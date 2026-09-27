import { isMuted } from "./db";
import { isQuietNow } from "./policy";
import type { Account, Channel } from "./types";

/**
 * 接收方自己的控制：一条消息推给一群人时，每个人按自己的设置各拿一版。
 *
 * 通道的设置（免打扰时段、去重）由创建者定、对所有人一样；这里的每一项只影响这个人自己：
 * - 免打扰（prefs.mutes）：到他这里降成静默，不丢
 * - 最低提醒级别（prefs.minLevel）：低于它的降成静默。值班的人把生产告警群设成「时效性」，平常的播报就不再吵他
 * - 紧急授权（prefs.critical）：别人的群发来的 critical，只有他自己允许了才突破免打扰；
 *   没允许就按时效性送，免打扰、通道的免打扰时段照样管它
 *
 * 原先 critical 对谁都突破免打扰：群主、或者任何拿到推送地址的人写一个 level=critical，就能把已经把群
 * 设成免打扰的成员吵醒，成员没法拒绝。会不会被一个群在半夜叫醒，该由被叫醒的人说了算。
 * 自己建的通道不受影响：地址是自己给出去的，critical 照旧突破自己的免打扰。
 */

/**
 * 每个人拿到的那一版：
 * - asis   原样
 * - capped critical 降成时效性（没授权的人）
 * - quiet  静默（免打扰、低于最低级别，或者是发这条消息的人自己）
 */
export type Tier = "asis" | "capped" | "quiet";

/** 级别的高低。认不出的（没写、拼错）按 active 算 —— buildPayload 对认不出的级别不写 interruption-level，系统按普通送 */
const LEVEL_RANK = new Map<string, number>([
  ["passive", 0],
  ["active", 1],
  ["timesensitive", 2],
  ["time-sensitive", 2],
  ["critical", 3],
]);

export function levelRank(level?: string): number {
  return LEVEL_RANK.get((level ?? "").toLowerCase()) ?? 1;
}

export function isCritical(level?: string): boolean {
  return levelRank(level) === 3;
}

export interface TierContext {
  now: number;
  /** 成员在群里发的消息：发消息的人自己的设备静默收下 —— 进历史，不必对着自己响一遍 */
  senderId?: string;
}

/** 这个人能不能被这个通道的 critical 突破免打扰：自己建的通道能；加入的群要他自己允许过 */
export function allowsCritical(account: Pick<Account, "id" | "prefs">, channel: Pick<Channel, "id" | "ownerId">): boolean {
  return account.id === channel.ownerId || account.prefs?.critical?.[channel.id] === true;
}

/**
 * 这个人拿哪一版。level 是过完通道策略之后的级别：通道正在免打扰时段的话，普通消息到这里已经是 passive 了；
 * critical 在那一步被放过（见 policy.ts applyPolicy），没授权的人在这里补上
 */
export function tierFor(
  account: Pick<Account, "id" | "prefs">,
  channel: Pick<Channel, "id" | "ownerId" | "policy">,
  level: string | undefined,
  ctx: TierContext,
): Tier {
  if (ctx.senderId !== undefined && account.id === ctx.senderId) return "quiet";
  const critical = isCritical(level);
  if (critical && allowsCritical(account, channel)) return "asis";
  if (isMuted(account, channel.id, ctx.now)) return "quiet";
  if (critical) {
    const quietHours = channel.policy?.quietHours;
    if (quietHours && isQuietNow(quietHours, new Date(ctx.now))) return "quiet";
    // 降成时效性之后，谁的最低级别都拦不住它（最低级别最高只能设到时效性）
    return "capped";
  }
  // 已经是静默的不必再「降」：不然 muted 里会把本来就不响的消息也算进去
  const floor = account.prefs?.minLevel?.[channel.id];
  const rank = levelRank(level);
  if (floor && rank > 0 && rank < levelRank(floor)) return "quiet";
  return "asis";
}

/** 按每个人的设置把接收者分成三拨。每拨各推一版，见 push.ts deliver */
export function splitRecipients(
  recipients: Account[],
  channel: Pick<Channel, "id" | "ownerId" | "policy">,
  level: string | undefined,
  ctx: TierContext,
): Record<Tier, Account[]> {
  const split: Record<Tier, Account[]> = { asis: [], capped: [], quiet: [] };
  for (const account of recipients) split[tierFor(account, channel, level, ctx)].push(account);
  return split;
}
