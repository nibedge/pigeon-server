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
import { allowPush, cancelRepeat, deliver, deliveryCost, repeatMinutes, runReminders, type DeliveryReport, type ReminderReport } from "./push";
import type { Account, Channel, Env, PushParams, Watch, WatchQuiet } from "./types";
import { recordHistory } from "./watchhistory";
import { gate, isPaused, parseMaintenance, quietEnd, quietNote } from "./watchquiet";

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
  // 维护窗口新建时就能一起给（写法同编辑），不必建完再改一次
  if (v.maintenance === undefined || v.maintenance === null) return { ...parsed, ...strength };
  const maintenance = parseMaintenance(v.maintenance);
  if (typeof maintenance === "string") return maintenance;
  return { ...parsed, ...strength, ...(maintenance ? { maintenance } : {}) };
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
 * 「恢复」只取铃声、分组这类：通道默认的持续响铃、重复提醒不该落在好消息上。
 * live 也是「怎么提醒」：通道默认开着实时活动的，掉线、失联的告警也挂到锁屏和灵动岛上；恢复时照样结束（见 live.ts）
 */
const FIRING_DEFAULTS = ["level", "sound", "volume", "call", "group", "icon", "isArchive", "ttl", "badge", "repeat", "live"] as const;
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
 * 发出之前就被 deliver 拒了（内容截不动也放不下 —— 下一轮还是同样的内容，重推也一样被拒）；
 * 或者失败的全是重试也没用的 4xx（token 失效、payload 不对）。
 * 不算：APNs 5xx、429 限流、403（服务端自己的签名出了问题）、网络出错、一台设备都没有 —— 下一轮再推。
 *
 * 原先推完不看结果就把状态写死：APNs 抖一下，「掉线了」这唯一的一次告警就被当成已经发过，再也不推
 */
export function alertSettled(report: DeliveryReport): boolean {
  if (report.suppressed || report.delivered > 0 || report.rejection) return true;
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
  /** 从发出请求到收到响应头用了多少毫秒（建连、TLS 都算在内）。连不上、超时的没有 */
  ms?: number;
}

/** 等满 FETCH_TIMEOUT_MS 也没抓完 */
class FetchTimeout extends Error {}

interface Fetched {
  status: number;
  /** 收到响应头用了多少毫秒 */
  ms: number;
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
    const sentAt = Date.now();
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": "PigeonWatch/1.0 (+https://nfo.im)" },
      cf: { cacheTtl: 0 },
    });
    // 只量到响应头：正文读多少取决于找不找关键词，算进去就没法和别的监控比了
    const ms = Date.now() - sentAt;
    const ok = res.ok || (res.status >= 300 && res.status < 400);
    const blocked = res.status === 403 || res.status === 429 || (!res.ok && res.headers.has("cf-mitigated"));
    const textual = isTextual(res.headers.get("content-type") ?? "");
    if (keyword === undefined || !res.ok || blocked || !textual) {
      // 不读正文也要把连接放掉
      await res.body?.cancel().catch(() => undefined);
      return { status: res.status, ms, ok, blocked, binary: keyword !== undefined && res.ok && !blocked && !textual };
    }
    // 204 这类没有正文的：页面是空的，词自然不在
    if (!res.body) return { status: res.status, ms, ok, blocked, found: keyword === "", truncated: false };
    const scan = await scanFor(res.body, keyword);
    return {
      status: res.status,
      ms,
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
  const ms = got.ms;
  if (watch.kind === "up") {
    if (got.ok) return { status: "up", detail: http, ms };
    return { status: "down", detail: got.blocked ? `${http}（可能被目标站拦截）` : http, ms };
  }
  // keyword：只有 2xx 的文本才下结论，其余一律「这次判断不了」，保持上次的状态
  if (got.blocked) return { status: "error", detail: `${http}（可能被目标站拦截）`, ms };
  if (got.status < 200 || got.status >= 300) return { status: "error", detail: `${http}，无法判定`, ms };
  if (got.binary) return { status: "error", detail: "返回的不是文本，无法判定", ms };
  if (got.found) return { status: "present", detail: `找到了「${watch.keyword}」`, ms };
  if (got.truncated) return { status: "error", detail: "页面超过 512KB，前 512KB 里没找到，无法判定", ms };
  return { status: "absent", detail: `没有「${watch.keyword}」`, ms };
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

/**
 * 安静期（暂停、维护窗口）结束后第一次检查：拿压下之前的状态和现在比，还不对劲就补推一条，写明是什么时候出的事。
 * 已经好了、或者变回了原样，返回 null
 */
function settledSiteMessage(watch: SiteWatch, held: WatchQuiet, next: string | undefined, probe: Probe): PushParams | null {
  const message = messageFor(watch, held.from || undefined, next, probe);
  if (!message || message.status === "resolved") return null;
  const note = next === "down" ? `${quietNote(held.why)}掉线，到现在还没恢复` : `${quietNote(held.why)}发生`;
  return { ...message, body: `${message.body}\n（${note}）` };
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
  // 一直暂停着：不判失联，也不用排队（恢复时编辑接口会重新排）
  if (watch.pausedUntil === 0) return 0;
  const grace = watch.graceMinutes ?? defaultGraceMinutes(watch.intervalMinutes);
  // 暂停过的从暂停结束（手动恢复就是恢复那一刻）重新计时：暂停期间没来报到不算失联，
  // 恢复之后也给它一整个「间隔 + 宽限」—— 否则一恢复就因为几天前的报到时刻立刻响
  const since = Math.max(watch.lastPingAt, watch.pausedUntil ?? 0);
  return since + (watch.intervalMinutes + grace) * 60_000;
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
  // 手动暂停：一直暂停的不排（恢复时编辑接口重排），暂停到某时的到那时再看
  if (watch.pausedUntil === 0) return NEVER;
  const due = Math.max(regularSiteDueAt(watch), watch.pausedUntil ?? 0);
  // 维护窗口里压着告警：窗口一结束就看一次，不等下一个间隔 —— 每天查一次的监控，窗口结束后还挂着，不该再等一天才说
  const settle = watch.quiet?.until ?? 0;
  return settle > 0 ? Math.min(due, settle) : due;
}

/** 永远不用排队的时刻：状态 metadata 的 nextDueAt 写成它，cron 就不会挑中 */
const NEVER = Number.MAX_SAFE_INTEGER;

function regularSiteDueAt(watch: Watch): number {
  const last = watch.lastCheckedAt ?? 0;
  const interval = siteInterval(watch.intervalMinutes) * 60_000;
  if (watch.pausedAt !== undefined) return last + PAUSED_CHECK_MS;
  if (watch.pendingAlertAttempts) return last + RETRY_MS;
  if (watch.kind === "up" && (watch.failCount ?? 0) > 0 && watch.lastStatus !== "down") return last + RETRY_MS;
  const timeouts = watch.timeoutCount ?? 0;
  if (timeouts >= 2) return last + Math.max(interval, Math.min(interval * 2 ** (timeouts - 1), PAUSED_CHECK_MS));
  return last + interval;
}

/**
 * 写进状态 metadata 的「下一次该看它的时刻」，按类型分别算。
 * 心跳压着告警时（维护窗口里失联、报了失败），到安静期结束那一刻也要看一次：还没恢复就补推
 */
export function nextDueAt(watch: Watch): number {
  if (watch.kind !== "heartbeat") return siteDueAt(watch);
  const deadline = heartbeatDeadline(watch);
  // cron 挑心跳按「过了这一刻」比（失联是过了点才算，见 catalogDue）；安静期结束那一刻就该看，提前 1 毫秒
  const settle = (watch.quiet?.until ?? 0) - 1;
  if (settle <= 0) return deadline;
  return deadline > 0 ? Math.min(deadline, settle) : settle;
}

/** 一次运行的用时：不到一分钟写到秒，十分钟以内写到分和秒，再长的同 formatMinutes */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return "不到 1 秒";
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 10 * 60) {
    const rest = seconds % 60;
    return rest ? `${Math.floor(seconds / 60)} 分 ${rest} 秒` : `${seconds / 60} 分钟`;
  }
  return formatMinutes(seconds / 60);
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
 * 告警 payload 里的 watch_id：App 凭它打开对应的监控详情。
 * 网址监控就是监控 id；心跳用消息 id 那样单向推出来的引用 —— 心跳 id 是报到凭据，
 * 群里的成员收到告警也不该因此拿到它（见 heartbeatMessageId）。创建者的 App 从监控列表的 ref 字段对上号
 */
export async function watchRef(watch: Pick<Watch, "id" | "kind">): Promise<string> {
  return watch.kind === "heartbeat" ? heartbeatMessageId(watch.id) : watch.id;
}

/**
 * 停掉这个监控在某个通道里排下的重复提醒（「直到有人处理」）：删除、暂停、换通道、换了要盯的东西时。
 * 消息 id 和告警用的一样：网址监控是 watch-{id}（关键词带上 -present / -absent），心跳是单向推出来的那个
 */
export async function cancelWatchRepeats(env: Env, watch: Pick<Watch, "id" | "kind">, channelId: string): Promise<void> {
  const ids = watch.kind === "heartbeat"
    ? [await heartbeatMessageId(watch.id)]
    : [`watch-${watch.id}`, `watch-${watch.id}-present`, `watch-${watch.id}-absent`];
  await Promise.all(ids.map((id) => cancelRepeat(env, channelId, id)));
}

/**
 * 只收加密的通道：任务附的说明是脚本送来的明文，服务端没法替它加密，就不转发，只说一句失败了。
 * 这个开关防的正是「某个脚本把明文推了出去」
 */
export const E2E_FAIL_BODY = "任务报告失败（通道只收加密，说明未转发）";
/** 同上，报的是退出码：退出码是服务端自己认出来的，照写；附的说明不转发 */
const E2E_NOTE = "说明未转发（通道只收加密）";

/** 心跳报到带来的几样东西：失败没有、附的说明、退出码、这次运行的用时（/start 记过开始才有） */
export interface HeartbeatReport {
  failed: boolean;
  /** 任务附的说明（/fail 的请求体或 ?msg=），截到 200 字 */
  message?: string;
  /** /hb/{id}/{退出码} 报来的退出码：0 当成正常报到，别的都是失败 */
  code?: number;
}

/**
 * 心跳失联时说明现状：上次上报在多久以前、约定多久一次。调过 /start、这一轮开始了却一直没报到的，
 * 再说一句它已经跑了多久 —— 「任务根本没跑」和「跑起来卡住了」查法完全不同，前者看 cron，后者看任务本身
 */
function overdueText(watch: Watch, now: number): string {
  const silent = formatMinutes((now - (watch.lastPingAt ?? now)) / 60_000);
  const running = runDuration(watch, now);
  const hung = running !== undefined ? `这一轮已经跑了 ${formatDuration(running)}，还没结束。` : "";
  return `上次上报在 ${silent}前，预期每 ${formatMinutes(watch.intervalMinutes)}一次。${hung}`;
}

async function heartbeatMessage(
  watch: Watch,
  event: HeartbeatEvent,
  now: number,
  detail = "",
  extra: { code?: number; runMs?: number } = {},
): Promise<PushParams> {
  const id = await heartbeatMessageId(watch.id);
  const took = extra.runMs !== undefined ? `这次用时 ${formatDuration(extra.runMs)}。` : "";
  if (event === "down") {
    return {
      title: `🔴「${watch.name}」没有按时上报`,
      body: overdueText(watch, now),
      level: "timeSensitive", status: "firing", id, tags: "rotating_light",
    };
  }
  if (event === "failed") {
    const what = extra.code !== undefined
      ? detail ? `退出码 ${extra.code}：${detail}` : `退出码 ${extra.code}`
      : detail || "任务报告了失败，没有附带说明。";
    return {
      title: `🔴「${watch.name}」报告失败`,
      body: took ? `${what}\n${took}` : what,
      level: "timeSensitive", status: "firing", id, tags: "x",
    };
  }
  return {
    title: `🟢「${watch.name}」恢复上报`,
    body: `又收到正常上报了。${took}`,
    level: "active", status: "resolved", id, tags: "white_check_mark",
  };
}

/**
 * 安静期结束时心跳还是 down（维护窗口里失联、暂停期间报了失败）：补推一条。
 * 出的是什么事从历史的最后一次变化里取（「没有按时上报」「退出码 2」……），不存任务附的说明
 */
async function settledHeartbeatMessage(watch: Watch, held: WatchQuiet, now: number): Promise<PushParams | null> {
  if (watch.lastStatus !== "down" || held.from === "down") return null;
  const changes = watch.history?.changes ?? [];
  const what = [...changes].reverse().find((c) => c.status === "down")?.detail ?? "出了状况";
  return {
    title: `🔴「${watch.name}」仍未恢复`,
    body: `${quietNote(held.why)}${what}，到现在还没恢复。${overdueText(watch, now)}`,
    level: "timeSensitive", status: "firing", id: await heartbeatMessageId(watch.id), tags: "rotating_light",
  };
}

/**
 * 这次报到对应的那次运行用了多久：/start 记过开始，而且开始晚于上一次报到（不是上一轮剩下的）。
 * 算不出来返回 undefined。开始了一周以上才报到的不算 —— 多半是上次开始之后任务就没跑完
 */
export function runDuration(watch: Pick<Watch, "startedAt" | "lastPingAt">, now: number): number | undefined {
  const started = watch.startedAt;
  if (started === undefined || started <= (watch.lastPingAt ?? 0) || now < started) return undefined;
  if (now - started > MAX_HEARTBEAT_MINUTES * 60_000) return undefined;
  return now - started;
}

/** 两次安静期状态是不是一回事（变了才要写） */
function sameQuiet(a: WatchQuiet | undefined, b: WatchQuiet | undefined): boolean {
  if (!a || !b) return a === b;
  return a.from === b.from && a.until === b.until && a.why === b.why;
}

/** KV 同一把键每秒最多写一次 */
const KV_WRITE_GAP_MS = 1000;

/**
 * 同一把键上次写在 1 秒之内的，等满 1 秒再写：/start 之后不到一秒就跑完的任务、连着两次的编辑，
 * 不等就会撞上 KV 的限制、整个请求失败。lastAt 早就过了、或者在将来（测试里拨过的钟）的，不等
 */
export async function waitForWriteSlot(lastAt: number | undefined): Promise<void> {
  if (lastAt === undefined) return;
  const wait = lastAt + KV_WRITE_GAP_MS - Date.now();
  if (wait > 0 && wait <= KV_WRITE_GAP_MS) await new Promise((resolve) => setTimeout(resolve, wait));
}

/** 心跳这一次的记录：状态从 prev 到 next，是正常报到还是异常 */
function heartbeatHistory(
  prev: Watch,
  next: Watch,
  now: number,
  quietNow: boolean,
  sample: { ok: boolean; ms?: number } | undefined,
  detail: string,
): Watch["history"] {
  const status = next.lastStatus;
  const cls = status === "up" ? 1 : status === "down" && !quietNow ? 0 : -1;
  const changed = status !== undefined && status !== prev.lastStatus;
  return recordHistory(prev.history, now, {
    cls,
    sample,
    change: changed ? { status, detail, quiet: quietNow } : undefined,
  });
}

/**
 * 报到的结果。missing：没有这个心跳（或者刚删掉）；suspended：推给的通道被停用了；
 * throttled：这次该推的告警撞上了通道的推送额度，没推、也没记（channel 给回应里的说明用）。
 * runMs 是这次运行的用时（/start 记过开始才有）
 */
export type HeartbeatOutcome =
  | { ok: true; watch: Watch; runMs?: number }
  | { ok: false; reason: "missing" | "suspended" }
  | { ok: false; reason: "throttled"; channel: Pick<Channel, "name"> };

const MISSING: HeartbeatOutcome = { ok: false, reason: "missing" };

/**
 * 任务来报到：/hb/{id} 是正常，/hb/{id}/fail 是失败，/hb/{id}/{退出码} 看退出码。
 *
 * 只写状态键 hbstate:{id}，不碰配置：晚到一步的报到最多多写一次状态，写不回一个删掉的监控。
 * 要写要推之前先确认三件事 —— 没被删（墓碑）、通道还在（不在了就连心跳一起删）、通道没被停用
 * （停用期间不推也不改状态，但心跳留着，申诉恢复后接着用）。报得比约定还勤的那些次什么都不写，
 * 这三样也就不查：热路径上每次报到只读配置和状态两次，停用和删除最多晚几分钟才反映到回应上。
 *
 * 先推后写，而且看推没推出去：没推出去（APNs 出错、一台设备都没有）就不改状态，只记下任务还活着、
 * 试了几次 —— 「恢复」下次报到时再推，失联由 cron 下一轮再推；满 MAX_ALERT_ATTEMPTS 次才放弃。
 * 回给任务的仍是它报的状态：报到本身收下了，推没推出去是服务端自己的事。
 *
 * 暂停和维护窗口里照样记，只是告警压下（见 watchquiet.ts gate）；之前告过警的事在这期间恢复了，静默送达。
 * 历史（状态变化、这次的用时）跟状态同一次写入
 */
export async function recordHeartbeat(
  env: Env,
  id: string,
  report: HeartbeatReport,
  now: number = Date.now(),
): Promise<HeartbeatOutcome> {
  if (!isValidId(id)) return MISSING;
  const [stored, state] = await Promise.all([readWatchConfig(env, id), readWatchState(env, "heartbeat", id)]);
  if (!stored || stored.kind !== "heartbeat") return MISSING;

  const watch = mergeWatch(stored, state);
  const runMs = runDuration(watch, now);
  const step = heartbeatStep(watch, report, now);
  const quiet = quietEnd(watch, now);
  const event = step.event === null ? null : step.event === "recovered" ? "resolved" : "firing";
  const decision = gate(watch, step.watch.lastStatus, event, quiet);
  const pushes = decision.action === "send" || decision.action === "quiet-send";
  const updated: Watch = { ...step.watch, quiet: decision.quiet };
  // 用时要写下来（这一轮的开始也就此了结），压着的告警有了变化也要写；其余照原来的节流
  const persist = step.persist || runMs !== undefined || !sameQuiet(watch.quiet, decision.quiet);
  if (!pushes && !persist) return { ok: true, watch: updated, runMs };

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
      await waitForWriteSlot(state?.at);
      await writeWatchState(env, alive, nextDueAt(alive), now);
    }
    return { ok: false, reason: "suspended" };
  }

  const sample = { ok: !report.failed, ms: runMs };
  const detail = report.failed
    ? report.code !== undefined ? `退出码 ${report.code}` : "报告失败"
    : watch.lastStatus === "down" ? "恢复上报" : "开始上报";
  if (!pushes) {
    const next: Watch = { ...updated, history: heartbeatHistory(watch, updated, now, quiet !== null, sample, detail) };
    await waitForWriteSlot(state?.at);
    await writeWatchState(env, next, nextDueAt(next), now);
    return { ok: true, watch: next, runMs };
  }

  const recipients = await recipientsOf(env, channel);
  // 和路径式推送、/push、/hook 共用同一份按通道的额度。心跳地址本身就是凭据，定时任务的重试循环
  // 一直打 /fail，原先每次都给全群推一条。撞上额度就什么都不做：不推、不改状态 ——
  // 告警还没发出去，状态不能先走到 down；任务收到 429，下次报到再试
  if (!(await allowPush(env, channel, recipients))) return { ok: false, reason: "throttled", channel };

  const note = report.message && channel.policy?.e2eOnly ? (report.code !== undefined ? E2E_NOTE : E2E_FAIL_BODY) : report.message;
  const own = await heartbeatMessage(watch, step.event ?? "failed", now, note, { code: report.code, runMs });
  const params = decision.action === "quiet-send" ? { ...own, level: "passive" } : own;
  const delivery = await deliver(env, channel, recipients, alertParams(channel, watch, { ...params, watchId: await watchRef(watch) }));
  const attempt = retryAttempt(watch, delivery);
  const advanced: Watch = attempt === null ? updated : { ...watch, lastPingAt: now, pendingAlertAttempts: attempt };
  // 已经是 down 又报失败、离上次记下不到 PING_PERSIST_MS：推照推（每次失败都是一件事），状态不必再写 ——
  // 除了 lastPingAt 什么都没变。连着报失败的任务不会一秒写好几次同一个键，撞上 KV 同键每秒一次的上限
  if (attempt === null && !persist && watch.pendingAlertAttempts === undefined) {
    return { ok: true, watch: updated, runMs };
  }
  const next: Watch = { ...advanced, history: heartbeatHistory(watch, advanced, now, quiet !== null, sample, detail) };
  try {
    await waitForWriteSlot(state?.at);
    await writeWatchState(env, next, nextDueAt(next), now);
  } catch (err) {
    // 推送已经发出去了：这时回 500，任务一重试就再推一遍。状态没记上的，下次报到会按旧状态重来一次
    console.error(`心跳 ${watch.id} 告警已推出、状态没写进去`, err);
  }
  return { ok: true, watch: updated, runMs };
}

/**
 * /hb/{id}/start：任务开始跑了。只记下开始的时刻，下一次报到（成功或失败）据此算出这次用了多久，
 * 写进告警和历史。开始本身不算报到：不改状态、不推、不影响失联的判定。
 *
 * 写入有节流：离上次记下的开始不到 PING_PERSIST_MS 就不记 —— 按约定跑的任务（间隔至少 5 分钟）次次都记，
 * 比约定还勤的只记一部分，免得每分钟一次的任务一分钟写两次 KV。没记下开始的那一轮只是没有用时
 */
export async function recordHeartbeatStart(env: Env, id: string, now: number = Date.now()): Promise<HeartbeatOutcome> {
  if (!isValidId(id)) return MISSING;
  const [stored, state] = await Promise.all([readWatchConfig(env, id), readWatchState(env, "heartbeat", id)]);
  if (!stored || stored.kind !== "heartbeat") return MISSING;
  const watch = mergeWatch(stored, state);
  if (watch.startedAt !== undefined && now >= watch.startedAt && now - watch.startedAt < PING_PERSIST_MS) {
    return { ok: true, watch };
  }
  const [deleted, channel] = await Promise.all([isWatchDeleted(env, id), getChannel(env, stored.channelId)]);
  if (deleted) return MISSING;
  if (!channel) {
    await deleteWatch(env, stored, now);
    return MISSING;
  }
  if (channel.suspended) return { ok: false, reason: "suspended" };
  const next: Watch = { ...watch, startedAt: now };
  await waitForWriteSlot(state?.at);
  await writeWatchState(env, next, nextDueAt(next), now);
  return { ok: true, watch: next };
}

// ── 定时执行 ────────────────────────────────────────────────────────

/** 两个 cron（wrangler.toml）：整 5 分钟跑监控，错开 2 分钟跑重复提醒。各自一次调用、各自一份额度 */
export const WATCH_CRON = "*/5 * * * *";
export const REMINDER_CRON = "2-59/5 * * * *";
/**
 * 一次调用最多 1000 个子请求（KV 操作和对外 fetch 合在一起算）。用到这么多就不再开始新的监控：
 * 还在跑的最多 6 个，每个还要读写几次状态、抓一次网址；告警另有 SWEEP_ALERT_LIMIT 管着
 */
export const SWEEP_SOFT_LIMIT = 700;
/**
 * 告警推之前先占额度：读这群人的账号、再按人和设备估一遍投递的开销（见 push.ts deliveryCost），
 * 加上已经用掉的和别的告警占下的，超过这个数就这一轮不推、状态原样不动，下一轮它排在最前面再来。
 * 原先告警不看额度：6 个大群的告警一起推，光失效墓碑和 APNs 请求就过了 1000，推到一半中断。
 * 离 1000 留的一截给还在跑的监控（每个几次读写）和收尾（记录这一轮、通知运营者）
 */
export const SWEEP_ALERT_LIMIT = 900;
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
  /** 手动暂停或维护窗口里压下、没推的告警 */
  quieted: number;
  /** 通道被停用、这一轮跳过的 */
  skipped: number;
  /** 额度或时间用完、没轮上（或者告警这一轮推不起），顺延到下一轮的 */
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
  /** 这一轮对外发了多少个请求（APNs、抓网址）。和 kvOps 加起来就是子请求数 */
  fetches: number;
}

function emptyReport(): ScheduledReport {
  return {
    due: 0, checked: 0, alerted: 0, retrying: 0, abandoned: 0, paused: 0, quieted: 0, skipped: 0,
    deferred: 0, errors: 0, adopted: 0, removed: 0, leftovers: 0, kvOps: 0, fetches: 0,
  };
}

/** 一轮巡检的上下文。同一个通道常挂着好几个监控：通道和接收者这一轮只读一次 */
interface Sweep {
  env: Env;
  now: number;
  report: ScheduledReport;
  channels: Map<string, Promise<Channel | null>>;
  recipients: Map<string, Promise<Account[]>>;
  /** 给一条告警占下 cost 个子请求。占不下（这一轮推不起）返回 false；占下的推完用 release 还回去 */
  reserve(cost: number): boolean;
  release(cost: number): void;
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
    watchId: watch.id,
  });
}

/**
 * 推一条告警，按结果算这一轮的账。attempt 为 null 表示照常推进状态，数字是要记下的重推次数；
 * delivered 是真的推出去了（放弃的不算）。deferred 表示这一轮的额度推不起它，什么都没做 ——
 * 调用方不写状态，下一轮它照样到期、再来
 */
async function sendAlert(
  sweep: Sweep,
  channel: Channel,
  watch: Watch,
  own: PushParams,
): Promise<{ attempt: number | null; delivered: boolean } | "deferred"> {
  // 先占下读账号的额度（一个 50 人群就是五十几次读），读完才知道有几台设备、推一遍要多少
  const reads = sweep.recipients.has(channel.id) ? 0 : 1 + channel.memberIds.length;
  if (!sweep.reserve(reads)) {
    sweep.report.deferred += 1;
    return "deferred";
  }
  let recipients: Account[];
  try {
    recipients = await sweepRecipients(sweep, channel);
  } finally {
    sweep.release(reads);
  }
  const cost = deliveryCost(recipients);
  if (!sweep.reserve(cost)) {
    sweep.report.deferred += 1;
    return "deferred";
  }
  let delivery: DeliveryReport;
  try {
    const params = alertParams(channel, watch, { ...own, watchId: await watchRef(watch) });
    delivery = await deliver(sweep.env, channel, recipients, params);
  } finally {
    sweep.release(cost);
  }
  const attempt = retryAttempt(watch, delivery);
  const delivered = alertSettled(delivery);
  if (attempt !== null) sweep.report.retrying += 1;
  else if (delivered) sweep.report.alerted += 1;
  else sweep.report.abandoned += 1;
  return { attempt, delivered };
}

/** 一次网址检查落地之后：写下去的监控、这次推没推出告警 */
export interface SiteCheckOutcome {
  watch: Watch;
  alerted: boolean;
}

/**
 * 抓完一次之后：判状态、按安静期把关、推告警、记历史、写状态。cron 和「立即检测」走同一条路 ——
 * 状态只有一份，同一次掉线不会因为手动查了一下又被 cron 推一遍。
 * 返回 deferred：这一轮推不起告警，这次的结果不记，下一轮它还是到期的，重新抓、重新判断
 */
async function settleSiteCheck(
  sweep: Sweep,
  channel: Channel,
  watch: SiteWatch,
  result: Probe,
): Promise<SiteCheckOutcome | "deferred"> {
  const { env, now } = sweep;
  const step = siteStep(watch, result, now);
  const quiet = quietEnd(watch, now);
  const event = step.alert ? (step.alert.status === "resolved" ? "resolved" : "firing") : null;
  const decision = gate(watch, step.watch.lastStatus, event, quiet);
  let own: PushParams | null = null;
  if (decision.action === "send") own = step.alert;
  else if (decision.action === "quiet-send" && step.alert) own = { ...step.alert, level: "passive" };
  else if (decision.action === "settle" && watch.quiet) own = settledSiteMessage(watch, watch.quiet, step.watch.lastStatus, result);
  if (quiet && step.alert && decision.action === "none") sweep.report.quieted += 1;

  let next: Watch = { ...step.watch, pendingAlertAttempts: undefined, quiet: decision.quiet };
  let alerted = false;
  if (own) {
    const sent = await sendAlert(sweep, channel, watch, own);
    if (sent === "deferred") return "deferred";
    alerted = sent.delivered;
    // 没推出去：状态停在原处（压着的告警也原样留着），下一轮重新抓一次 —— 那时还是这样就再推，已经好了就不必推了
    if (sent.attempt !== null) {
      next = { ...step.watch, lastStatus: watch.lastStatus, pendingAlertAttempts: sent.attempt, quiet: watch.quiet };
    }
  }
  if (step.paused) {
    sweep.report.paused += 1;
    try {
      await noticePaused(sweep, channel, watch);
    } catch (err) {
      console.error(`监控 ${watch.id} 暂停的说明没推出去`, err);
    }
  }
  const ok = result.status !== "down" && result.status !== "error";
  const changed = next.lastStatus !== undefined && next.lastStatus !== watch.lastStatus;
  next.history = recordHistory(watch.history, now, {
    // 可用率按这次看到的算（一次失败也算一段异常），不等确认掉线；维护、暂停期间的异常不计
    cls: ok ? 1 : quiet ? -1 : 0,
    sample: { ok, ms: result.ms },
    change: changed ? { status: next.lastStatus as string, detail: result.detail, quiet: quiet !== null } : undefined,
  });
  await writeWatchState(env, next, nextDueAt(next), now);
  return { watch: next, alerted };
}

/**
 * 心跳到了该看的时刻：过了「间隔 + 宽限」还没来就推「没有按时上报」（维护窗口里只记下、不推），
 * 或者安静期刚结束、压下的失联还没恢复，补推一条
 */
async function runDueHeartbeat(sweep: Sweep, watch: Watch): Promise<void> {
  const { env, now } = sweep;
  const quiet = quietEnd(watch, now);
  const overdue = heartbeatOverdue(watch, now);
  const settling = watch.quiet !== undefined && quiet === null;
  if (!overdue && !settling) return;
  const channel = await liveChannel(sweep, watch);
  if (!channel || (await isWatchDeleted(env, watch.id))) return;

  const decision = overdue ? gate(watch, "down", "firing", quiet) : gate(watch, watch.lastStatus, null, null);
  let own: PushParams | null = null;
  if (decision.action === "send") own = await heartbeatMessage(watch, "down", now);
  else if (decision.action === "settle" && watch.quiet) own = await settledHeartbeatMessage(watch, watch.quiet, now);
  if (overdue && quiet && decision.action === "none") sweep.report.quieted += 1;

  // 推出去了（或者压下了）就记成 down：之后不再重复告警，等任务回来报到时推「恢复」
  let next: Watch = { ...watch, lastStatus: overdue ? "down" : watch.lastStatus, pendingAlertAttempts: undefined, quiet: decision.quiet };
  if (own) {
    const sent = await sendAlert(sweep, channel, watch, own);
    if (sent === "deferred") return;
    // 没推出去就还是原样，只记下试了几次 —— 失联的那一刻已经过了，下一轮照样到期、再推
    if (sent.attempt !== null) next = { ...watch, pendingAlertAttempts: sent.attempt };
  }
  const wentDown = next.lastStatus === "down" && watch.lastStatus !== "down";
  next.history = recordHistory(watch.history, now, {
    cls: next.lastStatus === "up" ? 1 : next.lastStatus === "down" && !quiet ? 0 : -1,
    sample: wentDown ? { ok: false } : undefined,
    change: wentDown ? { status: "down", detail: "没有按时上报", quiet: quiet !== null } : undefined,
  });
  await writeWatchState(env, next, nextDueAt(next), now);
}

/** 处理一个（按列表看）到期的监控。值以这一刻读到的为准 */
async function runDueWatch(sweep: Sweep, id: string): Promise<void> {
  const { env, now } = sweep;
  const stored = await readWatchConfig(env, id);
  if (!stored) return;
  const watch = mergeWatch(stored, await readWatchState(env, stored.kind, id));

  // 心跳不抓网址，只比一下报到时刻。列表可能比值旧一步：刚报到过的，以值为准，不误报
  if (watch.kind === "heartbeat") return runDueHeartbeat(sweep, watch);
  if (!isSiteWatch(watch)) return;
  if (isPaused(watch, now)) {
    // 列表上还按暂停之前排的时刻（暂停时状态没写进去）：按暂停重排一次，到暂停结束之前不再来
    await writeWatchState(env, watch, nextDueAt(watch), now);
    return;
  }
  if (now < siteDueAt(watch)) return;

  const channel = await liveChannel(sweep, watch);
  if (!channel) return;
  sweep.report.checked += 1;
  // 抓网址也是一个子请求。跟着跳转的每一跳其实各算一个，那几个留在余量里
  env.countFetch?.();
  const result = await probe(watch);
  // 抓取的这几秒里被删了：不推，也不把状态写回去
  if (await isWatchDeleted(env, id)) return;
  await settleSiteCheck(sweep, channel, watch, result);
}

/** 「立即检测」的结果。deleted：抓的这几秒里监控被删了，什么都没记 */
export type ManualCheck = { deleted: true } | { deleted: false; probe: Probe; watch: Watch; alerted: boolean };

/**
 * 「立即检测」：现在就抓一次，结果和 cron 的检查一样落地（状态、告警、历史）—— 状态只有一份，
 * 手动查出掉线推了告警，cron 下一轮就不会再推；cron 推过的，手动再查也不会重复推。
 * 暂停中也能查：结果照记，告警照样压着。不占巡检的额度（这是一次普通的请求）。
 * 频率由调用方管（每个监控每分钟一次，见 routes/watches.ts）
 */
export async function checkWatchNow(env: Env, watch: Watch, channel: Channel, now: number = Date.now()): Promise<ManualCheck> {
  if (!isSiteWatch(watch)) throw new Error("心跳没有网址可查");
  const sweep: Sweep = {
    env, now, report: emptyReport(), channels: new Map(), recipients: new Map(),
    reserve: () => true,
    release: () => undefined,
  };
  const result = await probe(watch);
  if (await isWatchDeleted(env, watch.id)) return { deleted: true };
  const done = await settleSiteCheck(sweep, channel, watch, result);
  if (done === "deferred") return { deleted: false, probe: result, watch, alerted: false };
  return { deleted: false, probe: result, watch: done.watch, alerted: done.alerted };
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
 * 最多 6 个同时抓。子请求（KV 操作加上对外的 fetch）快到每次调用 1000 个的上限、或者跑了 4 分钟，就不再开始新的，
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
  let reserved = 0;
  const sweep: Sweep = {
    env, now, report, channels: new Map(), recipients: new Map(),
    reserve(cost) {
      // 一条告警单独就超过上限（人多、每人设备又多）：永远占不下的话它就永远推不出去。
      // 让它在没有别的告警占着时推，推得出去多少算多少 —— 顺延过的排在下一轮最前面，那时额度最宽
      const oversized = cost > SWEEP_ALERT_LIMIT && reserved === 0;
      if (!oversized && meter.used() + reserved + cost > SWEEP_ALERT_LIMIT) return false;
      reserved += cost;
      return true;
    },
    release(cost) {
      reserved -= cost;
    },
  };
  const hasBudget = (): boolean =>
    meter.used() < SWEEP_SOFT_LIMIT && Date.now() - startedAt < SWEEP_TIME_BUDGET_MS;

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
  report.deferred += due.length - started;

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
  report.fetches = meter.fetches();
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
/**
 * 重复提醒这一轮的问题严重到要告诉运营者：出错的太多，或者到点的排不上的太多（额度不够用了，
 * 提醒在一轮轮地晚）。原先只有整轮抛错才通知 —— 额度用完之后逐条失败，记录里照样是 ok
 */
function reminderProblem(result: ReminderReport): string | null {
  if (result.errors < SWEEP_ERROR_ALERT && result.deferred < SWEEP_DEFERRED_ALERT) return null;
  return `这一轮补发了 ${result.sent} 条：${result.errors} 条出错，${result.deferred} 条没轮上、顺延到下一轮。详情看 Workers 日志。`;
}

export async function sweepReminders(env: Env, now: number = Date.now()): Promise<ReminderReport | null> {
  const startedAt = Date.now();
  let result: ReminderReport | null = null;
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
  const problem = result ? reminderProblem(result) : "这一轮整个没跑完，到点的重复提醒都没补发。详情看 Workers 日志。";
  if (problem) await notifyOperator(env, "reminders", "⚠️ 重复提醒出了问题", problem, now);
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
