import { isDeadToken, pushToDevice, type ApnsHeaders } from "./apns";
import { readBody } from "./body";
import {
  clearAck,
  deadTokens,
  getChannel,
  isAcked,
  isMuted,
  listEntries,
  meteredEnv,
  newId,
  recipientsOf,
  recordPushOutcome,
} from "./db";
import { fieldLines, genericMessage } from "./compat/generic";
import { serviceParams } from "./compat/params";
import { ackSignature } from "./groups";
import { prepareInteraction } from "./actions";
import { initReceipt, onRepeatExpired } from "./receipts";
import { liveAfterDelivery, liveCost, liveOnAck, liveOnRetract, liveRequested, type LiveReport } from "./live";
import { applyPolicy, applyQuietHours, isQuietNow } from "./policy";
import { allow } from "./ratelimit";
import { isCritical, splitRecipients } from "./receivers";
// 按人分拨的规则在 receivers.ts；从这里再导出一次，推送的单元测试照旧只打包这一个入口
export { splitRecipients };
import type { Account, Channel, Device, Env, PushParams, PushResult, RepeatRecord } from "./types";

/** 所有认识的推送参数名。既用于从 query / body 里挑字段，也是通道默认值的白名单 */
export const PARAM_KEYS = [
  "title", "subtitle", "body", "level", "volume", "badge", "call",
  "autoCopy", "copy", "sound", "icon", "group", "ciphertext", "iv",
  "isArchive", "ttl", "url", "image", "markdown", "action", "id", "delete",
  "tags", "status", "repeat", "actions", "callback", "live",
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

/** 这个字段名是不是信鸽认得的参数（含别名） */
function isParamName(raw: string): boolean {
  return raw.toLowerCase() in SOFT_ALIASES || normalizeName(raw) !== null || raw in ALIASES;
}

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
 * short（卡片上的一句摘要）也当副标题。
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
  short: "subtitle",
};

/**
 * 开关类参数。App 只认 "1" / "0"：原先 isArchive=false 照样存进历史（App 看的是「不等于 0」），
 * autoCopy=true 不生效（App 看的是「等于 1」）。true / yes / on 统一成 "1"，false / no / off 统一成 "0"
 */
const SWITCH_PARAMS = new Set<string>(["autoCopy", "isArchive", "call", "delete", "live"]);
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
  // actions 在 JSON 请求体里常直接写成数组/对象；表单和 query 里是 JSON 字符串。两种都收进来，
  // 统一交给 parseActions 去认（它 JSON 和简写都吃）
  if (name === "actions" && raw !== null && typeof raw === "object") {
    return JSON.stringify(raw);
  }
  return null;
}

/**
 * 通道默认值（PATCH 通道的 defaults）里一项的值 → 存下来的字符串，和推送参数同一套规矩（见 scalar）：
 * 写成 JSON 数组的 actions 存 JSON 原文，不是 String() 出来的「[object Object]」；开关统一成 "1" / "0"。
 * 认不了的（对象、数组，actions、tags 除外）返回 null，当没写
 */
export function defaultParamValue(name: string, raw: unknown): string | null {
  const value = scalar(name, raw);
  if (value === null) return null;
  return SWITCH_PARAMS.has(name) ? normalizeSwitch(value) : value;
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

/** 撤回（delete=1）：把同 id 的那条消息撤回来。只看 id，标题正文一概不推 */
export function isRetraction(params: PushParams): boolean {
  return params.delete === "1";
}

export const RETRACT_NEEDS_ID = "撤回要带上原消息的 id";

/**
 * 有没有可推的内容。端到端加密的消息只有密文、没有明文标题正文，也是一条合法的消息；
 * 撤回只要 id（没带 id 的撤回由入口单独回 400，说清楚缺的是什么）
 */
export function hasContent(params: PushParams): boolean {
  if (isRetraction(params)) return Boolean(params.id);
  return Boolean(params.title || params.subtitle || params.body || params.ciphertext);
}

/**
 * 通道默认值垫底，这次请求带来的覆盖在上面。
 * 默认值里的 delete 不算：撤回是针对某一条消息的动作，当成默认值的话每条推送都成了撤回
 */
export function withDefaults(channel: Pick<Channel, "defaults">, own: PushParams): PushParams {
  const { delete: _notADefault, ...defaults } = channel.defaults ?? {};
  return promoteMarkdown({ ...defaults, ...own });
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
  /** 请求体不为空，却什么也没认出来；或者认不出正文、按通用 JSON 推了 */
  warning?: string;
  /** 别家推送服务特有、信鸽用不上的参数名（见 compat/params.ts） */
  ignored?: string[];
  /** 通用 JSON 兜底猜出来的字段：query、请求头里明写了的，以明写的为准 */
  guessed?: (keyof PushParams)[];
}

const GENERIC_JSON =
  "请求体里没有认得的字段，已按通用 JSON 推送：标题取 title、name、event、status 这类常见字段，正文是前 6 个字段。想自己定标题正文，请用 title、body";
const GENERIC_FIELDS = "请求体里有标题、没有认得的正文字段：其余字段按「键：值」排成了正文。想自己定正文，请用 body";

/** 正文、标题这类「看得见的内容」一样都没有 */
function lacksContent(params: PushParams): boolean {
  return !(params.title || params.subtitle || params.body || params.markdown || params.ciphertext || params.delete);
}

/** 通用 JSON 兜底用了哪一种（整条都靠猜 / 只补了正文），猜出来的是哪几个字段 */
interface Fallback {
  kind: "full" | "fields";
  guessed: (keyof PushParams)[];
}

/**
 * 认不出正文的 JSON：按通用规则取标题和前几个字段（见 compat/generic.ts），至少推出一条看得懂的消息。
 * 已经认出来的信鸽参数（id、level、url……）不再排进正文；别家的令牌之类一概不进推送。
 *
 * 认出了标题、却没有正文（{"title":"备份失败","host":"nas","error":"disk full"}）：其余字段排成正文 ——
 * 原先只推一个标题，出了什么事、在哪台机器上全丢了，发送方毫无察觉
 */
function genericFallback(parsed: unknown, params: PushParams, skip: (key: string) => boolean): Fallback | null {
  if (!lacksContent(params)) {
    if (params.body || params.markdown || params.ciphertext || params.delete || !parsed || typeof parsed !== "object") return null;
    const body = fieldLines(parsed, skip);
    if (!body) return null;
    params.body = body;
    return { kind: "fields", guessed: ["body"] };
  }
  const generic = genericMessage(parsed, { skipTopLevel: skip });
  if (!generic.title && !generic.body) return null;
  const guessed: (keyof PushParams)[] = [];
  const fill = (name: "title" | "body" | "url" | "image" | "level", value: string | undefined, overwrite: boolean) => {
    if (!value || (!overwrite && params[name])) return;
    params[name] = value;
    guessed.push(name);
  };
  fill("title", generic.title, true);
  fill("body", generic.body, true);
  fill("url", generic.url, false);
  fill("image", generic.image, false);
  fill("level", generic.level, false);
  return { kind: "full", guessed };
}

/**
 * subject：邮件式的通知（{"subject","message"}）拿它装标题。只在认出了正文、却没有标题时用 ——
 * 不当普通别名，免得一个只有 subject 和一堆字段的请求体被当成「只有标题」，错过通用 JSON 的兜底
 */
function subjectTitle(params: PushParams, object: Record<string, unknown>): void {
  if (params.title || !params.body) return;
  const subject = Object.entries(object).find(([k, v]) => k.toLowerCase() === "subject" && typeof v === "string" && v.trim());
  if (subject) params.title = String(subject[1]).trim();
}

/** 一个 JSON 值 → 参数：对象按字段、认不出正文的按通用 JSON；数组按通用 JSON */
function absorbJson(params: PushParams, parsed: unknown): { recognised: number; generic: Fallback | null; ignored: string[] } {
  if (Array.isArray(parsed)) {
    return { recognised: 0, generic: genericFallback(parsed, params, () => false), ignored: [] };
  }
  const object = parsed as Record<string, unknown>;
  const styled = serviceParams(Object.entries(object));
  const recognised = absorb(params, styled.entries);
  subjectTitle(params, object);
  const foreign = new Set(styled.ignored);
  const kept = new Set(styled.entries.map(([name]) => name));
  // 被 absorb 认出来的（信鸽自己的参数）和别家的参数都不排进正文
  const skip = (key: string) => foreign.has(key) || (kept.has(key) && isParamName(key));
  return { recognised, generic: genericFallback(object, params, skip), ignored: styled.ignored };
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
  let generic: Fallback | null = null;
  let ignored: string[] = [];

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
    else if (parsed && typeof parsed === "object") ({ recognised, generic, ignored } = absorbJson(params, parsed));
  } else if (type.includes("form-urlencoded")) {
    const form = [...new URLSearchParams(text).entries()];
    // 没有一个字段有值、也没有等号：这不是表单，是一句话（里面带 & 的会被拆成好几个「字段」）
    if (!text.includes("=") && form.every(([, value]) => value === "")) {
      // 原文用了百分号编码（--data-urlencode）就解码；没编码的取原文 —— 表单解码会把 + 变成空格
      rawText = /%[0-9a-f]{2}/i.test(text) ? formDecode(text) : text;
    } else {
      const styled = serviceParams(form);
      ignored = styled.ignored;
      recognised = absorb(params, styled.entries);
    }
  } else if (type.includes("multipart/form-data")) {
    try {
      const form = await new Response(raw, { headers: { "content-type": contentType } }).formData();
      const styled = serviceParams([...form.entries()] as [string, unknown][]);
      ignored = styled.ignored;
      recognised = absorb(params, styled.entries);
    } catch {
      // 多部分表单坏了：当没认出来
    }
  } else if (type === "" || type.startsWith("text/")) {
    // fetch() 直接传字符串时类型是 text/plain，里面装的常常是 JSON
    const object = jsonObject(text);
    if (object) ({ recognised, generic, ignored } = absorbJson(params, object));
    else rawText = text;
  }

  if (rawText !== null) {
    const body = rawText.trimEnd();
    if (body) {
      params.body = body;
      return { params };
    }
  }
  const extra = ignored.length ? { ignored } : {};
  if (generic) return { params, warning: generic.kind === "full" ? GENERIC_JSON : GENERIC_FIELDS, guessed: generic.guessed, ...extra };
  return recognised > 0 ? { params, ...extra } : { params, warning: UNRECOGNISED, ...extra };
}

// ── 收集一次推送的参数 ──────────────────────────────────────────────

export interface CollectedRequest {
  /** 通道默认值 + 这次请求带来的，推送用它 */
  params: PushParams;
  /** 只有这次请求自己带来的。只收加密、不生效的参数都只看它 —— 默认值是创建者自己设的 */
  own: PushParams;
  /** 给发送方的中文提示：请求体没认出来之类 */
  warnings: string[];
  /** 别家推送服务特有、信鸽用不上的参数名：入口把它们并进响应的 ignored（见 compat/params.ts） */
  ignored: string[];
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
  const query = serviceParams(url.searchParams.entries());
  absorb(fromQuery, query.entries);
  const ignored = [...query.ignored];
  const fromHeaders = headerParams(request.headers);

  let fromBody: PushParams = {};
  if (request.method !== "GET" && request.method !== "HEAD") {
    // 先按上限把原文读下来，再按类型解析：request.json() / formData() 不看大小，
    // 几十 MB 的请求体会被整个收进内存
    const parsed = await parseBody(await readBody(request), request.headers.get("content-type") ?? "");
    fromBody = parsed.params;
    // 兜底猜出来的标题正文不盖过 query、请求头里明写的
    for (const k of parsed.guessed ?? []) if (fromQuery[k] !== undefined || fromHeaders[k] !== undefined) delete fromBody[k];
    if (parsed.warning) warnings.push(parsed.warning);
    for (const name of parsed.ignored ?? []) if (!ignored.includes(name)) ignored.push(name);
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
  return { params: withDefaults(channel, own), own, warnings, ignored };
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
  if (isRetraction(params)) return retractionPayload(params, category, origin);

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
    "markdown", "id", "ttl", "repeat", "actions",
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
  // 监控告警才有：App 凭它打开监控详情（发送方给不了，见 PushParams.watchId）
  if (params.watchId) payload.watch_id = params.watchId;

  // App 靠这两个字段把历史按通道归类
  if (origin) {
    payload.channel_id = origin.id;
    payload.channel_name = origin.name;
  }

  return payload;
}

/** 撤回之后锁屏和通知中心里显示的那一句 */
export const RETRACTED_TITLE = "此消息已撤回";

/**
 * 撤回：一条静默（passive）的普通通知，沿用原消息的 id 作 collapse-id，
 * 锁屏和通知中心里的原通知被原地替换成「此消息已撤回」，原文不再露出来。
 *
 * 原先发的是后台推送：App 没开后台模式，通知扩展也不会为后台推送运行 —— 手机上什么都没发生，
 * 发送方却拿到 200，以为误发的口令已经撤回了。普通通知一定会经过通知扩展：
 * 新版 App 看到 delete 就从历史里删掉这条、撤掉同 id 的其它通知，撤回通知本身不进历史；
 * 旧版 App 不认 delete，把它当成同 id 的新一版存进历史 —— 原文照样被「此消息已撤回」盖掉。
 * 发送方给的标题正文一概不带。
 */
function retractionPayload(params: PushParams, category: string, origin?: Origin): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    aps: {
      alert: { title: RETRACTED_TITLE },
      "thread-id": params.group ?? origin?.id,
      category,
      "mutable-content": 1,
      "interruption-level": "passive",
    },
    delete: "1",
    id: params.id,
    // 旧版 App 按顶层的 level 归档；撤回不该算成一条要紧的新消息
    level: "passive",
  };
  if (origin) {
    payload.channel_id = origin.id;
    payload.channel_name = origin.name;
  }
  return payload;
}

/** 标签：逗号或竖线分隔（中英文逗号都认；竖线是别家常见的写法），去重，最多 5 个、每个 24 字以内 —— 照单全收会把通知撑爆 */
export function normalizeTags(raw?: string): string | undefined {
  if (!raw) return undefined;
  const tags = [
    ...new Set(
      raw.split(/[,，|]/).map((t) => t.trim()).filter(Boolean).map((t) => t.slice(0, 24)),
    ),
  ].slice(0, 5);
  return tags.length ? tags.join(",") : undefined;
}

export function pushHeaders(params: PushParams): ApnsHeaders {
  // 撤回也是普通通知、立即送达：原文正亮在别人锁屏上，晚一刻撤就多一刻被看见
  const headers: ApnsHeaders = {
    "apns-push-type": "alert",
    "apns-priority": "10",
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
 * 没授权「紧急」的接收者拿到的那一版：critical 按时效性送（见 receivers.ts）。
 * 顶层的 level 也跟着改 —— App 按它归档，他那里记下的就是一条时效性消息。
 * 不是 critical 的原样返回：量载荷时三版都量，平白多出一个级别字段，贴着 4KB 的消息就会被白白截短
 */
function capCritical(params: PushParams): PushParams {
  return isCritical(params.level) ? { ...params, level: "timeSensitive" } : params;
}

/** 并发推给每台设备，死 token 按各自的账号归堆，交给 recordPushOutcome 分别清理 */
async function fanOut(
  env: Env,
  targets: Target[],
  payload: Record<string, unknown>,
  headers: ApnsHeaders,
): Promise<{ results: PushResult[]; delivered: number; deadByAccount: Map<string, string[]> }> {
  // APNs 早先报过失效的 token 立了墓碑、还挂在账号上（等本人来访才摘，见 recordPushOutcome），这里跳过
  const dead = await deadTokens(env, targets.map((t) => t.device));
  if (dead.size > 0) targets = targets.filter((t) => !dead.has(t.device.token));
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

/** 推送在发出之前就被拒了：截不动、放不下（413），或者撤回没带 id（400）。入口按 status 和 message 回给发送方 */
export interface Rejection {
  status: number;
  message: string;
  /** 放不下时：量出来的 payload 字节数和上限，发送方据此知道要缩短多少 */
  bytes?: number;
  limit?: number;
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
  /** 没有发出去：内容截不动也放不下，或者撤回没带 id */
  rejection?: Rejection;
  /** 这是一次撤回（delete=1） */
  retracted?: boolean;
  /** 要求了重复提醒、但同时在响的已经满额，这条只推这一次：满的是这个通道，还是创建者名下全部通道 */
  repeatSkipped?: RepeatLimit;
  /** 实时活动这一路：开了、更新了、结束了几个（见 live.ts） */
  live?: LiveReport;
}

export interface DeliverOptions {
  /** cron 补发重复提醒时给出：这是第几次（≥ 2）。补发绕过去重、不重新排期、不计入推送统计 */
  reminder?: number;
  /** 发出时刻（毫秒）。补发时给原消息的，默认是现在 */
  sentAt?: number;
  /** 补发时给出：原消息截短过（存下来的已是截短后的内容，这里量不出来了） */
  truncated?: boolean;
  /** 用发送令牌推的：令牌的名字，payload 带 from，App 显示「来自：NAS」（见 tokens.ts） */
  from?: string;
  /** 成员在群里发的：发消息的人的名字，payload 带 sender（见 routes/messages.ts） */
  sender?: string;
  /** 同上，发消息的人的账号 id：他自己的设备静默收下（见 receivers.ts） */
  senderId?: string;
  /**
   * 告警演练（见 routes/selftest.ts）：第一次补发提早到 firstAt、提醒到 until 为止。
   * 真告警隔 every 分钟才补第一次、响满一小时；演练要在几分钟里走完，只补一次
   */
  reminderPlan?: { firstAt: number; until: number };
  /** 通知体检的 nonce：原样放进 payload 的 selftest 字段，NSE 据此记下送达时刻、不归档 */
  selftest?: string;
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
    ...(report.retracted ? { retracted: true } : {}),
    // 给脚本看的：warnings 是说给人听的中文，这个字段不用解析文字就知道提醒没排上
    ...(report.repeatSkipped ? { repeat_skipped: `${report.repeatSkipped}_limit` } : {}),
    // 实时活动开了几个（要了 live 却是 0：接收者都没在手机上打开它，或者被免打扰压低了）
    ...(report.live ? { live: report.live } : {}),
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
  const retraction = isRetraction(incoming);
  if (retraction && !incoming.id) {
    return { results: [], delivered: 0, warnings: [], rejection: { status: 400, message: RETRACT_NEEDS_ID } };
  }
  const requested = repeatEvery(incoming);
  // 同一个 id 的最新一版决定这条消息还提不提醒：恢复了、撤回了、或者新的一版没要求重复，
  // 之前排下的提醒一律作废 —— 否则补发的会是旧内容，把手机上更新过的那条又盖回去。
  // 放在最前面：被去重压掉的「已恢复」、没有可用设备的通道，照样要停
  if (incoming.id && !options.reminder && !requested) await cancelRepeat(env, channel.id, incoming.id);
  // 事件结束了（恢复、撤回）：这一次的认领也到此为止。同一个 id 下次再触发是新的一件事，
  // 得重新有人接手、重新提醒。同一次触发的重发（firing 或没写 status）不清 —— 已经有人在处理了
  if (incoming.id && !options.reminder && (retraction || incoming.status === "resolved")) {
    await clearAck(env, channel.id, incoming.id);
  }

  const targets = targetsOf(recipients);
  if (targets.length === 0) return { results: [], delivered: 0 };
  if (retraction && incoming.id) return retract(env, channel, recipients, targets, incoming, incoming.id, sentAt);

  // 每条消息都要有 id：同一条通知落在群里不同人的手机上，靠它对上号；
  // 它同时是 apns-collapse-id，之后的「正在处理」才能原地替换掉原通知。
  const messageId = incoming.id || newId();
  const shaped: PushParams = { ...incoming, id: messageId };
  // 认领凭据：只有真从这个通道推出去的消息，才认领得了（见 groups.ts）。签不出来（本地没有私钥、
  // 私钥格式不对）就不带 —— 推送照常，认领按旧 App 的过渡规则放行
  const ackSig = await ackSignature(env, channel.id, messageId).catch(() => undefined);
  const headers = pushHeaders(shaped);
  const warnings: string[] = [];
  // 自定义按钮 / 回调地址：把 actions 规整成紧凑写法、验一遍 callback，给出按钮凭据 act_sig（思路同 ack_sig）。
  // 有错（多半来自通道默认值、适配器或监控的推送）就去掉，说明进 warnings。放在量 payload 之前 —— 按钮也占 4KB
  const actSig = await prepareInteraction(env, channel.id, messageId, shaped, warnings);
  // 每次提醒靠 collapse-id 原地替换上一次。id 太长当不了 collapse-id（App 也没法认领它），
  // 再提醒就是在通知中心里摞一串 —— 这种只推这一次
  let every = headers["apns-collapse-id"] ? requested : 0;
  let repeatSkipped: RepeatLimit | undefined;
  if (every && !options.reminder) {
    // 同时在响的提醒满额了：这条照常送达，只是不再重复（payload 里也就不带 repeat，App 不会说「会重复提醒」）
    repeatSkipped = (await repeatLimitReached(env, channel, messageId, sentAt)) ?? undefined;
    if (repeatSkipped) {
      every = 0;
      // 同一个 id 之前排下的也作废：新的一版不重复，就不能再拿旧内容来响
      if (incoming.id) await cancelRepeat(env, channel.id, messageId);
    }
  }
  if (every) shaped.repeat = String(every);
  else delete shaped.repeat;
  const category = categoryFor(env, channel, every > 0);
  const origin = originOf(channel);

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
    // 放在这里一起量：它也占 payload 的 4KB（约 35 字节）
    if (ackSig) payload.ack_sig = ackSig;
    // 按钮凭据。App 点了要经服务端的按钮时原样带回，服务端据此确认按钮真是这条消息推出去的、没被改过
    if (actSig) payload.act_sig = actSig;
    // 第几次提醒只出现在补发里。它不是推送参数 —— 发送方不能自己冒充「第 5 次提醒」
    if (options.reminder) payload.reminder = String(options.reminder);
    // 谁发的也不是推送参数：令牌名、成员名由服务端按凭据填，发送方冒充不了
    if (options.from) payload.from = options.from;
    if (options.sender) payload.sender = options.sender;
    // 同理：体检的 nonce 只有服务端自己的演练会带
    if (options.selftest) payload.selftest = options.selftest;
    return payload;
  };
  // 每个人拿到的三版（原样、critical 降成时效性、静默）都量，取大的
  const fitted = fitPayload(shaped, (p) =>
    Math.max(
      payloadBytes(finish(buildPayload(p, category, origin))),
      payloadBytes(finish(buildPayload(capCritical(p), category, origin))),
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

  const outcome = await applyPolicy(env, channel, fitted.params, new Date(), {
    skipDedupe: Boolean(options.reminder),
    generatedId: !incoming.id,
  });
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
  // 每个人按自己的设置拿一版：免打扰、低于自己设的最低级别的拿静默版本，没授权「紧急」的拿降成时效性的，
  // 其他人拿原样（见 receivers.ts）。几拨并发推，结果合并
  const tiers = splitRecipients(recipients, channel, params.level, { now: Date.now(), senderId: options.senderId });
  const batches = [
    { quiet: false, targets: targetsOf(tiers.asis), payload: stamp(buildPayload(params, category, origin)) },
    { quiet: false, targets: targetsOf(tiers.capped), payload: stamp(buildPayload(capCritical(params), category, origin)) },
    { quiet: true, targets: targetsOf(tiers.quiet), payload: stamp(buildPayload(applyQuietHours(params), category, origin)) },
  ].filter((batch) => batch.targets.length > 0);
  const outcomes = await Promise.all(
    batches.map((batch) => fanOut(env, batch.targets, batch.payload, headers)),
  );

  const results = outcomes.flatMap((o) => o.results);
  const delivered = outcomes.reduce((sum, o) => sum + o.delivered, 0);
  // 因接收者开了免打扰（或设了最低级别）而静默送达的设备数。发送方问「为什么没响」时，这是第一个该看的数
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
  // 带了 callback：把它连同发出时刻记进回执，认领和点按钮时才找得到往哪发事件。
  // 补发不重记（同一条），一台都没送到也不记（本来就没人收得到、点得了）
  if (params.callback && delivered > 0 && !options.reminder) {
    await initReceipt(env, channel.id, messageId, params.callback, sentAt);
  }
  // 实时活动（见 live.ts）：跟在普通推送之后，只开给响着送到了的设备（原样的和 critical 降成时效性的；按接收方设置压成静默的不开，见 receivers.ts）；补发的提醒不再开。出了错不影响这条消息
  if (!options.reminder) {
    const loudDelivered = new Set(
      outcomes.flatMap((o, i) => (batches[i]?.quiet ? [] : o.results.filter((r) => r.status === 200).map((r) => r.deviceToken))),
    );
    const live = await liveAfterDelivery(env, {
      channel, recipients, params, messageId, sentAt, hadId: Boolean(incoming.id), ackSig, loudDelivered,
      passive: interruptionLevel(params.level) === "passive",
    });
    if (live) report.live = live;
  }
  // 满额的说明只跟着真推出去的消息走：被去重压掉、被拒的，本来就没有提醒可言
  if (repeatSkipped) {
    report.repeatSkipped = repeatSkipped;
    warnings.push(REPEAT_LIMIT_MESSAGES[repeatSkipped]);
  }
  // 一台都没送到就不排提醒：发送方拿到的是失败，由它决定要不要重试；这边若在背后接着推，
  // 一条「推送失败」的消息过几分钟又响了，谁也说不清是怎么回事。
  // 存的是截短之后、免打扰降级之前的参数：补发内容和原消息一致，天亮之后的那几次照常响
  if (every && !options.reminder && delivered > 0) {
    report.repeat = await scheduleRepeat(env, channel, { ...fitted.params, id: messageId }, every, {
      sentAt,
      truncated,
      from: options.from,
    }, options.reminderPlan);
  }
  return report;
}

/**
 * 撤回同 id 的消息（delete=1）：推一条「此消息已撤回」原地替换原通知，见 retractionPayload。
 * 不去重（两次撤回不同的消息，文案一模一样）、不看免打扰（本来就是静默的）、不计入推送条数 ——
 * 它不是一条新消息。提醒和认领已经在 deliver 开头清掉了。
 */
async function retract(
  env: Env,
  channel: Channel,
  recipients: Account[],
  targets: Target[],
  incoming: PushParams,
  messageId: string,
  sentAt: number,
): Promise<DeliveryReport> {
  const params: PushParams = { ...incoming, id: messageId };
  const headers = pushHeaders(params);
  const warnings: string[] = [];
  if (!headers["apns-collapse-id"]) {
    warnings.push("id 超过 64 字节：锁屏上的原通知替换不掉，新版 App 的历史里照样会删掉这条");
  }
  // 撤回不带按钮：群组的「我来处理」、个人通道的「知道了」对它都没有意义
  const payload = buildPayload(params, env.APNS_CATEGORY || "pigeonNotification", originOf(channel));
  payload.sent_at = sentAt;
  // 能撑大它的只有 id 和分组。放不下的推出去也会被 APNs 整条拒掉
  const bytes = payloadBytes(payload);
  if (bytes > PAYLOAD_BUDGET) {
    return { results: [], delivered: 0, messageId, warnings, retracted: true, rejection: tooLarge(bytes, params) };
  }
  const { results, delivered, deadByAccount } = await fanOut(env, targets, payload, headers);
  await recordPushOutcome(env, channel.id, deadByAccount, false);
  // 这件事开着实时活动的话，立即收起
  const live = await liveOnRetract(env, channel, recipients, messageId, sentAt, liveRequested(incoming));
  return { results, delivered, messageId, warnings, retracted: true, ...(live ? { live } : {}) };
}

/**
 * 有人认领之后，告诉群里每个人。
 *
 * 用原消息的 id 作 collapse-id：通知中心里那条带「我来处理」按钮的原通知会被
 * 原地替换成「张三 正在处理」—— 按钮随之消失，别人不会再重复接手。
 * 级别是 passive：认领是状态更新，不是新告警，不该再吵一遍。
 *
 * 正文固定是「一条消息」，不带原消息的标题：原先用的是 App 传上来的标题，而加密消息的标题
 * 在 App 里已经解密 —— 等于把明文经服务端和 APNs 广播给全群。各台设备的通知扩展按 id
 * 在本机历史里找回原标题，自己换上去。
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
): Promise<{ delivered: number; devices: number }> {
  const personal = channel.memberIds.length === 0;
  const params: PushParams = {
    title: personal ? "已确认，不再提醒" : `${who} 正在处理`,
    body: "一条消息",
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
  // 开着实时活动的，换成「某某 正在处理」（见 live.ts）
  await liveOnAck(env, channel, recipients, messageId, who);
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
 * 推给这些人一次，最多要用多少个子请求。Workers 一次调用最多 1000 个，KV 操作和对外的 fetch 都算。
 *
 * 每台设备：读一次失效墓碑、打一次 APNs，再加上失败时的一次重试（或者立一块失效墓碑）—— 按 3 个算。
 * 固定开销：去重、推送统计、重复提醒的占位与记录、撤回和结束时清认领，按 DELIVERY_OVERHEAD 算。
 * 接收人账号的读取不在这里：那是查通道时花掉的，调用方自己算。
 *
 * 原先只按人数估：一个人两台设备、APNs 再抖一下，预算之内的一批照样超过 1000，推到一半中断
 */
export const DELIVERY_OVERHEAD = 12;
export const SUBREQUESTS_PER_DEVICE = 3;

export function deliveryCost(recipients: Pick<Account, "devices">[]): number {
  const devices = recipients.reduce((sum, account) => sum + account.devices.length, 0);
  // 登记了实时活动的设备另算（开始、结束各要推一次、删一条令牌）；没有的话是 0
  return DELIVERY_OVERHEAD + SUBREQUESTS_PER_DEVICE * devices + liveCost(recipients);
}

/**
 * POST /push 一批的子请求预算。每个 key 按「查通道 + 每人读一次账号 + 投递」估（见 deliveryCost），
 * 超了整个请求中途报错 —— 前面的人已经收到、后面的没收到，发送方一重试，前面的人又收一遍。
 * 所以超预算的一批在推之前就整批拒掉。离 1000 留出的余量给入口自己：限流、查不到的 key、违禁词表
 */
export const BATCH_BUDGET = 900;

/** 查一个通道（key 指针、通道记录、停用标记、推送统计）的读取 */
const RESOLVE_COST = 4;

export function batchCost(channel: Pick<Channel, "memberIds">, recipients: Pick<Account, "devices">[]): number {
  return RESOLVE_COST + 1 + channel.memberIds.length + deliveryCost(recipients);
}

export const OVER_BUDGET_MESSAGE =
  `这一批牵涉的人和设备太多，一次推不完（估算的存储读写和推送请求超过 ${BATCH_BUDGET} 个）：请分几批发送，每批少带几个群组的 key`;

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
 * 同时在响的重复提醒：每个通道最多 10 条，通道创建者名下所有通道加起来最多 30 条。
 *
 * cron 每轮逐条补发，每条要五六次存储读写，而一次 cron 调用全站共用 1000 次的额度 ——
 * 原先不设上限，一个人用一个 key 推两百条不同 id、带 repeat 的消息，就能让全站的提醒和监控整轮停摆。
 * 值班场景同时没人处理的告警超过十条，再多响几条也不会有人多看一眼。
 * 满额之后的推送照常送达，只是不再重复，响应里说明。
 */
export const MAX_REPEATS_PER_CHANNEL = 10;
export const MAX_REPEATS_PER_ACCOUNT = 30;

/**
 * 每条在响的提醒一个占位：`rptslot:{创建者 id}:{通道 id}:{消息 id}`，值为空，截止时刻放在 metadata 里。
 * 数一个人名下有几条，list 一下这个人的前缀就够了，不用读通道记录、也不用挨个读提醒记录。
 *
 * 不用一个计数器：KV 同一个键每秒最多写一次，一次告警风暴里同一个人的几条提醒几乎同时排上，
 * 计数器写不进去，要么漏数、要么只能把提醒丢掉；每条一个键就没有这个问题，过期了也不会漏减。
 * 只有 id，不含任何推送内容。
 */
const REPEAT_SLOT = "rptslot:";

export type RepeatLimit = "channel" | "account";

export const REPEAT_LIMIT_MESSAGES: Record<RepeatLimit, string> = {
  channel: `重复提醒没排上：这个通道同时最多 ${MAX_REPEATS_PER_CHANNEL} 条消息在重复提醒。这条照常送达，只是不再重复；先认领几条，或者推 status=resolved 结束它们`,
  account: `重复提醒没排上：这个通道的创建者名下，同时最多 ${MAX_REPEATS_PER_ACCOUNT} 条消息在重复提醒。这条照常送达，只是不再重复；先认领几条，或者推 status=resolved 结束它们`,
};

interface SlotMeta {
  /** 这条提醒的截止时刻（毫秒）。过了就不算数，不等 KV 真正删掉 */
  until: number;
}

function slotPrefix(ownerId: string, channelId?: string): string {
  return `${REPEAT_SLOT}${ownerId}:${channelId ? `${channelId}:` : ""}`;
}

function slotKey(ownerId: string, channelId: string, messageId: string): string {
  return `${slotPrefix(ownerId, channelId)}${messageId}`;
}

/**
 * 这条消息要排提醒的话，会不会超额；不超返回 null。
 * 同一个 id 再推一版是覆盖原来那条，不多占一个。查不了（KV 出错）就放行：少挡一次，好过把正经的提醒丢掉
 */
export async function repeatLimitReached(
  env: Env,
  channel: Pick<Channel, "id" | "ownerId">,
  messageId: string,
  now = Date.now(),
): Promise<RepeatLimit | null> {
  let keys: { name: string; metadata?: unknown }[];
  try {
    // 名下超过一页（1000 条）早就远超上限了，不必翻页
    keys = (await env.PIGEON_KV.list<SlotMeta>({ prefix: slotPrefix(channel.ownerId) })).keys;
  } catch {
    return null;
  }
  const self = slotKey(channel.ownerId, channel.id, messageId);
  const live = keys.filter((key) => {
    if (key.name === self) return false;
    const until = (key.metadata as SlotMeta | undefined)?.until;
    // 没有截止时刻的按在响算，由 KV 的过期兜底
    return typeof until !== "number" || until > now;
  });
  const inChannel = slotPrefix(channel.ownerId, channel.id);
  if (live.filter((key) => key.name.startsWith(inChannel)).length >= MAX_REPEATS_PER_CHANNEL) return "channel";
  if (live.length >= MAX_REPEATS_PER_ACCOUNT) return "account";
  return null;
}

/** 提醒结束，腾出占位。旧记录没记创建者，也就没有占位。出错不抛：占位最晚到截止时刻自己失效 */
async function releaseSlot(env: Env, record: Pick<RepeatRecord, "ownerId" | "channelId" | "messageId">): Promise<void> {
  if (!record.ownerId) return;
  try {
    await env.PIGEON_KV.delete(slotKey(record.ownerId, record.channelId, record.messageId));
  } catch {
    // 腾不掉就等它过期
  }
}

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

/**
 * 重复提醒记录的 metadata：下一次该响的时刻。cron 列键时就挑得出哪些到点了、先补最早到点的，
 * 没到点的一条也不读。这一版之前写下的记录没有它，读一次才知道 —— 下次写回时补上
 */
interface RepeatMeta {
  nextAt: number;
}

async function putRepeat(env: Env, record: RepeatRecord, now: number): Promise<void> {
  // KV 的 expirationTtl 最短 60 秒
  const ttl = Math.max(60, Math.ceil((record.until - now) / 1000) + REPEAT_TTL_MARGIN_SECONDS);
  const metadata: RepeatMeta = { nextAt: record.nextAt };
  await env.PIGEON_KV.put(repeatKey(record.channelId, record.messageId), JSON.stringify(record), {
    expirationTtl: ttl,
    metadata,
  });
}

/**
 * 原消息送到之后排上第一次补发。同一个 id 已经排过的整条覆盖：发送方又推了一遍同一件事，
 * 提醒从这一刻重新算，用的也是最新的内容。
 * 写失败不抛 —— 消息已经送到了，少了提醒也好过让发送方以为推送失败。
 */
async function scheduleRepeat(
  env: Env,
  channel: Pick<Channel, "id" | "ownerId">,
  params: PushParams & { id: string },
  every: number,
  original: { sentAt: number; truncated: boolean; from?: string },
  plan?: DeliverOptions["reminderPlan"],
  now = Date.now(),
): Promise<DeliveryReport["repeat"]> {
  const record: RepeatRecord = {
    channelId: channel.id,
    messageId: params.id,
    params,
    every,
    nextAt: plan?.firstAt ?? now + every * 60_000,
    until: plan?.until ?? now + REPEAT_WINDOW_MS,
    count: 1,
    sentAt: original.sentAt,
    ...(original.truncated ? { truncated: true } : {}),
    ownerId: channel.ownerId,
    ...(original.from ? { from: original.from } : {}),
  };
  try {
    await putRepeat(env, record, now);
  } catch {
    return undefined;
  }
  // 占位写不进去不影响提醒本身：少数一条，好过丢掉一条已经排上的提醒
  try {
    const meta: SlotMeta = { until: record.until };
    await env.PIGEON_KV.put(slotKey(channel.ownerId, channel.id, params.id), "", {
      expirationTtl: Math.max(60, Math.ceil((record.until - now) / 1000)),
      metadata: meta,
    });
  } catch {
    // 见上
  }
  return { every, until: record.until, id: record.messageId };
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
    const record = await env.PIGEON_KV.get<RepeatRecord>(key, "json");
    if (record === null) return false;
    await env.PIGEON_KV.delete(key);
    await releaseSlot(env, { ownerId: record.ownerId, channelId, messageId });
    return true;
  } catch {
    return false;
  }
}

/**
 * 一轮补发用到这么多子请求（KV 操作加上 APNs 请求）就不再开始新的一条。
 * Workers 一次调用最多 1000 个：原先不数，排到一百多条之后每次 KV 操作都抛错、被逐条吞掉，
 * 键名排在后面的通道每一轮都补发不出来，巡检记录却照样写着 ok
 */
export const REMINDER_SOFT_LIMIT = 700;
/**
 * 补发一条之前按人和设备估一遍开销（见 deliveryCost），加上已经用掉的超过这个数，就这一轮到此为止，
 * 剩下的顺延到下一轮。留出的一截给收尾：记下这一轮、必要时通知运营者
 */
export const REMINDER_LIMIT = 900;

/** 一轮补发做了什么。也原样记进 sweep:reminders（见 watch.ts sweepReminders） */
export interface ReminderReport {
  /** 补发出去的 */
  sent: number;
  /** 认领了、停用了、通道没了、过了截止，撤掉的 */
  stopped: number;
  /** 到点了、但这一轮额度用完没轮上，顺延到下一轮的 */
  deferred: number;
  /** 处理时抛了异常的（日志里有） */
  errors: number;
  kvOps: number;
  fetches: number;
}

/**
 * cron 每轮：把到点的重复提醒补发一次，直到有人认领、消息恢复或过了截止时刻。
 *
 * 补发沿用原消息的 id —— 它就是 apns-collapse-id，新的一次原地替换上一次，通知中心里
 * 始终只有一条；payload 带上 reminder（第几次），App 据此显示「第 N 次提醒」。
 *
 * 先列键，按 metadata 挑出到点的、最早到点的排前面（没有 metadata 的旧记录读一次才知道，排最前）；
 * 数着子请求，额度快用完就停，剩下的顺延 —— 下一轮它们到点最早，排在最前面，不会总是同一批补不上。
 * 每条独立 try/catch，一条出错不影响其它；补发成功之后才推进计数，中途失败下轮重来。
 */
export async function runReminders(raw: Env, now: number = Date.now()): Promise<ReminderReport> {
  const meter = meteredEnv(raw);
  const env = meter.env;
  const report: ReminderReport = { sent: 0, stopped: 0, deferred: 0, errors: 0, kvOps: 0, fetches: 0 };
  const due = (await listEntries<RepeatMeta>(env, REPEAT))
    .filter((entry) => !(typeof entry.metadata?.nextAt === "number" && now < entry.metadata.nextAt))
    .map((entry) => ({ name: entry.name, at: entry.metadata?.nextAt ?? 0 }))
    .sort((a, b) => a.at - b.at);

  for (let i = 0; i < due.length; i++) {
    const { name } = due[i] as { name: string };
    if (meter.used() >= REMINDER_SOFT_LIMIT) {
      report.deferred += due.length - i;
      break;
    }
    try {
      const record = await env.PIGEON_KV.get<RepeatRecord>(name, "json");
      if (!record || now < record.nextAt) continue;

      // 截止看的是「这一次本该在什么时候响」，不是 cron 实际跑到的时刻：间隔 60 分钟的提醒
      // 本该正好在截止那一刻响，而 cron 总要晚到几分钟 —— 按实际时刻比，它一次也响不了
      const expired = record.nextAt > record.until;
      const channel = expired ? null : await getChannel(env, record.channelId);
      if (!channel || channel.suspended || (await isAcked(env, record.channelId, record.messageId))) {
        await env.PIGEON_KV.delete(name);
        // 过了截止的占位已经不算数，省一次删除；认领、停用、删通道停下的要腾出来，不然白占到截止
        if (!expired) await releaseSlot(env, record);
        report.stopped += 1;
        continue;
      }

      // 读这群人的账号、再推一遍，这一轮还够不够。第一条例外：单独一条就超过上限的（人多、设备多），
      // 永远等不到够的那一轮 —— 让它在一轮开头推，推得出去多少算多少
      const first = report.sent === 0;
      if (!first && meter.used() + 1 + channel.memberIds.length > REMINDER_LIMIT) {
        report.deferred += due.length - i;
        break;
      }
      const recipients = await recipientsOf(env, channel);
      if (!first && meter.used() + deliveryCost(recipients) + 2 > REMINDER_LIMIT) {
        report.deferred += due.length - i;
        break;
      }

      const count = record.count + 1;
      await deliver(env, channel, recipients, record.params, {
        reminder: count,
        // 补发是同一件事再响一次，发出时刻沿用原消息的。旧记录没存，按截止时刻倒推回原消息那一刻
        sentAt: record.sentAt ?? record.until - REPEAT_WINDOW_MS,
        truncated: record.truncated,
        from: record.from,
      });
      report.sent += 1;
      const next: RepeatRecord = { ...record, count, nextAt: now + record.every * 60_000 };
      // 下一次已经落在截止之后：现在就删，不必留着等下一轮来删
      if (next.nextAt > next.until) {
        await env.PIGEON_KV.delete(name);
        await releaseSlot(env, record);
        // 最后一次也响过了、还是没人认领：推送时带了 callback 的，告诉发送方（见 receipts.ts）
        await onRepeatExpired(env, record.channelId, record.messageId, count);
      } else {
        await putRepeat(env, next, now);
      }
    } catch (err) {
      // 单条提醒的任何异常都不该影响其它提醒。但要记下来：原先一声不吭地吞掉，额度用完之后整片失败也没人知道
      report.errors += 1;
      console.error("重复提醒补发出错", err);
    }
  }
  report.kvOps = meter.ops();
  report.fetches = meter.fetches();
  return report;
}
