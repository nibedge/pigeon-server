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
  heartbeatOverdue,
  heartbeatStep,
  parseWatchInput,
  PING_PERSIST_MS,
  recordHeartbeat,
  runScheduled,
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
}

// ── 内存 KV + 假 APNs ────────────────────────────────────────────────

function memoryKV() {
  const store = new Map();
  const puts = new Map();
  return {
    store,
    /** 某个键被写过几次 —— 节流省下的正是这个 */
    writesTo: (key) => puts.get(key) ?? 0,
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value) {
      puts.set(key, (puts.get(key) ?? 0) + 1);
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = "" } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true, cacheStatus: null };
    },
  };
}

const { privateKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

/** 截下来的 APNs 请求。心跳不会去抓别的网址，抓了就是 bug */
const sent = [];
/** 放进这里的 token，APNs 回 410（用户删了 App） */
const unregistered = new Set();
globalThis.fetch = async (url, init) => {
  if (!String(url).includes("push.apple.com")) throw new Error(`心跳不该去抓网址：${url}`);
  sent.push({ url: String(url), headers: init.headers, payload: JSON.parse(init.body) });
  const token = String(url).split("/").pop();
  if (unregistered.has(token)) return new Response(JSON.stringify({ reason: "Unregistered" }), { status: 410 });
  return new Response("", { status: 200 });
};

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
  check("第一次报到 → up，不推", w?.lastStatus === "up" && sent.length === 0);
  check("报到时刻写回了 KV", (await getWatch(env, hb.id))?.lastPingAt === t0);

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
  check("★ 又来报到 → 推「恢复上报」，状态回到 up", sent.length === 2 && w?.lastStatus === "up" && back.aps.alert.title?.includes("恢复上报"));
  check("恢复是 resolved + active", back.status === "resolved" && back.aps["interruption-level"] === "active");
  check("★ 失联和恢复用同一个消息 id（App 据此算持续多久）", back.id === down.id && /^hb-/.test(back.id ?? ""), `${down.id} / ${back.id}`);
  check("消息 id 就是 collapse-id：恢复原地替换失联那条", sent[1]?.headers["apns-collapse-id"] === back.id);
  check("★ 消息 id 里看不出监控 id（后者就是报到地址，成员不该拿到）", !back.id.includes(hb.id));

  w = await recordHeartbeat(env, hb.id, { failed: true, message: "磁盘满了，备份中止" }, t0 + 202 * MIN);
  const failed = sent[2]?.payload ?? { aps: { alert: {} } };
  check("★ 报告失败 → 立刻推，正文是任务附的说明", sent.length === 3 && failed.aps.alert.body === "磁盘满了，备份中止");
  check("失败的标题、级别、状态", failed.aps.alert.title?.includes("「夜间备份」报告失败") && failed.aps["interruption-level"] === "time-sensitive" && failed.status === "firing");
  check("失败也用同一个消息 id", failed.id === down.id);
  check("失败之后状态是 down", w?.lastStatus === "down");
  await recordHeartbeat(env, hb.id, { failed: true }, t0 + 203 * MIN);
  check("没附说明也有一句默认的", sent[3]?.payload.aps.alert.body.includes("没有附带说明"));
  await recordHeartbeat(env, hb.id, { failed: false }, t0 + 204 * MIN);
  check("★ 失败之后的第一次正常报到 → 推恢复", sent.length === 5 && sent[4]?.payload.status === "resolved");

  const key = `watch:${hb.id}`;
  const before = kv.writesTo(key);
  await recordHeartbeat(env, hb.id, { failed: false }, t0 + 205 * MIN);
  await recordHeartbeat(env, hb.id, { failed: false }, t0 + 207 * MIN);
  check("★ up 状态下几分钟内连着报到：一次也不写 KV", kv.writesTo(key) === before, `${before} → ${kv.writesTo(key)}`);
  await recordHeartbeat(env, hb.id, { failed: false }, t0 + 208 * MIN);
  check("离上次记下的满 4 分钟才写一次", kv.writesTo(key) === before + 1);
  check("正常报到什么都不推", sent.length === 5);

  check("不存在的 id → null", (await recordHeartbeat(env, "nosuchwatch01", { failed: false })) === null);
  const site = await createWatch(env, "owner0001", parseWatchInput({ kind: "up", channelId: "chan0001", url: "https://nfo.im" }));
  check("★ 网址监控的 id 不能拿来报到", (await recordHeartbeat(env, site.id, { failed: false })) === null && (await getWatch(env, site.id))?.lastPingAt === undefined);
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
  check("失联时发现通道被删了：不推，心跳顺手删掉", round.alerted === 0 && sent.length === 0 && (await getWatch(env, hb.id)) === null);

  const again = makeEnv();
  const hb2 = await createWatch(again.env, "owner0001", parseWatchInput({ kind: "heartbeat", channelId: "chan0001", intervalMinutes: 5 }));
  const chan = JSON.parse(again.kv.store.get("chan:chan0001"));
  again.kv.store.set("chan:chan0001", JSON.stringify({ ...chan, suspended: { at: t0 } }));
  check("通道被停用：报失败不推，报到地址随之作废", (await recordHeartbeat(again.env, hb2.id, { failed: true }, t0)) === null && sent.length === 0 && (await getWatch(again.env, hb2.id)) === null);
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
  const round = await runScheduled(env, t0 + 11 * MIN);
  check("心跳失联时发现通道被停用：不推，心跳删掉", round.alerted === 0 && sent.length === 0 && (await getWatch(env, hb.id)) === null);
  check("通道记录上没有停用字段（没被写回去）", JSON.parse(kv.store.get("chan:chan0001")).suspended === undefined);

  const again = makeEnv();
  const hb2 = await createWatch(again.env, "owner0001", parseWatchInput({ kind: "heartbeat", channelId: "chan0001", intervalMinutes: 5 }));
  again.kv.store.set("susp:chan0001", JSON.stringify({ at: t0 }));
  check("报失败时通道已停用：不推，报到地址作废", (await recordHeartbeat(again.env, hb2.id, { failed: true }, t0)) === null && sent.length === 0);

  const site = makeEnv();
  const w = await createWatch(site.env, "owner0001", parseWatchInput({ kind: "up", channelId: "chan0001", url: "https://nfo.im" }));
  site.kv.store.set("susp:chan0001", "坏掉的值");
  const r = await runScheduled(site.env, t0);
  check("网址监控：通道停用（值坏了也算）就不再去抓，监控删掉", r.checked === 0 && (await getWatch(site.env, w.id)) === null);
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
