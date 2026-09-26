/**
 * 网站监控与心跳的解析与判定。失败方式都是静默的 —— 状态判错就是「该响没响」或「不停乱响」。
 *
 * 心跳那几段跑在内存 KV 上，APNs 用假的 fetch 截下来看：cron 和报到接口之间的状态转换，
 * 只有真的推出去了什么、KV 里真的写了什么，才说得清对不对。
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import {
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
  return {
    store,
    meta,
    ttl,
    reads,
    /** 某个键被写过几次 —— 节流省下的正是这个 */
    writesTo: (key) => puts.get(key) ?? 0,
    async get(key, type) {
      reads.push(key);
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value, opts) {
      puts.set(key, (puts.get(key) ?? 0) + 1);
      store.set(key, value);
      if (opts?.metadata !== undefined) meta.set(key, JSON.parse(JSON.stringify(opts.metadata)));
      else meta.delete(key);
      if (opts?.expirationTtl !== undefined) ttl.set(key, opts.expirationTtl);
      else ttl.delete(key);
    },
    async delete(key) {
      store.delete(key);
      meta.delete(key);
      ttl.delete(key);
    },
    async list({ prefix = "", cursor } = {}) {
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
/**
 * 网址监控要抓的假网站：网址 → 怎么回应（可以是函数，抓取的那一刻做点什么）。
 * 不在这里的网址一概不许抓 —— 心跳不抓网址，抓了就是 bug
 */
const sites = new Map();
const fetched = [];
globalThis.fetch = async (url, init) => {
  const href = String(url);
  if (sites.has(href)) {
    fetched.push(href);
    const site = sites.get(href);
    const reply = typeof site === "function" ? await site() : site;
    return new Response(reply.body ?? "ok", { status: reply.status ?? 200, headers: { "content-type": "text/html" } });
  }
  if (!href.includes("push.apple.com")) throw new Error(`不该去抓这个网址：${href}`);
  sent.push({ url: href, headers: init.headers, payload: JSON.parse(init.body) });
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
  sites.set("https://site.test/flaky", async () => {
    await deleteWatch(env, w.id);
    return { status: 500 };
  });
  const round = await runScheduled(env, t0 + 15 * MIN);
  check("★ 掉线了但监控已经删了：不推「掉线」", round.checked === 1 && round.alerted === 0 && sent.length === 0, JSON.stringify(round));
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

console.log("\n★ 规模：1500 个监控，一轮全都看到");
{
  const { env, kv } = makeEnv();
  const big = memoryKV({ pageSize: 1000 });
  for (const [k, v] of kv.store) big.store.set(k, v);
  const scaled = { ...env, PIGEON_KV: big };
  sites.set("https://site.test/many", { status: 200 });
  const t0 = Date.now();
  for (let i = 0; i < 1500; i++) await createWatch(scaled, "owner0001", parseWatchInput({ kind: "up", channelId: "chan0001", url: "https://site.test/many", intervalMinutes: 15 }));
  fetched.length = 0;
  let round = await runScheduled(scaled, t0);
  check("★ 超过一页（1000）的也全都检查到", round.checked === 1500 && fetched.length === 1500, `checked=${round.checked}`);
  big.reads.length = 0;
  round = await runScheduled(scaled, t0 + 5 * MIN);
  check("★ 下一轮都没到期：一条值也不读", round.checked === 0 && big.reads.filter((k) => k.startsWith("watch:") || k.startsWith("wstate:")).length === 0, `reads=${big.reads.length}`);
  round = await runScheduled(scaled, t0 + 15 * MIN);
  check("到期了又全都检查到", round.checked === 1500);
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
  const titles = sent.slice(1).map((s) => s.payload.aps.alert.title);
  check("★ 第二轮：失联已久的老心跳告警，老网站照常检查", round.alerted === 2 && round.checked === 1 && titles.some((t) => t.includes("legacysilent")) && titles.some((t) => t.includes("legacysite01")), titles.join(" | "));
  check("按时报到的、还没接上的老心跳都不响", !titles.some((t) => t.includes("legacyfine01") || t.includes("legacyfresh1")));
  check("状态照常更新", (await getWatch(env, "legacysilent"))?.lastStatus === "down" && (await getWatch(env, "legacysite01"))?.lastStatus === "down");

  const lists = [];
  const spied = { ...env, PIGEON_KV: { ...kv, list: (opts) => (lists.push(opts.prefix), kv.list(opts)) } };
  check("有了标记：按人列监控只翻自己的索引", (await listWatches(spied, "owner0001")).length === 5 && lists.every((p) => p === "wown:owner0001:"), lists.join(" | "));
  check("删一个老监控：配置、状态、索引一起删", (await deleteWatch(env, await getWatch(env, "legacysite01")), leftKeys(kv, "legacysite01").length === 0));
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
