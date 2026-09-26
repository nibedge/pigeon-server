/**
 * 群组违禁词过滤的端到端测试：群里的明文推送从四个入口进来都被拦下，个人通道照常。
 *
 *   BASE=http://localhost:8799 node test/api-s3filter.test.mjs
 *
 * 本地 wrangler dev 没有 APNS_KEY_P8，推送走到签发 APNs token 那一步就失败 —— 这里要的是请求被正常受理
 * （没被当成违禁拦下）。换词表（config:blocklist）在 test/filter.test.mjs 里测：本地测试改不了 KV。
 */
const BASE = process.env.BASE || "http://localhost:8799";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `  → ${detail}` : ""}`);
  }
}

async function call(method, path, { body, secret, headers: extra = {} } = {}) {
  const headers = { ...extra };
  if (body) headers["content-type"] = "application/json";
  if (secret) headers.authorization = `Bearer ${secret}`;
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

// 每次运行换一批 token：本地 KV 跨次保留
const run = Date.now().toString(16);
let seq = 0;
async function newAccount(name) {
  seq += 1;
  const token = `${run}${seq}`.padEnd(64, "a").slice(0, 64);
  const r = await call("POST", "/account", { body: { device_token: token, environment: "sandbox", device_name: "测试机" } });
  const data = r.json?.data;
  if (name) await call("PATCH", `/account/${data.account_id}`, { secret: data.secret, body: { name } });
  return { id: data?.account_id, secret: data?.secret, key: data?.channels?.[0]?.key, channelId: data?.channels?.[0]?.id };
}

/** 推送被正常受理：成功，或者（本地没有 APNs 私钥）走到了投递那一步才失败 */
const accepted = (r) => r.status === 200 || (r.status >= 500 && /推送失败|APNs/.test(r.json?.message ?? ""));

console.log("\n★ 群组违禁词过滤");
const O = await newAccount("老王");
const made = await call("POST", `/account/${O.id}/channels`, { secret: O.secret, body: { name: "过滤测试群", group: true } });
const group = made.json?.data?.channel ?? {};
const code = (await call("POST", `/account/${O.id}/channels/${group.id}/invites`, { secret: O.secret })).json?.data?.code ?? "";
const M = await newAccount();
{
  const joined = await call("POST", `/account/${M.id}/invites/${code}`, { secret: M.secret });
  check("成员加入", joined.json?.data?.result === "joined", joined.text);
  const bad = await call("GET", `/${group.key}/${encodeURIComponent("今晚裸聊")}`);
  check("★ 群里推违禁词 → 400，写明命中的词", bad.status === 400 && (bad.json?.message ?? "").includes("「裸聊」"), bad.text);
  const json = await call("POST", `/${group.key}`, { body: { title: "广告", body: "真人 荷官" } });
  check("JSON 推送同样拦", json.status === 400, json.text);
  const hook = await call("POST", `/hook/${group.key}/uptimekuma`, { body: { msg: "冰毒" } });
  check("webhook 适配器同样拦", hook.status === 400 && (hook.json?.message ?? "").includes("「冰毒」"), hook.text);
  const batch = await call("POST", "/push", { body: { device_key: group.key, body: "摇头丸" } });
  check("/push 批量接口同样拦", batch.status === 400 && (batch.json?.data?.[0]?.error ?? "").includes("「摇头丸」"), batch.text);
  const clean = await call("GET", `/${group.key}/${encodeURIComponent("有人按了门铃")}`);
  check("正常内容照常受理", accepted(clean), clean.text);
  const personal = await call("GET", `/${O.key}/${encodeURIComponent("裸聊")}`);
  check("只有自己收的通道不过滤", accepted(personal), personal.text);
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
