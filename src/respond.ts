const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function ok(data?: unknown): Response {
  return new Response(
    JSON.stringify({ code: 200, message: "success", data, timestamp: now() }),
    { status: 200, headers: JSON_HEADERS },
  );
}

export function fail(status: number, message: string, data?: unknown): Response {
  return new Response(
    JSON.stringify({ code: status, message, data, timestamp: now() }),
    { status, headers: JSON_HEADERS },
  );
}

/**
 * 超出限流：429 + Retry-After。
 * 信封照旧带 code / message —— 旧版 App 只认 message；另带 error、retry_after 两个字段，给新版 App 和脚本直接读
 */
export function tooMany(message: string, retryAfter = 60): Response {
  return new Response(
    JSON.stringify({ code: 429, message, error: message, retry_after: retryAfter, timestamp: now() }),
    { status: 429, headers: { ...JSON_HEADERS, "retry-after": String(retryAfter) } },
  );
}

/** 页面的默认缓存：内容不含任何凭据，5 分钟内的旧版本无妨 */
export const PAGE_CACHE = "public, max-age=300";

/**
 * 页面的内容安全策略。
 *
 * 脚本只放行点名的几段内联脚本（按哈希，见 scriptHash），别的一概不执行 —— 发送页手里握着推送 key，
 * 将来哪处拼接漏了转义、被塞进一段 <script>，它也跑不起来。哈希必须从写死的脚本源码算，
 * 不能从拼好的页面里扫出来：那样被注入的脚本也会被算进去、一并放行。
 * 样式放行内联：页面样式都写在 <style> 和 style 属性里，样式注入偷不走东西。
 */
function contentSecurityPolicy(scriptHashes: readonly string[]): string {
  return [
    "default-src 'none'",
    `script-src ${scriptHashes.length ? scriptHashes.join(" ") : "'none'"}`,
    "style-src 'unsafe-inline'",
    "img-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * HTML 页面，统一带上安全头。
 * scriptHashes：这一页允许执行的内联脚本，每项是 scriptHash() 的结果；页面没有脚本就不传
 */
export function html(
  body: string,
  status = 200,
  cacheControl = PAGE_CACHE,
  scriptHashes: readonly string[] = [],
): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": cacheControl,
      "content-security-policy": contentSecurityPolicy(scriptHashes),
      // 不许被别的网站用 iframe 套住（老浏览器认这一个，新的认 CSP 的 frame-ancestors）
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
      // 邀请页的地址里有邀请码：从页面点出去（比如去 App Store），不该把它带给对方
      "referrer-policy": "no-referrer",
      // 以后一年内只走 https：第一次之后，浏览器不会再用明文 http 访问这个站
      "strict-transport-security": "max-age=31536000",
    },
  });
}

const scriptHashCache = new Map<string, Promise<string>>();

/**
 * 内联脚本在 CSP 里的写法 'sha256-…'：对 <script> 与 </script> 之间的原文（UTF-8）取 SHA-256。
 * 脚本源码都是写死的常量，每个 isolate 算一次就缓存
 */
export function scriptHash(source: string): Promise<string> {
  let hash = scriptHashCache.get(source);
  if (!hash) {
    hash = crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)).then((digest) => {
      let bin = "";
      for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
      return `'sha256-${btoa(bin)}'`;
    });
    scriptHashCache.set(source, hash);
  }
  return hash;
}
