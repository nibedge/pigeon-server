import { pushToDevice } from "./apns";
import {
  getAccount,
  getChannel,
  isValidId,
  newId,
  newSecret,
  recipientsOf,
  resolveChannel,
  sha256,
} from "./db";
import { buildPayload, pushHeaders, repeatMinutes } from "./push";
import { allow } from "./ratelimit";
import { levelRank } from "./receivers";
import type { Account, Channel, Env, PushParams } from "./types";

/**
 * 发送令牌：一个通道除了自己的推送地址（key），还能发出最多 10 个带名字的发送令牌 —— 给 NAS 一个、给 Grafana 一个、
 * 给家里人的网页发送链接一个。每个令牌可以单独停用、单独限级别和频率，推出去的消息带上「来自：NAS」。
 *
 * 为什么不只用一个 key：
 * - 一个 key 配在五六个地方，其中一处泄露了只能整个换掉，五六个地方一起改；令牌停用那一个就够了
 * - 给家里人的网页链接不该能发「紧急」、不该能一小时吵十几次；key 没法按来源设限
 * - 通知是谁发来的、哪个来源最吵，一眼看得出来
 *
 * 令牌只能推送。管理接口一律只认账号凭据：拿到令牌的人看不到通道收到的其他消息，也改不了任何设置。
 *
 * 存储（令牌相关的都在 stok: 下）：
 *   stok:{令牌的 SHA-256}   令牌本身：属于哪个通道、名字、限制。推送热路径只读这一个键。
 *                           令牌明文服务端不留，只在新建时回给创建者一次（和账号凭据一样）
 *   stok:ch:{通道 id}       这个通道的令牌清单（令牌 id 和摘要）和换下来的地址的摘要。列出令牌、删通道时靠它找全
 *   stok:use:{令牌 id}      用了几次、最近一次的时刻。按分钟攒着写，同 db.ts 的推送统计
 *   oldkey:{地址的 SHA-256} 换掉的推送地址、删掉的令牌，留 30 天：再有人用，回 410「地址已停用」，
 *                           并告诉创建者一声（一天最多一次）—— 原先只回「key 不存在，检查有没有拼错」，发送方以为是自己抄错了
 */

const TOKEN = "stok:";
const TOKEN_INDEX = "stok:ch:";
const TOKEN_USE = "stok:use:";
const RETIRED = "oldkey:";

/** 每个通道最多几个发送令牌。再多就该想想是不是一个来源配了一个 —— 那是 id 和标签该干的事 */
export const MAX_TOKENS_PER_CHANNEL = 10;
/** 令牌名会出现在别人的通知卡片上（「来自：NAS」），和成员显示名一样短 */
export const TOKEN_NAME_MAX = 20;
/** 每分钟上限最多设到 60：再多通道自己的额度（每分钟 60 条）先拦住了 */
export const TOKEN_PER_MINUTE_MAX = 60;
/** 换掉的地址、删掉的令牌留多久的墓碑 */
export const RETIRED_TTL_SECONDS = 30 * 24 * 3600;
/** 旧地址还有人在用：隔多久才再告诉创建者一次 */
export const RETIRED_NOTICE_INTERVAL_MS = 24 * 3600 * 1000;
/** 清单里最多记几个换下来的地址。更早的照样回 410，只是删通道时找不到它们，由 30 天过期兜底 */
const MAX_RETIRED_INDEXED = 20;

/**
 * 令牌的样子：st_ 加 43 个 base64url 字符（256 bit）。和推送 key（22 个字符）一眼分得开，
 * 服务端也靠这个格式决定先查令牌 —— key 的查法一点没变，老地址不多读一次存储
 */
const TOKEN_RE = /^st_[A-Za-z0-9_-]{43}$/;

export function isTokenFormat(value: string): boolean {
  return TOKEN_RE.test(value);
}

function newTokenValue(): string {
  return `st_${newSecret()}`;
}

export type TokenLevel = "passive" | "active" | "timeSensitive";

export interface SendToken {
  id: string;
  channelId: string;
  name: string;
  /** 最高级别：高于它的按它送。设在「普通」及以下的，也不能要求重复提醒 */
  maxLevel?: TokenLevel;
  /** 每分钟最多几条（1–60）。没设就只受通道每分钟 60 条的限制 */
  perMinute?: number;
  disabled?: boolean;
  createdAt: number;
  /** 令牌末四位：列表里认出是哪一个。令牌本身不存 */
  hint: string;
}

interface TokenUse {
  count: number;
  lastUsedAt: number;
}

interface TokenIndex {
  tokens: { id: string; hash: string }[];
  /** 换下来的推送地址、删掉的令牌的墓碑：删通道时一并删掉，不让它们在通道没了之后还挂 30 天 */
  retired?: { hash: string; until: number }[];
}

interface RetiredRecord {
  channelId: string;
  /** key：换地址换下来的；token：删掉的发送令牌 */
  kind: "key" | "token";
  /** 删掉的令牌叫什么 */
  name?: string;
  at: number;
  /** 墓碑到期的时刻（毫秒）。KV 的过期最终一致，到点后可能还读得到一会儿 —— 自己再核一次 */
  until: number;
  /** 最近一次为它提醒创建者的时刻 */
  noticedAt?: number;
}

/** 级别的中文叫法，和 App、README 一致 */
export const LEVEL_LABELS: Record<TokenLevel, string> = {
  passive: "静默",
  active: "普通",
  timeSensitive: "时效性",
};

const TOKEN_LEVELS = new Map<string, TokenLevel>([
  ["passive", "passive"],
  ["active", "active"],
  ["timesensitive", "timeSensitive"],
  ["time-sensitive", "timeSensitive"],
]);

// ── 读写 ────────────────────────────────────────────────────────────

/** 存储里的令牌 → 规整过的样子。格式不对的当不存在 —— 它只可能是这里写的，坏了宁可推不进来也不能放宽限制 */
function parseToken(raw: unknown): SendToken | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<Record<keyof SendToken, unknown>>;
  if (typeof r.id !== "string" || typeof r.channelId !== "string" || typeof r.name !== "string") return null;
  const token: SendToken = {
    id: r.id,
    channelId: r.channelId,
    name: r.name,
    createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
    hint: typeof r.hint === "string" ? r.hint : "",
  };
  const level = typeof r.maxLevel === "string" ? TOKEN_LEVELS.get(r.maxLevel.toLowerCase()) : undefined;
  if (level) token.maxLevel = level;
  if (typeof r.perMinute === "number" && Number.isInteger(r.perMinute) && r.perMinute > 0) {
    token.perMinute = Math.min(r.perMinute, TOKEN_PER_MINUTE_MAX);
  }
  if (r.disabled === true) token.disabled = true;
  return token;
}

async function readToken(env: Env, hash: string): Promise<SendToken | null> {
  return parseToken(await env.PIGEON_KV.get(TOKEN + hash, "json"));
}

async function putToken(env: Env, hash: string, token: SendToken): Promise<void> {
  await env.PIGEON_KV.put(TOKEN + hash, JSON.stringify(token));
}

async function readIndex(env: Env, channelId: string): Promise<TokenIndex> {
  const raw = await env.PIGEON_KV.get<Partial<TokenIndex>>(TOKEN_INDEX + channelId, "json");
  const tokens = Array.isArray(raw?.tokens)
    ? raw.tokens.filter((t): t is TokenIndex["tokens"][number] => typeof t?.id === "string" && typeof t?.hash === "string")
    : [];
  const retired = Array.isArray(raw?.retired)
    ? raw.retired.filter((t): t is NonNullable<TokenIndex["retired"]>[number] => typeof t?.hash === "string" && typeof t?.until === "number")
    : [];
  return { tokens, retired };
}

/** 写回时顺手丢掉过期的墓碑；什么都不剩就删键，不留空壳 */
async function writeIndex(env: Env, channelId: string, index: TokenIndex, now = Date.now()): Promise<void> {
  const retired = (index.retired ?? []).filter((r) => r.until > now).slice(-MAX_RETIRED_INDEXED);
  if (index.tokens.length === 0 && retired.length === 0) {
    await env.PIGEON_KV.delete(TOKEN_INDEX + channelId);
    return;
  }
  const next: TokenIndex = { tokens: index.tokens, ...(retired.length ? { retired } : {}) };
  await env.PIGEON_KV.put(TOKEN_INDEX + channelId, JSON.stringify(next));
}

/** 这个通道的全部令牌（按新建先后），带上用量。清单里有、令牌却读不到的（写到一半失败）跳过 */
export async function listTokens(env: Env, channelId: string): Promise<{ token: SendToken; use: TokenUse | null }[]> {
  const index = await readIndex(env, channelId);
  const found = await Promise.all(
    index.tokens.map(async (entry) => {
      const [token, use] = await Promise.all([readToken(env, entry.hash), readUse(env, entry.id)]);
      return token && token.id === entry.id && token.channelId === channelId ? { token, use } : null;
    }),
  );
  return found.filter((t): t is { token: SendToken; use: TokenUse | null } => t !== null);
}

// ── 新建、修改、删除（仅创建者，入口在 routes/tokens.ts）─────────────

export interface TokenInput {
  name?: string;
  /** null = 不限 */
  maxLevel?: TokenLevel | null;
  /** null = 不限 */
  perMinute?: number | null;
  disabled?: boolean;
}

/** 接口交上来的字段 → TokenInput；不合格返回说给人听的原因。creating：新建时名字必填 */
export function parseTokenInput(body: Record<string, unknown>, creating: boolean): TokenInput | string {
  const input: TokenInput = {};
  if (creating || "name" in body) {
    const name =
      typeof body.name === "string" ? body.name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, TOKEN_NAME_MAX) : "";
    if (!name) return "令牌要有个名字，比如 NAS、Grafana、家人网页 —— 收到的通知上会写「来自：这个名字」";
    input.name = name;
  }
  if ("max_level" in body) {
    const raw = body.max_level;
    if (raw === null || raw === "" || raw === "critical") input.maxLevel = null;
    else {
      const level = typeof raw === "string" ? TOKEN_LEVELS.get(raw.toLowerCase()) : undefined;
      if (!level) return "max_level 只能是 passive、active、timeSensitive；不限就给 null";
      input.maxLevel = level;
    }
  }
  if ("per_minute" in body) {
    const raw = body.per_minute;
    if (raw === null || raw === 0) input.perMinute = null;
    else if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= TOKEN_PER_MINUTE_MAX) {
      input.perMinute = raw;
    } else {
      return `per_minute 应为 1–${TOKEN_PER_MINUTE_MAX} 的整数；不限就给 null（仍受通道每分钟 60 条的限制）`;
    }
  }
  if ("disabled" in body) {
    if (typeof body.disabled !== "boolean") return "disabled 只收 true / false";
    input.disabled = body.disabled;
  }
  return input;
}

function applyInput(token: SendToken, input: TokenInput): void {
  if (input.name !== undefined) token.name = input.name;
  if (input.maxLevel === null) delete token.maxLevel;
  else if (input.maxLevel !== undefined) token.maxLevel = input.maxLevel;
  if (input.perMinute === null) delete token.perMinute;
  else if (input.perMinute !== undefined) token.perMinute = input.perMinute;
  if (input.disabled === true) token.disabled = true;
  else if (input.disabled === false) delete token.disabled;
}

function nameTaken(existing: SendToken[], name: string, except?: string): boolean {
  return existing.some((t) => t.id !== except && t.name === name);
}

/**
 * 新建一个令牌。返回令牌和它的明文 —— 明文只有这一次，之后服务端也拿不出来。
 * 先写令牌、再写清单：清单没写成就把令牌删掉、报错，创建者没拿到明文，也就不会有人用它
 */
export async function createToken(
  env: Env,
  channel: Pick<Channel, "id">,
  input: TokenInput,
  now = Date.now(),
): Promise<{ token: SendToken; value: string } | string> {
  const index = await readIndex(env, channel.id);
  if (index.tokens.length >= MAX_TOKENS_PER_CHANNEL) {
    return `一个通道最多 ${MAX_TOKENS_PER_CHANNEL} 个发送令牌，先删掉不用的再建`;
  }
  const name = input.name ?? "";
  const existing = (await listTokens(env, channel.id)).map((t) => t.token);
  if (nameTaken(existing, name)) return `已经有叫「${name}」的令牌了，换个名字 —— 通知上要靠它分出是谁发的`;

  const value = newTokenValue();
  const hash = await sha256(value);
  const token: SendToken = { id: newId(), channelId: channel.id, name, createdAt: now, hint: value.slice(-4) };
  applyInput(token, input);
  await putToken(env, hash, token);
  try {
    index.tokens.push({ id: token.id, hash });
    await writeIndex(env, channel.id, index, now);
  } catch (err) {
    await env.PIGEON_KV.delete(TOKEN + hash).catch(() => {});
    throw err;
  }
  return { token, value };
}

/** 改名、改限制、停用或恢复。没有这个令牌返回 null */
export async function updateToken(
  env: Env,
  channel: Pick<Channel, "id">,
  tokenId: string,
  input: TokenInput,
): Promise<SendToken | string | null> {
  const index = await readIndex(env, channel.id);
  const entry = index.tokens.find((t) => t.id === tokenId);
  if (!entry) return null;
  const token = await readToken(env, entry.hash);
  if (!token || token.id !== tokenId) return null;
  if (input.name !== undefined && input.name !== token.name) {
    const existing = (await listTokens(env, channel.id)).map((t) => t.token);
    if (nameTaken(existing, input.name, token.id)) return `已经有叫「${input.name}」的令牌了，换个名字`;
  }
  applyInput(token, input);
  await putToken(env, entry.hash, token);
  return token;
}

/**
 * 删掉一个令牌：立即不能再推，并留 30 天墓碑 —— 还在用它的来源收到 410「地址已停用」，而不是「不存在」。
 * 先删令牌再立墓碑、改清单：删到一半失败，至少它已经推不进来了
 */
export async function deleteToken(
  env: Env,
  channel: Pick<Channel, "id">,
  tokenId: string,
  now = Date.now(),
): Promise<boolean> {
  const index = await readIndex(env, channel.id);
  const entry = index.tokens.find((t) => t.id === tokenId);
  if (!entry) return false;
  const token = await readToken(env, entry.hash);
  await env.PIGEON_KV.delete(TOKEN + entry.hash);
  const until = await retire(env, channel.id, entry.hash, "token", token?.name, now);
  index.tokens = index.tokens.filter((t) => t.id !== tokenId);
  index.retired = [...(index.retired ?? []), { hash: entry.hash, until }];
  await writeIndex(env, channel.id, index, now);
  await env.PIGEON_KV.delete(TOKEN_USE + tokenId).catch(() => {});
  return true;
}

/**
 * 通道删掉了：它的令牌、用量、换下来的地址的墓碑一并删掉。通道都没了，墓碑也不必再替它说「地址已停用」。
 * 逐个删、出错不抛：删不掉的令牌指向一个不存在的通道，推送时当它不存在（见 resolveSender）
 */
export async function forgetTokens(env: Env, channelId: string): Promise<void> {
  const index = await readIndex(env, channelId);
  const keys = [
    ...index.tokens.flatMap((t) => [TOKEN + t.hash, TOKEN_USE + t.id]),
    ...(index.retired ?? []).map((r) => RETIRED + r.hash),
  ];
  for (const key of keys) await env.PIGEON_KV.delete(key).catch(() => {});
  await env.PIGEON_KV.delete(TOKEN_INDEX + channelId);
}

// ── 换下来的地址 ────────────────────────────────────────────────────

async function retire(
  env: Env,
  channelId: string,
  hash: string,
  kind: RetiredRecord["kind"],
  name: string | undefined,
  now: number,
): Promise<number> {
  const until = now + RETIRED_TTL_SECONDS * 1000;
  const record: RetiredRecord = { channelId, kind, ...(name ? { name } : {}), at: now, until };
  await env.PIGEON_KV.put(RETIRED + hash, JSON.stringify(record), { expirationTtl: RETIRED_TTL_SECONDS });
  return until;
}

/**
 * 换了推送地址：旧地址留 30 天墓碑。在 db.ts rotateKey 之后调用 —— 旧指针已经删了，这里只负责
 * 「再有人用旧地址时说清楚发生了什么」。立不成不影响换地址本身：旧地址照样推不进来，只是回的是 404
 */
export async function retireKey(env: Env, channel: Pick<Channel, "id">, oldKey: string, now = Date.now()): Promise<void> {
  const hash = await sha256(oldKey);
  const until = await retire(env, channel.id, hash, "key", undefined, now);
  const index = await readIndex(env, channel.id);
  index.retired = [...(index.retired ?? []).filter((r) => r.hash !== hash), { hash, until }];
  await writeIndex(env, channel.id, index, now);
}

function parseRetired(raw: unknown): RetiredRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<RetiredRecord>;
  if (typeof r.channelId !== "string" || typeof r.until !== "number" || typeof r.at !== "number") return null;
  return {
    channelId: r.channelId,
    kind: r.kind === "token" ? "token" : "key",
    ...(typeof r.name === "string" ? { name: r.name } : {}),
    at: r.at,
    until: r.until,
    ...(typeof r.noticedAt === "number" ? { noticedAt: r.noticedAt } : {}),
  };
}

async function readRetired(env: Env, key: string, now: number): Promise<RetiredRecord | null> {
  try {
    const record = parseRetired(await env.PIGEON_KV.get(key, "json"));
    return record && record.until > now ? record : null;
  } catch {
    return null;
  }
}

/** 这是不是一个换掉、删掉的地址。只查不提醒 —— 给网页用：有人打开链接看一眼，不算「还在用」 */
export async function isRetired(env: Env, credential: string, now = Date.now()): Promise<boolean> {
  if (!isValidId(credential)) return false;
  return (await readRetired(env, RETIRED + (await sha256(credential)), now)) !== null;
}

export const RETIRED_KEY_MESSAGE = "地址已停用：请到 App 里复制新地址";
export const RETIRED_TOKEN_MESSAGE = "地址已停用：这个发送令牌已被通道的创建者删除，请向他要新的地址";

/**
 * 查不到这个 key 或令牌时再问一句：是不是换掉、删掉的？是就返回 410 该说的话，并按需提醒创建者；不是返回 null。
 * 只在查不到时才走到这里，正常推送一次也不多读。via：从哪个入口来的（写进给创建者的提醒里）
 */
export async function retiredMessage(
  env: Env,
  credential: string,
  request: Request,
  via: string,
  now = Date.now(),
): Promise<string | null> {
  if (!isValidId(credential)) return null;
  const key = RETIRED + (await sha256(credential));
  const record = await readRetired(env, key, now);
  if (!record) return null;
  try {
    await noticeRetiredUse(env, key, record, sourceOf(request, via), now);
  } catch {
    // 提醒发不出去，410 照回
  }
  return record.kind === "token" ? RETIRED_TOKEN_MESSAGE : RETIRED_KEY_MESSAGE;
}

/**
 * 请求从哪来的：入口加上 User-Agent 的第一段（curl/8.4.0、Grafana/10.2.0、Go-http-client/1.1……）。
 * 创建者凭它找出是哪个脚本、哪个服务还没换地址。只进给创建者的这一条提醒，不落盘
 */
function sourceOf(request: Request, via: string): string {
  const first = (request.headers.get("user-agent") ?? "").trim().split(/\s+/)[0] ?? "";
  const product = first.replace(/[^\w./+-]/g, "").slice(0, 40);
  return product ? `${via}，${product}` : via;
}

/**
 * 告诉创建者：换掉的地址（删掉的令牌）还有人在用。一天最多一次 —— 先记下这次提醒的时刻再推，记不下就不推：
 * 宁可少提醒一次，也不能每一条被拒的推送都去吵他。静默送达：这是件该去处理、但不急的事
 */
async function noticeRetiredUse(
  env: Env,
  key: string,
  record: RetiredRecord,
  source: string,
  now: number,
): Promise<void> {
  if (record.noticedAt !== undefined && now - record.noticedAt < RETIRED_NOTICE_INTERVAL_MS) return;
  const ttl = Math.max(60, Math.ceil((record.until - now) / 1000));
  await env.PIGEON_KV.put(key, JSON.stringify({ ...record, noticedAt: now }), { expirationTtl: ttl });

  const channel = await getChannel(env, record.channelId);
  if (!channel) return;
  const owner = await getAccount(env, channel.ownerId);
  if (!owner || owner.devices.length === 0) return;
  const params: PushParams =
    record.kind === "token"
      ? {
          title: "删掉的发送令牌还有人在用",
          body: `「${channel.name}」删掉的发送令牌「${record.name ?? "未命名"}」又收到了推送，已拒收。来源：${source}。那边还要发的话，新建一个令牌换上去。这个提醒一天最多一次`,
        }
      : {
          title: "旧地址还有人在用",
          body: `「${channel.name}」换地址之前的旧地址又收到了推送，已拒收。来源：${source}。把那边的地址换成 App 里的新地址。这个提醒一天最多一次`,
        };
  params.level = "passive";
  params.id = newId();
  const payload = buildPayload(params, env.APNS_CATEGORY || "pigeonNotification", { id: channel.id, name: channel.name });
  payload.sent_at = now;
  const headers = pushHeaders(params);
  await Promise.all(owner.devices.map((device) => pushToDevice(env, device, payload, headers)));
}

// ── 推送入口 ────────────────────────────────────────────────────────

/** 推送地址背后是谁：通道、接收者，用令牌推的还有令牌本身 */
export interface Sender {
  channel: Channel;
  recipients: Account[];
  token?: SendToken;
}

/**
 * 推送入口认凭据：像令牌的先查令牌，其余照旧按 key 查（db.ts resolveChannel）。
 * 格式像令牌却查不到的，再按 key 查一遍 —— 万一哪个早年的 key 恰好长这样，也不至于从此推不进来。
 * 停用的令牌照样返回（不读接收者），由 senderRefusal 回 403 说清楚，而不是一句「不存在」
 */
export async function resolveSender(env: Env, credential: string): Promise<Sender | null> {
  if (isTokenFormat(credential)) {
    const token = await readToken(env, await sha256(credential));
    if (token) {
      const channel = await getChannel(env, token.channelId);
      // 通道删掉了、令牌还没清干净：当它不存在
      if (!channel) return null;
      return { channel, recipients: token.disabled ? [] : await recipientsOf(env, channel), token };
    }
  }
  return resolveChannel(env, credential);
}

export const TOKEN_DISABLED_MESSAGE = "这个发送地址已被通道的创建者停用，推不进来了。要恢复，请找他在 App 里重新启用";

/**
 * 令牌自己的关卡：停用了回 403，超了每分钟上限回 429。放行时记一笔用量。用 key 推的不经过这里。
 * 放在通道限流之前：一个吵闹的令牌自己先被拦下，不占通道每分钟 60 条的额度，别的来源照常推得进来
 */
export async function senderRefusal(
  env: Env,
  sender: Sender,
  now = Date.now(),
): Promise<{ status: 403 | 429; message: string } | null> {
  const token = sender.token;
  if (!token) return null;
  if (token.disabled) return { status: 403, message: TOKEN_DISABLED_MESSAGE };
  if (!(await allowTokenPush(env, token, now))) {
    return {
      status: 429,
      message: `推送太频繁：发送令牌「${token.name}」每分钟最多 ${token.perMinute} 条，请一分钟后再试`,
    };
  }
  try {
    await noteTokenUse(env, token, now);
  } catch {
    // 用量记漏一笔无所谓
  }
  return null;
}

/**
 * 按令牌的限制收一收这条消息：级别高于上限的按上限送；上限在「普通」及以下的，不能要求重复提醒 ——
 * 重复提醒是「一直吵到有人处理」，给家里人网页链接设成「最多普通」，就是不想被它吵。
 * 照限制改了什么都写进 warnings，发送方知道这条和他要的不一样
 */
export function limitToToken(params: PushParams, token?: SendToken): { params: PushParams; warnings: string[] } {
  if (!token?.maxLevel) return { params, warnings: [] };
  const cap = token.maxLevel;
  const label = LEVEL_LABELS[cap];
  const limited: PushParams = { ...params };
  const warnings: string[] = [];
  if (levelRank(params.level) > levelRank(cap)) {
    limited.level = cap;
    warnings.push(`发送令牌「${token.name}」最高只能发「${label}」，这条按「${label}」送达`);
  }
  if (levelRank(cap) < levelRank("timeSensitive") && repeatMinutes(limited.repeat) > 0) {
    delete limited.repeat;
    warnings.push(`发送令牌「${token.name}」最高只到「${label}」，不能要求重复提醒，这条只推一次`);
  }
  return { params: limited, warnings };
}

// ── 消息 id 的作用域 ────────────────────────────────────────────────

/**
 * 令牌推的消息 id 前面加的前缀：~ + 令牌 id 的前 8 位 + ~。令牌 id 是随机的 base64url，不含 ~。
 *
 * 为什么要有：消息 id 是推送方自己起的（db-01、deploy-42 这种，文档也这么教），同一个 id 的新一版会替换旧的、
 * 停掉它的重复提醒，status=resolved、delete=1 还了结认领、收起实时活动，带 callback 的会改掉回调地址，
 * 回执也按 id 查。不分来源的话，一个「只能推送」的令牌（给家人网页、NAS 的那种）拿着猜得到的 id，
 * 就能替换、撤回、了结群主或别的来源的消息，劫走回调、读别人的回执（谁认领、回了什么）。
 * 加上前缀，各个令牌的 id 落在各自的地盘里，互相碰不着；推送 key 是创建者的，不加前缀，哪条都管得了。
 * 怎么加见 push.ts scopedMessageId
 */
export function tokenIdScope(token?: Pick<SendToken, "id">): string | undefined {
  return token ? `~${token.id.slice(0, 8)}~` : undefined;
}

/** 用令牌推的，deliver 要带上的两样：通知上的「来自」和 id 的前缀。用 key 推的两样都没有 */
export function senderOptions(token?: SendToken): { from?: string; idScope?: string } {
  return token ? { from: token.name, idScope: tokenIdScope(token) } : {};
}

// ── 每分钟上限 ──────────────────────────────────────────────────────

/** 各令牌下一次从哪个格子试起。按实例记，只是为了少试几次 —— 不准也不影响对错 */
const nextSlot = new Map<string, number>();
/** 各令牌格子全满到什么时候：这段时间里直接拒，不再挨个去试 */
const fullUntil = new Map<string, number>();
/** 满了之后多久内不再试 */
const FULL_BACKOFF_MS = 5_000;

/**
 * 令牌的每分钟上限。Workers 的限流绑定每个绑定只有一个固定的上限，令牌的上限却是创建者自己定的 ——
 * 所以用一个「每个键一分钟只放一次」的绑定（RL_TOKEN），给上限是 N 的令牌 N 个格子，轮着用，N 个都用过了就拒。
 * 不用 KV 计数：同一个键每秒最多写一次，一阵连发根本数不过来，还每条推送都多一次写入。
 * 和别的限流一样是各节点各自的近似值；绑定缺失（本地单元测试、自建环境没配）时放行
 */
async function allowTokenPush(env: Env, token: SendToken, now: number): Promise<boolean> {
  const limit = token.perMinute;
  if (!limit || !env.RL_TOKEN) return true;
  if ((fullUntil.get(token.id) ?? 0) > now) return false;
  const start = nextSlot.get(token.id) ?? 0;
  for (let i = 0; i < limit; i++) {
    const slot = (start + i) % limit;
    if (await allow(env.RL_TOKEN, `stok:${token.id}:${slot}`)) {
      nextSlot.set(token.id, (slot + 1) % limit);
      return true;
    }
  }
  // 两张表只增不减：一个实例见过的令牌本来就不多，涨到上限就整个清掉重来
  if (fullUntil.size > 1000) fullUntil.clear();
  if (nextSlot.size > 1000) nextSlot.clear();
  fullUntil.set(token.id, now + FULL_BACKOFF_MS);
  return false;
}

// ── 用量 ────────────────────────────────────────────────────────────

/** 同 db.ts 的推送统计：攒在内存里，每个令牌最多每 60 秒落一次盘 */
const USE_FLUSH_MS = 60_000;
const unflushedUses = new Map<string, number>();
const usesFlushedAt = new WeakMap<object, Map<string, number>>();

export async function readUse(env: Env, tokenId: string): Promise<TokenUse | null> {
  try {
    const raw = await env.PIGEON_KV.get<Partial<TokenUse>>(TOKEN_USE + tokenId, "json");
    if (!raw || typeof raw.count !== "number" || typeof raw.lastUsedAt !== "number") return null;
    return { count: raw.count, lastUsedAt: raw.lastUsedAt };
  } catch {
    return null;
  }
}

async function noteTokenUse(env: Env, token: SendToken, now: number): Promise<void> {
  unflushedUses.set(token.id, (unflushedUses.get(token.id) ?? 0) + 1);
  let mine = usesFlushedAt.get(env.PIGEON_KV);
  if (!mine) usesFlushedAt.set(env.PIGEON_KV, (mine = new Map()));
  const last = mine.get(token.id);
  if (last !== undefined && now - last < USE_FLUSH_MS) return;
  const stored = await readUse(env, token.id);
  // 别的实例一分钟内刚写过：这几条先攒着，下次再一起写
  if (stored && now - stored.lastUsedAt < USE_FLUSH_MS) return;
  const pending = unflushedUses.get(token.id) ?? 0;
  if (pending === 0) return;
  unflushedUses.delete(token.id);
  mine.set(token.id, now);
  const next: TokenUse = { count: (stored?.count ?? 0) + pending, lastUsedAt: now };
  try {
    await env.PIGEON_KV.put(TOKEN_USE + token.id, JSON.stringify(next));
  } catch (err) {
    unflushedUses.set(token.id, (unflushedUses.get(token.id) ?? 0) + pending);
    mine.delete(token.id);
    throw err;
  }
}

/** 给创建者看的样子。令牌明文从不出现在这里 */
export function tokenView(token: SendToken, use: TokenUse | null) {
  return {
    id: token.id,
    name: token.name,
    hint: token.hint,
    ...(token.maxLevel ? { max_level: token.maxLevel } : {}),
    ...(token.perMinute ? { per_minute: token.perMinute } : {}),
    disabled: Boolean(token.disabled),
    created_at: token.createdAt,
    count: use?.count ?? 0,
    ...(use ? { last_used_at: use.lastUsedAt } : {}),
  };
}

/** 给 /s/{令牌} 网页用：查令牌和通道，不读接收者 */
export async function lookupToken(
  env: Env,
  value: string,
): Promise<{ token: SendToken; channel: Channel } | null> {
  if (!isTokenFormat(value)) return null;
  const token = await readToken(env, await sha256(value));
  if (!token) return null;
  const channel = await getChannel(env, token.channelId);
  return channel ? { token, channel } : null;
}
