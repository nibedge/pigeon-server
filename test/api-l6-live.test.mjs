/**
 * 实时活动的登记接口（端到端，打本地 wrangler dev）：开始令牌的登记与删除、某件事的更新令牌、
 * 认领和恢复之后再来登记时服务端怎么回。
 *
 *   BASE=http://localhost:8799 node test/api-l6-live.test.mjs
 *
 * 本地没有 APNs 私钥（run-api.sh 把 APNS_KEY_P8 置空），推送都发不出去 —— 这里看的是接口和服务端记下的状态；
 * 真正发给 APNs 的样子在 api-l6-live-apns.test.mjs 里用假 APNs 核对。账号都是这个文件自己新建的，令牌每次跑都换一批。
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

async function call(method, path, { body, secret, raw } = {}) {
  const headers = { "x-pigeon-client": "ios/1.1 (90)" };
  if (body !== undefined) headers["content-type"] = raw ? "application/x-www-form-urlencoded" : "application/json";
  if (secret) headers.authorization = `Bearer ${secret}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 交给断言 */
  }
  return { status: res.status, json };
}

const run = Date.now().toString(16);
/** 推送令牌、ActivityKit 令牌都是十六进制：用种子 + 这次运行的时刻拼满 64 位 */
const hex = (seed) => (seed + run).repeat(64).replace(/[^0-9a-f]/g, "").slice(0, 64);

async function newAccount(seed) {
  const r = await call("POST", "/account", {
    body: { device_token: hex(seed), environment: "sandbox", device_name: "测试机" },
  });
  const data = r.json?.data ?? {};
  return { id: data.account_id, secret: data.secret, channel: data.channels?.[0] ?? {}, token: hex(seed) };
}

const deviceView = async (acct) => (await call("GET", `/account/${acct.id}`, { secret: acct.secret })).json?.data?.devices?.[0] ?? {};

console.log("\n实时活动：开始令牌");
const A = await newAccount("a1");
{
  const path = `/account/${A.id}/devices/${A.token}/activity-start-token`;
  const start = hex("5a");
  const set = await call("PUT", path, { secret: A.secret, body: { token: start.toUpperCase() } });
  check("★ PUT 开始令牌 → 200 live_activities: true", set.status === 200 && set.json?.data?.live_activities === true, JSON.stringify(set.json));
  const view = await deviceView(A);
  check("★ 账号视图里这台设备多了 activity_start_token_prefix（前 12 位，已转小写）", view.activity_start_token_prefix === start.slice(0, 12), JSON.stringify(view));
  check("令牌本身不回给客户端", !JSON.stringify(view).includes(start));

  const same = await call("PUT", path, { secret: A.secret, body: { token: start } });
  check("同一个令牌再来一次 → 照样 200", same.status === 200 && same.json?.data?.live_activities === true);

  const byPrefix = await call("PUT", `/account/${A.id}/devices/${A.token.slice(0, 12)}/activity-start-token`, { secret: A.secret, body: { token: hex("5b") } });
  check("推送令牌只给 12 位前缀也认", byPrefix.status === 200 && (await deviceView(A)).activity_start_token_prefix === hex("5b").slice(0, 12));

  const bad = await call("PUT", path, { secret: A.secret, body: { token: "不是十六进制" } });
  check("令牌格式不对 → 400", bad.status === 400 && /token 格式不对/.test(bad.json?.message ?? ""), JSON.stringify(bad.json));
  const missing = await call("PUT", path, { secret: A.secret, body: {} });
  check("没给令牌 → 400", missing.status === 400);
  const stranger = await call("PUT", `/account/${A.id}/devices/${hex("zz")}/activity-start-token`, { secret: A.secret, body: { token: start } });
  check("不是这个账号的设备 → 404", stranger.status === 404 && stranger.json?.message === "这台设备不在账号里");
  const noAuth = await call("PUT", path, { secret: "wrong", body: { token: start } });
  check("凭据不对 → 401", noAuth.status === 401);
  const wrongMethod = await call("POST", path, { secret: A.secret, body: { token: start } });
  check("POST → 405", wrongMethod.status === 405);

  const cleared = await call("DELETE", path, { secret: A.secret });
  check("★ DELETE → 200 live_activities: false，视图里没有了", cleared.status === 200 && cleared.json?.data?.live_activities === false && !("activity_start_token_prefix" in (await deviceView(A))));
  const clearedAgain = await call("DELETE", path, { secret: A.secret });
  check("再删一次也是 200", clearedAgain.status === 200);
  const devices = (await call("GET", `/account/${A.id}`, { secret: A.secret })).json?.data?.devices ?? [];
  check("删开始令牌不影响设备本身", devices.length === 1 && devices[0].token_prefix === A.token.slice(0, 12));

  // 后面的来回要用
  await call("PUT", path, { secret: A.secret, body: { token: start } });
}

console.log("\n实时活动：某件事的更新令牌");
{
  const cid = A.channel.id;
  const mid = `db:01/${run}`;
  const path = `/account/${A.id}/activities/${cid}/${encodeURIComponent(mid)}`;
  const startedAt = Date.now();
  const reg = await call("PUT", path, { secret: A.secret, body: { token: hex("u1"), device: A.token, started_at: startedAt } });
  check("★ 登记 → registered、firing（消息 id 里的 / 和 : 百分号编码后照认）",
    reg.status === 200 && reg.json?.data?.registered === true && reg.json?.data?.status === "firing", JSON.stringify(reg.json));

  const cases = [
    ["令牌格式不对 → 400", { token: "xyz", device: A.token, started_at: startedAt }, 400],
    ["不是这个账号的设备 → 404", { token: hex("u1"), device: hex("zz"), started_at: startedAt }, 404],
    ["没给设备 → 404", { token: hex("u1"), started_at: startedAt }, 404],
  ];
  for (const [label, body, status] of cases) {
    const r = await call("PUT", path, { secret: A.secret, body });
    check(label, r.status === status, `${r.status} ${JSON.stringify(r.json)}`);
  }
  const longId = await call("PUT", `/account/${A.id}/activities/${cid}/${"x".repeat(65)}`, { secret: A.secret, body: { token: hex("u1"), device: A.token } });
  check("消息 id 超过 64 字 → 400", longId.status === 400 && longId.json?.message === "消息 id 格式不对");
  const B = await newAccount("b1");
  const foreign = await call("PUT", `/account/${B.id}/activities/${cid}/${encodeURIComponent(mid)}`, { secret: B.secret, body: { token: hex("u2"), device: B.token } });
  check("★ 别人的通道 → 404（不透露它存在）", foreign.status === 404);
  const incomplete = await call("PUT", `/account/${A.id}/activities/${cid}`, { secret: A.secret, body: {} });
  check("少了消息 id → 404 并说明用法", incomplete.status === 404 && /用法/.test(incomplete.json?.message ?? ""));
  const getIt = await call("GET", path, { secret: A.secret });
  check("GET → 405", getIt.status === 405);

  // 认领：本地推不出去，但服务端照样记下谁在处理
  const ack = await call("POST", `/account/${A.id}/channels/${cid}/ack`, { secret: A.secret, body: { message_id: mid } });
  check("认领成功", ack.status === 200 && ack.json?.data?.first === true, JSON.stringify(ack.json));
  const afterAck = await call("PUT", path, { secret: A.secret, body: { token: hex("u3"), device: A.token, started_at: startedAt } });
  check("★ 认领之后来登记 → acked 和认领人", afterAck.json?.data?.status === "acked" && typeof afterAck.json?.data?.ack_by === "string", JSON.stringify(afterAck.json));

  // 恢复：推送发不出去（本地没有私钥），实时活动的墓碑照样立
  const resolved = await call("POST", `/${A.channel.key}`, { body: { id: mid, status: "resolved", body: "已恢复" } });
  check("恢复推送走完（本地发不出去，回 502）", resolved.status === 502, `${resolved.status} ${JSON.stringify(resolved.json)}`);
  const late = await call("PUT", path, { secret: A.secret, body: { token: hex("u4"), device: A.token, started_at: startedAt } });
  check("★ 恢复之后来登记 → ended、resolved，不再登记",
    late.json?.data?.registered === false && late.json?.data?.ended === true && late.json?.data?.status === "resolved" && late.json?.data?.ended_at >= startedAt,
    JSON.stringify(late.json));
  const newer = await call("PUT", path, { secret: A.secret, body: { token: hex("u5"), device: A.token, started_at: Date.now() + 60_000 } });
  check("开始得比那次结束还晚（同一个 id 又触发了）：照常登记", newer.json?.data?.registered === true && newer.json?.data?.status === "firing", JSON.stringify(newer.json));
}

console.log("\n实时活动：推送参数与通道默认值");
{
  const mid = `live-${run}`;
  const firing = await call("POST", `/${A.channel.key}`, { body: { id: mid, status: "firing", live: true, title: "主库连不上" } });
  check("★ live=1 的 firing：响应里带 live（本地没送到设备，所以开了 0 个）", firing.json?.data?.live?.started === 0, JSON.stringify(firing.json));
  check("live 不在「不生效的参数」里", !(firing.json?.data?.ignored ?? []).includes("live"));

  const patch = await call("PATCH", `/account/${A.id}/channels/${A.channel.id}`, { secret: A.secret, body: { defaults: { live: "1", level: "timeSensitive" } } });
  const channel = (patch.json?.data?.channels ?? []).find((c) => c.id === A.channel.id);
  check("★ live 可以设成通道默认值", patch.status === 200 && channel?.defaults?.live === "1", JSON.stringify(channel?.defaults));

  const retract = await call("POST", `/${A.channel.key}`, { body: { id: mid, delete: 1 } });
  check("撤回照常", retract.status === 502 || retract.status === 200, `${retract.status}`);
  const after = await call("PUT", `/account/${A.id}/activities/${A.channel.id}/${mid}`, { secret: A.secret, body: { token: hex("u6"), device: A.token, started_at: Date.now() - 60_000 } });
  check("★ 撤回之后来登记 → ended、retracted", after.json?.data?.ended === true && after.json?.data?.status === "retracted", JSON.stringify(after.json));
}

if (failures > 0) {
  console.log(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\n实时活动（接口）全部通过");
