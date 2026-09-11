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

export function html(body: string, status = 200, cacheControl = "public, max-age=300"): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": cacheControl,
    },
  });
}
