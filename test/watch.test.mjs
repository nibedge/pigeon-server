/**
 * 网站监控与心跳的解析与判定。失败方式都是静默的 —— 状态判错就是「该响没响」或「不停乱响」。
 *
 * 心跳那几段跑在内存 KV 上，APNs 用假的 fetch 截下来看：cron 和报到接口之间的状态转换，
 * 只有真的推出去了什么、KV 里真的写了什么，才说得清对不对。
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  alertParams,
  alertSettled,
  E2E_FAIL_BODY,
  FETCH_CONCURRENCY,
  FETCH_TIMEOUT_MS,
  heartbeatMessageId,
  MAX_ALERT_ATTEMPTS,
  PAUSE_AFTER_TIMEOUTS,
  PAUSED_CHECK_MS,
  REMINDER_CRON,
  runCron,
  siteStep,
  sweepReminders,
  sweepWatches,
  SWEEP_ERROR_ALERT,
  WATCH_CRON,
  createWatch,
  defaultGraceMinutes,
  deleteWatch,
  formatMinutes,
  getWatch,
  heartbeatDeadline,
  heartbeatOverdue,
  heartbeatStep,
  listWatches,
  MAX_SITE_INTERVAL_MINUTES,
  parseWatchInput,
  PING_PERSIST_MS,
  recordHeartbeat,
  runScheduled,
  siteDueAt,
} from "../.test-build/watch.mjs";

/** 服务端记的日志（出错、放弃重推）截在这里，不刷屏；测试也要核对该记的记了 */
const logged = [];
console.error = (...args) => logged.push(args.map(String).join(" "));
console.warn = console.error;

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? `  → ${detail}` : ""}`); }
}

console.log("\n监控输入校验");
{
  const ok = parseWatchInput({ kind: "up", url: "https://nfo.im", channelId: "abcdef" });
  check("掉线监控正常解析", typeof ok === "object" && ok.kind === "up" && ok.name === "nfo.im");
  check("kind 不对 → 报错", typeof parseWatchInput({ kind: "x", url: "https://a.com", channelId: "abcdef" }) === "string");
  check("网址不合法 → 报错", typeof parseWatchInput({ kind: "up", url: "不是网址", channelId: "abcdef" }) === "string");
  check("非 http(s) → 报错", typeof parseWatchInput({ kind: "up", url: "ftp://a.com", channelId: "abcdef" }) === "string");
  check("channelId 格式不对 → 报错", typeof parseWatchInput({ kind: "up", url: "https://a.com", channelId: "!!" }) === "string");
  check("关键词监控缺 keyword → 报错", typeof parseWatchInput({ kind: "keyword", url: "https://a.com", channelId: "abcdef" }) === "string");

  const kw = parseWatchInput({ kind: "keyword", url: "https://a.com", channelId: "abcdef", keyword: "有票" });
  check("关键词监控解析，默认出现时提醒", typeof kw === "object" && kw.keyword === "有票" && kw.present === true);
  const gone = parseWatchInput({ kind: "keyword", url: "https://a.com", channelId: "abcdef", keyword: "售罄", present: false });
  check("可设成消失时提醒", typeof gone === "object" && gone.present === false);

  const fast = parseWatchInput({ kind: "up", url: "https://a.com", channelId: "abcdef", intervalMinutes: 1 });
  check("频率下限夹到 5 分钟", typeof fast === "object" && fast.intervalMinutes === 5);
  const rare = parseWatchInput({ kind: "up", url: "https://a.com", channelId: "abcdef", intervalMinutes: 99999 });
  check("★ 频率上限夹到 1 天", typeof rare === "object" && rare.intervalMinutes === 1440 && MAX_SITE_INTERVAL_MINUTES === 1440);
  const legacyRare = { kind: "up", url: "https://a.com", intervalMinutes: 500000, lastCheckedAt: 1000 };
  check("★ 老数据里没夹过的间隔，按 1 天算到期", siteDueAt(legacyRare) === 1000 + 1440 * 60_000);
  check("还没检查过的，现在就到期", siteDueAt({ kind: "up", intervalMinutes: 15 }) === 15 * 60_000);
  const named = parseWatchInput({ kind: "up", url: "https://a.com/x", channelId: "abcdef", name: "我的站" });
  check("自定义名字保留", typeof named === "object" && named.name === "我的站");
}

console.log("\n心跳：输入校验与缺省值");
{
  const hb = (extra) => parseWatchInput({ kind: "heartbeat", channelId: "abcdef", ...extra });
  const plain = hb({ intervalMinutes: 60 });
  check("不要网址也能建", typeof plain === "object" && plain.kind === "heartbeat" && plain.url === undefined, JSON.stringify(plain));
  check("给了网址也不存", hb({ intervalMinutes: 60, url: "https://a.com" }).url === undefined);
  check("名字缺省为「心跳」", plain.name === "心跳");
  check("自定义名字保留", hb({ intervalMinutes: 60, name: "夜间备份" }).name === "夜间备份");
  check("★ 新建的状态是 new：还没报到过", plain.lastStatus === "new");
  check("★ 没给间隔 → 报错（缺省值猜错就是误报）", typeof hb({}) === "string");
  check("间隔不是正数 → 报错", typeof hb({ intervalMinutes: 0 }) === "string" && typeof hb({ intervalMinutes: -5 }) === "string");
  check("间隔乱写 → 报错", typeof hb({ intervalMinutes: "每天" }) === "string");
  check("字符串形式的数字也认", hb({ intervalMinutes: "30" }).intervalMinutes === 30);
  check("间隔下限夹到 5 分钟", hb({ intervalMinutes: 1 }).intervalMinutes === 5);
  check("间隔上限夹到 7 天", hb({ intervalMinutes: 99999 }).intervalMinutes === 10080);
  check("channelId 格式不对 → 报错", typeof parseWatchInput({ kind: "heartbeat", channelId: "!!", intervalMinutes: 60 }) === "string");

  check("宽限缺省为间隔的一成：60 分钟 → 6", plain.graceMinutes === 6);
  check("宽限缺省至少 5 分钟：间隔 5 → 5", hb({ intervalMinutes: 5 }).graceMinutes === 5);
  check("每天一次 → 宽限 144 分钟", defaultGraceMinutes(1440) === 144);
  check("每周一次 → 宽限 1008 分钟", hb({ intervalMinutes: 10080 }).graceMinutes === 1008);
  check("自己给的宽限照用", hb({ intervalMinutes: 60, graceMinutes: 30 }).graceMinutes === 30);
  check("宽限下限夹到 5", hb({ intervalMinutes: 60, graceMinutes: 1 }).graceMinutes === 5 && hb({ intervalMinutes: 60, graceMinutes: 0 }).graceMinutes === 5);
  check("宽限上限夹到 1 天", hb({ intervalMinutes: 60, graceMinutes: 5000 }).graceMinutes === 1440);
  check("宽限乱写 → 用缺省", hb({ intervalMinutes: 60, graceMinutes: "abc" }).graceMinutes === 6);
}

console.log("\n时长的说法");
check("5 → 5 分钟", formatMinutes(5) === "5 分钟");
check("60 → 1 小时", formatMinutes(60) === "1 小时");
check("90 → 1 小时 30 分钟", formatMinutes(90) === "1 小时 30 分钟");
check("1440 → 1 天", formatMinutes(1440) === "1 天");
check("1500 → 1 天 1 小时（过了一天不再细到分钟）", formatMinutes(1500) === "1 天 1 小时");
check("10080 → 7 天", formatMinutes(10080) === "7 天");
check("零头舍掉", formatMinutes(7.9) === "7 分钟");

const T = 1_800_000_000_000;
const MIN = 60_000;
const base = { id: "hb0001", kind: "heartbeat", channelId: "chan0001", ownerId: "owner0001", intervalMinutes: 5, graceMinutes: 5, name: "n", lastStatus: "new", createdAt: T };

console.log("\n★ 报到后的状态转换");
{
  const first = heartbeatStep(base, { failed: false }, T);
  check("new → up，不推（第一次报到不是「恢复」）", first.watch.lastStatus === "up" && first.event === null && first.persist);
  check("记下报到时刻", first.watch.lastPingAt === T);
  const failed = heartbeatStep(first.watch, { failed: true }, T + MIN);
  check("报失败：up → down，推「失败」，要写", failed.watch.lastStatus === "down" && failed.event === "failed" && failed.persist);
  const back = heartbeatStep(failed.watch, { failed: false }, T + 2 * MIN);
  check("★ 失败之后第一次正常报到：推「恢复」", back.event === "recovered" && back.watch.lastStatus === "up" && back.persist);
  const again = heartbeatStep(failed.watch, { failed: true }, T + 2 * MIN);
  check("已经是 down 又报失败：照样推（每次失败都是一件事）", again.event === "failed");
  check("new 直接报失败也推", heartbeatStep(base, { failed: true }, T).event === "failed");
}

console.log("\n★ 报到写回的节流");
{
  const up = { ...base, lastStatus: "up", lastPingAt: T };
  check("★ up 状态下 1 分钟后再报到：不写 KV", !heartbeatStep(up, { failed: false }, T + MIN).persist);
  check("离上次记下的满 4 分钟：写", heartbeatStep(up, { failed: false }, T + PING_PERSIST_MS).persist);
  check("状态变了，隔多近都写", heartbeatStep({ ...up, lastStatus: "down" }, { failed: false }, T + 1).persist);

  // 比约定报得勤的任务：每分钟一次（时刻还不整齐），cron 每 5 分钟整点看一眼
  let stored = up;
  let writes = 0;
  let falseAlarm = false;
  for (let m = 1; m <= 240; m++) {
    const now = T + m * MIN + 17_000;
    const step = heartbeatStep(stored, { failed: false }, now);
    if (step.persist) {
      stored = step.watch;
      writes += 1;
    }
    const cron = T + Math.ceil((now - T) / (5 * MIN)) * 5 * MIN;
    if (heartbeatOverdue(stored, cron)) falseAlarm = true;
  }
  check("★ 每分钟报到一次：四小时只写 60 次，而且从不误报", !falseAlarm && writes === 60, `writes=${writes} falseAlarm=${falseAlarm}`);

  // 按约定每 5 分钟报一次：每次都离上次超过 4 分钟，一次也不省
  stored = up;
  writes = 0;
  for (let m = 5; m <= 60; m += 5) {
    const step = heartbeatStep(stored, { failed: false }, T + m * MIN);
    if (step.persist) {
      stored = step.watch;
      writes += 1;
    }
  }
  check("按约定报到的任务每次都写", writes === 12, `writes=${writes}`);
}

console.log("\n★ 什么时候算失联");
{
  const up = { ...base, lastStatus: "up", lastPingAt: T };
  check("没过「间隔 + 宽限」不算", !heartbeatOverdue(up, T + 9 * MIN));
  check("正好到点也不算", !heartbeatOverdue(up, T + 10 * MIN));
  check("过了就算", heartbeatOverdue(up, T + 10 * MIN + 1));
  check("★ new 等多久都不算", !heartbeatOverdue(base, T + 365 * 24 * 60 * MIN));
  check("★ down 不重复算", !heartbeatOverdue({ ...up, lastStatus: "down" }, T + 24 * 60 * MIN));
  check("网址监控不归它管", !heartbeatOverdue({ ...up, kind: "up" }, T + 24 * 60 * MIN));
  check("没记宽限的按缺省算", !heartbeatOverdue({ ...up, graceMinutes: undefined }, T + 10 * MIN) && heartbeatOverdue({ ...up, graceMinutes: undefined }, T + 10 * MIN + 1));
  check("失联的那一刻（写进 metadata 给 cron 挑）", heartbeatDeadline(up) === T + 10 * MIN);
  check("new / down 不用排队：0", heartbeatDeadline(base) === 0 && heartbeatDeadline({ ...up, lastStatus: "down" }) === 0);
}

// ── 内存 KV + 假 APNs ────────────────────────────────────────────────

/**
 * 内存 KV。list 一页只给 3 个（线上是 1000），只取第一页的地方在这里立刻就漏；metadata、TTL 都记下。
 * reads 记下每一次 get 的键：cron 有没有去读没到期的监控，一看便知
 */
function memoryKV({ pageSize = 3 } = {}) {
  const store = new Map();
  const meta = new Map();
  const ttl = new Map();
  const puts = new Map();
  const reads = [];
  let ops = 0;
  return {
    store,
    meta,
    ttl,
    reads,
    /** 一共做了多少次 KV 操作（get / put / delete / list 都算）—— 线上每次调用最多 1000 次 */
    ops: () => ops,
    /** 某个键被写过几次 —— 节流省下的正是这个 */
    writesTo: (key) => puts.get(key) ?? 0,
    async get(key, type) {
      ops += 1;
      reads.push(key);
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value, opts) {
      ops += 1;
      puts.set(key, (puts.get(key) ?? 0) + 1);
      store.set(key, value);
      if (opts?.metadata !== undefined) meta.set(key, JSON.parse(JSON.stringify(opts.metadata)));
      else meta.delete(key);
      if (opts?.expirationTtl !== undefined) ttl.set(key, opts.expirationTtl);
      else ttl.delete(key);
    },
    async delete(key) {
      ops += 1;
      store.delete(key);
      meta.delete(key);
      ttl.delete(key);
    },
    async list({ prefix = "", cursor } = {}) {
      ops += 1;
      const names = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const keys = names.slice(start, start + pageSize).map((name) => (meta.has(name) ? { name, metadata: meta.get(name) } : { name }));
      const next = start + pageSize;
      return next < names.length
        ? { keys, list_complete: false, cursor: String(next), cacheStatus: null }
        : { keys, list_complete: true, cacheStatus: null };
    },
  };
}

const { privateKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

/** 截下来的 APNs 请求 */
const sent = [];
/** 放进这里的 token，APNs 回 410（用户删了 App） */
const unregistered = new Set();
/** APNs 整体出问题时回的状态码（503、429……）；null 表示正常 */
const apns = { down: null };
/**
 * 网址监控要抓的假网站：网址 → 怎么回应（可以是函数，抓取的那一刻做点什么）。
 * 回应里可以给 status、body（字符串，或者按块给的数组）、type（内容类型）、headers、
 * delay（毫秒后才回）、hang（一直不回，等抓取方自己放弃）。
 * 不在这里的网址一概不许抓 —— 心跳不抓网址，抓了就是 bug
 */
const sites = new Map();
const fetched = [];
/** 同时在抓的网址，和这一段测试里的最大值 */
const flight = { now: 0, max: 0 };
function siteResponse(reply) {
  const headers = { "content-type": reply.type ?? "text/html", ...(reply.headers ?? {}) };
  if (Array.isArray(reply.body)) {
    // 按块给的正文，一块一块从这个数组里取走：读到一半停下的话，剩下的还留在数组里，测试看得见
    const chunks = reply.body;
    const stream = new ReadableStream({
      pull(controller) {
        const next = chunks.shift();
        if (next === undefined) controller.close();
        else controller.enqueue(typeof next === "string" ? new TextEncoder().encode(next) : next);
      },
    });
    return new Response(stream, { status: reply.status ?? 200, headers });
  }
  return new Response(reply.body ?? "ok", { status: reply.status ?? 200, headers });
}
globalThis.fetch = async (url, init) => {
  const href = String(url);
  if (sites.has(href)) {
    fetched.push(href);
    flight.now += 1;
    flight.max = Math.max(flight.max, flight.now);
    try {
      const site = sites.get(href);
      const reply = typeof site === "function" ? await site() : site;
      if (reply.hang) {
        // 一直不回：只有抓取方到点放弃（abort）才结束
        await new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      }
      if (reply.delay) await new Promise((resolve) => setTimeout(resolve, reply.delay));
      return siteResponse(reply);
    } finally {
      flight.now -= 1;
    }
  }
  if (!href.includes("push.apple.com")) throw new Error(`不该去抓这个网址：${href}`);
  sent.push({ url: href, headers: init.headers, payload: JSON.parse(init.body) });
  if (apns.down) return new Response(JSON.stringify({ reason: "ServiceUnavailable" }), { status: apns.down });
  const token = href.split("/").pop();
  if (unregistered.has(token)) return new Response(JSON.stringify({ reason: "Unregistered" }), { status: 410 });
  return new Response("", { status: 200 });
};

/** recordHeartbeat 的结果 → 状态，没成就是原因（missing / suspended） */
const outcome = (o) => (o.ok ? o.watch.lastStatus : o.reason);

function makeEnv() {
  const kv = memoryKV();
  kv.store.set("acct:owner0001", JSON.stringify({
    id: "owner0001", secretHash: "x", channelIds: ["chan0001"], createdAt: T, updatedAt: T,
    devices: [{ token: "a".repeat(64), env: "sandbox", name: "测试机", addedAt: T }],
  }));
  kv.store.set("chan:chan0001", JSON.stringify({
    id: "chan0001", key: "key000000001", name: "运维", ownerId: "owner0001", memberIds: [], createdAt: T, count: 0,
  }));
  return {
    kv,
    env: { PIGEON_KV: kv, APNS_KEY_P8: privateKey, APNS_KEY_ID: "ABC1234DEF", APNS_TEAM_ID: "TEAM567890", APNS_TOPIC: "im.nfo.pigeon" },
  };
}

console.log("\n★ 心跳：cron 与报到（内存 KV + 假 APNs）");
{
  const { env, kv } = makeEnv();
  sent.length = 0;
  const hb = await createWatch(env, "owner0001", parseWatchInput({ kind: "heartbeat", channelId: "chan0001", intervalMinutes: 60, name: "夜间备份" }));
  const t0 = Date.now();

  let round = await runScheduled(env, t0 + 30 * 24 * 60 * MIN);
  check("★ 还没报到过（new）：过一个月也不提醒", round.alerted === 0 && sent.length === 0);

  let w = await recordHeartbeat(env, hb.id, { failed: false }, t0);
  check("第一次报到 → up，不推", outcome(w) === "up" && sent.length === 0);
  check("报到时刻写回了 KV", (await getWatch(env, hb.id))?.lastPingAt === t0);
  check("★ 写的是状态键，metadata 里记着何时算失联", kv.meta.get(`hbstate:${hb.id}`)?.nextDueAt === t0 + 66 * MIN);

  round = await runScheduled(env, t0 + 66 * MIN);
  check("到「间隔 + 宽限」（60 + 6 分钟）为止不提醒", round.alerted === 0 && sent.length === 0);

  round = await runScheduled(env, t0 + 70 * MIN);
  const down = sent[0]?.payload ?? { aps: { alert: {} } };
  check("★ 过了点还没来 → 推一条", round.alerted === 1 && sent.length === 1);
  check("标题点名是哪个任务没来", down.aps.alert.title?.includes("「夜间备份」没有按时上报"), down.aps.alert.title);
  check("正文说清上次什么时候、约定多久一次", down.aps.alert.body === "上次上报在 1 小时 10 分钟前，预期每 1 小时一次。", down.aps.alert.body);
  check("时效性 + firing", down.aps["interruption-level"] === "time-sensitive" && down.status === "firing");
  check("状态记成 down", (await getWatch(env, hb.id))?.lastStatus === "down");

  round = await runScheduled(env, t0 + 200 * MIN);
  check("★ 已经是 down：不重复提醒", round.alerted === 0 && sent.length === 1);

  w = await recordHeartbeat(env, hb.id, { failed: false }, t0 + 201 * MIN);
  const back = sent[1]?.payload ?? { aps: { alert: {} } };
  check("★ 又来报到 → 推「恢复上报」，状态回到 up", sent.length === 2 && outcome(w) === "up" && back.aps.alert.title?.includes("恢复上报"));
  check("恢复是 resolved + active", back.status === "resolved" && back.aps["interruption-level"] === "active");
  check("★ 失联和恢复用同一个消息 id（App 据此算持续多久）", back.id === down.id && /^hb-/.test(back.id ?? ""), `${down.id} / ${back.id}`);
  check("消息 id 就是 collapse-id：恢复原地替换失联那条", sent[1]?.headers["apns-collapse-id"] === back.id);
  check("★ 消息 id 里看不出监控 id（后者就是报到地址，成员不该拿到）", !back.id.includes(hb.id));

  w = await recordHeartbeat(env, hb.id, { failed: true, message: "磁盘满了，备份中止" }, t0 + 202 * MIN);
  const failed = sent[2]?.payload ?? { aps: { alert: {} } };
  check("★ 报告失败 → 立刻推，正文是任务附的说明", sent.length === 3 && failed.aps.alert.body === "磁盘满了，备份中止");
  check("失败的标题、级别、状态", failed.aps.alert.title?.includes("「夜间备份」报告失败") && failed.aps["interruption-level"] === "time-sensitive" && failed.status === "firing");
  check("失败也用同一个消息 id", failed.id === down.id);
  check("失败之后状态是 down", outcome(w) === "down");
  await recordHeartbeat(env, hb.id, { failed: true }, t0 + 203 * MIN);
  check("没附说明也有一句默认的", sent[3]?.payload.aps.alert.body.includes("没有附带说明"));
  await recordHeartbeat(env, hb.id, { failed: false }, t0 + 204 * MIN);
  check("★ 失败之后的第一次正常报到 → 推恢复", sent.length === 5 && sent[4]?.payload.status === "resolved");

  const key = `hbstate:${hb.id}`;
  const before = kv.writesTo(key);
  const readsBefore = kv.reads.length;
  await recordHeartbeat(env, hb.id, { failed: false }, t0 + 205 * MIN);
  await recordHeartbeat(env, hb.id, { failed: false }, t0 + 207 * MIN);
  check("★ up 状态下几分钟内连着报到：一次也不写 KV", kv.writesTo(key) === before, `${before} → ${kv.writesTo(key)}`);
  check("★ 这几次热路径每次只读两个键（配置、状态），不查通道", kv.reads.length - readsBefore === 4, kv.reads.slice(readsBefore).join(" | "));
  await recordHeartbeat(env, hb.id, { failed: false }, t0 + 208 * MIN);
  check("离上次记下的满 4 分钟才写一次", kv.writesTo(key) === before + 1);
  check("正常报到什么都不推", sent.length === 5);
  check("★ 报到、告警、恢复来回这么多次，配置只在新建时写过一次", kv.writesTo(`watch:${hb.id}`) === 1);
  check("配置里没有状态字段", JSON.parse(kv.store.get(`watch:${hb.id}`)).lastStatus === undefined);

  check("不存在的 id → missing", outcome(await recordHeartbeat(env, "nosuchwatch01", { failed: false })) === "missing");
  check("格式不对的 id → missing，不去读 KV", outcome(await recordHeartbeat(env, "../x", { failed: false })) === "missing");
  const site = await createWatch(env, "owner0001", parseWatchInput({ kind: "up", channelId: "chan0001", url: "https://nfo.im" }));
  check("★ 网址监控的 id 不能拿来报到", outcome(await recordHeartbeat(env, site.id, { failed: false })) === "missing" && (await getWatch(env, site.id))?.lastPingAt === undefined);
  await deleteWatch(env, site.id);
}

console.log("\n心跳：通道没了");
{
  const { env, kv } = makeEnv();
  sent.length = 0;
  const hb = await createWatch(env, "owner0001", parseWatchInput({ kind: "heartbeat", channelId: "chan0001", intervalMinutes: 5 }));
  const t0 = Date.now();
  await recordHeartbeat(env, hb.id, { failed: false }, t0);
  kv.store.delete("chan:chan0001");
  const round = await runScheduled(env, t0 + 11 * MIN);
  check("失联时发现通道被删了：不推，心跳顺手删掉", round.alerted === 0 && round.removed === 1 && sent.length === 0 && (await getWatch(env, hb.id)) === null);
  check("状态键、索引一起删", ![...kv.store.keys()].some((k) => k.endsWith(hb.id) && !k.startsWith("watchdel:")));

  const again = makeEnv();
  const hb2 = await createWatch(again.env, "owner0001", parseWatchInput({ kind: "heartbeat", channelId: "chan0001", intervalMinutes: 5 }));
  again.kv.store.delete("chan:chan0001");
  const lost = await recordHeartbeat(again.env, hb2.id, { failed: false }, t0);
  check("★ 报到时发现通道没了（删通道时漏下的）：回 missing，心跳删掉", outcome(lost) === "missing" && (await getWatch(again.env, hb2.id)) === null && again.kv.store.has(`watchdel:${hb2.id}`));
  check("状态没写回去", !again.kv.store.has(`hbstate:${hb2.id}`));

  const legacy = makeEnv();
  const hb3 = await createWatch(legacy.env, "owner0001", parseWatchInput({ kind: "heartbeat", channelId: "chan0001", intervalMinutes: 5 }));
  const chan = JSON.parse(legacy.kv.store.get("chan:chan0001"));
  legacy.kv.store.set("chan:chan0001", JSON.stringify({ ...chan, suspended: { at: t0 } }));
  const refused = await recordHeartbeat(legacy.env, hb3.id, { failed: true }, t0);
  check("★ 通道被停用（旧数据写法）：报失败不推，回 suspended", outcome(refused) === "suspended" && sent.length === 0);
  check("★ 心跳留着，不删", (await getWatch(legacy.env, hb3.id))?.name === "心跳");
  check("停用期间的报到不记", !legacy.kv.store.has(`hbstate:${hb3.id}`));
}

console.log("\n★ 告警推送不写通道和账号记录；APNs 报失效的 token 立墓碑、之后跳过");
{
  const { env, kv } = makeEnv();
  const good = "a".repeat(64);
  const gone = "b".repeat(64);
  const owner = JSON.parse(kv.store.get("acct:owner0001"));
  // 登记时刻要早于墓碑（T 在未来，墓碑记的是真实时刻）：墓碑之后才登记的算重新登记过，不跳过
  owner.devices.push({ token: gone, env: "sandbox", name: "删了 App 的旧手机", addedAt: 1 });
  kv.store.set("acct:owner0001", JSON.stringify(owner));
  unregistered.add(gone);
  sent.length = 0;
  const hb = await createWatch(env, "owner0001", parseWatchInput({ kind: "heartbeat", channelId: "chan0001", intervalMinutes: 5 }));
  const t0 = Date.now();
  await recordHeartbeat(env, hb.id, { failed: false }, t0);
  const chanWrites = kv.writesTo("chan:chan0001");
  const acctWrites = kv.writesTo("acct:owner0001");

  await recordHeartbeat(env, hb.id, { failed: true, message: "第一次" }, t0 + MIN);
  check("两台都推了（APNs 这时才说旧手机失效）", sent.length === 2);
  check("★ 一次告警推送：通道记录一次也没写", kv.writesTo("chan:chan0001") === chanWrites);
  check("★ 账号记录也一次没写（失效设备等本人来访再摘）", kv.writesTo("acct:owner0001") === acctWrites);
  // 条数不在这里核对：统计按实例攒着没落盘的条数，前面几段同名通道攒下的会一起带进来
  check("推送统计写进了 stat:", JSON.parse(kv.store.get("stat:chan0001") ?? "{}").count >= 1);
  const tomb = "dead:" + createHash("sha256").update(gone).digest("hex");
  check("★ 失效的 token 立了墓碑", kv.store.has(tomb));

  await recordHeartbeat(env, hb.id, { failed: true, message: "第二次" }, t0 + 2 * MIN);
  const second = sent.slice(2);
  check("★ 下一条告警跳过失效的那台，只推好的", second.length === 1 && second[0].url.endsWith(good), second.map((s) => s.url.slice(-8)).join(","));
  check("账号上的设备原样还在", JSON.parse(kv.store.get("acct:owner0001")).devices.length === 2);
  unregistered.delete(gone);
}

console.log("\n★ 停用记在 susp: 上（审核脚本现在写这里）：监控和心跳同样认");
{
  const { env, kv } = makeEnv();
  sent.length = 0;
  const hb = await createWatch(env, "owner0001", parseWatchInput({ kind: "heartbeat", channelId: "chan0001", intervalMinutes: 5 }));
  const t0 = Date.now();
  await recordHeartbeat(env, hb.id, { failed: false }, t0);
  kv.store.set("susp:chan0001", JSON.stringify({ at: t0, reason: "刷屏" }));
  const stateBefore = kv.store.get(`hbstate:${hb.id}`);
  let round = await runScheduled(env, t0 + 11 * MIN);
  check("★ 心跳失联时发现通道被停用：不推，也不删", round.alerted === 0 && round.removed === 0 && sent.length === 0 && (await getWatch(env, hb.id))?.lastStatus === "up");
  check("状态原样，下一轮还会再看", kv.store.get(`hbstate:${hb.id}`) === stateBefore);
  check("通道记录上没有停用字段（没被写回去）", JSON.parse(kv.store.get("chan:chan0001")).suspended === undefined);
  check("★ 停用期间报到：回 suspended，不推", outcome(await recordHeartbeat(env, hb.id, { failed: false }, t0 + 12 * MIN)) === "suspended" && sent.length === 0);
  check("★ 但记下任务还活着（只刷新报到时刻，状态不变）", (await getWatch(env, hb.id))?.lastPingAt === t0 + 12 * MIN && (await getWatch(env, hb.id))?.lastStatus === "up");
  const aliveState = kv.store.get(`hbstate:${hb.id}`);
  check("停用期间报失败：不推，也不记", outcome(await recordHeartbeat(env, hb.id, { failed: true }, t0 + 13 * MIN)) === "suspended" && sent.length === 0 && kv.store.get(`hbstate:${hb.id}`) === aliveState);

  kv.store.delete("susp:chan0001");
  round = await runScheduled(env, t0 + 15 * MIN);
  check("★ 恢复之后：停用期间一直在报到的任务不算失联", round.alerted === 0 && (await getWatch(env, hb.id))?.lastStatus === "up");
  round = await runScheduled(env, t0 + 25 * MIN);
  check("恢复之后真停了照常判失联：还是那个心跳、那个地址", round.alerted === 1 && (await getWatch(env, hb.id))?.lastStatus === "down");
  check("恢复之后照常报到", outcome(await recordHeartbeat(env, hb.id, { failed: false }, t0 + 26 * MIN)) === "up");

  const again = makeEnv();
  const hb2 = await createWatch(again.env, "owner0001", parseWatchInput({ kind: "heartbeat", channelId: "chan0001", intervalMinutes: 5 }));
  again.kv.store.set("susp:chan0001", JSON.stringify({ at: t0 }));
  const before = sent.length;
  check("报失败时通道已停用：不推，回 suspended", outcome(await recordHeartbeat(again.env, hb2.id, { failed: true }, t0)) === "suspended" && sent.length === before);
  check("心跳留着", (await getWatch(again.env, hb2.id)) !== null);

  const site = makeEnv();
  sites.set("https://site.test/up", { status: 200 });
  const w = await createWatch(site.env, "owner0001", parseWatchInput({ kind: "up", channelId: "chan0001", url: "https://site.test/up" }));
  site.kv.store.set("susp:chan0001", "坏掉的值");
  fetched.length = 0;
  const r = await runScheduled(site.env, t0);
  check("★ 网址监控：通道停用（值坏了也算）就不再去抓，但监控不删", r.checked === 0 && fetched.length === 0 && (await getWatch(site.env, w.id)) !== null);
  check("不写状态", !site.kv.store.has(`wstate:${w.id}`));
  site.kv.store.delete("susp:chan0001");
  const r2 = await runScheduled(site.env, t0 + 5 * MIN);
  check("★ 恢复之后接着抓", r2.checked === 1 && fetched.length === 1 && (await getWatch(site.env, w.id))?.lastStatus === "up");
}

/**
 * 模拟落在另一个机房的请求：frozen 里的键读出来还是冻结那一刻的旧值（KV 在别处最长 60 秒才可见，
 * 缓存着「没有这个键」也算），写入照常落到中心存储。
 */
function staleView(kv, keys) {
  const frozen = new Map(keys.map((k) => [k, kv.store.get(k)]));
  return {
    PIGEON_KV: {
      async get(key, type) {
        if (!frozen.has(key)) return kv.get(key, type);
        const raw = frozen.get(key);
        if (raw === undefined) return null;
        return type === "json" ? JSON.parse(raw) : raw;
      },
      put: kv.put,
      delete: kv.delete,
      list: kv.list,
    },
    APNS_KEY_P8: privateKey, APNS_KEY_ID: "ABC1234DEF", APNS_TEAM_ID: "TEAM567890", APNS_TOPIC: "im.nfo.pigeon",
  };
}

/** 除墓碑以外，这个监控在 KV 里还剩哪些键 */
const leftKeys = (kv, id) => [...kv.store.keys()].filter((k) => k.endsWith(id) && !k.startsWith("watchdel:"));

console.log("\n★ 删掉的监控不会复活：墓碑 + 报到只写状态");
{
  const { env, kv } = makeEnv();
  sent.length = 0;
  const hb = await createWatch(env, "owner0001", parseWatchInput({ kind: "heartbeat", channelId: "chan0001", intervalMinutes: 5 }));
  const t0 = Date.now();
  await recordHeartbeat(env, hb.id, { failed: false }, t0);
  const cachedKeys = [`watch:${hb.id}`, `hbstate:${hb.id}`];
  const colo = staleView(kv, cachedKeys);
  const blind = staleView(kv, [...cachedKeys, `watchdel:${hb.id}`]);

  await deleteWatch(env, hb, t0 + 10_000);
  check("删除立了墓碑，10 分钟后自动消失", kv.store.has(`watchdel:${hb.id}`) && kv.ttl.get(`watchdel:${hb.id}`) === 600);
  check("配置、状态、索引都删了", leftKeys(kv, hb.id).length === 0);

  const late = await recordHeartbeat(colo, hb.id, { failed: true, message: "晚到的失败" }, t0 + 20_000);
  check("★ 别的机房还读得到旧配置：看到墓碑就当不存在（404），不推", outcome(late) === "missing" && sent.length === 0);
  check("★ 什么都没写回去", leftKeys(kv, hb.id).length === 0);
  const quick = await recordHeartbeat(colo, hb.id, { failed: false }, t0 + 30_000);
  check("热路径（不用写的那次）什么都不写", outcome(quick) === "up" && leftKeys(kv, hb.id).length === 0);

  // 最坏的情况：那个机房连墓碑都还没看到。也只会多写一把状态键 —— 配置不会被写回去
  await recordHeartbeat(blind, hb.id, { failed: false }, t0 + 5 * MIN);
  check("★ 最坏情况也只多出一把状态键，配置没有复活", !kv.store.has(`watch:${hb.id}`) && leftKeys(kv, hb.id).join() === `hbstate:${hb.id}`);
  check("列表里看不到它，按 id 也读不到", (await listWatches(env, "owner0001")).every((w) => w.id !== hb.id) && (await getWatch(env, hb.id)) === null);
  let round = await runScheduled(env, t0 + 6 * MIN);
  check("cron 不会因为这把状态键去告警，也先不急着清（可能只是配置还没列出来）", round.alerted === 0 && kv.store.has(`hbstate:${hb.id}`));
  round = await runScheduled(env, t0 + 16 * MIN);
  check("★ 放够 10 分钟，cron 把残键清掉", round.leftovers === 1 && leftKeys(kv, hb.id).length === 0);
}

console.log("\n★ cron 抓取的这几秒里监控被删了：不推、不写回");
{
  const { env, kv } = makeEnv();
  sent.length = 0;
  const w = await createWatch(env, "owner0001", parseWatchInput({ kind: "up", channelId: "chan0001", url: "https://site.test/flaky" }));
  sites.set("https://site.test/flaky", { status: 200 });
  const t0 = Date.now();
  await runScheduled(env, t0);
  check("第一次检查：在线", (await getWatch(env, w.id))?.lastStatus === "up");
  sites.set("https://site.test/flaky", { status: 500 });
  await runScheduled(env, t0 + 15 * MIN);
  check("掉线第一次：还不推，等下一轮确认", (await getWatch(env, w.id))?.failCount === 1 && sent.length === 0);
  sites.set("https://site.test/flaky", async () => {
    await deleteWatch(env, w.id);
    return { status: 500 };
  });
  const round = await runScheduled(env, t0 + 20 * MIN);
  check("★ 确认掉线了但监控已经删了：不推「掉线」", round.checked === 1 && round.alerted === 0 && sent.length === 0, JSON.stringify(round));
  check("★ 状态没写回去，配置没复活", leftKeys(kv, w.id).length === 0);
}

console.log("\n★ cron 只读到期的：没到期的一条也不读");
{
  const { env, kv } = makeEnv();
  sent.length = 0;
  sites.set("https://site.test/ok", { status: 200 });
  const t0 = Date.now();
  const calm = [];
  for (let i = 0; i < 8; i++) {
    const hb = await createWatch(env, "owner0001", parseWatchInput({ kind: "heartbeat", channelId: "chan0001", intervalMinutes: 60 }));
    await recordHeartbeat(env, hb.id, { failed: false }, t0);
    calm.push(hb.id);
  }
  for (let i = 0; i < 4; i++) calm.push((await createWatch(env, "owner0001", parseWatchInput({ kind: "heartbeat", channelId: "chan0001", intervalMinutes: 60 }))).id);
  const sitesChecked = [];
  for (let i = 0; i < 5; i++) sitesChecked.push((await createWatch(env, "owner0001", parseWatchInput({ kind: "up", channelId: "chan0001", url: "https://site.test/ok", intervalMinutes: 60 }))).id);
  await runScheduled(env, t0);
  calm.push(...sitesChecked);
  const late = await createWatch(env, "owner0001", parseWatchInput({ kind: "heartbeat", channelId: "chan0001", intervalMinutes: 5 }));
  await recordHeartbeat(env, late.id, { failed: false }, t0);

  kv.reads.length = 0;
  fetched.length = 0;
  const round = await runScheduled(env, t0 + 15 * MIN);
  check("到期的心跳告了警，没到期的网址一个没抓", round.alerted === 1 && round.checked === 0 && fetched.length === 0);
  const touched = kv.reads.filter((k) => calm.some((id) => k.endsWith(id)));
  check("★ 17 个没到期的监控：配置和状态一次都没读", touched.length === 0, touched.join(" | "));
  check("读的只有到期那个和它要推的通道、账号", kv.reads.every((k) => k.endsWith(late.id) || /^(chan|susp|acct|dead|stat|repeat|config):/.test(k)), kv.reads.join(" | "));
}

console.log("\n★ 规模：1500 个监控，每轮守住 KV 额度，几轮之内全都看到、谁也不被饿着");
{
  const { env, kv } = makeEnv();
  const big = memoryKV({ pageSize: 1000 });
  for (const [k, v] of kv.store) big.store.set(k, v);
  const scaled = { ...env, PIGEON_KV: big };
  sites.set("https://site.test/many", { status: 200 });
  const t0 = Date.now();
  const ids = [];
  for (let i = 0; i < 1500; i++) ids.push((await createWatch(scaled, "owner0001", parseWatchInput({ kind: "up", channelId: "chan0001", url: "https://site.test/many", intervalMinutes: 60 }))).id);
  fetched.length = 0;
  const rounds = [];
  let at = t0;
  for (let i = 0; i < 30; i++) {
    const before = big.ops();
    const round = await runScheduled(scaled, at);
    rounds.push({ ...round, counted: big.ops() - before });
    if (round.deferred === 0) break;
    at += 5 * MIN;
  }
  const first = rounds[0];
  check("★ 超过一页（1000）的也全都列到了", first.due === 1500, `due=${first.due}`);
  check("★ 每轮的 KV 操作都在 1000 次以内", rounds.every((r) => r.counted < 1000), rounds.map((r) => r.counted).join(","));
  check("巡检自己数的和实际的一致", rounds.every((r) => r.kvOps === r.counted), rounds.map((r) => `${r.kvOps}/${r.counted}`).join(","));
  check("★ 没轮上的顺延到下一轮，不算出错", first.deferred > 0 && first.errors === 0 && first.checked + first.deferred === 1500, JSON.stringify(first));
  const checkedOnce = fetched.length === 1500;
  check("★ 几轮之内 1500 个全都检查到，每个正好一次（先到期的先看，看过的不插队）", checkedOnce && rounds.length <= 15, `rounds=${rounds.length} fetched=${fetched.length}`);
  const states = ids.map((id) => big.meta.get(`wstate:${id}`));
  check("全都记下了状态", states.every((m) => m?.lastStatus === "up"));
  big.reads.length = 0;
  const idle = await runScheduled(scaled, at + 5 * MIN);
  check("★ 下一轮都没到期：一条值也不读", idle.checked === 0 && big.reads.filter((k) => k.startsWith("watch:") || k.startsWith("wstate:")).length === 0, `reads=${big.reads.length}`);
}

console.log("\n★ 老数据迁移：改版之前的监控（状态写在配置里、没有索引）");
{
  const { env, kv } = makeEnv();
  sent.length = 0;
  const t0 = Date.now();
  const seed = (id, extra) => {
    const raw = JSON.stringify({ id, ownerId: "owner0001", channelId: "chan0001", createdAt: t0 - 86_400_000, name: id, ...extra });
    kv.store.set(`watch:${id}`, raw);
    return raw;
  };
  const raws = {
    fine: seed("legacyfine01", { kind: "heartbeat", intervalMinutes: 60, graceMinutes: 6, lastStatus: "up", lastPingAt: t0 - MIN }),
    silent: seed("legacysilent", { kind: "heartbeat", intervalMinutes: 60, graceMinutes: 6, lastStatus: "up", lastPingAt: t0 - 3 * 60 * MIN }),
    fresh: seed("legacyfresh1", { kind: "heartbeat", intervalMinutes: 60, graceMinutes: 6, lastStatus: "new" }),
    site: seed("legacysite01", { kind: "up", url: "https://site.test/legacy", intervalMinutes: 15, lastStatus: "up", lastCheckedAt: t0 - 60 * MIN }),
    pinged: seed("legacypinged", { kind: "heartbeat", intervalMinutes: 60, graceMinutes: 6, lastStatus: "up", lastPingAt: t0 - 2 * MIN }),
  };
  seed("legacyorphan", { kind: "heartbeat", channelId: "chanGone0001", intervalMinutes: 60, lastStatus: "up", lastPingAt: t0 });
  sites.set("https://site.test/legacy", { status: 503 });

  check("★ 迁移之前：列表照样有老监控，状态取自配置里的旧字段", (await listWatches(env, "owner0001")).length === 6 && (await getWatch(env, "legacyfine01"))?.lastPingAt === t0 - MIN);
  check("迁移之前老心跳照常报到（按旧状态节流：刚报过，不写）", outcome(await recordHeartbeat(env, "legacyfine01", { failed: false }, t0)) === "up" && !kv.store.has("hbstate:legacyfine01"));
  const failed = await recordHeartbeat(env, "legacypinged", { failed: true, message: "迁移前报的失败" }, t0);
  check("迁移之前报失败：照推，状态写进状态键", outcome(failed) === "down" && sent.length === 1 && JSON.parse(kv.store.get("hbstate:legacypinged")).lastStatus === "down");
  check("配置原样没动", kv.store.get("watch:legacypinged") === raws.pinged);

  let round = await runScheduled(env, t0 + MIN);
  check("★ 第一轮：5 个补进索引，通道早没了的那个删掉", round.adopted === 5 && round.removed === 1, JSON.stringify(round));
  check("补索引的这一轮不告警、不抓（下一轮再看）", round.alerted === 0 && round.checked === 0 && sent.length === 1);
  check("★ 索引带着通道和类型", kv.meta.get("wown:owner0001:legacysilent")?.channelId === "chan0001" && kv.meta.get("wown:owner0001:legacysite01")?.kind === "up");
  check("★ 旧状态搬进状态键，metadata 里算好了何时到期", kv.meta.get("hbstate:legacysilent")?.nextDueAt === t0 - 3 * 60 * MIN + 66 * MIN && kv.meta.get("wstate:legacysite01")?.nextDueAt === t0 - 45 * MIN);
  check("★ 迁移前已经写过的状态不被旧字段盖掉", JSON.parse(kv.store.get("hbstate:legacypinged")).lastStatus === "down");
  check("★ 配置一个字节都没改", Object.entries(raws).every(([, raw]) => kv.store.has(`watch:${JSON.parse(raw).id}`) && kv.store.get(`watch:${JSON.parse(raw).id}`) === raw));
  check("通道没了的老监控连同配置删干净", leftKeys(kv, "legacyorphan").length === 0);
  check("★ 全部补完，记下标记", kv.store.has("config:watches_indexed"));

  round = await runScheduled(env, t0 + 6 * MIN);
  let titles = sent.slice(1).map((s) => s.payload.aps.alert.title);
  check("★ 第二轮：失联已久的老心跳告警，老网站照常检查", round.alerted === 1 && round.checked === 1 && titles.some((t) => t.includes("legacysilent")), titles.join(" | "));
  check("老网站这一次 503：先记一次失败，不急着报", (await getWatch(env, "legacysite01"))?.failCount === 1 && (await getWatch(env, "legacysite01"))?.lastStatus === "up");
  round = await runScheduled(env, t0 + 11 * MIN);
  titles = sent.slice(1).map((s) => s.payload.aps.alert.title);
  check("★ 下一轮还是 503：确认掉线，推出去", round.alerted === 1 && titles.some((t) => t.includes("legacysite01")), titles.join(" | "));
  check("按时报到的、还没接上的老心跳都不响", !titles.some((t) => t.includes("legacyfine01") || t.includes("legacyfresh1")));
  check("状态照常更新", (await getWatch(env, "legacysilent"))?.lastStatus === "down" && (await getWatch(env, "legacysite01"))?.lastStatus === "down");

  const lists = [];
  const spied = { ...env, PIGEON_KV: { ...kv, list: (opts) => (lists.push(opts.prefix), kv.list(opts)) } };
  check("有了标记：按人列监控只翻自己的索引", (await listWatches(spied, "owner0001")).length === 5 && lists.every((p) => p === "wown:owner0001:"), lists.join(" | "));
  check("删一个老监控：配置、状态、索引一起删", (await deleteWatch(env, await getWatch(env, "legacysite01")), leftKeys(kv, "legacysite01").length === 0));
}

// ── 提醒强度、告警参数、告警算不算发出去（纯函数） ────────────────────

console.log("\n★ 提醒强度（level / repeat）");
{
  const up = (extra) => parseWatchInput({ kind: "up", url: "https://a.com", channelId: "abcdef", ...extra });
  check("没给就不带", up({}).level === undefined && up({}).repeat === undefined);
  check("普通 = active", up({ level: "active" }).level === "active");
  check("重要 = timeSensitive，大小写、连字符写法都认", up({ level: "timeSensitive" }).level === "timeSensitive" && up({ level: "time-sensitive" }).level === "timeSensitive" && up({ level: "TIMESENSITIVE" }).level === "timeSensitive");
  check("★ level 写错 → 报错，不悄悄当成没设", typeof up({ level: "critical" }) === "string" && typeof up({ level: 3 }) === "string");
  check("repeat 5 → 每 5 分钟", up({ repeat: 5 }).repeat === 5);
  check("repeat true / \"1\" → 最密的 5 分钟（同推送参数）", up({ repeat: true }).repeat === 5 && up({ repeat: "1" }).repeat === 5);
  check("repeat 夹到 5–60", up({ repeat: 2 }).repeat === 5 && up({ repeat: 600 }).repeat === 60);
  check("repeat 0 / 乱写 = 不重复", up({ repeat: 0 }).repeat === undefined && up({ repeat: "abc" }).repeat === undefined);
  const hb = parseWatchInput({ kind: "heartbeat", channelId: "abcdef", intervalMinutes: 60, level: "timeSensitive", repeat: 5 });
  check("心跳也能带（「直到有人处理」）", hb.level === "timeSensitive" && hb.repeat === 5);
  check("关键词监控也能带", parseWatchInput({ kind: "keyword", url: "https://a.com", channelId: "abcdef", keyword: "x", level: "active" }).level === "active");
  check("别的字段先报错", parseWatchInput({ kind: "up", url: "x", channelId: "abcdef", level: "bad" }) === "url 不是合法的网址");
}

console.log("\n★ 告警参数：通道默认值垫底，告警自己的判断在上，监控的提醒强度最上");
{
  const channel = { defaults: { sound: "alarm.caf", repeat: "10", level: "passive", call: "1", title: "默认标题", body: "默认正文", ciphertext: "xyz", url: "https://x" } };
  const firing = { title: "掉线了", body: "b", level: "timeSensitive", status: "firing", id: "watch-x" };
  const resolved = { title: "恢复了", body: "b", level: "active", status: "resolved", id: "watch-x" };
  const plain = alertParams(channel, {}, firing);
  check("★ 通道默认的重复提醒对监控告警生效", plain.repeat === "10");
  check("通道默认的铃声、持续响铃也用上", plain.sound === "alarm.caf" && plain.call === "1");
  check("★ 告警自己的级别压过通道默认值（掉线不会被降成静默）", plain.level === "timeSensitive");
  check("★ 通道默认的内容（标题正文、密文、链接）不混进告警", plain.title === "掉线了" && plain.body === "b" && plain.ciphertext === undefined && plain.url === undefined);
  const strong = alertParams(channel, { level: "active", repeat: 5 }, firing);
  check("★ 监控自己的提醒强度最优先", strong.level === "active" && strong.repeat === "5");
  const back = alertParams(channel, { level: "timeSensitive", repeat: 5 }, resolved);
  check("★「恢复」不受提醒强度影响，也不带重复提醒、持续响铃", back.level === "active" && back.repeat === undefined && back.call === undefined && back.sound === "alarm.caf");
  check("关键词命中（没有 status）按告警算", alertParams(channel, { level: "active" }, { title: "t", level: "timeSensitive" }).level === "active");
  check("没有通道默认值也行", alertParams({}, {}, firing).level === "timeSensitive" && alertParams({}, {}, firing).repeat === undefined);
}

console.log("\n★ 告警算不算发出去了");
{
  const r = (...statuses) => ({ delivered: statuses.filter((s) => s === 200).length, results: statuses.map((status) => ({ status })) });
  check("送到一台就算", alertSettled(r(200, 503)));
  check("被通道去重压掉也算（同样的话刚说过）", alertSettled({ delivered: 0, results: [], suppressed: true }));
  check("失败的全是失效 token（410）：算，重试也没用", alertSettled(r(410, 410)));
  check("400 payload 不对：算", alertSettled(r(400)));
  check("★ APNs 503：不算，下一轮再推", !alertSettled(r(503)));
  check("429 限流、403 签名出错、网络出错（502）：不算", !alertSettled(r(429)) && !alertSettled(r(403)) && !alertSettled(r(502)));
  check("有一台是还能重试的失败：不算", !alertSettled(r(410, 503)));
  check("★ 一台设备都没有：不算（试几轮就放弃）", !alertSettled({ delivered: 0, results: [] }));
  check("★ 发出之前就被拒了（截不动也放不下）：算，重推也是同样被拒", alertSettled({ delivered: 0, results: [], rejection: { status: 413, message: "太长" } }));
}

console.log("\n★ 网址监控的判定：连续失败才算掉线，超时退避，太多次就暂停");
{
  const site = { id: "site0001", kind: "up", channelId: "chan0001", ownerId: "owner0001", url: "https://s.test/", intervalMinutes: 5, name: "官网", createdAt: T };
  const down = { status: "down", detail: "HTTP 500" };
  const ok = { status: "up", detail: "HTTP 200" };
  const slow = { status: "down", detail: "5 秒内没有回应", timeout: true };

  const s1 = siteStep(site, down, T);
  check("★ 新建后第一次检查就失败：不推，先记一次", s1.alert === null && s1.watch.failCount === 1 && s1.watch.lastStatus === undefined);
  check("失败说明记下", s1.watch.lastDetail === "HTTP 500");
  check("★ 下一轮（5 分钟后）就再看一次，不按间隔等", siteDueAt({ ...s1.watch, intervalMinutes: 60 }) === T + 5 * MIN);
  const s2 = siteStep(s1.watch, down, T + 5 * MIN);
  check("★ 连续第二次失败：确认掉线，推「掉线了」（首次检查也一样要两次）", s2.watch.lastStatus === "down" && s2.alert?.title.includes("掉线了") && s2.alert?.status === "firing");
  check("掉线告警的正文带上原因", s2.alert?.body.endsWith("HTTP 500"));
  const s3 = siteStep(s2.watch, down, T + 10 * MIN);
  check("已经掉线：不重复推", s3.alert === null && s3.watch.failCount === 3);
  check("掉线之后按原间隔检查", siteDueAt(s3.watch) === T + 15 * MIN);
  const back = siteStep(s3.watch, ok, T + 15 * MIN);
  check("★ 恢复一次就推「恢复了」，计数和说明清掉", back.alert?.status === "resolved" && back.watch.failCount === undefined && back.watch.lastDetail === undefined && back.watch.lastStatus === "up");

  const upOnce = siteStep(siteStep(site, ok, T).watch, down, T + 5 * MIN);
  check("★ 在线时失败一次（抖一下）：不推，状态还是在线", upOnce.alert === null && upOnce.watch.lastStatus === "up");
  const blip = siteStep(upOnce.watch, ok, T + 10 * MIN);
  check("抖完又好了：什么都不推", blip.alert === null && blip.watch.lastStatus === "up" && blip.watch.failCount === undefined);
  check("第一次就在线：不推", siteStep(site, ok, T).alert === null);

  let w = siteStep(site, ok, T).watch;
  const gaps = [];
  let now = T;
  let pausedAt = null;
  let notices = 0;
  for (let i = 1; i <= 10; i++) {
    now = siteDueAt(w);
    const step = siteStep(w, slow, now);
    if (step.paused) {
      notices += 1;
      pausedAt = now;
    }
    w = step.watch;
    gaps.push((siteDueAt(w) - now) / MIN);
  }
  check("★ 连续超时：第 2 次起间隔翻倍（5 → 10 → 20 → 40 …）", gaps.slice(0, 7).join(",") === "5,10,20,40,80,160,320", gaps.join(","));
  check(`★ 连续 ${PAUSE_AFTER_TIMEOUTS} 次超时：进入暂停，只说一次`, notices === 1 && w.pausedAt === pausedAt && w.timeoutCount === 10, `${notices} ${w.timeoutCount}`);
  check("暂停之后每天试一次", gaps.slice(7).every((g) => g === 24 * 60), gaps.join(","));
  const answered = siteStep(w, { status: "down", detail: "HTTP 502" }, now + PAUSED_CHECK_MS);
  check("★ 有回应了（哪怕是错误页）：退出暂停，回到原间隔", answered.watch.pausedAt === undefined && answered.watch.timeoutCount === undefined && siteDueAt(answered.watch) === now + PAUSED_CHECK_MS + 5 * MIN);
  const recovered = siteStep(w, ok, now + PAUSED_CHECK_MS);
  check("暂停中恢复在线：推「恢复了」", recovered.alert?.status === "resolved" && recovered.watch.pausedAt === undefined);
  const hourly = { ...site, intervalMinutes: 60, lastStatus: "down", lastCheckedAt: T, timeoutCount: 3 };
  check("退避不会比原间隔短，也不超过一天", siteDueAt(hourly) === T + 240 * MIN && siteDueAt({ ...hourly, timeoutCount: 7 }) === T + 24 * 60 * MIN);
  check("超时一次不退避（只是下一轮确认）", siteDueAt({ ...site, lastCheckedAt: T, failCount: 1, timeoutCount: 1, lastStatus: "up", intervalMinutes: 60 }) === T + 5 * MIN);
  check("告警等着重推：下一轮就看", siteDueAt({ ...site, intervalMinutes: 60, lastCheckedAt: T, pendingAlertAttempts: 1 }) === T + 5 * MIN);

  const kw = { ...site, kind: "keyword", keyword: "有票", present: true };
  const seen = siteStep(kw, { status: "absent", detail: "没有" }, T).watch;
  const broken = siteStep(seen, { status: "error", detail: "HTTP 502，无法判定" }, T + 5 * MIN);
  check("★ 关键词判断不了：保持上次的状态，不推", broken.alert === null && broken.watch.lastStatus === "absent" && broken.watch.lastDetail === "HTTP 502，无法判定");
  check("关键词判断不了不用等确认，按原间隔", siteDueAt(broken.watch) === T + 10 * MIN);
  const hit = siteStep(broken.watch, { status: "present", detail: "找到了" }, T + 10 * MIN);
  check("之后找到了：照常推「出现了」", hit.alert?.body.includes("出现了") && hit.watch.failCount === undefined);
}

// ── 跑在内存 KV 上的：抓取、告警重推、提醒强度、暂停、两个 cron ─────────

/** 往内存 KV 里加一个带设备的账号 */
function addAccount(kv, id, token) {
  kv.store.set(`acct:${id}`, JSON.stringify({
    id, secretHash: "x", channelIds: [], createdAt: T, updatedAt: T,
    devices: token ? [{ token, env: "sandbox", name: id, addedAt: T }] : [],
  }));
}
const OWNER_TOKEN = "a".repeat(64);
const pushedTo = (token) => sent.filter((s) => s.url.endsWith(token));
const titleOf = (s) => s?.payload.aps.alert.title ?? "";

console.log("\n★ 掉线监控：连续两次失败才推，原因写清楚");
{
  const { env } = makeEnv();
  sent.length = 0;
  const t0 = Date.now();
  sites.set("https://up.test/waf", { status: 403 });
  sites.set("https://up.test/dead", () => {
    throw new TypeError("fetch failed");
  });
  const waf = await createWatch(env, "owner0001", parseWatchInput({ kind: "up", channelId: "chan0001", url: "https://up.test/waf", name: "被拦的站" }));
  const dead = await createWatch(env, "owner0001", parseWatchInput({ kind: "up", channelId: "chan0001", url: "https://up.test/dead", name: "连不上的站" }));
  let round = await runScheduled(env, t0);
  check("★ 新建后第一轮就失败：一条都不推", round.checked === 2 && round.alerted === 0 && sent.length === 0, JSON.stringify(round));
  check("记下第一次失败和原因", (await getWatch(env, waf.id))?.lastDetail === "HTTP 403（可能被目标站拦截）" && (await getWatch(env, dead.id))?.lastDetail === "连不上");
  round = await runScheduled(env, t0 + 5 * MIN);
  check("★ 5 分钟后（不等 15 分钟的间隔）再看还是不行：推「掉线了」", round.checked === 2 && round.alerted === 2 && sent.length === 2, JSON.stringify(round));
  const wafAlert = sent.find((s) => titleOf(s).includes("被拦的站"));
  check("★ 403 的告警写明可能是被目标站拦截", wafAlert?.payload.aps.alert.body.endsWith("HTTP 403（可能被目标站拦截）"), wafAlert?.payload.aps.alert.body);
  check("状态记成 down", (await getWatch(env, waf.id))?.lastStatus === "down" && (await getWatch(env, dead.id))?.lastStatus === "down");
  const listed = (await listWatches(env, "owner0001")).find((w) => w.id === waf.id);
  check("列表里看得到失败说明", listed?.lastDetail === "HTTP 403（可能被目标站拦截）");
}

console.log("\n★ 关键词：只在 2xx 的文本里找；错误页、拦截页、验证页、图片、超大页面都「判断不了」，不误报");
{
  const { env } = makeEnv();
  sent.length = 0;
  const t0 = Date.now();
  const cases = {
    e502: [{ status: 502, body: "Bad Gateway" }, "HTTP 502，无法判定"],
    e403: [{ status: 403, body: "Forbidden" }, "HTTP 403（可能被目标站拦截）"],
    e429: [{ status: 429, body: "Too Many Requests" }, "HTTP 429（可能被目标站拦截）"],
    mitigated: [{ status: 503, body: "", headers: { "cf-mitigated": "challenge" } }, "HTTP 503（可能被目标站拦截）"],
    challenge: [{ body: '<html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b"></script></body></html>' }, "HTTP 200（可能被目标站拦截）"],
    image: [{ body: "PNG....", type: "image/png" }, "返回的不是文本，无法判定"],
    huge: [{ body: Array.from({ length: 10 }, () => "x".repeat(64 * 1024)) }, "页面超过 512KB，前 512KB 里没找到，无法判定"],
  };
  const ids = {};
  for (const name of [...Object.keys(cases), "gone"]) {
    const url = `https://kw.test/${name}`;
    sites.set(url, { body: "<p>还有票</p>" });
    ids[name] = (await createWatch(env, "owner0001", parseWatchInput({ kind: "keyword", channelId: "chan0001", url, keyword: "有票", present: false, name }))).id;
  }
  await runScheduled(env, t0);
  let allPresent = true;
  for (const id of Object.values(ids)) allPresent &&= (await getWatch(env, id))?.lastStatus === "present";
  check("先都看到了关键词", allPresent && sent.length === 0);

  for (const [name, [reply]] of Object.entries(cases)) sites.set(`https://kw.test/${name}`, reply);
  sites.set("https://kw.test/gone", { body: "<p>售罄</p>" });
  const round = await runScheduled(env, t0 + 15 * MIN);
  check("★ 只有真的没了的那个推了「消失了」", round.alerted === 1 && sent.length === 1 && sent[0].payload.aps.alert.body.startsWith("「有票」消失了"), sent.map(titleOf).join(" | "));
  for (const [name, [, detail]] of Object.entries(cases)) {
    const w = await getWatch(env, ids[name]);
    check(`${name}：保持上次的状态，说明是「${detail}」`, w?.lastStatus === "present" && w?.lastDetail === detail, `${w?.lastStatus} ${w?.lastDetail}`);
  }

  const chunks = Array.from({ length: 20 }, (_, i) => (i === 3 ? "……今天有票……" : "y".repeat(64 * 1024)));
  sites.set("https://kw.test/late", { body: "<p>暂时没有</p>" });
  const late = await createWatch(env, "owner0001", parseWatchInput({ kind: "keyword", channelId: "chan0001", url: "https://kw.test/late", keyword: "有票", name: "开票提醒" }));
  await runScheduled(env, t0 + 20 * MIN);
  sites.set("https://kw.test/late", { body: chunks });
  await runScheduled(env, t0 + 40 * MIN);
  check("★ 词在后面几块里也找得到：推「出现了」", (await getWatch(env, late.id))?.lastStatus === "present" && titleOf(sent.at(-1)).includes("开票提醒"));
  check("★ 找到就停，后面的不再读（20 块只取了前几块）", chunks.length >= 14, `剩 ${chunks.length} 块`);
}

console.log("\n★ APNs 出错时告警不丢：状态不动、下一轮重推，试满 3 轮才放弃");
/** APNs 回 5xx 时 pushToDevice 自己先重试一次（apns.ts），所以一次没送到的推送在假 APNs 这边是两个请求 */
const TRIES_ON_5XX = 2;
{
  const { env, kv } = makeEnv();
  sent.length = 0;
  const t0 = Date.now();
  sites.set("https://p.test/", { status: 200 });
  const w = await createWatch(env, "owner0001", parseWatchInput({ kind: "up", channelId: "chan0001", url: "https://p.test/", intervalMinutes: 60 }));
  await runScheduled(env, t0);
  sites.set("https://p.test/", { status: 500 });
  await runScheduled(env, t0 + 60 * MIN);
  apns.down = 503;
  let round = await runScheduled(env, t0 + 65 * MIN);
  check("★ 确认掉线、但 APNs 503：推了没送到，状态还是在线", round.retrying === 1 && round.alerted === 0 && sent.length === TRIES_ON_5XX && (await getWatch(env, w.id))?.lastStatus === "up", JSON.stringify(round));
  check("记下试了一次，下一轮就重推", (await getWatch(env, w.id))?.pendingAlertAttempts === 1 && kv.meta.get(`wstate:${w.id}`)?.nextDueAt === t0 + 70 * MIN);
  apns.down = null;
  round = await runScheduled(env, t0 + 70 * MIN);
  check("★ 下一轮 APNs 好了：重推送到，这才记成掉线", round.alerted === 1 && sent.length === TRIES_ON_5XX + 1 && (await getWatch(env, w.id))?.lastStatus === "down" && (await getWatch(env, w.id))?.pendingAlertAttempts === undefined);
  round = await runScheduled(env, t0 + 130 * MIN);
  check("之后不再重复推", round.alerted === 0 && sent.length === TRIES_ON_5XX + 1);

  apns.down = 503;
  sites.set("https://p.test/", { status: 200 });
  round = await runScheduled(env, t0 + 190 * MIN);
  check("「恢复了」也一样：没送到就还是 down", round.retrying === 1 && (await getWatch(env, w.id))?.lastStatus === "down");
  apns.down = null;
  round = await runScheduled(env, t0 + 195 * MIN);
  check("下一轮重推送到，记成 up", round.alerted === 1 && titleOf(sent.at(-1)).includes("恢复了") && (await getWatch(env, w.id))?.lastStatus === "up");

  sites.set("https://p.test/", { status: 500 });
  await runScheduled(env, t0 + 255 * MIN);
  apns.down = 503;
  await runScheduled(env, t0 + 260 * MIN);
  apns.down = null;
  sites.set("https://p.test/", { status: 200 });
  const before = sent.length;
  round = await runScheduled(env, t0 + 265 * MIN);
  check("★ 重推之前网站已经好了：不补推「掉线了」，也不推「恢复了」", round.alerted === 0 && sent.length === before && (await getWatch(env, w.id))?.lastStatus === "up" && (await getWatch(env, w.id))?.pendingAlertAttempts === undefined);
}
{
  const { env } = makeEnv();
  sent.length = 0;
  const hb = await createWatch(env, "owner0001", parseWatchInput({ kind: "heartbeat", channelId: "chan0001", intervalMinutes: 5 }));
  const t0 = Date.now();
  await recordHeartbeat(env, hb.id, { failed: false }, t0);
  apns.down = 503;
  let round = await runScheduled(env, t0 + 11 * MIN);
  check("★ 心跳失联但 APNs 503：状态还是 up，下一轮再推", round.retrying === 1 && (await getWatch(env, hb.id))?.lastStatus === "up" && (await getWatch(env, hb.id))?.pendingAlertAttempts === 1);
  round = await runScheduled(env, t0 + 16 * MIN);
  check("第二轮还是 503：再推一次", round.retrying === 1 && (await getWatch(env, hb.id))?.pendingAlertAttempts === 2 && sent.length === 2 * TRIES_ON_5XX);
  round = await runScheduled(env, t0 + 21 * MIN);
  check(`★ 试满 ${MAX_ALERT_ATTEMPTS} 轮：放弃，记成 down，不再每轮空转`, round.abandoned === 1 && (await getWatch(env, hb.id))?.lastStatus === "down" && sent.length === 3 * TRIES_ON_5XX, JSON.stringify(round));
  check("放弃的记了日志，写明原因", logged.some((l) => l.includes(hb.id) && l.includes("放弃") && l.includes("ServiceUnavailable")));
  round = await runScheduled(env, t0 + 26 * MIN);
  check("放弃之后不再推", round.due === 0 && sent.length === 3 * TRIES_ON_5XX);

  let w = await recordHeartbeat(env, hb.id, { failed: false }, t0 + 30 * MIN);
  check("★ 回来报到、但「恢复」没推出去：回给任务的是 up，存下的仍是 down", outcome(w) === "up" && (await getWatch(env, hb.id))?.lastStatus === "down" && (await getWatch(env, hb.id))?.pendingAlertAttempts === 1);
  apns.down = null;
  w = await recordHeartbeat(env, hb.id, { failed: false }, t0 + 31 * MIN);
  check("★ 下次报到重推「恢复」，送到了才记成 up", outcome(w) === "up" && sent.at(-1)?.payload.status === "resolved" && (await getWatch(env, hb.id))?.lastStatus === "up" && (await getWatch(env, hb.id))?.pendingAlertAttempts === undefined);

  apns.down = 503;
  w = await recordHeartbeat(env, hb.id, { failed: true, message: "第一次失败" }, t0 + 40 * MIN);
  check("报失败没推出去：回的是 down，存的还是 up（记下还活着）", outcome(w) === "down" && (await getWatch(env, hb.id))?.lastStatus === "up" && (await getWatch(env, hb.id))?.lastPingAt === t0 + 40 * MIN);
  apns.down = null;
  w = await recordHeartbeat(env, hb.id, { failed: true, message: "又失败了" }, t0 + 41 * MIN);
  check("再报失败照常推，这次送到了记成 down", outcome(w) === "down" && sent.at(-1)?.payload.aps.alert.body === "又失败了" && (await getWatch(env, hb.id))?.lastStatus === "down");
}
{
  const { env, kv } = makeEnv();
  addAccount(kv, "owner0001", null);
  sent.length = 0;
  const hb = await createWatch(env, "owner0001", parseWatchInput({ kind: "heartbeat", channelId: "chan0001", intervalMinutes: 5 }));
  const t0 = Date.now();
  await recordHeartbeat(env, hb.id, { failed: false }, t0);
  const rounds = [];
  for (let i = 0; i < 4; i++) rounds.push(await runScheduled(env, t0 + (11 + 5 * i) * MIN));
  check("★ 通道一台设备都没有：试 3 轮就放弃，之后不再空转", rounds.map((r) => `${r.retrying}${r.abandoned}`).join(",") === "10,10,01,00" && (await getWatch(env, hb.id))?.lastStatus === "down", rounds.map((r) => `${r.retrying}${r.abandoned}`).join(","));
}

console.log("\n★ 通道默认值、监控的提醒强度，真推一遍");
{
  const { env, kv } = makeEnv();
  const chan = JSON.parse(kv.store.get("chan:chan0001"));
  kv.store.set("chan:chan0001", JSON.stringify({ ...chan, defaults: { repeat: "10", sound: "alarm.caf", title: "默认标题" } }));
  sent.length = 0;
  const t0 = Date.now();
  const make = (name, extra) => createWatch(env, "owner0001", parseWatchInput({ kind: "heartbeat", channelId: "chan0001", intervalMinutes: 5, name, ...extra }));
  const plain = await make("默认强度", {});
  const calm = await make("普通强度", { level: "active" });
  const loud = await make("直到有人处理", { level: "timeSensitive", repeat: 5 });
  for (const w of [plain, calm, loud]) await recordHeartbeat(env, w.id, { failed: false }, t0);
  await runScheduled(env, t0 + 11 * MIN);
  const alertOf = (name) => sent.find((s) => titleOf(s).includes(`「${name}」没有按时上报`))?.payload;
  const p = alertOf("默认强度");
  check("★ 通道默认的重复提醒、铃声用在失联告警上", p?.repeat === "10" && p?.aps.sound === "alarm.caf" && p?.aps["interruption-level"] === "time-sensitive", JSON.stringify(p));
  check("通道默认的标题不会盖掉告警的标题", titleOf({ payload: p }).includes("默认强度"));
  check("★ 普通强度：告警是 active", alertOf("普通强度")?.aps["interruption-level"] === "active");
  const l = alertOf("直到有人处理");
  check("★ 直到有人处理：timeSensitive、每 5 分钟再提醒", l?.aps["interruption-level"] === "time-sensitive" && l?.repeat === "5");
  const loudKey = `repeat:chan0001:${await heartbeatMessageId(loud.id)}`;
  check("★ 真的排上了重复提醒", JSON.parse(kv.store.get(loudKey) ?? "{}").every === 5 && JSON.parse(kv.store.get(`repeat:chan0001:${await heartbeatMessageId(plain.id)}`) ?? "{}").every === 10);
  await recordHeartbeat(env, loud.id, { failed: false }, t0 + 12 * MIN);
  const back = sent.at(-1)?.payload;
  check("★ 恢复：active，不带重复提醒，排着的提醒随之撤掉", back?.status === "resolved" && back?.aps["interruption-level"] === "active" && back?.repeat === undefined && !kv.store.has(loudKey));
}

console.log("\n★ 只收加密的通道：任务附的失败说明不转发");
{
  const { env, kv } = makeEnv();
  const chan = JSON.parse(kv.store.get("chan:chan0001"));
  kv.store.set("chan:chan0001", JSON.stringify({ ...chan, policy: { e2eOnly: true } }));
  sent.length = 0;
  const hb = await createWatch(env, "owner0001", parseWatchInput({ kind: "heartbeat", channelId: "chan0001", intervalMinutes: 5, name: "备份" }));
  const t0 = Date.now();
  await recordHeartbeat(env, hb.id, { failed: true, message: "数据库口令 hunter2 不对" }, t0);
  const body = sent.at(-1)?.payload.aps.alert.body ?? "";
  check("★ 说明没转发，正文说清楚为什么", body === E2E_FAIL_BODY && !JSON.stringify(sent.at(-1)?.payload).includes("hunter2"), body);
  await recordHeartbeat(env, hb.id, { failed: true }, t0 + MIN);
  check("没附说明的照常是默认那句", sent.at(-1)?.payload.aps.alert.body === "任务报告了失败，没有附带说明。");
}

console.log("\n★ 心跳的告警和其他推送共用按通道的额度");
{
  const { env, kv } = makeEnv();
  const asked = [];
  let deny = false;
  env.RL_PUSH = { async limit({ key }) { asked.push(key); return { success: !deny }; } };
  sent.length = 0;
  const hb = await createWatch(env, "owner0001", parseWatchInput({ kind: "heartbeat", channelId: "chan0001", intervalMinutes: 5, name: "备份" }));
  const t0 = Date.now();
  await recordHeartbeat(env, hb.id, { failed: false }, t0);
  check("正常报到（没有要推的）不占额度", asked.length === 0);

  // 定时任务的重试循环一直打 /fail：原先每次都给全群推一条，额度根本不问
  const key = `hbstate:${hb.id}`;
  const writes = kv.writesTo(key);
  deny = true;
  const results = [];
  for (let i = 0; i < 20; i++) {
    results.push(outcome(await recordHeartbeat(env, hb.id, { failed: true, message: "重试" }, t0 + MIN + i * 100)));
  }
  check("★ 撞上额度：20 次都回 throttled", results.every((r) => r === "throttled"), results.join(","));
  check("★ 每次都问了按通道的额度", asked.length === 20 && asked.every((k) => k === "push:chan0001"), asked.slice(0, 2).join(","));
  check("★ 一条「报告失败」也没推", !sent.some((x) => x.payload.aps.alert?.title?.includes("报告失败")));
  check("只提醒了创建者一次「推送太频繁」", sent.length === 1 && sent[0].payload.aps.alert.title.includes("推送太频繁"), String(sent.length));
  check("★ 状态一次也没写，仍是 up（告警没发出去，不能先走到 down）", kv.writesTo(key) === writes && (await getWatch(env, hb.id))?.lastStatus === "up");

  deny = false;
  let w = await recordHeartbeat(env, hb.id, { failed: true, message: "第一次" }, t0 + 2 * MIN);
  check("额度回来了：推「报告失败」，记成 down", outcome(w) === "down" && sent.at(-1)?.payload.aps.alert.body === "第一次" && (await getWatch(env, hb.id))?.lastStatus === "down");
  const afterFirst = kv.writesTo(key);
  await recordHeartbeat(env, hb.id, { failed: true, message: "第二次" }, t0 + 2 * MIN + 400);
  await recordHeartbeat(env, hb.id, { failed: true, message: "第三次" }, t0 + 2 * MIN + 800);
  check("已经是 down 又报失败：照样推", sent.at(-1)?.payload.aps.alert.body === "第三次");
  check("★ 但几分钟内不再写状态：同一个键一秒写几次会撞上 KV 的上限", kv.writesTo(key) === afterFirst, `${afterFirst} → ${kv.writesTo(key)}`);
  await recordHeartbeat(env, hb.id, { failed: true, message: "第四次" }, t0 + 7 * MIN);
  check("离上次记下满 4 分钟，再写一次", kv.writesTo(key) === afterFirst + 1);

  // KV 同键写入超限：推送已经出去了，这时抛出去就是 500，任务一重试又推一遍
  const put = kv.put;
  kv.put = async (k, v, o) => {
    if (k === key) throw new Error("KV PUT failed: 429 Too Many Requests");
    return put.call(kv, k, v, o);
  };
  const quiet = console.error;
  console.error = () => {};
  try {
    w = await recordHeartbeat(env, hb.id, { failed: false }, t0 + 8 * MIN);
  } catch (err) {
    w = { ok: false, reason: `抛了：${err.message}` };
  } finally {
    console.error = quiet;
    kv.put = put;
  }
  check("★ 「恢复」推出去了、状态没写进去：照样回 up，不抛", outcome(w) === "up" && sent.at(-1)?.payload.status === "resolved", outcome(w));
}

console.log("\n★ 一轮里几个大群同时告警：按人和设备占额度，推不起的顺延到下一轮，子请求不过 1000");
{
  const { env, kv } = makeEnv();
  const device = (id, k) => ({ token: `${id}d${k}`.padEnd(64, "0"), env: "sandbox", name: id, addedAt: T });
  const hbs = [];
  for (let g = 0; g < 6; g++) {
    const chanId = `bigch${g}00001`;
    const ownerId = `bigow${g}00001`;
    const memberIds = Array.from({ length: 50 }, (_, j) => `bm${g}x${String(j).padStart(3, "0")}`);
    // 50 人群，每人两台设备：一条告警光失效墓碑和 APNs 就是两三百个子请求
    for (const id of [ownerId, ...memberIds]) {
      kv.store.set(`acct:${id}`, JSON.stringify({ id, secretHash: "x", channelIds: [chanId], createdAt: T, updatedAt: T, devices: [device(id, 0), device(id, 1)] }));
    }
    kv.store.set(`chan:${chanId}`, JSON.stringify({ id: chanId, key: `bigkey${g}000001`, name: `大群${g}`, ownerId, memberIds, createdAt: T, count: 0 }));
    hbs.push(await createWatch(env, ownerId, parseWatchInput({ kind: "heartbeat", channelId: chanId, intervalMinutes: 5, name: `任务${g}` })));
  }
  const t0 = Date.now();
  for (const hb of hbs) await recordHeartbeat(env, hb.id, { failed: false }, t0);
  sent.length = 0;

  const rounds = [];
  let at = t0 + 15 * MIN;
  for (let i = 0; i < 6; i++) {
    const kvBefore = kv.ops();
    const apnsBefore = sent.length;
    const round = await runScheduled(env, at);
    rounds.push({ ...round, used: kv.ops() - kvBefore + (sent.length - apnsBefore) });
    if (round.deferred === 0) break;
    at += 5 * MIN;
  }
  const [first] = rounds;
  check("★ 每轮的子请求（KV 操作 + APNs 请求）都在 1000 以内", rounds.every((r) => r.used < 1000), rounds.map((r) => r.used).join(","));
  check("巡检自己数的（kvOps + fetches）和实际的一致", rounds.every((r) => r.kvOps + r.fetches === r.used), rounds.map((r) => `${r.kvOps}+${r.fetches}/${r.used}`).join(","));
  check("★ 第一轮推不起的告警顺延了，不算出错、也不算没推出去", first.deferred > 0 && first.alerted + first.deferred === 6 && first.errors === 0 && first.retrying === 0, JSON.stringify(first));
  const ids = await Promise.all(hbs.map((hb) => heartbeatMessageId(hb.id)));
  const perGroup = ids.map((id) => sent.filter((x) => x.payload.id === id).length);
  check("★ 几轮之内 6 个群都告了警，每台设备正好一次", rounds.length > 1 && perGroup.every((n) => n === 102), `rounds=${rounds.length} ${perGroup.join(",")}`);
  const states = await Promise.all(hbs.map((hb) => getWatch(env, hb.id)));
  check("告完都记成 down，没有挂着重推", states.every((w) => w?.lastStatus === "down" && w.pendingAlertAttempts === undefined));
}

console.log("\n★ 抓取：同时最多 6 个，5 秒超时，连续超时太多次就暂停、告诉创建者");
{
  const { env } = makeEnv();
  const t0 = Date.now();
  for (let i = 0; i < 12; i++) {
    sites.set(`https://slow.test/${i}`, { delay: 200 });
    await createWatch(env, "owner0001", parseWatchInput({ kind: "up", channelId: "chan0001", url: `https://slow.test/${i}` }));
  }
  flight.max = 0;
  const started = Date.now();
  const round = await runScheduled(env, t0);
  const took = Date.now() - started;
  check(`★ 同时在抓的最多 ${FETCH_CONCURRENCY} 个`, flight.max === FETCH_CONCURRENCY, `max=${flight.max}`);
  check("12 个慢站点分两拨抓完（并发，不是一个个排队）", round.checked === 12 && took >= 380 && took < 2000, `${took}ms`);
}
{
  const { env, kv } = makeEnv();
  // 群：成员也收告警，但暂停的说明只给创建者
  const MEMBER_TOKEN = "c".repeat(64);
  addAccount(kv, "member0001", MEMBER_TOKEN);
  const chan = JSON.parse(kv.store.get("chan:chan0001"));
  kv.store.set("chan:chan0001", JSON.stringify({ ...chan, memberIds: ["member0001"] }));
  sent.length = 0;
  const t0 = Date.now();
  const make = async (name, kind = "up") => {
    sites.set(`https://hang.test/${name}`, { hang: true });
    return createWatch(env, "owner0001", parseWatchInput({ kind, channelId: "chan0001", url: `https://hang.test/${name}`, name, keyword: "有票" }));
  };
  const a = await make("a");
  const b = await make("b");
  const c = await make("c", "keyword");
  const tired = await make("tired");
  const seeded = { kind: "up", lastStatus: "down", lastCheckedAt: t0 - 2 * 24 * 60 * MIN, failCount: 7, timeoutCount: 7, lastDetail: "5 秒内没有回应", nextDueAt: 0, at: t0 - MIN };
  kv.store.set(`wstate:${tired.id}`, JSON.stringify(seeded));
  kv.meta.set(`wstate:${tired.id}`, seeded);

  const started = Date.now();
  const round = await runScheduled(env, t0);
  const took = Date.now() - started;
  check(`★ 等不到回应的，${FETCH_TIMEOUT_MS / 1000} 秒就放弃（4 个同时等，一起超时）`, round.checked === 4 && took >= FETCH_TIMEOUT_MS - 100 && took < FETCH_TIMEOUT_MS + 2000, `${took}ms`);
  const wa = await getWatch(env, a.id);
  check("超时记下原因；新建后第一次超时不推", wa?.lastDetail === "5 秒内没有回应" && wa?.timeoutCount === 1 && wa?.failCount === 1 && !sent.some((s) => titleOf(s).includes("掉线")));
  const wc = await getWatch(env, c.id);
  check("关键词监控超时：判断不了", wc?.lastDetail === "5 秒内没有回应，无法判定" && wc?.lastStatus === undefined);
  const wt = await getWatch(env, tired.id);
  check(`★ 连续第 ${PAUSE_AFTER_TIMEOUTS} 次超时：暂停常规检查`, wt?.pausedAt === t0 && round.paused === 1 && wt?.timeoutCount === 8);
  const notices = sent.filter((s) => titleOf(s).includes("暂停检查"));
  check("★ 暂停的说明只推一条、只给创建者，群里别人不收", notices.length === 1 && notices[0].url.endsWith(OWNER_TOKEN) && pushedTo(MEMBER_TOKEN).length === 0, notices.map((n) => n.url.slice(-6)).join(","));
  check("说明里讲清楚之后怎么办", notices[0]?.payload.aps.alert.body.includes("之后每天试一次"));
  check("下一次一天后再试", kv.meta.get(`wstate:${tired.id}`)?.nextDueAt === t0 + PAUSED_CHECK_MS);
  const view = (await listWatches(env, "owner0001")).find((w) => w.id === tired.id);
  check("列表里看得到暂停的时刻", view?.pausedAt === t0);
  for (const name of ["a", "b", "c", "tired"]) sites.delete(`https://hang.test/${name}`);
  void b;
}

console.log("\n★ 两个 cron 各跑各的；每轮记下来；出错多了告诉运营者");
{
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const crons = toml.match(/^crons\s*=\s*(\[.*\])/m)?.[1] ?? "[]";
  check("★ wrangler.toml 配了两个 cron，和代码里分派用的一致", JSON.parse(crons).join("|") === [WATCH_CRON, REMINDER_CRON].join("|"), crons);

  const dispatch = async (cron) => {
    const { env, kv } = makeEnv();
    await runCron(env, cron, Date.now());
    return [kv.store.has("sweep:watches"), kv.store.has("sweep:reminders")].join(",");
  };
  check("★ 整 5 分钟那个只跑监控", (await dispatch(WATCH_CRON)) === "true,false");
  check("★ 错开 2 分钟那个只跑重复提醒", (await dispatch(REMINDER_CRON)) === "false,true");
  check("认不出来的（本地手动触发、旧配置）两样都跑", (await dispatch(undefined)) === "true,true");

  const { env, kv } = makeEnv();
  const MOD_TOKEN = "d".repeat(64);
  addAccount(kv, "mod0000001", MOD_TOKEN);
  kv.store.set("chan:modchan001", JSON.stringify({ id: "modchan001", key: "modkey000001", name: "审核", ownerId: "mod0000001", memberIds: [], createdAt: T, count: 0 }));
  kv.store.set("config:mod_channel", "modchan001");
  sites.set("https://ok.test/", { status: 200 });
  await createWatch(env, "owner0001", parseWatchInput({ kind: "up", channelId: "chan0001", url: "https://ok.test/" }));
  for (let i = 0; i < SWEEP_ERROR_ALERT; i++) {
    const w = await createWatch(env, "owner0001", parseWatchInput({ kind: "up", channelId: "chan0001", url: "https://ok.test/" }));
    kv.store.set(`watch:${w.id}`, "{坏掉的记录");
  }
  sent.length = 0;
  const now = Date.now();
  const report = await sweepWatches(env, now);
  check("出错的记数，不连累别的监控", report?.errors === SWEEP_ERROR_ALERT && report?.checked === 1, JSON.stringify(report));
  check("★ 出错的记了日志（原先一声不吭地吞掉）", logged.filter((l) => l.includes("检查出错")).length >= SWEEP_ERROR_ALERT);
  const record = JSON.parse(kv.store.get("sweep:watches"));
  check("★ 这一轮记下来了：跑完的时刻、计划时刻、耗时、计数", record.ok === true && record.errors === SWEEP_ERROR_ALERT && record.checked === 1 && record.scheduledAt === now && record.at >= now && typeof record.tookMs === "number" && typeof record.kvOps === "number");
  const toMod = () => pushedTo(MOD_TOKEN);
  check(`★ 一轮出错满 ${SWEEP_ERROR_ALERT} 个：推给运营者的审核通道`, toMod().length === 1 && titleOf(toMod()[0]).includes("监控巡检") && toMod()[0].payload.aps.alert.body.includes(`${SWEEP_ERROR_ALERT} 个出错`), toMod().map(titleOf).join(","));
  await sweepWatches(env, now + 5 * MIN);
  check("★ 一小时里只通知一次", toMod().length === 1);

  const broken = { ...env, PIGEON_KV: { ...kv, list: async () => { throw new Error("KV 抽风"); } } };
  kv.store.delete("sweep:notified:watches");
  const failed = await sweepWatches(broken, now + 10 * MIN);
  check("★ 整轮都没跑成：不抛出，记下失败，通知运营者", failed === null && JSON.parse(kv.store.get("sweep:watches")).ok === false && toMod().length === 2);
  const lost = await sweepReminders(broken, now);
  check("重复提醒整轮失败：同样记下、通知（和监控分开算）", lost === null && JSON.parse(kv.store.get("sweep:reminders")).ok === false && toMod().length === 3 && titleOf(toMod()[2]).includes("重复提醒"));
  const fine = await sweepReminders(env, now);
  check("正常的一轮：记下补发了几条", fine?.sent === 0 && JSON.parse(kv.store.get("sweep:reminders")).ok === true && JSON.parse(kv.store.get("sweep:reminders")).sent === 0);
  // 逐条出错（额度用完之后就是这样）：原先整轮没抛就记 ok、不通知，出错也不留日志
  for (let i = 0; i < SWEEP_ERROR_ALERT; i++) kv.store.set(`repeat:chan0001:bad${i}`, "{坏掉的记录");
  kv.store.delete("sweep:notified:reminders");
  const bad = await sweepReminders(env, now);
  const badRecord = JSON.parse(kv.store.get("sweep:reminders"));
  check(`★ 重复提醒逐条出错满 ${SWEEP_ERROR_ALERT} 条：记下出错数，通知运营者`, bad?.errors === SWEEP_ERROR_ALERT && badRecord.errors === SWEEP_ERROR_ALERT && toMod().length === 4 && toMod()[3].payload.aps.alert.body.includes(`${SWEEP_ERROR_ALERT} 条出错`), `${JSON.stringify(bad)} ${toMod().length}`);
  check("出错的记了日志", logged.filter((l) => l.includes("重复提醒补发出错")).length >= SWEEP_ERROR_ALERT);
  for (let i = 0; i < SWEEP_ERROR_ALERT; i++) kv.store.delete(`repeat:chan0001:bad${i}`);

  const quiet = makeEnv();
  for (let i = 0; i < SWEEP_ERROR_ALERT - 1; i++) {
    const w = await createWatch(quiet.env, "owner0001", parseWatchInput({ kind: "up", channelId: "chan0001", url: "https://ok.test/" }));
    quiet.kv.store.set(`watch:${w.id}`, "{坏掉的记录");
  }
  quiet.kv.store.set("config:mod_channel", "chan0001");
  sent.length = 0;
  await sweepWatches(quiet.env, now);
  check("零星出错不打扰运营者", sent.length === 0);
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
