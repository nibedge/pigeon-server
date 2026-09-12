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
} from "./types";

const ACCOUNT = "acct:";
const CHANNEL = "chan:";
const KEY = "ch:";
const INVITE = "inv:";
const ACK = "ack:";
const REPORT = "report:";
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

/** 群组里怎么称呼这个人 */
export function displayName(account: Account): string {
  return account.name?.trim() || account.devices[0]?.name || "成员";
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
  return timingSafeEqual(presented, account.secretHash) ? account : null;
}

// ── 通道 ────────────────────────────────────────────────────────────

async function putKeyPointer(env: Env, key: string, id: string): Promise<void> {
  const pointer: KeyPointer = { id };
  await env.PIGEON_KV.put(KEY + key, JSON.stringify(pointer));
}

export async function getChannel(env: Env, id: string): Promise<Channel | null> {
  if (!isValidId(id)) return null;
  const channel = await env.PIGEON_KV.get<Channel>(CHANNEL + id, "json");
  if (!channel) return null;
  channel.memberIds ??= [];
  return channel;
}

export async function putChannel(env: Env, channel: Channel): Promise<void> {
  await env.PIGEON_KV.put(CHANNEL + channel.id, JSON.stringify(channel));
}

async function createChannelRecord(
  env: Env,
  ownerId: string,
  name: string,
  icon?: string,
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
): Promise<Channel> {
  const channel = await createChannelRecord(env, account.id, name, icon);
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
 * 读取次数是 2 + 人数。群组有上限，这个量级可以接受；换来的是设备列表只存
 * 一份在各自账号上，增删设备不必回写任何通道。
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

/** 删除通道：所有成员一起失去它。先让 key 失效，删到一半也不会再有推送进来 */
export async function deleteChannel(env: Env, channel: Channel): Promise<void> {
  await env.PIGEON_KV.delete(KEY + channel.key);
  await env.PIGEON_KV.delete(CHANNEL + channel.id);
  for (const id of [channel.ownerId, ...channel.memberIds]) {
    const account = await getAccount(env, id);
    if (!account) continue;
    account.channelIds = account.channelIds.filter((c) => c !== channel.id);
    forgetChannel(account, channel.id);
    await putAccount(env, account);
  }
}

/** 通道离开了这个人的列表：连带清掉他为它设的置顶、免打扰、分组归属和保管的密钥 */
export function forgetChannel(account: Account, channelId: string): void {
  const prefs = account.prefs;
  if (prefs) {
    if (prefs.pins) prefs.pins = prefs.pins.filter((id) => id !== channelId);
    if (prefs.mutes) delete prefs.mutes[channelId];
    if (prefs.folderOf) delete prefs.folderOf[channelId];
    if (prefs.sounds) delete prefs.sounds[channelId];
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

// ── 删除账号 ────────────────────────────────────────────────────────

/**
 * 删除账号：服务端上和这个人有关的记录全部清掉。
 *
 * 自己建的通道整个删除（成员一起失去它，地址立即失效），加入的群组退出，最后删账号本身。
 * 顺序刻意：先断掉所有推送入口，删到一半失败也不会再有推送进来；账号记录放在最后，
 * 中途失败时用户还能凭 secret 再删一次，而不是落得「账号没了、通道还在」。
 */
export async function deleteAccount(env: Env, account: Account): Promise<void> {
  for (const channel of await listChannels(env, account)) {
    if (channel.ownerId === account.id) await deleteChannel(env, channel);
    else await leaveChannel(env, channel, account);
  }
  await env.PIGEON_KV.delete(ACCOUNT + account.id);
}

// ── 个人偏好 ────────────────────────────────────────────────────────

export const MAX_FOLDERS = 20;
const FOLDER_NAME_MAX = 20;
/** 限时免打扰最长一年；更久就该用「一直免打扰」（0） */
const MUTE_MAX_MS = 366 * 24 * 3600 * 1000;

/**
 * 清洗客户端提交的偏好。**整份替换、不做合并** —— 偏好只由这个人自己的设备改，两台设备
 * 同时改的概率很低；合并规则一复杂，就会出现「明明取消了的置顶又回来了」。
 *
 * 只保留格式合法、指向真实存在的东西的条目：不认识的通道、不存在的分组、已经过期的免打扰
 * 都丢掉，否则账号记录会被垃圾数据慢慢撑大。
 */
/** 铃声文件名：只允许字母数字点划线，且必须以 .caf 结尾 —— 挡掉 ../ 和绝对路径 */
const SOUND_FILE = /^[A-Za-z0-9_-]{1,60}\.caf$/;
/** 一个账号最多记多少条铃声选择 */
const MAX_SOUNDS = 200;

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

/** 停用或恢复一个通道。只有运营者能做：线上走 npm run mod，本地测试走 /__test__ */
export async function setSuspended(env: Env, channel: Channel, on: boolean, reason?: string): Promise<void> {
  if (on) channel.suspended = { at: Date.now(), ...(reason ? { reason } : {}) };
  else delete channel.suspended;
  await putChannel(env, channel);
}

// ── 推送后维护 ──────────────────────────────────────────────────────

/**
 * 推送之后：通道记一笔统计，各接收者账号摘掉失效 token。
 *
 * 统计写在通道记录上、死 token 写在各自的账号记录上 —— 落在不同的 key，
 * 不会再出现「两次读—改—写落在同一条记录上互相覆盖」那个旧 bug
 * （当年统计那次拿推送前的旧快照写回，把刚摘掉的死 token 又装了回去）。
 * 每条记录都现读现改，绝不拿推送前的快照写回。
 *
 * 失败不抛：通知已经发出去了，账本记漏一笔远好过让调用方以为推送失败。
 */
export async function recordPushOutcome(
  env: Env,
  channelId: string,
  deadByAccount: Map<string, string[]>,
  delivered: boolean,
): Promise<void> {
  if (delivered) {
    try {
      const channel = await getChannel(env, channelId);
      if (channel) {
        channel.count += 1;
        channel.lastPushAt = Date.now();
        await putChannel(env, channel);
      }
    } catch {
      // 统计写失败无所谓
    }
  }
  for (const [accountId, tokens] of deadByAccount) {
    if (tokens.length === 0) continue;
    try {
      const account = await getAccount(env, accountId);
      if (!account) continue;
      const dead = new Set(tokens);
      const next = account.devices.filter((d) => !dead.has(d.token));
      if (next.length !== account.devices.length) {
        account.devices = next;
        await putAccount(env, account);
      }
    } catch {
      // 某个账号清理失败不影响其它账号
    }
  }
}

// ── 设备 ────────────────────────────────────────────────────────────

export function upsertDevice(account: Account, device: Device): void {
  const existing = account.devices.find((d) => d.token === device.token);
  if (existing) {
    // 同一台设备重装后可能换了环境（debug 包 → TestFlight），以本次申报为准
    existing.env = device.env;
    existing.name = device.name;
  } else {
    account.devices.push(device);
  }
}

export type { ApnsEnv };
