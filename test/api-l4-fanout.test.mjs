/**
 * 接收方自己说了算（L4）：别人的群发来的 critical 要自己允许过才突破免打扰，最低提醒级别以下的静默送达。
 * 看的是推到每台设备上的 payload，所以在进程里跑（见 l4-harness.mjs）：
 *
 *   node test/api-l4-fanout.test.mjs
 */
import {
  call,
  capture,
  check,
  finish,
  makeEnv,
  makeGroup,
  newAccount,
  one,
  push,
  receivers,
} from "./l4-harness.mjs";

const { splitRecipients, tierFor, levelRank } = receivers;

// ── 接收方分拨的规则 ────────────────────────────────────────────────

console.log("\n★ 分拨规则：紧急授权、免打扰、最低级别");
{
  const now = 1_800_000_000_000;
  const channel = { id: "chanG", ownerId: "owner" };
  const owner = { id: "owner", prefs: { mutes: { chanG: 0 } } };
  const plain = { id: "plain" };
  const muted = { id: "muted", prefs: { mutes: { chanG: 0 } } };
  const allowed = { id: "allowed", prefs: { mutes: { chanG: 0 }, critical: { chanG: true } } };
  const elsewhere = { id: "elsewhere", prefs: { critical: { other: true } } };
  const refused = { id: "refused", prefs: { critical: { chanG: false } } };
  const ctx = { now };
  const tier = (a, level, c = channel, x = ctx) => tierFor(a, c, level, x);

  check("★ 自己建的通道：critical 照旧突破自己的免打扰", tier(owner, "critical") === "asis");
  check("★ 加入的群、没授权：critical 按时效性送", tier(plain, "critical") === "capped");
  check("★ 没授权又开着免打扰：静默，不再被叫醒", tier(muted, "critical") === "quiet");
  check("★ 授权了：critical 突破自己的免打扰", tier(allowed, "critical") === "asis");
  check("别的群的授权不算数", tier(elsewhere, "critical") === "capped");
  check("明说不允许（false）同没授权", tier(refused, "critical") === "capped");
  check("级别名不分大小写", tier(plain, "Critical") === "capped" && tier(allowed, "CRITICAL") === "asis");
  check("普通消息照旧：免打扰的静默，其余原样", tier(muted, "active") === "quiet" && tier(plain, "active") === "asis");

  const quietHours = { ...channel, policy: { quietHours: { start: "00:00", end: "23:59", timezone: "UTC" } } };
  check("★ 通道正在免打扰时段：没授权的人不再被 critical 叫醒", tier(plain, "critical", quietHours) === "quiet");
  check("授权了的照样叫醒", tier(allowed, "critical", quietHours) === "asis");
  check("群主自己也照样叫醒", tier(owner, "critical", quietHours) === "asis");

  const floor = (level) => ({ id: "floor", prefs: { minLevel: { chanG: level } } });
  check("★ 最低级别 = 时效性：普通消息静默", tier(floor("timeSensitive"), "active") === "quiet");
  check("没写级别的按普通算，也静默", tier(floor("timeSensitive"), undefined) === "quiet");
  check("时效性照常响", tier(floor("timeSensitive"), "timeSensitive") === "asis");
  check("本来就静默的不算「降」（muted 里不数它）", tier(floor("timeSensitive"), "passive") === "asis");
  check("没授权的 critical 降成时效性，最低级别拦不住它", tier(floor("timeSensitive"), "critical") === "capped");
  check("最低级别 = 普通：普通照常响", tier(floor("active"), "active") === "asis");
  check("最低级别 = 静默：什么也不改", tier(floor("passive"), "active") === "asis");
  check("★ 自己建的通道也认最低级别", tierFor({ id: "owner", prefs: { minLevel: { chanG: "timeSensitive" } } }, channel, "active", ctx) === "quiet");

  check("★ 发消息的人自己：静默收下", tier(plain, "timeSensitive", channel, { now, senderId: "plain" }) === "quiet");
  const split = splitRecipients([owner, plain, muted, allowed], channel, "critical", ctx);
  check("一次分成三拨", split.asis.map((a) => a.id).join() === "owner,allowed" && split.capped.map((a) => a.id).join() === "plain" && split.quiet.map((a) => a.id).join() === "muted", JSON.stringify(split));
  check("级别高低：passive < active < timeSensitive < critical，认不出的按 active", levelRank("passive") < levelRank("active") && levelRank("active") < levelRank("timeSensitive") && levelRank("timeSensitive") < levelRank("critical") && levelRank("weird") === levelRank("active"));
}

// ── 端到端：偏好 ────────────────────────────────────────────────────

console.log("\n★ 偏好：critical、minLevel 走 prefs_patch 逐条合并、清洗、随退群清掉");
const env = makeEnv();
const O = await newAccount(env, "老王");
const M = await newAccount(env, "李四");
const N = await newAccount(env, "张三");
const G = await makeGroup(env, O, [M, N]);
{
  const set = await N.as("PATCH", `/account/${N.id}`, {
    prefs_patch: { critical: { [G.id]: true, nosuchchannel: true }, minLevel: { [G.id]: "time-sensitive", [N.channelId]: "loud" } },
  });
  const prefs = set.json?.data?.prefs ?? {};
  check("★ 记下紧急授权", prefs.critical?.[G.id] === true, JSON.stringify(prefs));
  check("★ 最低级别规整成 timeSensitive", prefs.minLevel?.[G.id] === "timeSensitive", JSON.stringify(prefs));
  check("不认识的通道、认不出的级别丢掉", prefs.critical?.nosuchchannel === undefined && prefs.minLevel?.[N.channelId] === undefined);
  const proto = await N.as("PATCH", `/account/${N.id}`, { prefs_patch: { minLevel: { [N.channelId]: "constructor" } } });
  check("「constructor」这种原型上的名字也不认", proto.json?.data?.prefs?.minLevel?.[N.channelId] === undefined, JSON.stringify(proto.json?.data?.prefs));
  const other = await N.as("PATCH", `/account/${N.id}`, { prefs_patch: { minLevel: { [N.channelId]: "active" } } });
  check("★ 逐条合并：改一条不动别的", other.json?.data?.prefs?.minLevel?.[G.id] === "timeSensitive" && other.json?.data?.prefs?.minLevel?.[N.channelId] === "active");
  const legacy = await N.as("PATCH", `/account/${N.id}`, { prefs: { pins: [G.id] } });
  check("★ 老版 App 整份替换偏好：没提到的紧急授权、最低级别留着", legacy.json?.data?.prefs?.critical?.[G.id] === true && legacy.json?.data?.prefs?.minLevel?.[G.id] === "timeSensitive", JSON.stringify(legacy.json?.data?.prefs));
  const cleared = await N.as("PATCH", `/account/${N.id}`, { prefs_patch: { minLevel: { [N.channelId]: null } } });
  check("条目给 null 删掉这一条", cleared.json?.data?.prefs?.minLevel?.[N.channelId] === undefined && cleared.json?.data?.prefs?.minLevel?.[G.id] === "timeSensitive");
  const bad = await N.as("PATCH", `/account/${N.id}`, { prefs_patch: { critical: { [G.id]: "yes" } } });
  check("只收布尔：「yes」不算授权（那一条按没授权处理）", bad.json?.data?.prefs?.critical?.[G.id] === undefined, JSON.stringify(bad.json?.data?.prefs?.critical));
  const again = await N.as("PATCH", `/account/${N.id}`, { prefs_patch: { critical: { [G.id]: true } } });
  check("重新授权", again.json?.data?.prefs?.critical?.[G.id] === true);
}

console.log("\n★ 推送：每个人按自己的设置拿一版");
{
  await M.as("PATCH", `/account/${M.id}`, { prefs_patch: { mutes: { [G.id]: 0 } } });
  // N 允许紧急、最低级别时效性；M 没授权、开着免打扰；群主 O 什么都没设
  const { result, sent } = await capture(() => call(env, "POST", `/${G.key}`, { body: { title: "水浸", body: "地下室进水", level: "critical" } }));
  check("推送受理", result.status === 200, result.text);
  check("★ 群主原样收到 critical", one(sent, O)?.level === "critical" && one(sent, O)?.aps["interruption-level"] === "time-sensitive", JSON.stringify(one(sent, O)));
  check("★ 授权了的成员收到 critical", one(sent, N)?.level === "critical");
  check("★ 没授权、开着免打扰的成员：静默，不响", one(sent, M)?.level === "passive" && one(sent, M)?.aps["interruption-level"] === "passive" && one(sent, M)?.aps.sound === undefined, JSON.stringify(one(sent, M)));
  check("三份都是同一条消息（id 一样）", new Set(sent.map((a) => a.payload.id)).size === 1 && sent.length === 3);
  check("响应里 muted = 1", result.json?.data?.muted === 1, JSON.stringify(result.json?.data));

  await M.as("PATCH", `/account/${M.id}`, { prefs_patch: { mutes: null } });
  const again = await capture(() => call(env, "POST", `/${G.key}`, { body: { title: "水浸", body: "又进水了", level: "critical" } }));
  check("★ 没授权、没开免打扰：按时效性送（顶层 level 也改了，历史里记的是时效性）", one(again.sent, M)?.level === "timeSensitive" && one(again.sent, M)?.aps["interruption-level"] === "time-sensitive", JSON.stringify(one(again.sent, M)));
  check("没授权的那一份不算 muted", again.result.json?.data?.muted === undefined || again.result.json?.data?.muted === 0, JSON.stringify(again.result.json?.data));

  const normal = await capture(() => call(env, "POST", `/${G.key}`, { body: { title: "日报", body: "今天一切正常" } }));
  check("★ 最低级别时效性的人：普通消息静默送达", one(normal.sent, N)?.level === "passive" && one(normal.sent, N)?.aps["interruption-level"] === "passive");
  check("其余人照常", one(normal.sent, M)?.aps["interruption-level"] === undefined && one(normal.sent, O)?.aps.sound === "default");
  check("muted 把最低级别拦下的也算上", normal.result.json?.data?.muted === 1, JSON.stringify(normal.result.json?.data));
}


console.log("\n★ 载荷预算：不是 critical 的消息，不为「降成时效性」那一版多留地方");
{
  // 先量出静默那一版有多大（把自己的通道设成免打扰，推出去的就是静默版），再把正文加长到它正好顶到预算
  const solo = await newAccount(env, "独自");
  const base = 3000;
  await solo.as("PATCH", `/account/${solo.id}`, { prefs_patch: { mutes: { [solo.channelId]: 0 } } });
  const quiet = await capture(() => call(env, "POST", `/${solo.key}`, { body: { body: "x".repeat(base), id: "edge" } }));
  const quietBytes = Buffer.byteLength(JSON.stringify(quiet.sent[0]?.payload));
  await solo.as("PATCH", `/account/${solo.id}`, { prefs_patch: { mutes: null } });
  const fit = base + (push.PAYLOAD_BUDGET - quietBytes);
  const edge = await capture(() => call(env, "POST", `/${solo.key}`, { body: { body: "x".repeat(fit), id: "edge" } }));
  check("★ 静默那一版正好顶到预算：原样送达，不截", edge.result.status === 200 && edge.result.json?.data?.truncated === undefined && edge.sent[0]?.payload.aps.alert.body.length === fit, `${fit} ${edge.result.text.slice(0, 200)}`);
  const over = await capture(() => call(env, "POST", `/${solo.key}`, { body: { body: "x".repeat(fit + 1), id: "edge" } }));
  check("再多一个字就截", over.result.json?.data?.truncated === true, over.result.text.slice(0, 200));
}

console.log("\n★ 退群清掉这个群的紧急授权、最低级别");
{
  const left = await N.as("DELETE", `/account/${N.id}/channels/${G.id}`);
  check("退群", left.status === 200 && left.json?.data?.left === true);
  const prefs = left.json?.data?.prefs ?? {};
  check("★ 退群之后这个群的紧急授权、最低级别清掉", prefs.critical?.[G.id] === undefined && prefs.minLevel?.[G.id] === undefined, JSON.stringify(prefs));
}

finish();
