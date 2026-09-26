const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
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

export function html(body: string, status = 200, cacheControl = "public, max-age=300"): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": cacheControl,
    },
  });
}
