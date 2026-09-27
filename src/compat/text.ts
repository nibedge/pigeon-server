/**
 * 兼容层共用的文字处理：别家格式里的 HTML、带尖括号的链接写法、@所有人、客户端内打开的链接包装……
 * 统一成信鸽 App 认得的样子 —— 正文按行内 Markdown 显示（加粗、链接），块级的标记（# 标题、> 引用）
 * 和 HTML 标签在通知里只会原样露出来。
 */

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'",
};

/** 常见的 HTML 实体还原：&amp; &lt; &#20320; &#x4f60; */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith("#x")) return safeCodePoint(parseInt(lower.slice(2), 16)) ?? whole;
    if (lower.startsWith("#") && lower !== "#39") return safeCodePoint(parseInt(lower.slice(1), 10)) ?? whole;
    return ENTITIES[lower] ?? whole;
  });
}

function safeCodePoint(n: number): string | undefined {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : undefined;
}

/** 空白整理：行尾空格去掉，连着三个以上的换行并成一个空行，首尾空白去掉 */
export function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * HTML → 纯文字。换行类标签变换行，<li> 变「• 」，<a href> 变 [文字](地址)（App 的正文按 Markdown 显示，链接点得开），
 * 其余标签去掉、实体还原。有的推送服务默认把正文当 HTML，发来的正文里满是 <br> <b>，原样推出去没法读
 */
export function htmlToText(html: string): string {
  let t = html.replace(/\r\n?/g, "\n");
  t = t.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  // HTML 里的换行本来不算数，由标签决定；先压成空格，免得源码里的缩进换行变成一堆空行
  t = t.replace(/\s*\n\s*/g, " ");
  t = t.replace(/<br\s*\/?>/gi, "\n");
  t = t.replace(/<li\b[^>]*>/gi, "\n• ");
  t = t.replace(/<\/(p|div|h[1-6]|tr|table|ul|ol|blockquote|pre|section|article)\s*>/gi, "\n");
  t = t.replace(/<(p|div|h[1-6]|tr|table|ul|ol|blockquote|pre|section|article)\b[^>]*>/gi, "\n");
  t = t.replace(/<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi, (_, _q: string, href: string, inner: string) => {
    const label = decodeEntities(inner.replace(/<[^>]+>/g, "")).trim();
    const target = decodeEntities(href).trim();
    if (!/^https?:\/\//i.test(target)) return label;
    return label && label !== target ? `[${label}](${target})` : target;
  });
  t = t.replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_, _tag: string, inner: string) => {
    const label = inner.trim();
    return label ? `**${label}**` : "";
  });
  t = t.replace(/<[^>]+>/g, "");
  return tidy(decodeEntities(t).replace(/[ \t]{2,}/g, " "));
}

/** 看起来是 HTML：带着常见的排版标签 */
export function looksLikeHtml(text: string): boolean {
  return /<(br|p|div|b|strong|i|em|a|span|font|ul|ol|li|h[1-6]|table|tr|td|img)\b[^>]*>/i.test(text);
}

/** 群机器人格式常用的排版标签：<font color=…>、<span> 这类去掉、只留文字，<br> 换行 */
function stripLayoutTags(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?font\b[^>]*>/gi, "")
    .replace(/<\/?(span|div|p|b|i|u|strong|em)\b[^>]*>/gi, "");
}

/** 表格的一行：| a | b | → 「a · b」；分隔行（|---|:--:|）返回 null，整行去掉 */
function tableRow(line: string): string | null {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = inner.split("|").map((c) => c.trim());
  if (cells.every((c) => /^:?-{2,}:?$/.test(c))) return null;
  return cells.filter(Boolean).join(" · ");
}

/**
 * 块级 Markdown 的标记去掉，行内的（加粗、链接、行内代码）留着：App 的正文只认行内 Markdown，
 * 「## 标题」「> 引用」「- 列表」「| 表格 |」原样显示出来只是一堆符号，锁屏上尤其难读。
 * 列表换成「• 」，表格一行排成「a · b」，代码块的 ``` 围栏去掉、里面的内容照留。
 * 群机器人格式常用的 <font color=…>、<br> 一并处理
 */
export function flattenMarkdown(md: string): string {
  const t = stripLayoutTags(md.replace(/\r\n?/g, "\n"))
    .split("\n")
    .map((line) => {
      if (/^\s{0,3}(```|~~~)/.test(line)) return null;
      if (/^\s*\|.*\|\s*$/.test(line)) return tableRow(line);
      return line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s{0,3}(>\s?)+/, "")
        .replace(/^\s{0,3}([-*_])(\s*\1){2,}\s*$/, "———")
        .replace(/^(\s*)[-*+]\s+(?=\S)/, "$1• ");
    })
    .filter((line): line is string => line !== null)
    .join("\n");
  return tidy(t);
}

/**
 * 当标题用的一行：排版标签、块级标记、行内 Markdown 都去掉。「## 构建失败 <font color="warning">#182</font>」→「构建失败 #182」
 */
export function plainTitle(text: string): string {
  return plainInline(stripLayoutTags(text).replace(/\s*\n\s*/g, " ").replace(/^\s*#{1,6}\s+/, ""));
}

/**
 * 字段写成一行「名字：值」。卡片的字段常写成「**名字**\n值」或名字自带冒号（「Error:」），
 * 原样拼出来是「**名字**\n值」「Error:：值」
 */
export function labelled(name: string, value: string | undefined): string {
  const label = plainInline(name).replace(/\s*[：:]\s*$/, "");
  return `${label}：${value ?? ""}`;
}

/** 「**名字**\n值」「*名字*\n值」这种两行的字段并成「名字：值」；不是这个样子的原样返回 */
export function joinFieldLines(field: string): string {
  const m = /^\s*\*\*(.+?)\*\*\s*\n([\s\S]+)$/.exec(field);
  return m ? labelled(m[1] ?? "", (m[2] ?? "").trim()) : field;
}

/** 标题里用不上的行内标记：**加粗**、`代码`、【】这类包装不去掉，只去 Markdown 的 */
export function plainInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1")
    .trim();
}

/** 标题最多这么多字：锁屏上一行放不下更多，剩下的留在正文里 */
export const TITLE_MAX_CHARS = 60;

/**
 * 一段文字 → 标题 + 正文。有两行以上、第一行不长（像个标题）时，第一行当标题；否则整段当正文、不给标题。
 * 群机器人的纯文本消息常见的写法就是「第一行说什么事，下面几行是细节」
 */
export function splitTitle(text: string): { title?: string; body?: string } {
  const lines = tidy(text).split("\n");
  const first = (lines[0] ?? "").trim();
  const rest = tidy(lines.slice(1).join("\n"));
  const heading = plainInline(first.replace(/^#{1,6}\s+/, ""));
  if (rest && heading && Array.from(heading).length <= TITLE_MAX_CHARS) return { title: heading, body: rest };
  const whole = tidy(text);
  return whole ? { body: whole } : {};
}

/** 截到 max 个字（按码点，不截出半个 emoji），截了就加省略号 */
export function clipText(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const chars = Array.from(text.trim());
  if (chars.length <= max) return chars.join("");
  return chars.slice(0, max - 1).join("").trimEnd() + "…";
}

/** 只收 http(s) 的地址，别的（app 私有协议、javascript:）一概不要 */
export function httpUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return /^https?:\/\/[^\s]+$/i.test(value) ? value : undefined;
}

/**
 * 客户端内打开的链接包装 → 里面真正的地址。
 * 有的群机器人格式要求把链接包成「私有协议://…/page/link?url=编码后的地址」或「https://…/client/web_url/open?url=…」，
 * 让链接在它自家客户端里打开；在手机上点开这种包装只会跳去别的 App（或者打不开），所以拆出里面的 url
 */
export function unwrapLink(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  const wrapped = !/^https?:$/.test(parsed.protocol) || /\/(page\/link|web_url\/open)\/?$/.test(parsed.pathname);
  if (wrapped) {
    const inner = parsed.searchParams.get("url");
    return httpUrl(inner ?? undefined);
  }
  return httpUrl(value);
}

/** 图片只收 https：App 不加载明文 http 的图片 */
export function httpsImage(raw: unknown): string | undefined {
  const url = httpUrl(raw);
  return url && url.toLowerCase().startsWith("https://") ? url : undefined;
}

/** 文字里的「@所有人」一类写法 */
export interface Mentions {
  text: string;
  all: boolean;
}

/**
 * 尖括号标记的写法（blocks 风格）→ 信鸽的 Markdown：
 *   <地址|文字> → [文字](地址)、<地址> → 地址、<!channel> <!here> <!everyone> → @所有人、
 *   <@U123|名字> → @名字、<#C1|名字> → #名字、*加粗* → **加粗**、~删除~ → ~~删除~~，&amp; 这类转义还原
 */
export function fromAngleMarkup(raw: string): Mentions {
  let all = false;
  let t = raw.replace(/<!(channel|here|everyone)(\|[^>]*)?>/gi, () => {
    all = true;
    return "@所有人";
  });
  t = t.replace(/<!subteam\^[^|>]+\|([^>]+)>/g, "$1");
  t = t.replace(/<!date\^[^|>]+\|([^>]+)>/g, "$1");
  t = t.replace(/<@[A-Z0-9]+\|([^>]+)>/g, "@$1").replace(/<@[A-Z0-9]+>/g, "@成员");
  t = t.replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1").replace(/<#[A-Z0-9]+>/g, "#频道");
  t = t.replace(/<((?:https?|mailto):[^|>\s]+)\|([^>]+)>/gi, "[$2]($1)");
  t = t.replace(/<((?:https?|mailto):[^|>\s]+)>/gi, "$1");
  t = t.replace(/(^|[\s(（])\*([^*\n]+?)\*(?=$|[\s),.!?:;，。！？：；）])/g, "$1**$2**");
  t = t.replace(/(^|[\s(（])~([^~\n]+?)~(?=$|[\s),.!?:;，。！？：；）])/g, "$1~~$2~~");
  t = t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return { text: t, all };
}

/**
 * embeds 风格的正文：<@123> <@!123> <@&123> → @成员，<#123> → #频道，<t:秒:格式> → 北京时间，@everyone / @here → @所有人
 */
export function fromEmbedMarkup(raw: string): Mentions {
  let all = false;
  let t = raw.replace(/@(everyone|here)\b/g, () => {
    all = true;
    return "@所有人";
  });
  t = t.replace(/<@[!&]?\d+>/g, "@成员").replace(/<#\d+>/g, "#频道");
  t = t.replace(/<a?:(\w+):\d+>/g, ":$1:");
  t = t.replace(/<t:(\d{1,12})(?::[a-zA-Z])?>/g, (whole, seconds: string) => beijingTime(Number(seconds) * 1000) ?? whole);
  return { text: t, all };
}

/**
 * <at …>名字</at> 写法（msg_type 风格）：user_id="all" / id=all 是 @所有人，其余换成 @名字
 */
export function fromAtTags(raw: string): Mentions {
  let all = false;
  const t = raw.replace(/<at\b([^>]*)>([^<]*)<\/at\s*>/gi, (_, attrs: string, inner: string) => {
    if (/(?:user_id|id|open_id)\s*=\s*["']?all["']?/i.test(attrs)) {
      all = true;
      return "@所有人";
    }
    const name = inner.trim();
    return name ? `@${name.replace(/^@/, "")}` : "@成员";
  });
  return { text: t, all };
}

/** 毫秒时刻 → 「2026-09-27 14:05」（北京时间）。显示精确时刻，不写「3 分钟前」 */
export function beijingTime(ms: number): string | undefined {
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  const d = new Date(ms + 8 * 3600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 安全地取对象：不是对象（null、数组、字符串）就返回 undefined */
export function obj(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** 安全地取数组 */
export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 字符串或数字 → 字符串；其余（对象、null）→ undefined。空串也算没有 */
export function text(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() ? value : undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}
