/**
 * 认领与举报的端到端测试：旧版 App 的认领照常可用、举报每小时的额度。
 *
 *   BASE=http://localhost:8799 node test/api-s3.test.mjs
 *
 * 本地 wrangler dev 没有 APNS_KEY_P8：认领凭据不签发也不核对，这一段在 test/groups.test.mjs 里测。
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

async function call(method, path, { body, secret } = {}) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (secret) headers.authorization = `Bearer ${secret}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 某些路径回的不是 JSON，交给断言去判断 */
  }
  return { status: res.status, headers: res.headers, json };
}

// 每次运行换一批 token：本地 KV 跨次保留，老账号不该影响这次的断言
const run = Date.now().toString(16);
let seq = 0;
async function newAccount(deviceName, name) {
  seq += 1;
  const token = `${run}${seq}`.padEnd(64, "e").slice(0, 64);
  const r = await call("POST", "/account", { body: { device_token: token, environment: "sandbox", device_name: deviceName } });
  const acct = { id: r.json?.data?.account_id, secret: r.json?.data?.secret, data: r.json?.data };
  if (name) await call("PATCH", `/account/${acct.id}`, { secret: acct.secret, body: { name } });
  return acct;
}

const as = (who) => (method, path, body) => call(method, path, { secret: who.secret, body });

const O = await newAccount("群主的 iPhone", "王五");
const M = await newAccount("成员的 iPhone", "李四");
const N = await newAccount("路人的 iPhone");
const byO = as(O);
const byM = as(M);
const byN = as(N);
const made = await byO("POST", `/account/${O.id}/channels`, { name: "值班群", group: true });
const gid = made.json?.data?.channel?.id;
for (const who of [M, N]) {
  const code = (await byO("POST", `/account/${O.id}/channels/${gid}/invites`)).json?.data?.code;
  await call("POST", `/account/${who.id}/invites/${code}`, { secret: who.secret });
}

console.log("\n★ 认领：旧版 App 照常可用");
{
  const mid = `msg-${run}`;
  const ack = await byM("POST", `/account/${M.id}/channels/${gid}/ack`, { message_id: mid, title: "旧版 App 会带标题" });
  check("带 title、不带 sig 的旧式请求 → 200", ack.status === 200 && ack.json?.data?.first === true, JSON.stringify(ack.json));
  check("认领人用的是显示名", ack.json?.data?.acked_by === "李四", ack.json?.data?.acked_by);
  const withSig = await byN("POST", `/account/${N.id}/channels/${gid}/ack`, { message_id: `${mid}-2`, sig: "AAAAAAAAAAAAAAAAAAAAAA" });
  check("本地没有签发密钥：带 sig 也不核对 → 200", withSig.status === 200, JSON.stringify(withSig.json));
  check("没起名字的人认领，记的是「成员·id 后四位」", withSig.json?.data?.acked_by === `成员·${N.id.slice(-4)}`, withSig.json?.data?.acked_by);
}

console.log("\n★ 举报：每个账号每小时 5 次");
{
  const statuses = [];
  for (let i = 0; i < 5; i++) {
    statuses.push((await byN("POST", `/account/${N.id}/channels/${gid}/report`, { reason: "spam", message_id: `r-${i}` })).status);
  }
  check("前 5 次收下", statuses.every((s) => s === 200), statuses.join(","));
  const sixth = await byN("POST", `/account/${N.id}/channels/${gid}/report`, { reason: "spam", message_id: "r-5" });
  check("★ 第 6 次 → 429", sixth.status === 429, JSON.stringify(sixth.json));
  check("body 带中文原因 error 和 retry_after", typeof sixth.json?.error === "string" && sixth.json.error.includes("举报") && typeof sixth.json?.retry_after === "number", JSON.stringify(sixth.json));
  check("旧版 App 读的 message 也是这句", sixth.json?.message === sixth.json?.error);
  check("头里有 Retry-After", Number(sixth.headers.get("retry-after")) === sixth.json?.retry_after);
  check("填错的请求照常报 400，不被额度挡在前面", (await byN("POST", `/account/${N.id}/channels/${gid}/report`, { reason: "nope" })).status === 400);
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
