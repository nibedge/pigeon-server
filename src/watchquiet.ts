import type { MaintenanceWindow, Watch, WatchQuiet } from "./types";

/*
 * 安静期：手动暂停、每周维护窗口。
 *
 * 暂停：网址不抓、心跳不判失联，什么都不推 —— 这个监控暂时不归我们管了。任务来报到照样记下（报到时刻、
 * 用时），恢复之后心跳从恢复那一刻重新计时，不会一恢复就因为「暂停期间没报到」立刻响。
 * 维护窗口：照常检查、照常记录，只是不推告警。计划内的重启、备份时的停机不该半夜把人叫醒。
 *
 * 两种安静期里压下的告警不是丢掉，而是记下「压下之前是什么状态」（quiet.from）：安静期一结束，
 * 拿现在的状态和它比 —— 已经好了就当什么都没发生，还不对劲就补推一条，写明是维护或暂停期间出的事。
 * 安静期里恢复了一件之前告过警的事：照推，但降成静默送达 —— 让 App 里那件事了结、算出持续多久，又不吵人。
 */

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const DAY_MINUTES = 24 * 60;
/** 暂停最长一年；想一直停着就给 0（一直暂停到手动恢复） */
export const MAX_PAUSE_MS = 366 * 24 * 60 * 60_000;

function toMinutes(time: string): number {
  const [h, m] = time.split(":");
  return Number(h) * 60 + Number(m);
}

export function validTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * 编辑时给的维护窗口。null / "" 表示去掉；格式不对返回说明。
 * 时区也认 timezone 这个写法（通道免打扰时段用的是它）
 */
export function parseMaintenance(raw: unknown): MaintenanceWindow | null | string {
  if (raw === null || raw === "" || raw === false) return null;
  if (typeof raw !== "object") return "maintenance 要么是 null（去掉），要么是 {days, start, end, tz}";
  const v = raw as Record<string, unknown>;
  const rawDays = Array.isArray(v.days) ? v.days : [];
  const days = [...new Set(rawDays.map((d) => Number(d)))].sort((a, b) => a - b);
  if (days.length === 0 || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
    return "维护窗口的 days 是星期几的列表：1 = 周一 … 7 = 周日，至少选一天";
  }
  const start = String(v.start ?? "");
  const end = String(v.end ?? "");
  if (!TIME_RE.test(start) || !TIME_RE.test(end)) return "维护窗口的 start、end 写成 24 小时制的 \"HH:MM\"，如 \"03:00\"";
  const tz = String(v.tz ?? v.timezone ?? "").trim();
  if (!validTimeZone(tz)) return "维护窗口要给 tz：IANA 时区名，如 \"Asia/Shanghai\"";
  return { days, start, end, tz };
}

/**
 * 编辑时给的 paused_until：毫秒时刻 = 暂停到那时，0 = 一直暂停，null = 恢复。
 * 返回 undefined 表示没给；返回字符串是说明。给成秒（10 位数）的单独说一声 —— 这是最容易犯的错
 */
export function parsePausedUntil(raw: unknown, now: number): number | null | undefined | string {
  if (raw === undefined) return undefined;
  if (raw === null || raw === false) return null;
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "paused_until 是毫秒时刻：暂停到那时；0 = 一直暂停；null = 恢复";
  }
  if (value === 0) return 0;
  if (value < 1e11) return "paused_until 是毫秒时刻，看起来给的是秒";
  if (value <= now) return "暂停到的时刻已经过了";
  if (value - now > MAX_PAUSE_MS) return "最长暂停一年。想一直停着，paused_until 给 0";
  return Math.floor(value);
}

/** 现在是不是暂停着 */
export function isPaused(watch: Pick<Watch, "pausedUntil">, now: number): boolean {
  return watch.pausedUntil === 0 || (watch.pausedUntil !== undefined && watch.pausedUntil > now);
}

/** 某个时区里此刻是星期几（1–7）、当天第几分钟。时区不认得返回 null */
function localClock(tz: string, now: number): { weekday: number; minutes: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date(now));
    const weekday = WEEKDAYS[parts.find((p) => p.type === "weekday")?.value ?? ""];
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    const minute = Number(parts.find((p) => p.type === "minute")?.value);
    if (!weekday || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    // 有的实现午夜给 "24"
    return { weekday, minutes: (hour % 24) * 60 + minute };
  } catch {
    return null;
  }
}

/**
 * 现在在不在维护窗口里；在的话还剩多少分钟。
 * days 是窗口开始的那天：周日 23:00–01:00 的窗口，周一 00:30 也在里面（算周日的窗口）。
 * start 等于 end 是整整 24 小时
 */
function maintenanceLeft(window: MaintenanceWindow, now: number): number | null {
  const clock = localClock(window.tz, now);
  if (!clock) return null;
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  const cur = clock.minutes;
  const today = window.days.includes(clock.weekday);
  const yesterday = window.days.includes(clock.weekday === 1 ? 7 : clock.weekday - 1);
  if (start < end) return today && cur >= start && cur < end ? end - cur : null;
  // 跨午夜（或整 24 小时）：今天 start 之后，或者昨天开始、今天 end 之前
  if (today && cur >= start) return DAY_MINUTES - cur + end;
  if (yesterday && cur < end) return end - cur;
  return null;
}

export function inMaintenance(window: MaintenanceWindow | undefined, now: number): boolean {
  return window !== undefined && maintenanceLeft(window, now) !== null;
}

/**
 * 现在是不是安静期：返回什么时候结束、为什么；不是返回 null。
 * 一直暂停的 until 是 0（没有确定的结束，等手动恢复）。
 * 维护窗口的结束按分钟算到整分：跨夏令时切换那一晚可能差一小时 —— 到点时会再判断一次，不会提前推
 */
export function quietEnd(watch: Pick<Watch, "pausedUntil" | "maintenance">, now: number): Omit<WatchQuiet, "from"> | null {
  if (isPaused(watch, now)) return { until: watch.pausedUntil ?? 0, why: "pause" };
  if (!watch.maintenance) return null;
  const left = maintenanceLeft(watch.maintenance, now);
  if (left === null) return null;
  const minuteStart = Math.floor(now / 60_000) * 60_000;
  return { until: minuteStart + left * 60_000, why: "maint" };
}

/**
 * 这一步（一次检查、一次报到、一次失联判定）之后怎么推：
 *   send        照常推这一步自己的告警
 *   quiet-send  推这一步的告警（恢复），但静默送达
 *   settle      安静期结束了：拿 quiet.from 和现在比，补推一条（调用方按两头的状态生成，可能不用推）
 *   none        不推
 * quiet 是推完（或压下）之后要记的安静期状态，undefined 表示没有压着的告警
 */
export type GateAction = "send" | "quiet-send" | "settle" | "none";

export function gate(
  watch: Pick<Watch, "lastStatus" | "quiet">,
  next: string | undefined,
  event: "firing" | "resolved" | null,
  quiet: Omit<WatchQuiet, "from"> | null,
): { action: GateAction; quiet?: WatchQuiet } {
  const held = watch.quiet;
  const from = held ? held.from || undefined : undefined;
  // 已经压着的，只跟着延长结束时刻；why 留着第一次压下时的原因 —— 补推时说的「维护窗口内掉线」「暂停期间掉线」
  // 讲的是事情什么时候出的。维护窗口里掉的线、之后又被暂停，结束时说「暂停期间掉线」就错了
  const extend = (q: Omit<WatchQuiet, "from">): WatchQuiet | undefined => (held ? { ...held, until: q.until } : undefined);
  if (quiet) {
    // 压着告警、又变回了压下之前的样子：这段期间的变化互相抵消，什么都不用说了
    if (held && next === from) return { action: "none" };
    // 状态没变的告警（已经是 down 又报了一次失败）：用户知道的还是那样，不用记什么 ——
    // 记成「压下之前是 down」的话，之后在安静期里恢复了，那条早就推出去的「掉线」就永远等不到「恢复」
    if (event === null || (event === "firing" && next === watch.lastStatus)) {
      return { action: "none", quiet: extend(quiet) };
    }
    if (event === "resolved") {
      // 之前告过警的事在安静期里恢复了：静默送达，App 里那件事随之了结
      if (!held) return { action: "quiet-send" };
      return { action: "none", quiet: extend(quiet) };
    }
    // 新的告警：压下，记住压下之前用户最后知道的状态
    return { action: "none", quiet: extend(quiet) ?? { from: watch.lastStatus ?? "", ...quiet } };
  }
  if (!held) return { action: event ? "send" : "none" };
  // 安静期已经结束。这一步自己就有新的告警：它说的就是现状，照推（压着的一并了结）
  if (event === "firing") return { action: "send" };
  if (next === from) return { action: "none" };
  return { action: "settle" };
}

/** 补推的告警里说一句是什么时候出的事 */
export function quietNote(why: WatchQuiet["why"]): string {
  return why === "pause" ? "暂停期间" : "维护窗口内";
}
