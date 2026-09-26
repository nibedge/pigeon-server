import { readBodyText } from "../body";
import { isLinkPreviewAgent, isPrefetch } from "../preview";
import { throttledMessage } from "../push";
import { rateLimited } from "../ratelimit";
import { fail, ok } from "../respond";
import { recordHeartbeat, type HeartbeatOutcome } from "../watch";
import type { Env } from "../types";

/** 失败说明截到这么长：通知里放得下一句话，放不下一整段日志 */
const MAX_FAIL_MESSAGE = 200;

const NOT_FOUND =
  "没有这个心跳监控。检查地址有没有抄错；如果已经在 App 里删掉了，这个地址也随之作废";

/**
 * 停用期间心跳留着、报到不记：申诉恢复后还是这个地址。回 403 而不是 200 —— 定时任务的主人
 * 看得到出了什么事，不会以为自己还在被盯着
 */
const SUSPENDED =
  "这个心跳推送的通道因违反《使用条款》已被停用：上报暂不记录，也不会提醒";

/**
 * 这次 GET / HEAD 是链接预览或浏览器预取，不是任务来报到。
 *
 * 报到地址、`curl …/fail` 脚本常被贴进聊天里：对方的服务器抓一遍生成预览卡片，命中 /fail 就给全群推一条
 * 假的「报告失败」，命中报到地址会把还没接上的心跳激活、把真实的失联「恢复」掉。
 * 只看 GET 和 HEAD：预览从来不 POST，任务自己用 POST 报的一律照记，哪怕它的 UA 里也带着 bot
 */
function isPreview(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  // 爬虫 UA、预取标头和推送入口用同一套判断（preview.ts）。但不用它的 isPreviewRequest：
  // 那边把一切 HEAD 都当预览，而 HEAD 在这里是合法的报到方式（C18）
  return isPrefetch(request.headers) || isLinkPreviewAgent(request.headers.get("user-agent") ?? "");
}

function respond(outcome: HeartbeatOutcome): Response {
  if (!outcome.ok) {
    if (outcome.reason === "throttled") return rateLimited(throttledMessage(outcome.channel));
    return outcome.reason === "suspended" ? fail(403, SUSPENDED) : fail(404, NOT_FOUND);
  }
  return ok({ name: outcome.watch.name, status: outcome.watch.lastStatus });
}

function clipMessage(text: string): string {
  return text.trim().slice(0, MAX_FAIL_MESSAGE);
}

/**
 * /fail 附带的说明：?msg= 优先，其次是请求体。
 *
 * 请求体什么写法都认，因为发它的往往是一行 shell：`curl -d "磁盘满了"` 默认按表单编码发出，
 * 整句话会被当成一个没有值的字段名 —— 按表单解析就只剩空白。所以只从 JSON 和表单里挑
 * msg / message 这类字段，挑不到就把请求体原文当说明。
 */
async function readFailMessage(request: Request, url: URL): Promise<string> {
  const fromQuery = url.searchParams.get("msg");
  if (fromQuery) return clipMessage(fromQuery);
  if (request.method !== "POST") return "";

  let text = "";
  try {
    // 读原文也有上限（64 KB）：说明反正只留 200 字，超长的就不附说明，失败照样记
    text = await readBodyText(request);
  } catch {
    return "";
  }
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "string") return clipMessage(parsed);
      if (parsed && typeof parsed === "object") {
        for (const field of ["msg", "message", "body", "text"]) {
          const value = (parsed as Record<string, unknown>)[field];
          if (typeof value === "string" || typeof value === "number") return clipMessage(String(value));
        }
        // 一个 JSON 对象里没有认得的字段：原文是一坨花括号，当说明只会更难看
        return "";
      }
    } catch {
      // 声称是 JSON 却解析不了，就当普通文字
    }
  }
  if (type.includes("form-urlencoded")) {
    const form = new URLSearchParams(text);
    const value = form.get("msg") ?? form.get("message");
    if (value) return clipMessage(value);
  }
  return clipMessage(text);
}

/**
 * 心跳报到：
 *   GET | POST | HEAD  /hb/{id}        正常报到
 *   POST               /hb/{id}/fail   任务自己报失败，立刻提醒
 *
 * 不要凭据 —— 和推送地址一样，地址本身就是凭据。定时任务末尾加一行 curl 就能接上，
 * 不必在脚本里保管任何密钥。不存在的和不是心跳的一律 404，不透露别的监控存不存在；
 * 推给的通道被停用了回 403。链接预览、浏览器预取回 200，什么也不记。
 *
 * /fail 只收 POST：GET 谁都能随手触发 —— 聊天里的链接预览、浏览器地址栏的预加载 —— 而它一触发
 * 就是给全群推一条「报告失败」。报到地址照旧收 GET，那是最常见的 curl 写法，而且预览已经挡在前面
 */
export async function handleHeartbeat(
  request: Request,
  env: Env,
  url: URL,
  id: string,
  action?: string,
): Promise<Response> {
  const method = request.method;
  if (action !== undefined && action !== "fail") {
    return fail(404, "没有这个接口。正常报到用 /hb/{id}，报告失败用 POST /hb/{id}/fail");
  }
  if (isPreview(request)) return ok({ skipped: "preview" });

  if (action === undefined) {
    if (method !== "GET" && method !== "POST" && method !== "HEAD") {
      return fail(405, "心跳报到只支持 GET、POST 或 HEAD");
    }
    return respond(await recordHeartbeat(env, id, { failed: false }));
  }

  if (method !== "POST") {
    return fail(405, `报告失败请用 POST：curl -fsS -X POST ${url.origin}/hb/${id}/fail，附说明就用 -d "说明"`);
  }
  const message = await readFailMessage(request, url);
  return respond(await recordHeartbeat(env, id, { failed: true, message }));
}
