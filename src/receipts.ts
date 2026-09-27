import { newSecret } from "./db";
import { keyMaterial, urlProblem } from "./actions";
import type { Env } from "./types";

/**
 * 回执与回调：谁、几点处理了某条消息，回给发送方。
 *
 * - 回执 `rcpt:{通道 id}:{消息 id}`：记下这条消息上有人点过哪些按钮、回过什么话（TTL 7 天）。
 *   发送方用推送带的 key 长轮询 `GET /{key}/receipt/{id}` 就能读到，认领状态另从 ack: 记录取。
 * - 回调 callback：推送时带上一个 https 地址，有人认领、点按钮，或重复提醒响到头还没人认领时，
 *   服务端 POST 一条带签名的事件过去。
 *   callback 地址随回执记录一起存 —— 认领发生在推送之后，那一刻服务端手里没有原推送，只能从这里取回。
 * - 通道回调密钥 `cbsec:{通道 id}`：服务端代发按钮请求、以及发回调事件时用它签名（X-Pigeon-Signature），
 *   接收方据此确认请求确实来自信鸽、内容没被人改过。只有创建者看得到、能重置。
 *
 * 回执只记元数据（谁、几点、点了哪个按钮、结果状态码），不记推送正文。
 */

const RECEIPT = "rcpt:";
const CALLBACK_SECRET = "cbsec:";
/** 回执保留 7 天：够发送方的脚本轮询到结果，也够事后查「这条告警谁处理的」 */
export const RECEIPT_TTL_SECONDS = 7 * 24 * 3600;
/** 一条消息的回执里最多记这么多次动作，满了挤掉最早的 —— 防着有人对着一条消息反复点刷爆记录 */
const MAX_RECEIPT_ACTIONS = 50;

/** 回执里的一次动作 */
export interface ReceiptAction {
  /** 谁点的（显示名） */
  by: string;
  at: number;
  /** 按钮名 */
  label: string;
  /** open | http | copy | reply */
  type: string;
  /** http：服务端代发那次请求的状态码；发不出去（超时、地址不通）时没有 */
  status?: number;
  ok?: boolean;
  /** reply：回复的文字 */
  reply?: string;
}

export interface ReceiptRecord {
  /** callback 地址，有人认领或点按钮时往这里发事件。推送时带了 callback 才有 */
  callback?: string;
  /** 服务端收下原推送的时刻 */
  sentAt?: number;
  actions?: ReceiptAction[];
}

function receiptKey(channelId: string, messageId: string): string {
  return `${RECEIPT}${channelId}:${messageId}`;
}

export async function getReceipt(env: Env, channelId: string, messageId: string): Promise<ReceiptRecord | null> {
  return env.PIGEON_KV.get<ReceiptRecord>(receiptKey(channelId, messageId), "json");
}

async function putReceipt(env: Env, channelId: string, messageId: string, record: ReceiptRecord): Promise<void> {
  await env.PIGEON_KV.put(receiptKey(channelId, messageId), JSON.stringify(record), {
    expirationTtl: RECEIPT_TTL_SECONDS,
  });
}

/**
 * 推送时带了 callback：把它连同发出时刻记进回执，认领和点按钮时才找得到往哪发。
 * 只在带了 callback 时写，普通推送的热路径一次写入都不加。写失败不抛 —— 回调是锦上添花
 */
export async function initReceipt(
  env: Env,
  channelId: string,
  messageId: string,
  callback: string,
  sentAt: number,
): Promise<void> {
  try {
    const existing = await getReceipt(env, channelId, messageId);
    // 同一个 id 又推了一版（带 callback）：更新地址，已经记下的动作留着
    await putReceipt(env, channelId, messageId, { ...(existing ?? {}), callback, sentAt });
  } catch {
    // 见上
  }
}

/** KV 同一个键每秒最多写一次：撞上了等过这一秒再试 */
const KV_WRITE_GAP_MS = 1100;

/**
 * 往回执里追加一次动作（没有记录就新建一条），返回这条消息的 callback 地址和记没记上。不抛。
 *
 * 读—改—写：两个人一秒之内点同一条消息，后写的那次撞上 KV 同键每秒一次的上限。原先异常被吞掉、
 * 连 callback 也一起丢了 —— 这次点按不进回执、不发回调，接口却回 200。现在写失败就等过这一秒、重读、
 * 在最新的记录上再追加一次；还不行就只是没记上，callback 照样从读到的记录里取，回调照发。
 * 不同机房几乎同时点的，各自读到的是缓存里的旧记录，后写的仍可能盖掉先写的那一次 —— KV 没有比较后写入，
 * 回调（每次点按各发一条）不受影响，要一条不漏就用回调
 */
export async function appendReceiptAction(
  env: Env,
  channelId: string,
  messageId: string,
  action: ReceiptAction,
): Promise<{ callback?: string; recorded: boolean }> {
  let callback: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, KV_WRITE_GAP_MS));
      const existing = (await getReceipt(env, channelId, messageId)) ?? {};
      callback = existing.callback ?? callback;
      const actions = [...(existing.actions ?? []), action].slice(-MAX_RECEIPT_ACTIONS);
      await putReceipt(env, channelId, messageId, { ...existing, actions });
      return { callback, recorded: true };
    } catch (err) {
      if (attempt > 0) console.warn("回执没记上", err instanceof Error ? err.message : err);
    }
  }
  return { callback, recorded: false };
}

// ── 通道回调密钥 ────────────────────────────────────────────────────

/**
 * 通道的回调密钥，创建者来看（GET callback-secret）时用：没有就生成一把并存下来，之后保持不变，
 * 接收方那边配一次签名校验就一直有效。存原值（不是哈希）：签名要用它。
 *
 * 第一把不是随机的，由服务端的签名材料和通道 id 派生（见 initialCallbackSecret）：第一次代发和创建者第一次来看
 * 可能几乎同时落在两个机房，原先各自随机生成、各自写下，最后只留下一把 —— 另一把签出去的请求、或者创建者抄走
 * 配在接收方的那一把，从此永远核对不过；同一秒写两次还会撞上 KV 的限制，点按直接回 500。派生出来的哪里算都一样，
 * 写不进去也照用。创建者看过的这一把仍然存下来：服务端的签名材料以后换了，已经配出去的密钥不能跟着变
 */
export async function ensureCallbackSecret(env: Env, channelId: string): Promise<string> {
  const key = CALLBACK_SECRET + channelId;
  const existing = await env.PIGEON_KV.get(key);
  if (existing) return existing;
  const secret = await initialCallbackSecret(env, channelId);
  try {
    await env.PIGEON_KV.put(key, secret);
  } catch {
    // 别处正在生成（同一秒写同一个键）：派生的两边一样，照用。随机的（没有签名材料的自建实例）以存下的那把为准
    const stored = await env.PIGEON_KV.get(key).catch(() => null);
    if (stored) return stored;
  }
  return secret;
}

/**
 * 签名要用的回调密钥（代发按钮、发回调）：存着的就用存着的，没有就用派生的那一把，不写。
 * 签名这一路不写 cbsec: —— 这个机房缓存里还是「没有」的时候，创建者可能刚在别处重置过，
 * 这时写下派生的那一把就把他新换的盖掉了。没有签名材料的自建实例派生不了，照旧生成一把存下
 */
export async function callbackSecretForSigning(env: Env, channelId: string): Promise<string> {
  const existing = await env.PIGEON_KV.get(CALLBACK_SECRET + channelId);
  if (existing) return existing;
  if (!keyMaterial(env)) return ensureCallbackSecret(env, channelId);
  return initialCallbackSecret(env, channelId);
}

const CALLBACK_SECRET_CONTEXT = "pigeon callback-secret v1|";

/**
 * 回调密钥的初始值：HMAC-SHA256(SHA-256(前缀 + 签名材料), 通道 id)，43 个字符的 base64url，和随机生成的一样长。
 * 签名材料是 APNS_KEY_P8（本地测试是公开的测试材料），拿不到它就算不出来；重置之后换成随机的新值。
 * 没有签名材料的自建实例退回随机生成
 */
async function initialCallbackSecret(env: Env, channelId: string): Promise<string> {
  const material = keyMaterial(env);
  if (!material) return newSecret();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(CALLBACK_SECRET_CONTEXT + material));
  const key = await crypto.subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(channelId)));
  let bin = "";
  for (const b of mac) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 重置回调密钥：旧的立即失效。地址泄漏或想轮换时用 */
export async function regenerateCallbackSecret(env: Env, channelId: string): Promise<string> {
  const secret = newSecret();
  await env.PIGEON_KV.put(CALLBACK_SECRET + channelId, secret);
  return secret;
}

// ── 出站签名 ────────────────────────────────────────────────────────

/** 代发按钮、发回调时的 User-Agent。收到带它的请求说明绕回了自己（见 index.ts isOwnOutbound） */
export const OUTBOUND_USER_AGENT = "Pigeon-Callback/1";

/**
 * 这个请求是不是信鸽自己发出的代发、回调绕回来了：按钮和回调的地址不许指回信鸽（见 actions.ts urlProblem），
 * 可那边只认得出已知的域名 —— workers.dev 备用入口的全名、自建实例的其它别名它不知道。这里在入口兜底：
 * 按钮的请求头改不了 User-Agent 和 X-Pigeon-*（见 actions.ts 的保留请求头），带着它们来的只可能是自己
 */
export function isOwnOutbound(request: Request): boolean {
  return (request.headers.get("user-agent") ?? "").startsWith("Pigeon-Callback/") || request.headers.has("x-pigeon-signature");
}

const encoder = new TextEncoder();
const hmacKeys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = hmacKeys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    hmacKeys.set(secret, key);
  }
  return key;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 一次出站请求里要签进去的东西 */
export interface OutgoingRequest {
  method: string;
  /** 请求的完整地址（规整过、不带 #，见 signedUrl） */
  url: string;
  /** X-Pigeon-Event 的值 */
  event: string;
  /** 请求体原文；没有请求体是空字符串 */
  body: string;
}

/**
 * 签名里的地址：按 URL 规范规整一遍（主机名小写、该转义的转义、默认端口去掉），去掉 # 之后的部分 ——
 * 它不会发出去，接收方看不到。接收方按「https:// + Host 头 + 请求路径（含查询）」拼出来的就是这一串
 */
export function signedUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  return url.toString();
}

/**
 * 给出站请求（代发按钮、发回调）签名。签的是这五样，换行隔开：
 *
 *   时间戳 \n 方法 \n 完整地址 \n 事件 \n 请求体
 *
 * 时间戳：别人截下这次请求也没法过一会儿再重放。方法、地址、事件：按钮的地址和请求体是推送方定的 ——
 * 原先只签「时间戳.请求体」，能推送的人推一个指向自己地址的按钮、等成员点一下，就拿到了一份任意请求体的
 * 合法签名，5 分钟内原样转发到群主真正信任这把密钥的地址（比如回滚接口），校验必然通过；X-Pigeon-Event
 * 也能随手改。现在签名绑着这一次请求发往哪里、用什么方法、是哪种事件，挪到别的地址、改成别的事件都对不上。
 * 地址、方法、事件里都不会有换行，所以这样拼不会有两种拆法。
 * 头：X-Pigeon-Timestamp（秒）、X-Pigeon-Signature（sha256=十六进制 HMAC）。
 */
export async function signOutgoing(
  secret: string,
  request: OutgoingRequest,
  now = Date.now(),
): Promise<{ timestamp: string; signature: string }> {
  const timestamp = String(Math.floor(now / 1000));
  const text = [timestamp, request.method.toUpperCase(), request.url, request.event, request.body].join("\n");
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(text));
  return { timestamp, signature: `sha256=${hex(mac)}` };
}

// ── 代发按钮的 http 请求 ────────────────────────────────────────────

/** 代发请求最多等 5 秒：接收方自己的服务慢，不能把信鸽的 Worker 卡在这 */
const ACTION_TIMEOUT_MS = 5000;
/** 最多读接收方回来的这么多字节：只是为了判成没成，不整段收进内存 */
const MAX_RESPONSE_BYTES = 16 * 1024;
/** 最多跟几跳重定向，且只跟同主机的：跨主机跳转多半是想把带签名的请求引到别处去 */
const MAX_REDIRECTS = 3;

export interface HttpActionResult {
  status?: number;
  ok: boolean;
  /** 发不出去时的原因（超时、地址不通、跨主机跳转），只用来记进回执和日志 */
  error?: string;
}

/**
 * 服务端替用户请求按钮的地址，带上通道回调密钥的签名，和回调事件一样标上 X-Pigeon-Event（action / reply）：
 * 同一个接收地址既收代发又收回调时，看这个头就知道是哪一种。
 *
 * 只走 https、只请求域名（urlProblem 已经在收按钮时挡过 IP 和内网，这里再挡一次做纵深防御），
 * 限时 5 秒，回来的内容最多读 16KB，重定向只跟同主机、最多 3 跳 —— 免得这个代发口子被人拿去
 * 探内网、或者把带签名的请求引到别的主机上。
 */
export async function performHttpAction(
  method: string,
  url: string,
  headers: Record<string, string> | undefined,
  body: string | undefined,
  secret: string,
  now = Date.now(),
  event: "action" | "reply" = "action",
): Promise<HttpActionResult> {
  const problem = urlProblem(url, "按钮地址");
  if (problem) return { ok: false, error: problem };

  const hasBody = body !== undefined && method !== "GET";
  const payload = hasBody ? body! : "";
  const baseHeaders: Record<string, string> = {
    ...(headers ?? {}),
    "X-Pigeon-Event": event,
    "User-Agent": OUTBOUND_USER_AGENT,
  };
  if (hasBody && !Object.keys(baseHeaders).some((h) => h.toLowerCase() === "content-type")) {
    baseHeaders["content-type"] = "application/json";
  }
  // 签名绑着地址：跟重定向跳到的每一跳按它自己的地址重签，接收方拿自己的地址核对得上
  const signedHeaders = async (target: string): Promise<Record<string, string>> => {
    const sig = await signOutgoing(secret, { method, url: target, event, body: payload }, now);
    return { ...baseHeaders, "X-Pigeon-Timestamp": sig.timestamp, "X-Pigeon-Signature": sig.signature };
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ACTION_TIMEOUT_MS);
  try {
    let current = signedUrl(url);
    for (let hop = 0; ; hop++) {
      const res = await fetch(current, {
        method,
        headers: await signedHeaders(current),
        body: hasBody ? payload : undefined,
        redirect: "manual",
        signal: controller.signal,
      });
      // 3xx 且给了新地址：只在同主机、没超跳数时跟过去，其余就停在这
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location || hop >= MAX_REDIRECTS) return { ok: res.ok, status: res.status };
        const refused = redirectRefusal(current, location);
        if (refused) return { ok: false, status: res.status, error: refused };
        current = signedUrl(new URL(location, current).toString());
        continue;
      }
      // 回来的内容最多读 16KB，读完就好，不关心具体是什么
      await drain(res, MAX_RESPONSE_BYTES);
      return { ok: res.ok, status: res.status };
    }
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { ok: false, error: aborted ? "接收方 5 秒内没有响应" : `请求发不出去：${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 这一跳重定向能不能跟：能跟返回 null，不能跟返回原因。每一跳都和按钮地址一样过一遍 urlProblem
 * （只收 https、只收公网域名、不指回信鸽），再要求同主机、同端口 —— 原先只比主机名，
 * Location 给 http://同主机/… 或 https://同主机:8443/ 照跟，签名头和按钮自带的请求头（可能有凭据）就走了明文或别的服务
 */
export function redirectRefusal(current: string, location: string): string | null {
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    return "重定向地址无效";
  }
  const from = new URL(current);
  if (next.hostname.toLowerCase() !== from.hostname.toLowerCase()) return "跨主机重定向，已停止";
  if (next.protocol !== "https:") return "重定向到了非 https 地址，已停止";
  if (next.port !== from.port) return "重定向换了端口，已停止";
  const problem = urlProblem(next.toString(), "重定向地址");
  return problem ? `${problem}，已停止` : null;
}

/** 把响应体读掉、最多 limit 字节，免得占住连接 */
async function drain(res: Response, limit: number): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  let read = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      if (read >= limit) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } catch {
    // 读到一半断了无所谓：状态码已经拿到了
  }
}

// ── 回调事件 ────────────────────────────────────────────────────────

/**
 * 有人认领了一条消息：如果它推送时带了 callback，发一条 ack 事件过去。
 * 认领本身已经记在 ack: 里（回执查询直接读那份），这里只管发回调。best-effort，出错不影响认领
 */
export async function onAckCallback(
  env: Env,
  channelId: string,
  messageId: string,
  by: string,
  at: number,
): Promise<void> {
  try {
    const receipt = await getReceipt(env, channelId, messageId);
    if (!receipt?.callback) return;
    await fireCallback(env, channelId, receipt.callback, {
      event: "ack",
      channel_id: channelId,
      id: messageId,
      by,
      at,
    });
  } catch {
    // 见上
  }
}

/**
 * 重复提醒响到头了还没人认领：如果这条消息推送时带了 callback，发一条 expired 事件。
 * 发送方的脚本据此改走别的路（打电话、发邮件、叫下一个人），不必自己数着时间等。
 * 最后一次提醒刚发出，之后仍可能有人认领 —— 那时照常再来一条 ack 事件。best-effort，出错不影响补发
 */
export async function onRepeatExpired(
  env: Env,
  channelId: string,
  messageId: string,
  reminders: number,
): Promise<void> {
  try {
    const receipt = await getReceipt(env, channelId, messageId);
    if (!receipt?.callback) return;
    await fireCallback(env, channelId, receipt.callback, {
      event: "expired",
      channel_id: channelId,
      id: messageId,
      at: Date.now(),
      reminders,
    });
  } catch {
    // 见上
  }
}

export type CallbackEventName = "ack" | "action" | "reply" | "expired";

export interface CallbackEvent {
  event: CallbackEventName;
  channel_id: string;
  /** 消息 id */
  id: string;
  /** 谁触发的（显示名）。expired 没有人触发，不带 */
  by?: string;
  at: number;
  /** action / reply：点的按钮名 */
  action?: string;
  /** reply：回复的文字 */
  reply?: string;
  /** expired：连原消息一共响了几次 */
  reminders?: number;
}

/**
 * 往 callback 地址发一条签名事件。best-effort：发不出去只记日志，不重试 —— KV 不是队列，
 * 与其把重试逻辑做半吊子，不如让发送方靠 GET /{key}/receipt/{id} 的长轮询兜底。
 * 用通道回调密钥签名（见 callbackSecretForSigning）。返回发没发出去。
 */
export async function fireCallback(
  raw: Env,
  channelId: string,
  callback: string,
  event: CallbackEvent,
): Promise<boolean> {
  // 推送时已经验过这个地址；这里再挡一次，和代发按钮一样做纵深防御 —— 签了名的请求只发往公网域名
  if (urlProblem(callback, "callback")) return false;
  try {
    const secret = await callbackSecretForSigning(raw, channelId);
    const body = JSON.stringify(event);
    const target = signedUrl(callback);
    const sig = await signOutgoing(secret, { method: "POST", url: target, event: event.event, body });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ACTION_TIMEOUT_MS);
    try {
      raw.countFetch?.();
      const res = await fetch(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Pigeon-Timestamp": sig.timestamp,
          "X-Pigeon-Signature": sig.signature,
          "X-Pigeon-Event": event.event,
          "User-Agent": OUTBOUND_USER_AGENT,
        },
        body,
        redirect: "manual",
        signal: controller.signal,
      });
      await drain(res, MAX_RESPONSE_BYTES);
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.error("回调发送失败", err instanceof Error ? err.message : err);
    return false;
  }
}
