import { readBodyText } from "../body";
import { fail, ok } from "../respond";
import { recordHeartbeat } from "../watch";
import type { Env } from "../types";

/** 失败说明截到这么长：通知里放得下一句话，放不下一整段日志 */
const MAX_FAIL_MESSAGE = 200;

const NOT_FOUND =
  "没有这个心跳监控。检查地址有没有抄错；如果已经在 App 里删掉了，这个地址也随之作废";

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
 *   GET | POST         /hb/{id}/fail   任务自己报失败，立刻提醒
 *
 * 不要凭据 —— 和推送地址一样，地址本身就是凭据。定时任务末尾加一行 curl 就能接上，
 * 不必在脚本里保管任何密钥。不存在的和不是心跳的一律 404，不透露别的监控存不存在。
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
    const watch = await recordHeartbeat(env, id, { failed: false });
    if (!watch) return fail(404, NOT_FOUND);
    return ok({ name: watch.name, status: watch.lastStatus });
  }

  if (action === "fail") {
    if (method !== "GET" && method !== "POST") return fail(405, "报告失败只支持 GET 或 POST");
    const message = await readFailMessage(request, url);
    const watch = await recordHeartbeat(env, id, { failed: true, message });
    if (!watch) return fail(404, NOT_FOUND);
    return ok({ name: watch.name, status: watch.lastStatus });
  }

  return fail(404, "没有这个接口。正常报到用 /hb/{id}，报告失败用 /hb/{id}/fail");
}
