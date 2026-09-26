import type { RateLimiter } from "./types";

/**
 * 查一次限流：放行返回 true。
 *
 * 绑定缺失（本地测试、自建环境没配）或者限流服务本身出错时一律放行 ——
 * 限流是挡滥用的护栏，不能因为它自己出问题就把正常推送拦下来。
 */
export async function allow(limiter: RateLimiter | undefined, key: string): Promise<boolean> {
  if (!limiter) return true;
  try {
    return (await limiter.limit({ key })).success;
  } catch {
    return true;
  }
}

/** 限流绑定的窗口长度（秒），与 wrangler.toml 的 period 一致。给 Retry-After 用 */
export const RATE_WINDOW_SECONDS = 60;

/**
 * 超出限流：429 + Retry-After。
 * 信封照旧带 code / message —— 旧版 App 只认 message；另带 error、retry_after 两个字段，给新版 App 和脚本直接读。
 * 发送方据 Retry-After 退避，而不是立刻重试、越试越多
 */
export function rateLimited(message: string, retryAfter = RATE_WINDOW_SECONDS): Response {
  return new Response(
    JSON.stringify({
      code: 429,
      message,
      error: message,
      retry_after: retryAfter,
      timestamp: Math.floor(Date.now() / 1000),
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "retry-after": String(retryAfter),
      },
    },
  );
}
