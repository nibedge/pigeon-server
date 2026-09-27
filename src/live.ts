import { isDeadToken, pushToDevice, type ApnsHeaders } from "./apns";
import { sha256 } from "./db";
import type { Account, ApnsEnv, Channel, Device, Env, PushParams, PushResult } from "./types";

/**
 * 实时活动（锁屏和灵动岛上那一块）：一件进行中的事，从开始到恢复一直挂在那里。
 *
 * 沿用已有的 id + status，不引入新概念：
 *   - 带 id 的 status=firing，发送方要了（live=1）或者通道默认值里开着 → 给接收者开一个实时活动（push-to-start），
 *     系统在本地按秒走「已持续 12:34」，不用每秒推一次；
 *   - 有人认领 → 推一次 update，换成「张三 正在处理」；
 *   - 同一个 id 推来 status=resolved → 推 end，定格成「已恢复 · 持续 18 分钟」，15 分钟后收起；撤回（delete=1）立即收起。
 *
 * 令牌有两种，都由 App 登记：
 *   - push-to-start 令牌：每台设备一个，存在账号的设备记录上（Device.activityStartToken），开新活动用；
 *   - 更新令牌：每个活动一个。活动开起来之后系统把 App 叫醒、交给它，App 登记到 la:{通道}:{消息}:{账号}.{设备}，
 *     认领、恢复时推给它们。
 *
 * 再加每件事一条小记录 la:{通道}:{消息}：开始的时刻、谁在处理、什么时候结束的。**不存标题正文**：标题在开始那一刻
 * 随 attributes 发到手机上，之后的更新只带状态，手机沿用开始时的标题（加密消息的标题服务端本来就看不到，
 * 手机从自己的历史里取解密后的）。结束之后它留作墓碑：推送晚到的手机再来登记更新令牌，直接告诉它「已经结束了」。
 *
 * 实时活动的推送全都跟在普通推送之后发，出了错只记日志，不影响这条消息本身的投递和响应。
 */

const LIVE = "la:";

/** 记录和更新令牌的存活时间。系统最多让实时活动活 8 小时（之后还能在锁屏上停 4 小时），多留一截兜底 */
export const LIVE_TTL_SECONDS = 12 * 3600;
/** 恢复之后在锁屏上再停多久。够人看一眼「已恢复 · 持续 18 分钟」，又不至于一直占着锁屏 */
export const LIVE_DISMISS_AFTER_MS = 15 * 60_000;
/**
 * 开始推送最多在 APNs 那里等多久。手机离线期间开始的事，联网后照样开出来 —— 那时它多半还在进行；
 * 已经结束了的，App 被叫醒登记更新令牌时会从墓碑得知，当场收起。超过实时活动本身的寿命就没有意义了
 */
export const LIVE_START_EXPIRATION_SECONDS = 8 * 3600;
/** 必须和 App 里 ActivityAttributes 的类型名一字不差，系统靠它找到界面 */
export const ATTRIBUTES_TYPE = "IncidentAttributes";
/** 加密消息服务端看不到标题，先显示这句；手机上有解开的历史时换成真标题 */
export const SEALED_TITLE = "加密消息";
/** 标题最多带这么多字：锁屏上最多显示两行，再长也看不到 */
const TITLE_MAX = 80;

export type LiveStatus = "firing" | "acked" | "resolved";

/** 和 App 里 IncidentAttributes.ContentState 一一对应。时刻都是毫秒，不用 Date —— 系统按默认策略解码，Date 会被当成 2001 年起的秒数 */
export interface LiveContentState {
  /** 只在开始时带；之后的更新不带，手机沿用 attributes 里开始时的标题 */
  title?: string;
  status: LiveStatus;
  ackBy?: string;
  startedAt?: number;
  resolvedAt?: number;
}

/** 和 App 里 IncidentAttributes 一一对应：活动开起来之后就不再变的部分 */
export interface LiveAttributes {
  channelId: string;
  messageId: string;
  channelName: string;
  title: string;
  startedAt: number;
  /** 标题在密文里，这里只有占位。手机从历史里找解密后的标题 */
  sealed?: boolean;
  /** 认领凭据（见 groups.ts ackSignature）。活动上的「我来处理」原样带回去 */
  ackSig?: string;
}

/** la:{通道}:{消息} —— 一件事的实时活动。不含任何推送内容 */
export interface LiveRecord {
  startedAt: number;
  ackBy?: string;
  /** 结束的时刻。有它就是墓碑 */
  endedAt?: number;
  end?: "resolved" | "retracted";
}

/** 每台设备的更新令牌放在键的 metadata 里：列一次前缀就拿全了，不必挨个读 */
interface EntryMeta {
  /** 更新令牌 */
  t: string;
  /** APNs 环境，和这台设备的推送令牌一致 */
  e: ApnsEnv;
  /** 手机报上来的开始时刻（毫秒）。记录没读到时拿它兜底 */
  s?: number;
}

interface Entry {
  name: string;
  accountId: string;
  meta: EntryMeta;
}

/** 一次推送里实时活动这一路做了什么（APNs 收下的条数），原样放进推送响应的 live */
export interface LiveReport {
  started?: number;
  updated?: number;
  ended?: number;
}

// ── 参数与键 ────────────────────────────────────────────────────────

/**
 * 发送方（或通道默认值）要了实时活动。请求里的 live 已经按开关规整成 "1" / "0"（见 push.ts SWITCH_PARAMS），
 * 通道默认值却是原样存的 —— 有人用接口设成 "true" 也得认
 */
export function liveRequested(params: Pick<PushParams, "live">): boolean {
  return ["1", "true", "yes", "on"].includes((params.live ?? "").trim().toLowerCase());
}

/** ActivityKit 的令牌：十六进制。长度随系统版本变，给个宽的范围 */
export function parseActivityToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const token = raw.trim().toLowerCase();
  return /^[0-9a-f]{16,512}$/.test(token) ? token : null;
}

/** 消息 id 和认领接口同一个规矩：非空、64 字以内、没有控制字符 */
export function validMessageId(id: string): boolean {
  return id.length > 0 && id.length <= 64 && !/[\u0000-\u001f]/.test(id);
}

/**
 * 消息 id 是发送方起的，什么字符都可能有。要按前缀列这件事的更新令牌，id 里的冒号会让
 * 「a」的前缀把「a:b」的也列进来 —— 编码一遍，键里就只剩字母数字和 %
 */
function liveKey(channelId: string, messageId: string): string {
  return `${LIVE}${channelId}:${encodeURIComponent(messageId)}`;
}

function entryPrefix(channelId: string, messageId: string): string {
  return `${liveKey(channelId, messageId)}:`;
}

/** 按设备分开存：同一台设备的新令牌覆盖旧的，不会越攒越多。键里只有令牌摘要的前 16 位，不放令牌本身 */
async function entryKey(channelId: string, messageId: string, accountId: string, device: Pick<Device, "token">): Promise<string> {
  return `${entryPrefix(channelId, messageId)}${accountId}.${(await sha256(device.token)).slice(0, 16)}`;
}

async function readRecord(env: Env, channelId: string, messageId: string): Promise<LiveRecord | null> {
  try {
    return await env.PIGEON_KV.get<LiveRecord>(liveKey(channelId, messageId), "json");
  } catch {
    return null;
  }
}

/** 写不进去不抛：记录只是为了后面的认领、恢复和晚到的登记，少了它这条推送照样送达 */
async function writeRecord(env: Env, channelId: string, messageId: string, record: LiveRecord): Promise<void> {
  try {
    await env.PIGEON_KV.put(liveKey(channelId, messageId), JSON.stringify(record), { expirationTtl: LIVE_TTL_SECONDS });
  } catch (err) {
    console.warn("实时活动记录没写进去", err);
  }
}

/** 这件事登记过的更新令牌。只留还收这个通道的人的（退了群的不再更新） */
async function listEntries(env: Env, channelId: string, messageId: string, recipients: Account[]): Promise<Entry[]> {
  const prefix = entryPrefix(channelId, messageId);
  let keys: { name: string; metadata?: unknown }[];
  try {
    keys = (await env.PIGEON_KV.list<EntryMeta>({ prefix })).keys;
  } catch {
    return [];
  }
  const members = new Set(recipients.map((a) => a.id));
  const entries: Entry[] = [];
  for (const key of keys) {
    const meta = key.metadata as EntryMeta | undefined;
    const accountId = key.name.slice(prefix.length).split(".")[0] ?? "";
    if (!meta?.t || !members.has(accountId)) continue;
    entries.push({ name: key.name, accountId, meta });
  }
  return entries;
}

// ── APNs ────────────────────────────────────────────────────────────

/**
 * 实时活动的推送头：推送类型 liveactivity，主题要加上 .push-type.liveactivity 后缀，否则 APNs 直接拒收。
 * 开始、认领、恢复都是要人马上看到的变化，一律 10
 */
function liveHeaders(env: Env, expiresAt?: number): ApnsHeaders {
  return {
    "apns-push-type": "liveactivity",
    "apns-topic": `${env.APNS_TOPIC}.push-type.liveactivity`,
    "apns-priority": "10",
    ...(expiresAt ? { "apns-expiration": String(expiresAt) } : {}),
  };
}

const seconds = (ms: number) => Math.floor(ms / 1000);

/** 开始：attributes 带上以后都不变的部分，alert 是 Apple 的硬性要求（开始时一定要提醒一下，免得凭空冒出来） */
export function startPayload(attributes: LiveAttributes, state: LiveContentState, relevance: number, now: number): Record<string, unknown> {
  return {
    aps: {
      timestamp: seconds(now),
      event: "start",
      "content-state": state,
      "attributes-type": ATTRIBUTES_TYPE,
      attributes,
      // 不带铃声：同一条消息的普通通知正在响，再响一声就成了两遍
      alert: { title: attributes.title, body: attributes.channelName },
      // iOS 18 起要显式要一个更新令牌，系统才会把它交给 App（17.x 本来就给，不认这个键）
      "input-push-token": 1,
      "relevance-score": relevance,
    },
  };
}

export function updatePayload(state: LiveContentState, relevance: number, now: number): Record<string, unknown> {
  return {
    aps: {
      timestamp: seconds(now),
      event: "update",
      "content-state": state,
      "relevance-score": relevance,
    },
  };
}

/** 结束：带上最终的状态，dismissal-date 之前它停在锁屏上。给过去的时刻就是立即收起 */
export function endPayload(state: LiveContentState, dismissAt: number, now: number): Record<string, unknown> {
  return {
    aps: {
      timestamp: seconds(now),
      event: "end",
      "content-state": state,
      "dismissal-date": seconds(dismissAt),
    },
  };
}

interface LiveTarget {
  token: string;
  env: ApnsEnv;
}

/** 并发推出去，数 APNs 收下了几条。不抛 */
async function sendAll(env: Env, targets: LiveTarget[], payload: Record<string, unknown>, headers: ApnsHeaders): Promise<PushResult[]> {
  return Promise.all(targets.map((target) => pushToDevice(env, target, payload, headers)));
}

const accepted = (results: PushResult[]) => results.filter((r) => r.status === 200).length;

/**
 * 更新令牌失效了（活动已经被人划掉、App 删了）：删掉那一条，下次不再推。
 * push-to-start 令牌失效不在这里处理 —— 它挂在账号记录上，推送途中不回写账号（见 db.ts recordPushOutcome 的理由），
 * App 拿到新令牌会自己来换
 */
async function dropDead(env: Env, entries: Entry[], results: PushResult[]): Promise<void> {
  await Promise.all(
    results.map(async (result, i) => {
      const entry = entries[i];
      if (!entry || !isDeadToken(result)) return;
      try {
        await env.PIGEON_KV.delete(entry.name);
      } catch {
        // 删不掉就等它过期
      }
    }),
  );
}

// ── 投递时 ──────────────────────────────────────────────────────────

/** 标题：给了标题用标题，否则副标题、正文第一行；都没有（只有密文）就是占位 */
export function liveTitle(params: PushParams, channelName: string): { title: string; sealed: boolean } {
  const pick = [params.title, params.subtitle, params.body?.split("\n").find((line) => line.trim())]
    .map((text) => text?.trim())
    .find((text) => text);
  if (pick) return { title: Array.from(pick).slice(0, TITLE_MAX).join(""), sealed: false };
  return params.ciphertext ? { title: SEALED_TITLE, sealed: true } : { title: channelName, sealed: false };
}

/** 接收者里有没有登记了 push-to-start 令牌的设备。没有的话连记录都不必读 —— 老用户的每条推送不多花一次存储读取 */
export function hasStartTokens(recipients: Pick<Account, "devices">[]): boolean {
  return recipients.some((account) => account.devices.some((device) => device.activityStartToken));
}

/**
 * 实时活动这一路最多要用多少个子请求（记入 push.ts deliveryCost）：读记录、列令牌、写记录、兜底一个；
 * 每台开着的设备推一次（失败重试一次）、结束时删一条令牌
 */
export function liveCost(recipients: Pick<Account, "devices">[]): number {
  const devices = recipients.reduce((sum, a) => sum + a.devices.filter((d) => d.activityStartToken).length, 0);
  return devices > 0 ? 4 + 3 * devices : 0;
}

export interface LiveDelivery {
  channel: Channel;
  recipients: Account[];
  /** 免打扰、通道策略处理之后，真正推出去的参数 */
  params: PushParams;
  messageId: string;
  sentAt: number;
  /** id 是发送方给的。服务端补的 id 以后没人能再引用，开了活动也永远等不到结束 */
  hadId: boolean;
  /** 这条最终是静默（passive）送达的：发送方自己要的，或者赶上了通道的免打扰时段 */
  passive: boolean;
  /** 原样（没被降成静默）送到了的设备的推送令牌。设了免打扰的人、没送到的设备都不开活动 */
  loudDelivered: Set<string>;
  ackSig?: string;
}

/**
 * 普通推送发完之后：firing 开活动、resolved 结束活动。补发的重复提醒不经过这里（见 deliver）。
 * 任何异常只记日志 —— 这条消息已经送到了，实时活动是锦上添花
 */
export async function liveAfterDelivery(env: Env, delivery: LiveDelivery): Promise<LiveReport | undefined> {
  if (!delivery.hadId) return undefined;
  const { params } = delivery;
  try {
    if (params.status === "firing" && liveRequested(params)) return await startLive(env, delivery);
    if (params.status === "resolved" && (liveRequested(params) || hasStartTokens(delivery.recipients))) {
      return await endLive(env, delivery.channel, delivery.recipients, delivery.messageId, delivery.sentAt, "resolved", liveRequested(params));
    }
  } catch (err) {
    console.error("实时活动出错", err);
  }
  return undefined;
}

/**
 * 开一个实时活动。同一件事已经开着（发送方周期性重发 firing）就什么也不做：
 * 重开会在手机上叠出第二块，而活动本身的计时一直在走，不需要重发来续命。
 *
 * 只开给「原样送到了」的设备：接收者给这个通道开了免打扰（紧急级别除外）、赶上通道的免打扰时段、
 * 发送方自己给的 passive，都和普通通知一样压低 —— 实时活动会点亮锁屏，压低就是不开。
 */
async function startLive(env: Env, delivery: LiveDelivery): Promise<LiveReport> {
  const { channel, recipients, params, messageId, sentAt } = delivery;
  if (delivery.passive) return { started: 0 };
  const targets: LiveTarget[] = recipients.flatMap((account) =>
    account.devices
      .filter((d) => d.activityStartToken && delivery.loudDelivered.has(d.token))
      .map((d) => ({ token: d.activityStartToken as string, env: d.env })),
  );
  if (targets.length === 0) return { started: 0 };

  const record = await readRecord(env, channel.id, messageId);
  if (record && !record.endedAt) return { started: 0 };

  const { title, sealed } = liveTitle(params, channel.name);
  const attributes: LiveAttributes = {
    channelId: channel.id,
    messageId,
    channelName: channel.name,
    title,
    startedAt: sentAt,
    ...(sealed ? { sealed: true } : {}),
    ...(delivery.ackSig ? { ackSig: delivery.ackSig } : {}),
  };
  // 时效性、紧急的排在前面（灵动岛只放得下一块）
  const urgent = (params.level ?? "").toLowerCase() === "critical" || /^time-?sensitive$/i.test(params.level ?? "");
  const now = Date.now();
  const payload = startPayload(attributes, { title, status: "firing", startedAt: sentAt }, urgent ? 100 : 50, now);
  const results = await sendAll(env, targets, payload, liveHeaders(env, seconds(now) + LIVE_START_EXPIRATION_SECONDS));
  const started = accepted(results);
  // 一块都没开成（APNs 那边出错）就不记「开着」：发送方下一次重发 firing 时还会再试
  if (started > 0) await writeRecord(env, channel.id, messageId, { startedAt: sentAt });
  return { started };
}

/**
 * 结束：恢复了定格 15 分钟，撤回立即收起。推完删掉各台设备的更新令牌，记录留作墓碑。
 *
 * 发起结束的这条消息自己要了实时活动（requested）时，即使一条令牌、一条记录都没读到，也立一块墓碑：
 * 开始和恢复前后脚到、落在不同机房时，这边可能还看不到那边刚写下的记录 —— 手机随后来登记更新令牌，
 * 墓碑让它知道这件事已经结束了
 */
export async function endLive(
  env: Env,
  channel: Channel,
  recipients: Account[],
  messageId: string,
  sentAt: number,
  end: "resolved" | "retracted",
  requested = false,
): Promise<LiveReport | undefined> {
  const [record, entries] = await Promise.all([
    readRecord(env, channel.id, messageId),
    listEntries(env, channel.id, messageId, recipients),
  ]);
  if (!record && entries.length === 0) {
    if (requested) await writeRecord(env, channel.id, messageId, { startedAt: sentAt, endedAt: sentAt, end });
    return undefined;
  }
  // 记录没读到（机房之间还没同步）：开始的时刻用手机报上来的
  const startedAt = record?.startedAt ?? minStarted(entries);
  let ended = 0;
  if (entries.length > 0) {
    const retracted = end === "retracted";
    const state: LiveContentState = {
      ...(retracted ? { title: "此消息已撤回" } : {}),
      status: "resolved",
      ...(record?.ackBy ? { ackBy: record.ackBy } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      resolvedAt: sentAt,
    };
    const now = Date.now();
    // 撤回：给一个已经过去的时刻，系统立即收起；恢复：从恢复那一刻算 15 分钟
    const dismissAt = retracted ? now - 1000 : Math.max(sentAt, now) + LIVE_DISMISS_AFTER_MS;
    const results = await sendAll(env, entries.map(target), endPayload(state, dismissAt, now), liveHeaders(env));
    ended = accepted(results);
    await Promise.all(
      entries.map(async (entry) => {
        try {
          await env.PIGEON_KV.delete(entry.name);
        } catch {
          // 删不掉就等它过期（LIVE_TTL_SECONDS）
        }
      }),
    );
  }
  if (!record?.endedAt) {
    await writeRecord(env, channel.id, messageId, {
      startedAt: startedAt ?? sentAt,
      ...(record?.ackBy ? { ackBy: record.ackBy } : {}),
      endedAt: sentAt,
      end,
    });
  }
  return { ended };
}

/** 有人认领了：推一次 update，换成「张三 正在处理」。已经结束的不动 */
export async function liveOnAck(
  env: Env,
  channel: Channel,
  recipients: Account[],
  messageId: string,
  who: string,
): Promise<LiveReport | undefined> {
  if (!hasStartTokens(recipients)) return undefined;
  try {
    const [record, entries] = await Promise.all([
      readRecord(env, channel.id, messageId),
      listEntries(env, channel.id, messageId, recipients),
    ]);
    if (record?.endedAt || (!record && entries.length === 0)) return undefined;
    const startedAt = record?.startedAt ?? minStarted(entries);
    // 记下来：之后才开起来的手机来登记时，直接告诉它谁在处理
    await writeRecord(env, channel.id, messageId, { startedAt: startedAt ?? Date.now(), ackBy: who });
    if (entries.length === 0) return { updated: 0 };
    const now = Date.now();
    const state: LiveContentState = { status: "acked", ackBy: who, ...(startedAt !== undefined ? { startedAt } : {}) };
    // 有人在管了，让位给还没人管的
    const results = await sendAll(env, entries.map(target), updatePayload(state, 30, now), liveHeaders(env));
    await dropDead(env, entries, results);
    return { updated: accepted(results) };
  } catch (err) {
    console.error("实时活动的认领更新出错", err);
    return undefined;
  }
}

/** 撤回：立即收起 */
export async function liveOnRetract(
  env: Env,
  channel: Channel,
  recipients: Account[],
  messageId: string,
  sentAt: number,
  requested: boolean,
): Promise<LiveReport | undefined> {
  if (!requested && !hasStartTokens(recipients)) return undefined;
  try {
    return await endLive(env, channel, recipients, messageId, sentAt, "retracted", requested);
  } catch (err) {
    console.error("实时活动的撤回出错", err);
    return undefined;
  }
}

function target(entry: Entry): LiveTarget {
  return { token: entry.meta.t, env: entry.meta.e };
}

function minStarted(entries: Entry[]): number | undefined {
  const all = entries.map((e) => e.meta.s).filter((s): s is number => typeof s === "number");
  return all.length ? Math.min(...all) : undefined;
}

// ── App 登记令牌 ────────────────────────────────────────────────────

/** 登记更新令牌的结果，原样回给 App */
export type ActivityRegistration =
  | { registered: true; status: "firing" | "acked"; ack_by?: string }
  | { registered: false; ended: true; status: "resolved" | "retracted"; ended_at: number; ack_by?: string };

/**
 * 手机上开起来一个活动，App 拿到它的更新令牌来登记。
 *
 * 这件事已经结束了（墓碑的结束时刻不早于这个活动的开始）：不登记，告诉 App 结束了，它当场收起 ——
 * 恢复比开始先一步处理完、推送在 APNs 那里存到手机联网才送达，都会走到这里。
 * 已经有人认领了：照常登记，同时告诉 App 是谁，它自己换成「某某 正在处理」（那次 update 推的时候还没有这个令牌）
 */
export async function registerActivity(
  env: Env,
  channelId: string,
  messageId: string,
  accountId: string,
  device: Device,
  token: string,
  startedAt: number | undefined,
): Promise<ActivityRegistration> {
  const record = await readRecord(env, channelId, messageId);
  const ackBy = record?.ackBy ? { ack_by: record.ackBy } : {};
  // 手机没报开始时刻（不该发生）就按已结束算：宁可收起一块，也不留一块永远在走的
  if (record?.endedAt !== undefined && (startedAt === undefined || record.endedAt >= startedAt)) {
    return { registered: false, ended: true, status: record.end ?? "resolved", ended_at: record.endedAt, ...ackBy };
  }
  const meta: EntryMeta = { t: token, e: device.env, ...(startedAt !== undefined ? { s: startedAt } : {}) };
  await env.PIGEON_KV.put(await entryKey(channelId, messageId, accountId, device), "", {
    expirationTtl: LIVE_TTL_SECONDS,
    metadata: meta,
  });
  // 墓碑是上一次的（这次的开始晚于它的结束）：这是同一个 id 又触发了一次，那次的认领不算数
  const current = record && !record.endedAt ? record : null;
  return current?.ackBy
    ? { registered: true, status: "acked", ack_by: current.ackBy }
    : { registered: true, status: "firing" };
}
