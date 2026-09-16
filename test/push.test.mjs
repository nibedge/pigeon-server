/**
 * payload 组装的测试。
 *
 * 这一层出错的方式全是静默的：级别写错位置，系统就按默认处理；铃声不写，
 * 通知就不出声；key 混进 payload，就等于把推送凭据发给了群里每个人。
 * 推送本身照样「成功」，所以只能在这里逐项钉死。
 */
import {
  buildPayload,
  categoryFor,
  collectParams,
  interruptionLevel,
  partitionByMute,
  pushHeaders,
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

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
