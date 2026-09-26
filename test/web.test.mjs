/**
 * 入口防护的测试：登记前验令牌、每台设备的账号上限、按 IP 限流、明文 http、页面安全头。
 *
 * 验令牌要真的打 APNs，本地 wrangler dev 没有 APNS_KEY_P8、也收不到明文 http（[dev] 把请求报成 https），
 * 所以这些只能在这里测：直接调处理函数和 Worker 的 fetch，KV 放内存里，APNs 换成截获请求的假 fetch。
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import worker from "../.test-build/s3web/index.mjs";
import {
  admitDevice,
  allowIp,
  clientIp,
  INVALID_TOKEN,
  MAX_ACCOUNTS_PER_DEVICE,
  probeToken,
  TOO_MANY_ACCOUNTS,
} from "../.test-build/s3web/guard.mjs";
import {
  handleAddDevice,
  handleCreateAccount,
  handleDeleteAccount,
  handleJoinInvite,
  handlePreviewInvite,
  handleRemoveDevice,
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
const sha256hex = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const indexOf = (env, token) => {
  const raw = env.PIGEON_KV.store.get(`tok:${sha256hex(token)}`);
  return raw === undefined ? undefined : JSON.parse(raw);
};

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

// ── 登记前验令牌 ────────────────────────────────────────────────────

console.log("\n★ 验令牌的推送长什么样");
{
  const env = makeEnv();
  const device = { token: fakeToken("p"), env: "sandbox", name: "x", addedAt: 0 };
  const before = apns.length;
  check("APNs 收下 → valid", (await probeToken(env, device)) === "valid");
  const sent = apns[before];
  check("发往这台设备申报的环境（sandbox）", sent?.url === `https://api.sandbox.push.apple.com/3/device/${device.token}`, sent?.url);
  check("后台推送、优先级 5", sent?.headers["apns-push-type"] === "background" && sent?.headers["apns-priority"] === "5", JSON.stringify(sent?.headers));
  check("不让 APNs 替离线设备存着（expiration 0）", sent?.headers["apns-expiration"] === "0");
  check("topic 是本 App", sent?.headers["apns-topic"] === "im.nfo.pigeon");
  check("★ payload 只有 content-available 和 probe", JSON.stringify(sent?.payload) === JSON.stringify({ aps: { "content-available": 1 }, probe: "1" }), JSON.stringify(sent?.payload));
  await probeToken(env, { ...device, env: "production" });
  check("production 设备发往正式环境", apns.at(-1).url.startsWith("https://api.push.apple.com/"), apns.at(-1).url);
}

console.log("\n★ APNs 的各种回答");
{
  const env = makeEnv();
  const device = { token: fakeToken("p"), env: "sandbox", name: "x", addedAt: 0 };
  const cases = [
    [{ status: 400, reason: "BadDeviceToken" }, "invalid", "BadDeviceToken → invalid"],
    [{ status: 400, reason: "DeviceTokenNotForTopic" }, "invalid", "DeviceTokenNotForTopic（别的 App 的 token）→ invalid"],
    [{ status: 410, reason: "Unregistered" }, "invalid", "410 Unregistered → invalid"],
    [{ status: 400, reason: "BadExpirationDate" }, "unknown", "别的 400（是我们请求的毛病）→ unknown，放行"],
    [{ status: 403, reason: "ExpiredProviderToken" }, "unknown", "403（我们自己的签名出错）→ unknown，放行"],
    [{ status: 429, reason: "TooManyRequests" }, "unknown", "429 → unknown，放行"],
    [{ status: 503, reason: "ServiceUnavailable" }, "unknown", "5xx → unknown，放行"],
    ["throw", "unknown", "连不上 APNs → unknown，放行"],
  ];
  for (const [reply, expected, label] of cases) {
    apnsReply = () => reply;
    const got = await probeToken(env, device);
    check(label, got === expected, got);
  }
  apnsReply = () => "hang";
  const started = Date.now();
  const hung = await probeToken(env, device, 50);
  check("★ APNs 一直不回 → 到点按 unknown 放行", hung === "unknown" && Date.now() - started < 1000, `${hung} ${Date.now() - started}ms`);
  apnsReply = () => ({ status: 200 });
}

console.log("\n★ 建账号：令牌无效就不建");
{
  const env = makeEnv();
  apnsReply = () => ({ status: 400, reason: "BadDeviceToken" });
  const bad = await create(env, fakeToken("b"));
  apnsReply = () => ({ status: 200 });
  check("★ BadDeviceToken → 400", bad.status === 400, JSON.stringify(bad.json));
  check("原因是约定的那句", bad.json?.message === INVALID_TOKEN && INVALID_TOKEN === "设备推送令牌无效，请重启 App 再试", bad.json?.message);
  check("没建出账号，也没记索引", ![...env.PIGEON_KV.store.keys()].some((k) => k.startsWith("acct:") || k.startsWith("tok:")), [...env.PIGEON_KV.store.keys()].join());

  apnsReply = () => ({ status: 503 });
  const flaky = await create(env, fakeToken("c"));
  apnsReply = () => ({ status: 200 });
  check("APNs 5xx → 照常建（不让真用户卡住）", flaky.status === 200, JSON.stringify(flaky.json));

  const good = await create(env, fakeToken("d"));
  check("APNs 收下 → 200", good.status === 200);
  check("★ 索引 tok:{sha256(token)} 记下这个账号", JSON.stringify(indexOf(env, fakeToken("d"))) === JSON.stringify([good.json.data.account_id]), JSON.stringify(indexOf(env, fakeToken("d"))));
  check("索引带过期时间", env.PIGEON_KV.ttl.get(`tok:${sha256hex(fakeToken("d"))}`) > 86_400 * 300);
  check("索引里不存 token 原文", ![...env.PIGEON_KV.store.entries()].some(([k, v]) => k.startsWith("tok:") && (k.includes(fakeToken("d")) || v.includes(fakeToken("d")))));
}

console.log("\n★ 一台设备最多挂 3 个账号");
{
  const env = makeEnv();
  const token = fakeToken("e");
  const made = [];
  for (let i = 0; i < MAX_ACCOUNTS_PER_DEVICE; i++) made.push(await create(env, token));
  check("前 3 个都能建", made.every((r) => r.status === 200), made.map((r) => r.status).join());
  check("索引里正好 3 个", indexOf(env, token)?.length === 3);
  const before = apns.length;
  const fourth = await create(env, token);
  check("★ 第 4 个 → 400", fourth.status === 400, JSON.stringify(fourth.json));
  check("原因是约定的那句", fourth.json?.message === TOO_MANY_ACCOUNTS && TOO_MANY_ACCOUNTS === "这台设备登记的账号太多了，请先在别的账号里移除这台设备");
  check("超了上限就不再打 APNs", apns.length === before);

  // 第 4 个账号拿别的 token 建好，再把这台设备加进去：同样拦下
  const other = await create(env, fakeToken("f"));
  const oid = other.json.data.account_id;
  const add = await json(await handleAddDevice(req("POST", `/account/${oid}/devices`, {
    secret: other.json.data.secret, body: { device_token: token, environment: "sandbox", device_name: "同一台" },
  }), env, oid));
  check("★ 往第 4 个账号里加这台设备 → 400", add.status === 400 && add.json?.message === TOO_MANY_ACCOUNTS, JSON.stringify(add.json));

  // 删掉一个账号：索引跟着摘掉，名额空出来
  const first = made[0].json.data;
  const del = await json(await handleDeleteAccount(req("DELETE", `/account/${first.account_id}`, { secret: first.secret }), env, first.account_id));
  check("删账号 → 200", del.status === 200);
  check("★ 删账号时从索引里摘掉", !indexOf(env, token)?.includes(first.account_id), JSON.stringify(indexOf(env, token)));
  const add2 = await json(await handleAddDevice(req("POST", `/account/${oid}/devices`, {
    secret: other.json.data.secret, body: { device_token: token, environment: "sandbox", device_name: "同一台" },
  }), env, oid));
  check("空出名额后就能加", add2.status === 200, JSON.stringify(add2.json));
  check("索引又是 3 个，包括刚加的", indexOf(env, token)?.length === 3 && indexOf(env, token).includes(oid), JSON.stringify(indexOf(env, token)));

  // 在某个账号里移除这台设备：索引不改，但下次计数时核对出来、不算它
  const second = made[1].json.data;
  const rm = await json(await handleRemoveDevice(req("DELETE", `/account/${second.account_id}/devices/${token}`, { secret: second.secret }), env, second.account_id, token));
  check("移除设备 → 200", rm.status === 200, JSON.stringify(rm.json));
  const again = await create(env, token);
  check("★ 移除过的账号不再占名额", again.status === 200, JSON.stringify(again.json));
  check("顺手把它从索引里剔掉", !indexOf(env, token).includes(second.account_id) && indexOf(env, token).length === 3, JSON.stringify(indexOf(env, token)));

  // 索引里指向已经不存在的账号（比如别处直接删了 KV）：同样不算
  env.PIGEON_KV.store.set(`tok:${sha256hex(fakeToken("g"))}`, JSON.stringify(["ghost0000001", "ghost0000002", "ghost0000003"]));
  check("索引里的账号都不在了 → 照常建", (await create(env, fakeToken("g"))).status === 200);
  check("鬼账号被剔掉", indexOf(env, fakeToken("g")).length === 1);
}

console.log("\n★ 已经在账号里的设备重新登记（App 每次启动都会）");
{
  const env = makeEnv();
  const token = fakeToken("h");
  const a = (await create(env, token)).json.data;
  const again = () => handleAddDevice(req("POST", `/account/${a.account_id}/devices`, {
    secret: a.secret, body: { device_token: token, environment: "sandbox", device_name: "改了名字" },
  }), env, a.account_id).then(json);

  const before = apns.length;
  const r = await again();
  check("重新登记 → 200，名字更新", r.status === 200 && r.json.data.devices[0].name === "改了名字", JSON.stringify(r.json?.data?.devices));
  check("★ 不再发验证推送", apns.length === before);

  // 这一版之前登记的设备没有索引：重新登记时补上
  env.PIGEON_KV.store.delete(`tok:${sha256hex(token)}`);
  apnsReply = () => ({ status: 400, reason: "BadDeviceToken" });
  const legacy = await again();
  apnsReply = () => ({ status: 200 });
  check("旧设备重新登记不验也不拦", legacy.status === 200 && apns.length === before, JSON.stringify(legacy.json));
  check("★ 顺手补上索引", JSON.stringify(indexOf(env, token)) === JSON.stringify([a.account_id]), JSON.stringify(indexOf(env, token)));

  // 已经挂了 3 个的旧设备：老账号里的重新登记照样放行（它本来就在里面）
  env.PIGEON_KV.store.set(`tok:${sha256hex(token)}`, JSON.stringify([]));
  const others = [];
  for (let i = 0; i < 3; i++) others.push((await create(env, token)).json.data.account_id);
  env.PIGEON_KV.store.set(`tok:${sha256hex(token)}`, JSON.stringify(others));
  check("索引已满、老账号重新登记 → 200", (await again()).status === 200);

  const added = await json(await handleAddDevice(req("POST", `/account/${a.account_id}/devices`, {
    secret: a.secret, body: { device_token: fakeToken("i"), environment: "sandbox", device_name: "新手机" },
  }), env, a.account_id));
  check("往账号里加一台新设备 → 要验", added.status === 200 && apns.at(-1).url.endsWith(fakeToken("i")), apns.at(-1)?.url);
  apnsReply = () => ({ status: 410, reason: "Unregistered" });
  const dead = await json(await handleAddDevice(req("POST", `/account/${a.account_id}/devices`, {
    secret: a.secret, body: { device_token: fakeToken("j"), environment: "sandbox", device_name: "旧手机" },
  }), env, a.account_id));
  apnsReply = () => ({ status: 200 });
  check("★ 新设备的令牌已注销 → 400，账号里没加上", dead.status === 400 && dead.json?.message === INVALID_TOKEN, JSON.stringify(dead.json));
}

console.log("\n★ 没有 APNs 私钥（本地开发）：整段跳过");
{
  const env = makeEnv({ APNS_KEY_P8: "" });
  const before = apns.length;
  const token = fakeToken("k");
  const made = [];
  for (let i = 0; i < MAX_ACCOUNTS_PER_DEVICE + 2; i++) made.push(await create(env, token));
  check("不发验证推送", apns.length === before);
  check("不计数：同一个 token 建 5 个都行", made.every((r) => r.status === 200));
  check("也不记索引", ![...env.PIGEON_KV.store.keys()].some((k) => k.startsWith("tok:")));
  const admission = await admitDevice(env, { token, env: "sandbox", name: "x", addedAt: 0 }, null);
  const keysBefore = env.PIGEON_KV.store.size;
  if (typeof admission === "object") await admission.commit("acct0001");
  check("回执照样能 commit，什么也不写", typeof admission === "object" && env.PIGEON_KV.store.size === keysBefore);
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
