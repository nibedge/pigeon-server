import { timingSafeEqual } from "./db";
import { RATE_WINDOW_SECONDS } from "./ratelimit";
import type { Env } from "./types";

/**
 * 群组防滥用：认领凭据、举报限额、给运营者的举报通知合并。
 */

const REPORT_QUOTA = "rl:report:";
const MOD_NOTE = "modnote:";

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
