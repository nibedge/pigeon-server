/**
 * db 层的单元测试，跑在内存 KV 上。
 *
 * 重点有三块，失败方式都是静默的：
 * - 群组的成员关系与权限边界（谁能收、谁能看 key）
 * - 两步写入的中途失败必须「干净」—— 不能留下能收到推送却看不到通道的状态
 * - 推送热路径不能写通道和账号记录：推送所在机房手里常是旧副本，一写回去就把
 *   别人刚做的改动（换 key、停用、改策略、登记新设备）悄悄盖掉
 */
import {
  addChannel,
  authenticate,
  claimAck,
  clearDeadToken,
  clearRemovedDevice,
  DEAD_TTL_SECONDS,
  forgetChannel,
  isRemovedDevice,
  markRemovedDevice,
  patchPrefs,
  PREFS_KEPT_ON_REPLACE,
  REMOVED_DEVICE_TTL_SECONDS,
  replacePrefs,
  TABLE_PREFS,
  deadTokens,
  getPushStat,
  getPushStats,
  pushStatOf,
  putChannel,
  STAT_FLUSH_MS,
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
  countWatches,
  createWatch,
  deleteWatch,
  getWatch,
  listWatches,
  markWatchIndexComplete,
  mergeWatch,
  removeWatchLeftovers,
  watchCatalog,
  WATCH_LEFTOVER_GRACE_MS,
  WATCH_TOMBSTONE_TTL_SECONDS,
  writeWatchState,
  claimSweepNotice,
  lastSweepTimes,
  meteredEnv,
  readSweep,
  recordSweep,
  SWEEP_NOTICE_TTL_SECONDS,
} from "../.test-build/db.mjs";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `  → ${detail}` : ""}`);
  }
}

/**
 * 内存 KV。list 一页只给 3 个（线上是 1000）：凡是只取第一页的地方，在这里立刻就漏，不必真灌上千条。
 * metadata 和 TTL 都记下来，测试可以直接核对
 */
function memoryKV({ pageSize = 3 } = {}) {
  const store = new Map();
  const meta = new Map();
  const ttl = new Map();
  return {
    store,
    meta,
    ttl,
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value, opts) {
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

/** 记下每一次写入的内存 KV：推送热路径写了哪些键，一看便知 */
function spiedKV() {
  const kv = memoryKV();
  const written = [];
  const put = kv.put;
  kv.written = written;
  kv.put = async (key, value, opts) => {
    written.push({ key, opts });
    return put(key, value, opts);
  };
  return kv;
}

console.log("\n★ 推送后维护：只写 stat: 和 dead:，不碰通道和账号记录");
{
  const kv = spiedKV();
  const e = { PIGEON_KV: kv };
  const { account: owner, secret: ownerSecret } = await createAccount(e, device("owner-1"));
  upsertDevice(owner, device("owner-2"));
  await putAccount(e, owner);
  const { account: member, secret: memberSecret } = await createAccount(e, device("member-1"));
  const ch = await addChannel(e, await getAccount(e, owner.id), "维护测试");
  await joinChannel(e, await getChannel(e, ch.id), member);

  const ownerDead = (await getAccount(e, owner.id)).devices[1].token;
  const memberDead = (await getAccount(e, member.id)).devices[0].token;
  const snapshot = () => [kv.store.get("chan:" + ch.id), kv.store.get("acct:" + owner.id), kv.store.get("acct:" + member.id)].join("|");
  const before = snapshot();
  kv.written.length = 0;
  const t0 = Date.now();

  await recordPushOutcome(e, ch.id, new Map([[owner.id, [ownerDead]], [member.id, [memberDead]]]), true, t0);

  const keys = kv.written.map((w) => w.key);
  check("★ 一次成功推送不写通道记录（不调 putChannel）", !keys.some((k) => k.startsWith("chan:")), keys.join(","));
  check("★ 也不写任何账号记录（不调 putAccount）", !keys.some((k) => k.startsWith("acct:")), keys.join(","));
  check("通道和两个账号的记录一个字节都没变", snapshot() === before);
  check("★ 统计记进了 stat:", JSON.parse(kv.store.get("stat:" + ch.id)).count === 1);
  const deadWrites = kv.written.filter((w) => w.key.startsWith("dead:"));
  check("★ 两个失效 token 各立一块墓碑", deadWrites.length === 2);
  check("墓碑 30 天后自动消失", deadWrites.every((w) => w.opts?.expirationTtl === DEAD_TTL_SECONDS && DEAD_TTL_SECONDS === 30 * 24 * 3600));
  check("墓碑键是 token 的 SHA-256，键名里没有 token 本身",
    kv.store.has("dead:" + (await sha256(ownerDead))) && deadWrites.every((w) => !w.key.includes(ownerDead) && !w.key.includes(memberDead)));

  const ownerNow = await getAccount(e, owner.id);
  check("失效设备暂时还挂在账号上（等本人来访才摘）", ownerNow.devices.length === 2);
  const dead = await deadTokens(e, ownerNow.devices);
  check("★ 推送据此认出要跳过的那台，好的那台不受影响", dead.size === 1 && dead.has(ownerDead));

  const authed = await authenticate(e, owner.id, ownerSecret);
  check("★ 本人来访（authenticate）时摘掉失效设备", authed.devices.length === 1 && authed.devices[0].token !== ownerDead);
  check("★ 只改内存：authenticate 自己不写账号，免得和请求本身的写入挤进同一秒",
    kv.store.get("acct:" + owner.id) === before.split("|")[1]);
  await putAccount(e, authed);
  check("请求本来要写账号时随之落盘", (await getAccount(e, owner.id)).devices.length === 1);
  check("secret 不对照样拒绝，不因为摘设备放行", (await authenticate(e, owner.id, "wrong-secret")) === null);

  const m = await authenticate(e, member.id, memberSecret);
  check("成员那边同样摘掉", m.devices.length === 0);
  upsertDevice(m, { token: memberDead, env: "production", name: "重装后", addedAt: t0 + 1000 });
  check("★ 墓碑之后重新登记的同一个 token 不算失效（重装偶尔拿回同一个 token）", (await deadTokens(e, m.devices)).size === 0);
  await clearDeadToken(e, memberDead);
  check("重新登记时墓碑作废", !kv.store.has("dead:" + (await sha256(memberDead))));

  await recordPushOutcome(e, ch.id, new Map(), false, t0 + 2 * STAT_FLUSH_MS);
  check("全失败时计数不动", JSON.parse(kv.store.get("stat:" + ch.id)).count === 1);

  kv.store.set("dead:" + (await sha256(ownerDead)), "不是 JSON");
  check("墓碑值坏了读不出来：当它还活着，宁可多推一次", (await deadTokens(e, ownerNow.devices)).size === 0);

  let threw = false;
  const bad = { PIGEON_KV: { get: kv.get, delete: kv.delete, put: () => Promise.reject(new Error("x")) } };
  try {
    await recordPushOutcome(bad, ch.id, new Map([[owner.id, ["x".repeat(64)]]]), true, t0 + 3 * STAT_FLUSH_MS);
  } catch {
    threw = true;
  }
  check("KV 写失败被吞掉，不抛给上层", !threw);
}

console.log("\n★ 推送统计：60 秒最多落一次盘，攒下的条数不丢");
{
  const kv = spiedKV();
  const e = { PIGEON_KV: kv };
  const id = "statchan0001";
  const writes = () => kv.written.filter((w) => w.key === "stat:" + id).length;
  const t0 = 1_700_000_000_000;

  await recordPushOutcome(e, id, new Map(), true, t0);
  check("第一条立刻落盘", writes() === 1 && (await getPushStat(e, id))?.count === 1 && (await getPushStat(e, id))?.lastPushAt === t0);
  for (let i = 1; i <= 5; i++) await recordPushOutcome(e, id, new Map(), true, t0 + i * 10_000);
  check("★ 60 秒内又来 5 条：一次也不写（KV 同一个键每秒只能写一次）", writes() === 1 && (await getPushStat(e, id))?.count === 1);
  await recordPushOutcome(e, id, new Map(), true, t0 + STAT_FLUSH_MS);
  check("★ 满 60 秒写一次，攒下的 5 条一起带上", writes() === 2 && (await getPushStat(e, id))?.count === 7, JSON.stringify(await getPushStat(e, id)));
  check("最近一次推送的时刻跟着更新", (await getPushStat(e, id))?.lastPushAt === t0 + STAT_FLUSH_MS);

  await Promise.all([1, 2, 3].map(() => recordPushOutcome(e, id, new Map(), true, t0 + 2 * STAT_FLUSH_MS)));
  check("同一实例里三条同时到点：只写一次，三条都算上", writes() === 3 && (await getPushStat(e, id))?.count === 10);

  const flaky = { PIGEON_KV: { get: kv.get, delete: kv.delete, put: () => Promise.reject(new Error("429")) } };
  await recordPushOutcome(flaky, id, new Map(), true, t0 + 3 * STAT_FLUSH_MS);
  await recordPushOutcome(e, id, new Map(), true, t0 + 3 * STAT_FLUSH_MS + 1);
  check("写失败的那条放回去，下次落盘一起带上", (await getPushStat(e, id))?.count === 12);

  const blind = spiedKV();
  const blindGet = blind.get;
  // 本机房一时读不到自己刚写的值：stat: 永远读成「没有」
  blind.get = (key, type) => (key.startsWith("stat:") ? Promise.resolve(null) : blindGet(key, type));
  for (let i = 0; i < 3; i++) await recordPushOutcome({ PIGEON_KV: blind }, "statblind01", new Map(), true, t0 + i * 10_000);
  check("★ 读不到自己刚写的统计，也不会每条推送都去写一次", blind.written.filter((w) => w.key === "stat:statblind01").length === 1);

  check("旧统计 + stat: 相加显示", pushStatOf({ count: 5, lastPushAt: 100 }, { count: 3, lastPushAt: 200 }).count === 8);
  check("最近推送取两者里晚的", pushStatOf({ count: 5, lastPushAt: 300 }, { count: 3, lastPushAt: 200 }).lastPushAt === 300);
  check("还没有 stat: 时就是旧数", pushStatOf({ count: 5, lastPushAt: 100 }, null).count === 5);
  check("从没推过：没有最近推送时刻", pushStatOf({ count: 0 }, undefined).lastPushAt === undefined);
  kv.store.set("stat:broken01", "{\"count\":\"x\"}");
  const many = await getPushStats(e, [id, "broken01", "nostat0001"]);
  check("批量读：坏的、没有的都不放进结果", many.size === 1 && many.get(id)?.count === 12);
}

console.log("\n★ 停用：只写 susp:，读通道时合进来；旧数据写在通道记录上的照样认");
{
  const kv = memoryKV();
  const e = { PIGEON_KV: kv };
  const { account: owner } = await createAccount(e, device("群主"));
  const ch = await addChannel(e, await getAccount(e, owner.id), "要停的群");
  const stored = () => JSON.parse(kv.store.get("chan:" + ch.id));
  const before = kv.store.get("chan:" + ch.id);

  await setSuspended(e, await getChannel(e, ch.id), true, "广告");
  check("停用写在 susp: 上", JSON.parse(kv.store.get("susp:" + ch.id)).reason === "广告");
  check("★ 停用不改写通道记录", kv.store.get("chan:" + ch.id) === before);
  const read = await getChannel(e, ch.id);
  check("★ 读通道时合进 suspended", read.suspended?.reason === "广告" && typeof read.suspended.at === "number");
  check("★ 推送入口认得（resolveChannel）", (await resolveChannel(e, ch.key))?.channel.suspended?.reason === "广告");
  check("账号快照那一侧也认得（listChannels）",
    (await listChannels(e, await getAccount(e, owner.id))).find((c) => c.id === ch.id)?.suspended !== undefined);

  read.name = "改了名";
  await putChannel(e, read);
  check("★ 整条改写通道记录（改名、换 key、加人）不会把叠加的停用写进去", stored().suspended === undefined && stored().name === "改了名");
  check("改写之后仍是停用", (await getChannel(e, ch.id)).suspended?.reason === "广告");

  kv.store.set("susp:" + ch.id, "坏掉的值");
  check("susp: 的值解析不了也按停用算，不因此放行", (await getChannel(e, ch.id)).suspended !== undefined);

  await setSuspended(e, await getChannel(e, ch.id), false);
  check("恢复：susp: 删掉", !kv.store.has("susp:" + ch.id));
  check("恢复后读出来没有 suspended", (await getChannel(e, ch.id)).suspended === undefined);
  check("恢复一个只在 susp: 上停用的通道，不改写通道记录", stored().name === "改了名" && stored().suspended === undefined);

  kv.store.set("chan:" + ch.id, JSON.stringify({ ...stored(), suspended: { at: 1, reason: "旧" } }));
  check("★ 旧数据：写在通道记录上的停用照样认", (await getChannel(e, ch.id)).suspended?.reason === "旧");
  const legacy = await getChannel(e, ch.id);
  legacy.icon = "bell";
  await putChannel(e, legacy);
  check("旧的停用字段在整条改写时原样保留", stored().suspended?.reason === "旧");
  await setSuspended(e, await getChannel(e, ch.id), false);
  check("★ 恢复旧数据的停用：通道记录上的字段一并去掉", stored().suspended === undefined && (await getChannel(e, ch.id)).suspended === undefined);

  await setSuspended(e, await getChannel(e, ch.id), true);
  await recordPushOutcome(e, ch.id, new Map(), true);
  const other = await addChannel(e, await getAccount(e, owner.id), "另一个");
  await deleteChannel(e, await getChannel(e, ch.id));
  check("删通道时 stat: 和 susp: 一起清掉", !kv.store.has("stat:" + ch.id) && !kv.store.has("susp:" + ch.id));
  check("别的通道不受影响", (await getChannel(e, other.id))?.name === "另一个");
}

console.log("\n★ 推送所在机房拿着旧副本：推送不再把别人的改动盖回去");
/**
 * 模拟推送落在另一个机房：frozen 里的键读出来还是冻结那一刻的旧值（KV 在别处最长 60 秒才可见，
 * 缓存着「没有这个键」也算），写入照常落到中心存储 —— 旧 bug 正是这样把旧副本写回去的。
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
  };
}
{
  const kv = memoryKV();
  const e = { PIGEON_KV: kv };
  const { account: owner } = await createAccount(e, device("群主"));
  const { account: mem } = await createAccount(e, device("成员"));
  const ch = await addChannel(e, await getAccount(e, owner.id), "被推得很勤的群");
  await joinChannel(e, await getChannel(e, ch.id), await getAccount(e, mem.id));
  const oldKey = ch.key;
  const cached = () => staleView(kv, ["ch:" + oldKey, "chan:" + ch.id, "susp:" + ch.id, "acct:" + owner.id, "acct:" + mem.id]);

  /** 旧机房里的一次推送在存储上留下的全部痕迹：按旧 key 找通道 → 推完记一笔 */
  async function pushFromStaleColo(stale, key, dead = new Map()) {
    const r = await resolveChannel(stale, key);
    if (r) await recordPushOutcome(stale, r.channel.id, dead, true);
    return r;
  }

  // ① 运营者停用
  let stale = cached();
  await setSuspended(e, await getChannel(e, ch.id), true, "刷屏");
  const seen = await pushFromStaleColo(stale, oldKey);
  check("（旧机房缓存里还没停用，这一条照样进来了 —— 最长 60 秒）", seen && !seen.channel.suspended);
  check("★ 停用没被抹掉：之后按新数据读，推送入口拒收", (await resolveChannel(e, oldKey))?.channel.suspended?.reason === "刷屏");
  await setSuspended(e, await getChannel(e, ch.id), false);

  // ①' 旧数据：停用还写在通道记录上（老版本的审核脚本）
  kv.store.set("chan:" + ch.id, JSON.stringify({ ...JSON.parse(kv.store.get("chan:" + ch.id)), suspended: { at: 1 } }));
  const legacyCopy = JSON.parse(kv.store.get("chan:" + ch.id));
  delete legacyCopy.suspended;
  const base = staleView(kv, ["ch:" + oldKey, "susp:" + ch.id]).PIGEON_KV;
  // 这个机房缓存的是审核脚本写入之前的通道记录
  stale = { PIGEON_KV: { ...base, get: async (k, t) => (k === "chan:" + ch.id ? structuredClone(legacyCopy) : base.get(k, t)) } };
  await pushFromStaleColo(stale, oldKey);
  check("★ 旧数据的停用也不会被推送抹掉", JSON.parse(kv.store.get("chan:" + ch.id)).suspended !== undefined);
  await setSuspended(e, await getChannel(e, ch.id), false);

  // ② 群主改策略（只收加密）、移除成员
  stale = cached();
  const patched = await getChannel(e, ch.id);
  patched.policy = { e2eOnly: true };
  await putChannel(e, patched);
  await pushFromStaleColo(stale, oldKey);
  check("★ PATCH 策略与推送并发：策略不回滚", (await getChannel(e, ch.id)).policy?.e2eOnly === true);
  stale = cached();
  await removeMember(e, await getChannel(e, ch.id), mem.id);
  await pushFromStaleColo(stale, oldKey);
  check("★ 移除的成员不会被推送写回名单", !(await getChannel(e, ch.id)).memberIds.includes(mem.id));

  // ③ 地址泄漏，群主换 key；滥用者接着用旧地址推
  stale = cached();
  const newKey = await rotateKey(e, await getChannel(e, ch.id));
  const abused = await pushFromStaleColo(stale, oldKey);
  check("（旧机房还认旧地址，这一条照样进来了）", abused !== null);
  check("★ 换 key 之后旧地址再推一次，新地址仍然可用", (await resolveChannel(e, newKey))?.channel.id === ch.id);
  check("旧地址按新数据已经失效", (await resolveChannel(e, oldKey)) === null);
  check("通道记录上是新 key", (await getChannel(e, ch.id)).key === newKey);

  // ④ 用户换了手机刚登记新设备，旧手机的 token 恰好在这时被发现失效
  const oldPhone = (await getAccount(e, owner.id)).devices[0].token;
  stale = staleView(kv, ["ch:" + newKey, "chan:" + ch.id, "acct:" + owner.id]);
  const fresh = await getAccount(e, owner.id);
  const newPhone = device("新手机");
  upsertDevice(fresh, newPhone);
  await putAccount(e, fresh);
  await pushFromStaleColo(stale, newKey, new Map([[owner.id, [oldPhone]]]));
  const after = await getAccount(e, owner.id);
  check("★ 刚登记的新设备还在（旧 bug：清死 token 时拿旧副本整条写回，把它删了）", after.devices.some((d) => d.token === newPhone.token));
  check("旧手机的 token 立了墓碑，推送会跳过它", (await deadTokens(e, after.devices)).has(oldPhone));
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
  // 设备名不再顶替：iOS 16 起它只剩「iPhone」，群里谁是谁分不清
  const fallback = `成员·${y.id.slice(-4)}`;
  check("★ 没有就叫「成员·账号 id 后四位」，不用设备名", displayName(y) === fallback, displayName(y));
  check("显示名全是空白也算没有", displayName({ ...y, name: "   " }) === fallback);

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

  // 备注名：成员给群起的、只有自己看得到的名字
  const al = sanitizePrefs({
    aliases: { chanAAAA1: "  值班群  ", chanBBBB2: "   ", chanCCCC3: 42, ghostchan1: "不存在的群" },
  }, ids, now);
  check("★ 备注名去掉首尾空白后留下", al.aliases?.chanAAAA1 === "值班群", JSON.stringify(al.aliases));
  check("空白备注名丢掉（等于取消备注）", !("chanBBBB2" in (al.aliases ?? {})));
  check("非字符串备注名丢掉", !("chanCCCC3" in (al.aliases ?? {})));
  check("备注名里不认识的通道丢掉", !("ghostchan1" in (al.aliases ?? {})));
  check("备注名截到 40 字", sanitizePrefs({ aliases: { chanAAAA1: "长".repeat(100) } }, ids, now).aliases.chanAAAA1.length === 40);
  check("全部无效 → 不产生字段", !("aliases" in sanitizePrefs({ aliases: { chanAAAA1: "" } }, ids, now)));
  check("★ 老客户端不带 aliases → 不产生字段", !("aliases" in sanitizePrefs({ pins: ["chanAAAA1"] }, ids, now)));
  // 新录音的文件名是纯 ASCII；老版本的 rec_录音_….caf 会被丢掉 —— App 启动时会把它们迁移成前者
  check("★ 新式录音文件名能同步", sanitizePrefs({ sounds: { chanAAAA1: "rec_1758043200.caf" } }, ids, now).sounds?.chanAAAA1 === "rec_1758043200.caf");
  check("老式带中文的录音文件名不收", !sanitizePrefs({ sounds: { chanAAAA1: "rec_录音_1758043200.caf" } }, ids, now).sounds);

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
  m1.prefs = { pins: [ch.id], mutes: { [ch.id]: 0 }, folders: [{ id: "fold0001", name: "工作" }], folderOf: { [ch.id]: "fold0001" }, sounds: { [ch.id]: "alert_siren.caf" }, aliases: { [ch.id]: "我的备注" }, images: { [ch.id]: true } };
  m1.wrappedKeys = { [ch.id]: "wrappedkeyblob0001" };
  await putAccount(e, m1);
  await leaveChannel(e, await getChannel(e, ch.id), await getAccount(e, mem.id));
  const m2 = await getAccount(e, mem.id);
  check("置顶清掉", !(m2.prefs?.pins ?? []).includes(ch.id));
  check("免打扰清掉", !(ch.id in (m2.prefs?.mutes ?? {})));
  check("分组归属清掉，分组本身保留", !(ch.id in (m2.prefs?.folderOf ?? {})) && m2.prefs?.folders?.length === 1);
  check("铃声选择清掉", !(ch.id in (m2.prefs?.sounds ?? {})));
  check("备注名清掉", !(ch.id in (m2.prefs?.aliases ?? {})));
  check("★ 图片开关清掉", !(ch.id in (m2.prefs?.images ?? {})), JSON.stringify(m2.prefs?.images));
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
  await fileReport(e, channel, reporter, { reason: "spam", detail: "广告", messageId: "m1", excerpt: "加好友领红包" });
  const key = reportKey("chan_abc123", "rep_1", "m1");
  check("落在 report: 前缀下", key.startsWith("report:") && store.has(key));
  check("★ 90 天后由 KV 自动删除", REPORT_TTL_SECONDS === 90 * 24 * 3600 && puts.find((p) => p.k === key)?.opts?.expirationTtl === REPORT_TTL_SECONDS);
  const saved = JSON.parse(store.get(key));
  check("记下了通道名和群主（群删了也看得懂）", saved.channelName === "测试群" && saved.ownerId === "owner_1");
  check("附上的内容和说明都在", saved.excerpt === "加好友领红包" && saved.detail === "广告");
  await fileReport(e, channel, reporter, { reason: "harassment", messageId: "m1" });
  const reports = () => [...store.keys()].filter((k) => k.startsWith("report:"));
  check("★ 同一人对同一条只留一份，再交就覆盖", reports().length === 1 && JSON.parse(store.get(key)).reason === "harassment");
  check("覆盖时没给的字段不残留", JSON.parse(store.get(key)).detail === undefined);
  await fileReport(e, channel, reporter, { reason: "other" });
  check("举报整个群是另一份", reports().length === 2 && store.has(reportKey("chan_abc123", "rep_1")));
  check("理由表齐全", ["spam", "harassment", "sexual", "illegal", "other"].every((k) => typeof REPORT_REASONS[k] === "string"));

  console.log("\n★ 停用与审核通道");
  await setSuspended(e, channel, true, "广告");
  check("停用写在 susp: 上，不写通道记录", JSON.parse(store.get("susp:chan_abc123")).reason === "广告" && !store.has("chan:chan_abc123"));
  check("手里这份通道对象也标上了", channel.suspended?.reason === "广告");
  await setSuspended(e, channel, false);
  check("恢复后 susp: 删掉、字段整个拿掉", !store.has("susp:chan_abc123") && channel.suspended === undefined && !store.has("chan:chan_abc123"));
  check("没设审核通道 → null", (await getModChannelId(e)) === null);
  store.set("config:mod_channel", "chan_mod01");
  check("设了就读得出来", (await getModChannelId(e)) === "chan_mod01");
  store.set("config:mod_channel", "bad id!");
  check("格式不对当没设", (await getModChannelId(e)) === null);
}

// ── 监控存储 ─────────────────────────────────────────────────────────

/** 一个监控在 KV 里的全部键（不含墓碑） */
const watchKeysOf = (kv, id) =>
  [...kv.store.keys()].filter((k) => k === `watch:${id}` || k === `hbstate:${id}` || k === `wstate:${id}` || (k.startsWith("wown:") && k.endsWith(`:${id}`)));

const hbInput = (channelId, extra = {}) => ({ channelId, kind: "heartbeat", intervalMinutes: 60, graceMinutes: 6, name: "备份", lastStatus: "new", ...extra });
const siteInput = (channelId, extra = {}) => ({ channelId, kind: "up", url: "https://site.test/", intervalMinutes: 15, name: "官网", ...extra });

console.log("\n★ 监控存储：配置、索引、状态分开存");
{
  const kv = memoryKV();
  const e = { PIGEON_KV: kv };
  const { account: owner } = await createAccount(e, device("监控的主人"));
  const chanId = owner.channelIds[0];
  const hb = await createWatch(e, owner.id, hbInput(chanId));
  const config = JSON.parse(kv.store.get(`watch:${hb.id}`));
  check("配置里不存状态字段", config.lastStatus === undefined && config.lastPingAt === undefined && config.name === "备份");
  check("刚建的心跳读出来是 new", hb.lastStatus === "new" && (await getWatch(e, hb.id))?.lastStatus === "new");
  check("★ 记进创建者的索引，metadata 带通道和类型", JSON.stringify(kv.meta.get(`wown:${owner.id}:${hb.id}`)) === JSON.stringify({ channelId: chanId, kind: "heartbeat", at: hb.createdAt }));
  check("状态键等第一次报到才写", !kv.store.has(`hbstate:${hb.id}`));

  const pinged = { ...(await getWatch(e, hb.id)), lastStatus: "up", lastPingAt: 1234 };
  await writeWatchState(e, pinged, 99_000, 5000);
  const value = JSON.parse(kv.store.get(`hbstate:${hb.id}`));
  check("★ 状态的值和 metadata 是同一份，带着下一次该看的时刻", JSON.stringify(value) === JSON.stringify(kv.meta.get(`hbstate:${hb.id}`)) && value.nextDueAt === 99_000 && value.at === 5000 && value.kind === "heartbeat");
  check("状态里只有状态字段，配置字段不混进去", value.name === undefined && value.channelId === undefined);
  const merged = await getWatch(e, hb.id);
  check("读出来是配置 + 状态", merged.lastStatus === "up" && merged.lastPingAt === 1234 && merged.name === "备份" && merged.nextDueAt === undefined);

  const legacy = { ...config, lastStatus: "down", lastPingAt: 1, lastCheckedAt: 2 };
  check("★ 老数据：没有状态键时拿配置里的旧字段", mergeWatch(legacy, null).lastStatus === "down" && mergeWatch(legacy, null).lastPingAt === 1);
  const fresh = mergeWatch(legacy, { lastStatus: "up", lastPingAt: 9 });
  check("★ 有了状态键就以它为准，配置里的旧字段一个不漏地让位", fresh.lastStatus === "up" && fresh.lastPingAt === 9 && fresh.lastCheckedAt === undefined);

  const site = await createWatch(e, owner.id, siteInput(chanId));
  check("网址监控刚建时没有状态", site.lastStatus === undefined && site.lastCheckedAt === undefined);
  await writeWatchState(e, { ...site, lastStatus: "up", lastCheckedAt: 7 }, 8, 7);
  check("网址监控的状态在 wstate:", kv.store.has(`wstate:${site.id}`) && !kv.store.has(`hbstate:${site.id}`));
}

console.log("\n★ 按人列监控：只读自己的，翻页取全");
{
  const kv = memoryKV();
  const e = { PIGEON_KV: kv };
  const { account: me } = await createAccount(e, device("我"));
  const { account: other } = await createAccount(e, device("别人"));
  const made = [];
  for (let i = 0; i < 7; i++) made.push(await createWatch(e, me.id, siteInput(me.channelIds[0], { name: `站 ${i}` })));
  const theirs = await createWatch(e, other.id, hbInput(other.channelIds[0]));
  await markWatchIndexComplete(e);

  const reads = [];
  const lists = [];
  const spied = {
    PIGEON_KV: {
      ...kv,
      get: (key, type) => (reads.push(key), kv.get(key, type)),
      list: (opts) => (lists.push(opts.prefix), kv.list(opts)),
    },
  };
  const mine = await listWatches(spied, me.id);
  check("★ 一页 3 个也列全了 7 个", mine.length === 7, String(mine.length));
  check("按创建先后", mine.every((w, i) => i === 0 || mine[i - 1].createdAt <= w.createdAt));
  check("★ 只翻自己的索引，不翻全站", lists.every((p) => p === `wown:${me.id}:`), lists.join(" | "));
  check(
    "★ 一条别人的记录都没读",
    !reads.some((k) => k.includes(theirs.id)) && reads.every((k) => k === "config:watches_indexed" || made.some((w) => k.endsWith(w.id))),
    reads.join(" | "),
  );
  check("数个数只翻索引，不读配置", (reads.length = 0, (await countWatches(spied, me.id)) === 7 && reads.length === 0));
  check("别人那边只有他自己的", (await listWatches(e, other.id)).map((w) => w.id).join() === theirs.id);

  // 索引指向空处（建到一半、刚删掉）：跳过，不报错
  kv.store.delete(`watch:${made[0].id}`);
  check("索引指向空处的跳过", (await listWatches(e, me.id)).length === 6);
}

console.log("\n★ 删通道、删号：推给它的监控一起删掉");
{
  const kv = memoryKV();
  const e = { PIGEON_KV: kv };
  const { account: owner } = await createAccount(e, device("群主"));
  const { account: bystander } = await createAccount(e, device("旁人"));
  const first = owner.channelIds[0];
  const second = await addChannel(e, await getAccount(e, owner.id), "第二个");
  const onFirst = [await createWatch(e, owner.id, hbInput(first)), await createWatch(e, owner.id, siteInput(first))];
  const onSecond = [await createWatch(e, owner.id, hbInput(second.id)), await createWatch(e, owner.id, siteInput(second.id))];
  const theirs = await createWatch(e, bystander.id, hbInput(bystander.channelIds[0]));
  for (const w of [...onFirst, ...onSecond]) await writeWatchState(e, { ...w, lastStatus: "up", lastPingAt: 1, lastCheckedAt: 1 }, 1, 1);

  await deleteChannel(e, await getChannel(e, second.id));
  check("★ 删通道：推给它的监控、状态、索引一把不剩", onSecond.every((w) => watchKeysOf(kv, w.id).length === 0), onSecond.flatMap((w) => watchKeysOf(kv, w.id)).join());
  check("★ 立了 10 分钟的墓碑", onSecond.every((w) => kv.store.has(`watchdel:${w.id}`) && kv.ttl.get(`watchdel:${w.id}`) === WATCH_TOMBSTONE_TTL_SECONDS) && WATCH_TOMBSTONE_TTL_SECONDS === 600);
  check("别的通道上的监控不动", onFirst.every((w) => watchKeysOf(kv, w.id).length === 3));

  await deleteAccount(e, await getAccount(e, owner.id));
  check("★ 删号：这个人的监控一把不剩", onFirst.every((w) => watchKeysOf(kv, w.id).length === 0));
  check("★ KV 里没有任何挂在他名下的监控键", ![...kv.store.keys()].some((k) => k.startsWith(`wown:${owner.id}:`) || (k.startsWith("watch:") && JSON.parse(kv.store.get(k)).ownerId === owner.id)));
  check("别人的监控不动", watchKeysOf(kv, theirs.id).length === 2 && (await getWatch(e, theirs.id))?.ownerId === bystander.id);

  const lone = await createWatch(e, bystander.id, siteInput(bystander.channelIds[0]));
  await deleteWatch(e, lone.id);
  check("只给 id 也删得干净（先查出是谁的，索引一起删）", watchKeysOf(kv, lone.id).length === 0 && kv.store.has(`watchdel:${lone.id}`));
}

console.log("\n★ 老数据：改版之前的监控（状态写在配置里、没有索引）");
{
  const kv = memoryKV();
  const e = { PIGEON_KV: kv };
  const { account: owner } = await createAccount(e, device("老用户"));
  const { account: other } = await createAccount(e, device("另一个老用户"));
  const chan = owner.channelIds[0];
  const legacy = (id, ownerId, channelId, extra) =>
    kv.store.set(`watch:${id}`, JSON.stringify({ id, ownerId, channelId, createdAt: 1, ...extra }));
  legacy("legacyhb0001", owner.id, chan, { kind: "heartbeat", intervalMinutes: 60, graceMinutes: 6, name: "老心跳", lastStatus: "up", lastPingAt: 100 });
  legacy("legacyst0001", owner.id, chan, { kind: "up", url: "https://site.test/", intervalMinutes: 5, name: "老网站", lastStatus: "down", lastCheckedAt: 50 });
  legacy("legacyot0001", other.id, other.channelIds[0], { kind: "up", url: "https://site.test/", intervalMinutes: 5, name: "别人的" });
  const modern = await createWatch(e, owner.id, hbInput(chan));

  const mine = await listWatches(e, owner.id);
  check("★ 索引补完之前：老监控照样列得出来（全表兜底）", mine.length === 3 && mine.some((w) => w.id === "legacyhb0001") && mine.some((w) => w.id === "legacyst0001"), mine.map((w) => w.id).join());
  check("老监控的状态取自配置里的旧字段", mine.find((w) => w.id === "legacyhb0001")?.lastPingAt === 100 && mine.find((w) => w.id === "legacyst0001")?.lastStatus === "down");
  check("别人的老监控不混进来", !mine.some((w) => w.id === "legacyot0001") && (await countWatches(e, owner.id)) === 3);

  await markWatchIndexComplete(e);
  check("索引补完的标记记在 config: 下", kv.store.has("config:watches_indexed"));

  await deleteAccount(e, await getAccount(e, owner.id));
  // 标记要等 cron 把老监控全补进索引才写；有了标记，删号就只按索引找
  check("有了标记：按索引删", watchKeysOf(kv, modern.id).length === 0);
  // 标记之前的删号：换一个没有标记的库
  const kv2 = memoryKV();
  const e2 = { PIGEON_KV: kv2 };
  const { account: old } = await createAccount(e2, device("老用户"));
  kv2.store.set("watch:legacyhb0002", JSON.stringify({ id: "legacyhb0002", ownerId: old.id, channelId: old.channelIds[0], kind: "heartbeat", intervalMinutes: 60, name: "老心跳", lastStatus: "new", createdAt: 1 }));
  await deleteAccount(e2, await getAccount(e2, old.id));
  check("★ 索引还没补的老监控，删号时照样删掉", !kv2.store.has("watch:legacyhb0002") && kv2.store.has("watchdel:legacyhb0002"));
}

console.log("\n★ 残键：配置没了、状态或索引还在的，放够 10 分钟才清");
{
  const kv = memoryKV();
  const e = { PIGEON_KV: kv };
  const { account: owner } = await createAccount(e, device("主人"));
  const w = await createWatch(e, owner.id, hbInput(owner.channelIds[0]));
  const T0 = w.createdAt;
  await writeWatchState(e, { ...w, lastStatus: "up", lastPingAt: T0 }, 1, T0);
  kv.store.delete(`watch:${w.id}`);
  const recent = await removeWatchLeftovers(e, await watchCatalog(e), T0 + WATCH_LEFTOVER_GRACE_MS - 1);
  check("不到 10 分钟：留着（可能只是配置还没列出来）", recent === 0 && kv.store.has(`hbstate:${w.id}`));
  const later = await removeWatchLeftovers(e, await watchCatalog(e), T0 + WATCH_LEFTOVER_GRACE_MS);
  check("★ 满 10 分钟：状态键和索引都清掉", later === 2 && watchKeysOf(kv, w.id).length === 0);
  const kept = await createWatch(e, owner.id, hbInput(owner.channelIds[0]));
  await writeWatchState(e, { ...kept, lastStatus: "up", lastPingAt: 1 }, 1, 1);
  check("配置还在的一概不动", (await removeWatchLeftovers(e, await watchCatalog(e), T0 * 2)) === 0 && watchKeysOf(kv, kept.id).length === 3);
}

console.log("\n★ 监控的新状态字段只进状态键；提醒强度是配置");
{
  const kv = memoryKV();
  const e = { PIGEON_KV: kv };
  const { account: owner } = await createAccount(e, device("主人"));
  const w = await createWatch(e, owner.id, siteInput(owner.channelIds[0], { level: "timeSensitive", repeat: 5 }));
  const config = JSON.parse(kv.store.get(`watch:${w.id}`));
  check("★ level / repeat 存在配置里（只在新建时写）", config.level === "timeSensitive" && config.repeat === 5);
  const failing = { ...w, lastStatus: "down", lastCheckedAt: 9, failCount: 3, timeoutCount: 2, pausedAt: 8, lastDetail: "5 秒内没有回应", pendingAlertAttempts: 1 };
  await writeWatchState(e, failing, 10, 9);
  const state = kv.meta.get(`wstate:${w.id}`);
  check("★ 失败计数、超时计数、暂停、失败说明、待重推次数都进状态键（值和 metadata 同一份）",
    state.failCount === 3 && state.timeoutCount === 2 && state.pausedAt === 8 && state.lastDetail === "5 秒内没有回应" && state.pendingAlertAttempts === 1 &&
    JSON.stringify(state) === kv.store.get(`wstate:${w.id}`));
  check("配置字段不混进状态键", state.level === undefined && state.repeat === undefined && state.url === undefined);
  check("状态的 metadata 远小于 1KB", JSON.stringify(state).length < 400, String(JSON.stringify(state).length));
  const merged = await getWatch(e, w.id);
  check("读出来配置和状态都在", merged.level === "timeSensitive" && merged.failCount === 3 && merged.pendingAlertAttempts === 1);
  check("配置一次都没被改写", kv.store.get(`watch:${w.id}`) === JSON.stringify(config));
  await writeWatchState(e, { ...merged, failCount: undefined, pendingAlertAttempts: undefined, lastDetail: undefined, pausedAt: undefined, timeoutCount: undefined, lastStatus: "up" }, 11, 10);
  const cleared = kv.meta.get(`wstate:${w.id}`);
  check("清零的字段从状态里拿掉，不留 null", !("failCount" in cleared) && !("pendingAlertAttempts" in cleared) && !("lastDetail" in cleared) && cleared.lastStatus === "up");
}

console.log("\n★ 巡检数着 KV 操作；每轮的记录、运营者通知的节流");
{
  const kv = memoryKV();
  const e = { PIGEON_KV: kv };
  const metered = meteredEnv(e);
  await metered.env.PIGEON_KV.put("x:1", "1");
  await metered.env.PIGEON_KV.get("x:1");
  await metered.env.PIGEON_KV.list({ prefix: "x:" });
  await metered.env.PIGEON_KV.delete("x:1");
  check("★ get / put / list / delete 每次都数上", metered.ops() === 4);
  check("数着的照样读写同一个库", !kv.store.has("x:1"));
  check("别的绑定原样带着", meteredEnv({ PIGEON_KV: kv, APNS_TOPIC: "t" }).env.APNS_TOPIC === "t");

  check("还没跑过：两个时刻都是 null", JSON.stringify(await lastSweepTimes(e)) === JSON.stringify({ watches: null, reminders: null }));
  await recordSweep(e, "watches", { at: 1000, scheduledAt: 900, tookMs: 100, ok: true, checked: 3, errors: 0 });
  check("★ 记下一轮：时刻和计数", (await readSweep(e, "watches"))?.checked === 3 && (await lastSweepTimes(e)).watches === 1000);
  check("记录只有数字和布尔，不含任何用户数据", Object.values(JSON.parse(kv.store.get("sweep:watches"))).every((v) => typeof v === "number" || typeof v === "boolean"));
  check("另一类还没跑过", (await lastSweepTimes(e)).reminders === null);
  kv.store.set("sweep:reminders", "坏掉的记录");
  check("记录坏了当没有，不报错", (await lastSweepTimes(e)).reminders === null);

  check("★ 一小时里第一次出问题：通知", await claimSweepNotice(e, "watches", 5));
  check("★ 同一小时里再出问题：不再通知", !(await claimSweepNotice(e, "watches", 6)));
  check("记号一小时后自动过期", kv.ttl.get("sweep:notified:watches") === SWEEP_NOTICE_TTL_SECONDS && SWEEP_NOTICE_TTL_SECONDS === 3600);
  check("两类各算各的", await claimSweepNotice(e, "reminders", 7));
}

console.log("\n★ 群图片开关：只收已知通道、布尔值");
{
  const now = 1_800_000_000_000;
  const ids = ["chanAAAA1", "chanBBBB2", "chanCCCC3"];
  const p = sanitizePrefs({ images: { chanAAAA1: true, chanBBBB2: false, chanCCCC3: "true", ghostchan1: true } }, ids, now);
  check("★ 开、关都留下", p.images?.chanAAAA1 === true && p.images?.chanBBBB2 === false, JSON.stringify(p.images));
  check("★ 不是布尔的丢掉（字符串 \"true\" 也不认）", !("chanCCCC3" in (p.images ?? {})));
  check("不认识的通道丢掉", !("ghostchan1" in (p.images ?? {})));
  check("全部无效 → 不产生字段", !("images" in sanitizePrefs({ images: { chanAAAA1: 1 } }, ids, now)));
  check("是数组 → 不产生字段", !("images" in sanitizePrefs({ images: [true] }, ids, now)));
  check("★ 老客户端不带 images → 不产生字段（没有条目时由 App 按身份取默认）", !("images" in sanitizePrefs({ pins: ["chanAAAA1"] }, ids, now)));
  const many = Array.from({ length: 300 }, (_, i) => `chan${String(i).padStart(5, "0")}`);
  check("条数有上限", Object.keys(sanitizePrefs({ images: Object.fromEntries(many.map((id) => [id, true])) }, many, now).images).length === 200);

  // 老版 App 不认识 images，交整份偏好时不带它：不能因此把新版设备设的开关清空
  const stored = { pins: ["chanAAAA1"], images: { chanBBBB2: true } };
  const legacy = sanitizePrefs(replacePrefs(stored, { pins: ["chanCCCC3"], mutes: { chanAAAA1: 0 } }), ids, now);
  check("★ 老版 App 整份提交（不带 images）：图片开关原样保留", JSON.stringify(legacy.images) === '{"chanBBBB2":true}', JSON.stringify(legacy));
  check("★ 它提到的项照旧整份替换", JSON.stringify(legacy.pins) === '["chanCCCC3"]' && legacy.mutes?.chanAAAA1 === 0);
  check("整份提交里明说 images 为空对象 → 清空", !("images" in sanitizePrefs(replacePrefs(stored, { images: {} }), ids, now)));
  check("整份提交里给了 images → 换成给的", JSON.stringify(sanitizePrefs(replacePrefs(stored, { images: { chanAAAA1: false } }), ids, now).images) === '{"chanAAAA1":false}');
  check("提交的是坏数据：老 App 认识的项清空（原有行为），images 仍保留", JSON.stringify(sanitizePrefs(replacePrefs(stored, "junk"), ids, now)) === '{"images":{"chanBBBB2":true}}');
  check("原来就没有 images：不凭空多出来", !("images" in replacePrefs({ pins: ["chanAAAA1"] }, { pins: [] })));
  check("整份替换保留的只有老 App 不认识的项", JSON.stringify(PREFS_KEPT_ON_REPLACE) === '["images"]' && !("pins" in replacePrefs(stored, {})));
  check("不改动传进来的对象", JSON.stringify(stored) === '{"pins":["chanAAAA1"],"images":{"chanBBBB2":true}}');

  const acct = { prefs: { images: { chanAAAA1: false, chanBBBB2: true } } };
  forgetChannel(acct, "chanAAAA1");
  check("★ 忘掉通道时删掉它的图片开关，别的不动", JSON.stringify(acct.prefs.images) === JSON.stringify({ chanBBBB2: true }));
}

console.log("\n★ 偏好按项合并（prefs_patch）");
{
  const now = 1_800_000_000_000;
  const ids = ["chanAAAA1", "chanBBBB2", "chanCCCC3"];
  const clean = (current, patch) => sanitizePrefs(patchPrefs(current, patch), ids, now);
  const current = {
    pins: ["chanAAAA1"],
    mutes: { chanAAAA1: 0, chanBBBB2: now + 3600_000 },
    folders: [{ id: "fold0001", name: "工作" }, { id: "fold0002", name: "家里" }],
    folderOf: { chanAAAA1: "fold0001", chanBBBB2: "fold0002" },
    sounds: { chanAAAA1: "alert_siren.caf" },
    defaultSound: "chime_soft.caf",
    aliases: { chanBBBB2: "值班群" },
    images: { chanBBBB2: false },
  };
  const before = JSON.stringify(current);

  const m = clean(current, { mutes: { chanCCCC3: 0 } });
  check("★ 表类：新条目加进去，原有条目都在", JSON.stringify(m.mutes) === JSON.stringify({ chanAAAA1: 0, chanBBBB2: now + 3600_000, chanCCCC3: 0 }), JSON.stringify(m.mutes));
  check("★ 没提到的偏好项原样保留", JSON.stringify(m.pins) === '["chanAAAA1"]' && m.defaultSound === "chime_soft.caf" && m.aliases?.chanBBBB2 === "值班群" && m.images?.chanBBBB2 === false, JSON.stringify(m));
  check("★ 条目值 null → 只删这一条", JSON.stringify(clean(current, { mutes: { chanAAAA1: null } }).mutes) === JSON.stringify({ chanBBBB2: now + 3600_000 }));
  check("改一条：覆盖这一条", clean(current, { sounds: { chanAAAA1: "chime_soft.caf" } }).sounds?.chanAAAA1 === "chime_soft.caf");
  check("★ 顶层 null → 整项删掉", !("aliases" in clean(current, { aliases: null })));
  check("最后一条也删了 → 不产生空字段", !("images" in clean(current, { images: { chanBBBB2: null } })));
  check("★ 数组整项替换", JSON.stringify(clean(current, { pins: ["chanCCCC3", "chanAAAA1"] }).pins) === '["chanCCCC3","chanAAAA1"]');
  check("★ 单值整项替换", clean(current, { defaultSound: "alert_urgent.caf" }).defaultSound === "alert_urgent.caf");
  check("没有的表：从空表开始合并", JSON.stringify(clean({}, { aliases: { chanAAAA1: "我的" } }).aliases) === '{"chanAAAA1":"我的"}');
  check("空补丁：什么都不变", JSON.stringify(clean(current, {})) === JSON.stringify(sanitizePrefs(current, ids, now)));
  check("★ 表类给了不是对象的值：当坏数据丢掉，原有的不清空", JSON.stringify(clean(current, { mutes: [] }).mutes) === JSON.stringify(current.mutes) && clean(current, { aliases: "x" }).aliases?.chanBBBB2 === "值班群");
  check("★ 合并后照样清洗：非法条目进不来", !("chanCCCC3" in (clean(current, { sounds: { chanCCCC3: "../x.caf" } }).sounds ?? {})) && !("ghostchan1" in (clean(current, { mutes: { ghostchan1: 0 } }).mutes ?? {})));
  const dropFolder = clean(current, { folders: [{ id: "fold0001", name: "工作" }] });
  check("★ 删掉一个分组：归到它下面的通道一起清掉", JSON.stringify(dropFolder.folderOf) === '{"chanAAAA1":"fold0001"}', JSON.stringify(dropFolder.folderOf));
  check("★ 合并不改动传进来的现有偏好", JSON.stringify(current) === before);
  const evil = patchPrefs(current, JSON.parse('{"__proto__": {"pins": ["chanCCCC3"]}, "mutes": {"__proto__": {"chanCCCC3": 0}}}'));
  check("★ __proto__ 键不改原型、不借原型塞进偏好", Object.getPrototypeOf(evil) === Object.prototype && Object.getPrototypeOf(evil.mutes) === Object.prototype && JSON.stringify(sanitizePrefs(evil, ids, now).pins) === '["chanAAAA1"]');
  check("未知偏好项：合并进来也被清洗掉", !("junk" in clean(current, { junk: { a: 1 } })));

  // 每个表类偏好都逐条合并 —— 新加一类表却忘了登记，这里就会发现
  const samples = { mutes: 0, folderOf: "fold0001", sounds: "alert_siren.caf", aliases: "备注", images: true };
  check("表类偏好名单：mutes、folderOf、sounds、aliases、images", JSON.stringify([...TABLE_PREFS].sort()) === JSON.stringify(Object.keys(samples).sort()), JSON.stringify(TABLE_PREFS));
  for (const key of TABLE_PREFS) {
    const base = { folders: [{ id: "fold0001", name: "工作" }], [key]: { chanAAAA1: samples[key] } };
    const out = clean(base, { [key]: { chanBBBB2: samples[key] } });
    check(`${key}：别的条目在，新条目也在`, out[key]?.chanAAAA1 === samples[key] && out[key]?.chanBBBB2 === samples[key], JSON.stringify(out[key]));
  }

  // 两台设备各自手里是旧快照，各改一项：两项都要留下
  let stored = sanitizePrefs({ pins: ["chanAAAA1"] }, ids, now);
  stored = clean(stored, { mutes: { chanBBBB2: 0 } });         // iPhone：给 B 设免打扰
  stored = clean(stored, { pins: ["chanAAAA1", "chanCCCC3"] }); // iPad：多置顶一个 C
  stored = clean(stored, { aliases: { chanCCCC3: "机房" } });    // iPhone：给 C 起备注
  check("★ 两台设备交替改：置顶、免打扰、备注名都在", JSON.stringify(stored.pins) === '["chanAAAA1","chanCCCC3"]' && stored.mutes?.chanBBBB2 === 0 && stored.aliases?.chanCCCC3 === "机房", JSON.stringify(stored));
}

console.log("\n★ 移除设备的墓碑：拦住静默重新登记，本人要回来时放行");
{
  const kv = memoryKV();
  const e = { PIGEON_KV: kv };
  const { account: owner } = await createAccount(e, device("机主的 iPhone"));
  const { account: other } = await createAccount(e, device("另一个账号"));
  const gone = device("送人的旧 iPad");
  const t0 = 1_800_000_000_000;

  await markRemovedDevice(e, owner.id, gone.token, t0);
  const key = `rmdev:${owner.id}:${await sha256(gone.token)}`;
  check("★ 键 = rmdev:{账号 id}:{token 的 SHA-256}", kv.store.has(key), [...kv.store.keys()].filter((k) => k.startsWith("rmdev:")).join());
  check("★ 值 = {accountId, at}", JSON.stringify(JSON.parse(kv.store.get(key))) === JSON.stringify({ accountId: owner.id, at: t0 }));
  check("★ 30 天后自动过期", kv.ttl.get(key) === REMOVED_DEVICE_TTL_SECONDS && REMOVED_DEVICE_TTL_SECONDS === 30 * 24 * 3600);
  check("键名、值里都没有 token 本身", ![...kv.store.entries()].some(([k, v]) => k.startsWith("rmdev:") && (k.includes(gone.token) || v.includes(gone.token))));

  const acct = await getAccount(e, owner.id);
  check("★ 不在账号里、有墓碑 → 拦", await isRemovedDevice(e, acct, gone.token));
  check("★ 别的账号不受影响", !(await isRemovedDevice(e, await getAccount(e, other.id), gone.token)));
  check("没被移除过的设备 → 放行", !(await isRemovedDevice(e, acct, device("新手机").token)));
  check("★ 还在账号里、登记得比墓碑早（移除还没传到这个机房）→ 照样拦",
    await isRemovedDevice(e, { ...acct, devices: [{ ...gone, addedAt: t0 - 1000 }] }, gone.token));
  check("★ 还在账号里、登记得比墓碑晚（本人加回来了，墓碑没删掉）→ 放行",
    !(await isRemovedDevice(e, { ...acct, devices: [{ ...gone, addedAt: t0 + 1000 }] }, gone.token)));

  kv.store.set(key, JSON.stringify({ accountId: owner.id }));
  check("墓碑格式不对也算数", await isRemovedDevice(e, acct, gone.token));
  const broken = { PIGEON_KV: { ...kv, async get() { throw new Error("KV 读不了"); } } };
  check("★ 读墓碑出错 → 放行，不把好设备挡在门外", !(await isRemovedDevice(broken, acct, gone.token)));

  await clearRemovedDevice(e, owner.id, gone.token);
  check("★ 本人加回来：墓碑删掉", !kv.store.has(key) && !(await isRemovedDevice(e, acct, gone.token)));
  const failing = { PIGEON_KV: { ...kv, async delete() { throw new Error("KV 删不了"); } } };
  let threw = false;
  try {
    await clearRemovedDevice(failing, owner.id, gone.token);
  } catch {
    threw = true;
  }
  check("删墓碑出错不往外抛（登记时刻会比墓碑晚，墓碑管不到它）", !threw);

  // upsertDevice 的 renew：静默续期不动登记时刻，本人加回来按这一次算
  const a = { devices: [{ ...gone, addedAt: t0 - 5000 }] };
  upsertDevice(a, { ...gone, name: "改了名", addedAt: t0 + 5000 });
  check("静默续期：更新名字，不动登记时刻", a.devices.length === 1 && a.devices[0].name === "改了名" && a.devices[0].addedAt === t0 - 5000);
  upsertDevice(a, { ...gone, addedAt: t0 + 5000 }, { renew: true });
  check("★ 本人加回来（renew）：登记时刻按这一次算", a.devices[0].addedAt === t0 + 5000);
  upsertDevice(a, { ...gone, addedAt: t0 }, { renew: true });
  check("renew 不会把登记时刻往回拨", a.devices[0].addedAt === t0 + 5000);

  // 删号：这个账号立的墓碑一块不剩，别的账号的不动。立 4 块，跨过内存 KV 一页 3 个
  for (let i = 0; i < 4; i++) await markRemovedDevice(e, owner.id, device(`旧设备${i}`).token, t0);
  await markRemovedDevice(e, other.id, gone.token, t0);
  await deleteAccount(e, await getAccount(e, owner.id));
  const left = [...kv.store.keys()].filter((k) => k.startsWith("rmdev:"));
  check("★ 删号：这个账号的墓碑全部删掉（翻页取全）", !left.some((k) => k.startsWith(`rmdev:${owner.id}:`)), left.join());
  check("别的账号的墓碑还在", left.length === 1 && left[0].startsWith(`rmdev:${other.id}:`));
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
