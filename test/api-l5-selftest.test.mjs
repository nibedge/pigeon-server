/**
 * 通知体检的端到端测试：经本地 wrangler dev 的真路由、真 KV、真限流绑定。
 *
 *   BASE=http://localhost:8799 node test/api-l5-selftest.test.mjs
 *
 * 本地没有 APNs 私钥，推送一律失败 —— 正好看体检怎么把「服务端推不出去」说给人听。
 * 推出去以后的一路（约一分钟后补一次、点「知道了」、推「已恢复」）见 api-l5-selftest-flow.test.mjs。
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
  const headers = { "x-pigeon-client": "ios/1.2 (90)" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (secret) headers.authorization = `Bearer ${secret}`;
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 交给断言 */
  }
  return { status: res.status, json, data: json?.data, headers: res.headers };
}

const run = Date.now().toString(36);
const token = (seed) => (seed + run).repeat(64).slice(0, 64);

async function newAccount(seed) {
  const r = await call("POST", "/account", { body: { device_token: token(seed), environment: "sandbox", device_name: "体检机" } });
  return { id: r.data?.account_id, secret: r.data?.secret, channel: r.data?.channels?.[0]?.id, token: token(seed) };
}

console.log("\n通知体检：服务端推不出去时怎么说");
const A = await newAccount("stA");
const selftest = (body, who = A) => call("POST", `/account/${who.id}/selftest`, { secret: who.secret, body });
{
  const r = await selftest({ token_prefix: A.token.slice(0, 12), environment: "sandbox" });
  const d = r.data ?? {};
  check("★ 200：推不出去也是一次正常的体检", r.status === 200, JSON.stringify(r.json));
  check("本机在账号里、环境对得上", d.this_device?.registered === true && d.this_device?.environment_matches === true, JSON.stringify(d.this_device));
  const mine = d.devices?.[0];
  check("★ 每台设备带 APNs 的状态和原始原因", mine?.this_device === true && mine?.kind === "alert" && mine?.status === 500 && /APNs/.test(mine?.reason ?? ""), JSON.stringify(d.devices));
  check("★ 说清这是服务端的问题", d.delivered === 0 && d.problems?.[0]?.code === "push_failed" && /服务端的推送配置/.test(d.problems?.[0]?.message ?? ""), JSON.stringify(d.problems));
  check("nonce 和时刻", typeof d.nonce === "string" && d.nonce.length >= 16 && d.expires_at - d.sent_at === 600_000);
  check("带上此刻被压成静默的通道（这里没有）", Array.isArray(d.silenced) && d.silenced.length === 0, JSON.stringify(d.silenced));
  check("CORS 放行", r.headers.get("access-control-allow-origin") === "*");
}
{
  const other = await selftest({ token_prefix: "ffffffffffff" });
  check("★ 本机不在账号里 → registered=false、not_registered", other.status === 200 && other.data?.this_device?.registered === false && other.data?.problems?.[0]?.code === "not_registered", JSON.stringify(other.data));
  const mismatch = await selftest({ token_prefix: A.token.slice(0, 12), environment: "production" });
  check("★ 推送环境对不上 → environment_mismatch", mismatch.data?.this_device?.environment_matches === false && mismatch.data?.problems?.some((p) => p.code === "environment_mismatch"), JSON.stringify(mismatch.data?.problems));
  check("token_prefix 格式不对 → 400", (await selftest({ token_prefix: "short" })).status === 400);
  check("environment 乱写 → 400", (await selftest({ environment: "prod" })).status === 400);
  check("没带凭据 → 401", (await call("POST", `/account/${A.id}/selftest`, { body: {} })).status === 401);
  check("GET → 405", (await call("GET", `/account/${A.id}/selftest`, { secret: A.secret })).status === 405);
}

console.log("\n告警演练：推不出去就不排提醒");
{
  const r = await selftest({ drill: true, token_prefix: A.token.slice(0, 12) });
  const d = r.data ?? {};
  check("★ 200，演练挑了自己的个人通道", r.status === 200 && d.drill?.id === d.nonce && d.drill?.channel_id === A.channel, JSON.stringify(r.json));
  check("★ 一台都没送到：不排补发、不说几点再提醒", d.delivered === 0 && !("remind_at" in (d.drill ?? {})), JSON.stringify(d.drill));
  check("毛病里写着推送失败", d.problems?.some((p) => p.code === "push_failed"), JSON.stringify(d.problems));
  const done = await selftest({ drill_resolve: d.nonce });
  check("★ 收尾 → 200", done.status === 200 && typeof done.data?.drill?.resolved_at === "number" && done.data?.drill?.acked === false, JSON.stringify(done.json));
  const again = await selftest({ drill_resolve: d.nonce });
  check("★ 再收尾一次：already_resolved，时刻不变", again.data?.drill?.already_resolved === true && again.data?.drill?.resolved_at === done.data?.drill?.resolved_at, JSON.stringify(again.json));
  check("不认识的演练 → 404", (await selftest({ drill_resolve: "nosuchdrill0001" })).status === 404);

  const group = (await call("POST", `/account/${A.id}/channels`, { secret: A.secret, body: { name: "值班群", group: true } })).data?.channel?.id;
  const invite = (await call("POST", `/account/${A.id}/channels/${group}/invites`, { secret: A.secret })).data?.code;
  const B = await newAccount("stB");
  await call("POST", `/account/${B.id}/invites/${invite}`, { secret: B.secret });
  const inGroup = await selftest({ drill: true, channel_id: group });
  check("★ 群里不能演练 → 400", inGroup.status === 400, JSON.stringify(inGroup.json));
  const lost = await selftest({ drill: true, token_prefix: "ffffffffffff" });
  check("★ 本机不在账号里 → 409", lost.status === 409, JSON.stringify(lost.json));
}

console.log("\n限流：同一账号每分钟 20 次");
{
  const C = await newAccount("stC");
  const statuses = [];
  for (let i = 0; i < 21; i++) statuses.push((await selftest({}, C)).status);
  check("前 20 次照常", statuses.slice(0, 20).every((s) => s === 200), JSON.stringify(statuses));
  const over = await selftest({}, C);
  check("★ 超了 → 429，带 Retry-After", statuses[20] === 429 && over.status === 429 && over.headers.get("retry-after") === "60" && typeof over.json?.error === "string", JSON.stringify(over.json));
  check("别的账号不受影响", (await selftest({})).status === 200);
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
