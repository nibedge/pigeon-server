import {
  deleteWatch,
  getChannel,
  indexWatch,
  isValidId,
  isWatchDeleted,
  markWatchIndexComplete,
  mergeWatch,
  readWatchConfig,
  readWatchState,
  recipientsOf,
  removeWatchLeftovers,
  sha256,
  watchCatalog,
  watchIndexComplete,
  writeWatchState,
  type StoredWatchState,
} from "./db";
import { deliver } from "./push";
import type { Channel, Env, Watch } from "./types";

// 存储在 db.ts（键的布局见那里的「监控存储」一节）；这几个一直从这里导出，调用方不用改
export { countWatches, createWatch, deleteWatch, getWatch, listWatches } from "./db";

/** 一个账号最多盯多少个（心跳也算在内）。个人用够了，也挡住有人拿它当爬虫 */
export const MAX_WATCHES = 20;
/** cron 每 5 分钟跑一次，比这更密没意义 */
export const MIN_INTERVAL_MINUTES = 5;
/**
 * 网址监控最稀一天看一次。再稀就谈不上「掉线了告诉你」；间隔随手填成几万分钟的监控，
 * 也会在 cron 眼皮底下躺上几个月都轮不到检查
 */
export const MAX_SITE_INTERVAL_MINUTES = 24 * 60;
/** 心跳的预期间隔最长 7 天：每周跑一次的任务是最稀的常见周期 */
export const MAX_HEARTBEAT_MINUTES = 7 * 24 * 60;
/**
 * 心跳宽限的下限。cron 5 分钟才看一轮，任务报到的时刻本身也有几分钟出入；
 * 比这更紧，只会把「晚到两分钟」当成失联。
 */
export const MIN_GRACE_MINUTES = 5;
/** 宽限的上限：一天。再宽，任务真挂了要隔天才知道 */
export const MAX_GRACE_MINUTES = 24 * 60;
/** 正常报到写回 KV 的最小间隔，为什么是 4 分钟见 heartbeatStep */
export const PING_PERSIST_MS = 4 * 60_000;
/** 抓取超时。Worker 的 subrequest 有时限，别卡死整轮 */
const FETCH_TIMEOUT_MS = 10_000;
/** 关键词匹配只读这么多字节，页面再大也不至于撑爆内存 */
const MAX_BODY_BYTES = 512 * 1024;

export interface WatchInput {
  channelId: string;
  kind: "up" | "keyword" | "heartbeat";
  /** up / keyword 必填；heartbeat 不要 */
  url?: string;
  /** kind=keyword 时：要找的词 */
  keyword?: string;
  /** kind=keyword 时：true=出现了就提醒（抢票开了），false=消失了就提醒 */
  present?: boolean;
  /** heartbeat 必填：任务多久报到一次 */
  intervalMinutes?: number;
  /** kind=heartbeat 时：过了预期时刻再等多久才提醒，缺省为间隔的一成（至少 5 分钟） */
  graceMinutes?: number;
  name?: string;
}

/** 校验并规整用户提交的监控。返回错误说明，或规整后的字段 */
export function parseWatchInput(raw: unknown): string | Omit<Watch, "id" | "ownerId" | "createdAt"> {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const kind =
    v.kind === "keyword" ? "keyword" : v.kind === "up" ? "up" : v.kind === "heartbeat" ? "heartbeat" : null;
  if (!kind) return "kind 只能是 up、keyword 或 heartbeat";
  if (kind === "heartbeat") return parseHeartbeatInput(v);

  const url = String(v.url ?? "").trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "url 不是合法的网址";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "只支持 http / https 网址";
  }

  const channelId = String(v.channelId ?? "");
  if (!isValidId(channelId)) return "channelId 格式不对";

  const interval = siteInterval(Math.floor(Number(v.intervalMinutes) || 15));
  const name = String(v.name ?? "").trim().slice(0, 40) || parsed.hostname;

  if (kind === "keyword") {
    const keyword = String(v.keyword ?? "").trim().slice(0, 100);
    if (!keyword) return "关键词监控要给出 keyword";
    return {
      channelId, kind, url: parsed.toString(), keyword,
      present: v.present !== false, intervalMinutes: interval, name,
    };
  }
  return { channelId, kind, url: parsed.toString(), intervalMinutes: interval, name };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 网址监控的检查间隔夹到 5 分钟 ~ 1 天。老数据里没夹过上限的，按这个算到期 */
function siteInterval(minutes: number): number {
  return clamp(Number.isFinite(minutes) ? minutes : 15, MIN_INTERVAL_MINUTES, MAX_SITE_INTERVAL_MINUTES);
}

/** 宽限缺省为间隔的一成：每 5 分钟一次的任务等 5 分钟，每天一次的等 2 小时 24 分 */
export function defaultGraceMinutes(intervalMinutes: number): number {
  return clamp(Math.max(MIN_GRACE_MINUTES, Math.ceil(intervalMinutes * 0.1)), MIN_GRACE_MINUTES, MAX_GRACE_MINUTES);
}

/**
 * 心跳：没有网址，只有「多久报到一次」。
 *
 * 间隔不给缺省值：猜错的代价是误报 —— 每天跑一次的备份被当成每小时一次，第一天就会响。
 * 新建的心跳状态是 new：任务还没来报到过，不管等多久都不提醒，免得刚建好、脚本还没改完就响。
 */
function parseHeartbeatInput(v: Record<string, unknown>): string | Omit<Watch, "id" | "ownerId" | "createdAt"> {
  const channelId = String(v.channelId ?? "");
  if (!isValidId(channelId)) return "channelId 格式不对";

  const every = Math.floor(Number(v.intervalMinutes));
  if (!Number.isFinite(every) || every <= 0) return "心跳监控要给出 intervalMinutes：任务多久报到一次（分钟）";
  const interval = clamp(every, MIN_INTERVAL_MINUTES, MAX_HEARTBEAT_MINUTES);

  const rawGrace = v.graceMinutes;
  const grace = Math.floor(Number(rawGrace));
  const graceMinutes =
    rawGrace === undefined || rawGrace === null || rawGrace === "" || !Number.isFinite(grace)
      ? defaultGraceMinutes(interval)
      : clamp(grace, MIN_GRACE_MINUTES, MAX_GRACE_MINUTES);

  const name = String(v.name ?? "").trim().slice(0, 40) || "心跳";
  return { channelId, kind: "heartbeat", intervalMinutes: interval, graceMinutes, name, lastStatus: "new" };
}

// ── 抓取与判定 ──────────────────────────────────────────────────────

/** 有网址可抓的监控：up / keyword */
type SiteWatch = Watch & { url: string };

function isSiteWatch(watch: Watch): watch is SiteWatch {
  return watch.kind !== "heartbeat" && typeof watch.url === "string" && watch.url !== "";
}

interface Probe {
  /** "up"：在线；"down"：掉线 / 出错。"present"/"absent"：关键词在不在 */
  status: string;
  detail: string;
}

async function fetchText(url: string): Promise<{ ok: boolean; status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": "PigeonWatch/1.0 (+https://nfo.im)" },
      cf: { cacheTtl: 0 },
    });
    let text = "";
    // keyword 才需要正文；up 只看状态码。读之前先看内容类型，别把二进制/大文件读进来
    const type = res.headers.get("content-type") ?? "";
    if (res.body && (type.includes("text") || type.includes("json") || type.includes("xml") || type.includes("html"))) {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          total += value.length;
          if (total >= MAX_BODY_BYTES) {
            await reader.cancel();
            break;
          }
        }
      }
      text = new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
    } else {
      // 不读正文也要把连接放掉
      await res.body?.cancel();
    }
    return { ok: res.ok || (res.status >= 300 && res.status < 400), status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

async function probe(watch: SiteWatch): Promise<Probe> {
  try {
    const { ok, status, text } = await fetchText(watch.url);
    if (watch.kind === "up") {
      return ok
        ? { status: "up", detail: `HTTP ${status}` }
        : { status: "down", detail: `HTTP ${status}` };
    }
    // keyword
    const hit = text.includes(watch.keyword ?? "");
    return hit
      ? { status: "present", detail: `找到了「${watch.keyword}」` }
      : { status: "absent", detail: `没有「${watch.keyword}」` };
  } catch {
    // 抓取失败：up 当作掉线；keyword 无法判定，保持上次状态（返回特殊标记）
    return watch.kind === "up"
      ? { status: "down", detail: "连不上" }
      : { status: "error", detail: "抓取失败" };
  }
}

/** 状态变化时要不要提醒、推什么。返回 null 表示这次不推 */
function messageFor(watch: SiteWatch, prev: string | undefined, probe: Probe): { params: Record<string, string> } | null {
  if (probe.status === "error") return null;
  if (prev === probe.status) return null; // 没变化，不打扰

  const id = `watch-${watch.id}`;
  if (watch.kind === "up") {
    if (probe.status === "down") {
      return { params: { title: `🔴 ${watch.name} 掉线了`, body: `${watch.url}\n${probe.detail}`, level: "timeSensitive", status: "firing", id, tags: "rotating_light", url: watch.url } };
    }
    // 恢复。prev 为 undefined（第一次就在线）不提醒，避免刚建就响
    if (prev === undefined) return null;
    return { params: { title: `🟢 ${watch.name} 恢复了`, body: `${watch.url}\n${probe.detail}`, level: "active", status: "resolved", id, tags: "white_check_mark", url: watch.url } };
  }

  // keyword：只在满足「用户关心的方向」时提醒
  const wantPresent = watch.present !== false;
  const nowMatches = (probe.status === "present") === wantPresent;
  if (!nowMatches) return null;
  if (prev === undefined) return null; // 建的时候就已经是目标状态，不提醒
  const verb = probe.status === "present" ? "出现了" : "消失了";
  return { params: { title: `🔔 ${watch.name}`, body: `「${watch.keyword}」${verb}\n${watch.url}`, level: "timeSensitive", id: `${id}-${probe.status}`, tags: "eyes", url: watch.url } };
}

// ── 心跳 ────────────────────────────────────────────────────────────

/** 心跳要推的三种消息：没按时报到（cron 判出来的）、任务自己报了失败、失联或失败之后又正常报到了 */
export type HeartbeatEvent = "down" | "failed" | "recovered";

/**
 * 收到一次报到（正常或失败）之后：新状态、要不要写回 KV、要不要推。
 *
 * 写回有节流：状态没变（up → up）时，离上次记下的报到不满 4 分钟就不写。每次报到都写的话，
 * 每分钟报一次的任务一天就是 1440 次 KV 写入。省掉的这些写入不会造成误报：
 * - 失联要等 cron 那一轮才判得出来，而 cron 5 分钟才一轮，报到时刻记得再准也快不了
 * - 记下的时刻最多比实际旧 4 分钟（再旧就会写），而判定失联还要再过一段宽限 ——
 *   宽限至少 5 分钟，吃得下这点误差
 * - 间隔至少 5 分钟：按时报到的任务，每次都离上次超过 4 分钟，一次也不会被省掉；
 *   被省掉的只有报得比约定还勤的
 */
export function heartbeatStep(
  watch: Watch,
  report: { failed: boolean },
  now: number,
): { watch: Watch; persist: boolean; event: HeartbeatEvent | null } {
  const prev = watch.lastStatus;
  const status = report.failed ? "down" : "up";
  // 失联或报了失败之后的第一次正常报到才是恢复；new → up 只是第一次报到，没什么可恢复的
  const event: HeartbeatEvent | null = report.failed ? "failed" : prev === "down" ? "recovered" : null;
  const persist = status !== prev || now - (watch.lastPingAt ?? 0) >= PING_PERSIST_MS;
  return { watch: { ...watch, lastStatus: status, lastPingAt: now }, persist, event };
}

/**
 * 心跳过了哪一刻还没来就算失联：最近一次报到 +「间隔 + 宽限」。不用排队的返回 0：
 * new 从不告警 —— 任务还没接上；down 已经告过警了，不再重复，等它回来推「恢复」。
 * 写状态时连同它记进 metadata，cron 翻键时据此挑出到期的
 */
export function heartbeatDeadline(watch: Watch): number {
  if (watch.kind !== "heartbeat" || watch.lastStatus !== "up" || watch.lastPingAt === undefined) return 0;
  const grace = watch.graceMinutes ?? defaultGraceMinutes(watch.intervalMinutes);
  return watch.lastPingAt + (watch.intervalMinutes + grace) * 60_000;
}

/** 心跳是否失联：报到过（up），且过了「间隔 + 宽限」还没再来 */
export function heartbeatOverdue(watch: Watch, now: number): boolean {
  const deadline = heartbeatDeadline(watch);
  return deadline > 0 && now > deadline;
}

/** 网址监控下一次该检查的时刻。还没检查过的，现在就该 */
export function siteDueAt(watch: Watch): number {
  return (watch.lastCheckedAt ?? 0) + siteInterval(watch.intervalMinutes) * 60_000;
}

/** 写进状态 metadata 的「下一次该看它的时刻」，按类型分别算 */
function nextDueAt(watch: Watch): number {
  return watch.kind === "heartbeat" ? heartbeatDeadline(watch) : siteDueAt(watch);
}

/** 分钟数 → 「5 分钟」「1 小时 30 分钟」「2 天 3 小时」。过了一天就不再细到分钟 */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  if (m < 60) return `${m} 分钟`;
  if (m < 24 * 60) {
    const hours = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
  }
  const days = Math.floor(m / (24 * 60));
  const hours = Math.floor((m % (24 * 60)) / 60);
  return hours ? `${days} 天 ${hours} 小时` : `${days} 天`;
}

/**
 * 心跳告警的消息 id。失联、报告失败、恢复共用这一个，App 才能把它们算成同一件事、算出持续多久。
 *
 * 由监控 id 单向推出来，而不是直接拼成 hb-{监控 id}：监控 id 就是报到地址 /hb/{id} 的那一段，
 * 拿到它就能替任务报平安（把真正的失联盖住），或者往通道里推一条「报告失败」。而消息 id
 * 会随 payload 落到群里每个成员的手机上 —— 成员只接收，不该因此拿到往群里推消息的门路。
 */
export async function heartbeatMessageId(watchId: string): Promise<string> {
  return `hb-${(await sha256(`hb:${watchId}`)).slice(0, 24)}`;
}

async function heartbeatMessage(
  watch: Watch,
  event: HeartbeatEvent,
  now: number,
  detail = "",
): Promise<Record<string, string>> {
  const id = await heartbeatMessageId(watch.id);
  if (event === "down") {
    const silent = formatMinutes((now - (watch.lastPingAt ?? now)) / 60_000);
    return {
      title: `🔴「${watch.name}」没有按时上报`,
      body: `上次上报在 ${silent}前，预期每 ${formatMinutes(watch.intervalMinutes)}一次。`,
      level: "timeSensitive", status: "firing", id, tags: "rotating_light",
    };
  }
  if (event === "failed") {
    return {
      title: `🔴「${watch.name}」报告失败`,
      body: detail || "任务报告了失败，没有附带说明。",
      level: "timeSensitive", status: "firing", id, tags: "x",
    };
  }
  return {
    title: `🟢「${watch.name}」恢复上报`,
    body: "又收到正常上报了。",
    level: "active", status: "resolved", id, tags: "white_check_mark",
  };
}

/** 报到的结果。missing：没有这个心跳（或者刚删掉）；suspended：推给的通道被停用了 */
export type HeartbeatOutcome =
  | { ok: true; watch: Watch }
  | { ok: false; reason: "missing" | "suspended" };

const MISSING: HeartbeatOutcome = { ok: false, reason: "missing" };

/**
 * 任务来报到：/hb/{id} 是正常，/hb/{id}/fail 是失败。
 *
 * 只写状态键 hbstate:{id}，不碰配置：晚到一步的报到最多多写一次状态，写不回一个删掉的监控。
 * 要写要推之前先确认三件事 —— 没被删（墓碑）、通道还在（不在了就连心跳一起删）、通道没被停用
 * （停用期间不推也不改状态，但心跳留着，申诉恢复后接着用）。报得比约定还勤的那些次什么都不写，
 * 这三样也就不查：热路径上每次报到只读配置和状态两次，停用和删除最多晚几分钟才反映到回应上。
 *
 * 和 cron 一样先推后写：推送中途出错的话状态还没改，下一次报到会再推一遍，
 * 不会落得「状态记了、通知没发」。
 */
export async function recordHeartbeat(
  env: Env,
  id: string,
  report: { failed: boolean; message?: string },
  now: number = Date.now(),
): Promise<HeartbeatOutcome> {
  if (!isValidId(id)) return MISSING;
  const [stored, state] = await Promise.all([readWatchConfig(env, id), readWatchState(env, "heartbeat", id)]);
  if (!stored || stored.kind !== "heartbeat") return MISSING;

  const watch = mergeWatch(stored, state);
  const step = heartbeatStep(watch, report, now);
  if (!step.event && !step.persist) return { ok: true, watch: step.watch };

  const [deleted, channel] = await Promise.all([isWatchDeleted(env, id), getChannel(env, stored.channelId)]);
  if (deleted) return MISSING;
  if (!channel) {
    // 通道没了心跳还在：删通道、删号时漏下的（改版之前就是这样）。这个心跳也没有意义了
    await deleteWatch(env, stored, now);
    return MISSING;
  }
  if (channel.suspended) {
    // 只照记一件事：一直按时报到的任务还活着。不记的话申诉恢复之后，cron 看到的还是停用那一刻的
    // 报到时刻，会把好好的任务当成失联。失败不记 —— 推不出去，记成 down 反倒让恢复后多推一条「恢复」
    if (!report.failed && watch.lastStatus === "up") {
      const alive: Watch = { ...watch, lastPingAt: now };
      await writeWatchState(env, alive, nextDueAt(alive), now);
    }
    return { ok: false, reason: "suspended" };
  }

  if (step.event) {
    const params = await heartbeatMessage(watch, step.event, now, report.message);
    await deliver(env, channel, await recipientsOf(env, channel), params);
  }
  await writeWatchState(env, step.watch, nextDueAt(step.watch), now);
  return { ok: true, watch: step.watch };
}

// ── 定时执行 ────────────────────────────────────────────────────────

/** 一轮 cron 做了什么 */
export interface ScheduledReport {
  /** 真正去抓了的网址 */
  checked: number;
  /** 推出去的告警 */
  alerted: number;
  /** 补进索引的老监控 */
  adopted: number;
  /** 推给的通道已经没了、顺手删掉的监控 */
  removed: number;
  /** 清掉的残键 */
  leftovers: number;
}

/**
 * 按列表带回来的 metadata，这一轮要不要看它。返回排队用的时刻，不用看返回 null。
 * 拿不准的（没有 metadata、不知道类型）也看 —— 读到值之后还会再判断一次
 */
function catalogDue(heartbeat: boolean | undefined, state: StoredWatchState | null | undefined, now: number): number | null {
  if (state === undefined) {
    // 还没有状态键：心跳是 new，不用看；网址监控还没检查过，现在就该
    return heartbeat === true ? null : 0;
  }
  if (state === null) return 0;
  if (heartbeat ?? (state.kind === "heartbeat")) {
    return state.nextDueAt > 0 && now > state.nextDueAt ? state.nextDueAt : null;
  }
  return now >= state.nextDueAt ? state.nextDueAt : null;
}

/**
 * 老监控（改版之前建的）第一次被 cron 看到：补上索引，配置里的旧状态搬进状态键。配置原样不动 ——
 * cron 从不写配置。推给的通道早就没了的（那时删号、删通道还不会连带删监控），直接删掉。
 *
 * 这一轮不接着检查它：搬过去的状态下一轮就在列表里了，最多晚 5 分钟；同一轮里再检查、再写一次状态，
 * 就撞上 KV 同一个键每秒只能写一次的限制。
 */
async function adoptLegacyWatch(
  env: Env,
  id: string,
  hasState: boolean,
  now: number,
): Promise<"adopted" | "removed" | "gone"> {
  const stored = await readWatchConfig(env, id);
  if (!stored || (await isWatchDeleted(env, id))) return "gone";
  if (!(await getChannel(env, stored.channelId))) {
    await deleteWatch(env, stored, now);
    return "removed";
  }
  // 已经有状态键（迁移之前它刚报到过一次）就以那份为准；没有才从配置里的旧字段搬
  if (!hasState && !(await readWatchState(env, stored.kind, id))) {
    const watch = mergeWatch(stored, null);
    await writeWatchState(env, watch, nextDueAt(watch), now);
  }
  await indexWatch(env, stored);
  return "adopted";
}

/**
 * 监控推给的通道，确认还能推。通道没了：监控也没有意义了，删掉；
 * 通道被停用：这一轮跳过，不删 —— 申诉恢复之后接着盯，监控和报到地址都还在
 */
async function liveChannel(env: Env, watch: Watch, now: number, report: ScheduledReport): Promise<Channel | null> {
  const channel = await getChannel(env, watch.channelId);
  if (!channel) {
    await deleteWatch(env, watch, now);
    report.removed += 1;
    return null;
  }
  return channel.suspended ? null : channel;
}

/** 处理一个（按列表看）到期的监控。值以这一刻读到的为准 */
async function runDueWatch(env: Env, id: string, now: number, report: ScheduledReport): Promise<void> {
  const stored = await readWatchConfig(env, id);
  if (!stored) return;
  const watch = mergeWatch(stored, await readWatchState(env, stored.kind, id));

  // 心跳不抓网址，只比一下报到时刻。列表可能比值旧一步：刚报到过的，以值为准，不误报
  if (watch.kind === "heartbeat") {
    if (!heartbeatOverdue(watch, now)) return;
    const channel = await liveChannel(env, watch, now, report);
    if (!channel || (await isWatchDeleted(env, id))) return;
    await deliver(env, channel, await recipientsOf(env, channel), await heartbeatMessage(watch, "down", now));
    report.alerted += 1;
    // 记成 down：之后不再重复告警，等任务回来报到时推「恢复」
    const down: Watch = { ...watch, lastStatus: "down" };
    await writeWatchState(env, down, nextDueAt(down), now);
    return;
  }
  if (!isSiteWatch(watch) || now < siteDueAt(watch)) return;

  const channel = await liveChannel(env, watch, now, report);
  if (!channel) return;
  report.checked += 1;
  const result = await probe(watch);
  const outgoing = messageFor(watch, watch.lastStatus, result);
  // 抓取的这几秒里被删了：不推，也不把状态写回去
  if (await isWatchDeleted(env, id)) return;
  if (outgoing) {
    await deliver(env, channel, await recipientsOf(env, channel), outgoing.params);
    report.alerted += 1;
  }
  // error（keyword 抓取失败）不覆盖上次的有效状态
  const next: Watch = { ...watch, lastCheckedAt: now, lastStatus: result.status === "error" ? watch.lastStatus : result.status };
  await writeWatchState(env, next, nextDueAt(next), now);
}

/**
 * cron 每轮：把到点的监控抓一遍，状态变了就推给对应通道；心跳看有没有按时报到。
 *
 * 先翻一遍键（配置、索引、状态，全部翻页取全），只凭状态键的 metadata 挑出到期的，
 * 没到期的一条也不读 —— 每轮的读取随到期的数量涨，不随监控总数涨。到期的按该看的时刻先后处理。
 * 顺手做两件维护：给老监控补索引（全部补完就记下标记），清掉配置已经没了的残键。
 *
 * 每个监控独立 try/catch —— 一个网站抓炸了不能带垮整轮。抓取和推送都做完再写状态，
 * 写在最后：中途失败下轮重来，不会因为「状态记了、通知没发」而漏掉一次告警。
 */
export async function runScheduled(env: Env, now: number = Date.now()): Promise<ScheduledReport> {
  const report: ScheduledReport = { checked: 0, alerted: 0, adopted: 0, removed: 0, leftovers: 0 };
  const catalog = await watchCatalog(env);
  let unindexed = 0;
  const due: { id: string; at: number }[] = [];

  for (const id of catalog.configs) {
    const listed = catalog.states.get(id);
    const indexed = catalog.index.get(id);
    if (!indexed) {
      try {
        const outcome = await adoptLegacyWatch(env, id, listed !== undefined, now);
        if (outcome === "adopted") report.adopted += 1;
        if (outcome === "removed") report.removed += 1;
      } catch {
        unindexed += 1;
      }
      continue;
    }
    const heartbeat = listed?.heartbeat ?? (indexed.meta?.kind ? indexed.meta.kind === "heartbeat" : undefined);
    const at = catalogDue(heartbeat, listed ? listed.state : undefined, now);
    if (at !== null) due.push({ id, at });
  }

  due.sort((a, b) => a.at - b.at);
  for (const { id } of due) {
    try {
      await runDueWatch(env, id, now, report);
    } catch {
      // 单个监控的任何异常都不该影响其它监控
    }
  }

  try {
    report.leftovers = await removeWatchLeftovers(env, catalog, now);
    if (unindexed === 0 && !(await watchIndexComplete(env))) await markWatchIndexComplete(env, now);
  } catch {
    // 维护做不完下一轮接着做
  }
  return report;
}
