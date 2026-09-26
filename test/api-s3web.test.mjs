/**
 * 网页与入口防护的端到端测试：页面安全头与 CSP、发送页和邀请页的脚本在 CSP 下照常可用、
 * 按 IP 限流、CORS 放行 X-Pigeon-Client。
 *
 *   BASE=http://localhost:8799 node test/api-s3web.test.mjs
 *
 * 本地 wrangler dev 按 [dev] 把请求报成 https，明文 http 的处理在 test/web.test.mjs 里测；
 * 没有 APNS_KEY_P8，登记前验令牌整段跳过，也在那里测。
 * 限流绑定在本地是真的在数（每 60 秒 30 次）：这里带上各自的来源 IP，本机回环地址不参与计数。
 */
import { createHash } from "node:crypto";

const BASE = process.env.BASE || "http://localhost:8799";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `  → ${detail}` : ""}`);
  }
}

async function call(method, path, { body, secret, ip, headers: extra = {} } = {}) {
  const headers = { ...extra };
  if (body) headers["content-type"] = "application/json";
  if (secret) headers.authorization = `Bearer ${secret}`;
  if (ip) headers["cf-connecting-ip"] = ip;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 页面 */
  }
  return { status: res.status, headers: res.headers, text, json };
}

// 每次运行换一批 token 和来源 IP：本地 KV 跨次保留，限流计数跨测试文件保留
const run = Date.now().toString(16);
let seq = 0;
const ipOf = (n) => `2001:db8:${run.slice(-4)}::${n}`;

async function newAccount(deviceName) {
  seq += 1;
  const token = `${run}${seq}`.padEnd(64, "d").slice(0, 64);
  const r = await call("POST", "/account", { body: { device_token: token, environment: "sandbox", device_name: deviceName } });
  return { id: r.json?.data?.account_id, secret: r.json?.data?.secret, data: r.json?.data, status: r.status };
}

const cspHash = (source) => `'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`;
const inlineScripts = (page) => [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
function directive(csp, name) {
  return csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(name + " "))?.slice(name.length + 1);
}

function pageHeaders(label, r, scripts) {
  const csp = r.headers.get("content-security-policy") ?? "";
  check(`${label}：HSTS、nosniff、no-referrer`,
    r.headers.get("strict-transport-security") === "max-age=31536000" &&
      r.headers.get("x-content-type-options") === "nosniff" &&
      r.headers.get("referrer-policy") === "no-referrer",
    JSON.stringify(Object.fromEntries(r.headers)));
  check(`${label}：frame-ancestors 'none'`, directive(csp, "frame-ancestors") === "'none'", csp);
  const found = inlineScripts(r.text);
  const allowed = (directive(csp, "script-src") ?? "").split(" ");
  if (scripts === 0) {
    check(`${label}：没有脚本，script-src 'none'`, found.length === 0 && allowed.join(" ") === "'none'", csp);
  } else {
    check(`${label}：${scripts} 段内联脚本`, found.length === scripts, String(found.length));
    check(`★ ${label}：CSP 放行的正是页面里的脚本（哈希对得上，浏览器不会拦）`,
      found.every((s) => allowed.includes(cspHash(s))) && allowed.length === found.length,
      `${allowed.join(" ")} vs ${found.map(cspHash).join(" ")}`);
    // 脚本要调的接口（发送页 POST /{key}）都在本站，connect-src 'self' 足够
    check(`${label}：connect-src 'self'`, directive(csp, "connect-src") === "'self'", csp);
  }
}

console.log("\n★ 页面安全头");
{
  pageHeaders("落地页", await call("GET", "/"), 0);
  pageHeaders("隐私政策", await call("GET", "/privacy"), 0);
  pageHeaders("使用条款", await call("GET", "/terms"), 0);
  const send = await call("GET", "/send");
  check("发送页 → 200", send.status === 200);
  pageHeaders("发送页", send, 1);
  check("发送页的表单不走原生提交（form-action 'none' 拦不到它）", !/<form[^>]+action=/i.test(send.text) && send.text.includes("event.preventDefault()"));
  check("JSON 接口也带 nosniff", (await call("GET", "/ping")).headers.get("x-content-type-options") === "nosniff");
}

console.log("\n★ 发送页脚本调的接口在 CSP 下照常可用");
{
  // 发送页脚本做的事：fetch("/" + key, POST JSON)。同源，connect-src 'self' 放行；这里按同样的请求走一遍
  const A = await newAccount("发送页测试机");
  const key = A.data?.channels?.[0]?.key;
  const r = await call("POST", `/${key}`, { body: { title: "", body: "网页发来的", level: "active" } });
  // 本地没有 APNs 私钥，推不出去；要的是请求被正常受理（不是 CSP、也不是 https 的拒绝）
  check("同源 POST /{key} 被正常受理", r.json && !/https/.test(r.json.message ?? "") && r.status !== 404, `${r.status} ${JSON.stringify(r.json)}`);
}

console.log("\n★ 邀请页");
const O = await newAccount("群主的 iPhone");
const made = await call("POST", `/account/${O.id}/channels`, { secret: O.secret, body: { name: "值班群", group: true } });
const gid = made.json?.data?.channel?.id;
const inv = await call("POST", `/account/${O.id}/channels/${gid}/invites`, { secret: O.secret });
const code = inv.json?.data?.code ?? "";
{
  check("★ 本地也报成 https（[dev] upstream_protocol）", (inv.json?.data?.link ?? "").startsWith("https://"), inv.json?.data?.link);
  const page = await call("GET", `/i/${code}`);
  check("有效的邀请页 → 200", page.status === 200, String(page.status));
  pageHeaders("有效的邀请页", page, 1);
  check("「用信鸽打开」的链接和转交密钥的脚本都在", page.text.includes(`href="pigeon://invite?c=${code}"`) && page.text.includes('getElementById("open")'));
  const gone = await call("GET", "/i/ZZZZ2345");
  check("失效的邀请页 → 404", gone.status === 404);
  pageHeaders("失效的邀请页", gone, 0);
}

console.log("\n★ CORS 与 X-Pigeon-Client");
{
  const pre = await call("OPTIONS", "/account", {
    headers: { origin: "https://example.test", "access-control-request-method": "POST", "access-control-request-headers": "content-type, x-pigeon-client" },
  });
  const allowed = (pre.headers.get("access-control-allow-headers") ?? "").toLowerCase();
  check("★ 预检放行 x-pigeon-client", pre.status === 204 && allowed.includes("x-pigeon-client"), allowed);
  const tagged = await call("POST", "/account", {
    headers: { "x-pigeon-client": "ios/1.1 (16)" },
    body: { device_token: `${run}ff`.padEnd(64, "c").slice(0, 64), environment: "sandbox" },
  });
  check("带 X-Pigeon-Client 的请求照常处理（只读不强制）", tagged.status === 200, tagged.text);
}

console.log("\n★ 按 IP 限流：POST /account（acct:{ip}）");
{
  const ip = ipOf(1);
  const statuses = [];
  // 用不合格的请求体数额度：限流排在最前，不必真的建 30 个账号
  for (let i = 0; i < 30; i++) statuses.push((await call("POST", "/account", { ip, body: {} })).status);
  check("前 30 次照常处理（缺 device_token → 400）", statuses.every((s) => s === 400), statuses.join());
  const over = await call("POST", "/account", { ip, body: {} });
  check("★ 第 31 次 → 429", over.status === 429, `${over.status} ${over.text}`);
  check("Retry-After: 60，body 带 error、retry_after", over.headers.get("retry-after") === "60" && over.json?.retry_after === 60 && /太频繁/.test(over.json?.error ?? ""), over.text);
  check("旧版 App 读的 message 同样是中文原因", over.json?.message === over.json?.error);
  check("换一个 IP 不受影响", (await call("POST", "/account", { ip: ipOf(2), body: {} })).status === 400);
  const local = [];
  for (let i = 0; i < 32; i++) local.push((await call("POST", "/account", { body: {} })).status);
  check("本机回环地址不计数（本地测试彼此不挤占）", local.every((s) => s === 400), local.join());
}

console.log("\n★ 按 IP 限流：邀请（invite:{ip}，预览、加入、网页共用）");
{
  const M = await newAccount("成员的 iPhone");
  const ip = ipOf(3);
  const statuses = [];
  for (let i = 0; i < 30; i++) statuses.push((await call("GET", "/i/ZZZZ2345", { ip })).status);
  check("前 30 次照常（失效的邀请 → 404）", statuses.every((s) => s === 404), statuses.join());
  const page = await call("GET", `/i/${code}`, { ip });
  check("★ 网页第 31 次 → 429 页面", page.status === 429 && (page.headers.get("content-type") ?? "").startsWith("text/html"), String(page.status));
  check("页面带 Retry-After，说明过一分钟再试", page.headers.get("retry-after") === "60" && page.text.includes("过一分钟"));
  pageHeaders("限流页", page, 0);
  const preview = await call("GET", `/account/${M.id}/invites/${code}`, { secret: M.secret, ip });
  check("★ 同一 IP 在 App 里预览 → 429", preview.status === 429 && preview.headers.get("retry-after") === "60", preview.text);
  const join = await call("POST", `/account/${M.id}/invites/${code}`, { secret: M.secret, ip });
  check("★ 加入 → 429", join.status === 429 && typeof join.json?.error === "string", join.text);
  const elsewhere = await call("GET", `/account/${M.id}/invites/${code}`, { secret: M.secret, ip: ipOf(4) });
  check("换一个 IP 照常预览", elsewhere.status === 200 && elsewhere.json?.data?.channel?.name === "值班群", elsewhere.text);
  const joined = await call("POST", `/account/${M.id}/invites/${code}`, { secret: M.secret, ip: ipOf(4) });
  check("照常加入", joined.status === 200 && joined.json?.data?.result === "joined", joined.text);
}

console.log("\n★ 没有 APNs 私钥：不验令牌、不按设备计数");
{
  const token = `${run}ee`.padEnd(64, "b").slice(0, 64);
  const statuses = [];
  for (let i = 0; i < 4; i++) {
    statuses.push((await call("POST", "/account", { body: { device_token: token, environment: "sandbox" } })).status);
  }
  check("同一个 token 建 4 个账号都行（本地验不了真假，计数没有意义）", statuses.every((s) => s === 200), statuses.join());
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
