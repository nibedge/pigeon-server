import { getChannel, isValidId, newId, recipientsOf } from "./db";
import { deliver } from "./push";
import type { Env, Watch } from "./types";

const WATCH = "watch:";

/** 一个账号最多盯多少个。个人用够了，也挡住有人拿它当爬虫 */
export const MAX_WATCHES = 20;
/** cron 每 5 分钟跑一次，比这更密没意义 */
export const MIN_INTERVAL_MINUTES = 5;
/** 抓取超时。Worker 的 subrequest 有时限，别卡死整轮 */
const FETCH_TIMEOUT_MS = 10_000;
/** 关键词匹配只读这么多字节，页面再大也不至于撑爆内存 */
const MAX_BODY_BYTES = 512 * 1024;

export interface WatchInput {
  channelId: string;
  kind: "up" | "keyword";
  url: string;
  /** kind=keyword 时：要找的词 */
  keyword?: string;
  /** kind=keyword 时：true=出现了就提醒（抢票开了），false=消失了就提醒 */
  present?: boolean;
  intervalMinutes?: number;
  name?: string;
}

/** 校验并规整用户提交的监控。返回错误说明，或规整后的字段 */
export function parseWatchInput(raw: unknown): string | Omit<Watch, "id" | "ownerId" | "createdAt"> {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const kind = v.kind === "keyword" ? "keyword" : v.kind === "up" ? "up" : null;
  if (!kind) return "kind 只能是 up 或 keyword";

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

async function probe(watch: Watch): Promise<Probe> {
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
function messageFor(watch: Watch, prev: string | undefined, probe: Probe): { params: Record<string, string> } | null {
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

// ── 定时执行 ────────────────────────────────────────────────────────

/**
 * cron 每轮：把到点的监控抓一遍，状态变了就推给对应通道。
 *
 * 每个监控独立 try/catch —— 一个网站抓炸了不能带垮整轮。抓取和推送都做完再写回
 * lastStatus，写在最后：中途失败下轮重来，不会因为「状态记了、通知没发」而漏掉一次告警。
 */
export async function runScheduled(env: Env, now: number = Date.now()): Promise<{ checked: number; alerted: number }> {
  const { keys } = await env.PIGEON_KV.list({ prefix: WATCH });
  let checked = 0;
  let alerted = 0;

  for (const key of keys) {
    try {
      const watch = await env.PIGEON_KV.get<Watch>(key.name, "json");
      if (!watch) continue;
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
