import assert from "node:assert/strict";
import { DOC_SECTIONS } from "../.test-build/s3web/docs.mjs";
import { apns, call, makeEnv, newAccount } from "./web-harness.mjs";

const paths = ["/", "/docs", "/support", "/privacy", "/terms"];
const env = makeEnv();
let checks = 0;
function check(condition, description) {
  assert.ok(condition, description);
  checks++;
}

for (const path of paths) {
  const en = await call(env, "GET", `${path}?lang=en`, { headers: { "accept-language": "zh-CN" } });
  const zh = await call(env, "GET", `${path}?lang=zh`, { headers: { "accept-language": "en-US" } });
  check(en.status === 200 && en.text.includes('<html lang="en">'), `${path}: English overrides Chinese browser`);
  check(zh.status === 200 && zh.text.includes('<html lang="zh-CN">'), `${path}: Chinese overrides English browser`);
  check(en.headers.get("content-language") === "en" && zh.headers.get("content-language") === "zh-CN", `${path}: language response headers`);
  check(en.headers.get("cache-control") === "public, max-age=300", `${path}: explicit language is cacheable`);
  check(en.text.includes(`href="${path}?lang=zh"`) && zh.text.includes(`href="${path}?lang=en"`), `${path}: switch stays on this page`);
  check(en.text.includes(`rel="canonical" href="https://nfo.im${path}?lang=en"`) && zh.text.includes(`rel="canonical" href="https://nfo.im${path}?lang=zh"`), `${path}: separate canonical URLs`);
  check(en.text.includes('property="og:locale" content="en_US"') && en.text.includes('hreflang="zh-Hans"'), `${path}: localized previews and alternates`);
  check(!/<script\b/.test(en.text) && en.headers.get("content-security-policy").includes("script-src 'none'"), `${path}: no scripts needed`);
  check(!/href="\/(?:docs|support|privacy|terms)?(?:#[^"]*)?"/.test(en.text), `${path}: public links keep English`);
  const ids = [...en.text.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  check(new Set(ids).size === ids.length, `${path}: no duplicate anchors`);
  for (const match of en.text.matchAll(/href="#([^"]+)"/g)) check(ids.includes(match[1]), `${path}: anchor ${match[1]} exists`);
  const head = await call(env, "HEAD", `${path}?lang=en`);
  check(head.status === 200 && head.text === "" && head.headers.get("content-language") === "en", `${path}: HEAD has headers only`);
}

for (const [header, language] of [
  ["en-US,en;q=0.9,zh-CN;q=0.8", "en"],
  ["en;q=0.2,zh-CN;q=0.9", "zh-CN"],
  ["zh-TW,zh;q=0.9,en;q=0.8", "zh-CN"],
  ["zh;q=0,en;q=0.8", "en"],
  ["fr-FR,fr;q=0.9", "en"],
  ["*;q=0.8,en;q=0", "zh-CN"],
  ["*;q=1,en;q=0.2,zh;q=0.8", "zh-CN"],
  ["zh-CN;q=0,zh;q=1,en;q=0.5", "en"],
]) {
  const r = await call(env, "GET", "/", { headers: { "accept-language": header } });
  check(r.headers.get("content-language") === language, `language negotiation: ${header}`);
  check(r.headers.get("vary") === "Accept-Language" && r.headers.get("cache-control").startsWith("private"), "negotiated responses cannot leak a cached language");
}
check((await call(env, "GET", "/?lang=invalid", { headers: { "accept-language": "en" } })).headers.get("content-language") === "en", "invalid choices fall back to browser language");
check((await call(env, "GET", "/")).headers.get("content-language") === "zh-CN", "headerless existing links preserve Chinese");
const redirect = await call(env, "GET", "/docs/params?lang=en");
check(redirect.status === 301 && redirect.headers.get("location") === "https://nfo.im/docs?lang=en#params", "documentation shortcuts preserve language and anchor");
const negotiatedRedirect = await call(env, "GET", "/docs/params", { headers: { "accept-language": "en" } });
check(negotiatedRedirect.headers.get("location") === "https://nfo.im/docs?lang=en#params" && negotiatedRedirect.headers.get("cache-control").startsWith("private"), "negotiated redirects cannot be cached for the wrong language");
const docs = await call(env, "GET", "/docs?lang=en");
for (const section of DOC_SECTIONS) check(docs.text.includes(`<section id="${section.id}">`), `English documentation includes ${section.id}`);
// test/api-l1-docs.test.mjs separately checks both translations against the README API reference.
const sitemap = await call(env, "GET", "/sitemap.xml");
for (const path of paths) check(sitemap.text.includes(`<loc>https://nfo.im${path}?lang=en</loc>`), `sitemap includes ${path} in English`);
check(apns.length === 0 && env.PIGEON_KV.store.size === 0, "public pages never push or write account state");

const account = await newAccount(env);
const before = apns.length;
const pushed = await call(env, "POST", "/?lang=en", { secret: account.key, body: { body: "Language selection must not intercept bearer pushes" } });
check(pushed.status === 200 && pushed.json?.code === 200 && apns.length > before, "root bearer push still works with a language parameter");
check(pushed.headers.get("content-type").includes("application/json"), "API response remains JSON");
for (const path of ["/privacy/unknown", "/terms/unknown", "/support/unknown", "/docs/unknown"]) {
  check((await call(env, "GET", `${path}?lang=en`)).status === 404, `unknown page: ${path}`);
}
console.log(`✓ ${checks} bilingual public-site checks passed`);
