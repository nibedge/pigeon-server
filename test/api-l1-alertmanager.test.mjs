/**
 * 接入面：/hook/{key}/alertmanager —— 每条告警单独一条消息、按 fingerprint 各自恢复、组里有变化时只推变了的。
 *
 * 直接调 Worker 的 fetch，KV 放内存里，APNs 换成截获请求的假 fetch（见 l1-harness.mjs）—— 推出去的 payload
 * 看得见，所以能断言「推出去的正是想要的」。包由 l1-harness.mjs 自己打，不依赖别的 npm 脚本先跑过。
 * 文件名以 api 开头只是为了让 run-api.sh 顺带跑它；它不用 BASE，不连本地 wrangler dev。
 */
import { apns, call, check, finish, lastPush, makeEnv, newAccount } from "./l1-harness.mjs";

// ── Alertmanager ─────────────────────────────────────────────────────

console.log("\n★ Alertmanager：每条告警单独一条消息");
{
  const env = makeEnv();
  const a = await newAccount(env);
  const iso = (ms) => new Date(ms).toISOString();
  const now = Date.now();
  const alert = (fp, status, extra = {}) => ({
    status,
    labels: { alertname: "HighCPU", instance: `db-${fp}:9100`, severity: "critical", ...(extra.labels ?? {}) },
    annotations: { summary: `CPU 过高（${fp}）`, runbook_url: "https://runbook.example/cpu", ...(extra.annotations ?? {}) },
    startsAt: iso(extra.startsAt ?? now - 60_000),
    endsAt: status === "resolved" ? iso(now) : "0001-01-01T00:00:00Z",
    generatorURL: "https://prom.example/graph",
    fingerprint: `${fp}`.padStart(16, "0"),
  });
  const group = (alerts, extra = {}) => ({
    version: "4", status: alerts.some((x) => x.status === "firing") ? "firing" : "resolved", receiver: "pigeon",
    groupKey: '{}:{alertname="HighCPU"}', groupLabels: { alertname: "HighCPU" }, commonLabels: { alertname: "HighCPU" },
    externalURL: "https://am.example", truncatedAlerts: 0, alerts, ...extra,
  });

  let before = apns.length;
  let r = await call(env, "POST", `/hook/${a.key}/alertmanager`, { json: group([alert(1, "firing"), alert(2, "firing", { labels: { severity: "warning" } })]) });
  let pushed = apns.slice(before).map((x) => x.payload);
  check("★ 两条告警 → 两条消息", pushed.length === 2, `${pushed.length} ${r.text}`);
  check("★ id 是 am-{fingerprint}", pushed[0]?.id === "am-0000000000000001" && pushed[1]?.id === "am-0000000000000002", pushed.map((x) => x.id).join(","));
  check("★ critical → 时效性、warning → 普通", pushed[0]?.aps["interruption-level"] === "time-sensitive" && pushed[1]?.aps["interruption-level"] === "active");
  check("★ 标题、副标题写着机器和「本组 2 条触发」", pushed[0]?.aps.alert.title === "🔴 触发 · HighCPU" && pushed[0]?.aps.alert.subtitle === "db-1:9100 · critical · 本组 2 条触发", JSON.stringify(pushed[0]?.aps.alert));
  check("★ 点开是 runbook_url", pushed[0]?.url === "https://runbook.example/cpu");
  check("同一组叠在一起（同一个 thread-id）", pushed[0]?.aps["thread-id"] === pushed[1]?.aps["thread-id"] && pushed[0]?.aps["thread-id"].startsWith("alertmanager-"));
  check("status=firing", pushed.every((x) => x.status === "firing"));
  check("响应列出每条的 id 和送达数", r.status === 200 && r.json?.data?.messages?.length === 2 && r.json.data.delivered === 2, r.text);

  // 组里加入一条新的（几分钟后，Alertmanager 把整组再发一遍）：旧的两条不再重推，新消息里点名。
  // 旧的两条才触发一两分钟 —— 只看触发时间分不出来，要靠记着推过哪几条
  before = apns.length;
  r = await call(env, "POST", `/hook/${a.key}/alertmanager`, { json: group([alert(1, "firing"), alert(2, "firing", { labels: { severity: "warning" } }), alert(3, "firing")]) });
  pushed = apns.slice(before).map((x) => x.payload);
  check("★ 组里加入新告警：只推新的那条（旧的两条刚触发不久也不重推）", pushed.length === 1 && pushed[0]?.id === "am-0000000000000003", pushed.map((x) => x.id).join(","));
  check("★ 新消息里点名同组仍在触发的", pushed[0]?.aps.alert.body.includes("同组仍在触发：db-1:9100、db-2:9100"), pushed[0]?.aps.alert.body);
  check("响应里说有 2 条没变、没重推", r.json?.data?.unchanged === 2, r.text);
  const seenKeys = () => [...env.PIGEON_KV.store.keys()].filter((k) => k.startsWith("amseen:"));
  const seenRecord = JSON.parse(env.PIGEON_KV.store.get(seenKeys()[0]) ?? "{}");
  check("★ KV 里按组记着推过哪几条：只有指纹和触发时刻", seenKeys().length === 1 && seenKeys()[0].startsWith(`amseen:${a.channelId}:`) && Object.keys(seenRecord.alerts ?? {}).length === 3 && !JSON.stringify(seenRecord).includes("CPU"), JSON.stringify(seenRecord));

  // 一条新的都没有（repeat_interval 到了的重发）：整组照推
  before = apns.length;
  await call(env, "POST", `/hook/${a.key}/alertmanager`, { json: group([alert(1, "firing"), alert(2, "firing", { labels: { severity: "warning" } }), alert(3, "firing")]) });
  check("★ 全是推过的（repeat_interval 到了的重发）：整组照推，不漏", apns.length === before + 3, `${apns.length - before}`);

  // 恢复之后又触发了：startsAt 变了，算新的一次
  await call(env, "POST", `/hook/${a.key}/alertmanager`, { json: group([alert(1, "resolved"), alert(2, "firing", { labels: { severity: "warning" } }), alert(3, "firing")]) });
  before = apns.length;
  await call(env, "POST", `/hook/${a.key}/alertmanager`, { json: group([alert(1, "firing", { startsAt: now + 60_000 }), alert(2, "firing", { labels: { severity: "warning" } }), alert(3, "firing")]) });
  check("★ 恢复后再触发（startsAt 变了）：只推它，另两条不动", apns.slice(before).map((x) => x.payload.id).join(",") === "am-0000000000000001", apns.slice(before).map((x) => x.payload.id).join(","));
  await call(env, "POST", `/hook/${a.key}/alertmanager`, { json: group([alert(1, "resolved"), alert(2, "resolved"), alert(3, "resolved")]) });
  check("整组都恢复：记录删掉", seenKeys().length === 0, seenKeys().join(","));

  // 没有记录（第一次见到这一组、记录过期）：按触发时间猜，3 小时前触发的当作推过了
  const fresh = makeEnv();
  const f = await newAccount(fresh);
  const beforeFresh = apns.length;
  r = await call(fresh, "POST", `/hook/${f.key}/alertmanager`, { json: group([alert(61, "firing", { startsAt: now - 3 * 3600_000 }), alert(62, "firing")]) });
  check("★ 没有记录时按触发时间猜：只推 30 分钟内触发的，老的点名", apns.length === beforeFresh + 1 && lastPush().sent.id === "am-0000000000000062" && lastPush().alert.body.includes("同组仍在触发：db-61:9100") && r.json?.data?.unchanged === 1, r.text);
  before = apns.length;
  await call(fresh, "POST", `/hook/${f.key}/alertmanager`, { json: group([alert(61, "firing", { startsAt: now - 3 * 3600_000 }), alert(62, "firing"), alert(63, "firing")]) });
  check("猜过一次之后有了记录：再来一条新的，只推新的", apns.slice(before).map((x) => x.payload.id).join(",") === "am-0000000000000063", apns.slice(before).map((x) => x.payload.id).join(","));

  // 通道默认值带重复提醒：恢复时按条停下
  await call(env, "PATCH", `/account/${a.id}/channels/${a.channelId}`, { secret: a.secret, json: { defaults: { repeat: "5" } } });
  await call(env, "POST", `/hook/${a.key}/alertmanager`, { json: group([alert(7, "firing", { startsAt: now - 18 * 60_000 }), alert(8, "firing", { startsAt: now - 10 * 60_000 })]) });
  const repeats = () => [...env.PIGEON_KV.store.keys()].filter((k) => k.startsWith("repeat:")).map((k) => k.split(":").pop());
  check("两条都排上了重复提醒", repeats().includes("am-0000000000000007") && repeats().includes("am-0000000000000008"), repeats().join(","));
  before = apns.length;
  r = await call(env, "POST", `/hook/${a.key}/alertmanager`, { json: group([alert(7, "resolved", { startsAt: now - 18 * 60_000 }), alert(8, "firing", { startsAt: now - 10 * 60_000 })]) });
  pushed = apns.slice(before).map((x) => x.payload);
  check("★ 一条恢复：只推恢复的那条，另一条不动", pushed.length === 1 && pushed[0]?.id === "am-0000000000000007" && pushed[0]?.status === "resolved", pushed.map((x) => `${x.id}:${x.status}`).join(","));
  check("★ 恢复静默送达，标题「🟢 恢复」，正文写持续多久", pushed[0]?.aps["interruption-level"] === "passive" && pushed[0]?.aps.alert.title === "🟢 恢复 · HighCPU" && pushed[0]?.aps.alert.body.includes("持续 18 分钟"), JSON.stringify(pushed[0]?.aps));
  check("★ 只停了恢复的那条的提醒", !repeats().includes("am-0000000000000007") && repeats().includes("am-0000000000000008"), repeats().join(","));
  await call(env, "PATCH", `/account/${a.id}/channels/${a.channelId}`, { secret: a.secret, json: { defaults: {} } });

  // 一次太多：前 9 条单独推，其余并成一条
  before = apns.length;
  r = await call(env, "POST", `/hook/${a.key}/alertmanager`, { json: group(Array.from({ length: 14 }, (_, i) => alert(100 + i, "firing")), { truncatedAlerts: 3 }) });
  pushed = apns.slice(before).map((x) => x.payload);
  check("★ 14 条：一次最多 10 条消息（9 条单独 + 1 条「另有 5 条」）", pushed.length === 10 && pushed.at(-1)?.aps.alert.title === "🔴 另有 5 条触发", `${pushed.length} ${pushed.at(-1)?.aps.alert.title}`);
  check("并成的那条列出是哪几条", pushed.at(-1)?.aps.alert.body.includes("HighCPU · db-109:9100"), pushed.at(-1)?.aps.alert.body);
  check("响应 warnings 说明并了几条", r.json?.data?.warnings?.some((w) => w.includes("并成了一条")), r.text);
  check("truncatedAlerts 写进正文", pushed[0]?.aps.alert.body.includes("另有 3 条告警没带上"), pushed[0]?.aps.alert.body);

  // 额度用完、恢复的那条没推出去：它之前排下的重复提醒照样替它停掉（响应是 200，Alertmanager 不会重发）
  const capped = makeEnv({ RL_PUSH: (() => { let n = 0; return { limit: async () => ({ success: ++n <= 2 }) }; })() });
  const c = await newAccount(capped);
  await call(capped, "PATCH", `/account/${c.id}/channels/${c.channelId}`, { secret: c.secret, json: { defaults: { repeat: "5" } } });
  await call(capped, "POST", `/hook/${c.key}/alertmanager`, { json: group([alert(41, "firing")]) });
  const cappedRepeats = () => [...capped.PIGEON_KV.store.keys()].filter((k) => k.startsWith("repeat:")).map((k) => k.split(":").pop());
  check("（前置）41 排上了重复提醒", cappedRepeats().includes("am-0000000000000041"), cappedRepeats().join(","));
  r = await call(capped, "POST", `/hook/${c.key}/alertmanager`, { json: group([alert(42, "firing"), alert(43, "firing"), alert(41, "resolved", { startsAt: now - 3600_000 })]) });
  check("★ 额度用完没推出去的恢复告警：重复提醒照样停下", !cappedRepeats().includes("am-0000000000000041") && r.json?.data?.messages?.length === 1, `${cappedRepeats().join(",")} ${r.text}`);

  r = await call(env, "POST", `/hook/${a.key}/alertmanager`, { json: group([]) });
  check("空的一组 → 200 skipped", r.status === 200 && r.json?.data?.skipped === true, r.text);

  // 通道每分钟的额度按条算
  const tight = makeEnv({ RL_PUSH: (() => { let n = 0; return { limit: async () => ({ success: ++n <= 2 }) }; })() });
  const t = await newAccount(tight);
  before = apns.length;
  r = await call(tight, "POST", `/hook/${t.key}/alertmanager`, { json: group([alert(21, "firing"), alert(22, "firing"), alert(23, "firing")]) });
  check("★ 额度按条扣：只推得出 2 条，响应说还有 1 条没推", apns.length - before === 2 && r.json?.data?.warnings?.some((w) => w.includes("还有 1 条没推")), `${apns.length - before} ${r.text}`);

  // 额度用完没推出去的那条不记成「推过」：下一次组里有变化（或者整组重发）时照推，不会就此漏掉
  let allowed = 2;
  const gate = makeEnv({ RL_PUSH: { limit: async () => ({ success: allowed-- > 0 }) } });
  const g = await newAccount(gate);
  await call(gate, "POST", `/hook/${g.key}/alertmanager`, { json: group([alert(31, "firing"), alert(32, "firing"), alert(33, "firing")]) });
  allowed = 100;
  before = apns.length;
  await call(gate, "POST", `/hook/${g.key}/alertmanager`, { json: group([alert(31, "firing"), alert(32, "firing"), alert(33, "firing"), alert(34, "firing")]) });
  check("★ 上次没推出去的，这次和新来的一起推；推出去了的不再响", apns.slice(before).map((x) => x.payload.id).sort().join(",") === "am-0000000000000033,am-0000000000000034", apns.slice(before).map((x) => x.payload.id).join(","));

  check("/info 的适配器列表里有 alertmanager 和 json", (await call(env, "GET", "/info")).json?.data?.adapters?.map((x) => x.name).join(",").includes("alertmanager,json"));
}

finish();
