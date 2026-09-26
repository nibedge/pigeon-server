import { isDeadToken, pushToDevice, type ApnsHeaders } from "./apns";
import { readBody } from "./body";
import { getChannel, isAcked, isMuted, newId, recipientsOf, recordPushOutcome } from "./db";
import { applyPolicy, applyQuietHours, isQuietNow } from "./policy";
import { allow } from "./ratelimit";
import type { Account, Channel, Device, Env, PushParams, PushResult, RepeatRecord } from "./types";

/** 所有认识的推送参数名。既用于从 query / body 里挑字段，也是通道默认值的白名单 */
export const PARAM_KEYS = [
  "title", "subtitle", "body", "level", "volume", "badge", "call",
  "autoCopy", "copy", "sound", "icon", "group", "ciphertext", "iv",
  "isArchive", "ttl", "url", "image", "markdown", "action", "id", "delete",
  "tags", "status", "repeat",
] as const;

/**
 * 参数别名。
 *
 * 同一个含义历史上有多种写法（全小写、驼峰），这里统一收敛，
 * 让从别处迁过来的脚本不必逐个改写。别名只影响入参解析，
 * 不构成对外承诺 —— 规范写法以 README 的参数表为准。
 */
const ALIASES: Record<string, string> = {
  autocopy: "autoCopy",
  isarchive: "isArchive",
  device_key: "__ignored",
  device_keys: "__ignored",
};

function normalizeName(raw: string): string | null {
  const alias = ALIASES[raw];
  if (alias) return alias === "__ignored" ? null : alias;
  const hit = PARAM_KEYS.find((k) => k.toLowerCase() === raw.toLowerCase());
  return hit ?? null;
}

/**
 * 正文、副标题的常见别名。许多现成服务和脚本的 webhook 用 text、content、message、msg、
 * desp、description 装正文，用 summary 装摘要。原先只认 body：推送只剩标题，正文静默丢失，
 * 发送方毫无察觉 —— 实测一条 {"title", "text"} 的推送就这样只显示了标题。
 *
 * 这是「软别名」：同一份来源里已经有正式字段时以正式字段为准，与字段先后无关；
 * 几个别名同时出现时取先写的那个。
 * 只收字符串和数字：有的服务把整个对象塞在 message 里，转成字符串只会得到 [object Object]。
 */
const SOFT_ALIASES: Record<string, "body" | "subtitle"> = {
  text: "body",
  message: "body",
  content: "body",
  msg: "body",
  desp: "body",
  description: "body",
  summary: "subtitle",
};

/**
 * 开关类参数。App 只认 "1" / "0"：原先 isArchive=false 照样存进历史（App 看的是「不等于 0」），
 * autoCopy=true 不生效（App 看的是「等于 1」）。true / yes / on 统一成 "1"，false / no / off 统一成 "0"
 */
const SWITCH_PARAMS = new Set<string>(["autoCopy", "isArchive", "call", "delete"]);
const SWITCH_VALUES: Record<string, string> = {
  "1": "1", true: "1", yes: "1", on: "1",
  "0": "0", false: "0", no: "0", off: "0",
};

export function normalizeSwitch(value: string): string {
  return SWITCH_VALUES[value.trim().toLowerCase()] ?? value;
}

/**
 * 参数值只收字符串、数字和布尔 —— 对象、数组转成字符串只会得到 [object Object]、「a,b」这种东西，
 * 表单里的文件也一样。tags 例外：["warning", "prod"] 这种写法很自然，按逗号连起来。
 */
function scalar(name: string, raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number") return Number.isFinite(raw) ? String(raw) : null;
  if (typeof raw === "boolean") return String(raw);
  if (name === "tags" && Array.isArray(raw) && raw.every((t) => typeof t === "string" || typeof t === "number")) {
    return raw.join(",");
  }
  return null;
}

/** 把一份来源（query、表单、JSON）里认得的参数收进 into，返回认出了几个 */
function absorb(into: PushParams, source: Iterable<[string, unknown]>): number {
  const soft: Partial<Record<"body" | "subtitle", string>> = {};
  let recognised = 0;
  for (const [rawName, rawValue] of source) {
    if (rawValue === null || rawValue === undefined) continue;
    const alias = SOFT_ALIASES[rawName.toLowerCase()];
    if (alias) {
      if (typeof rawValue === "string" || typeof rawValue === "number") {
        const value = String(rawValue);
        if (value !== "") {
          soft[alias] ??= value;
          recognised += 1;
        }
      }
      continue;
    }
    const name = normalizeName(rawName);
    if (!name) continue;
    const value = scalar(name, rawValue);
    if (value === null || value === "") continue;
    (into as Record<string, string>)[name] = SWITCH_PARAMS.has(name) ? normalizeSwitch(value) : value;
    recognised += 1;
  }
  // 整份来源读完才落软别名：body 写在前还是写在后，都是 body 赢
  if (!into.body && soft.body) into.body = soft.body;
  if (!into.subtitle && soft.subtitle) into.subtitle = soft.subtitle;
  return recognised;
}

/**
 * 只给了 markdown、没给 body：markdown 就是正文。App 的正文本来就按 Markdown 显示，
 * 而单独的 markdown 字段 App 并不显示 —— 原先这样的推送标题正文全空，被当成「没有内容」拒掉
 */
function promoteMarkdown(params: PushParams): PushParams {
  if (!params.body && params.markdown) {
    params.body = params.markdown;
    delete params.markdown;
  }
  return params;
}

/** 有没有可推的内容。端到端加密的消息只有密文、没有明文标题正文，也是一条合法的消息 */
export function hasContent(params: PushParams): boolean {
  return Boolean(params.title || params.subtitle || params.body || params.ciphertext);
}

/** 通道默认值垫底，这次请求带来的覆盖在上面 */
export function withDefaults(channel: Pick<Channel, "defaults">, own: PushParams): PushParams {
  return promoteMarkdown({ ...(channel.defaults ?? {}), ...own });
}

/** POST /push 的 JSON 请求体 → 推送参数。和路径式推送同一套别名、开关和 markdown 规则 */
export function paramsFromJson(payload: Record<string, unknown>): PushParams {
  const params: PushParams = {};
  absorb(params, Object.entries(payload));
  return promoteMarkdown(params);
}

// ── 请求头 ──────────────────────────────────────────────────────────

/**
 * 通用请求头：`curl -H "Title: 磁盘告警" -H "Priority: 4" -d "剩余 3%" …` 这种写法，
 * 正文放请求体、其余放头里，不必拼 JSON。只认这几个，别的头一概不看。
 */
const HEADER_PARAMS: [string, keyof PushParams][] = [
  ["title", "title"],
  ["priority", "level"],
  ["tags", "tags"],
  ["click", "url"],
  ["id", "id"],
];

/**
 * Priority 头：1–5 或 min / low / default / high / max / urgent，也可以直接写级别名。
 * 最高一档只到 timeSensitive：critical 会穿透每个接收者自己设的免打扰，不该由一个通用的头触发。
 * 认不出的值（比如浏览器按 HTTP 规范自己带的 `u=1, i`）当没写。
 */
const PRIORITY_LEVELS: Record<string, string> = {
  "1": "passive", min: "passive",
  "2": "passive", low: "passive",
  "3": "active", default: "active", normal: "active",
  "4": "timeSensitive", high: "timeSensitive",
  "5": "timeSensitive", max: "timeSensitive", urgent: "timeSensitive",
};

function priorityLevel(value: string): string | undefined {
  const v = value.trim().toLowerCase();
  if (PRIORITY_LEVELS[v]) return PRIORITY_LEVELS[v];
  return interruptionLevel(v) ? value.trim() : undefined;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/**
 * 请求头里的中文。HTTP 头按规范只有 ASCII：curl 把 UTF-8 原样发出来，到这里每个字节成了一个
 * Latin-1 字符（一个汉字成了三个乱码字符），按字节还原回 UTF-8；也认邮件式的 =?UTF-8?B?…?= / =?UTF-8?Q?…?=。
 * 还原不了的原样返回。
 */
export function decodeHeaderValue(raw: string): string {
  const value = raw.trim();
  const encoded = /^=\?utf-8\?([bq])\?(.*)\?=$/i.exec(value);
  if (encoded) {
    try {
      const [, kind = "", text = ""] = encoded;
      const binary =
        kind.toLowerCase() === "b"
          ? atob(text)
          : text.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
      return strictUtf8.decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
    } catch {
      return value;
    }
  }
  if (/[\u0080-\u00ff]/.test(value) && !/[^\u0000-\u00ff]/.test(value)) {
    try {
      return strictUtf8.decode(Uint8Array.from(value, (c) => c.charCodeAt(0)));
    } catch {
      return value;
    }
  }
  return value;
}

export function headerParams(headers: Headers): PushParams {
  const params: PushParams = {};
  for (const [header, name] of HEADER_PARAMS) {
    const raw = headers.get(header);
    if (!raw) continue;
    const value = name === "level" ? priorityLevel(raw) : decodeHeaderValue(raw);
    if (value) params[name] = value;
  }
  return params;
}

// ── 请求体 ──────────────────────────────────────────────────────────

const NOT_JSON = "请求体不是合法的 JSON，已忽略";
const UNRECOGNISED = "请求体里没有认得的字段，已忽略：正文请放在 body（或 text、message）里，或者直接发纯文字";

interface ParsedBody {
  params: PushParams;
  /** 请求体不为空，却什么也没认出来 */
  warning?: string;
}

function formDecode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, "%20"));
  } catch {
    return text;
  }
}

/** 一个 JSON 对象（不是数组）。纯文字请求体里偶尔装的是 JSON，要先认一下 */
function jsonObject(text: string): Record<string, unknown> | null {
  if (!text.trimStart().startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 请求体 → 参数。
 *
 * 认不出字段时不再静默丢掉：发它的往往是一行 shell，`curl -d "磁盘满了"` 默认按表单编码发出，
 * 整句话被当成一个没有值的字段名，按表单解析就只剩空白 —— 推出去只有标题，或者干脆 400。
 * 所以纯文字（text/*、没写类型）和「字段全都没有值的表单」都把原文当正文，
 * 思路同心跳的失败说明（routes/heartbeat.ts）。
 */
async function parseBody(raw: Uint8Array, contentType: string): Promise<ParsedBody> {
  const text = new TextDecoder().decode(raw);
  if (text.trim() === "") return { params: {} };
  const type = contentType.toLowerCase();
  const params: PushParams = {};
  let rawText: string | null = null;
  let recognised = 0;

  if (type.includes("json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // 声称是 JSON 却解析不了：像 JSON 的（花括号开头）多半是写坏了，推出去只会是一坨乱码；
      // 不像的是 `-H 'content-type: application/json' -d "磁盘满了"`，当纯文字
      if (/^\s*[[{]/.test(text)) return { params, warning: NOT_JSON };
      parsed = text;
    }
    if (typeof parsed === "string" || typeof parsed === "number") rawText = String(parsed);
    else if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) recognised = absorb(params, Object.entries(parsed));
  } else if (type.includes("form-urlencoded")) {
    const form = [...new URLSearchParams(text).entries()];
    // 没有一个字段有值、也没有等号：这不是表单，是一句话（里面带 & 的会被拆成好几个「字段」）
    if (!text.includes("=") && form.every(([, value]) => value === "")) {
      // 原文用了百分号编码（--data-urlencode）就解码；没编码的取原文 —— 表单解码会把 + 变成空格
      rawText = /%[0-9a-f]{2}/i.test(text) ? formDecode(text) : text;
    } else {
      recognised = absorb(params, form);
    }
  } else if (type.includes("multipart/form-data")) {
    try {
      const form = await new Response(raw, { headers: { "content-type": contentType } }).formData();
      recognised = absorb(params, [...form.entries()] as [string, unknown][]);
    } catch {
      // 多部分表单坏了：当没认出来
    }
  } else if (type === "" || type.startsWith("text/")) {
    // fetch() 直接传字符串时类型是 text/plain，里面装的常常是 JSON
    const object = jsonObject(text);
    if (object) recognised = absorb(params, Object.entries(object));
    else rawText = text;
  }

  if (rawText !== null) {
    const body = rawText.trimEnd();
    if (body) {
      params.body = body;
      return { params };
    }
  }
  return recognised > 0 ? { params } : { params, warning: UNRECOGNISED };
}

// ── 收集一次推送的参数 ──────────────────────────────────────────────

export interface CollectedRequest {
  /** 通道默认值 + 这次请求带来的，推送用它 */
  params: PushParams;
  /** 只有这次请求自己带来的。只收加密、不生效的参数都只看它 —— 默认值是创建者自己设的 */
  own: PushParams;
  /** 给发送方的中文提示：请求体没认出来之类 */
  warnings: string[];
}

/**
 * 收集一次推送的参数，后面的覆盖前面的：
 *   通道默认值 → query string → 请求头（Title、Priority…）→ 请求体 → URL 路径段
 *
 * 路径段优先级最高，因为 `/{key}/标题/内容` 是最显式的写法。
 * 请求体超过 64 KB 抛 BodyTooLarge（见 body.ts），由入口回 413。
 */
export async function collectRequest(
  request: Request,
  url: URL,
  pathText: string[],
  channel: Pick<Channel, "defaults">,
): Promise<CollectedRequest> {
  const warnings: string[] = [];
  const fromQuery: PushParams = {};
  absorb(fromQuery, url.searchParams.entries());
  const fromHeaders = headerParams(request.headers);

  let fromBody: PushParams = {};
  if (request.method !== "GET" && request.method !== "HEAD") {
    // 先按上限把原文读下来，再按类型解析：request.json() / formData() 不看大小，
    // 几十 MB 的请求体会被整个收进内存
    const parsed = await parseBody(await readBody(request), request.headers.get("content-type") ?? "");
    fromBody = parsed.params;
    if (parsed.warning) warnings.push(parsed.warning);
  }

  // 路径段：/{key}/body · /{key}/title/body · /{key}/title/subtitle/body
  const fromPath: PushParams = {};
  const [a, b, c] = pathText;
  if (pathText.length === 1 && a) {
    fromPath.body = a;
  } else if (pathText.length === 2 && a && b) {
    fromPath.title = a;
    fromPath.body = b;
  } else if (pathText.length >= 3 && a && b && c) {
    fromPath.title = a;
    fromPath.subtitle = b;
    fromPath.body = c;
  }

  const own = promoteMarkdown({ ...fromQuery, ...fromHeaders, ...fromBody, ...fromPath });
  return { params: withDefaults(channel, own), own, warnings };
}

/** 只要参数的简便写法（测试和旧调用方用） */
export async function collectParams(
  request: Request,
  url: URL,
  pathText: string[],
  channel: Pick<Channel, "defaults">,
): Promise<PushParams> {
  return (await collectRequest(request, url, pathText, channel)).params;
}

// ── payload ─────────────────────────────────────────────────────────

/** 推送携带的通道身份。只放公开的 id 和名称，绝不放 key —— payload 会落到每个成员手机上 */
export interface Origin {
  id: string;
  name: string;
}

const INTERRUPTION_LEVELS: Record<string, string> = {
  passive: "passive",
  active: "active",
  timesensitive: "time-sensitive",
  "time-sensitive": "time-sensitive",
  // 真正的 critical 需要 Apple 单独审批的 critical-alerts 权限，拿到之前系统不认。
  // 在那之前按 time-sensitive 送 —— 这是实际能做到的最强级别，不承诺做不到的。
  critical: "time-sensitive",
};

/**
 * level → APNs 的 interruption-level。
 *
 * 这一步曾经整个漏掉：level 只被当成普通字段塞进 payload 顶层，而系统只看
 * aps 里的 interruption-level —— 于是 passive 照样亮屏弹横幅，免打扰的
 * 「降级」只去掉了声音。没有任何报错，只有半夜被横幅照醒的人知道。
 */
export function interruptionLevel(level?: string): string | undefined {
  return level ? INTERRUPTION_LEVELS[level.toLowerCase()] : undefined;
}

/**
 * 铃声。APNs 的规矩是 aps 里没有 sound 就**不出声** —— 不指定铃声的推送原先
 * 全是静音的，和 App 里「留空为系统默认」的说法对不上。
 *
 * passive 不补默认铃声：它本来就不该出声，免打扰降级也正是靠去掉铃声来压低。
 * 发送方可以用 sound=none 显式静音。
 */
function soundFor(params: PushParams): string | undefined {
  if (params.sound === "none") return undefined;
  if (params.sound) return params.sound;
  return interruptionLevel(params.level) === "passive" ? undefined : "default";
}

/**
 * 组装 APNs payload。
 *
 * 顶层扩展字段（icon / url / copy …）不放在 aps 里，是因为 aps 是 Apple 保留的
 * 命名空间，自定义键必须与它平级；App 的 Notification Service Extension 从顶层读。
 * 反过来，系统要认的东西（级别、铃声、角标）必须进 aps，放在顶层等于没写。
 */
export function buildPayload(
  params: PushParams,
  category: string,
  origin?: Origin,
): Record<string, unknown> {
  if (params.delete === "1") {
    return {
      aps: { "content-available": 1, "mutable-content": 1 },
      id: params.id,
      delete: params.delete,
    };
  }

  const hasText = Boolean(params.title || params.subtitle || params.body);
  // 端到端加密的消息，服务端手里只有密文。系统先显示占位文字，真正的标题和正文由
  // App 的通知扩展解密后替换 —— 这台设备没有密钥、解不开时，用户看到的就是这一句
  const alert =
    params.ciphertext && !hasText
      ? { title: origin?.name ?? "信鸽", body: "🔒 加密消息" }
      : { title: params.title, subtitle: params.subtitle, body: hasText ? params.body : "Empty Message" };
  const aps: Record<string, unknown> = {
    alert,
    sound: soundFor(params),
    // 没指定分组时按通道归组：通知中心里同一个通道的消息叠在一起，
    // 不同来源的告警不会混成一长串
    "thread-id": params.group ?? origin?.id,
    // iOS 里 UNNotificationCategory 的标识符。操作按钮靠它注册，对不上按钮就不出现
    // （通知本身照常送达，所以很容易漏看）。
    category,
    // 必须为 1，否则 NSE 不会被唤起，图标下载和历史归档都不会发生
    "mutable-content": 1,
  };

  const level = interruptionLevel(params.level);
  if (level) aps["interruption-level"] = level;

  if (params.badge !== undefined) {
    const badge = Number(params.badge);
    if (Number.isInteger(badge) && badge >= 0) aps.badge = badge;
  }

  const payload: Record<string, unknown> = { aps };

  // App 端从 payload 顶层读这些。repeat 到这里已经由 deliver 规整成分钟数
  const ext: (keyof PushParams)[] = [
    "group", "call", "isArchive", "icon", "ciphertext", "iv", "level",
    "volume", "url", "copy", "autoCopy", "action", "image",
    "markdown", "id", "ttl", "repeat",
  ];
  const wireName: Partial<Record<keyof PushParams, string>> = {
    isArchive: "isarchive",
    autoCopy: "autocopy",
  };
  for (const k of ext) {
    const v = params[k];
    if (v !== undefined && v !== "") payload[wireName[k] ?? k] = v;
  }

  const tags = normalizeTags(params.tags);
  if (tags) payload.tags = tags;
  if (params.status === "firing" || params.status === "resolved") payload.status = params.status;

  // App 靠这两个字段把历史按通道归类
  if (origin) {
    payload.channel_id = origin.id;
    payload.channel_name = origin.name;
  }

  return payload;
}

/** 标签：逗号分隔（中英文逗号都认），去重，最多 5 个、每个 24 字以内 —— 照单全收会把通知撑爆 */
export function normalizeTags(raw?: string): string | undefined {
  if (!raw) return undefined;
  const tags = [
    ...new Set(
      raw.split(/[,，]/).map((t) => t.trim()).filter(Boolean).map((t) => t.slice(0, 24)),
    ),
  ].slice(0, 5);
  return tags.length ? tags.join(",") : undefined;
}

export function pushHeaders(params: PushParams): ApnsHeaders {
  const silent = params.delete === "1";
  const headers: ApnsHeaders = {
    "apns-push-type": silent ? "background" : "alert",
    "apns-priority": silent ? "5" : "10",
  };
  // APNs 对 collapse-id 限 64 字节，超了整条推送会被 400 拒掉 —— 宁可不折叠也要送达
  if (params.id && new TextEncoder().encode(params.id).length <= 64) {
    headers["apns-collapse-id"] = params.id;
  }
  return headers;
}

// ── 载荷预算 ────────────────────────────────────────────────────────

/** Apple 对单条普通推送 payload 的硬上限，超了整条回 413 PayloadTooLarge，一台设备都送不到 */
export const APNS_PAYLOAD_LIMIT = 4096;

/**
 * 我们自己按这个预算量（UTF-8 字节，按 JSON.stringify 之后算，转义多出来的也算进去）。
 * 比 4096 少留约 300 字节：截断标记、补发时的 reminder、以后加进 payload 的小字段都从这里出，
 * 不必每加一个字段就回来重算一遍。中文一个字 3 字节，扣掉其它字段，正文大约放得下 1100 字。
 */
export const PAYLOAD_BUDGET = 3800;

/** 截短的文字末尾加上它，让看的人知道后面还有 */
export const TRUNCATION_MARK = "…（已截断）";

/**
 * 超了预算按这个顺序截：先截最不影响理解的。markdown 目前 App 不显示，最先让位；
 * 正文最长、最常超；标题最短、最要紧，放到最后。
 */
const TRUNCATE_ORDER = ["markdown", "body", "copy", "subtitle", "title"] as const;
type TruncatableField = (typeof TRUNCATE_ORDER)[number];

const FIELD_LABELS: Record<TruncatableField, string> = {
  markdown: "markdown",
  body: "正文",
  copy: "复制内容",
  subtitle: "副标题",
  title: "标题",
};

const utf8 = new TextEncoder();

/** payload 发出去时的字节数 —— pushToDevice 也是这样 JSON.stringify 的 */
export function payloadBytes(payload: unknown): number {
  return utf8.encode(JSON.stringify(payload)).length;
}

export interface FittedParams {
  params: PushParams;
  /** 截短了哪些字段，按截的先后；没截是空数组 */
  truncated: TruncatableField[];
  /** 截完之后量出来的字节数。仍大于预算说明截不动（密文、超长链接），只能拒收 */
  bytes: number;
}

/**
 * 把文字字段截到 payload 放得下。
 *
 * 原先不做任何长度控制：`-d body="$(tail -50 app.log)"` 这种最常见的用法整条失败，
 * 群里每台设备都白打一次 APNs，发送方只拿到一句 PayloadTooLarge —— 而超长的往往正是
 * 最需要送到的那条告警。截掉一截送到，远好过一条都不送。
 *
 * measure 给出这组参数最终发出去的字节数（由调用方组装，含 sent_at 等后加的字段）。
 * 每个字段二分找「最多保留几个字还放得下」，按码点截，不会截出半个 emoji。
 */
export function fitPayload(
  params: PushParams,
  measure: (p: PushParams) => number,
  budget = PAYLOAD_BUDGET,
): FittedParams {
  let bytes = measure(params);
  if (bytes <= budget) return { params, truncated: [], bytes };

  const fitted: PushParams = { ...params };
  const truncated: TruncatableField[] = [];
  for (const field of TRUNCATE_ORDER) {
    const text = fitted[field];
    if (!text) continue;
    const chars = Array.from(text);
    const cut = (keep: number) => chars.slice(0, keep).join("").trimEnd() + TRUNCATION_MARK;
    const sizeWith = (value: string) => measure({ ...fitted, [field]: value });

    // 每个字至少 1 字节，保留的字数不会超过预算本身
    let lo = 0;
    let hi = Math.min(chars.length - 1, budget);
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sizeWith(cut(mid)) <= budget) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    // 整个字段只剩标记都放不下：先截成标记，接着截下一个字段。
    // 但字段本来就比标记还短时，换成标记反而更长 —— 那就不动它
    const candidate = cut(Math.max(best, 0));
    const after = sizeWith(candidate);
    if (after >= bytes) continue;
    fitted[field] = candidate;
    truncated.push(field);
    bytes = after;
    if (bytes <= budget) break;
  }
  return { params: fitted, truncated, bytes };
}

/**
 * 认得、但这一版 App 不照办的参数：发送方以为设上了，其实没有任何效果。
 * 响应里列出来（ignored），免得有人对着一个不生效的参数调半天。
 * badge：角标由 App 按未读条数自己算，发送方给的会被覆盖。
 * markdown：App 显示的是 body（本来就按 Markdown 显示）。只给了 markdown 时它会被当成正文（见 promoteMarkdown），
 * 走到这里还在的，是和 body 一起给的那份 —— 不显示。
 */
export const NOOP_PARAMS = ["badge", "call", "volume", "ttl", "action", "markdown"] as const;

/** 这次请求带了哪些不生效的参数。和通道默认值一模一样的不算 —— 那不是这次请求带来的 */
export function ignoredParams(params: PushParams, defaults?: Partial<PushParams>): string[] {
  return NOOP_PARAMS.filter((name) => {
    const value = params[name];
    return value !== undefined && value !== "" && value !== defaults?.[name];
  });
}

/** 截不动、放不下时回给发送方的话。密文和链接截了就坏了，只能请发送方自己缩短 */
function tooLarge(bytes: number, params: PushParams): Rejection {
  const message = params.ciphertext
    ? `内容太长：加密后的推送有 ${bytes} 字节，超过上限 ${PAYLOAD_BUDGET} 字节（Apple 单条推送最多 4KB）。密文没法截短，请缩短正文后重新加密发送`
    : `内容太长：截短文字之后推送仍有 ${bytes} 字节，超过上限 ${PAYLOAD_BUDGET} 字节（Apple 单条推送最多 4KB）。请缩短链接、图片地址、分组或 id`;
  return { status: 413, message, bytes, limit: PAYLOAD_BUDGET };
}

// ── 投递 ────────────────────────────────────────────────────────────

/**
 * 通知的 category，决定长按通知时出现哪些按钮：
 * - 群组带「我来处理」（.group）。重复提醒在群里也用它 —— 有人接手，提醒随之停下
 * - 个人通道的重复提醒带「知道了，别再提醒」（.remind），点它走的是同一个认领接口
 * - 其余不带按钮：一个人的通道不存在「谁来接手」的问题
 */
export function categoryFor(
  env: Pick<Env, "APNS_CATEGORY">,
  channel: Pick<Channel, "memberIds">,
  repeating = false,
): string {
  const base = env.APNS_CATEGORY || "pigeonNotification";
  if (channel.memberIds.length > 0) return `${base}.group`;
  return repeating ? `${base}.remind` : base;
}

interface Target {
  accountId: string;
  device: Device;
}

function targetsOf(recipients: Account[]): Target[] {
  return recipients.flatMap((account) =>
    account.devices.map((device) => ({ accountId: account.id, device })),
  );
}

function originOf(channel: Channel): Origin {
  return { id: channel.id, name: channel.name };
}

/**
 * 按每个人的免打扰分成两拨。免打扰的人照样收到，只是降成静默 —— 和免打扰时段同一个
 * 原则：压低，不丢；消息照常进通知中心和历史。critical 例外：会用到它的场景，正是
 * 免打扰也该被叫醒的时候。
 */
export function partitionByMute(
  recipients: Account[],
  channelId: string,
  level: string | undefined,
  now = Date.now(),
): { loud: Account[]; quiet: Account[] } {
  if ((level ?? "").toLowerCase() === "critical") return { loud: recipients, quiet: [] };
  const loud: Account[] = [];
  const quiet: Account[] = [];
  for (const account of recipients) (isMuted(account, channelId, now) ? quiet : loud).push(account);
  return { loud, quiet };
}

/** 并发推给每台设备，死 token 按各自的账号归堆，交给 recordPushOutcome 分别清理 */
async function fanOut(
  env: Env,
  targets: Target[],
  payload: Record<string, unknown>,
  headers: ApnsHeaders,
): Promise<{ results: PushResult[]; delivered: number; deadByAccount: Map<string, string[]> }> {
  const results = await Promise.all(
    targets.map((t) => pushToDevice(env, t.device, payload, headers)),
  );
  const deadByAccount = new Map<string, string[]>();
  results.forEach((result, i) => {
    const target = targets[i];
    if (!target || !isDeadToken(result)) return;
    const list = deadByAccount.get(target.accountId) ?? [];
    list.push(result.deviceToken);
    deadByAccount.set(target.accountId, list);
  });
  return { results, delivered: results.filter((r) => r.status === 200).length, deadByAccount };
}

/** 推送在发出之前就被拒了（目前只有「截不动、放不下」这一种）。入口按 status 和 message 回给发送方 */
export interface Rejection {
  status: number;
  message: string;
  /** 量出来的 payload 字节数和上限，发送方据此知道要缩短多少 */
  bytes: number;
  limit: number;
}

/**
 * 推给通道的所有接收者：创建者和每个成员名下的每一台设备。
 *
 * 通道决定「这条消息长什么样」（默认铃声、级别、策略），
 * 接收者名单决定「推给谁」。群组就是在后者上多几个人。
 */
export interface DeliveryReport {
  /** 因接收者开了免打扰而静默送达（不响、不亮屏）的设备数 */
  muted?: number;
  results: PushResult[];
  delivered: number;
  /** 被通道的去重窗口压掉了 */
  suppressed?: boolean;
  /** 被免打扰时段降级成 passive 了 */
  quieted?: boolean;
  /** 这条消息的 id。认领要靠它在各人手机上对上号 */
  messageId?: string;
  /** 排上了重复提醒：间隔分钟数、截止时刻（毫秒）、消息 id —— 发送方拿这个 id 推一条 status=resolved 就能提前停下 */
  repeat?: { every: number; until: number; id: string };
  /** 为了塞进 4KB 截短过文字 */
  truncated?: boolean;
  /** 给发送方的中文提示：截短了什么、id 太长当不了折叠标识…… */
  warnings?: string[];
  /** 没有发出去：内容截不动也放不下 */
  rejection?: Rejection;
}

export interface DeliverOptions {
  /** cron 补发重复提醒时给出：这是第几次（≥ 2）。补发绕过去重、不重新排期、不计入推送统计 */
  reminder?: number;
  /** 发出时刻（毫秒）。补发时给原消息的，默认是现在 */
  sentAt?: number;
  /** 补发时给出：原消息截短过（存下来的已是截短后的内容，这里量不出来了） */
  truncated?: boolean;
}

/**
 * 推送响应里各入口共用的几项：这次用的消息 id、不生效的参数、中文提示，截短了再带 truncated。
 * 发送方没给 id 时 id 是服务端生成的 —— 之后要替换、撤回、提前停下重复提醒都靠它。
 */
export function reportFields(report: DeliveryReport, ignored: string[] = []): Record<string, unknown> {
  return {
    ...(report.messageId ? { id: report.messageId } : {}),
    ignored,
    warnings: report.warnings ?? [],
    ...(report.truncated ? { truncated: true } : {}),
  };
}

export async function deliver(
  env: Env,
  channel: Channel,
  recipients: Account[],
  incoming: PushParams,
  options: DeliverOptions = {},
): Promise<DeliveryReport> {
  // 发出时刻：服务端收下这次推送的时刻。送达可能晚得多（手机没信号、APNs 排队），
  // App 拿它和送达时刻对比，才分得清「12:30 出的事」和「14:32 才收到」
  const sentAt = options.sentAt ?? Date.now();
  const requested = repeatEvery(incoming);
  // 同一个 id 的最新一版决定这条消息还提不提醒：恢复了、删掉了、或者新的一版没要求重复，
  // 之前排下的提醒一律作废 —— 否则补发的会是旧内容，把手机上更新过的那条又盖回去。
  // 放在最前面：被去重压掉的「已恢复」、没有可用设备的通道，照样要停
  if (incoming.id && !options.reminder && !requested) await cancelRepeat(env, channel.id, incoming.id);

  const targets = targetsOf(recipients);
  if (targets.length === 0) return { results: [], delivered: 0 };

  // 每条消息都要有 id：同一条通知落在群里不同人的手机上，靠它对上号；
  // 它同时是 apns-collapse-id，之后的「正在处理」才能原地替换掉原通知。
  const messageId = incoming.id || newId();
  const shaped: PushParams = { ...incoming, id: messageId };
  const headers = pushHeaders(shaped);
  // 每次提醒靠 collapse-id 原地替换上一次。id 太长当不了 collapse-id（App 也没法认领它），
  // 再提醒就是在通知中心里摞一串 —— 这种只推这一次
  const every = headers["apns-collapse-id"] ? requested : 0;
  if (every) shaped.repeat = String(every);
  else delete shaped.repeat;
  const category = categoryFor(env, channel, every > 0);
  const origin = originOf(channel);

  const warnings: string[] = [];
  // 原先这里静默：用长 id 要求重复提醒的人拿到 200，却从来收不到提醒
  if (incoming.id && !headers["apns-collapse-id"]) {
    warnings.push(
      requested
        ? "id 超过 64 字节：重复提醒未启用，同 id 的新消息也不会替换旧通知"
        : "id 超过 64 字节：同 id 的新消息不会替换旧通知",
    );
  }

  // 按最终发出去的样子量：免打扰的那一版级别字段不同，两版都量，取大的
  const finish = (payload: Record<string, unknown>): Record<string, unknown> => {
    payload.sent_at = sentAt;
    // 第几次提醒只出现在补发里。它不是推送参数 —— 发送方不能自己冒充「第 5 次提醒」
    if (options.reminder) payload.reminder = String(options.reminder);
    return payload;
  };
  const fitted = fitPayload(shaped, (p) =>
    Math.max(
      payloadBytes(finish(buildPayload(p, category, origin))),
      payloadBytes(finish(buildPayload(applyQuietHours(p), category, origin))),
    ),
  );
  // 截不动还放不下（密文、超长链接）：一台都不推。推出去也是被 APNs 整条拒掉，
  // 还白白让每台设备各打一次。放在去重之前，被拒的内容不会占住去重窗口
  if (fitted.bytes > PAYLOAD_BUDGET) {
    return { results: [], delivered: 0, messageId, warnings, rejection: tooLarge(fitted.bytes, shaped) };
  }
  const truncated = fitted.truncated.length > 0 || Boolean(options.truncated);
  if (fitted.truncated.length > 0) {
    const fields = fitted.truncated.map((f) => FIELD_LABELS[f]).join("、");
    warnings.push(`内容太长，已截短${fields}：单条推送最多 4KB，中文约 1100 字`);
  }

  const outcome = await applyPolicy(env, channel, fitted.params, new Date(), { skipDedupe: Boolean(options.reminder) });
  // 去重压掉的也要记一笔统计 —— 否则用户看到"这个通道很安静"，
  // 实际上它正在疯狂重复，只是被挡住了。
  if (outcome.suppressed) {
    await recordPushOutcome(env, channel.id, new Map(), true);
    // 没发出去的消息没有 id 可言；发送方自己给了的照样回带
    return { results: [], delivered: 0, suppressed: true, messageId: incoming.id, warnings };
  }
  const params = outcome.params;

  const stamp = (payload: Record<string, unknown>): Record<string, unknown> => {
    finish(payload);
    // App 据此在详情里注明「内容过长，发送时已截断」
    if (truncated) payload.truncated = "1";
    return payload;
  };
  // 设了免打扰的人拿静默版本，其他人拿原样。两拨并发推，结果合并
  const { loud, quiet } = partitionByMute(recipients, channel.id, params.level);
  const batches = [
    { quiet: false, targets: targetsOf(loud), payload: stamp(buildPayload(params, category, origin)) },
    { quiet: true, targets: targetsOf(quiet), payload: stamp(buildPayload(applyQuietHours(params), category, origin)) },
  ].filter((batch) => batch.targets.length > 0);
  const outcomes = await Promise.all(
    batches.map((batch) => fanOut(env, batch.targets, batch.payload, headers)),
  );

  const results = outcomes.flatMap((o) => o.results);
  const delivered = outcomes.reduce((sum, o) => sum + o.delivered, 0);
  // 因接收者开了免打扰而静默送达的设备数。发送方问「为什么没响」时，这是第一个该看的数
  const muted = outcomes.reduce((sum, o, i) => sum + (batches[i]?.quiet ? o.delivered : 0), 0);
  const deadByAccount = new Map<string, string[]>();
  for (const o of outcomes) {
    for (const [accountId, tokens] of o.deadByAccount) {
      deadByAccount.set(accountId, [...(deadByAccount.get(accountId) ?? []), ...tokens]);
    }
  }
  // 补发的提醒是同一条消息再响一次，不算新的一条 —— 否则一条没人理的告警一小时能把条数刷上去十几
  await recordPushOutcome(env, channel.id, deadByAccount, delivered > 0 && !options.reminder);

  const report: DeliveryReport = {
    results, delivered, muted, quieted: outcome.quieted, messageId, warnings,
    ...(truncated ? { truncated: true } : {}),
  };
  // 一台都没送到就不排提醒：发送方拿到的是失败，由它决定要不要重试；这边若在背后接着推，
  // 一条「推送失败」的消息过几分钟又响了，谁也说不清是怎么回事。
  // 存的是截短之后、免打扰降级之前的参数：补发内容和原消息一致，天亮之后的那几次照常响
  if (every && !options.reminder && delivered > 0) {
    report.repeat = await scheduleRepeat(env, channel.id, { ...fitted.params, id: messageId }, every, {
      sentAt,
      truncated,
    });
  }
  return report;
}

/**
 * 有人认领之后，告诉群里每个人。
 *
 * 用原消息的 id 作 collapse-id：通知中心里那条带「我来处理」按钮的原通知会被
 * 原地替换成「张三 正在处理」—— 按钮随之消失，别人不会再重复接手。
 * 级别是 passive：认领是状态更新，不是新告警，不该再吵一遍。
 *
 * 个人通道只有自己一个人，能认领的只有重复提醒（「知道了，别再提醒」）。
 * 「张三 正在处理」是说给别人听的，这里换成对自己说的那句。
 */
export async function announceAck(
  env: Env,
  channel: Channel,
  recipients: Account[],
  messageId: string,
  who: string,
  title: string,
): Promise<{ delivered: number; devices: number }> {
  const personal = channel.memberIds.length === 0;
  const params: PushParams = {
    title: personal ? "已确认，不再提醒" : `${who} 正在处理`,
    body: title || "一条消息",
    level: "passive",
    id: messageId,
  };
  const payload = buildPayload(
    params,
    env.APNS_CATEGORY || "pigeonNotification",
    originOf(channel),
  );
  // NSE 看到这个字段，就去历史里把原消息标成「已认领」，而不是另存一条
  payload.ack_by = who;
  // 认领是一件新发生的事，用它自己的时刻
  payload.sent_at = Date.now();

  const { results, delivered, deadByAccount } = await fanOut(
    env, targetsOf(recipients), payload, pushHeaders(params),
  );
  // 认领不计入通道的推送统计，但顺手清理死 token
  await recordPushOutcome(env, channel.id, deadByAccount, false);
  return { delivered, devices: results.length };
}

// ── 限流 ────────────────────────────────────────────────────────────

/** 每个通道每分钟最多推几条，与 wrangler.toml 里 RL_PUSH 的 limit 一致。只用来说给人听 */
export const PUSH_RATE_PER_MINUTE = 60;
/** 通道被限流过的标记：有它就不再提醒创建者。一小时后自动过期 */
const THROTTLE_NOTICE = "rlnote:";
const THROTTLE_NOTICE_TTL_SECONDS = 3600;

export function throttledMessage(channel: Pick<Channel, "name">): string {
  return `推送太频繁：「${channel.name}」每分钟最多 ${PUSH_RATE_PER_MINUTE} 条，请一分钟后再试。多半是发送脚本在循环重发`;
}

export const KEY_MISS_MESSAGE = "查询不存在的 key 太频繁，请一分钟后再试。先检查推送地址有没有抄错";

/**
 * 按通道限流，放行返回 true。
 *
 * 一个死循环的脚本能把群里每个人的手机刷爆，还会让 Apple 对这些设备限流 —— 真正的告警反而送不到。
 * 按通道 id 计、不按 key：换了 key，额度不该跟着清零。超了回 429，顺手告诉创建者一声（每小时最多一次），
 * 不然发送方的日志没人看，创建者只觉得「这个通道怎么不响了」。
 */
export async function allowPush(env: Env, channel: Channel, recipients: Account[]): Promise<boolean> {
  if (await allow(env.RL_PUSH, `push:${channel.id}`)) return true;
  await noticeThrottled(env, channel, recipients);
  return false;
}

/**
 * 告诉创建者他的通道被限流了。一小时最多一次：先记标记再推，记不下标记就不推 ——
 * 宁可少提醒一次，也不能每一条被拒的推送都去吵他。返回推没推。
 *
 * 只推给创建者：群成员管不了发送脚本。创建者给这个通道开了免打扰、或者正在免打扰时段，就静默送达。
 */
export async function noticeThrottled(
  env: Env,
  channel: Channel,
  recipients: Account[],
  now = Date.now(),
): Promise<boolean> {
  const owner = recipients.find((account) => account.id === channel.ownerId);
  if (!owner || owner.devices.length === 0) return false;
  const marker = THROTTLE_NOTICE + channel.id;
  try {
    if ((await env.PIGEON_KV.get(marker)) !== null) return false;
    await env.PIGEON_KV.put(marker, String(now), { expirationTtl: THROTTLE_NOTICE_TTL_SECONDS });
  } catch {
    return false;
  }

  const params: PushParams = {
    title: "推送太频繁，已暂时拒收",
    body: `「${channel.name}」一分钟内收到超过 ${PUSH_RATE_PER_MINUTE} 条推送，多出来的被拒收了。检查一下发送脚本是不是在循环重发。这个提醒一小时内不再重复`,
    id: newId(),
  };
  const quiet =
    isMuted(owner, channel.id, now) ||
    Boolean(channel.policy?.quietHours && isQuietNow(channel.policy.quietHours, new Date(now)));
  const payload = buildPayload(
    quiet ? applyQuietHours(params) : params,
    env.APNS_CATEGORY || "pigeonNotification",
    originOf(channel),
  );
  payload.sent_at = now;
  const { deadByAccount } = await fanOut(env, targetsOf([owner]), payload, pushHeaders(params));
  // 不计入推送统计，但顺手清理死 token
  await recordPushOutcome(env, channel.id, deadByAccount, false);
  return true;
}

/**
 * 查了一个不存在的 key：按来源 IP 计数（nokey:{ip}），放行返回 true。
 * 只在查不到时才计 —— 正常的推送从不受它影响，挡的是拿一堆编出来的 key 来回试的。
 * 本地开发没有来源 IP，不限。
 */
export async function allowKeyMiss(env: Env, request: Request): Promise<boolean> {
  const ip = request.headers.get("cf-connecting-ip");
  if (!ip) return true;
  return allow(env.RL_IP, `nokey:${ip}`);
}

// ── 批量推送的预算 ──────────────────────────────────────────────────

/** POST /push 一次最多推几个 key */
export const MAX_BATCH_KEYS = 20;

/**
 * POST /push 一批的存储读取预算。每个 key 按「2 + 接收人数」估：推送地址指针、通道记录，再每人读一次账号。
 * 投递时还有去重、统计、给每台设备的 APNs 请求，实际的子请求大致是这个数的两三倍；Workers 一次调用
 * 最多 1000 个子请求，超了整个请求中途报错 —— 前面的人已经收到、后面的没收到，发送方一重试，
 * 前面的人又收一遍。所以超预算的一批在推之前就整批拒掉。
 */
export const BATCH_BUDGET = 300;

export function batchCost(channel: Pick<Channel, "memberIds">): number {
  return 2 + 1 + channel.memberIds.length;
}

export const OVER_BUDGET_MESSAGE =
  `这一批牵涉的人太多，一次推不完（估算的存储读取超过 ${BATCH_BUDGET} 次）：请分几批发送，每批少带几个群组的 key`;

// ── 重复提醒 ────────────────────────────────────────────────────────

const REPEAT = "repeat:";
/** 提醒间隔的下限：cron 5 分钟一轮，比这更密做不到 */
export const REPEAT_MIN_MINUTES = 5;
/** 上限：再稀就出了一小时的提醒窗口，一次也响不了 */
export const REPEAT_MAX_MINUTES = 60;
/** 从原消息算起最多提醒这么久。一小时没人理，再响下去只会让人把这个通道静音 */
export const REPEAT_WINDOW_MS = 60 * 60_000;
/** KV 自动过期比截止时刻多留一会儿：cron 在截止之后的一轮内处理掉它，处理不到的由 KV 兜底删掉 */
const REPEAT_TTL_MARGIN_SECONDS = 10 * 60;

/**
 * repeat 参数 → 间隔分钟数，0 表示不重复。
 * "1" / "true" / "yes" 是「要重复」的开关写法，按最密的 5 分钟；数字取整后夹到 [5, 60]；
 * 缺省、0、乱写一律当没要求 —— 猜错成「要重复」的代价是一小时里被吵十几次。
 */
export function repeatMinutes(raw?: string): number {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "1" || value === "true" || value === "yes") return REPEAT_MIN_MINUTES;
  const minutes = Math.floor(Number(value));
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.min(REPEAT_MAX_MINUTES, Math.max(REPEAT_MIN_MINUTES, minutes));
}

/**
 * 这条消息要不要重复提醒、隔几分钟；0 = 不要。
 *
 * 看的是发送方给的级别，不是免打扰降级之后的：半夜被降成静默的告警，天亮之后的那几次
 * 提醒就该照常响。passive 本来就是「别打扰」，删除和已恢复也没有什么可提醒的。
 */
export function repeatEvery(params: PushParams): number {
  if (params.delete === "1" || params.status === "resolved") return 0;
  if (interruptionLevel(params.level) === "passive") return 0;
  return repeatMinutes(params.repeat);
}

function repeatKey(channelId: string, messageId: string): string {
  return `${REPEAT}${channelId}:${messageId}`;
}

async function putRepeat(env: Env, record: RepeatRecord, now: number): Promise<void> {
  // KV 的 expirationTtl 最短 60 秒
  const ttl = Math.max(60, Math.ceil((record.until - now) / 1000) + REPEAT_TTL_MARGIN_SECONDS);
  await env.PIGEON_KV.put(repeatKey(record.channelId, record.messageId), JSON.stringify(record), {
    expirationTtl: ttl,
  });
}

/**
 * 原消息送到之后排上第一次补发。同一个 id 已经排过的整条覆盖：发送方又推了一遍同一件事，
 * 提醒从这一刻重新算，用的也是最新的内容。
 * 写失败不抛 —— 消息已经送到了，少了提醒也好过让发送方以为推送失败。
 */
async function scheduleRepeat(
  env: Env,
  channelId: string,
  params: PushParams & { id: string },
  every: number,
  original: { sentAt: number; truncated: boolean },
  now = Date.now(),
): Promise<DeliveryReport["repeat"]> {
  const record: RepeatRecord = {
    channelId,
    messageId: params.id,
    params,
    every,
    nextAt: now + every * 60_000,
    until: now + REPEAT_WINDOW_MS,
    count: 1,
    sentAt: original.sentAt,
    ...(original.truncated ? { truncated: true } : {}),
  };
  try {
    await putRepeat(env, record, now);
    return { every, until: record.until, id: record.messageId };
  } catch {
    return undefined;
  }
}

/**
 * 撤掉一条消息的重复提醒，返回撤没撤到。
 *
 * 先读后删：绝大多数带 id 的推送根本没排过提醒，而 KV 的删除按写入计费、额度比读少得多。
 * 出错不抛 —— 撤不掉不能连累推送或认领本身；cron 每次补发前还会查认领记录，
 * 最坏也只是响到一小时的截止为止。
 */
export async function cancelRepeat(env: Env, channelId: string, messageId: string): Promise<boolean> {
  const key = repeatKey(channelId, messageId);
  try {
    if ((await env.PIGEON_KV.get(key)) === null) return false;
    await env.PIGEON_KV.delete(key);
    return true;
  } catch {
    return false;
  }
}

/** 某个前缀下的全部键。KV 一页最多 1000 个，翻页取全 */
async function listKeys(env: Env, prefix: string): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await env.PIGEON_KV.list({ prefix, cursor });
    for (const key of page.keys) names.push(key.name);
    if (page.list_complete) return names;
    cursor = page.cursor;
  }
}

/**
 * cron 每轮：把到点的重复提醒补发一次，直到有人认领、消息恢复或过了截止时刻。
 *
 * 补发沿用原消息的 id —— 它就是 apns-collapse-id，新的一次原地替换上一次，通知中心里
 * 始终只有一条；payload 带上 reminder（第几次），App 据此显示「第 N 次提醒」。
 * 每条独立 try/catch，一条出错不影响其它；补发成功之后才推进计数，中途失败下轮重来。
 */
export async function runReminders(env: Env, now: number = Date.now()): Promise<{ sent: number; stopped: number }> {
  let sent = 0;
  let stopped = 0;
  for (const name of await listKeys(env, REPEAT)) {
    try {
      const record = await env.PIGEON_KV.get<RepeatRecord>(name, "json");
      if (!record || now < record.nextAt) continue;

      // 截止看的是「这一次本该在什么时候响」，不是 cron 实际跑到的时刻：间隔 60 分钟的提醒
      // 本该正好在截止那一刻响，而 cron 总要晚到几分钟 —— 按实际时刻比，它一次也响不了
      const expired = record.nextAt > record.until;
      const channel = expired ? null : await getChannel(env, record.channelId);
      if (!channel || channel.suspended || (await isAcked(env, record.channelId, record.messageId))) {
        await env.PIGEON_KV.delete(name);
        stopped += 1;
        continue;
      }

      const count = record.count + 1;
      await deliver(env, channel, await recipientsOf(env, channel), record.params, {
        reminder: count,
        // 补发是同一件事再响一次，发出时刻沿用原消息的。旧记录没存，按截止时刻倒推回原消息那一刻
        sentAt: record.sentAt ?? record.until - REPEAT_WINDOW_MS,
        truncated: record.truncated,
      });
      sent += 1;
      const next: RepeatRecord = { ...record, count, nextAt: now + record.every * 60_000 };
      // 下一次已经落在截止之后：现在就删，不必留着等下一轮来删
      if (next.nextAt > next.until) await env.PIGEON_KV.delete(name);
      else await putRepeat(env, next, now);
    } catch {
      // 单条提醒的任何异常都不该影响其它提醒
    }
  }
  return { sent, stopped };
}
