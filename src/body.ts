import { fail } from "./respond";

/**
 * 推送入口的请求体上限。
 *
 * 一条推送最后要塞进 Apple 4KB 的 payload，64 KB 已经是它的十几倍，正常用法碰不到；
 * 不设上限的话，一个几十 MB 的 JSON 就能把单个请求的内存（128 MB）和 CPU 白白耗光。
 */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * /hook 的上限放宽到 1 MB：第三方 webhook 的原始 payload 比推送本身大得多（一次带几十个提交的
 * push、一批告警），它们的内容由适配器挑着用，不会原样进通知。卡在 64 KB 会把正常事件拒掉
 */
export const MAX_HOOK_BODY_BYTES = 1024 * 1024;

function tooLargeMessage(limit: number): string {
  const size = limit >= 1024 * 1024 ? `${limit / 1024 / 1024} MB` : `${limit / 1024} KB`;
  // 推送入口多说一句：通知本身放不下多少字，发几十 KB 过来也只会被截掉
  const hint = limit <= MAX_BODY_BYTES ? "；通知里实际只放得下约 1100 个汉字" : "";
  return `内容太长：请求体不能超过 ${size}${hint}`;
}

export class BodyTooLarge extends Error {
  constructor(readonly limit: number) {
    super(tooLargeMessage(limit));
    this.name = "BodyTooLarge";
  }
}

export function bodyTooLarge(limit = MAX_BODY_BYTES): Response {
  return fail(413, tooLargeMessage(limit));
}

/** 请求自己声明的长度已经超了 —— 不用读，也不用先查 KV */
export function declaredTooLarge(request: Request, limit = MAX_BODY_BYTES): boolean {
  const declared = Number(request.headers.get("content-length"));
  return Number.isFinite(declared) && declared > limit;
}

/**
 * 读整个请求体，超过上限抛 BodyTooLarge。
 *
 * 先看 Content-Length；没有（分块上传）或者少报了，就边读边数，一过上限立刻停手，
 * 不会先把整个请求体收进内存再判断。
 */
export async function readBody(request: Request, limit = MAX_BODY_BYTES): Promise<Uint8Array> {
  if (declaredTooLarge(request, limit)) throw new BodyTooLarge(limit);
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLarge(limit);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** 读成文字（UTF-8），超过上限同样抛 BodyTooLarge */
export async function readBodyText(request: Request, limit = MAX_BODY_BYTES): Promise<string> {
  return new TextDecoder().decode(await readBody(request, limit));
}
