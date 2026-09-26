/**
 * 监控巡检与心跳报到的端到端测试：跑在真的 Worker 和本地 KV 上。
 *
 *   BASE=http://localhost:8799 node test/api-s1-sweep.test.mjs
 *
 * - 监控可以带提醒强度（level / repeat），原样回来；只收加密的通道上建不了
 * - 巡检（走 /__test__/cron/watches，只看这里建的监控）：连续两次失败才算掉线；告警推不出去
 *   （本地连不上 APNs）就不改状态、下一轮重推，试满 3 轮放弃；每轮记下来，/info 报最近一轮的时刻
 *
 * 被监控的网址就用这个本地 Worker 自己的地址：结果确定，不依赖外网。
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

async function call(method, path, { body, secret, headers = {} } = {}) {
  const all = { ...headers };
  if (body !== undefined) all["content-type"] = "application/json";
  if (secret) all.authorization = `Bearer ${secret}`;
  const res = await fetch(BASE + path, { method, headers: all, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 交给断言去判断 */
  }
  return { status: res.status, json };
}

/** 每次跑都换一批令牌：本地 KV 跨次保留 */
const run = Date.now().toString(36);
const token = (seed) => (seed + run).repeat(64).slice(0, 64);

async function newAccount(seed, name) {
  const r = await call("POST", "/account", {
    body: { device_token: token(seed), environment: "sandbox", device_name: name },
  });
  const data = r.json?.data ?? {};
  return { id: data.account_id, secret: data.secret, channel: data.channels?.[0] ?? {} };
}

const createWatch = (account, body) => call("POST", `/account/${account.id}/watches`, { secret: account.secret, body });

/** 某个监控状态键的 metadata（就是状态本身） */
async function stateOf(id) {
  const r = await call("POST", `/__test__/watch-keys/${id}`);
  const keys = r.json?.data?.keys ?? [];
  return keys.find((k) => k.name.startsWith("wstate:") || k.name.startsWith("hbstate:"))?.metadata ?? null;
}

const sweep = async (now, ids) => (await call("POST", `/__test__/cron/watches?now=${now}&only=${ids.join(",")}`)).json?.data ?? null;

const A = await newAccount("sa", "巡检测试机");

console.log("\n★ 提醒强度：建的时候给，原样回来");
{
  const r = await createWatch(A, { kind: "heartbeat", channelId: A.channel.id, intervalMinutes: 60, name: "直到有人处理", level: "timeSensitive", repeat: 5 });
  const w = r.json?.data?.watch ?? {};
  check("带 level / repeat 建心跳 → 200，原样回来", r.status === 200 && w.level === "timeSensitive" && w.repeat === 5, JSON.stringify(r.json));
  const calm = (await createWatch(A, { kind: "up", channelId: A.channel.id, url: "https://example.com/", level: "active" })).json?.data?.watch ?? {};
  check("普通：只有 level", calm.level === "active" && calm.repeat === undefined);
  const plain = (await createWatch(A, { kind: "up", channelId: A.channel.id, url: "https://example.com/" })).json?.data?.watch ?? {};
  check("没给就不带这两个字段（旧 App 看到的和原来一样）", plain.id && !("level" in plain) && !("repeat" in plain));
  const bad = await createWatch(A, { kind: "up", channelId: A.channel.id, url: "https://example.com/", level: "critical" });
  check("★ level 写错 → 400，说清能填什么", bad.status === 400 && (bad.json?.message ?? "").includes("timeSensitive"), JSON.stringify(bad.json));
  const listed = (await call("GET", `/account/${A.id}/watches`, { secret: A.secret })).json?.data?.watches ?? [];
  check("列表里也带着", listed.find((x) => x.id === w.id)?.repeat === 5 && listed.find((x) => x.id === calm.id)?.level === "active");
  for (const x of [w, calm, plain]) await call("DELETE", `/account/${A.id}/watches/${x.id}`, { secret: A.secret });
}

console.log("\n★ 只收加密的通道上建不了监控");
{
  const locked = (await call("POST", `/account/${A.id}/channels`, { secret: A.secret, body: { name: "只收加密" } })).json?.data?.channel ?? {};
  const patched = await call("PATCH", `/account/${A.id}/channels/${locked.id}`, { secret: A.secret, body: { policy: { e2eOnly: true } } });
  check("打开「只接受加密消息」", patched.status === 200, JSON.stringify(patched.json));
  const r = await createWatch(A, { kind: "heartbeat", channelId: locked.id, intervalMinutes: 60 });
  check("★ 建心跳 → 400，说清为什么", r.status === 400 && (r.json?.message ?? "").includes("只收加密"), JSON.stringify(r.json));
  const site = await createWatch(A, { kind: "up", channelId: locked.id, url: "https://example.com/" });
  check("建网址监控也是 400", site.status === 400);
  await call("DELETE", `/account/${A.id}/channels/${locked.id}`, { secret: A.secret });
}

console.log("\n★ 巡检：连续两次失败才算掉线；告警推不出去就留到下一轮，试满 3 轮放弃");
{
  const before = Date.now();
  // 被监控的就是这个本地 Worker：/hb 不带 id 回 404，/healthz 回 ok
  const down = (await createWatch(A, { kind: "up", channelId: A.channel.id, url: `${BASE}/hb`, name: "会掉线的", intervalMinutes: 60 })).json?.data?.watch ?? {};
  const kw = (await createWatch(A, { kind: "keyword", channelId: A.channel.id, url: `${BASE}/healthz`, keyword: "ok", name: "健康检查" })).json?.data?.watch ?? {};
  check("建好两个监控", Boolean(down.id && kw.id));
  const T0 = Date.now();
  const ids = [down.id, kw.id];

  let report = await sweep(T0, ids);
  check("第一轮：两个都抓了", report?.due === 2 && report?.checked === 2, JSON.stringify(report));
  let st = await stateOf(down.id);
  check("★ 第一次失败：不推，记下失败和原因", report?.alerted === 0 && report?.retrying === 0 && st?.failCount === 1 && st?.lastDetail === "HTTP 404" && st?.lastStatus === undefined, JSON.stringify(st));
  check("★ 下一轮就再看（不等 60 分钟的间隔）", st?.nextDueAt === T0 + 5 * 60_000, `${st?.nextDueAt} vs ${T0 + 5 * 60_000}`);
  check("关键词在 2xx 的文本里找到了", (await stateOf(kw.id))?.lastStatus === "present");

  report = await sweep(T0 + 5 * 60_000, ids);
  st = await stateOf(down.id);
  check("第二轮只看到期的那个", report?.due === 1 && report?.checked === 1, JSON.stringify(report));
  // 本地连不上 APNs：告警推不出去（真有设备、真去推了）
  const retried = report?.retrying === 1 && st?.pendingAlertAttempts === 1 && st?.lastStatus === undefined && st?.failCount === 2;
  const delivered = report?.alerted === 1 && st?.lastStatus === "down";
  check("★ 连续第二次失败：推「掉线了」；推不出去就不改状态、记下试了一次", retried || delivered, JSON.stringify({ report, st }));
  if (retried) {
    report = await sweep(T0 + 10 * 60_000, ids);
    check("第三轮再推一次", report?.retrying === 1 && (await stateOf(down.id))?.pendingAlertAttempts === 2, JSON.stringify(report));
    report = await sweep(T0 + 15 * 60_000, ids);
    st = await stateOf(down.id);
    check("★ 试满 3 轮：放弃，记成 down，不再每轮空转", report?.abandoned === 1 && st?.lastStatus === "down" && st?.pendingAlertAttempts === undefined, JSON.stringify({ report, st }));
    report = await sweep(T0 + 20 * 60_000, ids);
    check("之后按原间隔，这一轮不到期", report?.due === 0, JSON.stringify(report));
  }
  const listed = ((await call("GET", `/account/${A.id}/watches`, { secret: A.secret })).json?.data?.watches ?? []).find((w) => w.id === down.id);
  check("列表里看得到失败说明", listed?.last_detail === "HTTP 404" && listed?.last_status === "down", JSON.stringify(listed));

  const info = (await call("GET", "/info")).json?.data ?? {};
  check("★ /info 报最近一轮监控巡检的时刻", typeof info.last_sweep_at === "number" && info.last_sweep_at >= before, JSON.stringify(info));
  check("/info 带着重复提醒巡检的时刻（本地没跑过就是 null）", "last_reminder_sweep_at" in info);
  check("测试接口只收 POST", (await call("GET", `/__test__/cron/watches?only=${down.id}`)).status === 404);
  for (const id of ids) await call("DELETE", `/account/${A.id}/watches/${id}`, { secret: A.secret });
}

await call("DELETE", `/account/${A.id}`, { secret: A.secret });
console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
