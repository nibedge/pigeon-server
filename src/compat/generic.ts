import { clipText, httpUrl, httpsImage, obj, text } from "./text";

/**
 * 认不出格式的 JSON → 一条看得懂的推送。
 *
 * 原先推到 /{key} 的 JSON 只要没有 title、body 这类字段，就是一句 400「没有认得的字段」：
 * 各家服务的 webhook 五花八门，发送方多半改不了请求体，于是这个服务就接不进来。
 * 现在零配置兜底：标题取常见的键（title、name、event、status……），正文取前 6 个叶子字段排成「键：值」，
 * 保证至少推出一条看得懂的消息。原始 JSON 不整个塞进通知 —— 放不下，也没法读。
 */

/** 标题候选，按优先级。先找顶层，顶层没有再往下找一层 */
const TITLE_KEYS = [
  "title", "subject", "summary", "name", "alertname", "alert_name", "alert", "event", "event_type",
  "eventtype", "event_name", "check_name", "monitor", "service", "job", "task", "action", "type",
];

/** 状态候选：接在标题后面，「备份 · failed」 */
const STATUS_KEYS = ["status", "state", "result", "outcome", "conclusion", "health"];

/** 正文候选：有成段的文字就直接当正文，不必排「键：值」 */
const BODY_KEYS = ["body", "message", "text", "content", "description", "detail", "details", "msg", "desp"];

/** 点击链接候选 */
const URL_KEYS = [
  "url", "link", "href", "html_url", "web_url", "permalink", "detail_url", "details_url", "target_url",
  "dashboard_url", "runbook_url", "generatorurl", "externalurl",
];

const IMAGE_KEYS = ["image", "image_url", "imageurl", "picurl", "pic_url", "thumbnail", "screenshot"];

/** 级别候选：值是 critical、high 这类的，映射成通知的提醒强度 */
const LEVEL_KEYS = ["severity", "priority", "level", "urgency"];

/**
 * 看起来是凭据的字段：值不能出现在推送里。别家推送服务的 token、签名，发送方顺手带过来的密码……
 * 推送会落到每个接收者的手机上、进通知中心，凭据一旦推出去就收不回来
 */
const SECRET_KEY = /(token|secret|password|passwd|pwd|sign|signature|auth|cookie|session|credential|api_?key|access_?key|private)/i;

/** 最多排这么多个字段进正文 */
export const MAX_FIELDS = 6;
/** 每个字段的值最多这么多字 */
const VALUE_MAX_CHARS = 120;
/** 最多看这么多个节点：一个几万项的数组不该让一次推送算上半天 */
const MAX_NODES = 400;
const MAX_DEPTH = 6;

export interface GenericMessage {
  title?: string;
  body?: string;
  url?: string;
  image?: string;
  level?: string;
}

export interface GenericOptions {
  /** 顶层这些键已经被别处用掉了（信鸽自己的参数），不再排进正文 */
  skipTopLevel?: (key: string) => boolean;
}

/** 严重程度 → 提醒强度。认不出的返回 undefined，按通道默认 */
export function levelFromSeverity(raw: string | undefined): string | undefined {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return undefined;
  if (/^(critical|crit|fatal|emergency|emerg|alert|page|disaster|urgent|high|p0|p1|sev0|sev1|严重|紧急|灾难|高)$/.test(value)) {
    return "timeSensitive";
  }
  if (/^(info|informational|information|notice|low|debug|trace|none|ok|p4|p5|sev4|低|提示|信息)$/.test(value)) {
    return "passive";
  }
  if (/^(warning|warn|error|err|major|minor|medium|moderate|average|p2|p3|sev2|sev3|警告|一般|中)$/.test(value)) {
    return "active";
  }
  return undefined;
}

function findKey(
  node: Record<string, unknown>,
  candidates: readonly string[],
  accept: (v: unknown) => string | undefined,
): { key: string; value: string } | undefined {
  const lower = new Map(Object.keys(node).map((k) => [k.toLowerCase(), k]));
  for (const want of candidates) {
    const real = lower.get(want);
    if (real === undefined || SECRET_KEY.test(real)) continue;
    const value = accept(node[real]);
    if (value) return { key: real, value };
  }
  return undefined;
}

/** 在顶层找，找不到再到第一层子对象里找。返回找到的值和它的路径 */
function lookup(
  root: Record<string, unknown>,
  candidates: readonly string[],
  accept: (v: unknown) => string | undefined,
): { value: string; path: string } | undefined {
  const top = findKey(root, candidates, accept);
  if (top) return { value: top.value, path: top.key };
  for (const [key, child] of Object.entries(root)) {
    const inner = obj(child);
    if (!inner || SECRET_KEY.test(key)) continue;
    const hit = findKey(inner, candidates, accept);
    if (hit) return { value: hit.value, path: `${key}.${hit.key}` };
  }
  return undefined;
}

const oneLine = (v: unknown): string | undefined => {
  const t = text(v);
  return t ? clipText(t.replace(/\s+/g, " "), 80) : undefined;
};

/** 叶子字段：按原来的顺序深度优先，跳过凭据、空值和用掉了的 */
function leaves(root: unknown, skip: Set<string>, skipTopLevel?: (key: string) => boolean): { lines: string[]; more: number } {
  const lines: string[] = [];
  let more = 0;
  let visited = 0;
  const walk = (node: unknown, path: string, depth: number): void => {
    if (visited++ > MAX_NODES) return;
    if (Array.isArray(node)) {
      if (depth >= MAX_DEPTH) return;
      node.forEach((item, i) => walk(item, path ? `${path}.${i}` : String(i), depth + 1));
      return;
    }
    const o = obj(node);
    if (o) {
      if (depth >= MAX_DEPTH) return;
      for (const [key, value] of Object.entries(o)) {
        if (SECRET_KEY.test(key)) continue;
        if (depth === 0 && skipTopLevel?.(key)) continue;
        walk(value, path ? `${path}.${key}` : key, depth + 1);
      }
      return;
    }
    if (skip.has(path)) return;
    let value: string | undefined;
    if (typeof node === "string") value = node.trim() ? clipText(node.replace(/\s+/g, " "), VALUE_MAX_CHARS) : undefined;
    else if (typeof node === "number" && Number.isFinite(node)) value = String(node);
    else if (typeof node === "boolean") value = node ? "是" : "否";
    if (value === undefined) return;
    if (lines.length < MAX_FIELDS) lines.push(`${path || "值"}：${value}`);
    else more += 1;
  };
  walk(root, "", 0);
  return { lines, more };
}

/** 一个 JSON 值的前几个字段排成「键：值」，一行一个；不挑标题。skipTopLevel 是已经用掉的顶层键。取不出返回 undefined */
export function fieldLines(value: unknown, skipTopLevel?: (key: string) => boolean): string | undefined {
  const { lines, more } = leaves(value, new Set(), skipTopLevel);
  if (more > 0) lines.push(`…另有 ${more} 个字段`);
  return lines.length ? lines.join("\n") : undefined;
}

/**
 * 任意 JSON 值 → 标题、正文、链接、图片、级别。一样都取不出来（空对象、全是凭据）时各项都是 undefined
 */
export function genericMessage(value: unknown, options: GenericOptions = {}): GenericMessage {
  if (Array.isArray(value)) {
    const first = value.find((item) => obj(item)) ?? value[0];
    if (first === undefined) return {};
    const inner = genericMessage(first, {});
    const count = value.length > 1 ? `（共 ${value.length} 条）` : "";
    return { ...inner, title: inner.title ? `${inner.title}${count}` : count ? `收到 ${value.length} 条记录` : undefined };
  }
  const root = obj(value);
  if (!root) {
    const t = text(value);
    return t ? { body: t } : {};
  }
  const usable = (key: string) => !options.skipTopLevel?.(key);
  const scoped = Object.fromEntries(Object.entries(root).filter(([key]) => usable(key)));
  const used = new Set<string>();

  const titleHit = lookup(scoped, TITLE_KEYS, oneLine);
  const statusHit = lookup(root, STATUS_KEYS, oneLine);
  let title = titleHit?.value;
  if (titleHit) used.add(titleHit.path);
  if (statusHit && statusHit.value !== title) {
    title = title ? `${title} · ${statusHit.value}` : `状态：${statusHit.value}`;
    used.add(statusHit.path);
  }

  const urlHit = lookup(root, URL_KEYS, (v) => httpUrl(v));
  if (urlHit) used.add(urlHit.path);
  const imageHit = lookup(root, IMAGE_KEYS, (v) => httpsImage(v));
  if (imageHit) used.add(imageHit.path);
  const levelHit = lookup(root, LEVEL_KEYS, (v) => levelFromSeverity(text(v)));

  // 有成段的文字（message、description……）就直接当正文；没有才排「键：值」
  const prose = findKey(scoped, BODY_KEYS, text);
  let body: string | undefined;
  if (prose) {
    body = prose.value.trim();
  } else {
    const { lines, more } = leaves(root, used, options.skipTopLevel);
    if (more > 0) lines.push(`…另有 ${more} 个字段`);
    body = lines.length ? lines.join("\n") : undefined;
  }

  return {
    title,
    body,
    url: urlHit?.value,
    image: imageHit?.value,
    level: levelHit?.value,
  };
}
