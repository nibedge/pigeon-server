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
