import { allow } from "./ratelimit";
import type { RateLimiter } from "./types";

/**
 * 入口防滥用：按来源 IP 限流。
 *
 * 建账号不要任何凭据（App 第一次打开就得能用），所以「每个账号最多几个通道、几个监控」这类上限，
 * 只有在账号本身不能随手成批造出来时才算数。这里几道闸门就是为此而设。
 */

/** 本机回环地址。线上的来源不可能是它，只有本地 wrangler dev 会这么填 */
const LOOPBACK = /^(?:127\.|::1$|::ffff:127\.)/;

/**
 * 请求的来源 IP。Cloudflare 在边缘填好，客户端改不了。
 * 拿不到、或者是本机回环地址，只会是本地开发 —— 那就不按 IP 限，免得本地测试彼此挤占额度
 */
export function clientIp(request: Request): string | null {
  const ip = request.headers.get("cf-connecting-ip");
  return ip && !LOOPBACK.test(ip) ? ip : null;
}

/** 按来源 IP 限一次流，放行返回 true。bucket 区分用途（acct、invite），各记各的 */
export async function allowIp(
  limiter: RateLimiter | undefined,
  request: Request,
  bucket: string,
): Promise<boolean> {
  const ip = clientIp(request);
  if (!ip) return true;
  return allow(limiter, `${bucket}:${ip}`);
}
