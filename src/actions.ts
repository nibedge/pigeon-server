import { timingSafeEqual } from "./db";
import type { Channel, Env, PushParams } from "./types";

/**
 * 通知上的自定义按钮（推送参数 actions）与事件回调地址（推送参数 callback）。
 *
 * 按钮定义随推送整份下发到每台设备（payload 的 actions，紧凑 JSON 字符串），外加服务端的签名 act_sig。
 * 有人点了要服务端经手的按钮（http、reply），App 把这两样原样交回来（见 routes/actions.ts）：
 * 服务端核对签名，确认按钮真是从这个通道推出去的、一个字没改过，再替他去请求按钮的地址。
 * 服务端因此不必为每条带按钮的推送存任何东西 —— 推送热路径上一次写入都不加。
 *
 * 没有签名的话，任何成员都能编一个按钮交上来，让服务端带着通道的回调签名去请求任意地址。
 */

/** 一条推送最多几个按钮。锁屏上长按展开时再多就要滚动，手表上也放不下 */
export const MAX_ACTIONS = 3;
/** 按钮名最多几个字（按字形算，一个 emoji 算一个）。长了在锁屏菜单里会被截掉 */
export const MAX_LABEL = 20;
/**
 * 按钮定义（紧凑 JSON）在 payload 里最多占多少字节。按钮是整份签名的，截不得；
 * 给它单独一个上限，正文还剩 2KB 多（约 700 个汉字）可截可放
 */
export const MAX_ACTIONS_BYTES = 1500;
/** 复制按钮的内容上限 */
const MAX_COPY = 500;
/** 按钮自带的请求头最多几个 */
const MAX_HEADERS = 8;
const MAX_URL = 1024;

export type ActionType = "open" | "http" | "copy" | "reply";
const ACTION_TYPES = new Set<ActionType>(["open", "http", "copy", "reply"]);
/** 服务端代发请求时认的方法。其余（CONNECT、TRACE 之类）一概不代发 */
export const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/**
 * 一个按钮。
 * - open：点了在手机上打开 url（https）
 * - http：点了由服务端去请求 url（https），带上通道回调密钥的签名；不给 url 的只记进回执、推给 callback
 * - copy：点了把 value 复制到剪贴板
 * - reply：点了弹出输入框，写的话交给服务端：记进回执、推给 callback；给了 url 的再发到 url
 */
export interface Action {
  type: ActionType;
  label: string;
  url?: string;
  /** http 的请求方法，默认 POST。reply 总是 POST */
  method?: string;
  headers?: Record<string, string>;
  /** http 的请求体原文。不给时 POST / PUT / PATCH 发一份说明谁点了什么的 JSON（同回调事件） */
  body?: string;
  /** copy 要复制的内容 */
  value?: string;
  /** 危险操作：按钮显示成红色，点之前要解锁手机 */
  destructive?: boolean;
  /** 点之前要解锁手机 */
  auth?: boolean;
}

/** 服务端会经手的按钮：点了要交回服务端。open、copy 在手机上就地完成 */
export function isServerAction(action: Pick<Action, "type">): boolean {
  return action.type === "http" || action.type === "reply";
}

// ── 地址 ────────────────────────────────────────────────────────────

/** 这些结尾的主机名只在内网或本机有意义，公网上解析不到或者解析到别人家里去 */
const PRIVATE_SUFFIXES = [
  ".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".private",
  ".home.arpa", ".test", ".invalid", ".example", ".onion",
];

/** 信鸽自己的地址：按钮和回调不能指回来 —— 服务端请求自己，一圈下来谁也说不清是哪条推送触发的 */
const OWN_HOSTS = ["nfo.im"];
/**
 * workers.dev 上的备用入口（wrangler.toml 的 workers_dev = true）：pigeon.{账号子域}.workers.dev。
 * 从 nfo.im 推来的按钮指向它，推送时的 ownHost 是 nfo.im，认不出来。别人部署在 workers.dev 上的服务照收
 */
const OWN_WORKERS_DEV = /^pigeon\.[a-z0-9-]+\.workers\.dev$/;

/**
 * 按钮和回调的地址能不能用，能用返回 null，不能用返回中文原因。
 *
 * 只收 https、只收域名：IP 地址（含 127.0.0.1、10.x、[::1] 这类）一律不收，内网专用的后缀、单段主机名、
 * localhost 也不收 —— 服务端替人发请求，就不能被指着去探别处的内网。地址里带账号密码的也不收：
 * 它会随推送落到每个接收者手机上。
 * ownHost：这次请求到达的主机（线上是 nfo.im，自建的实例是它自己的域名）
 */
export function urlProblem(raw: string, what: string, ownHost?: string): string | null {
  if (raw.length > MAX_URL) return `${what}太长了（最多 ${MAX_URL} 个字符）`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `${what}不是完整的网址：${clip(raw)}`;
  }
  if (url.protocol !== "https:") return `${what}只收 https 地址：${clip(raw)}`;
  if (url.username || url.password) return `${what}里不能带账号密码：它会随推送落到每个接收者手机上`;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || /^[\d.]+$/.test(host) || /^0x/i.test(host)) {
    return `${what}要写域名，不收 IP 地址：${clip(raw)}`;
  }
  if (!host.includes(".") || host === "localhost" || PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) {
    return `${what}要是公网上的域名：${host} 只在内网或本机有意义`;
  }
  const own = [...OWN_HOSTS, ...(ownHost ? [ownHost.toLowerCase()] : [])];
  if (own.some((h) => host === h || host.endsWith(`.${h}`)) || OWN_WORKERS_DEV.test(host)) return `${what}不能指向信鸽自己`;
  return null;
}

function clip(text: string, max = 60): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

// ── 解析 ────────────────────────────────────────────────────────────

/** 紧凑写法的键名（payload 里用这套），解析时和完整写法一样认，规整过的再规整一遍结果不变 */
const SHORT_KEYS: Record<string, keyof Action> = {
  t: "type", l: "label", u: "url", m: "method", h: "headers", b: "body", v: "value", d: "destructive", a: "auth",
};

/** 请求头名：HTTP 的 token 字符 */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
/** 这些头由服务端自己定（签名、长度、连接），按钮不能改 */
const RESERVED_HEADERS = new Set([
  "host", "content-length", "connection", "transfer-encoding", "keep-alive", "upgrade", "te", "trailer",
  "expect", "proxy-authorization", "proxy-connection", "user-agent",
]);

/**
 * 凭据类请求头不收：按钮定义（连同请求头）随推送整份落到每个接收者手机上，还进 App 历史 ——
 * 和地址里带账号密码同一个理由。要让接收方确认请求真是信鸽发的，核对 X-Pigeon-Signature
 */
function isCredentialHeader(name: string): boolean {
  const n = name.toLowerCase();
  return n === "authorization" || n === "cookie" || n.startsWith("proxy-");
}

function isReservedHeader(name: string): boolean {
  const n = name.toLowerCase();
  return RESERVED_HEADERS.has(n) || n.startsWith("x-pigeon-") || n.startsWith("cf-") || n.startsWith("x-forwarded-");
}

type Parsed = { actions: Action[] } | { error: string };

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true" || value === "yes";
}

/** 一项 JSON 写法的按钮 → Action。完整键名、紧凑键名都认；错了返回中文原因 */
function actionFromObject(raw: unknown, index: number, ownHost?: string): Action | string {
  const where = `第 ${index + 1} 个按钮`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `${where}要写成 {"label": …} 这样的对象`;
  const input: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    input[SHORT_KEYS[k] ?? k.toLowerCase()] = v;
  }
  // 复制的内容也可以叫 text、copy
  input.value ??= input.text ?? input.copy;

  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (!label) return `${where}没有名字（label）`;
  if (/[\u0000-\u001f\u007f]/.test(label)) return `${where}的名字里有控制字符`;
  if (Array.from(label).length > MAX_LABEL) return `按钮名最多 ${MAX_LABEL} 个字：「${clip(label, 24)}」`;

  const url = typeof input.url === "string" && input.url.trim() ? input.url.trim() : undefined;
  const method = typeof input.method === "string" && input.method.trim() ? input.method.trim().toUpperCase() : undefined;
  const body = typeof input.body === "string" ? input.body : input.body === undefined || input.body === null ? undefined : JSON.stringify(input.body);
  const headersIn = input.headers;
  // 没写类型：给了请求方法、请求头或请求体的是 http；只有地址的是 open；什么都没有的是只回报的 http
  let type = (typeof input.type === "string" ? input.type.trim().toLowerCase() : "") as ActionType;
  if (!type) type = method || headersIn || body !== undefined ? "http" : url ? "open" : "http";
  if (!ACTION_TYPES.has(type)) return `${where}的类型「${clip(String(input.type), 20)}」不认识，只有 open、http、copy、reply`;

  const action: Action = { type, label };
  if (type === "open" || type === "http" || type === "reply") {
    if (type === "open" && !url) return `「${label}」是打开链接的按钮，要给 url`;
    if (url) {
      const problem = urlProblem(url, `「${label}」的地址`, ownHost);
      if (problem) return problem;
      action.url = url;
    }
  }
  if (type === "http") {
    if (method) {
      if (!HTTP_METHODS.has(method)) return `「${label}」的请求方法只能是 GET、POST、PUT、PATCH、DELETE`;
      if (method !== "POST") action.method = method;
    }
    if (headersIn !== undefined && headersIn !== null) {
      if (typeof headersIn !== "object" || Array.isArray(headersIn)) return `「${label}」的 headers 要写成 {"名字": "值"}`;
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(headersIn as Record<string, unknown>)) {
        if (!HEADER_NAME.test(name)) return `「${label}」的请求头名「${clip(name, 30)}」不合规`;
        if (isCredentialHeader(name)) {
          return `「${label}」不能带 ${name} 头：按钮连同请求头会随推送落到每个接收者手机上。要确认请求来自信鸽，请核对 X-Pigeon-Signature 签名`;
        }
        if (isReservedHeader(name)) return `「${label}」不能自己设 ${name} 头：它由服务端来定`;
        const text = typeof value === "number" ? String(value) : value;
        // 请求头只能是可见的 ASCII：换行会让一个头变成两个，非 ASCII 字符 fetch 直接报错
        if (typeof text !== "string" || !/^[\x20-\x7e]{0,512}$/.test(text)) return `「${label}」的请求头 ${name} 只能是 512 字以内的英文字符`;
        headers[name] = text;
      }
      if (Object.keys(headers).length > MAX_HEADERS) return `「${label}」最多带 ${MAX_HEADERS} 个请求头`;
      if (Object.keys(headers).length) action.headers = headers;
    }
    if (body !== undefined && body !== "") action.body = body;
    if (!url && (action.method || action.headers || action.body !== undefined)) {
      return `「${label}」给了请求方法、请求头或请求体，却没给 url`;
    }
  }
  if (type === "copy") {
    const value = typeof input.value === "string" || typeof input.value === "number" ? String(input.value) : "";
    if (!value) return `「${label}」是复制按钮，要给 value（要复制的内容）`;
    if (Array.from(value).length > MAX_COPY) return `「${label}」要复制的内容最多 ${MAX_COPY} 个字`;
    action.value = value;
  }
  if (truthy(input.destructive)) action.destructive = true;
  if (truthy(input.auth)) action.auth = true;
  return action;
}

/**
 * 简写：`名字=目标; 名字=目标`（分号或换行隔开，最多 3 个），给 curl 用，不必拼 JSON：
 *   查看=https://…              打开链接
 *   回滚=POST https://…         服务端代发（GET PUT PATCH DELETE 同理）
 *   单号=copy:SF1234            复制
 *   回复=reply  或 reply https://…
 *   收到                        只有名字：点了只记进回执、推给 callback
 * 名字前加 ! 是危险操作（红色、要先解锁）。名字到第一个 = 为止，地址里的 = 不受影响
 */
function actionsFromShorthand(text: string, ownHost?: string): Parsed {
  const parts = text.split(/[;\n]/).map((p) => p.trim()).filter(Boolean);
  const out: Action[] = [];
  for (const [i, part] of parts.entries()) {
    const eq = part.indexOf("=");
    let label = (eq >= 0 ? part.slice(0, eq) : part).trim();
    const target = eq >= 0 ? part.slice(eq + 1).trim() : "";
    let destructive = false;
    if (label.startsWith("!")) {
      destructive = true;
      label = label.slice(1).trim();
    }
    const raw: Record<string, unknown> = { label, ...(destructive ? { destructive: true } : {}) };
    const methodMatch = /^([A-Za-z]+)\s+(\S+)$/.exec(target);
    if (!target) raw.type = "http";
    else if (/^copy:/i.test(target)) Object.assign(raw, { type: "copy", value: target.slice(5).trim() });
    else if (/^reply(\s+\S+)?$/i.test(target)) Object.assign(raw, { type: "reply", url: target.slice(5).trim() || undefined });
    else if (methodMatch && HTTP_METHODS.has((methodMatch[1] ?? "").toUpperCase())) {
      Object.assign(raw, { type: "http", method: methodMatch[1], url: methodMatch[2] });
    } else if (/^\S+$/.test(target)) Object.assign(raw, { type: "open", url: target });
    else return { error: `第 ${i + 1} 个按钮看不懂：「${clip(part, 40)}」。写法是 名字=https://…、名字=POST https://…、名字=copy:内容、名字=reply` };
    const action = actionFromObject(raw, i, ownHost);
    if (typeof action === "string") return { error: action };
    out.push(action);
  }
  return { actions: out };
}

/** 规整成 payload 里的紧凑写法。键的顺序固定：同样的按钮总是同一串文字，签名才对得上 */
export function compactActions(actions: Action[]): string {
  return JSON.stringify(
    actions.map((a) => ({
      t: a.type,
      l: a.label,
      ...(a.url ? { u: a.url } : {}),
      ...(a.method ? { m: a.method } : {}),
      ...(a.headers ? { h: a.headers } : {}),
      ...(a.body !== undefined ? { b: a.body } : {}),
      ...(a.value !== undefined ? { v: a.value } : {}),
      ...(a.destructive ? { d: 1 } : {}),
      ...(a.auth ? { a: 1 } : {}),
    })),
  );
}

/**
 * actions 参数 → 按钮。JSON 数组（也认单个对象）或简写都行；错了返回中文原因。
 * 规整之后超过 MAX_ACTIONS_BYTES 的也算错：按钮整份签名，截短了就对不上
 */
export function parseActions(raw: string, ownHost?: string): Parsed {
  const text = raw.trim();
  if (!text) return { actions: [] };
  let parsed: Parsed;
  if (text.startsWith("[") || text.startsWith("{")) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { error: "actions 不是合法的 JSON。也可以用简写：名字=https://…; 名字=POST https://…" };
    }
    const list = Array.isArray(value) ? value : [value];
    const actions: Action[] = [];
    for (const [i, item] of list.entries()) {
      if (i >= MAX_ACTIONS) break;
      const action = actionFromObject(item, i, ownHost);
      if (typeof action === "string") return { error: action };
      actions.push(action);
    }
    parsed = list.length > MAX_ACTIONS ? { error: `一条推送最多 ${MAX_ACTIONS} 个按钮` } : { actions };
  } else {
    parsed = actionsFromShorthand(text, ownHost);
    if ("actions" in parsed && parsed.actions.length > MAX_ACTIONS) parsed = { error: `一条推送最多 ${MAX_ACTIONS} 个按钮` };
  }
  if ("error" in parsed) return parsed;
  const bytes = new TextEncoder().encode(JSON.stringify(compactActions(parsed.actions))).length;
  if (bytes > MAX_ACTIONS_BYTES) {
    return { error: `按钮的定义太长：${bytes} 字节，最多 ${MAX_ACTIONS_BYTES}（整条推送只有 4KB）。请缩短地址、请求头或请求体` };
  }
  return parsed;
}

/**
 * 这次请求自己带来的 actions、callback 有没有问题。有就回 400 —— 发送方写错了按钮，
 * 推出去一条没有按钮的通知，他要到手机上才发现。通道默认值里的错到投递时再丢掉（见 prepareInteraction）。
 * 只收加密的通道不收按钮：按钮的名字和地址没法加密，服务端还要照着它去请求
 */
/** 只收加密的通道为什么不收按钮。推送带了、设默认值、投递时丢掉，说的都是这一句 */
export const E2E_NO_ACTIONS = "这个通道只收加密消息：按钮的名字和地址没法加密，不能带 actions";

export function interactionRejection(
  channel: Pick<Channel, "policy">,
  own: PushParams,
  ownHost?: string,
  token?: { name: string },
): string | null {
  if (own.actions !== undefined && own.actions !== "") {
    if (channel.policy?.e2eOnly && own.delete !== "1") return E2E_NO_ACTIONS;
    const parsed = parseActions(own.actions, ownHost);
    if ("error" in parsed) return parsed.error;
    // 发送令牌是「只能推送」的凭据（给 NAS、家人网页的那种）。要服务端代发请求的按钮会带着通道回调密钥的签名
    // 去请求推送方写的地址、带推送方写的请求体 —— 令牌推一个指向群主回滚接口的按钮、等成员点一下，
    // 群主那边的签名校验照样通过。这种按钮只该由通道的创建者定：用推送 key 推，或者设成通道默认按钮
    const proxied = token ? parsed.actions.find((a) => isServerAction(a) && a.url) : undefined;
    if (token && proxied) {
      return `发送令牌「${token.name}」推的消息不能带要服务端代发请求的按钮（「${proxied.label}」）：代发的请求带着通道回调密钥的签名，只能由通道的创建者定 —— 请用推送 key，或者请他设成通道默认按钮。打开链接、复制、不带地址的按钮照常能用`;
    }
  }
  if (own.callback) {
    const problem = urlProblem(own.callback.trim(), "callback", ownHost);
    if (problem) return problem;
  }
  return null;
}

/** 通道默认值里每一项的长度上限（见 routes/account.ts 的 PATCH 通道）。超了会被截断 */
export const MAX_DEFAULT_VALUE = 200;

/**
 * 创建者给通道设默认的 actions、callback 时先验一遍，有问题当场回绝（400）。
 * 否则要等到下一条推送才在 warnings 里看到「按钮没加上」—— 设默认值的人多半不看推送响应。
 * 默认值每项最多 200 字、超了会被截断：按钮定义和地址截断了就坏了，所以超长也算错
 */
export function defaultsRejection(defaults: Record<string, unknown>, ownHost?: string, e2eOnly = false): string | null {
  for (const name of ["actions", "callback"] as const) {
    const raw = defaults[name];
    if (raw === undefined || raw === null || raw === "") continue;
    // 只收加密的通道：默认按钮会随每条加密推送明文下发，和推送自己带 actions 一样不收
    if (name === "actions" && e2eOnly) return E2E_NO_ACTIONS;
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    if (Array.from(text).length > MAX_DEFAULT_VALUE) {
      return `默认的 ${name} 最多 ${MAX_DEFAULT_VALUE} 个字；更长的请在每次推送时带上`;
    }
    const problem = name === "callback" ? urlProblem(text.trim(), "默认回调地址", ownHost) : errorOf(parseActions(text, ownHost));
    if (problem) return problem;
  }
  return null;
}

function errorOf(parsed: Parsed): string | null {
  return "error" in parsed ? parsed.error : null;
}

// ── 签名 ────────────────────────────────────────────────────────────

/**
 * 按钮凭据 act_sig：HMAC-SHA256(K, 通道 id | 消息 id | 按钮定义原文) 的前 16 字节。
 * K 由 APNS_KEY_P8 派生，思路同认领凭据 ack_sig（见 groups.ts），用另一个前缀，两种凭据互不通用。
 *
 * 本地 API 测试没有 APNS_KEY_P8：run-api.sh 打开 PIGEON_TEST_ADMIN 时改用一段公开的测试用材料，
 * 签名照样签、照样核对，测试走得到这条路。两样都没有（没配私钥的自建实例）就不签发，
 * 服务端也不替任何按钮发请求 —— 核对不了的按钮，谁都能编
 */
const ACT_SIG_CONTEXT = "pigeon act-sig v1|";
const LOCAL_TEST_MATERIAL = "local-test-only";
const ACT_SIG_BYTES = 16;

let cachedActKey: { material: string; key: CryptoKey } | null = null;

/** 服务端签名用的材料（APNS_KEY_P8，本地测试时是公开的测试材料）。回调密钥的初始值也由它派生（见 receipts.ts） */
export function keyMaterial(env: Pick<Env, "APNS_KEY_P8" | "PIGEON_TEST_ADMIN">): string | null {
  if (env.APNS_KEY_P8) return env.APNS_KEY_P8;
  return env.PIGEON_TEST_ADMIN === "1" ? LOCAL_TEST_MATERIAL : null;
}

async function actKey(env: Pick<Env, "APNS_KEY_P8" | "PIGEON_TEST_ADMIN">): Promise<CryptoKey | null> {
  const material = keyMaterial(env);
  if (!material) return null;
  if (cachedActKey?.material === material) return cachedActKey.key;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ACT_SIG_CONTEXT + material));
  const key = await crypto.subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  cachedActKey = { material, key };
  return key;
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 这组按钮的凭据。签不了（没有密钥材料）返回 undefined */
export async function actionSignature(
  env: Pick<Env, "APNS_KEY_P8" | "PIGEON_TEST_ADMIN">,
  channelId: string,
  messageId: string,
  actions: string,
): Promise<string | undefined> {
  const key = await actKey(env);
  if (!key) return undefined;
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${channelId}|${messageId}|${actions}`));
  return b64url(new Uint8Array(mac).slice(0, ACT_SIG_BYTES));
}

/** 能不能核对按钮凭据。不能的话按钮一律不代发 */
export function canVerifyActions(env: Pick<Env, "APNS_KEY_P8" | "PIGEON_TEST_ADMIN">): boolean {
  return keyMaterial(env) !== null;
}

export async function actionSigValid(
  env: Pick<Env, "APNS_KEY_P8" | "PIGEON_TEST_ADMIN">,
  channelId: string,
  messageId: string,
  actions: string,
  sig: string,
): Promise<boolean> {
  const expected = await actionSignature(env, channelId, messageId, actions);
  return expected !== undefined && timingSafeEqual(sig, expected);
}

// ── 投递时 ──────────────────────────────────────────────────────────

/**
 * 投递前把按钮和回调规整好，给出按钮凭据。deliver 调用，params 就地改：
 * - actions 换成紧凑写法；有错（多半来自通道默认值，或者适配器、监控的推送）就去掉，说明放进 warnings
 * - callback 去掉首尾空白；有错同样去掉 —— 它不进 payload，只在投递之后记进回执（见 receipts.ts）
 * - 撤回不带按钮
 * - 只收加密的通道不带按钮：推送自己带的入口已经回了 400，走到这里的是通道默认值 ——
 *   先设了默认按钮、后打开「只收加密」的，按钮不能随每条密文明文下发
 */
export async function prepareInteraction(
  env: Env,
  channel: Pick<Channel, "id" | "policy">,
  messageId: string,
  params: PushParams,
  warnings: string[],
): Promise<string | undefined> {
  const channelId = channel.id;
  if (params.callback !== undefined) {
    const callback = params.callback.trim();
    const problem = callback ? urlProblem(callback, "callback") : "callback 是空的";
    if (problem) {
      delete params.callback;
      if (callback) warnings.push(`${problem}，事件不会回调`);
    } else {
      params.callback = callback;
    }
  }
  if (params.actions === undefined) return undefined;
  if (channel.policy?.e2eOnly && params.delete !== "1") {
    delete params.actions;
    warnings.push(`按钮没加上：${E2E_NO_ACTIONS}`);
    return undefined;
  }
  const parsed = params.delete === "1" ? { actions: [] } : parseActions(params.actions);
  if ("error" in parsed || parsed.actions.length === 0) {
    delete params.actions;
    if ("error" in parsed) warnings.push(`按钮没加上：${parsed.error}`);
    return undefined;
  }
  params.actions = compactActions(parsed.actions);
  // 签不出来就不带凭据：按钮照样显示，只是要经服务端的那几个点了会被拒
  return actionSignature(env, channelId, messageId, params.actions).catch(() => undefined);
}
