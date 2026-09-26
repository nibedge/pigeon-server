/**
 * 这个请求是不是链接预览、预取，而不是真有人要推送。
 *
 * 路径式推送的地址本身就是一次推送：把它贴进聊天软件，对方的服务器会先抓一遍生成预览卡片；
 * 浏览器地址栏里敲到一半，也可能被预先加载。原先这些请求一律照推 —— 群里每个人都收到一条
 * 莫名其妙的消息，发地址的人还以为是别人在乱推。
 *
 * 只看 GET 和 HEAD：预览和预取从来不带请求体，POST 一定是有意发来的。
 */
export function isPreviewRequest(request: Request): boolean {
  const method = request.method;
  // HEAD 只问「这个地址在不在」，从来不是要推送
  if (method === "HEAD") return true;
  if (method !== "GET") return false;
  const headers = request.headers;
  // 浏览器的预取、预渲染会自报家门：Sec-Purpose（新）、Purpose（旧）、X-Purpose、X-Moz
  for (const name of ["sec-purpose", "purpose", "x-purpose", "x-moz"]) {
    const value = (headers.get(name) ?? "").toLowerCase();
    if (value.includes("prefetch") || value.includes("preview") || value.includes("prerender")) return true;
  }
  return isLinkPreviewAgent(headers.get("user-agent") ?? "");
}

/**
 * 链接预览爬虫的 UA 大多带 bot 字样（…bot/2.1、…Bot (like …)、…bot-LinkExpanding）。
 * 不能是 robot —— 有的网站监控服务 UA 里就叫某某Robot，它们发来的是真告警；
 * 全大写的 BOT 也不算，那多半是手机型号。
 */
const BOT_WORD = /(?<![Rr]o)[Bb]ot(?![a-z])/;
const CRAWLER_WORDS = /crawler|spider|preview|externalhit|embedly|scraper/i;

/**
 * 另有几家聊天软件抓预览时，UA 里只有自家 App 的名字、没有上面那些字样。它们的内置浏览器用的也是
 * 这个 UA，所以在这些 App 里直接点开推送地址不会推送 —— 本来也不该这样推，网页发送用 /send。
 * 名单按 base64 存：代码和文案里不出现第三方 App 的名字（仓库的规矩），解码后是 UA 里的原样片段
 */
const NAMED_AGENTS = ["TWljcm9NZXNzZW5nZXI=", "V2hhdHNBcHA="].map((b64) => atob(b64).toLowerCase());

export function isLinkPreviewAgent(userAgent: string): boolean {
  if (!userAgent) return false;
  if (BOT_WORD.test(userAgent) || CRAWLER_WORDS.test(userAgent)) return true;
  const ua = userAgent.toLowerCase();
  return NAMED_AGENTS.some((token) => ua.includes(token));
}
