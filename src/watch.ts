import { getChannel, isValidId, newId, recipientsOf, sha256 } from "./db";
import { deliver } from "./push";
import type { Env, Watch } from "./types";

const WATCH = "watch:";

/** 一个账号最多盯多少个（心跳也算在内）。个人用够了，也挡住有人拿它当爬虫 */
export const MAX_WATCHES = 20;
/** cron 每 5 分钟跑一次，比这更密没意义 */
export const MIN_INTERVAL_MINUTES = 5;
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

  const interval = Math.max(MIN_INTERVAL_MINUTES, Math.floor(Number(v.intervalMinutes) || 15));
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

export async function createWatch(env: Env, ownerId: string, input: Omit<Watch, "id" | "ownerId" | "createdAt">): Promise<Watch> {
  const watch: Watch = { id: newId(), ownerId, createdAt: Date.now(), ...input };
  await env.PIGEON_KV.put(WATCH + watch.id, JSON.stringify(watch));
  return watch;
}

export async function listWatches(env: Env, ownerId: string): Promise<Watch[]> {
  const { keys } = await env.PIGEON_KV.list({ prefix: WATCH });
  const all = await Promise.all(keys.map((k) => env.PIGEON_KV.get<Watch>(k.name, "json")));
  return all.filter((w): w is Watch => w !== null && w.ownerId === ownerId);
}

export async function getWatch(env: Env, id: string): Promise<Watch | null> {
  if (!isValidId(id)) return null;
  return env.PIGEON_KV.get<Watch>(WATCH + id, "json");
}

export async function deleteWatch(env: Env, id: string): Promise<void> {
  await env.PIGEON_KV.delete(WATCH + id);
}

async function putWatch(env: Env, watch: Watch): Promise<void> {
  await env.PIGEON_KV.put(WATCH + watch.id, JSON.stringify(watch));
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
 * 心跳是否失联：报到过（up），且过了「间隔 + 宽限」还没再来。
 * new 从不告警 —— 任务还没接上；down 已经告过警了，不再重复，等它回来推「恢复」。
 */
export function heartbeatOverdue(watch: Watch, now: number): boolean {
  if (watch.kind !== "heartbeat" || watch.lastStatus !== "up" || watch.lastPingAt === undefined) return false;
  const grace = watch.graceMinutes ?? defaultGraceMinutes(watch.intervalMinutes);
  return now > watch.lastPingAt + (watch.intervalMinutes + grace) * 60_000;
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

/**
 * 任务来报到：/hb/{id} 是正常，/hb/{id}/fail 是失败。返回更新后的心跳；不存在、或者不是心跳，返回 null。
 *
 * 和 cron 一样先推后写：推送中途出错的话状态还没改，下一次报到会再推一遍，
 * 不会落得「状态记了、通知没发」。
 */
export async function recordHeartbeat(
  env: Env,
  id: string,
  report: { failed: boolean; message?: string },
  now: number = Date.now(),
): Promise<Watch | null> {
  const watch = await getWatch(env, id);
  if (!watch || watch.kind !== "heartbeat") return null;

  const step = heartbeatStep(watch, report, now);
  if (step.event) {
    // 要推的时候才读通道 —— 正常报到是热路径，能省一次读取就省
    const channel = await getChannel(env, watch.channelId);
    // 通道没了 / 被停用：这个心跳也没有意义了，和 cron 里一样顺手删掉
    if (!channel || channel.suspended) {
      await deleteWatch(env, watch.id);
      return null;
    }
    const params = await heartbeatMessage(watch, step.event, now, report.message);
    await deliver(env, channel, await recipientsOf(env, channel), params);
  }
  if (step.persist) await putWatch(env, step.watch);
  return step.watch;
}

// ── 定时执行 ────────────────────────────────────────────────────────

/**
 * cron 每轮：把到点的监控抓一遍，状态变了就推给对应通道；心跳看有没有按时报到。
 *
 * 每个监控独立 try/catch —— 一个网站抓炸了不能带垮整轮。抓取和推送都做完再写回
 * lastStatus，写在最后：中途失败下轮重来，不会因为「状态记了、通知没发」而漏掉一次告警。
 * checked 只数这一轮真正去抓了的网址。
 */
export async function runScheduled(env: Env, now: number = Date.now()): Promise<{ checked: number; alerted: number }> {
  const { keys } = await env.PIGEON_KV.list({ prefix: WATCH });
  let checked = 0;
  let alerted = 0;

  for (const key of keys) {
    try {
      const watch = await env.PIGEON_KV.get<Watch>(key.name, "json");
      if (!watch) continue;

      // 心跳不抓网址，只比一下报到时刻，每轮都看 —— 不按间隔排队，失联最多晚一轮被发现
      if (watch.kind === "heartbeat") {
        if (!heartbeatOverdue(watch, now)) continue;
        const channel = await getChannel(env, watch.channelId);
        if (!channel || channel.suspended) {
          await deleteWatch(env, watch.id);
          continue;
        }
        await deliver(env, channel, await recipientsOf(env, channel), await heartbeatMessage(watch, "down", now));
        alerted += 1;
        // 记成 down：之后不再重复告警，等任务回来报到时推「恢复」
        await putWatch(env, { ...watch, lastStatus: "down" });
        continue;
      }
      if (!isSiteWatch(watch)) continue;

      const dueAt = (watch.lastCheckedAt ?? 0) + watch.intervalMinutes * 60_000;
      if (now < dueAt) continue;

      const channel = await getChannel(env, watch.channelId);
      // 通道没了 / 被停用：这个监控也没有意义了，顺手删掉
      if (!channel || channel.suspended) {
        await deleteWatch(env, watch.id);
        continue;
      }

      checked += 1;
      const result = await probe(watch);
      const outgoing = messageFor(watch, watch.lastStatus, result);
      if (outgoing) {
        await deliver(env, channel, await recipientsOf(env, channel), outgoing.params);
        alerted += 1;
      }
      // error（keyword 抓取失败）不覆盖上次的有效状态
      if (result.status !== "error") watch.lastStatus = result.status;
      watch.lastCheckedAt = now;
      await putWatch(env, watch);
    } catch {
      // 单个监控的任何异常都不该影响其它监控
    }
  }
  return { checked, alerted };
}
