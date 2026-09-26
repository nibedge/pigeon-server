/**
 * payload 组装的测试。
 *
 * 这一层出错的方式全是静默的：级别写错位置，系统就按默认处理；铃声不写，
 * 通知就不出声；key 混进 payload，就等于把推送凭据发给了群里每个人。
 * 推送本身照样「成功」，所以只能在这里逐项钉死。
 */
import { generateKeyPairSync } from "node:crypto";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import {
  allowKeyMiss,
  allowPush,
  announceAck,
  APNS_PAYLOAD_LIMIT,
  BATCH_BUDGET,
  batchCost,
  buildPayload,
  cancelRepeat,
  categoryFor,
  collectParams,
  collectRequest,
  decodeHeaderValue,
  deliver,
  headerParams,
  normalizeSwitch,
  paramsFromJson,
  fitPayload,
  ignoredParams,
  interruptionLevel,
  PAYLOAD_BUDGET,
  partitionByMute,
  payloadBytes,
  pushHeaders,
  REPEAT_WINDOW_MS,
  repeatEvery,
  repeatMinutes,
  reportFields,
  runReminders,
  TRUNCATION_MARK,
} from "../.test-build/push.mjs";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `  → ${detail}` : ""}`);
  }
}

console.log("\n★ level → interruption-level");
check("passive", interruptionLevel("passive") === "passive");
check("active", interruptionLevel("active") === "active");
check("timeSensitive → time-sensitive", interruptionLevel("timeSensitive") === "time-sensitive");
check("大小写不敏感", interruptionLevel("TIMESENSITIVE") === "time-sensitive");
check("critical 在拿到 Apple 授权前按 time-sensitive 送", interruptionLevel("critical") === "time-sensitive");
check("乱写 → 不设", interruptionLevel("loud") === undefined);
check("不给 → 不设", interruptionLevel(undefined) === undefined);

console.log("\n★ 级别真的进了 aps（原先整个漏掉）");
const quiet = buildPayload({ title: "t", body: "b", level: "passive" }, "cat");
check("passive 写进 aps.interruption-level", quiet.aps["interruption-level"] === "passive", JSON.stringify(quiet.aps));
check("passive 不带声音", quiet.aps.sound === undefined);
const urgent = buildPayload({ body: "b", level: "timeSensitive" }, "cat");
check("时效性写进 aps", urgent.aps["interruption-level"] === "time-sensitive");

console.log("\n★ 铃声");
check("没指定铃声时用系统默认（原先是静音）", buildPayload({ body: "b" }, "c").aps.sound === "default");
check("sound=none 可以显式静音", buildPayload({ body: "b", sound: "none" }, "c").aps.sound === undefined);
check("指定的铃声原样传", buildPayload({ body: "b", sound: "alarm.caf" }, "c").aps.sound === "alarm.caf");

console.log("\n角标");
check("数字进 aps.badge", buildPayload({ body: "b", badge: "3" }, "c").aps.badge === 3);
check("0 可以清掉角标", buildPayload({ body: "b", badge: "0" }, "c").aps.badge === 0);
check("非数字忽略", buildPayload({ body: "b", badge: "x" }, "c").aps.badge === undefined);
check("负数忽略", buildPayload({ body: "b", badge: "-1" }, "c").aps.badge === undefined);
check("小数忽略", buildPayload({ body: "b", badge: "1.5" }, "c").aps.badge === undefined);

console.log("\n通道身份");
const withOrigin = buildPayload({ body: "b" }, "c", { id: "chanid", name: "生产告警" });
check("带上通道 id 和名称", withOrigin.channel_id === "chanid" && withOrigin.channel_name === "生产告警");
check("没指定 group 时按通道归组", withOrigin.aps["thread-id"] === "chanid");
check(
  "指定了 group 就用 group",
  buildPayload({ body: "b", group: "g" }, "c", { id: "chanid", name: "n" }).aps["thread-id"] === "g",
);
check("★ payload 里没有 key 字段", !JSON.stringify(withOrigin).includes('"key"'));

console.log("\n只有群组的通知带「我来处理」");
check("个人通道 → 基础 category", categoryFor({}, { memberIds: [] }) === "pigeonNotification");
check("群组 → .group", categoryFor({}, { memberIds: ["x"] }) === "pigeonNotification.group");
check("跟随环境变量", categoryFor({ APNS_CATEGORY: "c" }, { memberIds: ["x"] }) === "c.group");

console.log("\nAPNs 请求头");
check("普通推送 alert / 10", pushHeaders({ body: "b" })["apns-push-type"] === "alert" && pushHeaders({})["apns-priority"] === "10");
check("id 作 collapse-id", pushHeaders({ id: "m1" })["apns-collapse-id"] === "m1");
check("★ 超过 64 字节的 id 不作 collapse-id（否则整条被 APNs 拒掉）",
  pushHeaders({ id: "长".repeat(30) })["apns-collapse-id"] === undefined);
check("静默删除 background / 5",
  pushHeaders({ delete: "1" })["apns-push-type"] === "background" && pushHeaders({ delete: "1" })["apns-priority"] === "5");

console.log("\n静默删除");
const del = buildPayload({ id: "m1", delete: "1" }, "c");
check("没有 alert，只有 content-available", del.aps.alert === undefined && del.aps["content-available"] === 1);
check("带着要删的 id", del.id === "m1");

console.log("\n标签与状态");
check("标签去空白后带上", buildPayload({ body: "b", tags: "warning, prod" }, "c").tags === "warning,prod");
check("中文逗号也认", buildPayload({ body: "b", tags: "警告，线上" }, "c").tags === "警告,线上");
check("去重、最多 5 个", buildPayload({ body: "b", tags: "a,b,c,d,e,f,a" }, "c").tags === "a,b,c,d,e");
check("没有标签就不带", !("tags" in buildPayload({ body: "b" }, "c")));
check("status 只认 firing / resolved",
  buildPayload({ body: "b", status: "resolved" }, "c").status === "resolved" &&
  buildPayload({ body: "b", status: "weird" }, "c").status === undefined);

console.log("\n★ 端到端加密的消息");
const enc = buildPayload({ ciphertext: "Y2lwaGVy", iv: "aXZpdml2aXZpdg" }, "c", { id: "chanid", name: "生产告警" });
check("密文和 iv 原样带上", enc.ciphertext === "Y2lwaGVy" && enc.iv === "aXZpdml2aXZpdg");
check("系统先显示占位：通道名 + 加密提示", enc.aps.alert.title === "生产告警" && enc.aps.alert.body.includes("加密"));
check("★ 占位文字里没有密文", !JSON.stringify(enc.aps.alert).includes("Y2lwaGVy"));
check("必须唤起通知扩展去解密", enc.aps["mutable-content"] === 1);
check("发送方另给了明文标题，就用它", buildPayload({ title: "有新消息", ciphertext: "x" }, "c").aps.alert.title === "有新消息");

console.log("\n★ 个人免打扰：降成静默，不丢");
const t0 = 1_800_000_000_000;
const ma = { id: "acctA", prefs: { mutes: { chan1: 0 } }, devices: [] };
const mb = { id: "acctB", devices: [] };
const mc = { id: "acctC", prefs: { mutes: { chan1: t0 - 1 } }, devices: [] };
const split = partitionByMute([ma, mb, mc], "chan1", "active", t0);
check("设了免打扰的人进静默组", split.quiet.map((x) => x.id).join() === "acctA");
check("没设的、已过期的照常", split.loud.map((x) => x.id).join() === "acctB,acctC");
check("★ critical 谁都叫醒", partitionByMute([ma, mb], "chan1", "critical", t0).quiet.length === 0);
check("别的通道不受影响", partitionByMute([ma], "chan2", "active", t0).quiet.length === 0);

console.log("\n★ 正文软别名：text / message / content");
{
  const ch = { id: "chan1", name: "测试", ownerId: "acct1", memberIds: [], defaults: {} };
  const collect = (body) => {
    const req = new Request("https://nfo.im/key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return collectParams(req, new URL(req.url), [], ch);
  };
  check("★ 实测那条请求：text 当正文，标题照旧", await (async () => {
    const p = await collect({ text: "测试信息", title: "Webhook 测试", timestamp: "2026-09-16T23:37:00-06:00", source: "manual-test" });
    return p.body === "测试信息" && p.title === "Webhook 测试";
  })());
  check("content 当正文", (await collect({ content: "c" })).body === "c");
  check("message 当正文", (await collect({ message: "m" })).body === "m");
  check("★ body 写在前，text 不覆盖", (await collect({ body: "b", text: "t" })).body === "b");
  check("★ body 写在后，照样 body 赢", (await collect({ text: "t", body: "b" })).body === "b");
  check("对象形态的 message 不收，免得正文变成 [object Object]", (await collect({ message: { text: "x" } })).body === undefined);
  check("数字也收", (await collect({ text: 42 })).body === "42");
  check("空字符串的别名不算", (await collect({ text: "" })).body === undefined);
}

console.log("\n★ 重复提醒：参数");
{
  check("\"1\" = 每 5 分钟", repeatMinutes("1") === 5);
  check("true / yes 也是开关写法，大小写不论", repeatMinutes("true") === 5 && repeatMinutes("YES") === 5);
  check("给分钟数就按分钟数", repeatMinutes("15") === 15);
  check("太密夹到 5 分钟（cron 5 分钟一轮）", repeatMinutes("2") === 5);
  check("太稀夹到 60 分钟", repeatMinutes("600") === 60);
  check("小数取整", repeatMinutes("7.9") === 7);
  check("缺省 → 不重复", repeatMinutes(undefined) === 0 && repeatMinutes("") === 0);
  check("0 → 不重复", repeatMinutes("0") === 0);
  check("乱写 → 不重复（猜错成要重复，代价是一小时被吵十几次）",
    repeatMinutes("abc") === 0 && repeatMinutes("false") === 0 && repeatMinutes("-5") === 0 && repeatMinutes("0.5") === 0);
  check("★ passive 不重复：它本来就是「别打扰」", repeatEvery({ repeat: "5", level: "passive" }) === 0);
  check("删除不重复", repeatEvery({ repeat: "5", delete: "1", id: "m" }) === 0);
  check("已恢复不重复", repeatEvery({ repeat: "5", status: "resolved" }) === 0);
  check("时效性照常重复", repeatEvery({ repeat: "10", level: "timeSensitive" }) === 10);
  check("没写级别照常重复", repeatEvery({ repeat: "yes" }) === 5);
  const req = new Request("https://nfo.im/key?Repeat=10");
  const params = await collectParams(req, new URL(req.url), [], { id: "c", name: "n", ownerId: "o", memberIds: [], defaults: {} });
  check("可以写在 query 里，大小写不论", params.repeat === "10");
  check("reminder 不是推送参数，发送方冒充不了「第 N 次提醒」",
    buildPayload({ body: "b", reminder: "7" }, "c").reminder === undefined);
}

console.log("\n★ 重复提醒：category 与 payload");
check("★ 个人通道的重复提醒 → .remind（「知道了，别再提醒」）", categoryFor({}, { memberIds: [] }, true) === "pigeonNotification.remind");
check("个人通道不重复 → 基础 category", categoryFor({}, { memberIds: [] }, false) === "pigeonNotification");
check("★ 群组照旧 .group（「我来处理」同样能停下提醒）", categoryFor({}, { memberIds: ["x"] }, true) === "pigeonNotification.group");
check(".remind 也跟随环境变量", categoryFor({ APNS_CATEGORY: "c" }, { memberIds: [] }, true) === "c.remind");
check("repeat 进 payload 顶层", buildPayload({ body: "b", repeat: "5" }, "c").repeat === "5");
check("没有 repeat 就不带", !("repeat" in buildPayload({ body: "b" }, "c")));

// ── 重复提醒的完整来回：内存 KV + 假 APNs ────────────────────────────

const { privateKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

/** 截下来的 APNs 请求；apnsStatus 改成别的值可以模拟投递失败 */
const apns = [];
let apnsStatus = 200;
globalThis.fetch = async (url, init) => {
  apns.push({ url: String(url), headers: init.headers, payload: JSON.parse(init.body) });
  return new Response(apnsStatus === 200 ? "" : JSON.stringify({ reason: "InternalServerError" }), { status: apnsStatus });
};
/** 发给某条消息的全部推送，按先后 */
const pushesOf = (id) => apns.filter((a) => a.payload.id === id);

function memoryKV() {
  const store = new Map();
  const ttl = new Map();
  return {
    store,
    ttl,
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value, opts) {
      store.set(key, value);
      if (opts?.expirationTtl) ttl.set(key, opts.expirationTtl);
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

const me = {
  id: "acct0001", secretHash: "x", channelIds: ["chan0001"], createdAt: 0, updatedAt: 0,
  devices: [{ token: "a".repeat(64), env: "sandbox", name: "iPhone", addedAt: 0 }],
};
const teammate = {
  id: "acct0002", secretHash: "x", channelIds: ["chan0001"], createdAt: 0, updatedAt: 0,
  devices: [{ token: "b".repeat(64), env: "sandbox", name: "同事的 iPhone", addedAt: 0 }],
};

/** 一个干净的环境：个人通道（或群组）+ 接收者，都落在内存 KV 里 */
function makeEnv({ policy, group = false } = {}) {
  const kv = memoryKV();
  const channel = {
    id: "chan0001", key: "key0000000001", name: "我的告警", ownerId: "acct0001",
    memberIds: group ? ["acct0002"] : [], createdAt: 0, count: 0, ...(policy ? { policy } : {}),
  };
  kv.store.set("acct:acct0001", JSON.stringify(me));
  kv.store.set("acct:acct0002", JSON.stringify(teammate));
  kv.store.set("chan:chan0001", JSON.stringify(channel));
  const env = { PIGEON_KV: kv, APNS_KEY_P8: privateKey, APNS_KEY_ID: "ABC1234DEF", APNS_TEAM_ID: "TEAM567890", APNS_TOPIC: "im.nfo.pigeon" };
  const recipients = group ? [me, teammate] : [me];
  const pending = (id) => {
    const raw = kv.store.get(`repeat:chan0001:${id}`);
    return raw === undefined ? null : JSON.parse(raw);
  };
  return { env, kv, channel, recipients, pending };
}

console.log("\n★ 重复提醒：排期与补发");
{
  const { env, kv, channel, recipients, pending } = makeEnv();
  const before = Date.now();
  const report = await deliver(env, channel, recipients, { title: "磁盘满了", body: "剩余 1%", level: "timeSensitive", repeat: "true", id: "disk" });
  const original = pushesOf("disk")[0]?.payload ?? { aps: {} };
  check("原消息送达", report.delivered === 1);
  check("★ 原消息带 repeat=5，不带 reminder", original.repeat === "5" && original.reminder === undefined, JSON.stringify(original));
  check("★ 个人通道的重复消息用 .remind", original.aps.category === "pigeonNotification.remind");
  check("★ 响应报告提醒安排：间隔、截止、消息 id",
    report.repeat?.every === 5 && report.repeat?.id === "disk" && report.repeat.until >= before + REPEAT_WINDOW_MS && report.repeat.until <= Date.now() + REPEAT_WINDOW_MS,
    JSON.stringify(report.repeat));

  const rec = pending("disk");
  check("排上了：第 1 次，5 分钟后补发", rec?.count === 1 && rec.every === 5 && rec.nextAt === rec.until - REPEAT_WINDOW_MS + 5 * 60_000, JSON.stringify(rec));
  check("存的参数里 repeat 已规整成分钟数", rec?.params.repeat === "5" && rec.params.title === "磁盘满了");
  check("KV 自动过期比截止时刻晚", kv.ttl.get("repeat:chan0001:disk") > REPEAT_WINDOW_MS / 1000);

  let round = await runReminders(env, rec.nextAt - 1);
  check("没到点不补发", round.sent === 0 && pushesOf("disk").length === 1);

  round = await runReminders(env, rec.nextAt);
  const second = pushesOf("disk")[1] ?? { payload: { aps: { alert: {} } }, headers: {} };
  check("★ 到点补发一次", round.sent === 1 && pushesOf("disk").length === 2);
  check("★ 补发带 reminder=2、repeat=5", second.payload.reminder === "2" && second.payload.repeat === "5");
  check("★ 沿用原消息 id 作 collapse-id：原地替换上一次，不在通知中心摞一串", second.headers["apns-collapse-id"] === "disk");
  check("内容和原消息一样、仍用 .remind", second.payload.aps.alert.title === "磁盘满了" && second.payload.aps.category === "pigeonNotification.remind");
  const rec2 = pending("disk");
  check("计数推进到 2，下一次再隔 5 分钟", rec2?.count === 2 && rec2.nextAt === rec.nextAt + 5 * 60_000);
  check("补发不计入通道的推送条数", JSON.parse(kv.store.get("chan:chan0001")).count === 1);

  await runReminders(env, rec2.nextAt);
  check("第三次：reminder=3", pushesOf("disk")[2]?.payload.reminder === "3");

  kv.store.set("ack:chan0001:disk", JSON.stringify({ accountId: "acct0001", name: "我", at: Date.now() }));
  round = await runReminders(env, pending("disk").nextAt);
  check("★ 有人认领过了：不再补发，提醒撤掉", round.sent === 0 && round.stopped === 1 && pending("disk") === null && pushesOf("disk").length === 3);
}

console.log("\n★ 重复提醒：什么时候停");
{
  const { env, channel, recipients, pending } = makeEnv();

  await deliver(env, channel, recipients, { body: "b", repeat: "5", id: "acked" });
  check("★ 认领接口撤提醒用的就是它：撤到 → true", (await cancelRepeat(env, "chan0001", "acked")) === true && pending("acked") === null);
  check("没排过的撤不到 → false", (await cancelRepeat(env, "chan0001", "acked")) === false);

  await deliver(env, channel, recipients, { title: "CPU 高", repeat: "5", id: "cpu", status: "firing" });
  check("排上了（前置）", pending("cpu") !== null);
  await deliver(env, channel, recipients, { title: "CPU 恢复", id: "cpu", status: "resolved" });
  const resolved = pushesOf("cpu").at(-1)?.payload ?? { aps: {} };
  check("★ 同 id 推来 resolved：提醒立刻撤掉", pending("cpu") === null);
  check("恢复那条自己不带 repeat，也不用 .remind", resolved.repeat === undefined && resolved.aps.category === "pigeonNotification");

  await deliver(env, channel, recipients, { body: "x", repeat: "5", id: "del" });
  await deliver(env, channel, recipients, { id: "del", delete: "1" });
  check("★ 同 id 推来 delete=1：提醒撤掉", pending("del") === null);

  await deliver(env, channel, recipients, { body: "90%", repeat: "5", id: "upd" });
  await deliver(env, channel, recipients, { body: "95%", id: "upd" });
  check("★ 同 id 的新一版没要求重复：旧提醒作废，不会拿旧内容把新的盖回去", pending("upd") === null);

  await deliver(env, channel, recipients, { body: "90%", repeat: "5", id: "upd2" });
  await deliver(env, channel, recipients, { body: "95%", repeat: "10", id: "upd2" });
  check("同 id 再推一版、仍要求重复：按新的内容和间隔来", pending("upd2")?.params.body === "95%" && pending("upd2")?.every === 10 && pending("upd2")?.count === 1);

  await deliver(env, channel, recipients, { body: "p", repeat: "5", level: "passive", id: "quiet" });
  check("passive 不排提醒", pending("quiet") === null && pushesOf("quiet")[0]?.payload.repeat === undefined);

  const long = "长".repeat(30);
  await deliver(env, channel, recipients, { body: "l", repeat: "5", id: long });
  check("id 超过 64 字节当不了 collapse-id：不排提醒（否则通知中心摞一串）", pending(long) === null && pushesOf(long)[0]?.payload.repeat === undefined);

  apnsStatus = 500;
  const failedReport = await deliver(env, channel, recipients, { body: "f", repeat: "5", id: "failed" });
  apnsStatus = 200;
  check("一台都没送到：不排提醒，响应里也没有", failedReport.delivered === 0 && failedReport.repeat === undefined && pending("failed") === null);
}

console.log("\n★ 重复提醒：一小时为止");
{
  const { env, pending, channel, recipients } = makeEnv();
  await deliver(env, channel, recipients, { body: "一直没人理", repeat: "5", id: "hour" });
  let clock = pending("hour").nextAt;
  // cron 每 5 分钟一轮，一直跑到提醒自己停下
  for (let i = 0; i < 40 && pending("hour"); i++, clock += 5 * 60_000) await runReminders(env, clock);
  const reminders = pushesOf("hour").filter((p) => p.payload.reminder);
  check("★ 每 5 分钟一次、满一小时自动停：补发 12 次", reminders.length === 12 && pending("hour") === null, `补发了 ${reminders.length} 次`);
  check("最后一次是第 13 次提醒（含原消息）", reminders.at(-1)?.payload.reminder === "13");

  await deliver(env, channel, recipients, { body: "每小时提醒一次", repeat: "60", id: "hourly" });
  const hourly = pending("hourly");
  check("间隔 60：第一次补发正好落在截止时刻", hourly?.nextAt === hourly?.until);
  // cron 总是晚到几分钟
  await runReminders(env, hourly.nextAt + 4 * 60_000);
  check("★ 间隔 60 的提醒在截止那一刻照样响一次（cron 晚到几分钟也算）", pushesOf("hourly").at(-1)?.payload.reminder === "2");
  check("那也是最后一次：记录随即删掉", pending("hourly") === null);

  await deliver(env, channel, recipients, { body: "e", repeat: "5", id: "expired" });
  const stale = pending("expired");
  env.PIGEON_KV.store.set("repeat:chan0001:expired", JSON.stringify({ ...stale, count: 12, nextAt: stale.until + 1 }));
  const round = await runReminders(env, stale.until + 1);
  check("★ 这一次已经落在截止之后：不补发，记录撤掉", round.stopped === 1 && pending("expired") === null && pushesOf("expired").length === 1);
}

console.log("\n重复提醒：通道没了、被停用");
{
  const { env, kv, channel, recipients, pending } = makeEnv();
  await deliver(env, channel, recipients, { body: "g", repeat: "5", id: "gone" });
  const at = pending("gone").nextAt;
  kv.store.set("chan:chan0001", JSON.stringify({ ...channel, suspended: { at: 1 } }));
  let round = await runReminders(env, at);
  check("通道被停用：不再补发，提醒撤掉", round.sent === 0 && pending("gone") === null);

  const second = makeEnv();
  await deliver(second.env, second.channel, second.recipients, { body: "g", repeat: "5", id: "gone2" });
  second.kv.store.delete("chan:chan0001");
  round = await runReminders(second.env, second.pending("gone2").nextAt);
  check("通道被删了：不再补发，提醒撤掉", round.sent === 0 && second.pending("gone2") === null);
}

console.log("\n★ 重复提醒与通道策略");
{
  const { env, channel, recipients, pending } = makeEnv({ policy: { dedupeWindow: 3600 } });
  const msg = { title: "重复的告警", body: "一字不差", repeat: "5", id: "dup" };
  await deliver(env, channel, recipients, msg);
  await runReminders(env, pending("dup").nextAt);
  check("★ 通道开了去重：一模一样的补发照样送出（否则只会提醒一次）", pushesOf("dup").length === 2 && pushesOf("dup")[1]?.payload.reminder === "2");
  const again = await deliver(env, channel, recipients, msg);
  check("发送方自己重发一模一样的：照旧被去重压掉，也不重新排期", again.suppressed === true && again.repeat === undefined && pending("dup")?.count === 2);
}

console.log("\n★ 群组里的重复提醒");
{
  const { env, channel, recipients, pending } = makeEnv({ group: true });
  await deliver(env, channel, recipients, { body: "服务挂了", repeat: "5", id: "grp" });
  check("群组的重复消息仍用 .group（「我来处理」）", pushesOf("grp")[0]?.payload.aps.category === "pigeonNotification.group");
  check("两个人都收到", pushesOf("grp").length === 2);
  check("群组同样排上提醒", pending("grp")?.count === 1);
}

console.log("\n★ 认领之后的广播");
{
  const personal = makeEnv();
  await announceAck(personal.env, personal.channel, personal.recipients, "disk", "我", "磁盘满了");
  const mine = apns.at(-1)?.payload ?? { aps: { alert: {} } };
  check("★ 个人通道：「已确认，不再提醒」", mine.aps.alert.title === "已确认，不再提醒" && mine.aps.alert.body === "磁盘满了");
  check("仍带 ack_by，App 据此把原消息标成已处理而不是另存一条", mine.ack_by === "我");
  check("原地替换原通知、静默", apns.at(-1)?.headers["apns-collapse-id"] === "disk" && mine.aps["interruption-level"] === "passive");
  const group = makeEnv({ group: true });
  await announceAck(group.env, group.channel, group.recipients, "grp", "张三", "服务挂了");
  check("群组照旧：「张三 正在处理」", apns.at(-1)?.payload.aps.alert.title === "张三 正在处理");
}


// ── 载荷预算：4KB 放不下时截短，截不动的拒收 ─────────────────────────

/** 字符串里有没有落单的代理项 —— 截在 emoji 中间就会这样 */
const hasLoneSurrogate = (text) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
/** 真正发给 APNs 的字节数（fetch 桩截下来的是 JSON.parse 过的，再序列化回去量） */
const wireBytes = (payload) => Buffer.byteLength(JSON.stringify(payload), "utf8");

console.log("\n★ 载荷预算：fitPayload");
{
  const measure = (p) => payloadBytes(buildPayload(p, "pigeonNotification", { id: "chan0001", name: "我的告警" }));
  const small = { title: "磁盘满了", body: "剩余 3%" };
  const same = fitPayload(small, measure);
  check("放得下就原样不动", same.params === small && same.truncated.length === 0);

  const long = fitPayload({ title: "日志", body: "错".repeat(5000) }, measure);
  check("★ 5000 个汉字的正文截到预算以内", long.bytes <= PAYLOAD_BUDGET && measure(long.params) === long.bytes, String(long.bytes));
  check("截得不多不少：离预算不到一个字（3 字节）", PAYLOAD_BUDGET - long.bytes < 3, String(long.bytes));
  check("★ 末尾标上「…（已截断）」", long.params.body.endsWith(TRUNCATION_MARK));
  check("标题没动", long.params.title === "日志");
  check("报告截了哪个字段", long.truncated.join() === "body");
  check("中文正文大约还剩 1100 字以上", long.params.body.length > 1100, String(long.params.body.length));

  const md = fitPayload({ body: "正文", markdown: "m".repeat(6000) }, measure);
  check("★ 先截 markdown，正文不动", md.truncated.join() === "markdown" && md.params.body === "正文" && md.bytes <= PAYLOAD_BUDGET);

  const both = fitPayload({ title: "t".repeat(3000), subtitle: "s".repeat(3000), body: "b".repeat(3000) }, measure);
  check("★ 一个字段不够就按顺序接着截：正文 → 副标题 → 标题", both.bytes <= PAYLOAD_BUDGET && both.truncated.join() === "body,subtitle", both.truncated.join());
  check("正文截到只剩标记也照样截下一个", both.params.body === TRUNCATION_MARK && both.params.subtitle.endsWith(TRUNCATION_MARK));

  const escaped = fitPayload({ body: "\n\"".repeat(3000) }, measure);
  check("★ JSON 转义多出来的字节也算进去（换行、引号各占 2 字节）", escaped.bytes <= PAYLOAD_BUDGET && measure(escaped.params) <= PAYLOAD_BUDGET, String(escaped.bytes));

  const emoji = fitPayload({ body: "😀".repeat(2000) }, measure);
  check("★ 不会截出半个 emoji", !hasLoneSurrogate(emoji.params.body) && emoji.bytes <= PAYLOAD_BUDGET);

  const shortTitle = fitPayload({ title: "警", url: `https://example.com/${"x".repeat(5000)}` }, measure);
  check("比标记还短的字段不换成标记（换了反而更长）", shortTitle.params.title === "警" && shortTitle.truncated.length === 0);
  check("链接截不动：报告的字节数仍超预算，交给调用方拒收", shortTitle.bytes > PAYLOAD_BUDGET);
}

console.log("\n★ 载荷预算：投递");
{
  const { env, kv, channel, recipients } = makeEnv({ policy: { dedupeWindow: 3600 } });
  const before = Date.now();
  const report = await deliver(env, channel, recipients, { title: "构建日志", body: "错".repeat(5000), id: "log" });
  const sent = pushesOf("log")[0]?.payload ?? { aps: { alert: {} } };
  check("★ 正文 5000 个汉字照样送达", report.delivered === 1, JSON.stringify(report.warnings));
  check("★ 发给 APNs 的 payload 不超过 4096 字节", wireBytes(sent) <= APNS_PAYLOAD_LIMIT, String(wireBytes(sent)));
  check("★ payload 带 truncated=\"1\"，App 据此注明已截断", sent.truncated === "1");
  check("★ 报告 truncated，并用中文说明截了什么", report.truncated === true && report.warnings?.some((w) => w.includes("正文")), JSON.stringify(report.warnings));
  check("通知里的正文带截断标记", sent.aps.alert.body.endsWith(TRUNCATION_MARK));
  check("没截短的消息不带 truncated", (await deliver(env, channel, recipients, { body: "短", id: "short" })).truncated === undefined && pushesOf("short")[0]?.payload.truncated === undefined);
  check("★ 每条 payload 都带 sent_at（毫秒数字）", typeof sent.sent_at === "number" && sent.sent_at >= before && sent.sent_at <= Date.now(), String(sent.sent_at));

  const fields = reportFields(report, ["badge"]);
  check("响应公共字段：id、ignored、warnings、truncated", fields.id === "log" && fields.ignored[0] === "badge" && fields.warnings.length === 1 && fields.truncated === true, JSON.stringify(fields));
  check("没有提示时 warnings 是空数组，不是缺席", JSON.stringify(reportFields({ results: [], delivered: 1, messageId: "m" }).warnings) === "[]");

  // 密文截不动
  const bigCipher = { ciphertext: "A".repeat(5000), iv: "aXZpdml2aXZpdml2", id: "enc" };
  const apnsBefore = apns.length;
  const dedupeKeys = () => [...kv.store.keys()].filter((k) => k.startsWith("dedupe:")).length;
  const dedupeBefore = dedupeKeys();
  const rejected = await deliver(env, channel, recipients, bigCipher);
  check("★ 密文超长：不推，报 413", rejected.delivered === 0 && rejected.rejection?.status === 413 && apns.length === apnsBefore, JSON.stringify(rejected.rejection));
  check("★ 报错写明当前字节数和上限", rejected.rejection?.bytes > PAYLOAD_BUDGET && rejected.rejection?.limit === PAYLOAD_BUDGET &&
    rejected.rejection.message.includes(String(rejected.rejection.bytes)) && rejected.rejection.message.includes(String(PAYLOAD_BUDGET)), rejected.rejection?.message);
  check("说的是「密文没法截短」", rejected.rejection?.message.includes("密文"));
  check("★ 被拒的内容不占去重窗口（通道开着去重）", dedupeKeys() === dedupeBefore && (await deliver(env, channel, recipients, bigCipher)).rejection?.status === 413);
  const smallCipher = await deliver(env, channel, recipients, { ciphertext: "A".repeat(2000), iv: "aXZpdml2aXZpdml2", id: "enc2" });
  check("放得下的密文照常推", smallCipher.delivered === 1 && pushesOf("enc2")[0]?.payload.ciphertext.length === 2000);
  check("密文从不被截", !pushesOf("enc2")[0]?.payload.truncated);

  // 免打扰那一版也要放得下
  const mutedMe = { ...me, prefs: { mutes: { chan0001: 0 } } };
  const both = makeEnv({ group: true });
  await deliver(both.env, both.channel, [mutedMe, teammate], { title: "t", body: "错".repeat(5000), id: "mutedlong" });
  const variants = pushesOf("mutedlong");
  check("★ 静默版和原样版都不超 4096 字节", variants.length === 2 && variants.every((v) => wireBytes(v.payload) <= APNS_PAYLOAD_LIMIT),
    variants.map((v) => wireBytes(v.payload)).join(","));
  check("两版截到同样的内容", variants[0]?.payload.aps.alert.body === variants[1]?.payload.aps.alert.body);
}

console.log("\n★ 重复提醒：截短之后才存，沿用发出时刻");
{
  const { env, channel, recipients, pending } = makeEnv();
  const report = await deliver(env, channel, recipients, { title: "一直报错", body: "错".repeat(5000), repeat: "5", id: "longrep" });
  const original = pushesOf("longrep")[0]?.payload ?? {};
  const rec = pending("longrep");
  check("排上了提醒", report.repeat?.id === "longrep" && rec !== null);
  check("★ 存的是截短之后的正文（和原消息一模一样）", rec?.params.body === original.aps?.alert?.body && rec?.params.body.endsWith(TRUNCATION_MARK));
  check("★ 记录带原消息的 sent_at 和截断标记", rec?.sentAt === original.sent_at && rec?.truncated === true, JSON.stringify({ sentAt: rec?.sentAt, truncated: rec?.truncated }));
  await runReminders(env, rec.nextAt);
  const second = pushesOf("longrep")[1]?.payload ?? {};
  check("★ 补发沿用原消息的 sent_at", second.reminder === "2" && second.sent_at === original.sent_at, `${second.sent_at} vs ${original.sent_at}`);
  check("★ 补发照样标 truncated（存下来的内容量不出截没截过）", second.truncated === "1");
  check("补发同样不超 4096 字节", wireBytes(second) <= APNS_PAYLOAD_LIMIT);

  // 旧记录没有 sentAt：按截止时刻倒推回原消息那一刻
  await deliver(env, channel, recipients, { body: "旧记录", repeat: "5", id: "legacy" });
  const legacy = pending("legacy");
  const { sentAt: _drop, ...oldShape } = legacy;
  env.PIGEON_KV.store.set("repeat:chan0001:legacy", JSON.stringify(oldShape));
  await runReminders(env, legacy.nextAt);
  const legacyReminder = pushesOf("legacy").at(-1)?.payload ?? {};
  check("★ 旧记录没存发出时刻：用记录创建的时刻（截止 − 一小时）", legacyReminder.reminder === "2" && legacyReminder.sent_at === legacy.until - REPEAT_WINDOW_MS,
    `${legacyReminder.sent_at} vs ${legacy.until - REPEAT_WINDOW_MS}`);
  check("旧记录补发不标 truncated", legacyReminder.truncated === undefined);
}

console.log("\n★ id 太长：响应里说清楚");
{
  const { env, channel, recipients } = makeEnv();
  const longId = "长".repeat(30);
  const withRepeat = await deliver(env, channel, recipients, { body: "l", repeat: "5", id: longId });
  check("★ 要求了重复提醒：警告「重复提醒未启用」", withRepeat.warnings?.some((w) => w.includes("64 字节") && w.includes("重复提醒未启用")), JSON.stringify(withRepeat.warnings));
  const plain = await deliver(env, channel, recipients, { body: "l", id: `${longId}x` });
  check("没要求重复：只提醒不会原地替换", plain.warnings?.length === 1 && !plain.warnings[0].includes("重复提醒") && plain.warnings[0].includes("替换"), JSON.stringify(plain.warnings));
  const fine = await deliver(env, channel, recipients, { body: "l", id: "ok-id" });
  check("正常的 id 没有警告", fine.warnings?.length === 0);
  const generated = await deliver(env, channel, recipients, { body: "没给 id" });
  check("没给 id 时回报服务端生成的 id", typeof generated.messageId === "string" && generated.messageId.length > 0 && reportFields(generated).id === generated.messageId);
}

console.log("\n★ 认领广播也带自己的 sent_at");
{
  const { env, channel, recipients } = makeEnv();
  const before = Date.now();
  await announceAck(env, channel, recipients, "m-ack", "我", "磁盘满了");
  const ack = apns.at(-1)?.payload ?? {};
  check("带 sent_at，是认领那一刻", typeof ack.sent_at === "number" && ack.sent_at >= before && ack.sent_at <= Date.now());
}

console.log("\n★ 不生效的参数");
{
  check("列出认得但不生效的参数", ignoredParams({ body: "b", badge: "3", call: "1", volume: "5", ttl: "60", action: "none" }).join() === "badge,call,volume,ttl,action");
  check("生效的参数不列", ignoredParams({ body: "b", level: "active", sound: "x", url: "https://a" }).length === 0);
  check("和通道默认值一样的不算这次请求带的", ignoredParams({ body: "b", call: "1" }, { call: "1" }).length === 0);
  check("覆盖了默认值的照样列出", ignoredParams({ body: "b", call: "0" }, { call: "1" }).join() === "call");
}

console.log("\n★ 请求体上限");
{
  const ch = { id: "chan1", name: "测试", ownerId: "acct1", memberIds: [], defaults: {} };
  const collect = (init) => {
    const req = new Request("https://nfo.im/key", { method: "POST", ...init });
    return collectParams(req, new URL(req.url), [], ch);
  };
  const tooBig = async (init) => {
    try {
      await collect(init);
      return false;
    } catch (err) {
      return err?.name === "BodyTooLarge" && err.message.includes("内容太长");
    }
  };
  const big = JSON.stringify({ body: "x".repeat(80 * 1024) });
  check("★ 80KB 的请求体 → BodyTooLarge（入口回 413）", await tooBig({ headers: { "content-type": "application/json" }, body: big }));
  // 没有 Content-Length 的分块上传：边读边数
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < 20; i++) controller.enqueue(new TextEncoder().encode("y".repeat(8 * 1024)));
      controller.close();
    },
  });
  check("★ 没有 Content-Length 的流式请求体，读过 64KB 也停下", await tooBig({ body: stream, duplex: "half", headers: { "content-type": "text/plain" } }));
  const ok64 = await collect({ headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "z".repeat(60 * 1024) }) });
  check("64KB 以内照常解析", ok64.body?.length === 60 * 1024);
  const form = await collect({ headers: { "content-type": "application/x-www-form-urlencoded" }, body: "title=%E6%A0%87%E9%A2%98&body=a+b" });
  check("表单照常解析（+ 是空格）", form.title === "标题" && form.body === "a b", JSON.stringify(form));
  const fd = new FormData();
  fd.set("title", "多部分");
  fd.set("body", "正文");
  const multi = await collect({ body: fd });
  check("multipart 表单照常解析", multi.title === "多部分" && multi.body === "正文", JSON.stringify(multi));
}

// ── 推送入口：一行 curl 就能推，不再静默丢内容 ─────────────────────────

/** 发一个请求给 collectRequest。init 里可以给 method、headers、body；query 写在 path 里 */
const collectFrom = (path, init = {}, pathText = [], channel = { defaults: {} }) => {
  const req = new Request(`https://nfo.im/key${path}`, { method: "POST", ...init });
  return collectRequest(req, new URL(req.url), pathText, channel);
};
const jsonBody = (body) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const formBody = (body) => ({ headers: { "content-type": "application/x-www-form-urlencoded" }, body });
/** curl 把 UTF-8 原样塞进请求头；到服务端每个字节成了一个 Latin-1 字符 */
const asHeader = (text) => Buffer.from(text, "utf8").toString("latin1");

console.log("\n★ 正文别名补全：desp / msg / description，summary 当副标题");
{
  const p = async (body) => (await collectFrom("", jsonBody(body))).params;
  check("★ {title, msg}（常见面板的默认写法）：msg 当正文，正文完整", await (async () => {
    const r = await p({ title: "磁盘告警", msg: "剩余 3%" });
    return r.title === "磁盘告警" && r.body === "剩余 3%";
  })());
  check("desp 当正文", (await p({ title: "t", desp: "d" })).body === "d");
  check("description 当正文", (await p({ description: "d" })).body === "d");
  check("★ summary 当副标题", (await p({ body: "b", summary: "s" })).subtitle === "s");
  check("已有 subtitle 时 summary 不覆盖", (await p({ subtitle: "正式", summary: "别名" })).subtitle === "正式");
  check("几个别名同时出现：取先写的", (await p({ msg: "先", text: "后" })).body === "先");
  check("表单里的别名一样认", (await collectFrom("", formBody("title=t&desp=%E6%AD%A3%E6%96%87"))).params.body === "正文");
  check("query 里的别名一样认", (await collectFrom("?msg=q", { method: "GET" })).params.body === "q");
  check("★ 请求体里的别名压过 query 里的 body（请求体优先）", (await collectFrom("?body=旧", jsonBody({ text: "新" }))).params.body === "新");
}

console.log("\n★ 开关参数：true / false 统一成 1 / 0");
{
  const p = async (body) => (await collectFrom("", jsonBody(body))).params;
  check("★ isArchive: false → \"0\"（App 看的是「不等于 0」，原先照样存进历史）", (await p({ body: "b", isArchive: false })).isArchive === "0");
  check("★ autoCopy: true → \"1\"（App 看的是「等于 1」，原先不生效）", (await p({ body: "b", autoCopy: true })).autoCopy === "1");
  check("小写别名、yes 也认", (await collectFrom("?autocopy=yes&isarchive=NO", { method: "GET" })).params.autoCopy === "1");
  check("off → 0、on → 1", normalizeSwitch("off") === "0" && normalizeSwitch("On") === "1");
  check("delete: true → \"1\"", (await p({ id: "m", delete: true })).delete === "1");
  check("认不出的值原样留着，不瞎猜", normalizeSwitch("maybe") === "maybe");
  check("repeat 不是开关，分钟数原样", (await p({ body: "b", repeat: "10" })).repeat === "10");
  check("数字照收", (await p({ body: "b", badge: 3 })).badge === "3");
  check("★ 对象值不收，免得变成 [object Object]", (await p({ body: "b", url: { href: "x" } })).url === undefined);
}

console.log("\n★ 请求体原文当正文");
{
  const r1 = await collectFrom("", { headers: { "content-type": "text/plain" }, body: "磁盘满了\n" });
  check("★ text/plain：原文就是正文（去掉末尾换行）", r1.params.body === "磁盘满了" && r1.warnings.length === 0, JSON.stringify(r1));
  const r2 = await collectFrom("", { body: new TextEncoder().encode("没写类型") });
  check("没写 Content-Type：原文当正文", r2.params.body === "没写类型", JSON.stringify(r2));
  const r3 = await collectFrom("", formBody("磁盘满了"));
  check("★ curl -d \"磁盘满了\"（按表单发出、整句成了没有值的字段名）→ 正文", r3.params.body === "磁盘满了" && r3.warnings.length === 0, JSON.stringify(r3));
  check("没编码的原文取原样：+ 不变成空格", (await collectFrom("", formBody("1+1 等于 2"))).params.body === "1+1 等于 2");
  check("百分号编码的（--data-urlencode）解码", (await collectFrom("", formBody("CPU%20%E5%88%B0%E4%BA%86%2095%25"))).params.body === "CPU 到了 95%");
  check("★ 带 & 的一句话也整句收下", (await collectFrom("", formBody("磁盘满了&内存也满了"))).params.body === "磁盘满了&内存也满了");
  const r4 = await collectFrom("", formBody("title=t&foo=bar"));
  check("真正的表单照常按字段解析，不当原文", r4.params.title === "t" && r4.params.body === undefined);
  const r5 = await collectFrom("", jsonBody("JSON 字符串"));
  check("JSON 字符串当正文", r5.params.body === "JSON 字符串");
  const r6 = await collectFrom("", { headers: { "content-type": "application/json" }, body: "声称是 JSON 的一句话" });
  check("声称是 JSON、其实是一句话：当正文", r6.params.body === "声称是 JSON 的一句话" && r6.warnings.length === 0);
  const r7 = await collectFrom("", { headers: { "content-type": "application/json" }, body: '{"title": "写坏了' });
  check("★ 写坏的 JSON 不当正文推出去，给提示", r7.params.body === undefined && r7.warnings.some((w) => w.includes("不是合法的 JSON")), JSON.stringify(r7));
  const r8 = await collectFrom("", { headers: { "content-type": "text/plain;charset=UTF-8" }, body: JSON.stringify({ title: "t", body: "b" }) });
  check("★ fetch() 直接传 JSON 字符串（类型是 text/plain）：照样按字段解析", r8.params.title === "t" && r8.params.body === "b", JSON.stringify(r8));
  const r9 = await collectFrom("", jsonBody({ foo: "bar", data: { text: "嵌套的" } }));
  check("★ 请求体不为空却一个字段都没认出来 → 提示", r9.params.body === undefined && r9.warnings.some((w) => w.includes("没有认得的字段")), JSON.stringify(r9));
  const r10 = await collectFrom("", { headers: { "content-type": "application/xml" }, body: "<alert/>" });
  check("认不得的类型（xml）同样提示", r10.warnings.length === 1);
  check("空请求体不提示", (await collectFrom("", { headers: { "content-type": "application/json" }, body: "" })).warnings.length === 0);
  check("只带 level 之类的参数不提示（认出来了，只是不是正文）", (await collectFrom("", jsonBody({ level: "passive" }))).warnings.length === 0);
  const r11 = await collectFrom("?title=查询里的", { headers: { "content-type": "text/plain" }, body: "请求体里的" }, ["路径里的"]);
  check("★ 路径段仍然优先：/{key}/正文 压过请求体原文；query 的标题照留", r11.params.body === "路径里的" && r11.params.title === "查询里的");
  const fd = new FormData();
  fd.set("title", "多部分");
  fd.set("url", new Blob(["x"]), "a.txt");
  fd.set("msg", "正文");
  const r12 = await collectFrom("", { body: fd });
  check("multipart：别名照认，文件不当参数值", r12.params.title === "多部分" && r12.params.body === "正文" && r12.params.url === undefined, JSON.stringify(r12.params));
}

console.log("\n★ 通用请求头：Title、Priority、Tags、Click、Id");
{
  const h = (headers) => headerParams(new Headers(headers));
  check("★ 中文标题（curl 原样发的 UTF-8）还原成中文", h({ Title: asHeader("磁盘告警") }).title === "磁盘告警");
  check("=?UTF-8?B?…?= 也认", decodeHeaderValue(`=?UTF-8?B?${Buffer.from("磁盘告警").toString("base64")}?=`) === "磁盘告警");
  check("=?utf-8?Q?…?= 也认", decodeHeaderValue("=?utf-8?Q?=E7=A3=81=E7=9B=98_A?=") === "磁盘 A");
  check("纯 ASCII 原样", decodeHeaderValue("Disk full") === "Disk full");
  check("还原不了的原样返回", decodeHeaderValue("café") === "café");
  check("Priority 5 / max / urgent → timeSensitive（不到 critical）", h({ Priority: "5" }).level === "timeSensitive" && h({ Priority: "urgent" }).level === "timeSensitive");
  check("Priority 4 / high → timeSensitive", h({ Priority: "high" }).level === "timeSensitive");
  check("Priority 3 → active；1、2 → passive", h({ Priority: "3" }).level === "active" && h({ Priority: "1" }).level === "passive" && h({ Priority: "low" }).level === "passive");
  check("Priority 直接写级别名也行", h({ Priority: "timeSensitive" }).level === "timeSensitive");
  check("★ 浏览器按 HTTP 规范自带的 Priority: u=1, i 不当级别", h({ Priority: "u=1, i" }).level === undefined);
  const all = h({ Tags: "warning,prod", Click: "https://example.com/x", Id: "disk-1" });
  check("Tags → tags、Click → url、Id → id", all.tags === "warning,prod" && all.url === "https://example.com/x" && all.id === "disk-1", JSON.stringify(all));
  const r = await collectFrom("", { headers: { Title: asHeader("备份失败"), Priority: "4", "content-type": "text/plain" }, body: "磁盘满了" });
  check("★ curl -H \"Title: …\" -d \"正文\"：标题来自头、正文来自请求体", r.params.title === "备份失败" && r.params.body === "磁盘满了" && r.params.level === "timeSensitive", JSON.stringify(r.params));
  const r2 = await collectFrom("", { headers: { Title: "from-header", "content-type": "application/json" }, body: JSON.stringify({ title: "from-body" }) });
  check("请求体里的字段压过请求头", r2.params.title === "from-body");
}

console.log("\n★ 只给 markdown：当正文");
{
  const lone = await collectFrom("", jsonBody({ markdown: "**磁盘满了**" }));
  check("★ 只给 markdown：它就是正文（原先被当成没有内容拒掉）", lone.params.body === "**磁盘满了**" && lone.params.markdown === undefined);
  check("这时 ignored 不列 markdown", !ignoredParams(lone.own).includes("markdown"));
  const both = await collectFrom("", jsonBody({ body: "正文", markdown: "**另一份**" }));
  check("和 body 一起给：body 为准，markdown 列进 ignored（App 不显示它）", both.params.body === "正文" && ignoredParams(both.own).includes("markdown"));
  check("/push 的 JSON 同样", paramsFromJson({ device_key: "k", markdown: "m" }).body === "m");
}

console.log("\n★ 这次请求自己带的（own），和通道默认值分开");
{
  const ch = { defaults: { title: "默认标题", level: "passive", call: "1" } };
  const r = await collectFrom("", jsonBody({ body: "正文" }), [], ch);
  check("推送用的参数合上了默认值", r.params.title === "默认标题" && r.params.level === "passive" && r.params.body === "正文");
  check("★ own 里只有这次请求带来的", r.own.title === undefined && r.own.body === "正文");
  check("默认值里的不生效参数不算这次请求带的", !ignoredParams(r.own).includes("call"));
  const md = await collectFrom("", jsonBody({ markdown: "m" }), [], { defaults: { body: "默认正文" } });
  check("只给 markdown 时，它压过默认正文", md.params.body === "m");
}

console.log("\n★ /push 的参数解析和路径式同一套");
{
  const p = paramsFromJson({ device_key: "k", device_keys: ["a"], title: { x: 1 }, text: "正文", autocopy: true, tags: ["warning", "prod"], extra: 1 });
  check("★ text 当正文（原先 /push 不认别名，推出一条 Empty Message）", p.body === "正文");
  check("小写 autocopy 规整成 autoCopy，true → 1", p.autoCopy === "1");
  check("tags 可以写成数组", p.tags === "warning,prod");
  check("对象值不收；device_key 不是推送参数", p.title === undefined && !("device_key" in p) && !("device_keys" in p) && !("extra" in p), JSON.stringify(p));
}

console.log("\n★ 限流提醒：只给创建者，每小时一次");
{
  const { env, kv, channel } = makeEnv({ group: true });
  const asked = [];
  const deny = { ...env, RL_PUSH: { limit: async ({ key }) => (asked.push(key), { success: false }) } };
  const before = apns.length;
  check("超限 → 不放行", !(await allowPush(deny, channel, [me, teammate])));
  check("★ 按通道 id 计（push:{id}），不按 key —— 换 key 额度不清零", asked[0] === "push:chan0001");
  const notices = apns.slice(before);
  check("★ 只提醒创建者，群成员不打扰", notices.length === 1 && notices[0].url.endsWith(me.devices[0].token), JSON.stringify(notices.map((n) => n.url)));
  check("提醒说清楚是哪个通道、怎么办", notices[0]?.payload.aps.alert.title.includes("推送太频繁") && notices[0]?.payload.aps.alert.body.includes("我的告警"));
  check("提醒归在这个通道下，带 sent_at", notices[0]?.payload.channel_id === "chan0001" && typeof notices[0]?.payload.sent_at === "number");
  check("标记一小时后自动过期", kv.ttl.get("rlnote:chan0001") === 3600);
  await allowPush(deny, channel, [me, teammate]);
  check("★ 一小时内再超限不再提醒", apns.length === before + 1);
  check("没超限 → 放行、不提醒", (await allowPush({ ...env, RL_PUSH: { limit: async () => ({ success: true }) } }, channel, [me])) && apns.length === before + 1);
  check("限流服务自己出错 → 放行", await allowPush({ ...env, RL_PUSH: { limit: async () => { throw new Error("down"); } } }, channel, [me]));
  check("没配限流绑定（本地、自建）→ 放行", await allowPush(env, channel, [me]));

  const quiet = makeEnv();
  const mutedMe = { ...me, prefs: { mutes: { chan0001: 0 } } };
  await allowPush({ ...quiet.env, RL_PUSH: { limit: async () => ({ success: false }) } }, quiet.channel, [mutedMe]);
  check("创建者给这个通道开了免打扰：提醒静默送达", apns.at(-1)?.payload.aps["interruption-level"] === "passive" && apns.at(-1)?.payload.aps.sound === undefined);
}

console.log("\n★ 查不存在的 key：按来源 IP 计数");
{
  const asked = [];
  const env = { RL_IP: { limit: async ({ key }) => (asked.push(key), { success: false }) } };
  const withIp = new Request("https://nfo.im/x", { headers: { "cf-connecting-ip": "203.0.113.5" } });
  check("超了 → 不放行", !(await allowKeyMiss(env, withIp)));
  check("★ 键是 nokey:{ip}", asked[0] === "nokey:203.0.113.5");
  check("没有来源 IP（本地开发）不计", (await allowKeyMiss(env, new Request("https://nfo.im/x"))) && asked.length === 1);
}

// ── 入口：整个 Worker 的 fetch，打包 src/index.ts ────────────────────

await build({
  entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
  bundle: true,
  format: "esm",
  outfile: fileURLToPath(new URL("../.test-build/entry.mjs", import.meta.url)),
  logLevel: "error",
});
const { default: worker } = await import("../.test-build/entry.mjs");

/** 一台设备的 token：由账号 id 补足 64 位，一眼看得出是谁的 */
const tokenOf = (accountId) => accountId.padEnd(64, "0");

/** 入口测试的环境：几个通道（各带 key 指针）和它们的创建者、成员，都在内存 KV 里 */
function entryEnv(specs = [{}]) {
  const kv = memoryKV();
  const account = (id, channelId, extra = {}) => {
    const acct = { id, secretHash: "x", channelIds: [channelId], createdAt: 0, updatedAt: 0, devices: [{ token: tokenOf(id), env: "sandbox", name: id, addedAt: 0 }], ...extra };
    kv.store.set(`acct:${id}`, JSON.stringify(acct));
    return acct;
  };
  const channels = specs.map((spec, i) => {
    const n = String(i).padStart(4, "0");
    const id = `chan${n}xx`;
    const owner = account(`owner${n}`, id, spec.owner);
    const memberIds = Array.from({ length: spec.members ?? 0 }, (_, j) => account(`m${n}x${String(j).padStart(3, "0")}`, id).id);
    const channel = {
      id, key: `key${n}xxxxxx`, name: spec.name ?? `通道${i}`, ownerId: owner.id, memberIds, createdAt: 0, count: 0,
      ...(spec.policy ? { policy: spec.policy } : {}),
      ...(spec.defaults ? { defaults: spec.defaults } : {}),
    };
    kv.store.set(`ch:${channel.key}`, JSON.stringify({ id }));
    kv.store.set(`chan:${id}`, JSON.stringify(channel));
    return channel;
  });
  const env = { PIGEON_KV: kv, APNS_KEY_P8: privateKey, APNS_KEY_ID: "ABC1234DEF", APNS_TEAM_ID: "TEAM567890", APNS_TOPIC: "im.nfo.pigeon" };
  return { env, kv, channels };
}

const hit = (env, path, init = {}) => worker.fetch(new Request(`https://nfo.im${path}`, init), env);
/** 响应读成 { status, json, headers } */
const read = async (pending) => {
  const res = await pending;
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // 不是 JSON（落地页）交给断言
  }
  return { status: res.status, json, headers: res.headers, text };
};
const post = (body, headers = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const lastAlert = () => apns.at(-1)?.payload.aps.alert ?? {};

console.log("\n★ 入口：根路径、Bearer、.send、一行 curl");
{
  const { env, channels: [ch] } = entryEnv();
  const root = await read(hit(env, "/", { method: "POST", body: "磁盘满了" }));
  check("★ POST 到根路径 → 400，说清楚少了 key、该是什么样", root.status === 400 && root.json?.message === "地址少了 key，应为 https://nfo.im/{key}", root.text);
  check("GET 根路径照旧是落地页", (await read(hit(env, "/"))).headers.get("content-type").includes("text/html"));
  const bearer = await read(hit(env, "/", { method: "POST", headers: { authorization: `Bearer ${ch.key}`, "content-type": "text/plain" }, body: "来自 Bearer" }));
  check("★ Authorization: Bearer {key} 推到根路径", bearer.status === 200 && lastAlert().body === "来自 Bearer", bearer.text);
  const send = await read(hit(env, `/${ch.key}.send?title=${encodeURIComponent("标题")}&desp=${encodeURIComponent("正文")}`));
  check("★ /{key}.send?title=…&desp=… 照样推", send.status === 200 && lastAlert().title === "标题" && lastAlert().body === "正文", send.text);
  check(".send 跟在正文后面也去掉", (await hit(env, `/${ch.key}/${encodeURIComponent("正文二")}.send`)).status === 200 && lastAlert().body === "正文二");
  const curl = await read(hit(env, `/${ch.key}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "磁盘满了" }));
  check("★ curl -d \"磁盘满了\" nfo.im/KEY 能送达", curl.status === 200 && lastAlert().body === "磁盘满了", curl.text);
  const titled = await read(hit(env, `/${ch.key}`, { method: "POST", headers: { Title: asHeader("备份失败"), Priority: "5", "content-type": "text/plain" }, body: "磁盘满了" }));
  check("★ 请求头 Title / Priority 生效", titled.status === 200 && lastAlert().title === "备份失败" && apns.at(-1)?.payload.aps["interruption-level"] === "time-sensitive", titled.text);
}

console.log("\n★ 链接预览、预取、HEAD：不推");
{
  const { env, channels: [ch] } = entryEnv();
  const before = apns.length;
  const head = await hit(env, `/${ch.key}/${encodeURIComponent("预览")}`, { method: "HEAD" });
  check("★ HEAD → 200，不推", head.status === 200 && apns.length === before);
  const prefetch = await read(hit(env, `/${ch.key}/x`, { headers: { "sec-purpose": "prefetch;prerender" } }));
  check("★ Sec-Purpose: prefetch → 200 {ok, skipped: preview}，不推", prefetch.status === 200 && prefetch.json?.ok === true && prefetch.json?.skipped === "preview" && apns.length === before, prefetch.text);
  check("Purpose: prefetch（旧写法）同样", (await read(hit(env, `/${ch.key}/x`, { headers: { purpose: "prefetch" } }))).json?.skipped === "preview");
  check("★ 链接预览爬虫（UA 带 bot）→ 不推", (await read(hit(env, `/${ch.key}/x`, { headers: { "user-agent": "Mozilla/5.0 (compatible; ExampleLinkBot/2.1)" } }))).json?.skipped === "preview" && apns.length === before);
  check("UA 带 crawler / spider / preview 同样", (await read(hit(env, `/${ch.key}/x`, { headers: { "user-agent": "example-crawler/1.0" } }))).json?.skipped === "preview" && (await read(hit(env, `/${ch.key}/x`, { headers: { "user-agent": "SomeUriPreview/0.5" } }))).json?.skipped === "preview");
  const named = Buffer.from("TWljcm9NZXNzZW5nZXI=", "base64").toString();
  check("★ UA 里只有自家 App 名字的预览（名单见 preview.ts）→ 不推", (await read(hit(env, `/${ch.key}/x`, { headers: { "user-agent": `Mozilla/5.0 (iPhone) Mobile ${named}/8.0.50` } }))).json?.skipped === "preview" && apns.length === before);
  check("没有 key 的 HEAD 也是 200：不透露 key 存不存在", (await hit(env, "/nosuchkey0000/x", { method: "HEAD" })).status === 200);
  check("★ 网站监控服务的 UA（…Robot/2.0）不误伤，照推", (await hit(env, `/${ch.key}/x`, { headers: { "user-agent": "Mozilla/5.0+(compatible; ExampleRobot/2.0)" } })).status === 200 && apns.length === before + 1);
  check("★ POST 就算 UA 带 bot 也照推：预览从不 POST", (await hit(env, `/${ch.key}`, { method: "POST", headers: { "user-agent": "MyAlertBot/1.0", "content-type": "text/plain" }, body: "告警" })).status === 200 && apns.length === before + 2);
  check("普通浏览器的 GET 照推", (await hit(env, `/${ch.key}/x`, { headers: { "user-agent": "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Safari/605.1.15" } })).status === 200 && apns.length === before + 3);
  check("型号里带全大写 BOT 的手机浏览器不当爬虫", (await hit(env, `/${ch.key}/x`, { headers: { "user-agent": "Mozilla/5.0 (Linux; Android 10; ABCBOT X30) Mobile Safari/537.36" } })).status === 200 && apns.length === before + 4);
  check("小写的 …robot 同样不误伤", (await hit(env, `/${ch.key}/x`, { headers: { "user-agent": "examplerobot/1.0" } })).status === 200 && apns.length === before + 5);
}

console.log("\n★ 限流：429 + Retry-After，各入口共用一份额度");
{
  const { env, kv, channels: [ch] } = entryEnv([{ members: 2, name: "生产告警" }]);
  const asked = [];
  env.RL_PUSH = { limit: async ({ key }) => (asked.push(key), { success: false }) };
  const before = apns.length;
  const res = await read(hit(env, `/${ch.key}/${encodeURIComponent("太快了")}`));
  check("★ 超限 → 429", res.status === 429, res.text);
  check("★ 头 Retry-After: 60，body 带中文 error 和 retry_after", res.headers.get("retry-after") === "60" && res.json?.retry_after === 60 && res.json?.error.includes("推送太频繁") && res.json?.message === res.json?.error, res.text);
  check("说清楚是哪个通道、每分钟多少条", res.json?.error.includes("生产告警") && res.json?.error.includes("60"));
  check("按通道 id 计", asked.at(-1) === `push:${ch.id}`);
  const notices = apns.slice(before);
  check("★ 给创建者推了一条提醒（群成员不打扰），不带被拒消息的内容", notices.length === 1 && notices[0].url.endsWith(tokenOf(ch.ownerId)) && !JSON.stringify(notices[0].payload).includes("太快了"));
  await hit(env, `/${ch.key}/again`);
  check("一小时内不再提醒", apns.length === before + 1 && kv.store.has(`rlnote:${ch.id}`));
  const hook = await read(hit(env, `/hook/${ch.key}/uptimekuma`, post({ heartbeat: { status: 0, msg: "timeout" }, monitor: { name: "官网" } })));
  check("★ /hook 同一份额度 → 429", hook.status === 429 && hook.headers.get("retry-after") === "60", hook.text);
  const batch = await read(hit(env, "/push", post({ device_key: ch.key, body: "批量" })));
  check("★ /push 全被限流 → 429（不是 400）", batch.status === 429 && batch.headers.get("retry-after") === "60" && batch.json?.error.includes("推送太频繁"), batch.text);
  check("被限流的一条都没推", apns.length === before + 1);
  env.RL_PUSH = { limit: async () => ({ success: true }) };
  check("没超限照常推", (await hit(env, `/${ch.key}/ok`)).status === 200);
}

console.log("\n★ 查不存在的 key：超了按 IP 限流");
{
  const { env, channels: [ch] } = entryEnv();
  const asked = [];
  env.RL_IP = { limit: async ({ key }) => (asked.push(key), { success: asked.length <= 1 }) };
  const ip = { "cf-connecting-ip": "203.0.113.5" };
  check("第一次 → 404", (await hit(env, "/nosuchkey0000/x", { headers: ip })).status === 404);
  const second = await read(hit(env, "/nosuchkey0001/x", { headers: ip }));
  check("★ 超了 → 429 + Retry-After", second.status === 429 && second.headers.get("retry-after") === "60" && second.json?.error.includes("不存在的 key"), second.text);
  const n = asked.length;
  check("★ 存在的 key 不受它影响，也不计数", (await hit(env, `/${ch.key}/x`, { headers: ip })).status === 200 && asked.length === n);
  check("/hook 查不到 key 同样计", (await hit(env, "/hook/nosuchkey0002/github", { ...post({ zen: "x" }), headers: { ...ip, "content-type": "application/json" } })).status === 429);
  const batch = await read(hit(env, "/push", { ...post({ device_keys: ["nosuchkey0003", ch.key], body: "b" }), headers: { ...ip, "content-type": "application/json" } }));
  check("/push 里查不到的 key 同样计；存在的照推", batch.status === 200 && batch.json?.data.results[0].error.includes("不存在的 key") && batch.json?.data.results[1].delivered === 1, batch.text);
}

console.log("\n★ 只收加密：密文之外带明文字段也拒");
{
  const { env, channels: [ch] } = entryEnv([{ policy: { e2eOnly: true }, defaults: { title: "默认标题" } }]);
  const mixed = await read(hit(env, `/${ch.key}/${encodeURIComponent("明文标题")}/${encodeURIComponent("明文正文")}?ciphertext=eA&iv=aXY`));
  check("★ /{key}/明文?ciphertext=x&iv=y → 400，点名是哪些明文", mixed.status === 400 && mixed.json?.message.startsWith("这个通道只收加密消息") && mixed.json?.message.includes("标题") && mixed.json?.message.includes("正文"), mixed.text);
  check("密文 + 明文链接也拒", (await hit(env, `/${ch.key}`, post({ ciphertext: "eA", iv: "aXY", url: "https://example.com" }))).status === 400);
  check("密文 + 请求头里的明文标题也拒", (await hit(env, `/${ch.key}`, post({ ciphertext: "eA", iv: "aXY" }, { Title: "leak" }))).status === 400);
  check("★ 只带密文（加上级别、id）→ 放行；通道默认值里的明文不算", (await hit(env, `/${ch.key}`, post({ ciphertext: "eA", iv: "aXY", level: "active", id: "e1" }))).status === 200);
  check("没带密文 → 400", (await hit(env, `/${ch.key}/${encodeURIComponent("明文")}`)).status === 400);
  const batch = await read(hit(env, "/push", post({ device_key: ch.key, ciphertext: "eA", iv: "aXY", title: "明文" })));
  check("/push 同样拒，原因写进 message", batch.status === 400 && batch.json?.message.includes("只收加密"), batch.text);
}

console.log("\n★ 请求体没认出来：说出原因");
{
  const { env, channels: [ch] } = entryEnv();
  const empty = await read(hit(env, `/${ch.key}`, post({ foo: "bar" })));
  check("★ 什么都没认出来 → 400，并说清楚为什么", empty.status === 400 && empty.json?.message.includes("没有认得的字段"), empty.text);
  const partial = await read(hit(env, `/${ch.key}/${encodeURIComponent("路径正文")}`, post({ foo: "bar" })));
  check("★ 路径给了正文、请求体没认出来：照推，warnings 里提一句", partial.status === 200 && partial.json?.data.warnings.some((w) => w.includes("没有认得的字段")), partial.text);
}

console.log("\n★ /push：最多 20 个 key，超预算整批拒");
{
  const { env, channels } = entryEnv(Array.from({ length: 6 }, () => ({ members: 50 })));
  const tooMany = await read(hit(env, "/push", post({ device_keys: Array.from({ length: 21 }, (_, i) => `k${i}xxxxxx`), body: "b" })));
  check("★ 21 个 key → 400（原先上限 100）", tooMany.status === 400 && tooMany.json?.message.includes("20"), tooMany.text);
  check("每个 key 按「2 + 接收人数」估", batchCost({ memberIds: [] }) === 3 && batchCost({ memberIds: Array(50).fill("x") }) === 53);
  const before = apns.length;
  const over = await read(hit(env, "/push", post({ device_keys: channels.map((c) => c.key), body: "大群" })));
  check(`★ 6 个 50 人群（估算 318 > ${BATCH_BUDGET}）→ 400，一条都没推`, over.status === 400 && over.json?.message.includes("分几批") && apns.length === before, over.text);
  const fits = await read(hit(env, "/push", post({ device_keys: channels.slice(0, 5).map((c) => c.key), body: "五个群" })));
  check("5 个 50 人群（估算 265）在预算内，照推", fits.status === 200 && fits.json?.data.delivered === 5 * 51, `${fits.status} ${fits.json?.data?.delivered}`);
}

console.log("\n★ /push：去重算收下，逐个 key 检查，失败说原因");
{
  const { env, channels: [dd, plain, withTitle] } = entryEnv([{ policy: { dedupeWindow: 600 } }, {}, { defaults: { title: "默认标题" } }]);
  const push = (body, headers) => read(hit(env, "/push", post(body, headers)));
  const first = await push({ device_key: dd.key, title: "同一句", body: "话" });
  check("第一次送达", first.status === 200 && first.json?.data.delivered === 1, first.text);
  const again = await push({ device_key: dd.key, title: "同一句", body: "话" });
  check("★ 被去重压掉 → 200（原先 400「全部推送失败 / 没有可用设备」）", again.status === 200 && again.json?.data.results[0].suppressed === "duplicate" && !again.json?.data.results[0].error && again.json?.data.suppressed === "duplicate", again.text);
  const mixed = await push({ device_keys: [dd.key, plain.key], title: "同一句", body: "话" });
  check("一个被去重、一个送达 → 200，顶层不标 suppressed", mixed.status === 200 && mixed.json?.data.suppressed === undefined && mixed.json?.data.delivered === 1, mixed.text);
  const perKey = await push({ device_keys: [plain.key, withTitle.key], level: "active" });
  const byKey = Object.fromEntries((perKey.json?.data.results ?? []).map((r) => [r.key, r]));
  check("★ 逐个 key 检查内容：没内容的报错，通道默认值里有标题的照推", perKey.status === 200 && byKey[plain.key]?.error?.includes("没有内容可推") && byKey[withTitle.key]?.delivered === 1, perKey.text);
  const allFail = await push({ device_keys: ["nosuchkey01", "nosuchkey02"], body: "b" });
  check("★ 全失败：message 带上第一条的原因", allFail.status === 400 && allFail.json?.message === "全部推送失败：key 不存在", allFail.text);
  const viaBearer = await push({ body: "Bearer 也行" }, { authorization: `Bearer ${plain.key}` });
  check("没写 device_key 时认 Authorization: Bearer", viaBearer.status === 200 && lastAlert().body === "Bearer 也行", viaBearer.text);
  const alias = await push({ device_key: plain.key, title: "磁盘告警", msg: "磁盘满了", autocopy: true });
  check("★ /push 认别名和小写开关（原先 msg 被丢、autocopy 不生效）", alias.status === 200 && lastAlert().body === "磁盘满了" && apns.at(-1)?.payload.autocopy === "1", alias.text);
  const md = await push({ device_key: plain.key, markdown: "**只有 markdown**" });
  check("/push 只给 markdown 也能推", md.status === 200 && lastAlert().body === "**只有 markdown**", md.text);
  check("响应带 ignored", (await push({ device_key: plain.key, body: "b", call: "1" })).json?.data.ignored.includes("call"));
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
