/**
 * 监控管理的端到端测试：编辑、暂停与维护窗口、立即检测、历史、心跳的 /start 和退出码。跑在真的 Worker 和本地 KV 上。
 *
 *   BASE=http://localhost:8799 node test/api-l3-watches.test.mjs
 *
 * 被监控的网址就用这个本地 Worker 自己的地址（/healthz 回 ok，/hb 不带 id 回 404）：结果确定，不依赖外网。
 * 本地没有 APNs 私钥，告警推不出去 —— 这里只看接口的约定，推送的内容由 watch-l3.test.mjs 核对。
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
  return { status: res.status, json, headers: res.headers };
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
const patchWatch = (account, id, body) => call("PATCH", `/account/${account.id}/watches/${id}`, { secret: account.secret, body });
const listed = async (account, id) =>
  ((await call("GET", `/account/${account.id}/watches`, { secret: account.secret })).json?.data?.watches ?? []).find((w) => w.id === id);
const sweep = async (now, ids) => (await call("POST", `/__test__/cron/watches?now=${now}&only=${ids.join(",")}`)).json?.data ?? null;
async function stateOf(id) {
  const keys = (await call("POST", `/__test__/watch-keys/${id}`)).json?.data?.keys ?? [];
  return keys.find((k) => k.name.startsWith("wstate:") || k.name.startsWith("hbstate:"))?.metadata ?? null;
}

const A = await newAccount("la", "监控管理测试机");
const B = await newAccount("lb", "别人的手机");

console.log("\n★ PATCH：只改给了的字段，校验同新建");
{
  const w = (await createWatch(A, { kind: "up", channelId: A.channel.id, url: `${BASE}/healthz`, intervalMinutes: 15 })).json?.data?.watch ?? {};
  check("建好一个网址监控，视图带上 ref 和可用率字段（还没数据是 null）", w.id && w.ref === w.id && w.uptime_24h === null && "uptime_30d" in w, JSON.stringify(w));
  let r = await patchWatch(A, w.id, { name: "健康检查", intervalMinutes: 30, level: "timeSensitive", repeat: 5 });
  const v = r.json?.data?.watch ?? {};
  check("★ 改名字、间隔、提醒强度 → 200，回完整视图", r.status === 200 && v.name === "健康检查" && v.interval_minutes === 30 && v.level === "timeSensitive" && v.repeat === 5 && v.url === w.url, JSON.stringify(r.json));
  check("列表里也是改过的", (await listed(A, w.id))?.name === "健康检查");
  r = await patchWatch(A, w.id, { level: null, repeat: 0 });
  check("level 给 null、repeat 给 0：去掉", r.status === 200 && !("level" in r.json.data.watch) && !("repeat" in r.json.data.watch));
  r = await patchWatch(A, w.id, { url: "ftp://nope" });
  check("★ 网址不合法 → 400，和新建一样的说明", r.status === 400 && r.json?.message === "只支持 http / https 网址", JSON.stringify(r.json));
  check("一个认得的字段都没有 → 400，列出能改的", (await patchWatch(A, w.id, { colour: "red" })).json?.message?.includes("能改的有"));
  check("网址监控改成心跳 → 400", (await patchWatch(A, w.id, { kind: "heartbeat" })).status === 400);
  r = await patchWatch(A, w.id, { kind: "keyword", keyword: "ok" });
  check("掉线改成关键词 → 200", r.status === 200 && r.json?.data?.watch?.kind === "keyword" && r.json.data.watch.keyword === "ok");
  check("★ 别人改不了：404（不透露这个 id 存在）", (await patchWatch(B, w.id, { name: "x" })).status === 404);
  check("没带凭据 → 401", (await call("PATCH", `/account/${A.id}/watches/${w.id}`, { body: { name: "x" } })).status === 401);
  check("不存在的监控 → 404", (await patchWatch(A, "nosuchwatch1", { name: "x" })).status === 404);

  const other = (await call("POST", `/account/${B.id}/channels`, { secret: B.secret, body: { name: "别人的通道" } })).json?.data?.channel ?? {};
  check("换到别人的通道 → 404", (await patchWatch(A, w.id, { channelId: other.id })).status === 404);
  const locked = (await call("POST", `/account/${A.id}/channels`, { secret: A.secret, body: { name: "只收加密" } })).json?.data?.channel ?? {};
  await call("PATCH", `/account/${A.id}/channels/${locked.id}`, { secret: A.secret, body: { policy: { e2eOnly: true } } });
  r = await patchWatch(A, w.id, { channel_id: locked.id });
  check("★ 换到只收加密的通道 → 400，说清为什么", r.status === 400 && (r.json?.message ?? "").includes("只收加密"), JSON.stringify(r.json));
  const second = (await call("POST", `/account/${A.id}/channels`, { secret: A.secret, body: { name: "第二个通道" } })).json?.data?.channel ?? {};
  r = await patchWatch(A, w.id, { channelId: second.id });
  check("换到自己的另一个通道 → 200", r.status === 200 && r.json?.data?.watch?.channel_id === second.id);
  const keys = (await call("POST", `/__test__/watch-keys/${w.id}`)).json?.data?.keys ?? [];
  check("★ 索引跟着换了通道", keys.find((k) => k.name.startsWith("wown:"))?.metadata?.channelId === second.id, JSON.stringify(keys));
  await call("DELETE", `/account/${A.id}/watches/${w.id}`, { secret: A.secret });
  await call("DELETE", `/account/${A.id}/channels/${locked.id}`, { secret: A.secret });
  await call("DELETE", `/account/${A.id}/channels/${second.id}`, { secret: A.secret });
}

console.log("\n★ 心跳：改间隔和宽限，报到地址不变");
{
  const hb = (await createWatch(A, { kind: "heartbeat", channelId: A.channel.id, intervalMinutes: 60, name: "备份" })).json?.data?.watch ?? {};
  const r = await patchWatch(A, hb.id, { intervalMinutes: 1440, name: "夜间备份" });
  const v = r.json?.data?.watch ?? {};
  check("★ 改间隔：报到地址不变，缺省宽限按新间隔重算", r.status === 200 && v.ping_url === hb.ping_url && v.interval_minutes === 1440 && v.grace_minutes === 144, JSON.stringify(v));
  check("宽限照新建的规矩夹", (await patchWatch(A, hb.id, { graceMinutes: 1 })).json?.data?.watch?.grace_minutes === 5);
  check("心跳的 ref 不是 id（id 是报到凭据）", typeof v.ref === "string" && v.ref.startsWith("hb-") && !v.ref.includes(hb.id));
  await call("DELETE", `/account/${A.id}/watches/${hb.id}`, { secret: A.secret });
}

console.log("\n★ 暂停与恢复、维护窗口");
{
  const w = (await createWatch(A, { kind: "up", channelId: A.channel.id, url: `${BASE}/healthz`, intervalMinutes: 15 })).json?.data?.watch ?? {};
  const T0 = Date.now();
  await sweep(T0, [w.id]);
  let r = await patchWatch(A, w.id, { paused_until: 0 });
  check("★ 一直暂停：视图带 paused_until: 0", r.status === 200 && r.json?.data?.watch?.paused_until === 0, JSON.stringify(r.json));
  check("暂停的监控不排队", (await stateOf(w.id))?.nextDueAt === Number.MAX_SAFE_INTEGER);
  const report = await sweep(T0 + 60 * 60_000, [w.id]);
  check("★ 暂停着：巡检不抓", report?.checked === 0, JSON.stringify(report));
  r = await patchWatch(A, w.id, { paused_until: null });
  check("恢复：视图里没有 paused_until，按上次检查接着排（暂停前刚查过，就等满间隔）", r.status === 200 && !("paused_until" in r.json.data.watch) && (await stateOf(w.id))?.nextDueAt === T0 + 15 * 60_000, JSON.stringify(await stateOf(w.id)));
  const until = Date.now() + 2 * 60 * 60_000;
  r = await patchWatch(A, w.id, { paused_until: until });
  check("暂停到某时", r.json?.data?.watch?.paused_until === until && (await stateOf(w.id))?.nextDueAt === until);
  check("★ 给成秒 → 400，说清楚要毫秒", (await patchWatch(A, w.id, { paused_until: Math.floor(until / 1000) })).json?.message?.includes("秒"));
  check("暂停到过去 → 400", (await patchWatch(A, w.id, { paused_until: Date.now() - 1000 })).status === 400);
  await patchWatch(A, w.id, { paused_until: null });

  const window = { days: [1, 2, 3, 4, 5, 6, 7], start: "00:00", end: "00:00", tz: "Asia/Shanghai" };
  r = await patchWatch(A, w.id, { maintenance: window });
  const v = r.json?.data?.watch ?? {};
  check("★ 设维护窗口：原样回来，此刻在窗口里（天天全天）", r.status === 200 && v.maintenance?.tz === "Asia/Shanghai" && v.maintenance.days.length === 7 && v.in_maintenance === true, JSON.stringify(v));
  check("维护窗口写错 → 400，说清怎么写", (await patchWatch(A, w.id, { maintenance: { days: [1], start: "25:00", end: "01:00", tz: "Asia/Shanghai" } })).json?.message?.includes("HH:MM"));
  check("不认得的时区 → 400", (await patchWatch(A, w.id, { maintenance: { days: [1], start: "01:00", end: "02:00", tz: "Mars/Base" } })).status === 400);
  r = await patchWatch(A, w.id, { maintenance: null });
  check("去掉维护窗口", r.status === 200 && !("maintenance" in r.json.data.watch));
  const made = await createWatch(A, { kind: "heartbeat", channelId: A.channel.id, intervalMinutes: 60, maintenance: { days: [7], start: "03:00", end: "04:00", tz: "Asia/Shanghai" } });
  check("新建时就能带维护窗口", made.status === 200 && made.json?.data?.watch?.maintenance?.start === "03:00", JSON.stringify(made.json));
  check("新建时维护窗口写错 → 400", (await createWatch(A, { kind: "heartbeat", channelId: A.channel.id, intervalMinutes: 60, maintenance: { days: [7] } })).status === 400);
  await call("DELETE", `/account/${A.id}/watches/${made.json?.data?.watch?.id}`, { secret: A.secret });
  await call("DELETE", `/account/${A.id}/watches/${w.id}`, { secret: A.secret });
}

console.log("\n★ 立即检测");
{
  const w = (await createWatch(A, { kind: "keyword", channelId: A.channel.id, url: `${BASE}/healthz`, keyword: "ok", intervalMinutes: 60 })).json?.data?.watch ?? {};
  let r = await call("POST", `/account/${A.id}/watches/${w.id}/check`, { secret: A.secret });
  const result = r.json?.data?.result ?? {};
  check("★ 现在就查：回这次的结果和响应时间", r.status === 200 && result.status === "present" && result.ok === true && typeof result.response_ms === "number" && typeof result.checked_at === "number", JSON.stringify(r.json));
  check("回来的视图已经带上这次检查", r.json?.data?.watch?.last_status === "present" && typeof r.json.data.watch.last_response_ms === "number");
  check("第一次就是目标状态：不推", r.json?.data?.alerted === false);
  r = await call("POST", `/account/${A.id}/watches/${w.id}/check`, { secret: A.secret });
  check("★ 一分钟之内再查 → 429，带 Retry-After", r.status === 429 && Number(r.headers.get("retry-after")) > 0 && (r.json?.error ?? "").includes("每分钟最多查一次"), JSON.stringify(r.json));
  check("GET 不行 → 405", (await call("GET", `/account/${A.id}/watches/${w.id}/check`, { secret: A.secret })).status === 405);
  check("别人查不了 → 404", (await call("POST", `/account/${B.id}/watches/${w.id}/check`, { secret: B.secret })).status === 404);
  const hb = (await createWatch(A, { kind: "heartbeat", channelId: A.channel.id, intervalMinutes: 60 })).json?.data?.watch ?? {};
  r = await call("POST", `/account/${A.id}/watches/${hb.id}/check`, { secret: A.secret });
  check("心跳没有网址可查 → 400", r.status === 400 && (r.json?.message ?? "").includes("心跳"));
  const down = (await createWatch(A, { kind: "up", channelId: A.channel.id, url: `${BASE}/hb`, intervalMinutes: 60 })).json?.data?.watch ?? {};
  r = await call("POST", `/account/${A.id}/watches/${down.id}/check`, { secret: A.secret });
  check("查到失败：结果照实回（HTTP 404）", r.status === 200 && r.json?.data?.result?.status === "down" && r.json.data.result.ok === false && r.json.data.result.detail === "HTTP 404", JSON.stringify(r.json));
  for (const x of [w, hb, down]) await call("DELETE", `/account/${A.id}/watches/${x.id}`, { secret: A.secret });
}

console.log("\n★ 历史与可用率");
{
  const w = (await createWatch(A, { kind: "up", channelId: A.channel.id, url: `${BASE}/healthz`, intervalMinutes: 15 })).json?.data?.watch ?? {};
  let r = await call("GET", `/account/${A.id}/watches/${w.id}/history`, { secret: A.secret });
  check("还没检查过：空的历史，可用率 null", r.status === 200 && r.json?.data?.changes?.length === 0 && r.json.data.checks.length === 0 && r.json.data.uptime_24h === null && r.json.data.tz === "UTC", JSON.stringify(r.json));
  const T0 = Date.now();
  await sweep(T0, [w.id]);
  await sweep(T0 + 15 * 60_000, [w.id]);
  r = await call("GET", `/account/${A.id}/watches/${w.id}/history?tz=Asia/Shanghai`, { secret: A.secret });
  const h = r.json?.data ?? {};
  check("★ 两次检查、一次变化（第一次在线）", h.checks?.length === 2 && h.checks.every((c) => c.ok === true && typeof c.ms === "number" && typeof c.at === "number") && h.changes?.[0]?.status === "up" && h.changes[0].detail === "HTTP 200", JSON.stringify(h));
  check("★ 按北京时间汇总的每天、可用率", h.tz === "Asia/Shanghai" && h.daily?.length >= 1 && h.daily.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date)) && h.uptime_24h === 100, JSON.stringify(h.daily));
  check("tz 写错 → 400", (await call("GET", `/account/${A.id}/watches/${w.id}/history?tz=Nowhere`, { secret: A.secret })).status === 400);
  check("别人看不了 → 404", (await call("GET", `/account/${B.id}/watches/${w.id}/history`, { secret: B.secret })).status === 404);
  check("POST 不行 → 405", (await call("POST", `/account/${A.id}/watches/${w.id}/history`, { secret: A.secret })).status === 405);
  const v = await listed(A, w.id);
  check("列表视图带上可用率和响应时间", v?.uptime_24h === 100 && typeof v.last_response_ms === "number", JSON.stringify(v));
  const meta = await stateOf(w.id);
  check("★ 状态的 metadata 里没有历史", meta && !("history" in meta));
  await call("DELETE", `/account/${A.id}/watches/${w.id}`, { secret: A.secret });
}

console.log("\n★ 心跳：/start 计时、退出码");
{
  const hb = (await createWatch(A, { kind: "heartbeat", channelId: A.channel.id, intervalMinutes: 60, name: "计时" })).json?.data?.watch ?? {};
  let r = await call("GET", `/hb/${hb.id}/start`);
  check("★ /start → 200，记下开始时刻，状态不变", r.status === 200 && typeof r.json?.data?.started_at === "number" && r.json.data.status === "new", JSON.stringify(r.json));
  check("列表里写着正在跑", typeof (await listed(A, hb.id))?.running_since === "number");
  r = await call("GET", `/hb/${hb.id}/0`);
  check("★ 退出码 0 = 正常报到，回这次的用时", r.status === 200 && r.json?.data?.status === "up" && typeof r.json.data.duration_ms === "number", JSON.stringify(r.json));
  const v = await listed(A, hb.id);
  check("列表带上 last_duration_ms，不再「正在跑」", typeof v?.last_duration_ms === "number" && !("running_since" in v), JSON.stringify(v));
  r = await call("GET", `/hb/${hb.id}/2`);
  check("★ 退出码非 0（GET 也收，curl …/$? 默认就是 GET）→ 记成失败", r.status === 200 && r.json?.data?.status === "down", JSON.stringify(r.json));
  check("退出码超过 255 → 404，说清用法", (await call("GET", `/hb/${hb.id}/256`)).status === 404);
  check("乱写的动作 → 404", (await call("GET", `/hb/${hb.id}/-1`)).status === 404 && (await call("GET", `/hb/${hb.id}/stop`)).json?.message?.includes("/start"));
  check("/fail 照旧只收 POST", (await call("GET", `/hb/${hb.id}/fail`)).status === 405);
  check("预览爬虫点开退出码地址 → 跳过", (await call("GET", `/hb/${hb.id}/3`, { headers: { "user-agent": "ExampleChatBot" } })).json?.data?.skipped === "preview");
  const hist = (await call("GET", `/account/${A.id}/watches/${hb.id}/history`, { secret: A.secret })).json?.data ?? {};
  // 本地没有 APNs 私钥，「报告失败」推不出去：状态先不改（下次重推），这次报到照样记进逐次检查
  check("历史：第一次报到记成「开始上报」，这次失败记在逐次检查里", hist.changes?.[0]?.detail === "开始上报" && hist.checks?.at(-1)?.ok === false && typeof hist.checks[0].ms === "number", JSON.stringify(hist));
  check("不存在的心跳 /start → 404", (await call("GET", "/hb/nosuchwatch1/start")).status === 404);
  await call("DELETE", `/account/${A.id}/watches/${hb.id}`, { secret: A.secret });
}

console.log("\n★ 路由");
{
  check("监控下不认得的子路径 → 404", (await call("GET", `/account/${A.id}/watches/abcdefabcdef/nope`, { secret: A.secret })).status === 404);
  check("监控本身只收 PATCH / DELETE", (await call("PUT", `/account/${A.id}/watches/abcdefabcdef`, { secret: A.secret, body: {} })).status === 405);
}

await call("DELETE", `/account/${A.id}`, { secret: A.secret });
await call("DELETE", `/account/${B.id}`, { secret: B.secret });
console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
