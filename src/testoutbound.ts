import type { Env } from "./types";

/**
 * 仅本地端到端测试：把 Worker 发往外面的请求（APNs、代发按钮、回调事件、令牌校验）一律转给本机的一个接收端。
 *
 * 按钮和回调只收 https 的公网域名（见 actions.ts 的 urlProblem），本机起的接收端本来够不着；
 * APNs 也连不上。可要验「服务端到底发出去了什么」—— 代发请求的签名头、群里原地广播的 payload、
 * 回调事件 —— 就得有个地方接住它们。test/api-l2-e2e.test.mjs 自己起一个 wrangler dev，带上
 * PIGEON_TEST_OUTBOUND=http://127.0.0.1:端口，这里把所有出站请求改投到那个端口：路径和查询原样保留，
 * 原来的主机名放进 x-test-host 头，方法、请求头、请求体都不动 —— 签名签的是时间戳和请求体，改投不影响核对。
 *
 * 三道闸，线上一道都过不去：PIGEON_TEST_ADMIN 必须是 "1"（线上从不设置）、PIGEON_TEST_OUTBOUND 必须给了、
 * 而且只能指向本机回环地址。
 */

/** 模块载入时的原生 fetch。改投之后还要靠它真正发出去，也免得重复安装时一层套一层 */
const nativeFetch = globalThis.fetch;
let installedFor: string | null = null;

/** 请求里带的原主机名，接收端据此分辨这是发给 APNs 的、还是发给按钮地址或回调地址的 */
export const TEST_HOST_HEADER = "x-test-host";

export function routeOutboundForTests(env: Pick<Env, "PIGEON_TEST_ADMIN" | "PIGEON_TEST_OUTBOUND">): void {
  const base = env.PIGEON_TEST_OUTBOUND;
  if (env.PIGEON_TEST_ADMIN !== "1" || !base || installedFor === base) return;
  let sink: URL;
  try {
    sink = new URL(base);
  } catch {
    return;
  }
  if (sink.protocol !== "http:" || (sink.hostname !== "127.0.0.1" && sink.hostname !== "localhost")) return;
  installedFor = base;

  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const original = new URL(request.url);
    if (original.host === sink.host) return nativeFetch(request);
    const headers = new Headers(request.headers);
    headers.set(TEST_HOST_HEADER, original.host);
    const target = new URL(original.pathname + original.search, sink);
    return nativeFetch(target.toString(), {
      method: request.method,
      headers,
      body: request.body,
      redirect: request.redirect,
      signal: request.signal,
    });
  };
}
