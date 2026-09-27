/**
 * 多设备已读水位：AccountPrefs.readThrough，通道 id → 毫秒时刻。这个通道里发出时刻（sent_at）不晚于它的消息，
 * 这个人都已经读过了。一台设备读了，同账号的其它设备刷新偏好时按它把自己那份标成已读、清掉通知中心的旧条目。
 *
 * 只存一个时刻，不存读了哪几条：一个通道一个数，账号记录不会因为消息多而变大；也不涉及任何消息内容。
 *
 * 和别的表类偏好不同，它只进不退：两台设备各自手里是不同时候的快照，谁晚交谁的值就生效的话，
 * 刚在 iPad 上读到的位置，会被 iPhone 手里的旧快照拉回去，读过的又变成未读。所以合并一律取较大的，
 * 按项合并（prefs_patch）和老版 App 的整份提交（prefs）都一样。要撤掉只能明说：条目给 null
 */

/** 偏好里的键名。db.ts 的表类偏好、合并与清洗都认它 */
export const READ_THROUGH = "readThrough";

/**
 * 比服务端此刻晚这么多以内的水位照收，再晚的截到这里。水位按消息的 sent_at（服务端时刻）算，
 * 本不会比现在晚；旧消息没有 sent_at 时 App 用本机收到的时刻，手机时钟快几分钟也不该把它丢掉。
 * 但时钟快了一整天的设备交上来的，不能让别的设备把之后一天里来的消息全算成已读 —— 截住就不会
 */
export const READ_THROUGH_SKEW_MS = 10 * 60_000;

/** 条数上限。一个账号最多 100 个通道，留足余量 */
const MAX_READ_THROUGH = 200;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usable(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * 把交上来的水位并到现有的上：每个通道取较大的；条目值 null 删掉这一条；不是数的条目当坏数据丢掉，原有的不动。
 * 太靠后的先截到「现在 + 容差」再比 —— 否则先取了大、清洗时再截，也一样，但这样读起来不必绕一圈。
 * 返回的还没清洗（不认识的通道还在），调用方照常再过一遍 sanitizePrefs
 */
export function mergeReadThrough(
  current: unknown,
  incoming: Record<string, unknown>,
  now = Date.now(),
): Record<string, unknown> {
  // 复制一份再改：现有偏好是账号记录里的对象，清洗失败也不该把它改了一半
  const merged: Record<string, unknown> = isPlainObject(current) ? { ...current } : {};
  const ceiling = now + READ_THROUGH_SKEW_MS;
  for (const [channelId, value] of Object.entries(incoming)) {
    // JSON 里的 "__proto__" 只是个普通键名，赋值时却会改掉对象的原型
    if (channelId === "__proto__") continue;
    if (value === null) {
      delete merged[channelId];
      continue;
    }
    if (!usable(value)) continue;
    const next = Math.min(Math.floor(value), ceiling);
    const before = merged[channelId];
    merged[channelId] = usable(before) ? Math.max(before, next) : next;
  }
  return merged;
}

/** 清洗：只留认识的通道、正的有限数，取整，截到「现在 + 容差」。没有一条合格的返回 undefined */
export function sanitizeReadThrough(
  raw: unknown,
  known: Set<string>,
  now = Date.now(),
): Record<string, number> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const ceiling = now + READ_THROUGH_SKEW_MS;
  const out: Record<string, number> = {};
  let count = 0;
  for (const [channelId, value] of Object.entries(raw)) {
    if (!known.has(channelId) || !usable(value)) continue;
    out[channelId] = Math.min(Math.floor(value), ceiling);
    if (++count >= MAX_READ_THROUGH) break;
  }
  return count > 0 ? out : undefined;
}
