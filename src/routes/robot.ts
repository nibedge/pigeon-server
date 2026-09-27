import { explainFailures } from "../apns";
import { BodyTooLarge, declaredTooLarge, MAX_HOOK_BODY_BYTES, readBody } from "../body";
import { genericMessage } from "../compat/generic";
import { detectRobotStyle, robotMessage, type RobotStyle } from "../compat/robot";
import { contentRejection } from "../contentfilter";
import { resolveChannel } from "../db";
import { plaintextRejection, suspensionRejection } from "../policy";
import {
  allowKeyMiss,
  allowPush,
  deliver,
  hasContent,
  ignoredParams,
  KEY_MISS_MESSAGE,
  paramsFromJson,
  throttledMessage,
  withDefaults,
} from "../push";
import { RATE_WINDOW_SECONDS } from "../ratelimit";
import type { Env, PushParams } from "../types";

/**
 * 群机器人格式的入口：请求体按 msgtype、msg_type、embeds、blocks 四种结构解析（见 compat/robot.ts），
 * 响应也按调用方熟悉的样子回 —— 发送方判断成败看的是原平台的返回：errcode 是不是 0、code 是不是 0、
 * 是不是 204、正文是不是 ok。回我们自己的 {"code":200} 信封，有的工具会当成失败一直重试。
 *
 * 两种走法：
 *   /{key} 收到这几种结构的 JSON：按结构认格式；
 *   兼容地址：只能填完整机器人地址的工具，把域名换成这里就行 ——
 *     /cgi-bin/webhook/send?key={key}          msgtype 风格
 *     /robot/send?access_token={key}           msgtype 风格（后面拼的 timestamp、sign 不看：key 本身就是凭据）
 *     /open-apis/bot/v2/hook/{key}             msg_type 风格（请求体里的 timestamp、sign 同样不看）
 *     /api/webhooks/{任意}/{key}                embeds 风格（/api/v10/webhooks/… 也认）
 *     /services/{任意…}/{key}                   blocks 风格
 *
 * 地址后面还可以拼信鸽自己的参数（?level=timeSensitive&repeat=5），它们盖过从消息里读出来的。
 */

/** 一次请求的结果，按格式换成对方熟悉的样子 */
interface Outcome {
  status: number;
  message: string;
  /** 成功时：消息 id、送达几台、提示 */
  id?: string;
  delivered?: number;
  devices?: number;
  warnings?: string[];
  ignored?: string[];
  suppressed?: boolean;
  channelId?: string;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function jsonResponse(status: number, body: unknown, retry?: boolean): Response {
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (retry) headers["retry-after"] = String(RATE_WINDOW_SECONDS);
  return new Response(JSON.stringify(body), { status, headers });
}

/** 成功时附带的信鸽自己的字段：不影响对方的判断，排查时有用 */
function extras(o: Outcome): Record<string, unknown> {
  return {
    ...(o.id ? { id: o.id } : {}),
    ...(o.delivered !== undefined ? { delivered: o.delivered, devices: o.devices } : {}),
    ...(o.suppressed ? { suppressed: "duplicate" } : {}),
    ...(o.warnings?.length ? { warnings: o.warnings } : {}),
    ...(o.ignored?.length ? { ignored: o.ignored } : {}),
  };
}

/**
 * 按格式回话。失败时 HTTP 状态码照实给（4xx 是请求的问题、5xx 可以重试），正文用对方的形状、中文原因；
 * 429 一律带 Retry-After
 */
export function robotReply(style: RobotStyle, o: Outcome, url: URL): Response {
  const ok = o.status >= 200 && o.status < 300;
  const retry = o.status === 429;
  switch (style) {
    case "msgtype":
      return ok
        ? jsonResponse(200, { errcode: 0, errmsg: "ok", ...extras(o) })
        : jsonResponse(o.status, { errcode: o.status, errmsg: o.message }, retry);
    case "msg_type":
      return ok
        ? jsonResponse(200, {
            code: 0,
            msg: "success",
            data: extras(o),
            StatusCode: 0,
            StatusMessage: "success",
          })
        : jsonResponse(o.status, { code: o.status, msg: o.message, data: {} }, retry);
    case "embeds": {
      if (!ok) return jsonResponse(o.status, { code: o.status, message: o.message }, retry);
      // 带 ?wait=true 的调用方要拿回消息对象（至少有 id）；不带的，成功就是 204 空响应
      if (url.searchParams.get("wait") === "true") {
        return jsonResponse(200, {
          id: o.id ?? "",
          type: 0,
          content: "",
          channel_id: o.channelId ?? "",
          timestamp: new Date().toISOString(),
          ...extras(o),
        });
      }
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }
    case "blocks": {
      const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };
      if (retry) headers["retry-after"] = String(RATE_WINDOW_SECONDS);
      return new Response(ok ? "ok" : o.message, { status: ok ? 200 : o.status, headers });
    }
  }
}

export interface RobotBody {
  style: RobotStyle;
  payload: unknown;
}

/**
 * /{key} 的 POST：先看一眼请求体是不是群机器人格式。是就交给 handleRobotPush；不是就原样交回，
 * 由路径式推送照常处理。读过的请求体按原样重新装进一个新的请求，后面照读不误。
 *
 * 只看 JSON（和没写类型、text/* 里装着 JSON 的）；声明的长度已经超了的不看，由路径式推送回 413。
 * 边读边超了上限：回 413 的响应
 */
export async function peekRobotBody(request: Request): Promise<{ request: Request; robot?: RobotBody } | Response> {
  if (request.method !== "POST" || declaredTooLarge(request)) return { request };
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!(type.includes("json") || type === "" || type.startsWith("text/"))) return { request };
  let raw: Uint8Array;
  try {
    raw = await readBody(request);
  } catch (err) {
    if (err instanceof BodyTooLarge) {
      return jsonResponse(413, { code: 413, message: err.message, timestamp: Math.floor(Date.now() / 1000) });
    }
    throw err;
  }
  const rebuilt = new Request(request.url, { method: request.method, headers: request.headers, body: raw });
  const textBody = new TextDecoder().decode(raw);
  if (!textBody.trimStart().startsWith("{")) return { request: rebuilt };
  let payload: unknown;
  try {
    payload = JSON.parse(textBody);
  } catch {
    return { request: rebuilt };
  }
  const style = detectRobotStyle(payload);
  return style ? { request: rebuilt, robot: { style, payload } } : { request: rebuilt };
}

/** 地址后面拼的信鸽参数：?level=…&repeat=…。别家的 key、access_token、timestamp、sign 不是参数，自然不收 */
function queryParams(url: URL): PushParams {
  const entries = [...url.searchParams.entries()].filter(([name]) => !/^(key|access_token|wait|thread_id)$/i.test(name));
  return paramsFromJson(Object.fromEntries(entries));
}

/** 一条群机器人消息 → 推送参数（还没合上通道默认值） */
export function robotParams(style: RobotStyle, payload: unknown): { own: PushParams; warnings: string[] } {
  const m = robotMessage(style, payload);
  const own: PushParams = {};
  if (m.title) own.title = m.title;
  if (m.subtitle) own.subtitle = m.subtitle;
  if (m.body) own.body = m.body;
  if (m.markdown) own.markdown = m.markdown;
  if (m.url) own.url = m.url;
  if (m.image) own.image = m.image;
  else if (m.icon) own.icon = m.icon;
  // @所有人：发送方明说了人人都得看，升到时效性（专注模式下也提醒）。不升到 critical —— 那要穿透每个人的免打扰
  if (m.mentionAll) own.level = "timeSensitive";
  return { own, warnings: m.warnings };
}

/**
 * 解析 + 推送 + 回话，/{key} 和兼容地址共用。style 决定怎么解析请求体，reply 决定怎么回话
 * （兼容地址按地址回话：调用方以为自己在跟那一家说话，请求体长什么样不影响它怎么判断成败）
 */
async function robotPush(
  request: Request,
  env: Env,
  url: URL,
  key: string,
  parse: () => { own: PushParams; warnings: string[] },
  reply: (o: Outcome) => Response,
): Promise<Response> {
  const resolved = await resolveChannel(env, key);
  if (!resolved) {
    if (!(await allowKeyMiss(env, request))) return reply({ status: 429, message: KEY_MISS_MESSAGE });
    return reply({ status: 404, message: "这个 key 不存在：检查地址里的 key 有没有抄错（在信鸽 App 的通道设置里复制）" });
  }
  const { channel, recipients } = resolved;
  const suspended = suspensionRejection(channel);
  if (suspended) return reply({ status: 403, message: suspended });
  if (!(await allowPush(env, channel, recipients))) return reply({ status: 429, message: throttledMessage(channel) });

  const parsed = parse();
  const fromQuery = queryParams(url);
  const own: PushParams = { ...parsed.own, ...fromQuery };
  const params = withDefaults(channel, own);
  if (!hasContent(params)) return reply({ status: 400, message: "没有内容可推：消息里没有认得出的文字" });
  const rejection = plaintextRejection(channel, params, own);
  if (rejection) return reply({ status: 400, message: rejection });
  const blocked = await contentRejection(env, channel, params);
  if (blocked) return reply({ status: 400, message: blocked });

  const report = await deliver(env, channel, recipients, params);
  const warnings = [...parsed.warnings, ...(report.warnings ?? [])];
  // 不生效的参数只看地址上拼的：消息里读出来的 markdown 是我们自己放的
  const ignored = ignoredParams(fromQuery);
  const common = { id: report.messageId, warnings, ignored, channelId: channel.id };
  if (report.rejection) return reply({ status: report.rejection.status, message: report.rejection.message });
  if (report.suppressed) return reply({ status: 200, message: "ok", suppressed: true, ...common });
  if (report.results.length === 0) return reply({ status: 410, message: "这个通道下没有可用设备，请在信鸽 App 里重新注册" });
  if (report.delivered === 0) {
    const failure = explainFailures(report.results);
    return reply({ status: failure.status, message: failure.message });
  }
  return reply({ status: 200, message: "ok", delivered: report.delivered, devices: report.results.length, ...common });
}

/** /{key} 收到群机器人格式的请求体 */
export function handleRobotPush(request: Request, env: Env, url: URL, key: string, robot: RobotBody): Promise<Response> {
  return robotPush(
    request,
    env,
    url,
    key,
    () => robotParams(robot.style, robot.payload),
    (o) => robotReply(robot.style, o, url),
  );
}

/** 兼容地址 → 回话的格式和 key；认不出的地址返回 null */
function mirrorRoute(url: URL, segments: string[]): { style: RobotStyle; key: string | undefined } | null {
  const [head, ...rest] = segments;
  switch (head) {
    case "cgi-bin":
      return rest.join("/") === "webhook/send" ? { style: "msgtype", key: url.searchParams.get("key") ?? undefined } : null;
    case "robot":
      return rest.join("/") === "send" ? { style: "msgtype", key: url.searchParams.get("access_token") ?? undefined } : null;
    case "open-apis":
      return rest.length === 4 && rest.slice(0, 3).join("/") === "bot/v2/hook" ? { style: "msg_type", key: rest[3] } : null;
    case "api": {
      // /api/webhooks/{id}/{key}，也认带版本号的 /api/v10/webhooks/{id}/{key}，和只有一段的 /api/webhooks/{key}
      const path = /^v\d+$/.test(rest[0] ?? "") ? rest.slice(1) : rest;
      if (path[0] !== "webhooks" || path.length < 2 || path.length > 3) return null;
      return { style: "embeds", key: path.at(-1) };
    }
    case "services":
      return rest.length >= 1 ? { style: "blocks", key: rest.at(-1) } : null;
    default:
      return null;
  }
}

/** 兼容地址上的请求体：JSON；也认表单里装着 JSON 的（payload、payload_json 字段） */
async function mirrorPayload(request: Request): Promise<unknown> {
  const raw = await readBody(request, MAX_HOOK_BODY_BYTES);
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (type.includes("multipart/form-data")) {
    const form = await new Response(raw, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
    const inner = form.get("payload_json") ?? form.get("payload");
    return typeof inner === "string" ? JSON.parse(inner) : Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string"));
  }
  const text = new TextDecoder().decode(raw);
  if (type.includes("form-urlencoded")) {
    const form = new URLSearchParams(text);
    const inner = form.get("payload") ?? form.get("payload_json");
    return inner !== null ? JSON.parse(inner) : Object.fromEntries(form.entries());
  }
  return JSON.parse(text);
}

/**
 * 兼容地址。请求体按它自己的结构认格式（一个 msgtype 风格的地址收到 blocks 风格也照样读得懂）；
 * 都不像时先按信鸽自己的参数读（title、body……），再不行按通用 JSON 取。回话一律按地址的格式
 */
export async function handleRobotMirror(request: Request, env: Env, url: URL, segments: string[]): Promise<Response> {
  const route = mirrorRoute(url, segments);
  if (!route) return jsonResponse(404, { code: 404, message: "没有这个接口", timestamp: Math.floor(Date.now() / 1000) });
  const reply = (o: Outcome) => robotReply(route.style, o, url);
  if (request.method !== "POST") {
    return reply({ status: 405, message: "这个地址只收 POST：把它填进发消息的工具里，由工具来发" });
  }
  if (!route.key) {
    return reply({
      status: 400,
      message: route.style === "msgtype" ? "地址里少了 key：应为 ?key={key} 或 ?access_token={key}" : "地址里少了 key",
    });
  }
  if (declaredTooLarge(request, MAX_HOOK_BODY_BYTES)) {
    return reply({ status: 413, message: new BodyTooLarge(MAX_HOOK_BODY_BYTES).message });
  }
  let payload: unknown;
  try {
    payload = await mirrorPayload(request);
  } catch (err) {
    if (err instanceof BodyTooLarge) return reply({ status: 413, message: err.message });
    return reply({ status: 400, message: "请求体不是合法的 JSON" });
  }
  const key = route.key;
  const parse = (): { own: PushParams; warnings: string[] } => {
    const style = detectRobotStyle(payload);
    if (style) return robotParams(style, payload);
    // 不是任何一种群机器人格式：先当信鸽自己的参数，一样都没有再按通用 JSON 取
    const native = payload && typeof payload === "object" && !Array.isArray(payload) ? paramsFromJson(payload as Record<string, unknown>) : {};
    if (native.title || native.body || native.subtitle) return { own: native, warnings: [] };
    const generic = genericMessage(payload);
    const own: PushParams = { ...native };
    if (generic.title) own.title = generic.title;
    if (generic.body) own.body = generic.body;
    if (generic.url) own.url ??= generic.url;
    return { own, warnings: generic.title || generic.body ? ["请求体不是群机器人格式，已按通用 JSON 取了标题和字段"] : [] };
  };
  return robotPush(request, env, url, key, parse, reply);
}
