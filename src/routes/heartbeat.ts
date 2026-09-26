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

function respond(outcome: HeartbeatOutcome): Response {
  if (!outcome.ok) return outcome.reason === "suspended" ? fail(403, SUSPENDED) : fail(404, NOT_FOUND);
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
    text = await request.text();
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
 *   GET | POST         /hb/{id}/fail   任务自己报失败，立刻提醒
 *
 * 不要凭据 —— 和推送地址一样，地址本身就是凭据。定时任务末尾加一行 curl 就能接上，
 * 不必在脚本里保管任何密钥。不存在的和不是心跳的一律 404，不透露别的监控存不存在；
 * 推给的通道被停用了回 403。
 */
export async function handleHeartbeat(
  request: Request,
  env: Env,
  url: URL,
  id: string,
  action?: string,
): Promise<Response> {
  const method = request.method;

  if (action === undefined) {
    if (method !== "GET" && method !== "POST" && method !== "HEAD") {
      return fail(405, "心跳报到只支持 GET、POST 或 HEAD");
    }
    return respond(await recordHeartbeat(env, id, { failed: false }));
  }

  if (action === "fail") {
    if (method !== "GET" && method !== "POST") return fail(405, "报告失败只支持 GET 或 POST");
    const message = await readFailMessage(request, url);
    return respond(await recordHeartbeat(env, id, { failed: true, message }));
  }

  return fail(404, "没有这个接口。正常报到用 /hb/{id}，报告失败用 /hb/{id}/fail");
}
