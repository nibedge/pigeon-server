/**
 * 入口防护的测试：按 IP 限流、明文 http、页面安全头。
 *
 * 本地 wrangler dev 收不到明文 http（[dev] 把请求报成 https），所以这些在这里测：
 * 直接调处理函数和 Worker 的 fetch，KV 放内存里，APNs 换成截获请求的假 fetch。
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import worker from "../.test-build/s3web/index.mjs";
import { allowIp, clientIp } from "../.test-build/s3web/guard.mjs";
import {
  handleCreateAccount,
  handleJoinInvite,
  handlePreviewInvite,
} from "../.test-build/s3web/routes/account.mjs";
import { privacyPage } from "../.test-build/s3web/privacy.mjs";
import { termsPage } from "../.test-build/s3web/terms.mjs";
import { landingPage } from "../.test-build/s3web/landing.mjs";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `  → ${detail}` : ""}`);
  }
}

function memoryKV() {
  const store = new Map();
  const ttl = new Map();
  return {
    store,
    ttl,
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value, opts) {
      store.set(key, value);
      if (opts?.expirationTtl) ttl.set(key, opts.expirationTtl);
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = "" } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true, cacheStatus: null };
    },
  };
}

const { privateKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

/**
 * 截下来的 APNs 请求。apnsReply 决定 APNs 怎么回：默认 200；
 * 也可以给 { status, reason }、给 "hang"（一直不回）、给 "throw"（连不上）
 */
const apns = [];
let apnsReply = () => ({ status: 200 });
globalThis.fetch = async (url, init) => {
  apns.push({ url: String(url), headers: init.headers, payload: JSON.parse(init.body) });
  const reply = apnsReply(String(url));
  if (reply === "hang") return new Promise(() => {});
  if (reply === "throw") throw new Error("connect ECONNREFUSED");
  return new Response(reply.reason ? JSON.stringify({ reason: reply.reason }) : "", { status: reply.status });
};

function makeEnv(extra = {}) {
  return {
    PIGEON_KV: memoryKV(),
    APNS_KEY_P8: privateKey,
    APNS_KEY_ID: "ABC1234DEF",
    APNS_TEAM_ID: "TEAM567890",
    APNS_TOPIC: "im.nfo.pigeon",
    ...extra,
  };
}

/** 记下被问到的键，按 deny 决定放不放行的假限流绑定 */
function fakeLimiter(deny = () => false) {
  const keys = [];
  return {
    keys,
    async limit({ key }) {
      keys.push(key);
      return { success: !deny(key) };
    },
  };
}

function req(method, path, { body, secret, ip, origin = "https://nfo.im", headers: extra = {} } = {}) {
  const headers = { ...extra };
  if (body) headers["content-type"] = "application/json";
  if (secret) headers.authorization = `Bearer ${secret}`;
  if (ip) headers["cf-connecting-ip"] = ip;
  return new Request(`${origin}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

async function json(res) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* 不是 JSON */
  }
  return { status: res.status, headers: res.headers, json: body };
}

const fakeToken = (seed) => seed.repeat(64).slice(0, 64);

async function create(env, token, { ip, environment = "sandbox" } = {}) {
  return json(await handleCreateAccount(req("POST", "/account", {
    ip,
    body: { device_token: token, environment, device_name: "测试机" },
  }), env));
}

// ── Worker 入口：明文 http、页面安全头、CORS ─────────────────────────

const call = (method, path, opts = {}, env = makeEnv({ APNS_KEY_P8: "" })) =>
  worker.fetch(req(method, path, opts), env, {});

console.log("\n★ 明文 http：页面跳 https，接口 400 且不推送");
{
  const env = makeEnv();
  // 先建一个真的通道，证明它是因为明文被拒、而不是 key 不存在
  const acct = (await json(await worker.fetch(req("POST", "/account", {
    body: { device_token: fakeToken("n"), environment: "sandbox", device_name: "x" },
  }), env, {}))).json.data;
  const key = acct.channels[0].key;
  const before = apns.length;
  const kvBefore = JSON.stringify([...env.PIGEON_KV.store.entries()]);

  const push = await json(await worker.fetch(req("GET", `/${key}/标题/内容`, { origin: "http://nfo.im" }), env, {}));
  check("★ http://nfo.im/{key}/t/b → 400", push.status === 400, JSON.stringify(push.json));
  check("说明请用 https", /https/.test(push.json?.message ?? ""), push.json?.message);
  check("★ 没有推出去", apns.length === before);
  check("KV 一点没动", JSON.stringify([...env.PIGEON_KV.store.entries()]) === kvBefore);
  check("带 CORS 头（网页里 fetch 也读得到原因）", push.headers.get("access-control-allow-origin") === "*");

  const postPush = await worker.fetch(req("POST", `/${key}`, { origin: "http://nfo.im", body: { body: "x" } }), env, {});
  check("POST 推送 → 400", postPush.status === 400);
  for (const [method, path] of [
    ["POST", "/push"],
    ["POST", `/hook/${key}/github`],
    ["POST", "/account"],
    ["GET", `/account/${acct.account_id}`],
    ["GET", "/hb/abcdef"],
    ["HEAD", "/hb/abcdef"],
    ["POST", "/hb/abcdef/fail"],
    ["POST", "/"],
    ["POST", "/send"],
  ]) {
    const r = await worker.fetch(req(method, path, { origin: "http://nfo.im" }), env, {});
    check(`${method} ${path.replace(key, "{key}").replace(acct.account_id, "{id}")} → 400，不跳转`, r.status === 400 && !r.headers.get("location"), String(r.status));
  }
  check("以上都没推出去", apns.length === before);

  for (const path of ["/", "/send", "/privacy", "/terms", "/i/ABCD2345", "/favicon.png", "/ping", "/.well-known/apple-app-site-association"]) {
    const r = await worker.fetch(req("GET", path + "?from=qr", { origin: "http://nfo.im" }), env, {});
    check(`GET ${path} → 301 到 https，路径和参数不变`, r.status === 301 && r.headers.get("location") === `https://nfo.im${path}?from=qr`, `${r.status} ${r.headers.get("location")}`);
  }
  const head = await worker.fetch(req("HEAD", "/send", { origin: "http://nfo.im" }), env, {});
  check("HEAD 页面也跳", head.status === 301);
  const local = await worker.fetch(req("GET", "/ping", { origin: "http://localhost:8787" }), env, {});
  check("主机是 localhost 的放过（本地开发）", local.status === 200);
  const secure = await worker.fetch(req("GET", "/ping"), env, {});
  check("https 照常", secure.status === 200);
}

/** 页面里每一段内联脚本的原文 */
function inlineScripts(page) {
  return [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}
const cspHash = (source) => `'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`;
function directive(csp, name) {
  return csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(name + " "))?.slice(name.length + 1);
}

async function checkPageHeaders(label, res, { scripts }) {
  const page = await res.text();
  const csp = res.headers.get("content-security-policy") ?? "";
  check(`${label}：HSTS 一年`, res.headers.get("strict-transport-security") === "max-age=31536000", res.headers.get("strict-transport-security"));
  check(`${label}：nosniff`, res.headers.get("x-content-type-options") === "nosniff");
  check(`${label}：referrer-policy no-referrer`, res.headers.get("referrer-policy") === "no-referrer");
  check(`${label}：不许被 iframe 套`, directive(csp, "frame-ancestors") === "'none'" && res.headers.get("x-frame-options") === "DENY", csp);
  check(`${label}：default-src 'none'、base-uri 'none'、form-action 'none'`,
    directive(csp, "default-src") === "'none'" && directive(csp, "base-uri") === "'none'" && directive(csp, "form-action") === "'none'", csp);
  check(`${label}：只连自己、图片只取自己`, directive(csp, "connect-src") === "'self'" && directive(csp, "img-src") === "'self'", csp);
  const found = inlineScripts(page);
  check(`${label}：内联脚本 ${scripts} 段`, found.length === scripts, String(found.length));
  const allowed = (directive(csp, "script-src") ?? "").split(" ");
  if (scripts === 0) check(`${label}：script-src 'none'`, allowed.length === 1 && allowed[0] === "'none'", csp);
  else {
    check(`★ ${label}：每段内联脚本的哈希都在 CSP 里`, found.every((s) => allowed.includes(cspHash(s))), `${allowed.join(" ")} vs ${found.map(cspHash).join(" ")}`);
    check(`${label}：脚本只放行这几段，没有 unsafe-*`, allowed.length === found.length && !allowed.some((a) => a.includes("unsafe")), csp);
  }
  check(`${label}：没有外部脚本`, !/<script[^>]+src=/i.test(page));
  return page;
}

console.log("\n★ 页面安全头与 CSP");
{
  const env = makeEnv({ APNS_KEY_P8: "" });
  await checkPageHeaders("落地页", await call("GET", "/", {}, env), { scripts: 0 });
  await checkPageHeaders("隐私政策", await call("GET", "/privacy", {}, env), { scripts: 0 });
  await checkPageHeaders("使用条款", await call("GET", "/terms", {}, env), { scripts: 0 });
  const send = await checkPageHeaders("发送页", await call("GET", "/send", {}, env), { scripts: 1 });
  check("发送页的脚本原样在（读 # 后的 key、POST 到 /{key}）", /location\.hash/.test(send) && /fetch\("\/" \+ key/.test(send));
  const gone = await checkPageHeaders("失效的邀请页", await call("GET", "/i/ABCD2345", {}, env), { scripts: 0 });
  check("失效的邀请页 → 仍是那句说明", gone.includes("邀请已失效"));

  // 建一个真的群和邀请，看有效的邀请页
  const acct = (await json(await call("POST", "/account", { body: { device_token: fakeToken("o"), environment: "sandbox" } }, env))).json.data;
  const made = (await json(await call("POST", `/account/${acct.account_id}/channels`, { secret: acct.secret, body: { name: "值班群", group: true } }, env))).json.data;
  const code = (await json(await call("POST", `/account/${acct.account_id}/channels/${made.channel.id}/invites`, { secret: acct.secret }, env))).json.data.code;
  const live = await call("GET", `/i/${code}`, {}, env);
  check("有效的邀请页 → 200，不缓存", live.status === 200 && live.headers.get("cache-control") === "no-store");
  const page = await checkPageHeaders("有效的邀请页", live, { scripts: 1 });
  check("邀请页的脚本原样在（把 # 后的密钥转给 App）", /location\.hash/.test(page) && page.includes('getElementById("open")'));
}

console.log("\n★ CORS 放行 X-Pigeon-Client");
{
  const pre = await call("OPTIONS", "/account", { headers: { "access-control-request-headers": "x-pigeon-client" } });
  const allowed = (pre.headers.get("access-control-allow-headers") ?? "").split(",").map((h) => h.trim().toLowerCase());
  check("预检 204", pre.status === 204);
  check("★ allow-headers 里有 x-pigeon-client", allowed.includes("x-pigeon-client"), allowed.join());
  check("原有的 content-type、authorization 还在", allowed.includes("content-type") && allowed.includes("authorization"));
  const env = makeEnv({ APNS_KEY_P8: "" });
  const tagged = await call("POST", "/account", {
    headers: { "x-pigeon-client": "ios/1.1 (16)" },
    body: { device_token: fakeToken("u"), environment: "sandbox" },
  }, env);
  check("带 X-Pigeon-Client 的请求照常处理", tagged.status === 200);
  check("JSON 响应也带 nosniff", tagged.headers.get("x-content-type-options") === "nosniff");
}

console.log("\n★ 文档页里的主机名转义");
{
  const host = 'evil.test"><img src=x>';
  for (const [name, render] of [["隐私政策", privacyPage], ["使用条款", termsPage], ["落地页", landingPage]]) {
    const page = render(host);
    check(`${name}：主机名转义后输出`, !page.includes('"><img') && page.includes("evil.test&quot;&gt;&lt;img src=x&gt;"));
  }
}

// ── 按 IP 限流 ──────────────────────────────────────────────────

console.log("\n★ 来源 IP 与按 IP 限流");
{
  check("取 cf-connecting-ip", clientIp(req("GET", "/", { ip: "203.0.113.9" })) === "203.0.113.9");
  check("IPv6 照样", clientIp(req("GET", "/", { ip: "2001:db8::1" })) === "2001:db8::1");
  check("没有这个头（本地）→ 不认", clientIp(req("GET", "/")) === null);
  check("本机回环（wrangler dev 填的）→ 不认", ["127.0.0.1", "::1", "::ffff:127.0.0.1"].every((ip) => clientIp(req("GET", "/", { ip })) === null));

  const rl = fakeLimiter();
  check("按「用途:IP」计数", (await allowIp(rl, req("GET", "/", { ip: "203.0.113.9" }), "acct")) && rl.keys[0] === "acct:203.0.113.9", rl.keys.join());
  const quiet = fakeLimiter(() => true);
  check("本地来源不查限流", (await allowIp(quiet, req("GET", "/", { ip: "127.0.0.1" }), "acct")) && quiet.keys.length === 0);
  check("绑定缺失 → 放行", await allowIp(undefined, req("GET", "/", { ip: "203.0.113.9" }), "acct"));
}

console.log("\n★ POST /account 按 IP 限流（acct:{ip}）");
{
  const rl = fakeLimiter((key) => key === "acct:203.0.113.66");
  const env = makeEnv({ RL_IP: rl });
  const before = apns.length;
  const blocked = await create(env, fakeToken("q"), { ip: "203.0.113.66" });
  check("★ 超限 → 429", blocked.status === 429, JSON.stringify(blocked.json));
  check("Retry-After: 60，body 带 error 与 retry_after", blocked.headers.get("retry-after") === "60" && blocked.json?.retry_after === 60 && typeof blocked.json?.error === "string");
  check("旧版 App 读的 message 也是这句中文", blocked.json?.message === blocked.json?.error && /太频繁/.test(blocked.json?.message ?? ""), blocked.json?.message);
  check("被拦下的请求不验令牌、不建账号", apns.length === before && ![...env.PIGEON_KV.store.keys()].some((k) => k.startsWith("acct:")));
  const other = await create(env, fakeToken("q"), { ip: "203.0.113.67" });
  check("换一个 IP 照常建", other.status === 200, JSON.stringify(other.json));
  check("计数键是 acct:{ip}", rl.keys.includes("acct:203.0.113.67"), rl.keys.join());
}

console.log("\n★ 邀请预览、加入按 IP 限流（invite:{ip}）");
{
  const rl = fakeLimiter((key) => key === "invite:203.0.113.77");
  const env = makeEnv({ RL_IP: rl });
  const M = (await create(env, fakeToken("m"))).json.data;
  const preview = await json(await handlePreviewInvite(req("GET", `/account/${M.account_id}/invites/ABCD2345`, { secret: M.secret, ip: "203.0.113.77" }), env, M.account_id, "ABCD2345"));
  check("★ 预览超限 → 429", preview.status === 429 && preview.headers.get("retry-after") === "60", JSON.stringify(preview.json));
  const join = await json(await handleJoinInvite(req("POST", `/account/${M.account_id}/invites/ABCD2345`, { secret: M.secret, ip: "203.0.113.77" }), env, M.account_id, "ABCD2345"));
  check("★ 加入超限 → 429", join.status === 429 && typeof join.json?.error === "string", JSON.stringify(join.json));
  const fine = await json(await handlePreviewInvite(req("GET", `/account/${M.account_id}/invites/ABCD2345`, { secret: M.secret, ip: "203.0.113.78" }), env, M.account_id, "ABCD2345"));
  check("别的 IP 照常（这个码不存在 → 404）", fine.status === 404, JSON.stringify(fine.json));
  check("计数键是 invite:{ip}", rl.keys.filter((k) => k === "invite:203.0.113.77").length === 2 && rl.keys.includes("invite:203.0.113.78"), rl.keys.join());
}

console.log("\n★ 网页邀请页按 IP 限流");
{
  const rl = fakeLimiter((key) => key === "invite:198.51.100.5");
  const env = makeEnv({ APNS_KEY_P8: "", RL_IP: rl });
  const limited = await call("GET", "/i/ABCD2345", { ip: "198.51.100.5" }, env);
  check("★ 超限 → 429 页面", limited.status === 429 && limited.headers.get("content-type")?.startsWith("text/html"), String(limited.status));
  check("带 Retry-After: 60、不缓存", limited.headers.get("retry-after") === "60" && limited.headers.get("cache-control") === "no-store");
  const text = await checkPageHeaders("限流页", limited, { scripts: 0 });
  check("页面说清楚过一分钟再试", text.includes("过一分钟"));
  const other = await call("GET", "/i/ABCD2345", { ip: "198.51.100.6" }, env);
  check("别的 IP 照常", other.status === 404);
  check("计数键 invite:{ip}", rl.keys.includes("invite:198.51.100.5") && rl.keys.includes("invite:198.51.100.6"), rl.keys.join());
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
