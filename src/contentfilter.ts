import type { Channel, Env, PushParams } from "./types";

/**
 * 群组明文推送的违禁词过滤。
 *
 * App Store 对「用户生成内容」的要求之一是有过滤不良内容的办法。群组里群主推什么、成员就收什么，
 * 所以在推送入口把群组的明文标题、副标题、正文过一遍词表：命中就拒收，发送方当场知道，成员那边什么也收不到。
 * 不改写、不打码、不存档 —— 比对只在内存里做，被拒的内容也不记下来。
 *
 * 管的范围刻意很窄：
 * - 只管有成员的群。只有自己一个人收的通道，内容只落到自己手机上，谈不上「给别人看」
 * - 只管明文。端到端加密的内容服务端看不到，这类靠举报兜底
 * - 词表只收几乎不会出现在正常告警、通知里的词。误拦一条告警的代价，远大于漏过一条广告
 *
 * 运营者可以用 KV 的 config:blocklist 整份替换词表（JSON 字符串数组；[] 表示关掉过滤）：
 *   npx wrangler kv key put --binding PIGEON_KV --remote config:blocklist '["词一","词二"]'
 * 读不出来或格式不对就用内置词表 —— 配错一个 KV 值，不该让过滤悄悄失效。
 */

const CONFIG_BLOCKLIST = "config:blocklist";

/** 内置词表。比对前两边都先规整（见 normalize），这里照常写就行 */
export const DEFAULT_BLOCKLIST: readonly string[] = [
  // 色情
  "裸聊", "约炮", "援交", "儿童色情", "child porn",
  // 毒品
  "冰毒", "海洛因", "摇头丸",
  // 迷药与性侵
  "迷药", "迷奸", "听话水",
  // 枪支、假证
  "出售枪支", "办假证",
  // 赌博引流
  "真人荷官", "线上赌场",
];

/** 过滤看的字段：用户在通知上直接看得到的文字 */
const FIELDS: (keyof PushParams)[] = ["title", "subtitle", "body", "markdown"];

/**
 * 词表缓存这么久：群组推送不必每条都多读一次 KV，改了词表一分钟内生效。
 * 按 KV 绑定对象分开缓存 —— 同一个 isolate 里的请求共用一份；换了一套 env（比如测试）各算各的
 */
const CACHE_MS = 60_000;
const cache = new WeakMap<object, { words: string[]; at: number }>();

/**
 * 规整成便于比对的样子：全角转半角（NFKC）、英文转小写，去掉空白、标点、符号和零宽字符。
 * 「裸 聊」「裸*聊」「ＣＨＩＬＤ ＰＯＲＮ」这类拆字、换写法的，规整之后都一样
 */
export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}​-‏⁠﻿]/gu, "");
}

function prepare(words: readonly string[]): string[] {
  return [...new Set(words.map(normalize).filter(Boolean))];
}

/** 当前生效的词表（已规整）。KV 里有合格的配置就用它，否则用内置的 */
export async function loadBlocklist(env: Pick<Env, "PIGEON_KV">, now = Date.now()): Promise<string[]> {
  const hit = cache.get(env.PIGEON_KV);
  if (hit && now - hit.at < CACHE_MS) return hit.words;
  let words = prepare(DEFAULT_BLOCKLIST);
  try {
    const raw = await env.PIGEON_KV.get(CONFIG_BLOCKLIST);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((w) => typeof w === "string")) words = prepare(parsed);
    }
  } catch {
    // 读不到或不是 JSON：用内置词表
  }
  cache.set(env.PIGEON_KV, { words, at: now });
  return words;
}

/** 命中的第一个词（规整后的写法）；没命中返回 null */
export function findBlocked(params: PushParams, words: readonly string[]): string | null {
  if (words.length === 0) return null;
  const text = FIELDS.map((field) => normalize(params[field] ?? "")).join("\n");
  if (!text.replace(/\n/g, "")) return null;
  return words.find((word) => text.includes(word)) ?? null;
}

/**
 * 群组的明文推送里有违禁词 —— 返回拒收的理由；没问题（或不归它管）返回 null。
 * 在推送入口调用，和 plaintextRejection 并列
 */
export async function contentRejection(
  env: Pick<Env, "PIGEON_KV">,
  channel: Pick<Channel, "memberIds">,
  params: PushParams,
): Promise<string | null> {
  if (channel.memberIds.length === 0) return null;
  if (!FIELDS.some((field) => params[field])) return null;
  const hit = findBlocked(params, await loadBlocklist(env));
  if (!hit) return null;
  return `这条消息含有群组里不允许推送的内容（「${hit}」），没有发出。群组里能推什么，见《使用条款》`;
}
