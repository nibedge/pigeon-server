import { fieldLines } from "./generic";
import { flattenMarkdown, htmlToText, httpUrl, looksLikeHtml } from "./text";

/**
 * 国内常见推送服务的参数写法。大量签到脚本、面板、RSS 工具内置了这些写法：认得它们，
 * 换个域名、换个 key 就能迁过来。只按参数本身说话，不写是哪家的：
 *
 *   text + desp            text 是标题、desp 是正文（只有 text 时它仍是正文）
 *   title + desp / content 标题 + 正文（desp、content 本来就是正文的别名）
 *   content + summary      正文 + 摘要（摘要当副标题）
 *   template / contentType / type   正文是什么格式：html、json、markdown、txt、image
 *   desp                   没写格式时按 Markdown：那一家把 desp 当 Markdown 渲染，脚本里常写「## 标题」「- 列表」、表格
 *
 * 各家特有、信鸽用不上的参数（渠道、群组编号、回调地址、对方的令牌……）列进响应的 ignored，
 * 免得发送方以为设上了；它们的值一概不进推送 —— 令牌推出去就收不回来。
 */

/** 别家推送服务特有、信鸽没有对应功能的参数（小写） */
const FOREIGN = new Set([
  "channel", "openid", "noip", "topic", "topicids", "uids", "webhook", "callbackurl", "to", "pre", "option",
  "apptoken", "verifypay", "verifypaytype", "token", "pushkey", "sendkey", "spt", "timestamp", "sign",
]);

/** 说明正文格式的参数（小写） */
const FORMAT_KEYS = new Set(["template", "contenttype", "type"]);

type Format = "html" | "json" | "markdown" | "text" | "image";

/** 格式参数的值 → 格式；认不出返回 undefined（这个参数就列进 ignored） */
function formatOf(key: string, raw: unknown): Format | undefined {
  const value = String(raw ?? "").trim().toLowerCase();
  if (key === "contenttype") {
    // 数字写法：1 文字、2 HTML、3 Markdown
    return ({ "1": "text", "2": "html", "3": "markdown" } as Record<string, Format>)[value] ?? namedFormat(value);
  }
  return namedFormat(value);
}

function namedFormat(value: string): Format | undefined {
  switch (value) {
    case "html":
      return "html";
    case "json":
      return "json";
    case "markdown":
    case "md":
      return "markdown";
    case "txt":
    case "text":
    case "plain":
      return "text";
    case "image":
      return "image";
    default:
      return undefined;
  }
}

/** 装正文的参数，按优先级。第一个有文字的就是这次的正文 */
const BODY_FIELDS = ["body", "content", "desp", "text", "message", "msg", "description"];

export interface ServiceParams {
  /** 改写过的参数，交给 push.ts 的 absorb 照常解析 */
  entries: [string, unknown][];
  /** 别家特有、信鸽用不上的参数名（原样拼写），列进响应的 ignored */
  ignored: string[];
}

const isText = (value: unknown) => (typeof value === "string" && value.trim() !== "") || typeof value === "number";

export function serviceParams(source: Iterable<[string, unknown]>): ServiceParams {
  const entries: [string, unknown][] = [];
  const ignored: string[] = [];
  let format: Format | undefined;
  let sawToken = false;
  const ignore = (name: string) => {
    if (!ignored.includes(name)) ignored.push(name);
  };

  for (const [name, value] of source) {
    const lower = name.toLowerCase();
    if (FOREIGN.has(lower)) {
      if (lower === "token") sawToken = true;
      ignore(name);
      continue;
    }
    if (FORMAT_KEYS.has(lower)) {
      const f = formatOf(lower, value);
      if (f) format ??= f;
      else ignore(name);
      continue;
    }
    entries.push([name, value]);
  }

  const find = (field: string) => entries.findIndex(([n, v]) => n.toLowerCase() === field && isText(v));

  // text + desp：text 是标题。原先 text 和 desp 都是正文的别名、取先写的那个，desp 整段丢了
  const textAt = find("text");
  if (find("title") < 0 && textAt >= 0 && find("desp") >= 0) {
    entries[textAt] = ["title", entries[textAt]?.[1]];
  }

  const bodyAt = BODY_FIELDS.map(find).find((i) => i >= 0) ?? -1;
  const bodyValue = bodyAt >= 0 ? entries[bodyAt]?.[1] : undefined;
  // 没写格式、却带着对方的 token：那一家默认把正文当 HTML
  if (!format && sawToken && typeof bodyValue === "string" && looksLikeHtml(bodyValue)) format = "html";
  if (bodyAt < 0 || typeof bodyValue !== "string") return { entries, ignored };

  const name = entries[bodyAt]?.[0] ?? "body";
  // desp 在那一家本来就是 Markdown：没写格式也按 Markdown 处理
  if (!format && name.toLowerCase() === "desp") format = "markdown";
  switch (format) {
    case "html":
      entries[bodyAt] = [name, htmlToText(bodyValue)];
      break;
    case "json": {
      // 正文是一段 JSON：排成「键：值」，别把一坨 JSON 原样推出去
      try {
        const lines = fieldLines(JSON.parse(bodyValue));
        if (lines) entries[bodyAt] = [name, lines];
      } catch {
        // 不是合法的 JSON：原样当文字
      }
      break;
    }
    case "image": {
      // 正文就是一张图片的地址
      const url = httpUrl(bodyValue);
      if (url) {
        entries.splice(bodyAt, 1);
        entries.push(["image", url]);
        if (!BODY_FIELDS.some((f) => find(f) >= 0)) entries.push(["body", "[图片]"]);
      }
      break;
    }
    case "markdown":
      // App 的正文只认行内 Markdown（加粗、链接）：「## 标题」「- 列表」「| 表格 |」原样显示只是一堆符号，
      // 换成读得顺的样子（见 flattenMarkdown）
      entries[bodyAt] = [name, flattenMarkdown(bodyValue)];
      break;
    default:
      // 纯文字、没写格式：不动
      break;
  }
  return { entries, ignored };
}
