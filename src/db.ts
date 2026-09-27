import type {
  AccountPrefs,
  AckRecord,
  Account,
  ApnsEnv,
  Channel,
  Device,
  Env,
  Folder,
  Invite,
  KeyPointer,
  Report,
  Watch,
} from "./types";

const ACCOUNT = "acct:";
const CHANNEL = "chan:";
const KEY = "ch:";
const INVITE = "inv:";
const ACK = "ack:";
const REPORT = "report:";
/** 推送统计：每个通道一份，和通道记录分开放。见 recordPushStat */
const STAT = "stat:";
/** 停用标记：每个通道一份，只由 npm run mod 写。见 getChannel */
const SUSPENDED = "susp:";
/** 失效 token 的墓碑，按 token 的 SHA-256 存。见 recordPushOutcome */
const DEAD = "dead:";
/** 被机主移出账号的设备，按「账号 id : token 的 SHA-256」存。见 markRemovedDevice */
const REMOVED_DEVICE = "rmdev:";
/** 服务端设置。目前只有一项：接收举报通知的通道 id，由 npm run mod -- inbox 写入 */
const CONFIG_MOD_CHANNEL = "config:mod_channel";

/** 群组人数上限（不含创建者）。再多就该用专门的值班告警系统了 */
export const MAX_MEMBERS = 50;
/** 邀请码有效期。可以重复使用，但不能永久有效 */
export const INVITE_TTL_SECONDS = 7 * 24 * 3600;
/** 认领记录保留一天。告警早就处理完了，再留着只是多存一份「谁在什么时候值班」 */
export const ACK_TTL_SECONDS = 24 * 3600;
/** 举报保留 90 天：够处理、够复核申诉，再久就只是替别人存着一段话 */
export const REPORT_TTL_SECONDS = 90 * 24 * 3600;
/** 屏蔽名单上限，满了挤掉最早的 */
export const MAX_BLOCKED = 200;
/**
 * 推送统计最多每 60 秒落一次盘。KV 同一个键每秒只能写一次，而告警密集时一个通道每秒可以来好几条；
 * 何况新写入本来就要最长约 60 秒才传到别的机房，写得再勤，别处也看不到
 */
export const STAT_FLUSH_MS = 60_000;
/** 失效 token 的墓碑留 30 天：足够等到账号本人下次打开 App，把它从账号上摘掉 */
export const DEAD_TTL_SECONDS = 30 * 24 * 3600;
/**
 * 移除设备的墓碑留 30 天。被移走的设备只要还登录着，每次打开 App 都会静默重新登记一次；
 * 30 天里它总会打开几回、收到 410 退出登录，之后就不会再来了
 */
export const REMOVED_DEVICE_TTL_SECONDS = 30 * 24 * 3600;

/** id / key 里只允许 URL 安全字符，避免路径解析歧义 */
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

export function isValidId(value: string): boolean {
  return ID_RE.test(value);
}

function randomToken(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 22 字符 base64url（128 bit）。比 UUID 短，URL 里也不用转义。 */
export function newId(): string {
  return randomToken(16);
}

/** 账号 secret 用 256 bit —— 它是长期凭据，猜中一个就等于拿到整个账号 */
export function newSecret(): string {
  return randomToken(32);
}

/**
 * 邀请码字母表：去掉了 0/O、1/I/L 这些念出来、抄下来都容易混的字符。
 * 邀请码是要口头报给同事、或者手敲进去的。
 */
const INVITE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const INVITE_RE = new RegExp(`^[${INVITE_ALPHABET}]{8}$`);

export function newInviteCode(): string {
  // 拒绝采样：直接用 byte % 31 会让前几个字符略微更常出现（256 不是 31 的
  // 整数倍）。邀请码是准凭据，不该有可预测的偏向。
  const n = INVITE_ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = "";
  while (out.length < 8) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < limit && out.length < 8) out += INVITE_ALPHABET.charAt(b % n);
    }
  }
  return out;
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 定长比较，不因为前几位不同就提前返回。
 *
 * 校验 secret 时用 === 会随匹配长度泄漏时间差，理论上可以被逐字节爆破出来。
 * 这里比的是两个等长的十六进制摘要，全程走完再给结论。
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── 账号 ────────────────────────────────────────────────────────────

/** 早期格式：通道直接嵌在账号里 */
interface LegacyChannel {
  key: string;
  name: string;
  icon?: string;
  defaults?: Channel["defaults"];
  policy?: Channel["policy"];
  createdAt: number;
  count?: number;
  lastPushAt?: number;
}
type StoredAccount = Account & { channels?: LegacyChannel[] };

export async function getAccount(env: Env, id: string): Promise<Account | null> {
  if (!isValidId(id)) return null;
  const raw = await env.PIGEON_KV.get<StoredAccount>(ACCOUNT + id, "json");
  if (!raw) return null;
  raw.devices ??= [];
  if (Array.isArray(raw.channels) && !Array.isArray(raw.channelIds)) {
    await migrateAccount(env, raw);
  }
  raw.channelIds ??= [];
  return raw;
}

/**
 * 旧通道迁移时，新 id 由 key 推导，而不是随机生成。
 *
 * 迁移是多步写入，中途失败的话下次读取会整个重跑。随机 id 会让每次重跑都
 * 新建一批通道记录，留下一堆孤儿；推导出来的 id 让重跑写回的是同一条记录。
 * id 本身是公开的，由 key 单向推出不会反过来泄漏 key。
 */
async function legacyChannelId(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(CHANNEL + key));
  let bin = "";
  for (const b of new Uint8Array(digest).slice(0, 16)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 早期账号把通道直接嵌在自己身上 —— 一个通道只能属于一个人，做不了群组。
 * 读到旧格式就地升级：每个嵌入的通道拆成独立记录，旧 key 指针改指向新 id。
 * **已经配出去的 webhook 地址（key）保持不变。**
 */
async function migrateAccount(env: Env, raw: StoredAccount): Promise<void> {
  const ids: string[] = [];
  for (const legacy of raw.channels ?? []) {
    const channel: Channel = {
      id: await legacyChannelId(legacy.key),
      key: legacy.key,
      name: legacy.name,
      icon: legacy.icon,
      ownerId: raw.id,
      memberIds: [],
      defaults: legacy.defaults,
      policy: legacy.policy,
      createdAt: legacy.createdAt,
      count: legacy.count ?? 0,
      lastPushAt: legacy.lastPushAt,
    };
    await putChannel(env, channel);
    await putKeyPointer(env, channel.key, channel.id);
    ids.push(channel.id);
  }
  raw.channelIds = ids;
  delete raw.channels;
  await putAccount(env, raw);
}

export async function putAccount(env: Env, account: Account): Promise<void> {
  account.updatedAt = Date.now();
  await env.PIGEON_KV.put(ACCOUNT + account.id, JSON.stringify(account));
}

export async function createAccount(
  env: Env,
  device: Device,
): Promise<{ account: Account; secret: string }> {
  const secret = newSecret();
  const now = Date.now();
  const account: Account = {
    id: newId(),
    secretHash: await sha256(secret),
    devices: [device],
    channelIds: [],
    createdAt: now,
    updatedAt: now,
  };
  // 附带一个默认通道 —— 用户装完 App 就该有个能用的地址
  const channel = await createChannelRecord(env, account.id, "默认", "bell");
  account.channelIds.push(channel.id);
  await putAccount(env, account);
  return { account, secret };
}

/**
 * 群组里怎么称呼这个人。没起名字就叫「成员·账号 id 后四位」，不再拿设备名顶替：
 * iOS 16 起设备名只剩「iPhone」，群里一排「iPhone 正在处理」谁也分不清；后四位至少能区分开
 */
export function displayName(account: Account): string {
  return account.name?.trim() || `成员·${account.id.slice(-4)}`;
}

/** 校验 bearer secret 是否属于这个账号 */
export async function authenticate(
  env: Env,
  accountId: string,
  secret: string,
): Promise<Account | null> {
  const account = await getAccount(env, accountId);
  if (!account) return null;
  const presented = await sha256(secret);
  if (!timingSafeEqual(presented, account.secretHash)) return null;
  // 推送时发现失效的 token 只记了墓碑（见 recordPushOutcome），到账号本人来访时才从账号上摘掉。
  // 只改内存：这次请求本来就要写账号的，随之落盘；不写的（比如 GET）等下一次写 ——
  // 不在这里单独写一次，免得和接下来的写入挤进同一秒，撞上 KV 同键每秒一次的上限。
  // 摘掉之前推送照样跳过这些 token，不耽误什么
  await pruneDeadDevices(env, account);
  return account;
}

// ── 通道 ────────────────────────────────────────────────────────────

async function putKeyPointer(env: Env, key: string, id: string): Promise<void> {
  const pointer: KeyPointer = { id };
  await env.PIGEON_KV.put(KEY + key, JSON.stringify(pointer));
}

type Suspension = NonNullable<Channel["suspended"]>;

/**
 * 从 susp: 叠加进内存的停用标记。putChannel 认得它们，不写回 chan:。
 *
 * 停用原先写在通道记录里，而通道记录会被整条读—改—写（换 key、改名、加人、退群）：
 * 哪个机房手里还是停用之前的旧副本，它一写回去，停用就被悄悄抹掉了。现在停用只由
 * susp: 这一个键说了算，别处谁也不写它；旧数据里写在 chan: 上的 suspended 照样认。
 */
const overlaidSuspension = new WeakMap<Channel, Suspension>();

async function readSuspension(env: Env, id: string): Promise<Suspension | null> {
  const raw = await env.PIGEON_KV.get(SUSPENDED + id);
  if (raw === null) return null;
  // 键在就是停用；值里只是时间和理由，解析不了也不能因此放行
  try {
    const parsed = JSON.parse(raw) as Partial<Suspension> | null;
    if (parsed && typeof parsed.at === "number") {
      return { at: parsed.at, ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}) };
    }
  } catch {
    // 同上
  }
  return { at: 0 };
}

/**
 * 读通道。停用标记在这里合进 channel.suspended —— 推送、重复提醒、监控、邀请、认领、
 * 账号快照都经由这里读通道，一处合并，处处认得，不必每个地方各记着多读一个键。
 */
export async function getChannel(env: Env, id: string): Promise<Channel | null> {
  if (!isValidId(id)) return null;
  const [channel, suspension] = await Promise.all([
    env.PIGEON_KV.get<Channel>(CHANNEL + id, "json"),
    readSuspension(env, id),
  ]);
  if (!channel) return null;
  channel.memberIds ??= [];
  if (suspension && !channel.suspended) {
    channel.suspended = suspension;
    overlaidSuspension.set(channel, suspension);
  }
  return channel;
}

export async function putChannel(env: Env, channel: Channel): Promise<void> {
  const overlay = overlaidSuspension.get(channel);
  const record = overlay && channel.suspended === overlay ? { ...channel, suspended: undefined } : channel;
  await env.PIGEON_KV.put(CHANNEL + channel.id, JSON.stringify(record));
}

async function createChannelRecord(
  env: Env,
  ownerId: string,
  name: string,
  icon?: string,
  group = false,
): Promise<Channel> {
  const channel: Channel = {
    id: newId(),
    key: newId(),
    name: name.trim() || "未命名",
    icon,
    ownerId,
    memberIds: [],
    createdAt: Date.now(),
    count: 0,
    ...(group ? { group: true } : {}),
  };
  await putChannel(env, channel);
  await putKeyPointer(env, channel.key, channel.id);
  return channel;
}

export async function addChannel(
  env: Env,
  account: Account,
  name: string,
  icon?: string,
  group = false,
): Promise<Channel> {
  const channel = await createChannelRecord(env, account.id, name, icon, group);
  account.channelIds.push(channel.id);
  await putAccount(env, account);
  return channel;
}

export function roleOf(channel: Channel, accountId: string): "owner" | "member" | null {
  if (channel.ownerId === accountId) return "owner";
  if (channel.memberIds.includes(accountId)) return "member";
  return null;
}

/**
 * 列出账号能看到的通道。**以通道自己的成员名单为准**，账号上的 id 列表只是索引。
 *
 * 两者在中途失败时可能短暂不一致（见 joinChannel）；以名单为准，
 * 不一致的那一侧就被自然滤掉，不会出现「列表里有、却收不到」的状态。
 */
export async function listChannels(env: Env, account: Account): Promise<Channel[]> {
  const found = await Promise.all(account.channelIds.map((id) => getChannel(env, id)));
  return found.filter((c): c is Channel => c !== null && roleOf(c, account.id) !== null);
}

/**
 * 推送热路径：key → 通道 → 所有接收者（创建者 + 成员）。
 *
 * 读取次数是 3 + 人数（通道记录和停用标记并发读）。群组有上限，这个量级可以接受；
 * 换来的是设备列表只存一份在各自账号上，增删设备不必回写任何通道。
 */
export async function resolveChannel(
  env: Env,
  key: string,
): Promise<{ channel: Channel; recipients: Account[] } | null> {
  if (!isValidId(key)) return null;
  let pointer = await env.PIGEON_KV.get<Partial<KeyPointer> & { accountId?: string }>(
    KEY + key,
    "json",
  );
  if (!pointer) return null;

  // 旧指针指向的是账号而不是通道：先让那个账号完成迁移（会重写指针），再重读
  if (!pointer.id && pointer.accountId) {
    await getAccount(env, pointer.accountId);
    pointer = await env.PIGEON_KV.get<Partial<KeyPointer>>(KEY + key, "json");
  }
  if (!pointer?.id) return null;

  const channel = await getChannel(env, pointer.id);
  // key 换过之后，旧指针即使因为某次失败没删干净，也不能再生效
  if (!channel || channel.key !== key) return null;
  return { channel, recipients: await recipientsOf(env, channel) };
}

/** 通道的全部接收者：创建者 + 成员。已经不存在的账号自然被跳过 */
export async function recipientsOf(env: Env, channel: Channel): Promise<Account[]> {
  const accounts = await Promise.all(
    [channel.ownerId, ...channel.memberIds].map((id) => getAccount(env, id)),
  );
  return accounts.filter((a): a is Account => a !== null);
}

/**
 * 换 key：旧地址立即作废。地址泄漏或者被滥发时的止损手段。
 *
 * 顺序刻意：先写新指针、再改通道、最后删旧指针。中途失败时旧地址仍然有效
 * （通道记录里还是旧 key），不会出现新旧两个地址同时失效的窗口 ——
 * 对告警系统来说，「暂时没换成」远好过「暂时谁都推不进来」。
 */
export async function rotateKey(env: Env, channel: Channel): Promise<string> {
  const oldKey = channel.key;
  const newKey = newId();
  await putKeyPointer(env, newKey, channel.id);
  channel.key = newKey;
  await putChannel(env, channel);
  await env.PIGEON_KV.delete(KEY + oldKey);
  return newKey;
}

/**
 * 删除通道：所有成员一起失去它。先让 key 失效，删到一半也不会再有推送进来。
 * 推给它的监控和心跳随后一起删 —— 它们是另一个推送来源，通道没了也不该再跑、再留着。
 * watchesDone：调用方已经把这个人的监控删完了（删账号时），不必再查一遍
 */
export async function deleteChannel(
  env: Env,
  channel: Channel,
  options: { watchesDone?: boolean } = {},
): Promise<void> {
  await env.PIGEON_KV.delete(KEY + channel.key);
  if (!options.watchesDone) await deleteWatchesOf(env, channel.ownerId, channel.id);
  await env.PIGEON_KV.delete(CHANNEL + channel.id);
  for (const id of [channel.ownerId, ...channel.memberIds]) {
    const account = await getAccount(env, id);
    if (!account) continue;
    account.channelIds = account.channelIds.filter((c) => c !== channel.id);
    forgetChannel(account, channel.id);
    await putAccount(env, account);
  }
  // 挂在通道 id 上的附属记录一起清掉。放在最后：通道已经没了，这些留着也不起作用。
  // 回调密钥（cbsec:，见 receipts.ts）没有 TTL，通道删了必须顺手删掉；回执 rcpt: 有 7 天 TTL，交给它自己过期
  await env.PIGEON_KV.delete(STAT + channel.id);
  await env.PIGEON_KV.delete(SUSPENDED + channel.id);
  await env.PIGEON_KV.delete(`cbsec:${channel.id}`);
}

/** 通道离开了这个人的列表：连带清掉他为它设的置顶、免打扰、分组归属、铃声、备注名、图片开关和保管的密钥 */
export function forgetChannel(account: Account, channelId: string): void {
  const prefs = account.prefs;
  if (prefs) {
    if (prefs.pins) prefs.pins = prefs.pins.filter((id) => id !== channelId);
    if (prefs.mutes) delete prefs.mutes[channelId];
    if (prefs.folderOf) delete prefs.folderOf[channelId];
    if (prefs.sounds) delete prefs.sounds[channelId];
    if (prefs.aliases) delete prefs.aliases[channelId];
    if (prefs.images) delete prefs.images[channelId];
  }
  if (account.wrappedKeys) delete account.wrappedKeys[channelId];
}

// ── 成员 ────────────────────────────────────────────────────────────

export async function createInvite(
  env: Env,
  channel: Channel,
  createdBy: string,
): Promise<Invite> {
  const now = Date.now();
  const invite: Invite = {
    code: newInviteCode(),
    channelId: channel.id,
    createdBy,
    createdAt: now,
    expiresAt: now + INVITE_TTL_SECONDS * 1000,
  };
  // 到期由 KV 自动删除，不留过期邀请的残骸
  await env.PIGEON_KV.put(INVITE + invite.code, JSON.stringify(invite), {
    expirationTtl: INVITE_TTL_SECONDS,
  });
  return invite;
}

export async function getInvite(env: Env, code: string): Promise<Invite | null> {
  // 落地页和 App 里都按 4-4 分组显示（ABCD 2345），有人会连空格、连字符一起敲进来。
  // App 端解析时已经去掉了，这里再做一遍，直接调接口的人也不必记这条规矩
  const normalized = code.replace(/[\s-]/g, "").toUpperCase();
  if (!INVITE_RE.test(normalized)) return null;
  const invite = await env.PIGEON_KV.get<Invite>(INVITE + normalized, "json");
  // KV 的过期是最终一致的，到点后可能还能读到一会儿 —— 自己再核一次时间
  if (!invite || invite.expiresAt < Date.now()) return null;
  return invite;
}

export type JoinResult = "joined" | "already" | "owner" | "full";

/**
 * 加入通道。先写账号索引，再写通道成员名单 —— **成员名单是提交点**。
 *
 * 两步不是原子的。按这个顺序，中途失败只会留下一条孤立的索引：listChannels
 * 以成员名单为准会把它滤掉，用户看不到这个通道、也收不到推送，等于没加入，
 * 重试即可。反过来的顺序失败了，就是能收到推送、却在列表里找不到通道 ——
 * 用户想退都无从退起。
 */
export async function joinChannel(
  env: Env,
  channel: Channel,
  account: Account,
): Promise<JoinResult> {
  if (channel.ownerId === account.id) return "owner";
  const alreadyMember = channel.memberIds.includes(account.id);
  if (!alreadyMember && channel.memberIds.length >= MAX_MEMBERS) return "full";

  if (!account.channelIds.includes(channel.id)) {
    account.channelIds.push(channel.id);
    await putAccount(env, account);
  }
  // 已经是成员时顺手补齐索引（上面那步），修复任何历史遗留的不一致
  if (alreadyMember) return "already";

  channel.memberIds.push(account.id);
  await putChannel(env, channel);
  return "joined";
}

/** 退出：先从成员名单拿掉（立即停止接收），再清账号索引 */
export async function leaveChannel(env: Env, channel: Channel, account: Account): Promise<void> {
  channel.memberIds = channel.memberIds.filter((id) => id !== account.id);
  await putChannel(env, channel);
  account.channelIds = account.channelIds.filter((id) => id !== channel.id);
  forgetChannel(account, channel.id);
  await putAccount(env, account);
}

export async function removeMember(env: Env, channel: Channel, memberId: string): Promise<boolean> {
  if (!channel.memberIds.includes(memberId)) return false;
  channel.memberIds = channel.memberIds.filter((id) => id !== memberId);
  await putChannel(env, channel);
  const member = await getAccount(env, memberId);
  if (member) {
    member.channelIds = member.channelIds.filter((id) => id !== channel.id);
    forgetChannel(member, channel.id);
    await putAccount(env, member);
  }
  return true;
}

// ── 翻页列键 ────────────────────────────────────────────────────────

/** 某个前缀下的全部键，连同 metadata。KV 一页最多 1000 个，翻页取全 —— 只取第一页，多出来的就静悄悄地漏了 */
export async function listEntries<M = unknown>(
  env: Env,
  prefix: string,
): Promise<{ name: string; metadata: M | null }[]> {
  const entries: { name: string; metadata: M | null }[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await env.PIGEON_KV.list<M>({ prefix, cursor });
    for (const key of page.keys) entries.push({ name: key.name, metadata: key.metadata ?? null });
    if (page.list_complete) return entries;
    cursor = page.cursor;
  }
}

/** 某个前缀下的全部键名 */
export async function listKeys(env: Env, prefix: string): Promise<string[]> {
  return (await listEntries(env, prefix)).map((entry) => entry.name);
}

// ── 监控存储 ────────────────────────────────────────────────────────

/*
 * 一个监控分几把键存（判定逻辑在 watch.ts）：
 *   watch:{id}                  配置：推给哪个通道、网址、间隔、暂停与维护窗口。只在新建和编辑时写，报到和 cron 都不改它
 *   wown:{创建者 id}:{id}       按人的索引，metadata 带通道 id 和类型。列「我的监控」、删号删通道都靠它找全
 *   hbstate:{id} / wstate:{id}  心跳 / 网址监控会变的那几项。metadata 里原样再放一份，外加下一次该看它的时刻 ——
 *                               cron 翻一遍键就知道哪些到期了，没到期的一条也不读。
 *                               值里另有历史（状态变化、响应时间、按小时的可用时长），跟状态同一次写入，不进 metadata
 *   watchdel:{id}               删除后的墓碑，10 分钟
 *
 * 原先整条监控存在 watch:{id} 一个键里，报到和 cron 读—改—写整条记录：删掉的监控会被晚到一步的报到
 * 整条写回去，死而复生；按人列监控要把全站的监控逐条读一遍；删号删通道时无从找起，监控就一直留着。
 *
 * 老数据照样认：状态还写在 watch:{id} 里，也没有索引。状态键还没有时拿配置里的旧字段顶上（mergeWatch）；
 * 索引由 cron 逐条补建（watch.ts runScheduled），补完之前，按人找监控退回全表扫描兜底。
 */
const WATCH = "watch:";
const WATCH_OWNER = "wown:";
const WATCH_STATE_HEARTBEAT = "hbstate:";
const WATCH_STATE_SITE = "wstate:";
const WATCH_DELETED = "watchdel:";
/** 老监控全部补进索引之后，cron 写下这个标记，按人找监控就不再全表扫描 */
const CONFIG_WATCHES_INDEXED = "config:watches_indexed";

/**
 * 墓碑留 10 分钟。删除要最长约 60 秒才传到别的机房，那边拿着旧配置的报到和 cron 这段时间里
 * 还以为监控在；墓碑是一把新键，读得到就知道删了。10 分钟远超这个窗口，也盖得住一轮 cron 的抓取
 */
export const WATCH_TOMBSTONE_TTL_SECONDS = 10 * 60;
/**
 * 配置已经没了、状态键或索引却还在的残键，放这么久才清：刚建的监控在别的机房一时可能还列不出配置，
 * 过了这个时长还是孤零零的，才是删到一半、或者删掉之后晚到的报到又写了一次状态留下的
 */
export const WATCH_LEFTOVER_GRACE_MS = 10 * 60_000;

/** 监控里会变的几项：报到和 cron 只写它们，存在状态键里。以后加的状态字段也列在这里 */
const WATCH_STATE_FIELDS = [
  "lastStatus", "lastCheckedAt", "lastPingAt",
  "failCount", "timeoutCount", "pausedAt", "lastDetail", "pendingAlertAttempts",
  "quiet", "startedAt", "history",
] as const;
export type WatchState = Pick<Watch, (typeof WATCH_STATE_FIELDS)[number]>;

/**
 * 状态键的值。除了 history，也原样放进它的 metadata（很小：失败说明截到 60 字，整条远不到 1KB 的上限）。
 * history 只在值里：几 KB，放不进 metadata 的 1KB，cron 翻键时也用不着它
 */
export interface StoredWatchState extends WatchState {
  kind: Watch["kind"];
  /** 下一次该看它的时刻（毫秒）。0 表示不用排队：心跳还没报到过（new），或者已经告过警（down） */
  nextDueAt: number;
  /** 写入时刻。清残键时看它够不够老 */
  at: number;
}

/** 索引键的 metadata */
interface WatchIndexMeta {
  channelId: string;
  kind: Watch["kind"];
  /** 监控的创建时刻。清残键时看它够不够老 */
  at: number;
}

/** 按人找出来的一个监控：删除、按通道挑选都够用了，不必读配置 */
export interface WatchRef {
  id: string;
  ownerId: string;
  channelId?: string;
  kind?: Watch["kind"];
}

function watchStateKey(kind: Watch["kind"], id: string): string {
  return (kind === "heartbeat" ? WATCH_STATE_HEARTBEAT : WATCH_STATE_SITE) + id;
}

function watchOwnerKey(ownerId: string, id: string): string {
  return `${WATCH_OWNER}${ownerId}:${id}`;
}

function pickWatchState(source: object): WatchState {
  const state: Record<string, unknown> = {};
  for (const field of WATCH_STATE_FIELDS) {
    const value = (source as Record<string, unknown>)[field];
    if (value !== undefined && value !== null) state[field] = value;
  }
  return state as WatchState;
}

/** 去掉状态字段，剩下的就是配置 */
function watchConfig(watch: Watch): Watch {
  const config: Record<string, unknown> = { ...watch };
  for (const field of WATCH_STATE_FIELDS) delete config[field];
  return config as unknown as Watch;
}

/**
 * 配置 + 状态 → 对外的 Watch。没有状态键时用配置里的旧字段（改版之前的老数据），
 * 再没有就是初始状态：心跳是 new（还没报到过），网址监控什么都没有（还没检查过）
 */
export function mergeWatch(stored: Watch, state: object | null): Watch {
  const current = pickWatchState(state ?? stored);
  if (stored.kind === "heartbeat" && current.lastStatus === undefined) current.lastStatus = "new";
  return { ...watchConfig(stored), ...current };
}

/** 配置原样，老数据里还带着状态字段。报到和 cron 要自己配状态，用这个；别处用 getWatch */
export async function readWatchConfig(env: Env, id: string): Promise<Watch | null> {
  if (!isValidId(id)) return null;
  return env.PIGEON_KV.get<Watch>(WATCH + id, "json");
}

export async function readWatchState(env: Env, kind: Watch["kind"], id: string): Promise<StoredWatchState | null> {
  if (!isValidId(id)) return null;
  return env.PIGEON_KV.get<StoredWatchState>(watchStateKey(kind, id), "json");
}

export async function getWatch(env: Env, id: string): Promise<Watch | null> {
  const stored = await readWatchConfig(env, id);
  if (!stored) return null;
  return mergeWatch(stored, await readWatchState(env, stored.kind, id));
}

/**
 * 写状态。值和 metadata 是同一份：报到按 id 读值；cron 翻键时 metadata 随列表一起回来，不用逐条读。
 * nextDueAt 由调用方按监控的类型算好（见 watch.ts）
 */
export async function writeWatchState(
  env: Env,
  watch: Watch,
  nextDueAt: number,
  now: number = Date.now(),
): Promise<StoredWatchState> {
  const record: StoredWatchState = { ...pickWatchState(watch), kind: watch.kind, nextDueAt, at: now };
  const { history: _history, ...metadata } = record;
  await env.PIGEON_KV.put(watchStateKey(watch.kind, watch.id), JSON.stringify(record), { metadata });
  return record;
}

/**
 * 编辑后写回配置（状态字段剥掉，照旧只在状态键里）。调用方负责校验和墓碑检查（见 routes/watches.ts）
 */
export async function putWatchConfig(env: Env, watch: Watch): Promise<Watch> {
  const config = watchConfig(watch);
  await env.PIGEON_KV.put(WATCH + config.id, JSON.stringify(config));
  return config;
}

/** 把监控记进创建者的索引。新建时写；老数据由 cron 补 */
export async function indexWatch(
  env: Env,
  watch: Pick<Watch, "id" | "ownerId" | "channelId" | "kind" | "createdAt">,
): Promise<void> {
  const meta: WatchIndexMeta = { channelId: watch.channelId, kind: watch.kind, at: watch.createdAt };
  await env.PIGEON_KV.put(watchOwnerKey(watch.ownerId, watch.id), "1", { metadata: meta });
}

export async function createWatch(
  env: Env,
  ownerId: string,
  input: Omit<Watch, "id" | "ownerId" | "createdAt">,
): Promise<Watch> {
  const config = watchConfig({ id: newId(), ownerId, createdAt: Date.now(), ...input });
  // 先写索引：中途失败只留下一条指向空处的索引，列表里自然跳过，cron 过后清掉。
  // 反过来会留下一个照样在跑、却不在任何人列表里的监控，要等 cron 补上索引才看得见、删得掉
  await indexWatch(env, config);
  await env.PIGEON_KV.put(WATCH + config.id, JSON.stringify(config));
  // 状态键等第一次报到或检查时再写：没有状态键就是初始状态
  return mergeWatch(config, null);
}

/** 这个实例已经确认索引补全了：标记只会从无到有，确认过就不必再读。按 KV 绑定分开记，测试里各用各的库 */
const watchesIndexedKnown = new WeakSet<object>();

export async function watchIndexComplete(env: Env): Promise<boolean> {
  if (watchesIndexedKnown.has(env.PIGEON_KV)) return true;
  const done = (await env.PIGEON_KV.get(CONFIG_WATCHES_INDEXED)) !== null;
  if (done) watchesIndexedKnown.add(env.PIGEON_KV);
  return done;
}

export async function markWatchIndexComplete(env: Env, now: number = Date.now()): Promise<void> {
  await env.PIGEON_KV.put(CONFIG_WATCHES_INDEXED, JSON.stringify({ at: now }));
  watchesIndexedKnown.add(env.PIGEON_KV);
}

/** 还没进索引的监控配置（改版之前的老数据）。全表翻一遍键，只读没进索引的那些 */
async function unindexedWatches(env: Env): Promise<Watch[]> {
  const [configs, index] = await Promise.all([listKeys(env, WATCH), listKeys(env, WATCH_OWNER)]);
  const indexed = new Set(index.map((name) => name.slice(name.lastIndexOf(":") + 1)));
  const missing = configs.map((name) => name.slice(WATCH.length)).filter((id) => !indexed.has(id));
  // 一条坏掉的老记录不能连累所有人的监控列表
  const found = await Promise.all(missing.map((id) => readWatchConfig(env, id).catch(() => null)));
  return found.filter((w): w is Watch => w !== null);
}

/**
 * 这个人的全部监控，只到索引这一层。老监控全部补进索引之前，还得全表扫一遍、把还没进索引的
 * 老记录挑出来 —— 否则刚上线这几分钟，老用户的监控在列表里凭空消失，删号时也漏删
 */
export async function ownedWatchRefs(env: Env, ownerId: string): Promise<WatchRef[]> {
  const prefix = watchOwnerKey(ownerId, "");
  const refs = new Map<string, WatchRef>();
  for (const { name, metadata } of await listEntries<Partial<WatchIndexMeta>>(env, prefix)) {
    const id = name.slice(prefix.length);
    refs.set(id, { id, ownerId, channelId: metadata?.channelId, kind: metadata?.kind });
  }
  if (!(await watchIndexComplete(env))) {
    for (const legacy of await unindexedWatches(env)) {
      if (legacy.ownerId !== ownerId || refs.has(legacy.id)) continue;
      refs.set(legacy.id, { id: legacy.id, ownerId, channelId: legacy.channelId, kind: legacy.kind });
    }
  }
  return [...refs.values()];
}

/** 这个人建的监控有几个。只数索引，不读配置 */
export async function countWatches(env: Env, ownerId: string): Promise<number> {
  return (await ownedWatchRefs(env, ownerId)).length;
}

/** 这个人建的全部监控，按创建先后。只读他自己的 */
export async function listWatches(env: Env, ownerId: string): Promise<Watch[]> {
  const refs = await ownedWatchRefs(env, ownerId);
  const found = await Promise.all(
    refs.map(async (ref) => {
      try {
        // 索引里记着类型，配置和状态可以一起读
        const [stored, state] = await Promise.all([
          readWatchConfig(env, ref.id),
          ref.kind ? readWatchState(env, ref.kind, ref.id) : Promise.resolve(null),
        ]);
        // 索引指向空处（刚删掉、或者建到一半），或者配置不是这个人的：都不算
        if (!stored || stored.ownerId !== ownerId) return null;
        return mergeWatch(stored, stored.kind === ref.kind ? state : await readWatchState(env, stored.kind, ref.id));
      } catch {
        // 一条坏掉的记录不连累整张列表
        return null;
      }
    }),
  );
  return found.filter((w): w is Watch => w !== null).sort((a, b) => a.createdAt - b.createdAt);
}

/** 这个监控刚被删过（墓碑还在） */
export async function isWatchDeleted(env: Env, id: string): Promise<boolean> {
  return (await env.PIGEON_KV.get(WATCH_DELETED + id)) !== null;
}

/**
 * 删一个监控：配置、状态、索引，外加一块 10 分钟的墓碑。
 *
 * 墓碑最先立：删到一半、或者别的机房一时还读得到旧配置的这段时间里，报到和 cron 写状态之前都先看它，
 * 就不会把状态写回去（配置它们本来就不写）。索引最后删：前面哪步失败了，重来时还按索引找得到它
 */
export async function deleteWatch(
  env: Env,
  target: string | Pick<Watch, "id" | "ownerId">,
  now: number = Date.now(),
): Promise<void> {
  const id = typeof target === "string" ? target : target.id;
  if (!isValidId(id)) return;
  const ownerId = typeof target === "string" ? (await readWatchConfig(env, id))?.ownerId : target.ownerId;
  await env.PIGEON_KV.put(WATCH_DELETED + id, JSON.stringify({ at: now }), {
    expirationTtl: WATCH_TOMBSTONE_TTL_SECONDS,
  });
  await Promise.all([
    env.PIGEON_KV.delete(WATCH + id),
    env.PIGEON_KV.delete(WATCH_STATE_HEARTBEAT + id),
    env.PIGEON_KV.delete(WATCH_STATE_SITE + id),
  ]);
  if (ownerId) await env.PIGEON_KV.delete(watchOwnerKey(ownerId, id));
}

/** 删掉这个人建的监控；给了通道就只删推给这个通道的。返回删了几个 */
export async function deleteWatchesOf(
  env: Env,
  ownerId: string,
  channelId?: string,
  now: number = Date.now(),
): Promise<number> {
  const refs = await ownedWatchRefs(env, ownerId);
  const chosen = await Promise.all(
    refs.map(async (ref) => {
      if (channelId === undefined) return ref;
      // 索引里没记通道的（按说没有）读一次配置再判断
      const target = ref.channelId ?? (await readWatchConfig(env, ref.id))?.channelId;
      return target === channelId ? ref : null;
    }),
  );
  const targets = chosen.filter((ref): ref is WatchRef => ref !== null);
  await Promise.all(targets.map((ref) => deleteWatch(env, ref, now)));
  return targets.length;
}

/** cron 每轮翻一遍的全部监控键。只列键和 metadata，一条值也不读 */
export interface WatchCatalog {
  /** 有配置的监控 id */
  configs: Set<string>;
  /** 索引：监控 id → 创建者和 metadata */
  index: Map<string, { key: string; ownerId: string; meta: Partial<WatchIndexMeta> | null }>;
  /** 状态键：监控 id → 键名、按前缀得出的类别、metadata（读不出来是 null） */
  states: Map<string, { key: string; heartbeat: boolean; state: StoredWatchState | null }>;
}

export async function watchCatalog(env: Env): Promise<WatchCatalog> {
  const [configs, index, heartbeats, sites] = await Promise.all([
    listKeys(env, WATCH),
    listEntries<Partial<WatchIndexMeta>>(env, WATCH_OWNER),
    listEntries<StoredWatchState>(env, WATCH_STATE_HEARTBEAT),
    listEntries<StoredWatchState>(env, WATCH_STATE_SITE),
  ]);
  const catalog: WatchCatalog = {
    configs: new Set(configs.map((name) => name.slice(WATCH.length))),
    index: new Map(),
    states: new Map(),
  };
  for (const { name, metadata } of index) {
    const [ownerId = "", id = ""] = name.slice(WATCH_OWNER.length).split(":");
    catalog.index.set(id, { key: name, ownerId, meta: metadata });
  }
  for (const [prefix, entries] of [[WATCH_STATE_HEARTBEAT, heartbeats], [WATCH_STATE_SITE, sites]] as const) {
    for (const { name, metadata } of entries) {
      const state = metadata && typeof metadata.nextDueAt === "number" ? metadata : null;
      catalog.states.set(name.slice(prefix.length), { key: name, heartbeat: prefix === WATCH_STATE_HEARTBEAT, state });
    }
  }
  return catalog;
}

/**
 * 清残键：状态键或索引还在，配置却没了 —— 删到一半失败了，或者删掉之后晚到的报到、cron 又写了一次状态。
 * 放够 WATCH_LEFTOVER_GRACE_MS 才清（见那里）。返回清了几把
 */
export async function removeWatchLeftovers(env: Env, catalog: WatchCatalog, now: number = Date.now()): Promise<number> {
  const stale: string[] = [];
  for (const [id, entry] of catalog.states) {
    if (!catalog.configs.has(id) && now - (entry.state?.at ?? 0) >= WATCH_LEFTOVER_GRACE_MS) stale.push(entry.key);
  }
  for (const [id, entry] of catalog.index) {
    if (!catalog.configs.has(id) && now - (entry.meta?.at ?? 0) >= WATCH_LEFTOVER_GRACE_MS) stale.push(entry.key);
  }
  let removed = 0;
  for (const key of stale) {
    try {
      await env.PIGEON_KV.delete(key);
      removed += 1;
    } catch {
      // 下一轮再清
    }
  }
  return removed;
}

/** 本地测试用（/__test__）：某个监控在 KV 里留下了哪些键，连同它们的 metadata */
export async function watchFootprint(
  env: Env,
  id: string,
): Promise<{ keys: { name: string; metadata: unknown }[]; config: Watch | null }> {
  const lists = await Promise.all(
    [WATCH, WATCH_STATE_HEARTBEAT, WATCH_STATE_SITE, WATCH_DELETED].map((prefix) => listEntries(env, prefix + id)),
  );
  const owners = (await listEntries(env, WATCH_OWNER)).filter((entry) => entry.name.endsWith(`:${id}`));
  return { keys: [...lists.flat(), ...owners], config: await readWatchConfig(env, id) };
}

// ── 定时巡检 ────────────────────────────────────────────────────────

/**
 * 数着子请求的 env。Cloudflare 每次调用最多 1000 个子请求，KV 操作和对外的 fetch（APNs、抓网址）合在一起算，
 * 超了之后的每一次都抛错 —— cron 一轮要处理的监控、提醒一多，排在后面的就会静悄悄地全部失败。
 * 巡检拿它数着用了多少，快到上限就不再开始新的，剩下的顺延到下一轮（见 watch.ts runScheduled、push.ts runReminders）。
 *
 * fetch 靠 env.countFetch 数：APNs 在 apns.ts 里发请求前调它，抓网址由巡检自己调
 */
export function meteredEnv(env: Env): { env: Env; ops: () => number; fetches: () => number; used: () => number } {
  const kv = env.PIGEON_KV;
  let count = 0;
  let fetches = 0;
  const counted = (name: "get" | "getWithMetadata" | "put" | "delete" | "list") =>
    (...args: unknown[]): unknown => {
      count += 1;
      return (kv[name] as (...a: unknown[]) => unknown).apply(kv, args);
    };
  const metered = {
    get: counted("get"),
    getWithMetadata: counted("getWithMetadata"),
    put: counted("put"),
    delete: counted("delete"),
    list: counted("list"),
  } as unknown as KVNamespace;
  // 外面已经在数了（巡检里再套一层）：两边都记上
  const outer = env.countFetch;
  const countFetch = (): void => {
    fetches += 1;
    outer?.();
  };
  return {
    env: { ...env, PIGEON_KV: metered, countFetch },
    ops: () => count,
    fetches: () => fetches,
    used: () => count + fetches,
  };
}

/**
 * 每轮巡检的记录，监控、重复提醒各留最近一轮：什么时候跑的、处理了多少、多少出错。
 * /info 对外报最近一轮的时刻 —— cron 停了从外面就看得出来。只有时刻和条数，不含任何用户数据
 */
const SWEEP = "sweep:";
export type SweepKind = "watches" | "reminders";
export type SweepRecord = { at: number } & Record<string, number | boolean>;
/** 巡检出了问题通知运营者，每类最多一小时一次：一直坏着的话，每 5 分钟响一次只会让人把审核通道静音 */
export const SWEEP_NOTICE_TTL_SECONDS = 3600;

export async function recordSweep(env: Env, kind: SweepKind, record: SweepRecord): Promise<void> {
  await env.PIGEON_KV.put(SWEEP + kind, JSON.stringify(record));
}

export async function readSweep(env: Env, kind: SweepKind): Promise<SweepRecord | null> {
  // /info 谁都能调：读的时候让边缘缓存一分钟，刷它也打不到存储上。记录 5 分钟才变一次
  const raw = await env.PIGEON_KV.get(SWEEP + kind, { cacheTtl: 60 });
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SweepRecord> | null;
    return parsed && typeof parsed.at === "number" ? (parsed as SweepRecord) : null;
  } catch {
    return null;
  }
}

/** 最近一轮监控巡检、重复提醒巡检各是什么时候。读不到的是 null */
export async function lastSweepTimes(env: Env): Promise<Record<SweepKind, number | null>> {
  const [watches, reminders] = await Promise.all([
    readSweep(env, "watches").catch(() => null),
    readSweep(env, "reminders").catch(() => null),
  ]);
  return { watches: watches?.at ?? null, reminders: reminders?.at ?? null };
}

/**
 * 这一小时里还没为这类巡检通知过运营者：记下「通知过了」，返回 true；已经通知过返回 false。
 * 先读后写不是原子的，两处同时出错顶多各通知一次
 */
export async function claimSweepNotice(env: Env, kind: SweepKind, now: number = Date.now()): Promise<boolean> {
  const key = `${SWEEP}notified:${kind}`;
  if ((await env.PIGEON_KV.get(key)) !== null) return false;
  await env.PIGEON_KV.put(key, JSON.stringify({ at: now }), { expirationTtl: SWEEP_NOTICE_TTL_SECONDS });
  return true;
}

// ── 删除账号 ────────────────────────────────────────────────────────

/**
 * 删除账号：服务端上和这个人有关的记录全部清掉。
 *
 * 自己建的监控和心跳、自己建的通道整个删除（成员一起失去它，地址立即失效），加入的群组退出，
 * 最后删账号本身。顺序刻意：先断掉所有推送入口（监控也会往通道里推），删到一半失败也不会再有
 * 推送进来；账号记录放在最后，中途失败时用户还能凭 secret 再删一次，而不是落得「账号没了、通道还在」。
 */
export async function deleteAccount(env: Env, account: Account): Promise<void> {
  // 按人一次删完，下面逐个删通道时就不必每个通道再查一遍
  await deleteWatchesOf(env, account.id);
  for (const channel of await listChannels(env, account)) {
    if (channel.ownerId === account.id) await deleteChannel(env, channel, { watchesDone: true });
    else await leaveChannel(env, channel, account);
  }
  // 这个账号移除设备时立的墓碑：账号没了，它们再也拦不着谁，留着只是多存一份「哪台设备在这个账号里待过」
  for (const name of await listKeys(env, `${REMOVED_DEVICE}${account.id}:`)) {
    await env.PIGEON_KV.delete(name);
  }
  await env.PIGEON_KV.delete(ACCOUNT + account.id);
}

// ── 个人偏好 ────────────────────────────────────────────────────────

export const MAX_FOLDERS = 20;
const FOLDER_NAME_MAX = 20;
/** 限时免打扰最长一年；更久就该用「一直免打扰」（0） */
const MUTE_MAX_MS = 366 * 24 * 3600 * 1000;

/** 铃声文件名：只允许字母数字点划线，且必须以 .caf 结尾 —— 挡掉 ../ 和绝对路径 */
const SOUND_FILE = /^[A-Za-z0-9_-]{1,60}\.caf$/;
/** 一个账号最多记多少条铃声选择 */
const MAX_SOUNDS = 200;
/** 备注名与通道名同一个长度上限 */
const ALIAS_MAX = 40;
const MAX_ALIASES = 200;
/** 图片开关的条数上限。一个账号最多 100 个通道，留足余量 */
const MAX_IMAGES = 200;

/**
 * 表类偏好：以通道 id 为键的对象。prefs_patch 对它们逐条合并，其余偏好（置顶、分组这样的数组，
 * 默认铃声这样的单值）整项替换（见 patchPrefs）。
 * 以后再加「通道 id → 值」这种偏好，要加进这里 —— 不加的话它按整项替换，两台设备各改一条又会互相覆盖
 */
export const TABLE_PREFS: readonly (keyof AccountPrefs)[] = ["mutes", "folderOf", "sounds", "aliases", "images"];
const TABLE_PREF_SET = new Set<string>(TABLE_PREFS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把 PATCH /account 的 prefs_patch 合并到现有偏好上。返回的还没清洗，调用方要再过一遍 sanitizePrefs。
 *
 * 原先 App 每次都把整份偏好交上来、服务端整份替换：一台设备手里的旧快照，会把另一台设备刚设的
 * 置顶、免打扰、铃声、备注名悄悄抹掉。现在 App 只交改了的那几项、那几条：
 * - 顶层值为 null：删掉这一项
 * - 表类偏好给的是对象：逐条合并，条目值为 null 表示删掉这一条
 * - 其余：整项替换
 *
 * 表类偏好给了个不是对象的值（数组、字符串）：当坏数据丢掉，原有的不动 —— 照「整项替换」办，
 * 清洗之后整张表就没了，一个出错的客户端就能把人家所有的免打扰清空
 */
export function patchPrefs(
  current: AccountPrefs | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    // JSON 里的 "__proto__" 只是个普通键名，赋值时却会改掉对象的原型
    if (key === "__proto__") continue;
    if (value === null) {
      delete merged[key];
      continue;
    }
    if (!TABLE_PREF_SET.has(key)) {
      merged[key] = value;
      continue;
    }
    if (!isPlainObject(value)) continue;
    // 复制一份再改：现有偏好是账号记录里的对象，清洗失败也不该把它改了一半
    const base = merged[key];
    const table: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
    for (const [id, entry] of Object.entries(value)) {
      if (id === "__proto__") continue;
      if (entry === null) delete table[id];
      else table[id] = entry;
    }
    merged[key] = table;
  }
  return merged;
}

/**
 * 已经上线的老版 App（1.0 (15)）不认识的偏好项。它交整份偏好时压根不带这些键 —— 照整份替换办，
 * 同一账号另一台新版设备设的图片开关，会被老设备随手改个置顶就清空。所以整份提交里没提到的这几项
 * 原样保留，要清空得明说（给空对象，或用 prefs_patch 给 null）。以后再加偏好项也加进来；
 * 新版 App 用 prefs_patch，不受影响
 */
export const PREFS_KEPT_ON_REPLACE: readonly (keyof AccountPrefs)[] = ["images"];

/** PATCH /account 的 prefs（整份替换）：换成提交的这份，老版 App 不认识的项没提到就留着。返回的还没清洗 */
export function replacePrefs(current: AccountPrefs | undefined, raw: unknown): Record<string, unknown> {
  const next: Record<string, unknown> = isPlainObject(raw) ? { ...raw } : {};
  for (const key of PREFS_KEPT_ON_REPLACE) {
    if (!(key in next) && current?.[key] !== undefined) next[key] = current[key];
  }
  return next;
}

/**
 * 清洗偏好。整份提交（prefs，见 replacePrefs）和按项合并（prefs_patch，见 patchPrefs）的结果都过这一遍。
 *
 * 只保留格式合法、指向真实存在的东西的条目：不认识的通道、不存在的分组、已经过期的免打扰
 * 都丢掉，否则账号记录会被垃圾数据慢慢撑大。
 */
export function sanitizePrefs(raw: unknown, channelIds: string[], now = Date.now()): AccountPrefs {
  const known = new Set(channelIds);
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const prefs: AccountPrefs = {};

  if (Array.isArray(input.pins)) {
    const pins = [
      ...new Set(input.pins.filter((id): id is string => typeof id === "string" && known.has(id))),
    ];
    if (pins.length) prefs.pins = pins;
  }

  if (input.mutes && typeof input.mutes === "object") {
    const mutes: Record<string, number> = {};
    for (const [id, until] of Object.entries(input.mutes as Record<string, unknown>)) {
      if (!known.has(id) || typeof until !== "number" || !Number.isFinite(until)) continue;
      if (until === 0) mutes[id] = 0;
      else if (until > now) mutes[id] = Math.min(Math.floor(until), now + MUTE_MAX_MS);
    }
    if (Object.keys(mutes).length) prefs.mutes = mutes;
  }

  if (Array.isArray(input.folders)) {
    const folders: Folder[] = [];
    const ids = new Set<string>();
    for (const item of input.folders) {
      if (!item || typeof item !== "object") continue;
      const id = String((item as Record<string, unknown>).id ?? "");
      const name = String((item as Record<string, unknown>).name ?? "").trim().slice(0, FOLDER_NAME_MAX);
      if (!isValidId(id) || !name || ids.has(id)) continue;
      ids.add(id);
      folders.push({ id, name });
      if (folders.length >= MAX_FOLDERS) break;
    }
    if (folders.length) prefs.folders = folders;

    if (input.folderOf && typeof input.folderOf === "object") {
      const folderOf: Record<string, string> = {};
      for (const [channelId, folderId] of Object.entries(input.folderOf as Record<string, unknown>)) {
        if (known.has(channelId) && typeof folderId === "string" && ids.has(folderId)) {
          folderOf[channelId] = folderId;
        }
      }
      if (Object.keys(folderOf).length) prefs.folderOf = folderOf;
    }
  }

  if (input.sounds && typeof input.sounds === "object") {
    const sounds: Record<string, string> = {};
    for (const [channelId, file] of Object.entries(input.sounds as Record<string, unknown>)) {
      if (!known.has(channelId) || typeof file !== "string") continue;
      // 这个值会变成别的设备上的铃声文件名，必须是纯文件名：不能带路径、不能回退上级目录
      if (!SOUND_FILE.test(file)) continue;
      sounds[channelId] = file;
      if (Object.keys(sounds).length >= MAX_SOUNDS) break;
    }
    if (Object.keys(sounds).length) prefs.sounds = sounds;
  }

  // 默认铃声：与逐通道的文件名同样校验，挡掉路径穿越
  if (typeof input.defaultSound === "string" && SOUND_FILE.test(input.defaultSound)) {
    prefs.defaultSound = input.defaultSound;
  }

  // 备注名只在自己的 App 里显示，不进推送、不给别人看；只挡垃圾：不认识的通道、非字符串、空白
  if (input.aliases && typeof input.aliases === "object") {
    const aliases: Record<string, string> = {};
    for (const [channelId, raw] of Object.entries(input.aliases as Record<string, unknown>)) {
      if (!known.has(channelId) || typeof raw !== "string") continue;
      const name = raw.trim().slice(0, ALIAS_MAX);
      if (!name) continue;
      aliases[channelId] = name;
      if (Object.keys(aliases).length >= MAX_ALIASES) break;
    }
    if (Object.keys(aliases).length) prefs.aliases = aliases;
  }

  // 图片开关：要不要加载发送方给的图片地址。只收布尔 —— 没有条目时 App 自己按「自己建的开、加入的群关」
  // 处理，服务端不替它补默认值
  if (isPlainObject(input.images)) {
    const images: Record<string, boolean> = {};
    for (const [channelId, on] of Object.entries(input.images)) {
      if (!known.has(channelId) || typeof on !== "boolean") continue;
      images[channelId] = on;
      if (Object.keys(images).length >= MAX_IMAGES) break;
    }
    if (Object.keys(images).length) prefs.images = images;
  }

  return prefs;
}

/** 这个人此刻是否把这个通道设成了免打扰 */
export function isMuted(account: Pick<Account, "prefs">, channelId: string, now = Date.now()): boolean {
  const until = account.prefs?.mutes?.[channelId];
  return until !== undefined && (until === 0 || until > now);
}

// ── 认领 ────────────────────────────────────────────────────────────

/**
 * 认领一条消息。已经有人认领过就返回那个人，不覆盖 ——「谁先接手」是这个
 * 功能的全部意义，后来者不能把名字改成自己。
 *
 * KV 没有比较并交换，两个人在同一秒、从不同地区点下去，可能都被当成第一个。
 * 后果只是两人都收到一条「正在处理」，可以接受；为这个上强一致存储不值得。
 */
export async function claimAck(
  env: Env,
  channelId: string,
  messageId: string,
  claimant: Account,
): Promise<{ record: AckRecord; first: boolean }> {
  const key = `${ACK}${channelId}:${messageId}`;
  const existing = await env.PIGEON_KV.get<AckRecord>(key, "json");
  if (existing) return { record: existing, first: false };
  const record: AckRecord = { accountId: claimant.id, name: displayName(claimant), at: Date.now() };
  await env.PIGEON_KV.put(key, JSON.stringify(record), { expirationTtl: ACK_TTL_SECONDS });
  return { record, first: true };
}

/**
 * 这条消息有没有人认领过。重复提醒每次补发前都问一句 —— 认领那一刻会顺手撤掉提醒，
 * 但那一步失败了（或者 KV 还没同步到跑 cron 的地方），靠这里兜底，不会一直响下去。
 */
export async function isAcked(env: Env, channelId: string, messageId: string): Promise<boolean> {
  return (await env.PIGEON_KV.get(`${ACK}${channelId}:${messageId}`)) !== null;
}

/** 读认领记录：谁、几点认领的。没人认领过返回 null。回执查询（receipts.ts）用它取「谁在处理」 */
export async function getAck(env: Env, channelId: string, messageId: string): Promise<AckRecord | null> {
  return env.PIGEON_KV.get<AckRecord>(`${ACK}${channelId}:${messageId}`, "json");
}

/**
 * 清掉一条消息的认领记录，返回清没清到。事件结束（同 id 推来 status=resolved）或消息被撤回时调用。
 *
 * 同一个 id 常被反复用来代表同一件事（grafana-告警名、kuma-监控名、监控和心跳的 id）。不清的话，
 * 恢复之后 24 小时内再次触发：重复提醒第一轮就被当成「已认领」撤掉，群里点「我来处理」拿到的
 * 还是上一次的人 —— 大家以为有人在处理，其实没有。
 * 同一次触发的周期性重发（没带 status 或仍是 firing）不走这里：已经有人接手的事，不该重新吵他。
 *
 * 先读后删：绝大多数恢复消息没人认领过，删除按写入计费。出错不抛 —— 最坏是记录 24 小时后自己过期。
 */
export async function clearAck(env: Env, channelId: string, messageId: string): Promise<boolean> {
  const key = `${ACK}${channelId}:${messageId}`;
  try {
    if ((await env.PIGEON_KV.get(key)) === null) return false;
    await env.PIGEON_KV.delete(key);
    return true;
  } catch {
    return false;
  }
}

// ── 举报、屏蔽、停用 ────────────────────────────────────────────────

/** 举报理由。键给接口用，值是审核通知里显示的中文 */
export const REPORT_REASONS: Record<string, string> = {
  spam: "垃圾信息或广告",
  harassment: "骚扰或辱骂",
  sexual: "色情低俗",
  illegal: "违法违规",
  other: "其他",
};

/**
 * 同一个人对同一条消息（或同一个群）只留一份举报，再交一次就覆盖 ——
 * 既挡住有人刷举报，也让「改一下补充说明再交」自然成立。
 */
export function reportKey(channelId: string, reporterId: string, messageId?: string): string {
  return `${REPORT}${channelId}:${reporterId}:${messageId || "-"}`;
}

export async function fileReport(
  env: Env,
  channel: Channel,
  reporter: Account,
  input: { reason: string; detail?: string; messageId?: string; excerpt?: string },
): Promise<Report> {
  const report: Report = {
    channelId: channel.id,
    channelName: channel.name,
    ownerId: channel.ownerId,
    reporterId: reporter.id,
    reason: input.reason,
    at: Date.now(),
  };
  if (input.messageId) report.messageId = input.messageId;
  if (input.detail) report.detail = input.detail;
  if (input.excerpt) report.excerpt = input.excerpt;
  await env.PIGEON_KV.put(reportKey(channel.id, reporter.id, input.messageId), JSON.stringify(report), {
    expirationTtl: REPORT_TTL_SECONDS,
  });
  return report;
}

/** 接收举报通知的通道。没设就只落盘、不通知 —— mod 脚本里照样看得到 */
export async function getModChannelId(env: Env): Promise<string | null> {
  const id = await env.PIGEON_KV.get(CONFIG_MOD_CHANNEL);
  return id && isValidId(id) ? id : null;
}

export function isBlocked(account: Pick<Account, "blocked">, ownerId: string): boolean {
  return (account.blocked ?? []).some((b) => b.id === ownerId);
}

/** 记下屏蔽。已经在名单上就挪到最后、刷新名字和时间；名单满了挤掉最早的 */
export function blockOwner(account: Account, ownerId: string, ownerName: string, now = Date.now()): void {
  const rest = (account.blocked ?? []).filter((b) => b.id !== ownerId);
  account.blocked = [...rest, { id: ownerId, name: ownerName, at: now }].slice(-MAX_BLOCKED);
}

/** 解除屏蔽。名单上没有这个人时返回 false；名单空了就整个拿掉，不留空数组 */
export function unblockOwner(account: Account, ownerId: string): boolean {
  const before = account.blocked?.length ?? 0;
  const next = (account.blocked ?? []).filter((b) => b.id !== ownerId);
  if (next.length) account.blocked = next;
  else delete account.blocked;
  return next.length !== before;
}

/**
 * 停用或恢复一个通道。只有运营者能做：线上走 npm run mod（它写的是同一个键），本地测试走 /__test__。
 *
 * 停用只写 susp:{id}，不碰通道记录（原因见 getChannel）。恢复时删掉它；旧数据里停用还写在
 * 通道记录上的，顺手把那个字段也去掉 —— 只有这一种情况会为停用改写通道记录。
 */
export async function setSuspended(env: Env, channel: Channel, on: boolean, reason?: string): Promise<void> {
  if (on) {
    const suspension: Suspension = { at: Date.now(), ...(reason ? { reason } : {}) };
    await env.PIGEON_KV.put(SUSPENDED + channel.id, JSON.stringify(suspension));
    if (!channel.suspended) {
      channel.suspended = suspension;
      overlaidSuspension.set(channel, suspension);
    }
    return;
  }
  await env.PIGEON_KV.delete(SUSPENDED + channel.id);
  const legacy = channel.suspended !== undefined && overlaidSuspension.get(channel) !== channel.suspended;
  delete channel.suspended;
  if (legacy) await putChannel(env, channel);
}

// ── 推送后维护 ──────────────────────────────────────────────────────

/**
 * 推送之后：记一笔统计，给失效的 token 立墓碑。**不写通道记录，也不写账号记录。**
 *
 * 原先这里把整条通道、整个账号读出来改一个数再写回去。KV 在别的机房最长要 60 秒才看得到新写入，
 * 推送所在机房手里的往往是旧副本：一写回去，刚换的 key、刚移除的成员、刚停用的标记、刚改的
 * 免打扰、刚登记的新设备，全被悄悄盖回旧样子 —— 推得越勤的通道越容易中招。所以推送热路径只写
 * 两类独立的小键：stat:{通道 id} 和 dead:{token 摘要}，它们别处谁也不写，覆盖不了任何人的改动。
 *
 * 失败不抛：通知已经发出去了，账本记漏一笔远好过让调用方以为推送失败。
 */
export async function recordPushOutcome(
  env: Env,
  channelId: string,
  deadByAccount: Map<string, string[]>,
  delivered: boolean,
  now: number = Date.now(),
): Promise<void> {
  if (delivered) {
    try {
      await recordPushStat(env, channelId, now);
    } catch {
      // 统计写失败无所谓
    }
  }
  const dead = [...deadByAccount.values()].flat();
  if (dead.length > 0) await markDeadTokens(env, dead, now);
}

// ── 推送统计 ────────────────────────────────────────────────────────

/** stat:{通道 id} 里存的东西。只记这次改动之后的推送；之前的还留在通道记录的 count / lastPushAt 上 */
export interface PushStat {
  count: number;
  lastPushAt: number;
}

/**
 * 这个实例里攒着、还没落盘的推送条数，按通道 id。
 *
 * 60 秒内的后续推送只在这里加一，到下一次落盘时一并写进去。实例被回收时没来得及写的几条会丢 ——
 * 统计本来只是用来看「哪个来源最吵」，差几条不要紧，要紧的是别为了它每条推送都写一次 KV。
 */
const unflushedPushes = new Map<string, number>();

/**
 * 这个实例上次替各通道落盘的时刻。自己刚写过就不必再去读 stat: —— 省一次读；也防着本机房
 * 一时读不到自己刚写的值，以为早该落盘了、每条推送都去写一次。按 KV 绑定分开记，测试里各用各的库
 */
const flushedAt = new WeakMap<object, Map<string, number>>();

export async function getPushStat(env: Env, channelId: string): Promise<PushStat | null> {
  const raw = await env.PIGEON_KV.get<Partial<PushStat>>(STAT + channelId, "json");
  if (!raw || typeof raw.count !== "number" || typeof raw.lastPushAt !== "number") return null;
  return { count: raw.count, lastPushAt: raw.lastPushAt };
}

/** 一批通道的统计，并发读。读不到的不放进结果 —— 当它还没有新统计 */
export async function getPushStats(env: Env, channelIds: string[]): Promise<Map<string, PushStat>> {
  const stats = new Map<string, PushStat>();
  await Promise.all(
    channelIds.map(async (id) => {
      try {
        const stat = await getPushStat(env, id);
        if (stat) stats.set(id, stat);
      } catch {
        // 统计读不出来，账号快照照样要给
      }
    }),
  );
  return stats;
}

/**
 * 记一条推送。离上次落盘不到 STAT_FLUSH_MS 就只在内存里记着，否则连同攒下的一起写进去。
 *
 * 各机房、各实例各攒各的，同一分钟里可能有几处先后写，后写的会盖掉先写的那几条 —— 只丢计数，
 * 不丢别的，这是把统计挪出通道记录时就认下的代价。
 */
async function recordPushStat(env: Env, channelId: string, now: number): Promise<void> {
  unflushedPushes.set(channelId, (unflushedPushes.get(channelId) ?? 0) + 1);
  let mine = flushedAt.get(env.PIGEON_KV);
  if (!mine) flushedAt.set(env.PIGEON_KV, (mine = new Map()));
  const last = mine.get(channelId);
  if (last !== undefined && now - last < STAT_FLUSH_MS) return;
  const stored = await getPushStat(env, channelId);
  if (stored && now - stored.lastPushAt < STAT_FLUSH_MS) return;
  // 同一实例里并发的几条推送都会走到这里：第一个把攒下的全部带走，后面的已经无事可做
  const pending = unflushedPushes.get(channelId) ?? 0;
  if (pending === 0) return;
  unflushedPushes.delete(channelId);
  mine.set(channelId, now);
  const next: PushStat = { count: (stored?.count ?? 0) + pending, lastPushAt: now };
  try {
    await env.PIGEON_KV.put(STAT + channelId, JSON.stringify(next));
  } catch (err) {
    // 没写成就放回去，下次落盘时一起带上
    unflushedPushes.set(channelId, (unflushedPushes.get(channelId) ?? 0) + pending);
    mine.delete(channelId);
    throw err;
  }
}

/** 给人看的统计：通道记录上的旧数（这次改动之前累计的）加上 stat: 里之后的 */
export function pushStatOf(
  channel: Pick<Channel, "count" | "lastPushAt">,
  stat?: PushStat | null,
): { count: number; lastPushAt?: number } {
  const count = (channel.count ?? 0) + (stat?.count ?? 0);
  const last = Math.max(channel.lastPushAt ?? 0, stat?.lastPushAt ?? 0);
  return last > 0 ? { count, lastPushAt: last } : { count };
}

// ── 失效 token ──────────────────────────────────────────────────────

async function deadKey(token: string): Promise<string> {
  return DEAD + (await sha256(token));
}

/**
 * APNs 说这些 token 已经失效（删了 App、重装、环境不对）：各立一块墓碑，30 天后自动消失。
 * 推送据此跳过它们（deadTokens），账号本人下次来访时再从账号上摘掉（authenticate）。
 * 键名用 token 的摘要：墓碑不因为 token 挂在谁的账号上而重复，也不把 token 本身写进键名。
 */
export async function markDeadTokens(env: Env, tokens: string[], now: number = Date.now()): Promise<void> {
  for (const token of new Set(tokens)) {
    try {
      await env.PIGEON_KV.put(await deadKey(token), JSON.stringify({ at: now }), {
        expirationTtl: DEAD_TTL_SECONDS,
      });
    } catch {
      // 某个没写成，下次推到它还会再报失效、再写一次
    }
  }
}

/**
 * 这些设备里哪些的 token 已经立了墓碑。墓碑之后才登记的设备不算：同一个 token 重新登记过，
 * 就是又能用了（重装 App 偶尔会拿回同一个 token）。
 * 读不到墓碑的一律当它还活着 —— 多推一次失效的 token，好过漏掉一台好好的设备。
 */
export async function deadTokens(
  env: Env,
  devices: Pick<Device, "token" | "addedAt">[],
): Promise<Set<string>> {
  const dead = new Set<string>();
  await Promise.all(
    devices.map(async (device) => {
      try {
        const marker = await env.PIGEON_KV.get<{ at?: number }>(await deadKey(device.token), "json");
        if (marker && (marker.at ?? Infinity) >= (device.addedAt ?? 0)) dead.add(device.token);
      } catch {
        // 见上
      }
    }),
  );
  return dead;
}

/** 从账号上摘掉已经立了墓碑的设备。只改内存，返回摘没摘到 */
export async function pruneDeadDevices(env: Env, account: Account): Promise<boolean> {
  if (account.devices.length === 0) return false;
  const dead = await deadTokens(env, account.devices);
  if (dead.size === 0) return false;
  account.devices = account.devices.filter((d) => !dead.has(d.token));
  return true;
}

/**
 * 设备重新登记了这个 token：墓碑作废。不先读再删 —— 读到的可能是本机房的旧缓存，
 * 以为没有墓碑就不删，别处却还照着它跳过这台设备，这台设备就一直收不到。
 */
export async function clearDeadToken(env: Env, token: string): Promise<void> {
  try {
    await env.PIGEON_KV.delete(await deadKey(token));
  } catch {
    // 删不掉也有后手：下次登记时墓碑已经传到这里，这台设备会先被摘掉、再以新的登记时刻加回来，
    // 墓碑就管不到它了（见 deadTokens）
  }
}

// ── 设备 ────────────────────────────────────────────────────────────

/**
 * 按 token 登记设备，已有就更新。
 *
 * renew：这是用户亲手把设备加回来（扫码、点「继续使用」），登记时刻按这一次算 —— 早先立的
 * 移除墓碑、失效墓碑都比它早，就都管不到它了（见 isRemovedDevice、deadTokens）。平常的静默续期
 * 不动登记时刻：设备列表里的「添加于」是它第一次加进来的那天
 */
export function upsertDevice(account: Account, device: Device, options: { renew?: boolean } = {}): void {
  const existing = account.devices.find((d) => d.token === device.token);
  if (existing) {
    // 同一台设备重装后可能换了环境（debug 包 → TestFlight），以本次申报为准
    existing.env = device.env;
    existing.name = device.name;
    if (options.renew) existing.addedAt = Math.max(existing.addedAt ?? 0, device.addedAt);
  } else {
    account.devices.push(device);
  }
}

// ── 移除设备的墓碑 ──────────────────────────────────────────────────

async function removedDeviceKey(accountId: string, token: string): Promise<string> {
  return `${REMOVED_DEVICE}${accountId}:${await sha256(token)}`;
}

/**
 * 机主把这台设备移出了账号：立一块墓碑，30 天后自动消失。
 *
 * 光从账号上摘掉 token 不够 —— 被移走的设备手里还有账号凭据，下次打开 App 会静默重新登记，
 * 悄无声息地回到账号里，又开始收全部推送。有了墓碑，这种静默登记收到 410、App 退出登录；
 * 用户亲手扫码或点「继续使用」时带 reclaim，才放它回来。
 *
 * 只防善意场景（送人、转卖、换下来的旧手机）：那台设备仍持有账号凭据，改过的客户端照样能带着
 * reclaim 回来。真要踢出去，得换账号凭据。
 *
 * 按账号分开存：一台设备可以挂在几个账号上，在这个账号被移走，不影响它在别的账号里的登记。
 * 键名以账号 id 打头，删账号时能按前缀一把清掉（见 deleteAccount）；token 本身只以摘要出现
 */
export async function markRemovedDevice(
  env: Env,
  accountId: string,
  token: string,
  now: number = Date.now(),
): Promise<void> {
  await env.PIGEON_KV.put(await removedDeviceKey(accountId, token), JSON.stringify({ accountId, at: now }), {
    expirationTtl: REMOVED_DEVICE_TTL_SECONDS,
  });
}

/**
 * 这次登记是不是撞上了移除墓碑。
 *
 * 已经在账号里、而且登记得比墓碑晚的，不算 —— 那是用户亲手加回来以后墓碑没删掉，或者别的机房
 * 还看得到旧的。在账号里、但登记得比墓碑早的，照样算：移除还没传到这个机房，手里的账号是旧副本。
 * 读不到墓碑一律当没有：宁可让被移走的设备回来一次，也不能把一台好好的设备挡在门外
 */
export async function isRemovedDevice(env: Env, account: Account, token: string): Promise<boolean> {
  let marker: { at?: unknown } | null;
  try {
    marker = await env.PIGEON_KV.get<{ at?: unknown }>(await removedDeviceKey(account.id, token), "json");
  } catch {
    return false;
  }
  if (!marker) return false;
  // 格式不对的墓碑也算数：它只可能是这里写的，拦错了用户扫一次码就解开
  const at = typeof marker.at === "number" ? marker.at : Infinity;
  const existing = account.devices.find((d) => d.token === token);
  return !(existing && (existing.addedAt ?? 0) > at);
}

/**
 * 用户亲手把这台设备加回来了：墓碑作废。和 clearDeadToken 一样不先读再删。
 * 删不掉也不要紧：这次登记带 renew，登记时刻比墓碑晚，墓碑管不到它（见 isRemovedDevice）
 */
export async function clearRemovedDevice(env: Env, accountId: string, token: string): Promise<void> {
  try {
    await env.PIGEON_KV.delete(await removedDeviceKey(accountId, token));
  } catch {
    // 见上
  }
}

export type { ApnsEnv };
