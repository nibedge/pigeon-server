import { getInvite, INVITE_TTL_SECONDS, timingSafeEqual } from "./db";
import { RATE_WINDOW_SECONDS } from "./ratelimit";
import type { Env, Invite } from "./types";

/**
 * 群组管控：邀请码的索引与作废、禁入名单、认领凭据、举报限额、给运营者的举报通知合并。
 *
 * 管控状态单独放在 grp:{通道 id} 一个键里，不写回通道记录 —— 通道记录在推送热路径上被读，
 * 整条改写它容易把同一时刻的加入、退出覆盖掉；这几样又都是群主偶尔才动一下的东西，一个键足够。
 */

const GROUP = "grp:";
/** 与 db.ts 里邀请码的键前缀一致：作废邀请就是删掉这个键 */
const INVITE = "inv:";
const REPORT_QUOTA = "rl:report:";
const MOD_NOTE = "modnote:";

/** 索引里最多记这么多条邀请。更早的照样有效，「全部作废」靠时间线把它们一起盖掉 */
const MAX_INDEXED_INVITES = 100;
/** 禁入名单上限，满了挤掉最早的 */
const MAX_BANNED = 200;

export interface IndexedInvite {
  code: string;
  createdAt: number;
  expiresAt: number;
}

export interface GroupState {
  /** 这个群生成过、还没过期的邀请码。只有新版本生成的才在这里 */
  invites?: IndexedInvite[];
  /**
   * 这个时刻之前生成的邀请一律作废。
   * 索引之外的邀请（上线这个功能之前生成的、或者当时索引没记上的）没法逐个找到，靠它一起失效
   */
  invitesRevokedAt?: number;
  /** 群主移除时选了「禁止再加入」的账号 id */
  banned?: string[];
}

export async function getGroupState(env: Env, channelId: string): Promise<GroupState> {
  return (await env.PIGEON_KV.get<GroupState>(GROUP + channelId, "json")) ?? {};
}

/** 写回时顺手清掉过期的邀请和已经没用的作废时刻；什么都不剩就删键，不留空壳 */
export async function saveGroupState(
  env: Env,
  channelId: string,
  state: GroupState,
  now = Date.now(),
): Promise<void> {
  const next: GroupState = {};
  const invites = liveInvites(state, now).slice(-MAX_INDEXED_INVITES);
  if (invites.length) next.invites = invites;
  // 作废时刻之前的邀请过了有效期都会自己失效，再留着这个时刻就没有意义了
  if (state.invitesRevokedAt && now - state.invitesRevokedAt < INVITE_TTL_SECONDS * 1000) {
    next.invitesRevokedAt = state.invitesRevokedAt;
  }
  if (state.banned?.length) next.banned = state.banned.slice(-MAX_BANNED);
  if (Object.keys(next).length === 0) await env.PIGEON_KV.delete(GROUP + channelId);
  else await env.PIGEON_KV.put(GROUP + channelId, JSON.stringify(next));
}

/** 通道删掉了：它的管控状态一并删掉 */
export async function forgetGroup(env: Env, channelId: string): Promise<void> {
  await env.PIGEON_KV.delete(GROUP + channelId);
}

// ── 邀请 ────────────────────────────────────────────────────────────

/**
 * 严格早于作废时刻才算作废：「全部作废」之后紧接着生成的新邀请，哪怕落在同一毫秒也得能用。
 * 同一毫秒里更早生成的那个若在索引里，作废时已经逐个删掉了
 */
export function inviteRevoked(state: GroupState, invite: Pick<Invite, "createdAt">): boolean {
  return state.invitesRevokedAt !== undefined && invite.createdAt < state.invitesRevokedAt;
}

/** 索引里仍然有效的邀请：没过期、也没被「全部作废」盖掉 */
export function liveInvites(state: GroupState, now = Date.now()): IndexedInvite[] {
  return (state.invites ?? []).filter((i) => i.expiresAt > now && !inviteRevoked(state, i));
}

/**
 * 新生成的邀请记进索引，群主才列得出、撤得掉。
 * 记不上不抛：邀请本身已经生效了，「全部作废」还有作废时刻兜底
 */
export async function recordInvite(env: Env, invite: Invite, now = Date.now()): Promise<void> {
  try {
    const state = await getGroupState(env, invite.channelId);
    state.invites = [
      ...(state.invites ?? []),
      { code: invite.code, createdAt: invite.createdAt, expiresAt: invite.expiresAt },
    ];
    await saveGroupState(env, invite.channelId, state, now);
  } catch {
    // 见上
  }
}

/**
 * 按邀请码找到仍然有效的邀请，连同这个群的管控状态（加入时还要查禁入名单）。
 * 预览、加入、网页邀请页都走这里 —— 作废了的邀请在哪条路上都不能再用
 */
export async function openInvite(
  env: Env,
  code: string,
): Promise<{ invite: Invite; state: GroupState } | null> {
  const invite = await getInvite(env, code);
  if (!invite) return null;
  const state = await getGroupState(env, invite.channelId);
  return inviteRevoked(state, invite) ? null : { invite, state };
}

/**
 * 作废一个邀请码。只认这个群自己的 —— 否则群主拿别的群的邀请码也能删。
 * 返回规范写法的邀请码；不存在、已过期或者不属于这个群返回 null
 */
export async function revokeInvite(
  env: Env,
  channelId: string,
  code: string,
  now = Date.now(),
): Promise<string | null> {
  const invite = await getInvite(env, code);
  if (!invite || invite.channelId !== channelId) return null;
  await env.PIGEON_KV.delete(INVITE + invite.code);
  const state = await getGroupState(env, channelId);
  state.invites = (state.invites ?? []).filter((i) => i.code !== invite.code);
  await saveGroupState(env, channelId, state, now);
  return invite.code;
}

/**
 * 作废这个群的全部邀请：删掉索引里的邀请码，再记下作废时刻盖住索引之外的旧邀请。
 * 只改 state，不写回 —— 移除成员时和禁入一起写，一次写入。返回删掉了几个邀请码
 */
export async function revokeAllInvites(env: Env, state: GroupState, now = Date.now()): Promise<number> {
  const codes = liveInvites(state, now).map((i) => i.code);
  await Promise.all(codes.map((code) => env.PIGEON_KV.delete(INVITE + code)));
  state.invites = [];
  state.invitesRevokedAt = now;
  return codes.length;
}

// ── 禁入 ────────────────────────────────────────────────────────────

export function isBanned(state: GroupState, accountId: string): boolean {
  return (state.banned ?? []).includes(accountId);
}

export function ban(state: GroupState, accountId: string): void {
  state.banned = [...(state.banned ?? []).filter((id) => id !== accountId), accountId];
}

/** 解除禁入。名单上没有这个人时返回 false */
export function unban(state: GroupState, accountId: string): boolean {
  const before = state.banned?.length ?? 0;
  state.banned = (state.banned ?? []).filter((id) => id !== accountId);
  return state.banned.length !== before;
}

// ── 认领凭据 ────────────────────────────────────────────────────────

/**
 * 认领凭据 ack_sig：服务端给每条推出去的消息签一个「通道 id + 消息 id」的凭据，
 * 认领时带回来核对。没有它，任何成员都能编一个 message_id 认领，每编一个就往全群广播一次。
 *
 * 签名密钥由 APNS_KEY_P8 派生，不另设一个 secret：这把私钥本来就只在服务端，
 * 加上专用前缀再做 SHA-256，派生出的 HMAC 密钥和 APNs 签名互不相干。
 * 本地测试没有 APNS_KEY_P8：不签发、也不核对。
 */
const ACK_SIG_CONTEXT = "pigeon ack-sig v1|";
/** HMAC-SHA256 截到前 16 字节：够防伪造，payload 里只多 22 个字符 */
const ACK_SIG_BYTES = 16;

let cachedAckKey: { p8: string; key: CryptoKey } | null = null;

async function ackKey(env: Pick<Env, "APNS_KEY_P8">): Promise<CryptoKey | null> {
  const p8 = env.APNS_KEY_P8;
  if (!p8) return null;
  if (cachedAckKey?.p8 === p8) return cachedAckKey.key;
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ACK_SIG_CONTEXT + p8));
  const key = await crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  cachedAckKey = { p8, key };
  return key;
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 这条消息的认领凭据。没有签发密钥时返回 undefined */
export async function ackSignature(
  env: Pick<Env, "APNS_KEY_P8">,
  channelId: string,
  messageId: string,
): Promise<string | undefined> {
  const key = await ackKey(env);
  if (!key) return undefined;
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${channelId}|${messageId}`));
  return b64url(new Uint8Array(mac).slice(0, ACK_SIG_BYTES));
}

/** 给一次投递的各份 payload 盖上认领凭据。签不出来就不带 —— 推送本身不能因此失败 */
export async function stampAckSig(
  env: Pick<Env, "APNS_KEY_P8">,
  channelId: string,
  messageId: string,
  payloads: Record<string, unknown>[],
): Promise<void> {
  try {
    const sig = await ackSignature(env, channelId, messageId);
    if (sig) for (const payload of payloads) payload.ack_sig = sig;
  } catch {
    // 见上
  }
}

/** 核对认领时带回来的凭据。没有签发密钥时一律放行（本地测试） */
export async function ackSigValid(
  env: Pick<Env, "APNS_KEY_P8">,
  channelId: string,
  messageId: string,
  sig: string,
): Promise<boolean> {
  const expected = await ackSignature(env, channelId, messageId);
  return expected === undefined || timingSafeEqual(sig, expected);
}

// ── 举报限额与通知合并 ──────────────────────────────────────────────

/** 每个账号每小时最多举报几次。正常人一小时举报不了几回，多出来的是在刷 */
export const REPORTS_PER_HOUR = 5;
const HOUR_MS = 3_600_000;

/**
 * 占用一次举报额度。放行返回 0（已经记上这一次）；超了返回还要等几秒。
 *
 * 计数按整点分桶存在 KV，键 2 小时后自动过期。计数写不进去也按超限处理：
 * 刷举报的脚本一秒连发，撞上 KV 同一个键每秒一次的写入上限，正好在这里挡住
 */
export async function takeReportQuota(env: Env, accountId: string, now = Date.now()): Promise<number> {
  const hour = Math.floor(now / HOUR_MS);
  const key = `${REPORT_QUOTA}${accountId}:${hour}`;
  const used = Number(await env.PIGEON_KV.get(key)) || 0;
  if (used >= REPORTS_PER_HOUR) return Math.max(1, Math.ceil(((hour + 1) * HOUR_MS - now) / 1000));
  try {
    await env.PIGEON_KV.put(key, String(used + 1), { expirationTtl: 2 * 3600 });
  } catch {
    return RATE_WINDOW_SECONDS;
  }
  return 0;
}

/** 同一个群的举报，给运营者的通知多久最多推一次 */
export const MOD_NOTIFY_WINDOW_MS = 10 * 60_000;

interface ModNote {
  /** 在这之前再来的举报只计数、不推 */
  until: number;
  /** 上一次通知之后被合并掉的条数 */
  held: number;
}

/**
 * 这条举报要不要现在就推给运营者。
 *
 * 同一个群 10 分钟内只推第一条，其余只计数，由下一次推送写明「又收到 N 条」。
 * 举报本身都已落盘，审核时照样逐条看得到；合并的只是通知 —— 有人换着 message_id 刷举报，
 * 运营者的手机不能跟着响个不停，真正的举报也就不会被淹没。
 * 返回 null = 这次不推；返回数字 = 现在推，数字是此前被合并掉的条数
 */
export async function moderatorNotice(env: Env, channelId: string, now = Date.now()): Promise<number | null> {
  const key = MOD_NOTE + channelId;
  const note = await env.PIGEON_KV.get<ModNote>(key, "json");
  // 计数留一周：隔了很久才来的下一条举报，也能带上之前没推的那几条
  const ttl = { expirationTtl: 7 * 24 * 3600 };
  if (note && now < note.until) {
    await env.PIGEON_KV.put(key, JSON.stringify({ ...note, held: note.held + 1 }), ttl);
    return null;
  }
  await env.PIGEON_KV.put(key, JSON.stringify({ until: now + MOD_NOTIFY_WINDOW_MS, held: 0 }), ttl);
  return note?.held ?? 0;
}
