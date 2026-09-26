import type { PushParams } from "../types";

/**
 * 入站适配器：把某个服务原生的 webhook payload 渲染成一条人看得懂的通知。
 *
 * 这是整个产品的差异化所在 —— 同类工具基本都是哑管道：POST 什么就推什么，
 * 用户得自己写胶水代码做这层转换。
 *
 * render 返回 null 表示「这个事件不值得推」（比如 GitHub 的 ping、
 * 或者成功的构建），服务端会回 200 但不发推送。回 200 是必要的，
 * 否则发送方会当成投递失败一直重试。
 */
export interface Adapter {
  name: string;
  label: string;
  /** 可以是异步的：算 id 要用 WebCrypto 的摘要 */
  render(body: unknown, headers: Headers): PushParams | null | Promise<PushParams | null>;
}

/** 从任意对象里安全取路径，取不到返回 undefined */
export function pick(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export function str(obj: unknown, path: string): string | undefined {
  const v = pick(obj, path);
  return typeof v === "string" || typeof v === "number" ? String(v) : undefined;
}

/** 截断长文本，避免把整段 stack trace 塞进通知栏 */
export function clip(text: string | undefined, max = 240): string | undefined {
  if (!text) return undefined;
  const t = text.trim().replace(/\s*\n\s*\n+/g, "\n");
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/**
 * 任意长的文字 → 24 位十六进制（SHA-256 的前 96 位）。当消息 id 用：定长，不会超过
 * APNs collapse-id 的 64 字节 —— 中文长名、Grafana 的 groupKey 都很容易超，超了就没法折叠
 */
export async function digest24(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** prefix + text 放得进 64 字节就原样用（排查时看得懂），放不下换成摘要 */
export async function readableId(prefix: string, text: string): Promise<string> {
  const plain = `${prefix}${text}`;
  return new TextEncoder().encode(plain).length <= 64 ? plain : `${prefix}${await digest24(text)}`;
}
