/**
 * payload 组装的测试。
 *
 * 这一层出错的方式全是静默的：级别写错位置，系统就按默认处理；铃声不写，
 * 通知就不出声；key 混进 payload，就等于把推送凭据发给了群里每个人。
 * 推送本身照样「成功」，所以只能在这里逐项钉死。
 */
import { generateKeyPairSync } from "node:crypto";
import {
  announceAck,
  buildPayload,
  cancelRepeat,
  categoryFor,
  collectParams,
  deliver,
  interruptionLevel,
  partitionByMute,
  pushHeaders,
  REPEAT_WINDOW_MS,
  repeatEvery,
  repeatMinutes,
  runReminders,
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
  check("content 当正文（Discord 风格）", (await collect({ content: "c" })).body === "c");
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
  await announceAck(personal.env, personal.channel, personal.recipients, "disk", "我");
  const mine = apns.at(-1)?.payload ?? { aps: { alert: {} } };
  // 正文不再是原消息标题：加密消息的标题在 App 里已经解密，传上来再广播就是明文泄露
  check("★ 个人通道：「已确认，不再提醒」，正文固定「一条消息」", mine.aps.alert.title === "已确认，不再提醒" && mine.aps.alert.body === "一条消息");
  check("带上认领广播自己的发出时刻", typeof mine.sent_at === "number");
  check("仍带 ack_by，App 据此把原消息标成已处理而不是另存一条", mine.ack_by === "我");
  check("原地替换原通知、静默", apns.at(-1)?.headers["apns-collapse-id"] === "disk" && mine.aps["interruption-level"] === "passive");
  const group = makeEnv({ group: true });
  // 旧的调用方式（多传一个标题）也不会把它带出去
  await announceAck(group.env, group.channel, group.recipients, "grp", "张三", "服务挂了");
  check("群组照旧：「张三 正在处理」", apns.at(-1)?.payload.aps.alert.title === "张三 正在处理");
  check("★ 广播里没有原消息的任何文字", !JSON.stringify(apns.at(-1)?.payload).includes("服务挂了"));
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
