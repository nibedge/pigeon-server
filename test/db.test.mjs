/**
 * db 层的单元测试，跑在内存 KV 上。
 *
 * 重点有三块，失败方式都是静默的：
 * - 群组的成员关系与权限边界（谁能收、谁能看 key）
 * - 两步写入的中途失败必须「干净」—— 不能留下能收到推送却看不到通道的状态
 * - 推送后维护不能互相覆盖（死 token 摘了又被写回的旧 bug）
 */
import {
  addChannel,
  claimAck,
  createAccount,
  createInvite,
  deleteAccount,
  deleteChannel,
  displayName,
  getAccount,
  getChannel,
  getInvite,
  isMuted,
  joinChannel,
  leaveChannel,
  listChannels,
  MAX_MEMBERS,
  newInviteCode,
  putAccount,
  recordPushOutcome,
  removeMember,
  resolveChannel,
  roleOf,
  rotateKey,
  sanitizePrefs,
  sha256,
  timingSafeEqual,
  upsertDevice,
  blockOwner,
  fileReport,
  getModChannelId,
  isBlocked,
  MAX_BLOCKED,
  REPORT_REASONS,
  REPORT_TTL_SECONDS,
  reportKey,
  setSuspended,
  unblockOwner,
} from "../.test-build/db.mjs";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `  → ${detail}` : ""}`);
  }
}

function memoryKV() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

let seq = 0;
const device = (name, env = "production") => {
  seq++;
  return { token: seq.toString(16).padStart(4, "0").repeat(16), env, name, addedAt: Date.now() };
};
const reload = (env, a) => getAccount(env, a.id);

console.log("\n密码学工具");
{
  const a = await sha256("hello");
  check("SHA-256 稳定", a === (await sha256("hello")) && a.length === 64);
  check("相同串相等", timingSafeEqual("abc123", "abc123"));
  check("不同串不等", !timingSafeEqual("abc123", "abc124"));
  check("长度不同直接不等", !timingSafeEqual("abc", "abcd"));
}

const env = { PIGEON_KV: memoryKV() };

console.log("\n建账号与默认通道");
const { account: A, secret } = await createAccount(env, device("A 的 iPhone"));
const defaultId = A.channelIds[0];
const dflt = await getChannel(env, defaultId);
{
  check("secret 够长", secret.length >= 40);
  check("存的是摘要不是明文", A.secretHash === (await sha256(secret)) && A.secretHash !== secret);
  check("带一个默认通道", A.channelIds.length === 1 && dflt?.name === "默认");
  check("默认通道归自己", dflt?.ownerId === A.id && roleOf(dflt, A.id) === "owner");
  check("★ id 和 key 是两个不同的值", dflt && dflt.id !== dflt.key);

  const r = await resolveChannel(env, dflt.key);
  check("key 能反查到通道", r?.channel.id === dflt.id);
  check("接收者只有自己", r?.recipients.length === 1 && r.recipients[0].id === A.id);
  check("★ 公开 id 不能当推送地址用", (await resolveChannel(env, dflt.id)) === null);
  check("乱写的 key 查不到", (await resolveChannel(env, "nosuchkey123456")) === null);
  check("非法格式直接拒", (await resolveChannel(env, "../../etc")) === null);
}

console.log("\n★ 群组：加入、扇出、角色");
const { account: B } = await createAccount(env, device("B 的 iPhone"));
const group = await addChannel(env, A, "生产告警", "server.rack");
{
  check("创建者是 owner", roleOf(group, A.id) === "owner");
  check("外人没有角色", roleOf(group, B.id) === null);

  check("加入成功", (await joinChannel(env, group, B)) === "joined");
  check("加入后是 member", roleOf(group, B.id) === "member");

  const r = await resolveChannel(env, group.key);
  const ids = r?.recipients.map((a) => a.id) ?? [];
  check("★ 推送扇出到两个人", ids.length === 2 && ids.includes(A.id) && ids.includes(B.id));

  const bList = await listChannels(env, await reload(env, B));
  check("成员的列表里有这个通道", bList.some((c) => c.id === group.id));

  check("重复加入 → already", (await joinChannel(env, group, await reload(env, B))) === "already");
  check("创建者用自己的邀请 → owner", (await joinChannel(env, group, A)) === "owner");
}

console.log("\n退出与移除");
{
  const g = await getChannel(env, group.id);
  await leaveChannel(env, g, await reload(env, B));
  const after = await getChannel(env, group.id);
  check("退出后不再是成员", roleOf(after, B.id) === null);
  check("退出后列表里没了", !(await listChannels(env, await reload(env, B))).some((c) => c.id === group.id));
  check("退出后不再接收", (await resolveChannel(env, group.key))?.recipients.length === 1);

  await joinChannel(env, await getChannel(env, group.id), await reload(env, B));
  check("被移除 → true", await removeMember(env, await getChannel(env, group.id), B.id));
  check("被移除后账号索引也清掉", !(await reload(env, B)).channelIds.includes(group.id));
  check("移除不存在的人 → false", !(await removeMember(env, await getChannel(env, group.id), B.id)));
}

console.log("\n换 key");
{
  const g = await getChannel(env, group.id);
  const oldKey = g.key;
  const newKey = await rotateKey(env, g);
  check("得到新 key", newKey !== oldKey);
  check("★ 旧 key 立即失效", (await resolveChannel(env, oldKey)) === null);
  check("新 key 可用", (await resolveChannel(env, newKey))?.channel.id === group.id);
  check("id 不变", (await getChannel(env, group.id))?.id === group.id);

  // 模拟「删旧指针」那一步失败，指针残留
  await env.PIGEON_KV.put("ch:" + oldKey, JSON.stringify({ id: group.id }));
  check("★ 旧指针残留也不生效（key 对不上）", (await resolveChannel(env, oldKey)) === null);
}

console.log("\n删除通道");
{
  const { account: C } = await createAccount(env, device("C 的 iPad"));
  const g = await getChannel(env, group.id);
  await joinChannel(env, g, C);
  const key = (await getChannel(env, group.id)).key;

  await deleteChannel(env, await getChannel(env, group.id));
  check("通道记录没了", (await getChannel(env, group.id)) === null);
  check("key 失效", (await resolveChannel(env, key)) === null);
  check("★ 成员的索引一并清掉", !(await reload(env, C)).channelIds.includes(group.id));
  check("创建者的索引也清掉", !(await reload(env, A)).channelIds.includes(group.id));
}

console.log("\n邀请码");
{
  const code = newInviteCode();
  check("8 位", code.length === 8);
  check("不含易混字符 0 1 O I L", !/[01OIL]/.test(code));
  const many = new Set(Array.from({ length: 2000 }, newInviteCode));
  check("2000 个互不重复", many.size === 2000);

  const ch = await addChannel(env, await reload(env, A), "邀请测试");
  const inv = await createInvite(env, ch, A.id);
  check("能查到", (await getInvite(env, inv.code))?.channelId === ch.id);
  check("大小写不敏感", (await getInvite(env, inv.code.toLowerCase()))?.channelId === ch.id);
  check("首尾空白容忍", (await getInvite(env, `  ${inv.code} `))?.channelId === ch.id);
  check("按 4-4 分组带空格也认", (await getInvite(env, `${inv.code.slice(0, 4)} ${inv.code.slice(4)}`))?.channelId === ch.id);
  check("带连字符也认", (await getInvite(env, `${inv.code.slice(0, 4)}-${inv.code.slice(4).toLowerCase()}`))?.channelId === ch.id);
  check("格式错 → null", (await getInvite(env, "BAD!CODE")) === null);
  check("不存在 → null", (await getInvite(env, "22222222")) === null);

  await env.PIGEON_KV.put("inv:" + inv.code, JSON.stringify({ ...inv, expiresAt: Date.now() - 1 }));
  check("★ 过期但 KV 还没删 → 仍然拒绝", (await getInvite(env, inv.code)) === null);
}

console.log("\n人数上限");
{
  const ch = await addChannel(env, await reload(env, A), "上限测试");
  const g = await getChannel(env, ch.id);
  g.memberIds = Array.from({ length: MAX_MEMBERS }, (_, i) => `fakemember${i}xx`);
  const { account: D } = await createAccount(env, device("D"));
  check("满员 → full", (await joinChannel(env, g, D)) === "full");
  check("满员被拒时不留孤立索引", !(await reload(env, D)).channelIds.includes(ch.id));
}

console.log("\n★ 加入的中途失败必须是干净的");
{
  const kv = memoryKV();
  const good = { PIGEON_KV: kv };
  const { account: owner } = await createAccount(good, device("owner"));
  const { account: joiner } = await createAccount(good, device("joiner"));
  const ch = await addChannel(good, owner, "脆弱的群");

  // 写账号成功、写通道成员名单失败 —— 模拟两步写入之间断掉
  const broken = {
    PIGEON_KV: {
      get: kv.get,
      delete: kv.delete,
      put: (k, v, o) => (k.startsWith("chan:") ? Promise.reject(new Error("KV 挂了")) : kv.put(k, v, o)),
    },
  };
  let threw = false;
  try {
    await joinChannel(broken, await getChannel(good, ch.id), await getAccount(good, joiner.id));
  } catch {
    threw = true;
  }
  check("写失败时抛出，调用方知道没成功", threw);

  const listed = await listChannels(good, await getAccount(good, joiner.id));
  check("★ 列表里看不到（孤立索引被名单滤掉）", !listed.some((c) => c.id === ch.id));
  const r = await resolveChannel(good, ch.key);
  check("★ 也收不到推送 —— 状态等于没加入", !r.recipients.some((a) => a.id === joiner.id));

  const retry = await joinChannel(good, await getChannel(good, ch.id), await getAccount(good, joiner.id));
  check("重试后加入成功", retry === "joined");
  check("重试后列表里有了",
    (await listChannels(good, await getAccount(good, joiner.id))).some((c) => c.id === ch.id));
}

console.log("\n★ 推送后维护：统计写通道，死 token 写各自账号");
{
  const kv = memoryKV();
  const e = { PIGEON_KV: kv };
  const { account: owner } = await createAccount(e, device("owner-1"));
  upsertDevice(owner, device("owner-2"));
  await putAccount(e, owner);
  const { account: member } = await createAccount(e, device("member-1"));
  const ch = await addChannel(e, await getAccount(e, owner.id), "维护测试");
  await joinChannel(e, await getChannel(e, ch.id), member);

  const ownerDead = (await getAccount(e, owner.id)).devices[1].token;
  const memberDead = (await getAccount(e, member.id)).devices[0].token;

  await recordPushOutcome(e, ch.id, new Map([[owner.id, [ownerDead]], [member.id, [memberDead]]]), true);

  check("★ 创建者的死 token 摘掉了", !(await getAccount(e, owner.id)).devices.some((d) => d.token === ownerDead));
  check("创建者的好 token 还在", (await getAccount(e, owner.id)).devices.length === 1);
  check("★ 成员的死 token 也摘掉了", (await getAccount(e, member.id)).devices.length === 0);
  check("★ 统计同时记上了", (await getChannel(e, ch.id)).count === 1);

  await recordPushOutcome(e, ch.id, new Map(), false);
  check("全失败时计数不动", (await getChannel(e, ch.id)).count === 1);

  let threw = false;
  const bad = { PIGEON_KV: { get: kv.get, delete: kv.delete, put: () => Promise.reject(new Error("x")) } };
  try {
    await recordPushOutcome(bad, ch.id, new Map([[owner.id, ["x".repeat(64)]]]), true);
  } catch {
    threw = true;
  }
  check("KV 写失败被吞掉，不抛给上层", !threw);
}

console.log("\n★ 旧格式迁移：已配出去的地址必须继续有效");
{
  const kv = memoryKV();
  const e = { PIGEON_KV: kv };
  const legacyKey = "LegacyKey12345678901x";
  await kv.put("acct:legacyacct01", JSON.stringify({
    id: "legacyacct01",
    secretHash: "h",
    devices: [device("旧设备")],
    channels: [{ key: legacyKey, name: "旧通道", createdAt: 1, count: 5 }],
    createdAt: 1,
    updatedAt: 1,
  }));
  await kv.put("ch:" + legacyKey, JSON.stringify({ accountId: "legacyacct01" }));

  const r = await resolveChannel(e, legacyKey);
  check("★ 从旧 key 进来能找到通道", r?.channel.name === "旧通道");
  check("统计数字保留", r?.channel.count === 5);
  check("旧账号成了创建者", r?.channel.ownerId === "legacyacct01");
  check("接收者正确", r?.recipients.length === 1);

  const migrated = await getAccount(e, "legacyacct01");
  check("账号换成了新格式", Array.isArray(migrated.channelIds) && migrated.channels === undefined);
  check("★ key 没变", (await getChannel(e, migrated.channelIds[0])).key === legacyKey);

  // 从账号这一侧进来的迁移也要成立
  await kv.put("acct:legacyacct02", JSON.stringify({
    id: "legacyacct02", secretHash: "h", devices: [],
    channels: [{ key: "AnotherLegacyKey000001", name: "另一个", createdAt: 1 }],
    createdAt: 1, updatedAt: 1,
  }));
  await kv.put("ch:AnotherLegacyKey000001", JSON.stringify({ accountId: "legacyacct02" }));
  const acct = await getAccount(e, "legacyacct02");
  check("从账号侧迁移", acct.channelIds.length === 1);
  check("迁移后 key 照常可用", (await resolveChannel(e, "AnotherLegacyKey000001"))?.channel.name === "另一个");
}

console.log("\n★ 迁移中途失败，重跑不留孤儿");
{
  const kv = memoryKV();
  const legacyKey = "RetryLegacyKey000000001";
  await kv.put("acct:retryacct01", JSON.stringify({
    id: "retryacct01", secretHash: "h", devices: [],
    channels: [{ key: legacyKey, name: "重跑", createdAt: 1, count: 2 }],
    createdAt: 1, updatedAt: 1,
  }));
  // 第一次：通道记录写进去了，最后写账号那一步失败
  const flaky = {
    PIGEON_KV: {
      get: kv.get, delete: kv.delete,
      put: (k, v, o) => (k.startsWith("acct:") ? Promise.reject(new Error("KV 挂了")) : kv.put(k, v, o)),
    },
  };
  let threw = false;
  try { await getAccount(flaky, "retryacct01"); } catch { threw = true; }
  check("第一次迁移失败时抛出", threw);
  const firstRun = [...kv.store.keys()].filter((k) => k.startsWith("chan:"));

  const acct = await getAccount({ PIGEON_KV: kv }, "retryacct01");
  const after = [...kv.store.keys()].filter((k) => k.startsWith("chan:"));
  check("★ 重跑之后仍然只有一条通道记录", after.length === 1, after.join(","));
  check("★ 两次写的是同一个 id", firstRun.length === 1 && firstRun[0] === "chan:" + acct.channelIds[0]);
  check("key 照常可用", (await resolveChannel({ PIGEON_KV: kv }, legacyKey))?.channel.name === "重跑");
}

console.log("\n★ 认领");
{
  const e = { PIGEON_KV: memoryKV() };
  const { account: x } = await createAccount(e, device("X 的手机"));
  const { account: y } = await createAccount(e, device("Y 的手机"));
  x.name = "张三";
  check("有显示名用显示名", displayName(x) === "张三");
  check("没有就用设备名", displayName(y) === "Y 的手机");
  check("显示名全是空白也算没有", displayName({ ...y, name: "   " }) === "Y 的手机");
  check("连设备都没有就叫「成员」", displayName({ ...y, devices: [] }) === "成员");

  const a1 = await claimAck(e, "chanid0001", "msg-1", x);
  check("第一个认领 → first", a1.first && a1.record.name === "张三");
  const a2 = await claimAck(e, "chanid0001", "msg-1", y);
  check("★ 后来者不是 first，拿到的仍是张三", !a2.first && a2.record.accountId === x.id && a2.record.name === "张三");
  const a3 = await claimAck(e, "chanid0001", "msg-2", y);
  check("另一条消息互不影响", a3.first && a3.record.accountId === y.id);
  const a4 = await claimAck(e, "chanid0002", "msg-1", y);
  check("另一个通道的同 id 消息互不影响", a4.first);
}

console.log("\n★ 个人偏好：置顶、免打扰、分组");
{
  const now = 1_800_000_000_000;
  const ids = ["chanAAAA1", "chanBBBB2", "chanCCCC3"];
  const p = sanitizePrefs({
    pins: ["chanBBBB2", "chanBBBB2", "nosuchchan", 5],
    mutes: { chanAAAA1: 0, chanBBBB2: now + 3600_000, chanCCCC3: now - 1, ghostchan1: 0, chanX: "x" },
    folders: [{ id: "fold0001", name: "  工作  " }, { id: "fold0001", name: "重复" }, { id: "x", name: "id 太短" }, { id: "fold0002", name: "" }],
    folderOf: { chanAAAA1: "fold0001", chanBBBB2: "nosuchfold", ghostchan1: "fold0001" },
  }, ids, now);
  check("置顶去重、丢掉不认识的通道和非法值", JSON.stringify(p.pins) === JSON.stringify(["chanBBBB2"]), JSON.stringify(p.pins));
  check("一直免打扰记作 0", p.mutes?.chanAAAA1 === 0);
  check("限时免打扰保留截止时刻", p.mutes?.chanBBBB2 === now + 3600_000);
  check("已经过期的免打扰丢掉", !("chanCCCC3" in (p.mutes ?? {})));
  check("不认识的通道丢掉", !("ghostchan1" in (p.mutes ?? {})));
  check("分组名去空白；重复 id、非法 id、空名丢掉", p.folders?.length === 1 && p.folders[0].name === "工作", JSON.stringify(p.folders));
  check("归属只认存在的分组和通道", JSON.stringify(p.folderOf) === JSON.stringify({ chanAAAA1: "fold0001" }), JSON.stringify(p.folderOf));
  check("超长免打扰夹到一年以内", sanitizePrefs({ mutes: { chanAAAA1: now + 10 * 365 * 86400_000 } }, ids, now).mutes.chanAAAA1 <= now + 366 * 86400_000);
  check("空输入 → 空偏好", Object.keys(sanitizePrefs(null, ids, now)).length === 0);

  // 铃声文件名会变成别的设备上 UNNotificationSound 的参数，必须挡住路径穿越
  const s = sanitizePrefs({
    sounds: {
      chanAAAA1: "alert_urgent.caf",
      chanBBBB2: "../../../etc/passwd.caf",
      chanCCCC3: "/tmp/evil.caf",
      ghostchan1: "chime_soft.caf",
    },
  }, ids, now);
  check("合法铃声文件名留下", s.sounds?.chanAAAA1 === "alert_urgent.caf", JSON.stringify(s.sounds));
  check("★ 带 ../ 的文件名丢掉", !("chanBBBB2" in (s.sounds ?? {})));
  check("★ 绝对路径丢掉", !("chanCCCC3" in (s.sounds ?? {})));
  check("铃声里不认识的通道丢掉", !("ghostchan1" in (s.sounds ?? {})));
  check("非 .caf 丢掉", !sanitizePrefs({ sounds: { chanAAAA1: "evil.sh" } }, ids, now).sounds);

  // 默认铃声不挂在任何通道下，「通道存在吗」这道闸门对它不生效，全部安全性都压在文件名正则上
  const ds = (v) => sanitizePrefs({ defaultSound: v }, ids, now);
  check("合法的默认铃声留下", ds("chime_soft.caf").defaultSound === "chime_soft.caf");
  check("★ 默认铃声带 ../ 丢掉", !("defaultSound" in ds("../../../etc/passwd.caf")));
  check("★ 默认铃声是绝对路径丢掉", !("defaultSound" in ds("/tmp/evil.caf")));
  check("默认铃声非 .caf 丢掉", !("defaultSound" in ds("evil.sh")));
  check("默认铃声不是字符串丢掉", !("defaultSound" in ds(42)));
  check("默认铃声为空 → 不产生字段", !("defaultSound" in ds("")) && !("defaultSound" in ds(null)));
  check("压根没给 → 不产生字段", !("defaultSound" in sanitizePrefs({ pins: ["chanAAAA1"] }, ids, now)));
  // 同一份偏好里两者要能共存 —— App 靠「通道设置 → 默认铃声 → 跟随系统」逐级回落
  const both = sanitizePrefs({ defaultSound: "chime_soft.caf", sounds: { chanAAAA1: "alert_urgent.caf" } }, ids, now);
  check("默认铃声与逐通道铃声共存、互不覆盖",
    both.defaultSound === "chime_soft.caf" && both.sounds?.chanAAAA1 === "alert_urgent.caf", JSON.stringify(both));
  check("★ 逐通道铃声非法时，默认铃声不受牵连",
    sanitizePrefs({ defaultSound: "chime_soft.caf", sounds: { chanAAAA1: "../x.caf" } }, ids, now).defaultSound === "chime_soft.caf");

  const acct = { prefs: p };
  check("一直免打扰 → muted", isMuted(acct, "chanAAAA1", now));
  check("截止前 → muted", isMuted(acct, "chanBBBB2", now + 1000));
  check("★ 截止后自动失效", !isMuted(acct, "chanBBBB2", now + 3600_001));
  check("没设的通道 → 不 muted", !isMuted(acct, "chanCCCC3", now));
}

console.log("\n★ 离开通道时连带清掉偏好和密钥");
{
  const e = { PIGEON_KV: memoryKV() };
  const { account: owner } = await createAccount(e, device("群主"));
  const { account: mem } = await createAccount(e, device("成员"));
  const ch = await addChannel(e, await getAccount(e, owner.id), "要退的群");
  await joinChannel(e, await getChannel(e, ch.id), mem);
  const m1 = await getAccount(e, mem.id);
  m1.prefs = { pins: [ch.id], mutes: { [ch.id]: 0 }, folders: [{ id: "fold0001", name: "工作" }], folderOf: { [ch.id]: "fold0001" }, sounds: { [ch.id]: "alert_siren.caf" } };
  m1.wrappedKeys = { [ch.id]: "wrappedkeyblob0001" };
  await putAccount(e, m1);
  await leaveChannel(e, await getChannel(e, ch.id), await getAccount(e, mem.id));
  const m2 = await getAccount(e, mem.id);
  check("置顶清掉", !(m2.prefs?.pins ?? []).includes(ch.id));
  check("免打扰清掉", !(ch.id in (m2.prefs?.mutes ?? {})));
  check("分组归属清掉，分组本身保留", !(ch.id in (m2.prefs?.folderOf ?? {})) && m2.prefs?.folders?.length === 1);
  check("铃声选择清掉", !(ch.id in (m2.prefs?.sounds ?? {})));
  check("保管的密钥清掉", !(ch.id in (m2.wrappedKeys ?? {})));
}

console.log("\n★ 删除账号");
{
  const e = { PIGEON_KV: memoryKV() };
  const { account: owner } = await createAccount(e, device("要注销的人"));
  const { account: other } = await createAccount(e, device("别人"));
  const mine = await addChannel(e, await getAccount(e, owner.id), "我建的群");
  await joinChannel(e, await getChannel(e, mine.id), other);
  const theirs = await addChannel(e, await getAccount(e, other.id), "别人的群");
  await joinChannel(e, await getChannel(e, theirs.id), await getAccount(e, owner.id));
  const ownedKeys = (await listChannels(e, await getAccount(e, owner.id)))
    .filter((c) => c.ownerId === owner.id).map((c) => c.key);

  await deleteAccount(e, await getAccount(e, owner.id));
  check("账号记录没了", (await getAccount(e, owner.id)) === null);
  check("★ 自己建的每个通道都失效", ownedKeys.length === 2 && (await Promise.all(ownedKeys.map((k) => resolveChannel(e, k)))).every((r) => r === null));
  check("★ 成员那边一起清掉", !(await getAccount(e, other.id)).channelIds.includes(mine.id));
  check("★ 别人的群名单上没有他了", !(await getChannel(e, theirs.id)).memberIds.includes(owner.id));
  check("别人的群本身还在", (await getChannel(e, theirs.id))?.name === "别人的群");
  check("KV 里不再有这个账号", !e.PIGEON_KV.store.has("acct:" + owner.id));
}

console.log("\n★ 屏蔽名单");
{
  const acct = { id: "acct_x" };
  check("一开始谁都没屏蔽", !isBlocked(acct, "o1"));
  blockOwner(acct, "o1", "张三", 1000);
  check("屏蔽后在名单上，记着当时的名字", isBlocked(acct, "o1") && acct.blocked[0].name === "张三");
  blockOwner(acct, "o1", "张三改了名", 2000);
  check("★ 重复屏蔽不重复记，名字和时间刷新", acct.blocked.length === 1 && acct.blocked[0].at === 2000 && acct.blocked[0].name === "张三改了名");
  check("解除一个不在名单上的人 → false", unblockOwner(acct, "nobody") === false);
  check("解除 → true", unblockOwner(acct, "o1") === true);
  check("名单空了就整个拿掉，不留空数组", acct.blocked === undefined);
  for (let i = 0; i < MAX_BLOCKED + 5; i++) blockOwner(acct, `o${i}`, `n${i}`, i);
  check(`名单封顶 ${MAX_BLOCKED}，挤掉最早的`, acct.blocked.length === MAX_BLOCKED && !isBlocked(acct, "o0") && isBlocked(acct, `o${MAX_BLOCKED + 4}`));
}

console.log("\n★ 举报记录");
{
  const store = new Map();
  const puts = [];
  const e = {
    PIGEON_KV: {
      store,
      async get(k, type) {
        const v = store.get(k);
        if (v === undefined) return null;
        return type === "json" ? JSON.parse(v) : v;
      },
      async put(k, v, opts) {
        store.set(k, v);
        puts.push({ k, opts });
      },
      async delete(k) {
        store.delete(k);
      },
    },
  };
  const channel = { id: "chan_abc123", key: "k", name: "测试群", ownerId: "owner_1", memberIds: ["rep_1"], createdAt: 0, count: 0 };
  const reporter = { id: "rep_1" };
  await fileReport(e, channel, reporter, { reason: "spam", detail: "广告", messageId: "m1", excerpt: "加微信领红包" });
  const key = reportKey("chan_abc123", "rep_1", "m1");
  check("落在 report: 前缀下", key.startsWith("report:") && store.has(key));
  check("★ 90 天后由 KV 自动删除", REPORT_TTL_SECONDS === 90 * 24 * 3600 && puts.find((p) => p.k === key)?.opts?.expirationTtl === REPORT_TTL_SECONDS);
  const saved = JSON.parse(store.get(key));
  check("记下了通道名和群主（群删了也看得懂）", saved.channelName === "测试群" && saved.ownerId === "owner_1");
  check("附上的内容和说明都在", saved.excerpt === "加微信领红包" && saved.detail === "广告");
  await fileReport(e, channel, reporter, { reason: "harassment", messageId: "m1" });
  const reports = () => [...store.keys()].filter((k) => k.startsWith("report:"));
  check("★ 同一人对同一条只留一份，再交就覆盖", reports().length === 1 && JSON.parse(store.get(key)).reason === "harassment");
  check("覆盖时没给的字段不残留", JSON.parse(store.get(key)).detail === undefined);
  await fileReport(e, channel, reporter, { reason: "other" });
  check("举报整个群是另一份", reports().length === 2 && store.has(reportKey("chan_abc123", "rep_1")));
  check("理由表齐全", ["spam", "harassment", "sexual", "illegal", "other"].every((k) => typeof REPORT_REASONS[k] === "string"));

  console.log("\n★ 停用与审核通道");
  await setSuspended(e, channel, true, "广告");
  check("停用写进了通道记录", JSON.parse(store.get("chan:chan_abc123")).suspended?.reason === "广告");
  await setSuspended(e, channel, false);
  check("恢复后字段整个拿掉", JSON.parse(store.get("chan:chan_abc123")).suspended === undefined);
  check("没设审核通道 → null", (await getModChannelId(e)) === null);
  store.set("config:mod_channel", "chan_mod01");
  check("设了就读得出来", (await getModChannelId(e)) === "chan_mod01");
  store.set("config:mod_channel", "bad id!");
  check("格式不对当没设", (await getModChannelId(e)) === null);
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
