import type { WatchChange, WatchHistory } from "./types";

/*
 * 监控的历史：最近 20 次状态变化、最近 24 小时的每次检查、最近 30 天按小时的正常 / 异常时长。
 *
 * 存在状态键（hbstate: / wstate:）的值里，跟状态同一次写入 —— 巡检每轮的 KV 额度一次也不多花，
 * 也不会多出一把要按「每秒最多写一次」错开的键。metadata 里没有它（放不下，cron 也用不着）。
 * 老监控没有历史：第一次检查或报到时从零开始记，之前的时段算「没有数据」，不算正常也不算异常。
 *
 * 可用率按时长算，不按次数：检查失败之后隔 5 分钟就复查一次，而正常时可能一小时才看一次 ——
 * 按次数数，一次十分钟的故障能把当天的可用率拉到九成。这里每次记录时，把上一次记录以来的那段时间
 * 记在上一次的结论名下（状态以最后一次看到的为准），暂停和维护期间的异常不计入。
 * 按小时而不是按天分格：服务端不知道用户在哪个时区，按小时存，要按哪个时区的「天」汇总都行。
 */

/** 状态变化留几条 */
export const HISTORY_CHANGES = 20;
/** 逐次检查留多久 */
export const HISTORY_CHECKS_MS = 24 * 60 * 60_000;
/**
 * 逐次检查最多留几条。巡检最密 5 分钟一次，一天 288 次；再加上「立即检测」（每分钟最多一次），
 * 有人一直点也就到此为止，值不会无限长
 */
export const HISTORY_MAX_CHECKS = 400;
/** 按小时的格子留多少个：30 天，再多一格给正在走的这个小时 */
export const HISTORY_HOURS = 30 * 24 + 1;

const HOUR_MS = 60 * 60_000;
/** 一次记下的时长最多算回这么久：再久的早就滚出 30 天了 */
const MAX_SPAN_MS = HISTORY_HOURS * HOUR_MS;
const MAX_DETAIL = 60;

/** 一次记录：cls 是从现在起到下一次记录算哪一类（1 正常、0 异常、-1 不计） */
export interface HistoryEntry {
  cls: 1 | 0 | -1;
  /** 这次检查（报到）的结果；只是改个计时起点（暂停、恢复）时不给 */
  sample?: { ok: boolean; ms?: number };
  /** 状态变了：变成了什么、为什么 */
  change?: { status: string; detail?: string; quiet?: boolean };
}

function fresh(now: number, cls: HistoryEntry["cls"]): WatchHistory {
  return { changes: [], checks: [], hours: { start: Math.floor(now / HOUR_MS), up: [], down: [] }, cur: cls, since: now };
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((n) => typeof n === "number" && Number.isFinite(n));
}

/**
 * 从存储里读出来的历史，逐项核对一遍。改坏了、将来的新格式认不出来的，当作没有历史重新记 ——
 * 可用率从零算起，总比一条坏记录让整个监控列表出错强
 */
export function readHistory(raw: unknown): WatchHistory | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const h = raw as Partial<WatchHistory>;
  const hours = h.hours;
  if (
    !Array.isArray(h.changes) || !Array.isArray(h.checks) || !hours || typeof hours.start !== "number" ||
    !isNumberArray(hours.up) || !isNumberArray(hours.down) || hours.up.length !== hours.down.length ||
    (h.cur !== 1 && h.cur !== 0 && h.cur !== -1) || typeof h.since !== "number"
  ) {
    return undefined;
  }
  return {
    changes: h.changes.filter((c): c is WatchChange => Boolean(c) && typeof c.at === "number" && typeof c.status === "string"),
    checks: h.checks.filter((c): c is [number, number, 0 | 1] => isNumberArray(c) && c.length === 3),
    hours: { start: hours.start, up: [...hours.up], down: [...hours.down] },
    cur: h.cur,
    since: h.since,
  };
}

function clone(h: WatchHistory): WatchHistory {
  return {
    changes: [...h.changes],
    checks: [...h.checks],
    hours: { start: h.hours.start, up: [...h.hours.up], down: [...h.hours.down] },
    cur: h.cur,
    since: h.since,
  };
}

/** 给第 hour 个小时的格子记上 seconds 秒。太旧（已滚出 30 天）的丢掉；格子不够就往后补，超出 30 天从前面滚掉 */
function addToHour(h: WatchHistory, hour: number, cls: 1 | 0, seconds: number): void {
  const slots = h.hours;
  if (slots.up.length === 0 || hour - slots.start >= 2 * HISTORY_HOURS) {
    // 空着，或者隔得太久（比如停了两个月）：整个重来，别补上千个 0 再滚掉
    slots.start = hour;
    slots.up = [];
    slots.down = [];
  }
  if (hour < slots.start) return;
  while (hour >= slots.start + slots.up.length) {
    slots.up.push(0);
    slots.down.push(0);
  }
  const overflow = slots.up.length - HISTORY_HOURS;
  if (overflow > 0) {
    slots.up.splice(0, overflow);
    slots.down.splice(0, overflow);
    slots.start += overflow;
  }
  if (hour < slots.start) return;
  const list = cls === 1 ? slots.up : slots.down;
  const index = hour - slots.start;
  list[index] = (list[index] ?? 0) + seconds;
}

/** 把 [from, to) 这段时间按小时切开，记到 cls 名下。cls = -1（不计）什么都不记 */
function attribute(h: WatchHistory, from: number, to: number, cls: HistoryEntry["cls"]): void {
  if (cls === -1 || !(to > from)) return;
  let t = Math.max(from, to - MAX_SPAN_MS);
  while (t < to) {
    const hour = Math.floor(t / HOUR_MS);
    const end = Math.min(to, (hour + 1) * HOUR_MS);
    const seconds = Math.round((end - t) / 1000);
    if (seconds > 0) addToHour(h, hour, cls, seconds);
    t = end;
  }
}

/**
 * 记一次：先把上一次以来的时长记到上一次的结论名下，再记这次的检查和状态变化，换上新的计时起点。
 * 返回新的历史，不改传进来的那份（告警没推出去时，调用方还要拿原来的状态重来）
 */
export function recordHistory(stored: unknown, now: number, entry: HistoryEntry): WatchHistory {
  const previous = readHistory(stored);
  const h = previous ? clone(previous) : fresh(now, entry.cls);
  if (previous) attribute(h, h.since, now, h.cur);

  if (entry.sample) {
    const ms = entry.sample.ms !== undefined && Number.isFinite(entry.sample.ms) ? Math.max(0, Math.round(entry.sample.ms)) : -1;
    h.checks.push([Math.floor(now / 1000), ms, entry.sample.ok ? 1 : 0]);
  }
  const cutoff = Math.floor((now - HISTORY_CHECKS_MS) / 1000);
  let drop = 0;
  while (drop < h.checks.length && ((h.checks[drop]?.[0] ?? 0) < cutoff || h.checks.length - drop > HISTORY_MAX_CHECKS)) drop += 1;
  if (drop > 0) h.checks.splice(0, drop);

  if (entry.change) {
    const change: WatchChange = { at: now, status: entry.change.status };
    const detail = entry.change.detail ? [...entry.change.detail].slice(0, MAX_DETAIL).join("") : "";
    if (detail) change.detail = detail;
    if (entry.change.quiet) change.quiet = 1;
    h.changes.push(change);
    if (h.changes.length > HISTORY_CHANGES) h.changes.splice(0, h.changes.length - HISTORY_CHANGES);
  }

  h.cur = entry.cls;
  h.since = now;
  return h;
}

/** 算可用率时连「上一次记录到现在」这段也算上：一直挂着的心跳不会再写状态，但它挂着的时间要算 */
function withPending(h: WatchHistory, now: number): WatchHistory {
  const copy = clone(h);
  attribute(copy, copy.since, now, copy.cur);
  return copy;
}

/** 百分比往下取两位：有过一分钟异常就不会显示成 100 */
function percent(up: number, down: number): number | null {
  const total = up + down;
  if (total <= 0) return null;
  return Math.floor((up / total) * 10000) / 100;
}

/** 最近 hours 个小时（含正在走的这个）的可用率，百分数；这段时间没有数据时是 null */
export function uptimePercent(stored: unknown, now: number, hours: number): number | null {
  const history = readHistory(stored);
  if (!history) return null;
  const h = withPending(history, now);
  const from = Math.floor(now / HOUR_MS) - hours + 1;
  let up = 0;
  let down = 0;
  h.hours.up.forEach((seconds, i) => {
    if (h.hours.start + i < from) return;
    up += seconds;
    down += h.hours.down[i] ?? 0;
  });
  return percent(up, down);
}

/** 列表和详情上用的几个数：24 小时、7 天、30 天可用率，最近一次检查的毫秒数（心跳是最近一次的用时） */
export function historyStats(stored: unknown, now: number): {
  uptime24h: number | null;
  uptime7d: number | null;
  uptime30d: number | null;
  lastMs: number | null;
} {
  const history = readHistory(stored);
  const last = history?.checks[history.checks.length - 1];
  return {
    uptime24h: uptimePercent(history, now, 24),
    uptime7d: uptimePercent(history, now, 7 * 24),
    uptime30d: uptimePercent(history, now, 30 * 24),
    lastMs: last && last[1] >= 0 ? last[1] : null,
  };
}

/** 某个时区里的日期 "2026-09-27"。时区不认得返回 null */
export function dateFormatter(tz: string): ((ms: number) => string) | null {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    return null;
  }
  return (ms) => {
    const parts = format.formatToParts(new Date(ms));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  };
}

export interface DailyUptime {
  date: string;
  up_seconds: number;
  down_seconds: number;
  uptime: number | null;
}

/**
 * 按某个时区的日期汇总最近 days 天，旧的在前，没有数据的日子不列。
 * 每个小时格算在它中点所在的那天：整点时区正好对齐，差半小时的时区（+05:30 这类）也归得八九不离十
 */
export function dailyUptime(stored: unknown, now: number, tz: string, days = 30): DailyUptime[] | null {
  const dateOf = dateFormatter(tz);
  if (!dateOf) return null;
  const history = readHistory(stored);
  if (!history) return [];
  const h = withPending(history, now);
  const byDate = new Map<string, { up: number; down: number }>();
  const from = Math.floor(now / HOUR_MS) - days * 24 + 1;
  h.hours.up.forEach((up, i) => {
    const hour = h.hours.start + i;
    const down = h.hours.down[i] ?? 0;
    if (hour < from || up + down <= 0) return;
    const date = dateOf(hour * HOUR_MS + HOUR_MS / 2);
    const day = byDate.get(date) ?? { up: 0, down: 0 };
    day.up += up;
    day.down += down;
    byDate.set(date, day);
  });
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(-days)
    .map(([date, day]) => ({ date, up_seconds: day.up, down_seconds: day.down, uptime: percent(day.up, day.down) }));
}
