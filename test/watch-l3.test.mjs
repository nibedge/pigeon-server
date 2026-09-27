/**
 * 监控管理：编辑、暂停、维护窗口、立即检测、历史与可用率、心跳的开始计时和退出码。
 *
 * 纯函数直接核对；和状态、告警有关的跑在内存 KV 上，APNs 和被监控的网站都用假的 fetch 截下来 ——
 * 维护窗口里「该不该推、推什么、之后补不补」只有真推一遍才说得清。
 * 时刻都拨到固定的一刻：2026-09-27（周日）18:00 UTC = 北京时间周一 02:00。
 */
import { generateKeyPairSync } from "node:crypto";
import {
  checkWatchNow,
  createWatch,
  cancelWatchRepeats,
  formatDuration,
  getWatch,
  heartbeatDeadline,
  heartbeatMessageId,
  nextDueAt,
  parseWatchInput,
  recordHeartbeat,
  recordHeartbeatStart,
  runDuration,
  runScheduled,
  siteDueAt,
  watchRef,
} from "../.test-build/l3/watch.mjs";
import { putWatchConfig, readWatchState, writeWatchState } from "../.test-build/l3/db.mjs";
import { applyWatchEdit } from "../.test-build/l3/watchedit.mjs";
import { watchDetails } from "../.test-build/l3/watchview.mjs";
import {
  dailyUptime,
  historyStats,
  HISTORY_CHANGES,
  HISTORY_HOURS,
  HISTORY_MAX_CHECKS,
  readHistory,
  recordHistory,
  uptimePercent,
} from "../.test-build/l3/watchhistory.mjs";
import { gate, inMaintenance, isPaused, parseMaintenance, parsePausedUntil, quietEnd } from "../.test-build/l3/watchquiet.mjs";

const logged = [];
console.error = (...args) => logged.push(args.map(String).join(" "));
console.warn = console.error;

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? `  → ${detail}` : ""}`); }
}

const T0 = 1790532000000; // 2026-09-27 18:00 UTC，北京时间周一 02:00
const MIN = 60_000;
const HOUR = 60 * MIN;
const SH = "Asia/Shanghai";
/** 北京时间周一 01:30–03:00 */
const MON_NIGHT = { days: [1], start: "01:30", end: "03:00", tz: SH };

// ── 维护窗口、暂停：解析与判定 ─────────────────────────────────────────

console.log("\n★ 维护窗口：解析");
{
  const ok = parseMaintenance({ days: [3, 1, 1], start: "01:30", end: "03:00", tz: SH });
  check("合法的窗口：星期去重排好", typeof ok === "object" && ok.days.join(",") === "1,3" && ok.tz === SH, JSON.stringify(ok));
  check("时区也认 timezone 的写法", parseMaintenance({ days: [1], start: "01:00", end: "02:00", timezone: SH })?.tz === SH);
  check("null → 去掉", parseMaintenance(null) === null);
  check("没有星期几 → 说明", typeof parseMaintenance({ days: [], start: "01:00", end: "02:00", tz: SH }) === "string");
  check("星期几超出 1–7 → 说明", typeof parseMaintenance({ days: [8], start: "01:00", end: "02:00", tz: SH }) === "string");
  check("时刻不是 HH:MM → 说明", typeof parseMaintenance({ days: [1], start: "3:00", end: "04:00", tz: SH }) === "string");
  check("不认得的时区 → 说明", typeof parseMaintenance({ days: [1], start: "01:00", end: "02:00", tz: "Mars/Base" }) === "string");
  check("没给时区 → 说明", typeof parseMaintenance({ days: [1], start: "01:00", end: "02:00" }) === "string");
  check("不是对象 → 说明", typeof parseMaintenance("每周一") === "string");
}

console.log("\n★ 维护窗口：什么时候算在里面（按窗口自己的时区）");
{
  check("周一 02:00 在周一 01:30–03:00 里", inMaintenance(MON_NIGHT, T0));
  check("01:30 整算在里面，01:29 不算", inMaintenance(MON_NIGHT, T0 - 30 * MIN) && !inMaintenance(MON_NIGHT, T0 - 31 * MIN));
  check("03:00 整就结束了", !inMaintenance(MON_NIGHT, T0 + 60 * MIN) && inMaintenance(MON_NIGHT, T0 + 59 * MIN));
  check("★ 同一时刻换成 UTC 的窗口就不在（按时区算，不按服务器时间）", !inMaintenance({ ...MON_NIGHT, tz: "UTC" }, T0));
  check("下周一同一时刻又在里面", inMaintenance(MON_NIGHT, T0 + 7 * 24 * HOUR) && !inMaintenance(MON_NIGHT, T0 + 24 * HOUR));
  const sunday = { days: [7], start: "23:00", end: "01:00", tz: SH };
  check("★ 跨午夜：周日 23:00–01:00，周一 00:30 也在（算周日的窗口）", inMaintenance(sunday, T0 - 90 * MIN));
  check("跨午夜：周日 23:30 在，周一 01:00 不在", inMaintenance(sunday, T0 - 150 * MIN) && !inMaintenance(sunday, T0 - 60 * MIN));
  check("跨午夜：周六 23:30 不在（只选了周日）", !inMaintenance(sunday, T0 - 150 * MIN - 24 * HOUR));
  const allDay = { days: [1], start: "00:00", end: "00:00", tz: SH };
  check("起止相同是整整 24 小时：周一全天在，周日、周二不在", inMaintenance(allDay, T0) && !inMaintenance(allDay, T0 - 3 * HOUR) && !inMaintenance(allDay, T0 + 22 * HOUR + 1));
  check("没设窗口不算", !inMaintenance(undefined, T0));
}

console.log("\n★ 安静期：暂停和维护窗口各到什么时候");
{
  const inWindow = quietEnd({ maintenance: MON_NIGHT }, T0);
  check("维护窗口里：到窗口结束（北京时间 03:00）", inWindow?.why === "maint" && inWindow?.until === T0 + 60 * MIN, JSON.stringify(inWindow));
  const sunday = quietEnd({ maintenance: { days: [7], start: "23:00", end: "01:00", tz: SH } }, T0 - 90 * MIN + 17_000);
  check("跨午夜的窗口结束在第二天 01:00，按整分钟算", sunday?.until === T0 - 60 * MIN, JSON.stringify(sunday));
  check("窗口外：不是安静期", quietEnd({ maintenance: MON_NIGHT }, T0 + 2 * HOUR) === null);
  check("暂停到某时：到那时", quietEnd({ pausedUntil: T0 + HOUR }, T0)?.until === T0 + HOUR && quietEnd({ pausedUntil: T0 + HOUR }, T0)?.why === "pause");
  check("★ 一直暂停：until 是 0（等手动恢复）", quietEnd({ pausedUntil: 0 }, T0)?.until === 0);
  check("暂停的时刻已经过了（恢复过的）：不是安静期", quietEnd({ pausedUntil: T0 - 1 }, T0) === null && !isPaused({ pausedUntil: T0 - 1 }, T0));
  check("暂停优先于维护窗口", quietEnd({ pausedUntil: 0, maintenance: MON_NIGHT }, T0)?.why === "pause");
}

console.log("\n★ paused_until 的写法");
{
  check("没给 → 不动", parsePausedUntil(undefined, T0) === undefined);
  check("null → 恢复", parsePausedUntil(null, T0) === null);
  check("0 → 一直暂停", parsePausedUntil(0, T0) === 0);
  check("将来的毫秒时刻 → 暂停到那时", parsePausedUntil(T0 + HOUR, T0) === T0 + HOUR && parsePausedUntil(String(T0 + HOUR), T0) === T0 + HOUR);
  check("已经过了 → 说明", String(parsePausedUntil(T0 - 1, T0)).includes("已经过了"));
  check("★ 给成秒 → 说清楚要毫秒", String(parsePausedUntil(Math.floor(T0 / 1000) + 3600, T0)).includes("秒"));
  check("超过一年 → 说明（一直停着用 0）", String(parsePausedUntil(T0 + 400 * 24 * HOUR, T0)).includes("0"));
  check("乱写、负数 → 说明", typeof parsePausedUntil("明天", T0) === "string" && typeof parsePausedUntil(-5, T0) === "string");
}

console.log("\n★ 安静期里的告警怎么处理（gate）");
{
  const Q = { until: T0 + HOUR, why: "maint" };
  const held = { from: "up", until: T0 + HOUR, why: "maint" };
  let g = gate({ lastStatus: "up" }, "down", "firing", Q);
  check("安静期里掉线：不推，记住压下之前是 up", g.action === "none" && g.quiet?.from === "up" && g.quiet?.until === T0 + HOUR);
  g = gate({ lastStatus: undefined }, "down", "firing", Q);
  check("刚建就掉线：压下之前「还没有状态」记成空串", g.action === "none" && g.quiet?.from === "");
  g = gate({ lastStatus: "down", quiet: held }, "up", "resolved", Q);
  check("★ 安静期里掉了又好了：互相抵消，什么都不推", g.action === "none" && g.quiet === undefined);
  g = gate({ lastStatus: "down" }, "up", "resolved", Q);
  check("★ 之前告过警的事在安静期里恢复：静默送达", g.action === "quiet-send" && g.quiet === undefined);
  g = gate({ lastStatus: "down", quiet: held }, "down", null, { until: T0 + 2 * HOUR, why: "maint" });
  check("还压着、状态没变：接着压，结束时刻跟着更新", g.action === "none" && g.quiet?.from === "up" && g.quiet?.until === T0 + 2 * HOUR);
  g = gate({ lastStatus: "down", quiet: held }, "down", null, null);
  check("★ 安静期结束、还是 down：补推", g.action === "settle" && g.quiet === undefined);
  g = gate({ lastStatus: "down", quiet: held }, "down", "firing", null);
  check("安静期结束时恰好有新告警：推新告警（它说的就是现状）", g.action === "send");
  g = gate({ lastStatus: "up", quiet: held }, "up", null, null);
  check("安静期结束、已经好了：什么都不推，压着的了结", g.action === "none" && g.quiet === undefined);
  check("不在安静期、没压着：照常", gate({ lastStatus: "up" }, "down", "firing", null).action === "send" && gate({ lastStatus: "up" }, "up", null, null).action === "none");
  g = gate({ lastStatus: "down" }, "down", "firing", Q);
  check("★ 已经告过警的 down 在安静期里又报失败：不推，也不记成压着（之后的恢复照样静默送达）", g.action === "none" && g.quiet === undefined);
}

// ── 历史 ──────────────────────────────────────────────────────────────

console.log("\n★ 历史：按时长算可用率，状态变化、每次检查都记下");
{
  let h = recordHistory(undefined, T0, { cls: 1, sample: { ok: true, ms: 120 }, change: { status: "up", detail: "HTTP 200" } });
  check("第一次：记下检查和变化，还没有时长", h.checks.length === 1 && h.checks[0].join(",") === `${T0 / 1000},120,1` && h.changes[0].status === "up" && h.hours.up.length === 0);
  check("第一次之前没有数据：可用率是 null", uptimePercent(h, T0, 24) === null);
  h = recordHistory(h, T0 + 90 * MIN, { cls: 0, sample: { ok: false }, change: { status: "down", detail: "HTTP 503" } });
  check("★ 上一次以来的 90 分钟记在「正常」名下，按小时切开", h.hours.up.join(",") === "3600,1800" && h.hours.down.join(",") === "0,0", JSON.stringify(h.hours));
  check("没有毫秒数的检查记成 -1", h.checks[1][1] === -1 && h.checks[1][2] === 0);
  h = recordHistory(h, T0 + 120 * MIN, { cls: 1, sample: { ok: true, ms: 80 }, change: { status: "up" } });
  check("异常的 30 分钟记在「异常」名下", h.hours.down.join(",") === "0,1800");
  check("★ 可用率 = 正常时长 ÷ 总时长：75%", uptimePercent(h, T0 + 120 * MIN, 24) === 75);
  check("★ 还没写下的这一段（上次记录到现在）也算上", uptimePercent(h, T0 + 180 * MIN, 24) === 83.33);
  const stats = historyStats(h, T0 + 120 * MIN);
  check("最近一次的毫秒数", stats.lastMs === 80 && stats.uptime7d === 75 && stats.uptime30d === 75);
  check("往下取两位：有过异常就不显示成 100", uptimePercent(recordHistory(recordHistory(h, T0 + 200 * MIN, { cls: 1 }), T0 + 20000 * MIN, { cls: 1 }), T0 + 20000 * MIN, 30 * 24) < 100);
  const before = JSON.stringify(h);
  recordHistory(h, T0 + 300 * MIN, { cls: 0, change: { status: "down" } });
  check("不改传进去的那份（告警没推出去时要拿原样重来）", JSON.stringify(h) === before);
  const excluded = recordHistory(recordHistory(h, T0 + 130 * MIN, { cls: -1 }), T0 + 500 * MIN, { cls: 1 });
  check("「不计」的时段（暂停、维护里的异常）既不算正常也不算异常", excluded.hours.up.reduce((a, b) => a + b, 0) === 5400 + 600 && excluded.hours.down.reduce((a, b) => a + b, 0) === 1800);
}

console.log("\n★ 历史：有上限，不会越存越大");
{
  let h;
  for (let i = 0; i < 600; i++) h = recordHistory(h, T0 + i * MIN, { cls: 1, sample: { ok: true, ms: 50 } });
  check(`每分钟一次、十小时：逐次检查最多留 ${HISTORY_MAX_CHECKS} 条`, h.checks.length === HISTORY_MAX_CHECKS && h.checks.at(-1)[0] === (T0 + 599 * MIN) / 1000);
  h = undefined;
  for (let i = 0; i < 12 * 24 * 3; i++) h = recordHistory(h, T0 + i * 5 * MIN, { cls: 1, sample: { ok: true, ms: 50 } });
  const now = T0 + (12 * 24 * 3 - 1) * 5 * MIN;
  check("三天每 5 分钟一次：逐次检查只留最近 24 小时", h.checks.length === 289 && h.checks[0][0] >= (now - 24 * HOUR) / 1000, `${h.checks.length}`);
  h = undefined;
  for (let i = 0; i < 30; i++) h = recordHistory(h, T0 + i * MIN, { cls: i % 2 ? 0 : 1, change: { status: i % 2 ? "down" : "up", detail: "x".repeat(200) } });
  check(`状态变化只留最近 ${HISTORY_CHANGES} 次，说明截到 60 字`, h.changes.length === HISTORY_CHANGES && h.changes.at(-1).at === T0 + 29 * MIN && h.changes[0].detail.length === 60);
  h = recordHistory(recordHistory(undefined, T0, { cls: 1 }), T0 + 40 * 24 * HOUR, { cls: 1 });
  check(`按小时的格子最多 ${HISTORY_HOURS} 个（30 天）`, h.hours.up.length === HISTORY_HOURS && uptimePercent(h, T0 + 40 * 24 * HOUR, 30 * 24) === 100);
  h = recordHistory(h, T0 + 100 * 24 * HOUR, { cls: 1 });
  check("隔了两个多月：整个重来，不补上千个空格子", h.hours.up.length <= HISTORY_HOURS);
  const size = JSON.stringify(h).length;
  check("历史的体积有数（一整天每 5 分钟一次也就几 KB）", size < 16_000, `${size}`);
  check("改坏了的历史当作没有，从零记", readHistory({ changes: "x" }) === undefined && recordHistory({ hours: 1 }, T0, { cls: 1 }).checks.length === 0);
}

console.log("\n★ 按时区汇总每天");
{
  const h = recordHistory(recordHistory(undefined, T0, { cls: 1 }), T0 + 8 * HOUR, { cls: 1 });
  const utc = dailyUptime(h, T0 + 8 * HOUR, "UTC");
  const bj = dailyUptime(h, T0 + 8 * HOUR, SH);
  check("UTC：分在 27 日（6 小时）和 28 日（2 小时）", utc.length === 2 && utc[0].date === "2026-09-27" && utc[0].up_seconds === 6 * 3600 && utc[1].up_seconds === 2 * 3600, JSON.stringify(utc));
  check("★ 北京时间：全在 28 日（周一 02:00–10:00）", bj.length === 1 && bj[0].date === "2026-09-28" && bj[0].up_seconds === 8 * 3600 && bj[0].uptime === 100, JSON.stringify(bj));
  check("时区不认得 → null", dailyUptime(h, T0, "Bad/Zone") === null);
  check("没有历史 → 空", dailyUptime(undefined, T0, SH).length === 0);
}

// ── 编辑 ──────────────────────────────────────────────────────────────

console.log("\n★ 编辑：校验同新建，只改给了的字段");
{
  const site = {
    id: "site00000001", ownerId: "owner0001", createdAt: T0 - 86_400_000, channelId: "chan0001", kind: "up",
    url: "https://a.test/x", intervalMinutes: 15, name: "a.test",
    lastStatus: "down", lastCheckedAt: T0 - MIN, failCount: 3, lastDetail: "HTTP 500",
  };
  const edit = (patch, base = site) => applyWatchEdit(base, patch, T0);
  check("一个认得的字段都没有 → 说明", String(edit({ foo: 1 })).includes("能改的有"));
  check("网址不合法 → 和新建一样的说明", edit({ url: "ftp://a.test" }) === "只支持 http / https 网址");
  let e = edit({ url: "https://b.test/" });
  check("★ 换网址：名字当初是域名的，跟着换成新域名", e.watch.url === "https://b.test/" && e.watch.name === "b.test");
  check("★ 换网址：掉线状态留着（新网址好了就推「恢复了」），失败计数清掉，下一轮就查", e.watch.lastStatus === "down" && e.watch.failCount === undefined && e.watch.lastCheckedAt === undefined && e.stateChanged && !e.cancelIn);
  check("自己起的名字不跟着换", edit({ url: "https://b.test/" }, { ...site, name: "主站" }).watch.name === "主站");
  check("间隔照新建的规矩夹到 5 分钟", edit({ intervalMinutes: 1 }).watch.intervalMinutes === 5 && edit({ interval_minutes: 30 }).watch.intervalMinutes === 30);
  check("改间隔要重排（状态重写），不动索引", edit({ intervalMinutes: 30 }).stateChanged && !edit({ intervalMinutes: 30 }).indexChanged);
  e = edit({ kind: "keyword", keyword: "有票" });
  check("★ 掉线改成关键词：状态从头来（第一次检查不提醒），原来的提醒停掉，索引跟着改", e.watch.kind === "keyword" && e.watch.present === true && e.watch.lastStatus === undefined && e.cancelIn === "chan0001" && e.indexChanged);
  check("改成关键词却没给词 → 和新建一样的说明", edit({ kind: "keyword" }) === "关键词监控要给出 keyword");
  check("★ 网址监控和心跳不能互相改", String(edit({ kind: "heartbeat" })).includes("不能互相改"));
  e = edit({ level: "timeSensitive", repeat: 5 });
  check("提醒强度", e.watch.level === "timeSensitive" && e.watch.repeat === 5 && !e.stateChanged);
  e = edit({ level: null, repeat: 0 }, e.watch);
  check("level 给 null、repeat 给 0：去掉", e.watch.level === undefined && e.watch.repeat === undefined && e.changed);
  check("level 写错 → 说明", typeof edit({ level: "loud" }) === "string");
  e = edit({ name: "主站" });
  check("只改名字：只写配置", e.changed && !e.stateChanged && !e.indexChanged && e.watch.name === "主站" && e.watch.updatedAt === T0);
  check("★ 改成一模一样：什么都不写", edit({ name: "a.test", intervalMinutes: 15 }).changed === false);
  e = edit({ channel_id: "chan0002" });
  check("换通道：索引跟着改，原通道里的提醒停掉", e.watch.channelId === "chan0002" && e.indexChanged && e.cancelIn === "chan0001");
  check("通道 id 格式不对 → 说明", typeof edit({ channelId: "!!" }) === "string");
}

console.log("\n★ 编辑：暂停、恢复、维护窗口");
{
  const hist = recordHistory(undefined, T0 - HOUR, { cls: 1, sample: { ok: true, ms: 10 } });
  const site = {
    id: "site00000002", ownerId: "owner0001", createdAt: T0 - 86_400_000, channelId: "chan0001", kind: "up",
    url: "https://a.test/", intervalMinutes: 15, name: "a.test", lastStatus: "up", lastCheckedAt: T0 - MIN, history: hist,
  };
  let e = applyWatchEdit(site, { paused_until: 0 }, T0);
  check("★ 一直暂停：记 0，要重排，原来的提醒停掉", e.watch.pausedUntil === 0 && e.stateChanged && e.cancelIn === "chan0001");
  check("暂停的这一刻给历史换计时起点：之前的记正常，之后不计", e.watch.history.cur === -1 && e.watch.history.hours.up.reduce((a, b) => a + b, 0) === 3600);
  check("一直暂停的网址监控不排队", siteDueAt(e.watch) === Number.MAX_SAFE_INTEGER);
  const resumed = applyWatchEdit(e.watch, { paused_until: null }, T0 + 2 * HOUR);
  check("★ 恢复：记成恢复的那一刻，不再算暂停", resumed.watch.pausedUntil === T0 + 2 * HOUR && !isPaused(resumed.watch, T0 + 2 * HOUR) && resumed.stateChanged);
  check("恢复后计时从现在的状态接着算", resumed.watch.history.cur === 1 && resumed.watch.history.since === T0 + 2 * HOUR);
  check("恢复后网址监控马上到期（暂停前上次检查早就过了间隔）", siteDueAt(resumed.watch) === T0 + 2 * HOUR);
  check("没暂停时恢复：什么都不改", applyWatchEdit(site, { paused_until: null }, T0).changed === false);
  e = applyWatchEdit(site, { paused_until: T0 + HOUR }, T0);
  check("暂停到某时：到那时才再查", e.watch.pausedUntil === T0 + HOUR && siteDueAt(e.watch) === T0 + HOUR);
  check("暂停到过去 → 说明", typeof applyWatchEdit(site, { paused_until: T0 - 1 }, T0) === "string");
  e = applyWatchEdit(site, { maintenance: MON_NIGHT }, T0);
  check("设维护窗口：只写配置", e.watch.maintenance?.start === "01:30" && e.changed && !e.stateChanged);
  check("去掉维护窗口", applyWatchEdit(e.watch, { maintenance: null }, T0).watch.maintenance === undefined);
  check("维护窗口写错 → 说明", typeof applyWatchEdit(site, { maintenance: { days: [9] } }, T0) === "string");
  const held = { ...site, lastStatus: "down", maintenance: MON_NIGHT, quiet: { from: "up", until: T0 + HOUR, why: "maint" } };
  e = applyWatchEdit(held, { maintenance: null }, T0);
  check("★ 压着告警时去掉维护窗口：下一轮马上补判", e.watch.quiet?.until === T0 && e.stateChanged && nextDueAt(e.watch) === T0);

  const hb = {
    id: "hb0000000001", ownerId: "owner0001", createdAt: T0 - 86_400_000, channelId: "chan0001", kind: "heartbeat",
    intervalMinutes: 60, graceMinutes: 6, name: "备份", lastStatus: "up", lastPingAt: T0 - 10 * MIN,
  };
  check("★ 心跳改间隔：宽限当初是缺省的，按新间隔重算", applyWatchEdit(hb, { intervalMinutes: 1440 }, T0).watch.graceMinutes === 144);
  check("自己设过的宽限照留", applyWatchEdit({ ...hb, graceMinutes: 30 }, { intervalMinutes: 1440 }, T0).watch.graceMinutes === 30);
  check("宽限照新建的规矩夹到 5 分钟", applyWatchEdit(hb, { grace_minutes: 1 }, T0).watch.graceMinutes === 5);
  check("心跳的间隔不能是 0", typeof applyWatchEdit(hb, { intervalMinutes: 0 }, T0) === "string");
  check("改了宽限要重排失联的时刻", applyWatchEdit(hb, { graceMinutes: 30 }, T0).stateChanged);
  const paused = applyWatchEdit(hb, { paused_until: T0 + 3 * HOUR }, T0).watch;
  check("★ 心跳暂停到某时：失联从暂停结束重新计时", heartbeatDeadline(paused) === T0 + 3 * HOUR + 66 * MIN);
  check("一直暂停的心跳不判失联", heartbeatDeadline(applyWatchEdit(hb, { paused_until: 0 }, T0).watch) === 0);
}

// ── 内存 KV + 假 APNs + 假网站 ────────────────────────────────────────

function memoryKV() {
  const store = new Map();
  const meta = new Map();
  const puts = new Map();
  return {
    store, meta,
    writesTo: (key) => puts.get(key) ?? 0,
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value, opts) {
      puts.set(key, (puts.get(key) ?? 0) + 1);
      store.set(key, value);
      if (opts?.metadata !== undefined) meta.set(key, JSON.parse(JSON.stringify(opts.metadata)));
      else meta.delete(key);
    },
    async delete(key) {
      store.delete(key);
      meta.delete(key);
    },
    async list({ prefix = "", cursor } = {}) {
      const names = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const keys = names.slice(start, start + 1000).map((name) => (meta.has(name) ? { name, metadata: meta.get(name) } : { name }));
      return start + 1000 < names.length ? { keys, list_complete: false, cursor: String(start + 1000) } : { keys, list_complete: true };
    },
  };
}

const { privateKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const sent = [];
const sites = new Map();
const fetched = [];
globalThis.fetch = async (url, init) => {
  const href = String(url);
  if (sites.has(href)) {
    fetched.push(href);
    const reply = sites.get(href);
    return new Response(reply.body ?? "ok", { status: reply.status ?? 200, headers: { "content-type": "text/html" } });
  }
  if (!href.includes("push.apple.com")) throw new Error(`不该去抓这个网址：${href}`);
  sent.push({ headers: init.headers, payload: JSON.parse(init.body) });
  return new Response("", { status: 200 });
};
const titleOf = (s) => s?.payload?.aps?.alert?.title ?? "";
const bodyOf = (s) => s?.payload?.aps?.alert?.body ?? "";

function makeEnv() {
  const kv = memoryKV();
  kv.store.set("acct:owner0001", JSON.stringify({
    id: "owner0001", secretHash: "x", channelIds: ["chan0001"], createdAt: T0, updatedAt: T0,
    devices: [{ token: "a".repeat(64), env: "sandbox", name: "测试机", addedAt: T0 }],
  }));
  kv.store.set("chan:chan0001", JSON.stringify({
    id: "chan0001", key: "key000000001", name: "运维", ownerId: "owner0001", memberIds: [], createdAt: T0, count: 0,
  }));
  kv.store.set("config:watches_indexed", "{}");
  return {
    kv,
    env: { PIGEON_KV: kv, APNS_KEY_P8: privateKey, APNS_KEY_ID: "ABC1234DEF", APNS_TEAM_ID: "TEAM567890", APNS_TOPIC: "im.nfo.pigeon" },
  };
}

/** 按路由的做法落地一次编辑：配置、需要时的状态 */
async function patch(env, id, body, now) {
  const current = await getWatch(env, id);
  const e = applyWatchEdit(current, body, now);
  if (typeof e === "string") throw new Error(e);
  if (!e.changed) return current;
  await putWatchConfig(env, e.watch);
  if (e.stateChanged) await writeWatchState(env, e.watch, nextDueAt(e.watch), now);
  if (e.cancelIn) await cancelWatchRepeats(env, current, e.cancelIn);
  return e.watch;
}

const site = (env, url, extra = {}) =>
  createWatch(env, "owner0001", parseWatchInput({ kind: "up", channelId: "chan0001", url, intervalMinutes: 15, name: "主站", ...extra }));
const heartbeat = (env, extra = {}) =>
  createWatch(env, "owner0001", parseWatchInput({ kind: "heartbeat", channelId: "chan0001", intervalMinutes: 60, name: "备份", ...extra }));

console.log("\n★ 网址监控的历史跟状态同一次写入，metadata 里没有它");
{
  const { env, kv } = makeEnv();
  sites.set("https://h.test/", { status: 200 });
  const w = await site(env, "https://h.test/");
  const before = await watchDetails(await getWatch(env, w.id), T0);
  check("刚建：可用率都是 null，没有响应时间", before.uptime_24h === null && before.uptime_30d === null && !("last_response_ms" in before) && before.ref === w.id);
  await runScheduled(env, T0);
  await runScheduled(env, T0 + 15 * MIN);
  check("★ 每检查一次，状态键只写一次", kv.writesTo(`wstate:${w.id}`) === 2);
  check("没有另开一把历史的键", ![...kv.store.keys()].some((k) => k.startsWith("whist:")));
  const meta = kv.meta.get(`wstate:${w.id}`);
  check("★ metadata 里没有历史，远在 1KB 以内", meta && !("history" in meta) && JSON.stringify(meta).length < 400, JSON.stringify(meta));
  const stored = await readWatchState(env, "up", w.id);
  check("值里有历史：两次检查、一次变化（第一次在线）", stored.history.checks.length === 2 && stored.history.changes.length === 1 && stored.history.changes[0].status === "up");
  const details = await watchDetails(await getWatch(env, w.id), T0 + 15 * MIN);
  check("★ 视图带上可用率和响应时间", details.uptime_24h === 100 && details.uptime_7d === 100 && typeof details.last_response_ms === "number", JSON.stringify(details));
}

console.log("\n★ 老监控没有历史：照常工作，第一次检查起开始记");
{
  const { env, kv } = makeEnv();
  sites.set("https://old.test/", { status: 200 });
  const t = T0 - 86_400_000;
  kv.store.set("watch:legacyold001", JSON.stringify({ id: "legacyold001", ownerId: "owner0001", channelId: "chan0001", kind: "up", url: "https://old.test/", intervalMinutes: 15, name: "老站", createdAt: t }));
  kv.store.set("wown:owner0001:legacyold001", "1");
  kv.meta.set("wown:owner0001:legacyold001", { channelId: "chan0001", kind: "up", at: t });
  const oldState = { lastStatus: "up", lastCheckedAt: T0 - 20 * MIN, kind: "up", nextDueAt: T0 - 5 * MIN, at: T0 - 20 * MIN };
  kv.store.set("wstate:legacyold001", JSON.stringify(oldState));
  kv.meta.set("wstate:legacyold001", oldState);
  const d = await watchDetails(await getWatch(env, "legacyold001"), T0);
  check("还没有历史：可用率 null，不报错", d.uptime_24h === null && d.ref === "legacyold001");
  const round = await runScheduled(env, T0);
  const w = await getWatch(env, "legacyold001");
  check("★ 第一次检查：照常，历史从这一次开始", round.checked === 1 && w.history?.checks.length === 1 && w.history.changes.length === 0 && w.lastStatus === "up");
  const legacyHb = { id: "legacyhb0001", ownerId: "owner0001", channelId: "chan0001", kind: "heartbeat", intervalMinutes: 60, graceMinutes: 6, name: "老心跳", createdAt: t, lastStatus: "up", lastPingAt: T0 - 5 * MIN };
  kv.store.set("watch:legacyhb0001", JSON.stringify(legacyHb));
  const r = await recordHeartbeat(env, "legacyhb0001", { failed: true, message: "老心跳报失败" }, T0);
  check("★ 改版之前的老心跳（状态还在配置里）照常报失败，历史从这一次开始", r.ok && sent.at(-1) && bodyOf(sent.at(-1)) === "老心跳报失败" && (await getWatch(env, "legacyhb0001")).history?.changes[0]?.detail === "报告失败");
}

console.log("\n★ 维护窗口：窗口里掉线不推，结束时还没好才补推");
{
  const { env, kv } = makeEnv();
  sent.length = 0;
  sites.set("https://m.test/", { status: 200 });
  const w = await site(env, "https://m.test/");
  await runScheduled(env, T0 - 60 * MIN); // 01:00，窗口外，在线
  await patch(env, w.id, { maintenance: MON_NIGHT }, T0 - 59 * MIN);
  sites.set("https://m.test/", { status: 500 });
  await runScheduled(env, T0 - 30 * MIN); // 01:30，窗口开始，第一次失败
  let round = await runScheduled(env, T0 - 25 * MIN);
  let state = await getWatch(env, w.id);
  check("★ 窗口里确认掉线：不推，记成 down，记住之前是 up", sent.length === 0 && round.quieted === 1 && state.lastStatus === "down" && state.quiet?.from === "up" && state.quiet?.until === T0 + 60 * MIN, JSON.stringify({ round, q: state.quiet }));
  check("历史里这次变化标着「维护期间」，异常不计入可用率", state.history.changes.at(-1).quiet === 1 && state.history.cur === -1);
  for (let t = T0 - 10 * MIN; t < T0 + 60 * MIN; t += 15 * MIN) await runScheduled(env, t);
  check("窗口里一直挂着：一条都不推", sent.length === 0);
  check("★ 窗口结束那一刻排了一次检查（不等下一个间隔）", kv.meta.get(`wstate:${w.id}`)?.nextDueAt === T0 + 60 * MIN, String(kv.meta.get(`wstate:${w.id}`)?.nextDueAt - T0));
  round = await runScheduled(env, T0 + 60 * MIN);
  check("★ 窗口结束还挂着：补推「掉线了」，写明窗口内就已掉线", round.alerted === 1 && titleOf(sent[0]).includes("掉线了") && bodyOf(sent[0]).includes("维护窗口内掉线"), bodyOf(sent[0]));
  check("告警带 watch_id（网址监控就是监控 id）", sent[0].payload.watch_id === w.id);
  state = await getWatch(env, w.id);
  check("补推之后压着的了结", state.quiet === undefined && state.lastStatus === "down");
  sites.set("https://m.test/", { status: 200 });
  await runScheduled(env, T0 + 75 * MIN);
  check("之后恢复照常推（普通级别）", titleOf(sent[1]).includes("恢复了") && sent[1].payload.aps["interruption-level"] === "active");
}
{
  const { env } = makeEnv();
  sent.length = 0;
  sites.set("https://m2.test/", { status: 200 });
  const w = await site(env, "https://m2.test/", { maintenance: undefined });
  await runScheduled(env, T0 - 60 * MIN);
  await patch(env, w.id, { maintenance: MON_NIGHT }, T0 - 59 * MIN);
  sites.set("https://m2.test/", { status: 500 });
  await runScheduled(env, T0 - 30 * MIN);
  await runScheduled(env, T0 - 25 * MIN);
  sites.set("https://m2.test/", { status: 200 });
  await runScheduled(env, T0 - 10 * MIN);
  await runScheduled(env, T0 + 60 * MIN);
  const state = await getWatch(env, w.id);
  check("★ 窗口里掉了又好了：从头到尾一条不推，也不补推", sent.length === 0 && state.lastStatus === "up" && state.quiet === undefined);
  check("两次变化都记在历史里", state.history.changes.slice(-2).map((c) => `${c.status}${c.quiet ?? ""}`).join(",") === "down1,up1");
}
{
  const { env } = makeEnv();
  sent.length = 0;
  sites.set("https://m3.test/", { status: 500 });
  const w = await site(env, "https://m3.test/", { maintenance: undefined });
  await runScheduled(env, T0 - 60 * MIN);
  await runScheduled(env, T0 - 55 * MIN); // 01:05，窗口外确认掉线
  check("窗口外掉线：照推", sent.length === 1 && titleOf(sent[0]).includes("掉线了"));
  await patch(env, w.id, { maintenance: MON_NIGHT }, T0 - 50 * MIN);
  sites.set("https://m3.test/", { status: 200 });
  await runScheduled(env, T0 - 30 * MIN); // 01:30，窗口里恢复
  check("★ 之前告过警的在窗口里恢复：推「恢复了」，但静默送达", sent.length === 2 && titleOf(sent[1]).includes("恢复了") && sent[1].payload.aps["interruption-level"] === "passive");
  check("恢复和掉线是同一个事件 id，App 能算出持续多久", sent[1].payload.id === sent[0].payload.id && sent[1].payload.status === "resolved");
}

console.log("\n★ 暂停：网址不抓，恢复后接着查");
{
  const { env, kv } = makeEnv();
  sent.length = 0;
  sites.set("https://p.test/", { status: 200 });
  const w = await site(env, "https://p.test/");
  await runScheduled(env, T0);
  await patch(env, w.id, { paused_until: 0 }, T0 + MIN);
  check("一直暂停：状态 metadata 不再排队", kv.meta.get(`wstate:${w.id}`)?.nextDueAt === Number.MAX_SAFE_INTEGER);
  fetched.length = 0;
  sites.set("https://p.test/", { status: 500 });
  for (let i = 1; i <= 10; i++) await runScheduled(env, T0 + i * HOUR);
  check("★ 暂停十小时：一次都没抓、一条都没推", fetched.length === 0 && sent.length === 0);
  const view = await watchDetails(await getWatch(env, w.id), T0 + 10 * HOUR);
  check("视图写着暂停到 0（一直）", view.paused_until === 0);
  await patch(env, w.id, { paused_until: null }, T0 + 10 * HOUR + MIN);
  check("恢复：马上排上", kv.meta.get(`wstate:${w.id}`)?.nextDueAt === T0 + 10 * HOUR + MIN);
  await runScheduled(env, T0 + 10 * HOUR + 5 * MIN);
  check("★ 恢复后的下一轮就抓", fetched.length === 1);
  check("恢复后视图里没有 paused_until", !("paused_until" in (await watchDetails(await getWatch(env, w.id), T0 + 11 * HOUR))));

  // 暂停时状态没写进去（metadata 还按暂停之前排）：cron 来了也不抓，按暂停重排一次
  const w2 = await site(env, "https://p.test/");
  await runScheduled(env, T0);
  const cfg = JSON.parse(kv.store.get(`watch:${w2.id}`));
  kv.store.set(`watch:${w2.id}`, JSON.stringify({ ...cfg, pausedUntil: T0 + 5 * HOUR }));
  fetched.length = 0;
  await runScheduled(env, T0 + HOUR);
  check("★ 列表还按旧的排：不抓，按暂停重排到暂停结束", fetched.length === 0 && kv.meta.get(`wstate:${w2.id}`)?.nextDueAt === T0 + 5 * HOUR);
}

console.log("\n★ 心跳暂停：不判失联；恢复后给一整个间隔");
{
  const { env } = makeEnv();
  sent.length = 0;
  const hb = await heartbeat(env);
  await recordHeartbeat(env, hb.id, { failed: false }, T0);
  await patch(env, hb.id, { paused_until: T0 + 3 * HOUR }, T0 + MIN);
  let round = await runScheduled(env, T0 + 2 * HOUR);
  check("暂停期间过了「间隔 + 宽限」：不推", round.alerted === 0 && sent.length === 0);
  round = await runScheduled(env, T0 + 3 * HOUR + 60 * MIN);
  check("★ 暂停结束后一整个「间隔 + 宽限」之内：还不推", round.alerted === 0 && sent.length === 0);
  round = await runScheduled(env, T0 + 3 * HOUR + 67 * MIN);
  check("过了才推「没有按时上报」", round.alerted === 1 && titleOf(sent[0]).includes("没有按时上报"));
  check("★ 心跳告警的 watch_id 不是心跳 id（id 是报到凭据）", sent[0].payload.watch_id === (await heartbeatMessageId(hb.id)) && !JSON.stringify(sent[0].payload).includes(hb.id));
  check("视图的 ref 和告警里的 watch_id 对得上", (await watchDetails(await getWatch(env, hb.id), T0)).ref === sent[0].payload.watch_id && (await watchRef(hb)) === sent[0].payload.watch_id);
}
{
  const { env } = makeEnv();
  sent.length = 0;
  const hb = await heartbeat(env);
  await recordHeartbeat(env, hb.id, { failed: false }, T0);
  await patch(env, hb.id, { paused_until: 0 }, T0 + MIN);
  const r = await recordHeartbeat(env, hb.id, { failed: true, code: 3 }, T0 + 10 * MIN);
  let state = await getWatch(env, hb.id);
  check("★ 暂停期间报失败：记成 down，不推，记住之前是 up", r.ok && sent.length === 0 && state.lastStatus === "down" && state.quiet?.from === "up" && state.quiet?.why === "pause");
  await recordHeartbeat(env, hb.id, { failed: false }, T0 + 5 * HOUR);
  state = await getWatch(env, hb.id);
  check("暂停期间报到：照记，好了就了结压着的", sent.length === 0 && state.lastStatus === "up" && state.quiet === undefined && state.lastPingAt === T0 + 5 * HOUR);
  await recordHeartbeat(env, hb.id, { failed: true, code: 3 }, T0 + 6 * HOUR);
  await patch(env, hb.id, { paused_until: null }, T0 + 7 * HOUR);
  state = await getWatch(env, hb.id);
  check("恢复时还压着失败：下一轮马上补判", state.quiet?.until === T0 + 7 * HOUR);
  const round = await runScheduled(env, T0 + 7 * HOUR + 5 * MIN);
  check("★ 恢复后还是失败的：补推「仍未恢复」，写明暂停期间退出码 3", round.alerted === 1 && titleOf(sent[0]).includes("仍未恢复") && bodyOf(sent[0]).includes("暂停期间退出码 3"), bodyOf(sent[0]));
  check("补推之后不再重复", (await runScheduled(env, T0 + 8 * HOUR)).alerted === 0 && (await getWatch(env, hb.id)).quiet === undefined);
}

console.log("\n★ 心跳维护窗口：窗口里失联不推，结束时还没来才补推");
{
  const { env } = makeEnv();
  sent.length = 0;
  const hb = await heartbeat(env, { maintenance: undefined });
  await recordHeartbeat(env, hb.id, { failed: false }, T0 - 70 * MIN); // 00:50 报到，01:56 算失联
  await patch(env, hb.id, { maintenance: MON_NIGHT }, T0 - 69 * MIN);
  let round = await runScheduled(env, T0);
  let state = await getWatch(env, hb.id);
  check("★ 窗口里过了点：不推，记成 down，排到窗口结束再看", round.quieted === 1 && sent.length === 0 && state.lastStatus === "down" && nextDueAt(state) === T0 + 60 * MIN - 1);
  round = await runScheduled(env, T0 + 60 * MIN);
  check("★ 窗口结束还没来：补推「仍未恢复」，写明窗口内没有按时上报", round.alerted === 1 && bodyOf(sent[0]).includes("维护窗口内没有按时上报"), bodyOf(sent[0]));
  await recordHeartbeat(env, hb.id, { failed: false }, T0 + 70 * MIN);
  check("之后回来报到：照常推「恢复上报」", titleOf(sent[1]).includes("恢复上报") && sent[1].payload.aps["interruption-level"] === "active");
}
{
  const { env } = makeEnv();
  sent.length = 0;
  const hb = await heartbeat(env, { maintenance: undefined });
  await recordHeartbeat(env, hb.id, { failed: false }, T0 - 70 * MIN);
  await patch(env, hb.id, { maintenance: MON_NIGHT }, T0 - 69 * MIN);
  await runScheduled(env, T0);
  await recordHeartbeat(env, hb.id, { failed: false }, T0 + 30 * MIN); // 窗口里晚到了
  const round = await runScheduled(env, T0 + 60 * MIN);
  check("★ 窗口里晚到了、窗口里回来了：从头到尾一条不推", sent.length === 0 && round.alerted === 0 && (await getWatch(env, hb.id)).quiet === undefined);
}

{
  const { env } = makeEnv();
  sent.length = 0;
  const hb = await heartbeat(env, { maintenance: undefined });
  await recordHeartbeat(env, hb.id, { failed: false }, T0 - 3 * HOUR);
  await recordHeartbeat(env, hb.id, { failed: true, message: "窗口前就挂了" }, T0 - 2 * HOUR);
  check("窗口之前报失败：照推", sent.length === 1);
  await patch(env, hb.id, { maintenance: MON_NIGHT }, T0 - 2 * HOUR + MIN);
  await recordHeartbeat(env, hb.id, { failed: true, message: "窗口里又挂了一次" }, T0);
  check("窗口里又报失败：不推", sent.length === 1 && (await getWatch(env, hb.id)).quiet === undefined);
  await recordHeartbeat(env, hb.id, { failed: false }, T0 + 10 * MIN);
  check("★ 窗口里恢复：「恢复上报」静默送达，那件事在 App 里了结", sent.length === 2 && titleOf(sent[1]).includes("恢复上报") && sent[1].payload.aps["interruption-level"] === "passive" && sent[1].payload.id === sent[0].payload.id);
}

console.log("\n★ 心跳：/start 计时，退出码");
{
  const { env, kv } = makeEnv();
  sent.length = 0;
  const hb = await heartbeat(env);
  let r = await recordHeartbeatStart(env, hb.id, T0);
  check("开始：记下时刻，不推、状态不变", r.ok && r.watch.startedAt === T0 && r.watch.lastStatus === "new" && sent.length === 0);
  check("视图里写着正在跑", (await watchDetails(await getWatch(env, hb.id), T0 + MIN)).running_since === T0);
  r = await recordHeartbeat(env, hb.id, { failed: false }, T0 + 200_000);
  check("★ 报到时算出用时", r.ok && r.runMs === 200_000);
  let w = await getWatch(env, hb.id);
  check("用时记进历史，视图带 last_duration_ms，不再「正在跑」", w.history.checks.at(-1)[1] === 200_000 && (await watchDetails(w, T0 + 4 * MIN)).last_duration_ms === 200_000 && !("running_since" in (await watchDetails(w, T0 + 4 * MIN))));
  check("用时算过一次就了结：再报到不重复算", runDuration(w, T0 + 10 * MIN) === undefined);

  const writes = kv.writesTo(`hbstate:${hb.id}`);
  await recordHeartbeatStart(env, hb.id, T0 + 5 * MIN);
  await recordHeartbeatStart(env, hb.id, T0 + 6 * MIN);
  check("★ 离上次记下的开始不到 4 分钟：这次开始不记（比约定还勤的任务）", kv.writesTo(`hbstate:${hb.id}`) === writes + 1 && (await getWatch(env, hb.id)).startedAt === T0 + 5 * MIN);
  r = await recordHeartbeat(env, hb.id, { failed: true, code: 2 }, T0 + 5 * MIN + 95_000);
  const fail = sent.at(-1);
  check("★ 退出码非 0：推「报告失败」，正文写退出码和用时", titleOf(fail).includes("报告失败") && bodyOf(fail) === "退出码 2\n这次用时 1 分 35 秒。", bodyOf(fail));
  check("历史里这次变化写「退出码 2」（不存任务附的说明）", (await getWatch(env, hb.id)).history.changes.at(-1).detail === "退出码 2");
  await recordHeartbeat(env, hb.id, { failed: true, code: 1, message: "磁盘满了" }, T0 + 20 * MIN);
  check("退出码带说明：「退出码 1：磁盘满了」", bodyOf(sent.at(-1)) === "退出码 1：磁盘满了");
  check("开始没对上报到（记下的开始早于上一次报到）：不算用时", runDuration({ startedAt: T0, lastPingAt: T0 + 1 }, T0 + 5) === undefined);
  check("开始了一周以上才报到：不算", runDuration({ startedAt: T0 }, T0 + 8 * 24 * HOUR) === undefined);
  check("用时的说法", formatDuration(400) === "不到 1 秒" && formatDuration(42_000) === "42 秒" && formatDuration(95_000) === "1 分 35 秒" && formatDuration(120_000) === "2 分钟" && formatDuration(3 * HOUR) === "3 小时");
}
{
  const { env } = makeEnv();
  const kv = env.PIGEON_KV;
  const chan = JSON.parse(kv.store.get("chan:chan0001"));
  kv.store.set("chan:chan0001", JSON.stringify({ ...chan, policy: { e2eOnly: true } }));
  sent.length = 0;
  const hb = await heartbeat(env);
  await recordHeartbeat(env, hb.id, { failed: true, code: 4, message: "机密" }, T0);
  check("只收加密的通道：退出码照写，附的说明不转发", bodyOf(sent.at(-1)) === "退出码 4：说明未转发（通道只收加密）" && !JSON.stringify(sent.at(-1).payload).includes("机密"));
}

console.log("\n★ 立即检测：和 cron 同一份状态，同一次掉线只推一次");
{
  const { env } = makeEnv();
  sent.length = 0;
  sites.set("https://c.test/", { status: 200 });
  const w = await site(env, "https://c.test/");
  await runScheduled(env, T0);
  sites.set("https://c.test/", { status: 503 });
  const channel = JSON.parse(env.PIGEON_KV.store.get("chan:chan0001"));
  let r = await checkWatchNow(env, await getWatch(env, w.id), channel, T0 + 2 * MIN);
  check("第一次查到失败：回结果，还不推（连续两次才算掉线）", !r.deleted && r.probe.status === "down" && r.probe.detail === "HTTP 503" && typeof r.probe.ms === "number" && !r.alerted && sent.length === 0);
  r = await checkWatchNow(env, await getWatch(env, w.id), channel, T0 + 3 * MIN);
  check("★ 再查一次：确认掉线，推一条", r.alerted && sent.length === 1 && titleOf(sent[0]).includes("掉线了"));
  await runScheduled(env, T0 + 20 * MIN);
  check("★ cron 下一轮不再推同一次掉线", sent.length === 1 && (await getWatch(env, w.id)).lastStatus === "down");
  const h = (await getWatch(env, w.id)).history;
  check("手动检查也记进历史", h.checks.length === 4 && h.changes.at(-1).status === "down");
  const paused = await patch(env, w.id, { paused_until: 0 }, T0 + 21 * MIN);
  sites.set("https://c.test/", { status: 200 });
  r = await checkWatchNow(env, paused, channel, T0 + 30 * MIN);
  check("★ 暂停中也能手动查：结果照记，之前告过警的恢复静默送达", !r.deleted && r.watch.lastStatus === "up" && sent.length === 2 && sent[1].payload.aps["interruption-level"] === "passive");
}

console.log("\n★ 暂停时停掉排着的「直到有人处理」");
{
  const { env, kv } = makeEnv();
  sent.length = 0;
  const hb = await heartbeat(env, { level: "timeSensitive", repeat: 5 });
  await recordHeartbeat(env, hb.id, { failed: true, message: "挂了" }, Date.now());
  const key = `repeat:chan0001:${await heartbeatMessageId(hb.id)}`;
  check("告警排上了重复提醒", kv.store.has(key));
  check("★ 重复提醒存着的参数里也有 watch_id（补发的那几次同样点得开详情）", JSON.parse(kv.store.get(key)).params.watchId === (await heartbeatMessageId(hb.id)));
  check("第一次推出去的 payload 带 watch_id", sent.at(-1)?.payload.watch_id === (await heartbeatMessageId(hb.id)));
  await patch(env, hb.id, { paused_until: 0 }, Date.now());
  check("★ 暂停之后提醒撤掉", !kv.store.has(key));
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
