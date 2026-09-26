import {
  claimSweepNotice,
  deleteWatch,
  getChannel,
  getModChannelId,
  indexWatch,
  isValidId,
  isWatchDeleted,
  markWatchIndexComplete,
  meteredEnv,
  mergeWatch,
  readWatchConfig,
  readWatchState,
  recipientsOf,
  recordSweep,
  removeWatchLeftovers,
  sha256,
  watchCatalog,
  watchIndexComplete,
  writeWatchState,
  type StoredWatchState,
  type SweepKind,
  type SweepRecord,
  type WatchCatalog,
} from "./db";
import { deliver, repeatMinutes, runReminders, type DeliveryReport } from "./push";
import type { Account, Channel, Env, PushParams, Watch } from "./types";

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
/**
 * 抓取超时，连读正文一起算。原先是 10 秒：一个故意慢慢吐字节的网址就能占满一个抓取位 10 秒，
 * 几十个这样的监控就能把一轮 cron 拖过 5 分钟。正常的网站 5 秒内早就回应了
 */
export const FETCH_TIMEOUT_MS = 5_000;
/** 同时在抓的网址最多几个。Workers 一次调用同时等响应的连接最多 6 个，开得再多也只是排队 */
export const FETCH_CONCURRENCY = 6;
/** 关键词匹配只读这么多字节，页面再大也不至于撑爆内存 */
const MAX_BODY_BYTES = 512 * 1024;
/**
 * 连续失败几次才算掉线，新建之后的第一次检查也一样。只抓一次就报的话，一次网络抖动、一次超时，
 * 半夜就是一条「掉线了」，几分钟后再来一条「恢复了」—— 误报多了，人就会把通道静音，真掉线时也听不见
 */
export const DOWN_AFTER_FAILURES = 2;
/** 连续这么多次等不到回应，就暂停常规检查、改成每天试一次，并告诉创建者一声 */
export const PAUSE_AFTER_TIMEOUTS = 8;
/** 暂停之后隔多久试一次；超时退避也不超过这个 */
export const PAUSED_CHECK_MS = 24 * 60 * 60_000;
/**
 * 告警推不出去（APNs 5xx、限流、网络出错、一台设备都没有）最多试几轮。之后放弃并记日志，
 * 免得一个没有可用设备的通道每 5 分钟空转一次
 */
export const MAX_ALERT_ATTEMPTS = 3;
/** 失败待确认、告警待重推：下一轮就再看，cron 5 分钟一轮 */
const RETRY_MS = MIN_INTERVAL_MINUTES * 60_000;
/** 存下来的失败说明截到这么长：它也放进状态键的 metadata，那里总共只有 1KB */
const MAX_DETAIL = 60;

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
  /** 提醒强度："active"（普通）或 "timeSensitive"（重要） */
  level?: string;
  /** 重复提醒的间隔分钟数，规则同推送参数 repeat */
  repeat?: number | string | boolean;
}

/** level 的写法，全部规整成两种 */
const LEVELS: Record<string, NonNullable<Watch["level"]>> = {
  active: "active",
  timesensitive: "timeSensitive",
  "time-sensitive": "timeSensitive",
};

/**
 * 提醒强度：level 和 repeat，三种监控都可以带。
 * repeat 的规则和推送参数一样（"1"/true = 每 5 分钟，数字夹到 5–60，0 或乱写 = 不重复）；
 * level 写错了直接报错 —— 悄悄当成没设的话，用户以为选了「重要」，半夜来的却是一条普通通知
 */
function parseStrength(v: Record<string, unknown>): string | Pick<Watch, "level" | "repeat"> {
  const strength: Pick<Watch, "level" | "repeat"> = {};
  if (v.level !== undefined && v.level !== null && v.level !== "") {
    const level = typeof v.level === "string" ? LEVELS[v.level.trim().toLowerCase()] : undefined;
    if (!level) return "level 只能是 active（普通）或 timeSensitive（重要）";
    strength.level = level;
  }
  if (v.repeat !== undefined && v.repeat !== null) {
    const every = repeatMinutes(String(v.repeat));
    if (every > 0) strength.repeat = every;
  }
  return strength;
}

/** 校验并规整用户提交的监控。返回错误说明，或规整后的字段 */
export function parseWatchInput(raw: unknown): string | Omit<Watch, "id" | "ownerId" | "createdAt"> {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const kind =
    v.kind === "keyword" ? "keyword" : v.kind === "up" ? "up" : v.kind === "heartbeat" ? "heartbeat" : null;
  if (!kind) return "kind 只能是 up、keyword 或 heartbeat";
  const parsed = kind === "heartbeat" ? parseHeartbeatInput(v) : parseSiteInput(v, kind);
  if (typeof parsed === "string") return parsed;
  const strength = parseStrength(v);
  if (typeof strength === "string") return strength;
  return { ...parsed, ...strength };
}

function parseSiteInput(
  v: Record<string, unknown>,
  kind: "up" | "keyword",
): string | Omit<Watch, "id" | "ownerId" | "createdAt"> {
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

// ── 告警怎么推 ──────────────────────────────────────────────────────

/**
 * 通道默认值里用在监控告警上的几项：只取「怎么提醒」，不取内容 —— 标题正文、链接由监控自己写，
 * 通道默认的标题、密文之类混进来只会把告警改得面目全非。
 * 「恢复」只取铃声、分组这类：通道默认的持续响铃、重复提醒不该落在好消息上
 */
const FIRING_DEFAULTS = ["level", "sound", "volume", "call", "group", "icon", "isArchive", "ttl", "badge", "repeat"] as const;
const RESOLVED_DEFAULTS = ["sound", "group", "icon", "isArchive", "ttl", "badge"] as const;

/**
 * 一条监控告警最终推出去的参数，从下往上叠：
 *   通道默认值（用户在 App 里给通道设的铃声、重复提醒……）
 *   → 告警自己的判断（掉线是 timeSensitive、恢复是 active，标题正文、事件 id）
 *   → 这个监控自己设的提醒强度（level / repeat），只管告警、不管恢复
 *
 * 原先告警完全不看通道默认值：给通道设了「直到有人处理」，别的推送都照做，唯独最该吵醒人的掉线告警只响一次
 */
export function alertParams(
  channel: Pick<Channel, "defaults">,
  watch: Pick<Watch, "level" | "repeat">,
  own: PushParams,
): PushParams {
  const resolved = own.status === "resolved";
  const params: PushParams = {};
  for (const key of resolved ? RESOLVED_DEFAULTS : FIRING_DEFAULTS) {
    const value = channel.defaults?.[key];
    if (value !== undefined && value !== "") params[key] = value;
  }
  Object.assign(params, own);
  if (!resolved) {
    if (watch.level) params.level = watch.level;
    if (watch.repeat) params.repeat = String(watch.repeat);
  }
  return params;
}

/**
 * 这条告警算不算发出去了。算：送到了至少一台；被通道的去重压掉了（同样的话刚说过）；
 * 或者失败的全是重试也没用的 4xx（token 失效、payload 不对）。
 * 不算：APNs 5xx、429 限流、403（服务端自己的签名出了问题）、网络出错、一台设备都没有 —— 下一轮再推。
 *
 * 原先推完不看结果就把状态写死：APNs 抖一下，「掉线了」这唯一的一次告警就被当成已经发过，再也不推
 */
export function alertSettled(report: DeliveryReport): boolean {
  if (report.suppressed || report.delivered > 0) return true;
  if (report.results.length === 0) return false;
  return report.results.every((r) => r.status >= 400 && r.status < 500 && r.status !== 403 && r.status !== 429);
}

/**
 * 告警推完之后：发出去了（或者已经试满次数、只能放弃）返回 null，调用方照常推进状态；
 * 否则返回这是第几轮没推出去 —— 调用方保持原状态，下一轮再推
 */
function retryAttempt(watch: Watch, report: DeliveryReport): number | null {
  if (alertSettled(report)) return null;
  const attempt = (watch.pendingAlertAttempts ?? 0) + 1;
  if (attempt < MAX_ALERT_ATTEMPTS) return attempt;
  const reasons = [...new Set(report.results.map((r) => r.reason ?? String(r.status)))].join("；") || "没有可用设备";
  console.warn(`监控 ${watch.id} 的告警连续 ${attempt} 轮没推出去，放弃：${reasons}`);
  return null;
}

// ── 抓取与判定 ──────────────────────────────────────────────────────

/** 有网址可抓的监控：up / keyword */
type SiteWatch = Watch & { url: string };

function isSiteWatch(watch: Watch): watch is SiteWatch {
  return watch.kind !== "heartbeat" && typeof watch.url === "string" && watch.url !== "";
}

/** 一次检查的结论 */
export interface Probe {
  /** up：在线；down：掉线、出错。present / absent：关键词在不在；error：这次判断不了，保持上次的状态 */
  status: "up" | "down" | "present" | "absent" | "error";
  detail: string;
  /** 这次是等不到回应（超时）。连续超时才退避、暂停 —— 慢站点占着抓取位，连不上的不占 */
  timeout?: boolean;
}

/** 等满 FETCH_TIMEOUT_MS 也没抓完 */
class FetchTimeout extends Error {}

interface Fetched {
  status: number;
  /** 2xx 或 3xx */
  ok: boolean;
  /** 目标站的防护拦下了这次抓取：403、429、验证页 */
  blocked: boolean;
  /** 读了正文才有：关键词找到没有 */
  found?: boolean;
  /** 读满 512KB 就停了，后面没看 */
  truncated?: boolean;
  /** 返回的不是文本（图片、文件……），找不了关键词 */
  binary?: boolean;
}

/**
 * 人机验证、防护拦截页的特征。抓取从 Cloudflare 的境外节点发出，有些站点会对它弹验证页：
 * 这种页面上当然找不到关键词，按「消失了」报就是误报
 */
const CHALLENGE_MARKERS = [
  "cf-chl-", "challenge-platform", "<title>just a moment", "attention required!", "verify you are human", "请完成安全验证",
];

function looksLikeChallenge(text: string): boolean {
  const head = text.slice(0, 64 * 1024).toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => head.includes(marker));
}

/** 内容类型是文本类的（html、json、xml……）才读；没写内容类型的也读读看，大多是文本 */
function isTextual(type: string): boolean {
  if (!type) return true;
  return /text|json|xml|html|javascript/i.test(type);
}

/**
 * 边读边找关键词，找到就停；读满 512KB 还没找到也停。逐块解码，只在新读到的这一段附近找，
 * 不必每读一块就把整页从头再搜一遍
 */
async function scanFor(body: ReadableStream<Uint8Array>, keyword: string): Promise<{ found: boolean; truncated: boolean; text: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      text += decoder.decode();
      return { found: text.includes(keyword), truncated: false, text };
    }
    if (!value) continue;
    bytes += value.length;
    const from = Math.max(0, text.length - keyword.length);
    text += decoder.decode(value, { stream: true });
    const found = text.indexOf(keyword, from) >= 0;
    if (found || bytes >= MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return { found, truncated: !found, text };
    }
  }
}

/**
 * 抓一次。keyword 给了才读正文，而且只读 2xx 的文本 —— 错误页、验证页、图片里找关键词没有意义。
 * 超时抛 FetchTimeout，连不上照常抛出
 */
async function fetchSite(url: string, keyword?: string): Promise<Fetched> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": "PigeonWatch/1.0 (+https://nfo.im)" },
      cf: { cacheTtl: 0 },
    });
    const ok = res.ok || (res.status >= 300 && res.status < 400);
    const blocked = res.status === 403 || res.status === 429 || (!res.ok && res.headers.has("cf-mitigated"));
    const textual = isTextual(res.headers.get("content-type") ?? "");
    if (keyword === undefined || !res.ok || blocked || !textual) {
      // 不读正文也要把连接放掉
      await res.body?.cancel().catch(() => undefined);
      return { status: res.status, ok, blocked, binary: keyword !== undefined && res.ok && !blocked && !textual };
    }
    // 204 这类没有正文的：页面是空的，词自然不在
    if (!res.body) return { status: res.status, ok, blocked, found: keyword === "", truncated: false };
    const scan = await scanFor(res.body, keyword);
    return {
      status: res.status,
      ok,
      blocked: !scan.found && looksLikeChallenge(scan.text),
      found: scan.found,
      truncated: scan.truncated,
    };
  } catch (err) {
    if (timedOut) throw new FetchTimeout();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function probe(watch: SiteWatch): Promise<Probe> {
  const keyword = watch.kind === "keyword" ? watch.keyword ?? "" : undefined;
  let got: Fetched;
  try {
    got = await fetchSite(watch.url, keyword);
  } catch (err) {
    const timeout = err instanceof FetchTimeout;
    const detail = timeout ? `${FETCH_TIMEOUT_MS / 1000} 秒内没有回应` : "连不上";
    return watch.kind === "up"
      ? { status: "down", detail, ...(timeout ? { timeout } : {}) }
      : { status: "error", detail: `${detail}，无法判定`, ...(timeout ? { timeout } : {}) };
  }

  const http = `HTTP ${got.status}`;
  if (watch.kind === "up") {
    if (got.ok) return { status: "up", detail: http };
    return { status: "down", detail: got.blocked ? `${http}（可能被目标站拦截）` : http };
  }
  // keyword：只有 2xx 的文本才下结论，其余一律「这次判断不了」，保持上次的状态
  if (got.blocked) return { status: "error", detail: `${http}（可能被目标站拦截）` };
  if (got.status < 200 || got.status >= 300) return { status: "error", detail: `${http}，无法判定` };
  if (got.binary) return { status: "error", detail: "返回的不是文本，无法判定" };
  if (got.found) return { status: "present", detail: `找到了「${watch.keyword}」` };
  if (got.truncated) return { status: "error", detail: "页面超过 512KB，前 512KB 里没找到，无法判定" };
  return { status: "absent", detail: `没有「${watch.keyword}」` };
}

function clipDetail(text: string): string {
  return [...text].slice(0, MAX_DETAIL).join("");
}

/** 状态从 prev 变成 next 时要不要提醒、推什么（还没叠通道默认值）。返回 null 表示这次不推 */
function messageFor(watch: SiteWatch, prev: string | undefined, next: string | undefined, probe: Probe): PushParams | null {
  if (prev === next || next === undefined) return null;

  const id = `watch-${watch.id}`;
  if (watch.kind === "up") {
    // 掉线已经连续确认过了（见 siteStep）。刚建就连不上也照样报 —— 连续两次都不行，多半是真的
    if (next === "down") {
      return { title: `🔴 ${watch.name} 掉线了`, body: `${watch.url}\n${probe.detail}`, level: "timeSensitive", status: "firing", id, tags: "rotating_light", url: watch.url };
    }
    // 恢复。第一次就在线（prev 为 undefined）不提醒，避免刚建就响
    if (prev !== "down") return null;
    return { title: `🟢 ${watch.name} 恢复了`, body: `${watch.url}\n${probe.detail}`, level: "active", status: "resolved", id, tags: "white_check_mark", url: watch.url };
  }

  // keyword：只在满足「用户关心的方向」时提醒
  const wantPresent = watch.present !== false;
  if ((next === "present") !== wantPresent) return null;
  if (prev === undefined) return null; // 建的时候就已经是目标状态，不提醒
  const verb = next === "present" ? "出现了" : "消失了";
  return { title: `🔔 ${watch.name}`, body: `「${watch.keyword}」${verb}\n${watch.url}`, level: "timeSensitive", id: `${id}-${next}`, tags: "eyes", url: watch.url };
}

export interface SiteStep {
  /** 检查之后的监控（还没算告警推没推出去） */
  watch: Watch;
  /** 要推的告警；null 表示这次不推 */
  alert: PushParams | null;
  /** 这一次刚进入暂停：要告诉创建者一声 */
  paused: boolean;
}

/**
 * 抓了一次之后：新状态、要不要推、是不是该暂停了。
 *
 * - 成功（up / present / absent）：失败计数清零，状态照实记
 * - 失败：计数加一。up 连续失败满 DOWN_AFTER_FAILURES 次才记成 down；keyword 保持上次的状态
 * - 连续超时满 PAUSE_AFTER_TIMEOUTS 次进入暂停；有了回应（哪怕是个错误页）就退出暂停
 */
export function siteStep(watch: SiteWatch, probe: Probe, now: number): SiteStep {
  const failed = probe.status === "down" || probe.status === "error";
  const failCount = failed ? (watch.failCount ?? 0) + 1 : 0;
  const timeoutCount = probe.timeout ? (watch.timeoutCount ?? 0) + 1 : 0;
  const prev = watch.lastStatus;
  const next = !failed
    ? probe.status
    : watch.kind === "up" && failCount >= DOWN_AFTER_FAILURES
      ? "down"
      : prev;
  const pausedAt = probe.timeout ? watch.pausedAt ?? (timeoutCount >= PAUSE_AFTER_TIMEOUTS ? now : undefined) : undefined;
  const updated: Watch = {
    ...watch,
    lastCheckedAt: now,
    lastStatus: next,
    failCount: failCount || undefined,
    timeoutCount: timeoutCount || undefined,
    pausedAt,
    lastDetail: failed ? clipDetail(probe.detail) : undefined,
  };
  return {
    watch: updated,
    alert: messageFor(watch, prev, next, probe),
    paused: pausedAt !== undefined && watch.pausedAt === undefined,
  };
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
 *
 * 任务来报到了，之前没推出去、还在等重推的失联告警也就不必再推了（pendingAlertAttempts 清掉）
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
  return { watch: { ...watch, lastStatus: status, lastPingAt: now, pendingAlertAttempts: undefined }, persist, event };
}

/**
 * 心跳过了哪一刻还没来就算失联：最近一次报到 +「间隔 + 宽限」。不用排队的返回 0：
 * new 从不告警 —— 任务还没接上；down 已经告过警了，不再重复，等它回来推「恢复」。
 * 写状态时连同它记进 metadata，cron 翻键时据此挑出到期的。
 * 失联告警没推出去的，状态还是 up、这一刻已经过了，下一轮自然又到期、再推一次
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

/**
 * 网址监控下一次该检查的时刻。还没检查过的，现在就该。
 *
 * - 暂停中：一天后再试
 * - 告警还等着重推、或者失败了一次正等着确认是不是真掉线：下一轮就看（不按间隔等 ——
 *   每小时查一次的监控，确认掉线不该再多等一小时）
 * - 连续超时：间隔按 2 的次方拉长（第 2 次起），最长一天。慢站点每次都要占满一个抓取位 5 秒
 */
export function siteDueAt(watch: Watch): number {
  const last = watch.lastCheckedAt ?? 0;
  const interval = siteInterval(watch.intervalMinutes) * 60_000;
  if (watch.pausedAt !== undefined) return last + PAUSED_CHECK_MS;
  if (watch.pendingAlertAttempts) return last + RETRY_MS;
  if (watch.kind === "up" && (watch.failCount ?? 0) > 0 && watch.lastStatus !== "down") return last + RETRY_MS;
  const timeouts = watch.timeoutCount ?? 0;
  if (timeouts >= 2) return last + Math.max(interval, Math.min(interval * 2 ** (timeouts - 1), PAUSED_CHECK_MS));
  return last + interval;
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

/**
 * 只收加密的通道：任务附的说明是脚本送来的明文，服务端没法替它加密，就不转发，只说一句失败了。
 * 这个开关防的正是「某个脚本把明文推了出去」
 */
export const E2E_FAIL_BODY = "任务报告失败（通道只收加密，说明未转发）";

async function heartbeatMessage(
  watch: Watch,
  event: HeartbeatEvent,
  now: number,
  detail = "",
): Promise<PushParams> {
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
 * 先推后写，而且看推没推出去：没推出去（APNs 出错、一台设备都没有）就不改状态，只记下任务还活着、
 * 试了几次 —— 「恢复」下次报到时再推，失联由 cron 下一轮再推；满 MAX_ALERT_ATTEMPTS 次才放弃。
 * 回给任务的仍是它报的状态：报到本身收下了，推没推出去是服务端自己的事
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
    const detail = report.message && channel.policy?.e2eOnly ? E2E_FAIL_BODY : report.message;
    const own = await heartbeatMessage(watch, step.event, now, detail);
    const delivery = await deliver(env, channel, await recipientsOf(env, channel), alertParams(channel, watch, own));
    const attempt = retryAttempt(watch, delivery);
    if (attempt !== null) {
      const held: Watch = { ...watch, lastPingAt: now, pendingAlertAttempts: attempt };
      await writeWatchState(env, held, nextDueAt(held), now);
      return { ok: true, watch: step.watch };
    }
  }
  await writeWatchState(env, step.watch, nextDueAt(step.watch), now);
  return { ok: true, watch: step.watch };
}

// ── 定时执行 ────────────────────────────────────────────────────────

/** 两个 cron（wrangler.toml）：整 5 分钟跑监控，错开 2 分钟跑重复提醒。各自一次调用、各自一份额度 */
export const WATCH_CRON = "*/5 * * * *";
export const REMINDER_CRON = "2-59/5 * * * *";
/**
 * 一次调用最多 1000 次 KV 操作。用到这么多就不再开始新的监控：还在跑的（最多 6 个，
 * 大群的告警一个就要读上百个键）和收尾（记录这一轮、通知运营者）都还要用
 */
export const SWEEP_KV_SOFT_LIMIT = 700;
/** 一轮跑了这么久就不再开始新的：下一轮 5 分钟后就来，别和它叠在一起、同一个监控查两遍 */
export const SWEEP_TIME_BUDGET_MS = 4 * 60_000;
/** 一轮里这么多个监控出错，就通知运营者 */
export const SWEEP_ERROR_ALERT = 5;
/** 一轮里这么多个到期的排不上、顺延到下一轮，就通知运营者：额度不够用了，监控在一轮轮地晚 */
export const SWEEP_DEFERRED_ALERT = 20;

/** 一轮 cron 做了什么。也原样记进 sweep:watches（见 db.ts recordSweep） */
export interface ScheduledReport {
  /** 按列表看到期的 */
  due: number;
  /** 真正去抓了的网址 */
  checked: number;
  /** 推出去的告警 */
  alerted: number;
  /** 告警没推出去、留到下一轮重推的 */
  retrying: number;
  /** 告警连试几轮都没推出去、放弃了的 */
  abandoned: number;
  /** 这一轮进入暂停的（连续超时太多次） */
  paused: number;
  /** 通道被停用、这一轮跳过的 */
  skipped: number;
  /** KV 额度或时间用完、没轮上，顺延到下一轮的 */
  deferred: number;
  /** 处理时抛了异常的（日志里有） */
  errors: number;
  /** 补进索引的老监控 */
  adopted: number;
  /** 推给的通道已经没了、顺手删掉的监控 */
  removed: number;
  /** 清掉的残键 */
  leftovers: number;
  /** 这一轮用了多少次 KV 操作 */
  kvOps: number;
}

function emptyReport(): ScheduledReport {
  return {
    due: 0, checked: 0, alerted: 0, retrying: 0, abandoned: 0, paused: 0, skipped: 0,
    deferred: 0, errors: 0, adopted: 0, removed: 0, leftovers: 0, kvOps: 0,
  };
}

/** 一轮巡检的上下文。同一个通道常挂着好几个监控：通道和接收者这一轮只读一次 */
interface Sweep {
  env: Env;
  now: number;
  report: ScheduledReport;
  channels: Map<string, Promise<Channel | null>>;
  recipients: Map<string, Promise<Account[]>>;
}

function sweepChannel(sweep: Sweep, id: string): Promise<Channel | null> {
  let found = sweep.channels.get(id);
  if (!found) {
    found = getChannel(sweep.env, id);
    sweep.channels.set(id, found);
    found.catch(() => sweep.channels.delete(id));
  }
  return found;
}

function sweepRecipients(sweep: Sweep, channel: Channel): Promise<Account[]> {
  let found = sweep.recipients.get(channel.id);
  if (!found) {
    found = recipientsOf(sweep.env, channel);
    sweep.recipients.set(channel.id, found);
    found.catch(() => sweep.recipients.delete(channel.id));
  }
  return found;
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
async function liveChannel(sweep: Sweep, watch: Watch): Promise<Channel | null> {
  const channel = await sweepChannel(sweep, watch.channelId);
  if (!channel) {
    await deleteWatch(sweep.env, watch, sweep.now);
    sweep.report.removed += 1;
    return null;
  }
  if (channel.suspended) {
    sweep.report.skipped += 1;
    return null;
  }
  return channel;
}

/**
 * 暂停检查时告诉创建者一声，只推给他自己 —— 群里其他人管不了这个监控。
 * 推没推出去都只推这一次：暂停本身不是告警，下一次有回应时的「恢复了」才是
 */
async function noticePaused(sweep: Sweep, channel: Channel, watch: SiteWatch): Promise<void> {
  const owner = (await sweepRecipients(sweep, channel)).filter((account) => account.id === watch.ownerId);
  if (owner.length === 0) return;
  await deliver(sweep.env, { ...channel, memberIds: [] }, owner, {
    title: `⏸ ${watch.name} 暂停检查`,
    body: `连续 ${PAUSE_AFTER_TIMEOUTS} 次等了 ${FETCH_TIMEOUT_MS / 1000} 秒都没有回应，先停下常规检查，之后每天试一次；有回应了自动恢复。\n${watch.url}`,
    level: "active",
    id: `watch-${watch.id}-paused`,
  });
}

/** 推一条告警，按结果算这一轮的账。返回 null 表示照常推进状态，否则是要记下的重推次数 */
async function sendAlert(sweep: Sweep, channel: Channel, watch: Watch, own: PushParams): Promise<number | null> {
  const delivery = await deliver(sweep.env, channel, await sweepRecipients(sweep, channel), alertParams(channel, watch, own));
  const attempt = retryAttempt(watch, delivery);
  if (attempt !== null) sweep.report.retrying += 1;
  else if (alertSettled(delivery)) sweep.report.alerted += 1;
  else sweep.report.abandoned += 1;
  return attempt;
}

/** 处理一个（按列表看）到期的监控。值以这一刻读到的为准 */
async function runDueWatch(sweep: Sweep, id: string): Promise<void> {
  const { env, now } = sweep;
  const stored = await readWatchConfig(env, id);
  if (!stored) return;
  const watch = mergeWatch(stored, await readWatchState(env, stored.kind, id));

  // 心跳不抓网址，只比一下报到时刻。列表可能比值旧一步：刚报到过的，以值为准，不误报
  if (watch.kind === "heartbeat") {
    if (!heartbeatOverdue(watch, now)) return;
    const channel = await liveChannel(sweep, watch);
    if (!channel || (await isWatchDeleted(env, id))) return;
    const attempt = await sendAlert(sweep, channel, watch, await heartbeatMessage(watch, "down", now));
    // 推出去了就记成 down：之后不再重复告警，等任务回来报到时推「恢复」。
    // 没推出去就还是 up，只记下试了几次 —— 失联的那一刻已经过了，下一轮照样到期、再推
    const next: Watch = attempt === null
      ? { ...watch, lastStatus: "down", pendingAlertAttempts: undefined }
      : { ...watch, pendingAlertAttempts: attempt };
    await writeWatchState(env, next, nextDueAt(next), now);
    return;
  }
  if (!isSiteWatch(watch) || now < siteDueAt(watch)) return;

  const channel = await liveChannel(sweep, watch);
  if (!channel) return;
  sweep.report.checked += 1;
  const result = await probe(watch);
  // 抓取的这几秒里被删了：不推，也不把状态写回去
  if (await isWatchDeleted(env, id)) return;

  const step = siteStep(watch, result, now);
  let next: Watch = { ...step.watch, pendingAlertAttempts: undefined };
  if (step.alert) {
    const attempt = await sendAlert(sweep, channel, watch, step.alert);
    // 没推出去：状态停在原处，下一轮重新抓一次 —— 那时还是这样就再推，已经好了就不必推了
    if (attempt !== null) next = { ...step.watch, lastStatus: watch.lastStatus, pendingAlertAttempts: attempt };
  }
  if (step.paused) {
    sweep.report.paused += 1;
    try {
      await noticePaused(sweep, channel, watch);
    } catch (err) {
      console.error(`监控 ${id} 暂停的说明没推出去`, err);
    }
  }
  await writeWatchState(env, next, nextDueAt(next), now);
}

/**
 * 同时最多跑 limit 个，按顺序一个个开始；canStart 说不行了就不再开始新的（已经开始的照样跑完）。
 * 返回开始了几个 —— 没开始的留在列表里，下一轮按到期先后排在最前面
 */
async function runPool<T>(
  items: T[],
  limit: number,
  canStart: () => boolean,
  run: (item: T) => Promise<void>,
): Promise<number> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length && canStart()) {
      const item = items[next++] as T;
      await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return next;
}

/** 只看这几个监控时（本地测试用），列表里别的一概当没看见 */
function narrowCatalog(catalog: WatchCatalog, only: Set<string>): WatchCatalog {
  return {
    configs: new Set([...catalog.configs].filter((id) => only.has(id))),
    index: new Map([...catalog.index].filter(([id]) => only.has(id))),
    states: new Map([...catalog.states].filter(([id]) => only.has(id))),
  };
}

export interface ScheduledOptions {
  /** 只处理这几个监控。本地 API 测试用：同一个本地库里别的测试留下的监控不去碰 */
  only?: Set<string>;
}

/**
 * cron 每轮：把到点的监控抓一遍，状态变了就推给对应通道；心跳看有没有按时报到。
 *
 * 先翻一遍键（配置、索引、状态，全部翻页取全），只凭状态键的 metadata 挑出到期的，
 * 没到期的一条也不读 —— 每轮的读取随到期的数量涨，不随监控总数涨。到期的按该看的时刻先后处理，
 * 最多 6 个同时抓。KV 操作快到每次调用 1000 次的上限、或者跑了 4 分钟，就不再开始新的，
 * 剩下的原样留着，下一轮排在最前面 —— 不会像原先那样，额度用完之后排在后面的全部静悄悄地失败。
 * 顺手做两件维护：给老监控补索引（全部补完就记下标记），清掉配置已经没了的残键。
 *
 * 每个监控独立 try/catch —— 一个网站抓炸了不能带垮整轮，出错的记数、记日志。
 * 抓取和推送都做完再写状态，写在最后：中途失败下轮重来，不会因为「状态记了、通知没发」而漏掉一次告警。
 */
export async function runScheduled(
  raw: Env,
  now: number = Date.now(),
  options: ScheduledOptions = {},
): Promise<ScheduledReport> {
  const meter = meteredEnv(raw);
  const env = meter.env;
  const startedAt = Date.now();
  const report = emptyReport();
  const sweep: Sweep = { env, now, report, channels: new Map(), recipients: new Map() };
  const hasBudget = (): boolean =>
    meter.ops() < SWEEP_KV_SOFT_LIMIT && Date.now() - startedAt < SWEEP_TIME_BUDGET_MS;

  const listed = await watchCatalog(env);
  const catalog = options.only ? narrowCatalog(listed, options.only) : listed;
  const legacy: string[] = [];
  const due: { id: string; at: number }[] = [];

  for (const id of catalog.configs) {
    const state = catalog.states.get(id);
    const indexed = catalog.index.get(id);
    if (!indexed) {
      legacy.push(id);
      continue;
    }
    const heartbeat = state?.heartbeat ?? (indexed.meta?.kind ? indexed.meta.kind === "heartbeat" : undefined);
    const at = catalogDue(heartbeat, state ? state.state : undefined, now);
    if (at !== null) due.push({ id, at });
  }

  due.sort((a, b) => a.at - b.at);
  report.due = due.length;
  const started = await runPool(due, FETCH_CONCURRENCY, hasBudget, async ({ id }) => {
    try {
      await runDueWatch(sweep, id);
    } catch (err) {
      report.errors += 1;
      console.error(`监控 ${id} 检查出错`, err);
    }
  });
  report.deferred = due.length - started;

  let unindexed = 0;
  for (const id of legacy) {
    if (!hasBudget()) {
      unindexed += 1;
      continue;
    }
    try {
      const outcome = await adoptLegacyWatch(env, id, catalog.states.has(id), now);
      if (outcome === "adopted") report.adopted += 1;
      if (outcome === "removed") report.removed += 1;
    } catch (err) {
      unindexed += 1;
      report.errors += 1;
      console.error(`老监控 ${id} 补索引出错`, err);
    }
  }

  try {
    if (hasBudget()) report.leftovers = await removeWatchLeftovers(env, catalog, now);
    if (unindexed === 0 && !options.only && !(await watchIndexComplete(env))) await markWatchIndexComplete(env, now);
  } catch (err) {
    // 维护做不完下一轮接着做
    console.error("监控维护出错", err);
  }
  report.kvOps = meter.ops();
  return report;
}

// ── 两个 cron 的入口 ────────────────────────────────────────────────

/**
 * 这一轮的问题严重到要告诉运营者：整轮没跑完、出错的太多、或者排不上的太多。返回说给人听的一句话。
 * 原先每个监控的异常都被吞掉，没有日志、没有告警 —— 额度用完之后监控整片失效，谁也不知道
 */
function sweepProblem(report: ScheduledReport | null): string | null {
  if (!report) return "这一轮整个没跑完（列监控时就出错了），所有监控都没检查。详情看 Workers 日志。";
  if (report.errors < SWEEP_ERROR_ALERT && report.deferred < SWEEP_DEFERRED_ALERT) return null;
  return `这一轮到期 ${report.due} 个：${report.errors} 个出错，${report.deferred} 个没轮上、顺延到下一轮。详情看 Workers 日志。`;
}

/**
 * 推给运营者设定的审核通道（npm run mod -- inbox），每类每小时最多一次。没设审核通道就只记日志。
 * 审核通道要求端到端加密的话，服务端没法替它加密，只能不发
 */
async function notifyOperator(env: Env, kind: SweepKind, title: string, body: string, now: number): Promise<void> {
  try {
    const inboxId = await getModChannelId(env);
    if (!inboxId) return;
    const inbox = await getChannel(env, inboxId);
    if (!inbox || inbox.suspended || inbox.policy?.e2eOnly) return;
    if (!(await claimSweepNotice(env, kind, now))) return;
    await deliver(env, inbox, await recipientsOf(env, inbox), {
      title, body, level: "timeSensitive", tags: "warning", group: "moderation",
    });
  } catch (err) {
    console.error("通知运营者失败", err);
  }
}

/**
 * 这一轮的记录：at 是实际跑完的时刻（/info 报的就是它），scheduledAt 是 cron 的计划时刻，
 * 其余是计数 —— ScheduledReport 和提醒的结果全是数字，原样摊进去
 */
function sweepRecord(scheduledAt: number, startedAt: number, counts: object | null): SweepRecord {
  const at = Date.now();
  return { ...(counts as Record<string, number> | null), at, scheduledAt, tookMs: at - startedAt, ok: counts !== null };
}

/** 一轮监控巡检：跑、记下这一轮、出了问题告诉运营者。从不抛出 */
export async function sweepWatches(env: Env, now: number = Date.now(), options: ScheduledOptions = {}): Promise<ScheduledReport | null> {
  const startedAt = Date.now();
  let report: ScheduledReport | null = null;
  try {
    report = await runScheduled(env, now, options);
  } catch (err) {
    console.error("监控巡检整轮失败", err);
  }
  try {
    await recordSweep(env, "watches", sweepRecord(now, startedAt, report));
  } catch (err) {
    console.error("记录监控巡检失败", err);
  }
  const problem = sweepProblem(report);
  if (problem) {
    console.error(`监控巡检：${problem}`);
    await notifyOperator(env, "watches", "⚠️ 监控巡检出了问题", problem, now);
  }
  return report;
}

/** 一轮重复提醒：跑、记下这一轮、整轮失败了告诉运营者。从不抛出 */
export async function sweepReminders(env: Env, now: number = Date.now()): Promise<{ sent: number; stopped: number } | null> {
  const startedAt = Date.now();
  let result: { sent: number; stopped: number } | null = null;
  try {
    result = await runReminders(env, now);
  } catch (err) {
    console.error("重复提醒整轮失败", err);
  }
  try {
    await recordSweep(env, "reminders", sweepRecord(now, startedAt, result));
  } catch (err) {
    console.error("记录重复提醒巡检失败", err);
  }
  if (!result) {
    await notifyOperator(env, "reminders", "⚠️ 重复提醒出了问题", "这一轮整个没跑完，到点的重复提醒都没补发。详情看 Workers 日志。", now);
  }
  return result;
}

/**
 * scheduled() 的分派：整 5 分钟那个 cron 跑监控，错开 2 分钟那个跑重复提醒。原先两样挤在同一次调用里，
 * 共用 1000 次 KV 操作 —— 有人排上几百条重复提醒，全站的监控就一起停摆。
 * 认不出来的（本地手动触发、还只配了一个 cron 的旧部署）两样都跑
 */
export async function runCron(env: Env, cron: string | undefined, now: number): Promise<void> {
  const jobs: Promise<unknown>[] = [];
  if (cron !== REMINDER_CRON) jobs.push(sweepWatches(env, now));
  if (cron !== WATCH_CRON) jobs.push(sweepReminders(env, now));
  await Promise.all(jobs);
}
