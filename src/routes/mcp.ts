import { explainFailures } from "../apns";
import { BodyTooLarge, readBodyText } from "../body";
import { contentRejection } from "../contentfilter";
import { resolveChannel } from "../db";
import { plaintextRejection, suspensionRejection } from "../policy";
import {
  allowKeyMiss,
  allowPush,
  deliver,
  hasContent,
  KEY_MISS_MESSAGE,
  paramsFromJson,
  REPEAT_MAX_MINUTES,
  throttledMessage,
  withDefaults,
} from "../push";
import { VERSION } from "./misc";
import type { Channel, Env, PushParams } from "../types";

/**
 * MCP（Model Context Protocol）入口：POST /mcp/{key}，让 AI 助手、编码助手自己推通知。
 *
 * 只做最小的一块：一个 notify 工具，参数同推送接口，推送走 deliver —— 去重、免打扰、重复提醒、限流、
 * 只收加密、群组违禁词，和别的入口一模一样。无状态：不发会话 id、不开 SSE 流，每个请求自带一切，
 * 回一个 application/json 的 JSON-RPC 响应。
 *
 * 两代协议都认（2026-09 的现状：客户端新旧并存）：
 *   新一代（2026-07-28 起）：没有 initialize 握手，每个请求在 params._meta 里带协议版本和客户端能力，
 *     HTTP 头 MCP-Protocol-Version、Mcp-Method（tools/call 还有 Mcp-Name）必须和请求体一致；必须实现 server/discover。
 *   上一代（2025-03-26 / 2025-06-18 / 2025-11-25）：先 initialize、再 notifications/initialized，
 *     之后的请求带 MCP-Protocol-Version 头；会话 id 由服务端决定发不发，这里不发。
 * 一个请求带着新一代的 _meta 就按新一代处理，发来 initialize 的按上一代处理。
 *
 * Origin 头不拦：DNS 重绑定防的是只绑在本机的 MCP 服务；这里是公网服务，凭据是地址里的 key，
 * 推送接口本身也对任何来源开放（CORS *）。拦了只会挡住在浏览器里跑的 MCP 客户端。
 */

/** 新一代协议版本（请求里带 _meta） */
export const MODERN_VERSIONS = ["2026-07-28"];
/** 上一代协议版本（先 initialize 握手）。第一个是握手时对方的版本不认得时回给它的 */
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const ALL_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER = "io.modelcontextprotocol/serverInfo";

const SERVER_INFO = { name: "pigeon", title: "信鸽Push", version: VERSION };

/** JSON-RPC 与 MCP 的错误码 */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_VERSION = -32022;
/**
 * 信鸽自己的错误（key 不存在、停用、限流）：MCP 规范要求自定义的错误码放在 JSON-RPC 保留段（-32768 到 -32000）之外。
 * 用 HTTP 状态码的负数，一眼看得出是哪一类
 */
const appError = (status: number) => -status;

/** 给 AI 看的使用说明：什么时候推、怎么写、同一件事怎么收尾 */
export const INSTRUCTIONS = [
  "用 notify 把一条通知推到用户手机上的信鸽 App。",
  "适合：一项较长的任务做完了、失败了、卡住需要用户回来决定时，各推一条；别为每个小步骤都推。",
  "title 写一句话结论（锁屏上只显示一行），body 写要点和下一步；可以带 url 让用户点开看详情。",
  "同一件事用同一个 id：再推会原地替换旧通知；事情了结时带同一个 id、status=resolved 再推一次。",
  "level=timeSensitive 会穿过专注模式，只在真的需要用户马上看时用；repeat 会每隔几分钟再提醒，直到用户点「知道了」。",
  "内容以明文经过信鸽服务器，别放密码、密钥之类的机密。",
].join("\n");

/** notify 工具的定义。参数名、取值和推送接口一致 */
export const NOTIFY_TOOL = {
  name: "notify",
  title: "推送到手机",
  description:
    "把一条通知推到用户手机上的信鸽 App。任务完成、失败、需要用户介入时使用。同一件事用同一个 id：再推会替换旧通知，事情了结时带同一个 id 和 status=resolved 再推一次。内容以明文经过服务器。",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "标题：一句话结论，锁屏上只显示一行" },
      body: { type: "string", description: "正文：要点和下一步，支持加粗、链接这类简单 Markdown" },
      level: {
        type: "string",
        enum: ["passive", "active", "timeSensitive"],
        description: "提醒强度：passive 静默送达；active 普通（默认）；timeSensitive 穿过专注模式，只在需要马上看时用",
      },
      url: { type: "string", description: "点通知打开的链接，比如 PR、构建日志、文档" },
      id: { type: "string", description: "同一件事的标识（64 字节以内）。同 id 的新通知原地替换旧的" },
      status: {
        type: "string",
        enum: ["firing", "resolved"],
        description: "firing 进行中；resolved 已了结（带同一个 id），重复提醒随之停下",
      },
      repeat: {
        type: "integer",
        minimum: 0,
        maximum: REPEAT_MAX_MINUTES,
        description: "每隔几分钟再提醒一次（5–60），直到用户点「知道了」，最长一小时。0 或不给 = 不重复",
      },
    },
    additionalProperties: false,
  },
  annotations: {
    title: "推送到手机",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

const NOTIFY_FIELDS = ["title", "body", "level", "url", "id", "status", "repeat"] as const;

// ── 回话 ────────────────────────────────────────────────────────────

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

type RpcId = string | number;

function rpc(status: number, message: Record<string, unknown>, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", ...message }), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

function rpcError(status: number, id: RpcId | undefined, code: number, message: string, data?: unknown): Response {
  return rpc(status, {
    ...(id !== undefined ? { id } : {}),
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  });
}

/** GET /mcp/{key}：这里不开 SSE 流，说清楚该怎么用 */
function methodNotAllowed(url: URL): Response {
  return new Response(
    JSON.stringify({
      code: 405,
      message: `MCP 地址只收 POST：把 https://${url.host}/mcp/{key} 填进 AI 助手的 MCP 设置（传输方式选 Streamable HTTP / http），由它来发请求`,
      timestamp: Math.floor(Date.now() / 1000),
    }),
    { status: 405, headers: { ...JSON_HEADERS, allow: "POST, OPTIONS" } },
  );
}

// ── 入口 ────────────────────────────────────────────────────────────

interface Message {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Authorization: Bearer {key}：不想把 key 写进地址（会进各种配置和日志）时用 */
function bearer(request: Request): string | undefined {
  return /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "")?.[1];
}

/** Mcp-Name 头的值：非 ASCII 的名字按 =?base64?…?= 编码 */
function decodeHeader(raw: string | null): string | null {
  if (raw === null) return null;
  const m = /^=\?base64\?(.*)\?=$/.exec(raw.trim());
  if (!m) return raw.trim();
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(m[1] ?? ""), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/**
 * POST /mcp/{key}（或 POST /mcp 加 Authorization: Bearer {key}）
 */
export async function handleMcp(request: Request, env: Env, url: URL, pathKey: string | undefined, extra: string | undefined): Promise<Response> {
  if (extra !== undefined) return rpcError(404, undefined, appError(404), `没有这个地址：MCP 地址是 https://${url.host}/mcp/{key}`);
  if (request.method === "GET" || request.method === "HEAD" || request.method === "DELETE") return methodNotAllowed(url);
  if (request.method !== "POST") return methodNotAllowed(url);

  let message: unknown;
  try {
    message = JSON.parse(await readBodyText(request));
  } catch (err) {
    if (err instanceof BodyTooLarge) return rpcError(413, undefined, INVALID_REQUEST, err.message);
    return rpcError(400, undefined, PARSE_ERROR, "请求体不是合法的 JSON");
  }
  if (Array.isArray(message)) return rpcError(400, undefined, INVALID_REQUEST, "不支持批量请求：一次发一条 JSON-RPC 消息");
  if (!isObject(message) || message.jsonrpc !== "2.0") {
    return rpcError(400, undefined, INVALID_REQUEST, "不是 JSON-RPC 2.0 消息");
  }
  const msg = message as Message;
  // 客户端发来的响应（回应服务端的请求）：这里从不向客户端发请求，收下即可
  if (typeof msg.method !== "string") {
    return "result" in msg || "error" in msg
      ? new Response(null, { status: 202 })
      : rpcError(400, undefined, INVALID_REQUEST, "缺少 method");
  }
  const method = msg.method;
  // 通知（没有 id）：notifications/initialized、notifications/cancelled……一律收下，不回内容
  if (!("id" in msg)) return new Response(null, { status: 202 });
  const id = msg.id;
  if (typeof id !== "string" && typeof id !== "number") return rpcError(400, undefined, INVALID_REQUEST, "id 必须是字符串或整数");

  const key = pathKey ?? bearer(request);
  if (!key) return rpcError(400, id, appError(400), `地址少了 key：MCP 地址是 https://${url.host}/mcp/{key}，key 在信鸽 App 的通道设置里`);
  const resolved = await resolveChannel(env, key);
  if (!resolved) {
    if (!(await allowKeyMiss(env, request))) return rpcError(429, id, appError(429), KEY_MISS_MESSAGE);
    return rpcError(404, id, appError(404), "这个 key 不存在：检查 MCP 地址里的 key 有没有抄错（在信鸽 App 的通道设置里复制）");
  }
  const suspended = suspensionRejection(resolved.channel);
  if (suspended) return rpcError(403, id, appError(403), suspended);

  const params = isObject(msg.params) ? msg.params : {};
  const meta = isObject(params._meta) ? params._meta : {};
  const declared = meta[META_VERSION];
  if (method !== "initialize" && typeof declared === "string") {
    return modern(request, env, id, method, params, meta, declared, resolved);
  }
  return legacy(request, env, id, method, params, resolved);
}

// ── 新一代：每个请求自带版本和能力 ──────────────────────────────────

async function modern(
  request: Request,
  env: Env,
  id: RpcId,
  method: string,
  params: Record<string, unknown>,
  meta: Record<string, unknown>,
  version: string,
  resolved: Resolved,
): Promise<Response> {
  if (!MODERN_VERSIONS.includes(version)) {
    return rpcError(400, id, UNSUPPORTED_VERSION, "Unsupported protocol version", { supported: ALL_VERSIONS, requested: version });
  }
  // 头和请求体必须一致：网关按头路由、服务端按请求体执行，两边说的不是一回事就拒
  const headerVersion = request.headers.get("mcp-protocol-version");
  if (headerVersion !== version) {
    return rpcError(400, id, HEADER_MISMATCH, `Header mismatch: MCP-Protocol-Version 头（${headerVersion ?? "缺"}）和 _meta 里的版本（${version}）不一致`);
  }
  if (!isObject(meta[META_CAPABILITIES])) {
    return rpcError(400, id, INVALID_PARAMS, `缺少 _meta["${META_CAPABILITIES}"]`);
  }
  const headerMethod = request.headers.get("mcp-method");
  if (headerMethod !== method) {
    return rpcError(400, id, HEADER_MISMATCH, `Header mismatch: Mcp-Method 头（${headerMethod ?? "缺"}）和请求体里的 method（${method}）不一致`);
  }
  if (method === "tools/call") {
    const headerName = decodeHeader(request.headers.get("mcp-name"));
    if (headerName !== params.name) {
      return rpcError(400, id, HEADER_MISMATCH, `Header mismatch: Mcp-Name 头（${headerName ?? "缺"}）和请求体里的工具名不一致`);
    }
  }

  const stamp = (result: Record<string, unknown>) =>
    rpc(200, { id, result: { resultType: "complete", ...result, _meta: { [META_SERVER]: SERVER_INFO } } });
  switch (method) {
    case "server/discover":
      return stamp({
        supportedVersions: ALL_VERSIONS,
        capabilities: { tools: {} },
        instructions: INSTRUCTIONS,
        ttlMs: 3_600_000,
        cacheScope: "public",
      });
    case "ping":
      return stamp({});
    case "tools/list":
      // 工具对谁都一样：可以公共缓存
      return stamp({ tools: [NOTIFY_TOOL], ttlMs: 3_600_000, cacheScope: "public" });
    case "tools/call": {
      const outcome = await callTool(request, env, params, resolved);
      if ("error" in outcome) return rpcError(200, id, outcome.error.code, outcome.error.message);
      return stamp(outcome.result);
    }
    default:
      return rpcError(404, id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

// ── 上一代：initialize 握手 ─────────────────────────────────────────

async function legacy(
  request: Request,
  env: Env,
  id: RpcId,
  method: string,
  params: Record<string, unknown>,
  resolved: Resolved,
): Promise<Response> {
  if (method === "initialize") {
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
    // 认得就照它的版本来，不认得回我们支持的最新一版，由客户端决定还连不连
    const version = LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0];
    return rpc(200, {
      id,
      result: {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      },
    });
  }
  // 握手之后的请求带 MCP-Protocol-Version 头（2025-06-18 起）；没带的按 2025-03-26 处理
  const header = request.headers.get("mcp-protocol-version");
  if (header !== null && !LEGACY_VERSIONS.includes(header)) {
    if (MODERN_VERSIONS.includes(header)) {
      return rpcError(400, id, INVALID_PARAMS, `缺少 _meta["${META_VERSION}"]：${header} 版本的每个请求都要带上它`);
    }
    return rpcError(400, id, INVALID_REQUEST, `不支持的协议版本 ${header}，支持：${ALL_VERSIONS.join("、")}`);
  }
  switch (method) {
    case "ping":
      return rpc(200, { id, result: {} });
    case "tools/list":
      return rpc(200, { id, result: { tools: [NOTIFY_TOOL] } });
    case "tools/call": {
      const outcome = await callTool(request, env, params, resolved);
      if ("error" in outcome) return rpcError(200, id, outcome.error.code, outcome.error.message);
      return rpc(200, { id, result: outcome.result });
    }
    default:
      return rpcError(200, id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

// ── notify ──────────────────────────────────────────────────────────

type Resolved = NonNullable<Awaited<ReturnType<typeof resolveChannel>>>;

type ToolOutcome =
  | { result: Record<string, unknown> }
  | { error: { code: number; message: string } };

/** 工具执行出错：放在结果里（isError），让 AI 看得到原因、自己改了再试 */
function toolError(text: string): ToolOutcome {
  return { result: { content: [{ type: "text", text }], isError: true } };
}

/** notify 的参数 → 推送参数。校验失败返回中文原因 */
export function notifyParams(args: Record<string, unknown>): { params: PushParams } | { problem: string } {
  const unknown = Object.keys(args).filter((k) => !(NOTIFY_FIELDS as readonly string[]).includes(k));
  if (unknown.length) return { problem: `不认识的参数：${unknown.join("、")}。notify 只收 ${NOTIFY_FIELDS.join("、")}` };
  for (const field of ["title", "body", "url", "id"] as const) {
    if (args[field] !== undefined && typeof args[field] !== "string") return { problem: `${field} 要是字符串` };
  }
  if (!args.title && !args.body) return { problem: "title 和 body 至少给一个" };
  if (args.level !== undefined && !["passive", "active", "timeSensitive"].includes(String(args.level))) {
    return { problem: "level 只能是 passive、active、timeSensitive" };
  }
  if (args.status !== undefined && !["firing", "resolved"].includes(String(args.status))) {
    return { problem: "status 只能是 firing 或 resolved" };
  }
  if (args.repeat !== undefined) {
    const n = Number(args.repeat);
    if (!Number.isInteger(n) || n < 0 || n > REPEAT_MAX_MINUTES) return { problem: `repeat 是 0–${REPEAT_MAX_MINUTES} 的整数（分钟）` };
  }
  if (typeof args.url === "string" && args.url && !/^https?:\/\//i.test(args.url)) return { problem: "url 要以 http:// 或 https:// 开头" };
  const picked = Object.fromEntries(NOTIFY_FIELDS.filter((f) => args[f] !== undefined && args[f] !== "").map((f) => [f, args[f]]));
  // repeat 0 = 不重复：参数里不带
  if (picked.repeat !== undefined && Number(picked.repeat) === 0) delete picked.repeat;
  return { params: paramsFromJson(picked) };
}

async function callTool(request: Request, env: Env, params: Record<string, unknown>, resolved: Resolved): Promise<ToolOutcome> {
  if (params.name !== "notify") {
    return { error: { code: INVALID_PARAMS, message: `Unknown tool: ${String(params.name)}（只有 notify）` } };
  }
  const args = isObject(params.arguments) ? params.arguments : {};
  const checked = notifyParams(args);
  if ("problem" in checked) return toolError(checked.problem);
  return push(request, env, resolved, checked.params);
}

async function push(request: Request, env: Env, resolved: Resolved, own: PushParams): Promise<ToolOutcome> {
  const { channel, recipients } = resolved;
  if (!(await allowPush(env, channel, recipients))) return toolError(throttledMessage(channel));
  const params = withDefaults(channel, own);
  if (!hasContent(params)) return toolError("没有内容可推：title 和 body 至少给一个");
  const rejection = plaintextRejection(channel as Channel, params, own);
  if (rejection) return toolError(`${rejection}。MCP 发来的是明文，这个通道用不了 MCP`);
  const blocked = await contentRejection(env, channel, params);
  if (blocked) return toolError(blocked);

  const report = await deliver(env, channel, recipients, params);
  const warnings = report.warnings ?? [];
  if (report.rejection) return toolError(report.rejection.message);
  const structured: Record<string, unknown> = {
    id: report.messageId,
    delivered: report.delivered,
    devices: report.results.length,
    channel: channel.name,
    ...(report.suppressed ? { suppressed: "duplicate" } : {}),
    ...(report.repeat ? { repeat: report.repeat } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
  const tail = warnings.length ? `\n提示：${warnings.join("；")}` : "";
  if (report.suppressed) {
    return { result: { content: [{ type: "text", text: `和刚才那条一模一样，已按去重合并，没有再推一次。${tail}` }], structuredContent: structured } };
  }
  if (report.results.length === 0) return toolError("这个通道下没有可用设备：请在手机上打开信鸽 App 重新登记");
  if (report.delivered === 0) return toolError(explainFailures(report.results).message);
  const repeatNote = report.repeat ? `；每 ${report.repeat.every} 分钟再提醒一次，直到用户点「知道了」或你带同一个 id 推 status=resolved` : "";
  const text = `已推送到「${channel.name}」：送达 ${report.delivered}/${report.results.length} 台设备，消息 id：${report.messageId}${repeatNote}。${tail}`;
  return { result: { content: [{ type: "text", text }], structuredContent: structured } };
}
