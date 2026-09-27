import type { Watch } from "./types";
import { defaultGraceMinutes, parseWatchInput } from "./watch";
import { recordHistory } from "./watchhistory";
import { isPaused, parseMaintenance, parsePausedUntil, quietEnd } from "./watchquiet";

/*
 * 编辑一个监控（PATCH /account/{id}/watches/{wid}）。这里只算「改完是什么样、哪些键要写」，读写在 routes/watches.ts。
 *
 * 校验和新建完全一样：把没给的字段用现有的值补齐，整份再过一遍 parseWatchInput —— 编辑出来的监控
 * 不会是新建时建不出来的样子。id 不变，心跳的报到地址也就不变，定时任务那边什么都不用改。
 */

/** 编辑时认的字段：和新建时一样的驼峰写法，也认列表里回来的下划线写法 */
const FIELDS = {
  name: ["name"],
  url: ["url"],
  keyword: ["keyword"],
  present: ["present"],
  kind: ["kind"],
  channelId: ["channelId", "channel_id"],
  intervalMinutes: ["intervalMinutes", "interval_minutes"],
  graceMinutes: ["graceMinutes", "grace_minutes"],
  level: ["level"],
  repeat: ["repeat"],
  pausedUntil: ["paused_until", "pausedUntil"],
  maintenance: ["maintenance"],
} as const;

type Field = keyof typeof FIELDS;

/** 配置里用户能改的几项：比较前后有没有变 */
const CONFIG_KEYS = [
  "channelId", "kind", "url", "keyword", "present", "intervalMinutes", "graceMinutes",
  "name", "level", "repeat", "pausedUntil", "maintenance",
] as const;

export interface WatchEdit {
  /** 改完的监控：配置加上（按需重置过的）状态 */
  watch: Watch;
  /** 有没有真的改了什么。没有就一个键都不写 */
  changed: boolean;
  /** 状态也要重写：重置了、重新计时了，或者下一次该看它的时刻变了 */
  stateChanged: boolean;
  /** 通道或类型变了，按人的索引要跟着改（它的 metadata 里记着这两样） */
  indexChanged: boolean;
  /**
   * 原来那件事的重复提醒要停掉：暂停了、换了通道、或者换了要盯的东西（原来的「掉线」「出现了」都不作数了）。
   * 给的是原来的通道 —— 提醒排在那里
   */
  cancelIn: string | null;
}

function hostOf(url: string | undefined): string | null {
  try {
    return url ? new URL(url).hostname : null;
  } catch {
    return null;
  }
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 停在这一刻的监控算正常、异常还是没数据：暂停、恢复时给历史换计时起点用。
 * 网址监控看最近一次检查失败没有，心跳看状态
 */
function currentClass(watch: Watch): 1 | 0 | -1 {
  if (watch.kind === "heartbeat") return watch.lastStatus === "up" ? 1 : watch.lastStatus === "down" ? 0 : -1;
  if (watch.lastStatus === undefined && watch.lastCheckedAt === undefined) return -1;
  return watch.lastStatus === "down" || (watch.failCount ?? 0) > 0 ? 0 : 1;
}

/** 按 body 改 current。返回说明（400）或改完的样子 */
export function applyWatchEdit(current: Watch, raw: unknown, now: number): WatchEdit | string {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const given = new Map<Field, unknown>();
  for (const [field, names] of Object.entries(FIELDS) as [Field, readonly string[]][]) {
    const name = names.find((n) => Object.prototype.hasOwnProperty.call(body, n));
    if (name !== undefined) given.set(field, body[name]);
  }
  if (given.size === 0) {
    return "没有认得的字段。能改的有：name、url、keyword、present、intervalMinutes、graceMinutes、channelId、level、repeat、paused_until、maintenance";
  }

  // 类型：掉线和关键词可以互换（同一个网址，换个盯法）；心跳和网址监控是两回事，id 也是两种用法
  let kind = current.kind;
  if (given.has("kind")) {
    const wanted = given.get("kind");
    if (wanted !== current.kind) {
      if (current.kind === "heartbeat" || wanted === "heartbeat") return "心跳和网址监控不能互相改，删掉重建一个";
      if (wanted !== "up" && wanted !== "keyword") return "kind 只能是 up 或 keyword";
      kind = wanted;
    }
  }

  const input: Record<string, unknown> = {
    kind,
    channelId: current.channelId,
    url: current.url,
    keyword: current.keyword,
    present: current.present,
    intervalMinutes: current.intervalMinutes,
    graceMinutes: current.graceMinutes,
    name: current.name,
    level: current.level,
    repeat: current.repeat,
  };
  for (const field of ["name", "url", "keyword", "present", "channelId", "intervalMinutes", "graceMinutes", "level", "repeat"] as const) {
    if (given.has(field)) input[field] = given.get(field);
  }
  // 名字当初没起、用的是网址的域名：换了网址，名字跟着换成新的域名，别留着旧的
  if (!given.has("name") && given.has("url") && current.name === hostOf(current.url)) input.name = "";
  // 心跳的宽限当初用的缺省值（间隔的一成）：改了间隔，宽限按新间隔重算；自己设过的照留
  if (
    kind === "heartbeat" && given.has("intervalMinutes") && !given.has("graceMinutes") &&
    (current.graceMinutes === undefined || current.graceMinutes === defaultGraceMinutes(current.intervalMinutes))
  ) {
    input.graceMinutes = undefined;
  }

  const parsed = parseWatchInput(input);
  if (typeof parsed === "string") return parsed;
  // 心跳的解析结果里带着初始状态 new：那是新建用的，编辑不动状态
  const { lastStatus: _initial, ...fields } = parsed;

  const pause = given.has("pausedUntil") ? parsePausedUntil(given.get("pausedUntil"), now) : undefined;
  if (typeof pause === "string") return pause;
  let pausedUntil = current.pausedUntil;
  // 恢复：记成恢复的这一刻，不是删掉 —— 心跳从这一刻重新计时（见 watch.ts heartbeatDeadline）
  if (pause === null) pausedUntil = isPaused(current, now) ? now : current.pausedUntil;
  else if (pause !== undefined) pausedUntil = pause;

  let maintenance = current.maintenance;
  if (given.has("maintenance")) {
    const window = parseMaintenance(given.get("maintenance"));
    if (typeof window === "string") return window;
    maintenance = window ?? undefined;
  }

  const config: Watch = {
    id: current.id,
    ownerId: current.ownerId,
    createdAt: current.createdAt,
    ...fields,
    ...(pausedUntil !== undefined ? { pausedUntil } : {}),
    ...(maintenance ? { maintenance } : {}),
  };
  const changed = CONFIG_KEYS.some((key) => !same(current[key], config[key]));
  if (!changed) return { watch: current, changed: false, stateChanged: false, indexChanged: false, cancelIn: null };

  // 状态：先原样带过来，再看哪些要重置
  let watch: Watch = {
    ...config,
    updatedAt: now,
    lastStatus: current.lastStatus,
    lastCheckedAt: current.lastCheckedAt,
    lastPingAt: current.lastPingAt,
    failCount: current.failCount,
    timeoutCount: current.timeoutCount,
    pausedAt: current.pausedAt,
    lastDetail: current.lastDetail,
    pendingAlertAttempts: current.pendingAlertAttempts,
    quiet: current.quiet,
    startedAt: current.startedAt,
    history: current.history,
  };

  const statusReset = kind !== current.kind || config.keyword !== current.keyword || config.present !== current.present;
  const targetChanged = statusReset || config.url !== current.url;
  if (kind !== "heartbeat" && targetChanged) {
    // 换了网址：失败、超时的计数和暂停都是旧网址的事，清掉，下一轮就查新网址（清掉上次检查的时刻就是「现在到期」）。
    // 掉线监控的状态留着：旧网址挂着、新网址是好的，下一次检查就推「恢复了」，App 里那件事也就了结了
    watch = {
      ...watch,
      failCount: undefined, timeoutCount: undefined, pausedAt: undefined, lastDetail: undefined,
      pendingAlertAttempts: undefined, lastCheckedAt: undefined,
    };
    // 换了盯法（类型、关键词、出现还是消失）：原来的状态没有意义了，按新建处理 —— 第一次检查不提醒
    if (statusReset) watch = { ...watch, lastStatus: undefined, quiet: undefined };
  }

  const wasPaused = isPaused(current, now);
  const nowPaused = isPaused(config, now);
  if (wasPaused !== nowPaused && current.history) {
    // 暂停的这段不算进可用率；恢复时从现在的状态接着算
    watch.history = recordHistory(current.history, now, { cls: nowPaused ? -1 : currentClass(watch) });
  }
  if (watch.quiet) {
    // 压着告警时改了暂停或维护窗口：重算安静期到什么时候；已经不在安静期了，就让 cron 下一轮马上补判。
    // why 不动：它说的是事情出在哪段安静期里（见 watchquiet.ts gate）
    const quiet = quietEnd(watch, now);
    watch.quiet = { ...watch.quiet, until: quiet ? quiet.until : now };
  }

  const stateChanged =
    targetChanged || wasPaused !== nowPaused || !same(current.pausedUntil, config.pausedUntil) ||
    current.intervalMinutes !== config.intervalMinutes || current.graceMinutes !== config.graceMinutes ||
    !same(current.quiet, watch.quiet);
  const channelChanged = config.channelId !== current.channelId;
  return {
    watch,
    changed: true,
    stateChanged,
    indexChanged: channelChanged || kind !== current.kind,
    cancelIn: (nowPaused && !wasPaused) || channelChanged || statusReset ? current.channelId : null,
  };
}
