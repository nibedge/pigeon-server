import { genericMessage } from "./generic";
import {
  arr,
  clipText,
  flattenMarkdown,
  fromAngleMarkup,
  fromAtTags,
  fromEmbedMarkup,
  httpsImage,
  joinFieldLines,
  labelled,
  obj,
  plainInline,
  plainTitle,
  splitTitle,
  text,
  tidy,
  TITLE_MAX_CHARS,
  unwrapLink,
  type Mentions,
} from "./text";

/**
 * 群机器人的四类消息格式。很多工具（面板、监控、CI、签到脚本）只会往群机器人发消息，用户手里是一个现成的
 * 机器人地址：认得这几种结构，换个域名就能把它们接过来，不必改一行发送代码。
 *
 * 只按结构命名，不写来源：
 *   msgtype 风格  {msgtype, text:{content}, markdown:{title,text|content}, link, actionCard, feedCard, news:{articles}, template_card, at:{isAtAll}}
 *   msg_type 风格 {msg_type, content:{text|post}, card}
 *   embeds 风格   {content, embeds:[{title, description, url, color, fields, image, footer}]}
 *   blocks 风格   {text, blocks:[…], attachments:[…]}
 */
export type RobotStyle = "msgtype" | "msg_type" | "embeds" | "blocks";

/** 从一条群机器人消息里读出来的东西，交给推送参数 */
export interface RobotMessage {
  title?: string;
  subtitle?: string;
  body?: string;
  /** 原样的 Markdown（去掉块级标记之前）。App 目前只显示 body，留着给以后按块渲染 */
  markdown?: string;
  url?: string;
  image?: string;
  icon?: string;
  /** 消息里 @ 了所有人：发送方明说了人人都得看 */
  mentionAll: boolean;
  /** 给发送方的中文提示：图片、文件这类转不过来的 */
  warnings: string[];
}

/** 请求体像哪一种群机器人格式；都不像返回 null */
export function detectRobotStyle(payload: unknown): RobotStyle | null {
  const p = obj(payload);
  if (!p) return null;
  if (typeof p.msgtype === "string" && p.msgtype.trim()) return "msgtype";
  if (typeof p.msg_type === "string" && p.msg_type.trim()) return "msg_type";
  if (Array.isArray(p.embeds) && p.embeds.some((e) => obj(e))) return "embeds";
  if ((Array.isArray(p.blocks) && p.blocks.some((b) => obj(b))) || (Array.isArray(p.attachments) && p.attachments.some((a) => obj(a)))) {
    return "blocks";
  }
  return null;
}

/** 一条消息里有好几条（图文、卡片列表）时，第一条展开，其余只列标题 */
const MAX_LISTED = 5;

function othersLine(titles: string[]): string | undefined {
  if (titles.length === 0) return undefined;
  const shown = titles.slice(0, MAX_LISTED).map((t) => `• ${t}`);
  const rest = titles.length > MAX_LISTED ? [`…共另 ${titles.length} 条`] : [];
  return [`另 ${titles.length} 条：`, ...shown, ...rest].join("\n");
}

function joinParts(...parts: (string | undefined)[]): string | undefined {
  const joined = tidy(parts.filter((p): p is string => Boolean(p && p.trim())).join("\n\n"));
  return joined || undefined;
}

function empty(): RobotMessage {
  return { mentionAll: false, warnings: [] };
}

/** 转不过来的消息（图片、文件、语音）：推一句说明，让人知道来了东西、去原处看 */
function placeholder(kind: string): RobotMessage {
  return {
    ...empty(),
    body: `[${kind}]`,
    warnings: [`${kind}没法转成通知，只推了一句「[${kind}]」提示`],
  };
}

/** Markdown 正文：body 放去掉块级标记的，markdown 放原文（和 body 不一样时才放） */
function markdownBody(md: string | undefined, title?: string): { body?: string; markdown?: string } {
  if (!md) return {};
  let source = tidy(md);
  // 正文第一行常常就是「## 标题」，和 title 重复，去掉（比的是去掉 <font> 这类标签之后的文字）
  if (title) {
    const [first = "", ...rest] = source.split("\n");
    if (plainTitle(first) === plainTitle(title)) source = tidy(rest.join("\n"));
  }
  const body = flattenMarkdown(source);
  return { body: body || undefined, markdown: body && body !== source ? source : undefined };
}

/**
 * 从 Markdown 正文里认一个标题：第一行是「# 标题」或「**标题**」。
 * 标题行里常夹着 <font color=…>（给群里的卡片上色）：去掉，只留文字 —— 通知标题不认标签
 */
function headingOf(md: string | undefined): string | undefined {
  const first = (md ?? "").trim().split("\n")[0] ?? "";
  const heading = /^#{1,6}\s+(.+)$/.exec(first.trim())?.[1] ?? /^\*\*(.+)\*\*$/.exec(first.trim())?.[1];
  return heading ? clipText(plainTitle(heading), 60) || undefined : undefined;
}

// ── msgtype 风格 ────────────────────────────────────────────────────

function msgtypeMessage(p: Record<string, unknown>): RobotMessage {
  const type = String(p.msgtype).trim();
  const node = obj(p[type]) ?? obj(p[type.toLowerCase()]) ?? {};
  const at = obj(p.at);
  const listAll = (list: unknown) => arr(list).some((x) => typeof x === "string" && x.trim().toLowerCase() === "@all");
  let mentionAll =
    at?.isAtAll === true || at?.isAtAll === "true" || listAll(node.mentioned_list) || listAll(node.mentioned_mobile_list);
  const markAll = (m: Mentions) => {
    mentionAll ||= m.all;
    return m.text;
  };
  // 正文里的 <@all>、<@userid>（部分 markdown 写法）
  const atMarks = (raw: string | undefined): string | undefined =>
    raw === undefined
      ? undefined
      : markAll({
          all: /<@all>/i.test(raw),
          text: raw.replace(/<@all>/gi, "@所有人").replace(/<@([^>\s]+)>/g, "@$1"),
        });

  let out: RobotMessage = empty();
  switch (type.toLowerCase()) {
    case "text": {
      out = { ...empty(), ...splitTitle(atMarks(text(node.content)) ?? "") };
      break;
    }
    case "markdown":
    case "markdown_v2": {
      const md = atMarks(text(node.text) ?? text(node.content));
      const title = clipText(plainTitle(text(node.title) ?? ""), 60) || headingOf(md);
      out = { ...empty(), title, ...markdownBody(md, title) };
      break;
    }
    case "link": {
      out = {
        ...empty(),
        title: text(node.title),
        body: text(node.text),
        url: unwrapLink(node.messageUrl ?? node.messageURL ?? node.url),
        image: httpsImage(node.picUrl ?? node.picURL),
      };
      break;
    }
    case "actioncard": {
      const buttons = arr(node.btns).map(obj).filter((b): b is Record<string, unknown> => Boolean(b));
      const title = text(node.title);
      out = {
        ...empty(),
        title,
        ...markdownBody(atMarks(text(node.text)), title),
        url: unwrapLink(node.singleURL ?? node.singleUrl) ?? buttons.map((b) => unwrapLink(b.actionURL ?? b.actionUrl)).find(Boolean),
      };
      break;
    }
    case "feedcard": {
      const links = arr(node.links).map(obj).filter((l): l is Record<string, unknown> => Boolean(l));
      const [first, ...rest] = links;
      out = {
        ...empty(),
        title: text(first?.title),
        body: othersLine(rest.map((l) => text(l.title)).filter((t): t is string => Boolean(t))),
        url: unwrapLink(first?.messageURL ?? first?.messageUrl ?? first?.url),
        image: httpsImage(first?.picURL ?? first?.picUrl),
      };
      break;
    }
    case "news": {
      const articles = arr(node.articles).map(obj).filter((a): a is Record<string, unknown> => Boolean(a));
      const [first, ...rest] = articles;
      out = {
        ...empty(),
        title: text(first?.title),
        body: joinParts(
          text(first?.description),
          othersLine(rest.map((a) => text(a.title)).filter((t): t is string => Boolean(t))),
        ),
        url: unwrapLink(first?.url),
        image: httpsImage(first?.picurl ?? first?.picUrl),
      };
      break;
    }
    case "template_card": {
      const main = obj(node.main_title);
      const emphasis = obj(node.emphasis_content);
      const quote = obj(node.quote_area);
      const pairs = arr(node.horizontal_content_list)
        .map(obj)
        .map((kv) => (kv && text(kv.keyname) ? `${text(kv.keyname)}：${text(kv.value) ?? ""}` : undefined));
      const verticals = arr(node.vertical_content_list)
        .map(obj)
        .map((v) => (v ? joinParts(text(v.title), text(v.desc)) : undefined));
      const action = obj(node.card_action);
      const jump = arr(node.jump_list).map(obj).find((j) => j && unwrapLink(j.url));
      out = {
        ...empty(),
        title: text(main?.title) ?? text(obj(node.source)?.desc),
        subtitle: text(main?.desc),
        body: joinParts(
          emphasis && text(emphasis.title) ? `${text(emphasis.desc) ?? ""}：${text(emphasis.title)}`.replace(/^：/, "") : undefined,
          text(node.sub_title_text),
          text(quote?.quote_text),
          pairs.filter(Boolean).join("\n"),
          verticals.filter(Boolean).join("\n"),
        ),
        url: unwrapLink(action?.url) ?? unwrapLink(jump?.url),
        image: httpsImage(obj(node.card_image)?.url),
      };
      break;
    }
    case "image":
      return { ...placeholder("图片"), mentionAll };
    case "file":
      return { ...placeholder("文件"), mentionAll };
    case "voice":
      return { ...placeholder("语音"), mentionAll };
    default: {
      // 认不得的子类型：按通用 JSON 取
      const generic = genericMessage(Object.keys(node).length ? node : p, { skipTopLevel: (k) => k === "msgtype" });
      out = { ...empty(), ...generic, warnings: [`msgtype「${type}」没见过，按通用 JSON 取了标题和字段`] };
    }
  }
  return { ...out, mentionAll: mentionAll || out.mentionAll };
}

// ── msg_type 风格 ───────────────────────────────────────────────────

/** 富文本（post）的一个元素 → 文字 */
function postElement(e: Record<string, unknown>, state: { all: boolean; url?: string }): string {
  const tag = String(e.tag ?? "");
  switch (tag) {
    case "text":
    case "md":
    case "code_block":
      return String(e.text ?? "");
    case "a": {
      const href = unwrapLink(e.href);
      const label = text(e.text) ?? href ?? "";
      if (href) state.url ??= href;
      return href && label !== href ? `[${label}](${href})` : label;
    }
    case "at":
      if (String(e.user_id ?? "").toLowerCase() === "all") {
        state.all = true;
        return "@所有人";
      }
      return `@${text(e.user_name) ?? "成员"}`;
    case "img":
    case "media":
      return "[图片]";
    case "hr":
      return "———";
    default:
      return text(e.text) ?? "";
  }
}

/** 卡片里的文字：div、markdown、字段、备注、按钮链接；分栏、折叠面板往里递归 */
function cardTexts(elements: unknown, lines: string[], state: { all: boolean; url?: string }, depth = 0): void {
  if (depth > 6) return;
  for (const raw of arr(elements)) {
    const e = obj(raw);
    if (!e) continue;
    const tag = String(e.tag ?? "");
    const say = (value: unknown) => {
      const t = text(value);
      if (t) {
        const m = fromAtTags(t);
        state.all ||= m.all;
        lines.push(m.text);
      }
    };
    switch (tag) {
      case "div": {
        say(obj(e.text)?.content);
        // 并排的短字段常写成「**服务**\n值」：并成一行「服务：值」
        const fields = arr(e.fields)
          .map((f) => text(obj(obj(f)?.text)?.content))
          .filter((t): t is string => Boolean(t))
          .map(joinFieldLines);
        if (fields.length) say(fields.join("\n"));
        break;
      }
      case "markdown":
      case "plain_text":
        say(e.content);
        break;
      case "note":
        say(
          arr(e.elements)
            .map((n) => text(obj(n)?.content))
            .filter(Boolean)
            .join(" "),
        );
        break;
      case "action":
        for (const a of arr(e.actions)) {
          const button = obj(a);
          const link = unwrapLink(button?.url) ?? unwrapLink(obj(button?.multi_url)?.url);
          if (link) state.url ??= link;
        }
        break;
      case "button": {
        const direct = unwrapLink(e.url) ?? unwrapLink(obj(e.multi_url)?.url);
        const behavior = arr(e.behaviors)
          .map(obj)
          .map((b) => unwrapLink(b?.default_url) ?? unwrapLink(b?.url))
          .find(Boolean);
        if (direct ?? behavior) state.url ??= direct ?? behavior;
        break;
      }
      case "column_set":
        for (const column of arr(e.columns)) cardTexts(obj(column)?.elements, lines, state, depth + 1);
        break;
      case "collapsible_panel":
        say(obj(obj(e.header)?.title)?.content);
        cardTexts(e.elements, lines, state, depth + 1);
        break;
      case "form":
      case "interactive_container":
        cardTexts(e.elements, lines, state, depth + 1);
        break;
      default:
        // 带 _md 后缀的文字元素（卡片里的 Markdown 文本）
        if (/_md$/.test(tag)) say(e.content);
        break;
    }
  }
}

function msgTypeMessage(p: Record<string, unknown>): RobotMessage {
  const type = String(p.msg_type).trim().toLowerCase();
  const content = obj(p.content) ?? {};
  switch (type) {
    case "text": {
      const m = fromAtTags(text(content.text) ?? "");
      return { ...empty(), ...splitTitle(m.text), mentionAll: m.all };
    }
    case "post": {
      const post = obj(content.post) ?? {};
      const lang = obj(post.zh_cn) ?? obj(post.en_us) ?? obj(post.ja_jp) ?? obj(Object.values(post)[0]) ?? {};
      const state: { all: boolean; url?: string } = { all: false };
      const lines = arr(lang.content).map((paragraph) =>
        arr(paragraph)
          .map(obj)
          .filter((e): e is Record<string, unknown> => Boolean(e))
          .map((e) => postElement(e, state))
          .join(""),
      );
      return {
        ...empty(),
        title: text(lang.title),
        body: tidy(lines.join("\n")) || undefined,
        url: state.url,
        mentionAll: state.all,
      };
    }
    case "interactive": {
      let card: unknown = p.card ?? content.card ?? content;
      if (typeof card === "string") {
        try {
          card = JSON.parse(card);
        } catch {
          card = {};
        }
      }
      const c = obj(card) ?? {};
      // 模板卡片只给了模板 id 和变量：内容在别家的模板里，这里看不到
      if (c.type === "template") {
        const vars = obj(obj(c.data)?.template_variable);
        const generic = vars ? genericMessage(vars) : {};
        return { ...empty(), ...generic, title: generic.title ?? "卡片消息", warnings: ["卡片用的是模板，模板内容不在请求里，只推了能看到的变量"] };
      }
      const header = obj(c.header) ?? obj(obj(c.i18n_header)?.zh_cn);
      const state: { all: boolean; url?: string } = { all: false };
      const lines: string[] = [];
      const i18n = obj(c.i18n_elements);
      const elements = c.elements ?? obj(c.body)?.elements ?? i18n?.zh_cn ?? i18n?.en_us ?? Object.values(i18n ?? {})[0];
      cardTexts(elements, lines, state);
      const cardLink = obj(c.card_link);
      const md = tidy(lines.join("\n"));
      const title = text(obj(header?.title)?.content);
      return {
        ...empty(),
        title,
        subtitle: text(obj(header?.subtitle)?.content),
        ...markdownBody(md || undefined, title),
        url: unwrapLink(cardLink?.url) ?? state.url,
        mentionAll: state.all,
      };
    }
    case "image":
      return placeholder("图片");
    case "share_chat":
      return placeholder("群名片");
    case "file":
    case "media":
    case "audio":
    case "sticker":
      return placeholder("文件");
    default: {
      const generic = genericMessage(Object.keys(content).length ? content : p, { skipTopLevel: (k) => k === "msg_type" });
      return { ...empty(), ...generic, warnings: [`msg_type「${type}」没见过，按通用 JSON 取了标题和字段`] };
    }
  }
}

// ── embeds 风格 ─────────────────────────────────────────────────────

function embedsMessage(p: Record<string, unknown>): RobotMessage {
  let all = false;
  const clean = (raw: unknown): string | undefined => {
    const t = text(raw);
    if (!t) return undefined;
    const m = fromEmbedMarkup(t);
    all ||= m.all;
    return m.text;
  };
  const content = clean(p.content);
  const embeds = arr(p.embeds).map(obj).filter((e): e is Record<string, unknown> => Boolean(e));
  const [first, ...rest] = embeds;
  const author = obj(first?.author);
  const rawFields = arr(first?.fields).map(obj).filter((f): f is Record<string, unknown> => Boolean(f));
  const fields = rawFields
    .map((f) => (text(f.name) ? labelled(clean(f.name) ?? "", clean(f.value)) : clean(f.value)))
    .filter((t): t is string => Boolean(t));

  const description = clean(first?.description);
  let title = clean(first?.title) ?? clean(author?.name);
  let lead = content;
  if (!title && content) {
    const split = splitTitle(content);
    if (split.title) {
      title = split.title;
      lead = split.body;
    } else if ((description || fields.length) && Array.from(plainInline(content)).length <= TITLE_MAX_CHARS) {
      // 一句话的 content 加一张卡片：content 就是这条消息说的事，卡片是细节 —— 当标题
      title = content;
      lead = undefined;
    }
  }
  // 卡片的描述是 Markdown（标题、引用、列表都有）：和别的格式一样去掉块级标记，原文放 markdown
  const described = markdownBody(description, title);
  const fieldText = fields.join("\n") || undefined;
  const others = othersLine(rest.map((e) => clean(e.title) ?? clean(e.description)).filter((t): t is string => Boolean(t)));
  return {
    ...empty(),
    title: title ? plainTitle(title) : undefined,
    body: joinParts(lead, described.body, fieldText, others),
    markdown: described.markdown ? joinParts(lead, described.markdown, fieldText, others) : undefined,
    url: unwrapLink(first?.url) ?? unwrapLink(author?.url) ?? fieldLink(rawFields.map((f) => [text(f.name), f.value])),
    image: httpsImage(obj(first?.image)?.url),
    icon: httpsImage(obj(first?.thumbnail)?.url),
    mentionAll: all,
  };
}

/**
 * 卡片没给点击链接时，从字段里找一个：名字里带 URL、链接、地址，值就是一个网址的（「Service URL：https://…」）。
 * 只认名字说明了是链接的字段 —— 随便拿一个值像网址的字段，点开的可能是回调地址、镜像源
 */
function fieldLink(fields: [string | undefined, unknown][]): string | undefined {
  for (const [name, value] of fields) {
    if (name && /(url|link|链接|地址|网址)/i.test(name)) {
      const link = unwrapLink(typeof value === "string" ? value.trim().replace(/^<(.+)>$/, "$1").replace(/\|.*$/, "") : value);
      if (link) return link;
    }
  }
  return undefined;
}

// ── blocks 风格 ─────────────────────────────────────────────────────

interface BlockState {
  all: boolean;
  url?: string;
  image?: string;
  header?: string;
  lines: string[];
}

function mrkdwn(state: BlockState, raw: unknown): string | undefined {
  const t = text(raw);
  if (!t) return undefined;
  const m = fromAngleMarkup(t);
  state.all ||= m.all;
  return m.text;
}

/** 表情元素：有码点就还原成表情，没有就写短码 */
function emojiOf(e: Record<string, unknown>): string {
  const codes = String(e.unicode ?? "")
    .split("-")
    .map((h) => parseInt(h, 16))
    .filter((n) => Number.isInteger(n) && n > 0 && n <= 0x10ffff);
  if (codes.length) return String.fromCodePoint(...codes);
  return text(e.name) ? `:${String(e.name)}:` : "";
}

/** 富文本块（rich_text）：文字、链接、@、广播 */
function richText(state: BlockState, elements: unknown, depth = 0): string {
  if (depth > 5) return "";
  return arr(elements)
    .map(obj)
    .map((e) => {
      if (!e) return "";
      switch (e.type) {
        case "text":
          return String(e.text ?? "");
        case "link": {
          const href = unwrapLink(e.url);
          if (href) state.url ??= href;
          const label = text(e.text);
          return href ? (label && label !== href ? `[${label}](${href})` : href) : (label ?? "");
        }
        case "broadcast":
          state.all = true;
          return "@所有人";
        case "user":
          return "@成员";
        case "channel":
          return "#频道";
        case "emoji":
          return emojiOf(e);
        case "rich_text_section":
        case "rich_text_preformatted":
        case "rich_text_quote":
          return `${richText(state, e.elements, depth + 1)}\n`;
        case "rich_text_list":
          return `${arr(e.elements)
            .map((item) => `• ${richText(state, obj(item)?.elements, depth + 1)}`)
            .join("\n")}\n`;
        default:
          return "";
      }
    })
    .join("");
}

function blockTexts(state: BlockState, blocks: unknown): void {
  for (const raw of arr(blocks)) {
    const b = obj(raw);
    if (!b) continue;
    switch (b.type) {
      case "header": {
        const t = mrkdwn(state, obj(b.text)?.text);
        if (t && !state.header) state.header = t;
        else if (t) state.lines.push(`**${t}**`);
        break;
      }
      case "section": {
        const t = mrkdwn(state, obj(b.text)?.text);
        if (t) state.lines.push(t);
        const fields = arr(b.fields)
          .map((f) => mrkdwn(state, obj(f)?.text))
          .filter((x): x is string => Boolean(x))
          // 字段常写成「*名字*\n值」：并成一行「名字：值」
          .map(joinFieldLines);
        if (fields.length) state.lines.push(fields.join("\n"));
        const accessory = obj(b.accessory);
        const link = unwrapLink(accessory?.url);
        if (link) state.url ??= link;
        break;
      }
      case "context": {
        const parts = arr(b.elements)
          .map((e) => (obj(e)?.type === "image" ? undefined : mrkdwn(state, obj(e)?.text)))
          .filter((x): x is string => Boolean(x));
        if (parts.length) state.lines.push(parts.join(" · "));
        break;
      }
      case "image":
        state.image ??= httpsImage(b.image_url);
        break;
      case "actions":
        for (const e of arr(b.elements)) {
          const link = unwrapLink(obj(e)?.url);
          if (link) state.url ??= link;
        }
        break;
      case "rich_text": {
        const t = tidy(richText(state, b.elements));
        if (t) state.lines.push(t);
        break;
      }
      default:
        break;
    }
  }
}

function blocksMessage(p: Record<string, unknown>): RobotMessage {
  const state: BlockState = { all: false, lines: [] };
  blockTexts(state, p.blocks);

  const attachments = arr(p.attachments).map(obj).filter((a): a is Record<string, unknown> => Boolean(a));
  const [first, ...rest] = attachments;
  let attTitle: string | undefined;
  // 字段里的链接只在别处都没有链接时才用（见 fieldLink）
  let fieldUrl: string | undefined;
  if (first) {
    attTitle = mrkdwn(state, first.title);
    const link = unwrapLink(first.title_link);
    if (link) state.url ??= link;
    const pre = mrkdwn(state, first.pretext);
    const author = mrkdwn(state, first.author_name);
    const body = mrkdwn(state, first.text);
    const rawFields = arr(first.fields).map(obj).filter((f): f is Record<string, unknown> => Boolean(f));
    const fields = rawFields
      .map((f) => (text(f.title) ? labelled(mrkdwn(state, f.title) ?? "", mrkdwn(state, f.value)) : mrkdwn(state, f.value)))
      .filter((x): x is string => Boolean(x));
    fieldUrl = fieldLink(rawFields.map((f) => [text(f.title), f.value]));
    blockTexts(state, first.blocks);
    for (const part of [pre, author, body, fields.join("\n")]) if (part) state.lines.push(part);
    state.image ??= httpsImage(first.image_url);
    if (!attTitle && !body && !fields.length) {
      const fallback = mrkdwn(state, first.fallback);
      if (fallback) state.lines.push(fallback);
    }
  }
  const others = othersLine(rest.map((a) => mrkdwn(state, a.title) ?? mrkdwn(state, a.fallback)).filter((t): t is string => Boolean(t)));
  if (others) state.lines.push(others);

  // 顶层 text 在带了 blocks 时是通知里的摘要：没有别的标题就拿它当标题，否则不再重复
  const top = mrkdwn(state, p.text);
  let title = state.header ?? attTitle;
  const lines = [...state.lines];
  if (top) {
    if (!title && lines.length) {
      const split = splitTitle(top);
      const single = tidy(top);
      if (split.title) {
        title = split.title;
        if (split.body && split.body !== lines[0]) lines.unshift(split.body);
      } else if (single !== tidy(lines[0] ?? "") && Array.from(plainInline(single)).length <= 60) {
        // 一行的摘要，和正文第一行不一样：当标题；一样的话就只留正文，不重复
        title = plainInline(single);
      }
    } else if (!lines.length) {
      const split = splitTitle(top);
      title ??= split.title;
      if (split.body) lines.push(split.body);
    }
  }
  const md = tidy(lines.join("\n"));
  return {
    ...empty(),
    title: title ? plainInline(title) : undefined,
    ...markdownBody(md || undefined, title),
    url: state.url ?? fieldUrl,
    image: state.image,
    icon: first ? httpsImage(first.thumb_url) : undefined,
    mentionAll: state.all,
  };
}

/** 按格式读出消息。请求体不是对象时返回空消息 */
export function robotMessage(style: RobotStyle, payload: unknown): RobotMessage {
  const p = obj(payload);
  if (!p) return empty();
  switch (style) {
    case "msgtype":
      return msgtypeMessage(p);
    case "msg_type":
      return msgTypeMessage(p);
    case "embeds":
      return embedsMessage(p);
    case "blocks":
      return blocksMessage(p);
  }
}
