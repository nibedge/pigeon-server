import { isDeadToken, pushToDevice, type ApnsHeaders } from "./apns";
import { isMuted, newId, recordPushOutcome } from "./db";
import { applyPolicy, applyQuietHours } from "./policy";
import type { Account, Channel, Device, Env, PushParams, PushResult } from "./types";

/** 所有认识的推送参数名。既用于从 query / body 里挑字段，也是通道默认值的白名单 */
export const PARAM_KEYS = [
  "title", "subtitle", "body", "level", "volume", "badge", "call",
  "autoCopy", "copy", "sound", "icon", "group", "ciphertext", "iv",
  "isArchive", "ttl", "url", "image", "markdown", "action", "id", "delete",
  "tags", "status",
] as const;

/**
 * 参数别名。
 *
 * 同一个含义历史上有多种写法（全小写、驼峰），这里统一收敛，
 * 让从别处迁过来的脚本不必逐个改写。别名只影响入参解析，
 * 不构成对外承诺 —— 规范写法以 README 的参数表为准。
 */
const ALIASES: Record<string, string> = {
  autocopy: "autoCopy",
  isarchive: "isArchive",
  device_key: "__ignored",
  device_keys: "__ignored",
};

function normalizeName(raw: string): string | null {
  const alias = ALIASES[raw];
  if (alias) return alias === "__ignored" ? null : alias;
  const hit = PARAM_KEYS.find((k) => k.toLowerCase() === raw.toLowerCase());
  return hit ?? null;
}

/**
 * 正文的常见别名。许多现成服务的 webhook 用 text（Slack 风格）、content（Discord 风格）、
 * message（通用）装正文。原先不认它们：推送只剩标题，正文静默丢失，发送方毫无察觉 ——
 * 实测一条 {"title", "text"} 的推送就这样只显示了标题。
 *
 * 这是「软别名」：同一份来源里已经有 body 时以 body 为准，与字段先后无关。
 * 只收字符串和数字：有的服务把整个对象塞在 message 里，转成字符串只会得到 [object Object]。
 */
const BODY_ALIASES = new Set(["text", "message", "content"]);

function absorb(into: PushParams, source: Iterable<[string, unknown]>): void {
  const soft: string[] = [];
  for (const [rawName, rawValue] of source) {
    if (rawValue === null || rawValue === undefined) continue;
    if (BODY_ALIASES.has(rawName.toLowerCase())) {
      if (typeof rawValue === "string" || typeof rawValue === "number") {
        const value = String(rawValue);
        if (value !== "") soft.push(value);
      }
      continue;
    }
    const name = normalizeName(rawName);
    if (!name) continue;
    const value = String(rawValue);
    if (value === "") continue;
    (into as Record<string, string>)[name] = value;
  }
  // 整份来源读完才落软别名：body 写在前还是写在后，都是 body 赢
  if (!into.body && soft.length > 0) into.body = soft[0];
}

/**
 * 收集一次推送的参数，后面的覆盖前面的：
 *   通道默认值 → query string → 请求体 → URL 路径段
 *
 * 路径段优先级最高，因为 `/{key}/标题/内容` 是最显式的写法。
 */
export async function collectParams(
  request: Request,
  url: URL,
  pathText: string[],
  channel: Channel,
): Promise<PushParams> {
  // 通道默认值垫底：用户在 App 里给「生产监控」设了铃声和级别之后，
  // 每次推送不必再重复带这些参数。
  const params: PushParams = { ...(channel.defaults ?? {}) };

  absorb(params, url.searchParams.entries());

  if (request.method !== "GET" && request.method !== "HEAD") {
    const contentType = request.headers.get("content-type") ?? "";
    try {
      if (contentType.includes("application/json")) {
        const parsed = (await request.json()) as Record<string, unknown>;
        if (parsed && typeof parsed === "object") absorb(params, Object.entries(parsed));
      } else if (
        contentType.includes("form-urlencoded") ||
        contentType.includes("multipart/form-data")
      ) {
        const form = await request.formData();
        absorb(params, [...form.entries()] as [string, unknown][]);
      }
    } catch {
      // 请求体解析不了就当没有 —— 路径和 query 里的参数仍然算数
    }
  }

  // 路径段：/{key}/body · /{key}/title/body · /{key}/title/subtitle/body
  const [a, b, c] = pathText;
  if (pathText.length === 1 && a) {
    params.body = a;
  } else if (pathText.length === 2 && a && b) {
    params.title = a;
    params.body = b;
  } else if (pathText.length >= 3 && a && b && c) {
    params.title = a;
    params.subtitle = b;
    params.body = c;
  }

  return params;
}

// ── payload ─────────────────────────────────────────────────────────

/** 推送携带的通道身份。只放公开的 id 和名称，绝不放 key —— payload 会落到每个成员手机上 */
export interface Origin {
  id: string;
  name: string;
}

const INTERRUPTION_LEVELS: Record<string, string> = {
  passive: "passive",
  active: "active",
  timesensitive: "time-sensitive",
  "time-sensitive": "time-sensitive",
  // 真正的 critical 需要 Apple 单独审批的 critical-alerts 权限，拿到之前系统不认。
  // 在那之前按 time-sensitive 送 —— 这是实际能做到的最强级别，不承诺做不到的。
  critical: "time-sensitive",
};

/**
 * level → APNs 的 interruption-level。
 *
 * 这一步曾经整个漏掉：level 只被当成普通字段塞进 payload 顶层，而系统只看
 * aps 里的 interruption-level —— 于是 passive 照样亮屏弹横幅，免打扰的
 * 「降级」只去掉了声音。没有任何报错，只有半夜被横幅照醒的人知道。
 */
export function interruptionLevel(level?: string): string | undefined {
  return level ? INTERRUPTION_LEVELS[level.toLowerCase()] : undefined;
}

/**
 * 铃声。APNs 的规矩是 aps 里没有 sound 就**不出声** —— 不指定铃声的推送原先
 * 全是静音的，和 App 里「留空为系统默认」的说法对不上。
 *
 * passive 不补默认铃声：它本来就不该出声，免打扰降级也正是靠去掉铃声来压低。
 * 发送方可以用 sound=none 显式静音。
 */
function soundFor(params: PushParams): string | undefined {
  if (params.sound === "none") return undefined;
  if (params.sound) return params.sound;
  return interruptionLevel(params.level) === "passive" ? undefined : "default";
}

/**
 * 组装 APNs payload。
 *
 * 顶层扩展字段（icon / url / copy …）不放在 aps 里，是因为 aps 是 Apple 保留的
 * 命名空间，自定义键必须与它平级；App 的 Notification Service Extension 从顶层读。
 * 反过来，系统要认的东西（级别、铃声、角标）必须进 aps，放在顶层等于没写。
 */
export function buildPayload(
  params: PushParams,
  category: string,
  origin?: Origin,
): Record<string, unknown> {
  if (params.delete === "1") {
    return {
      aps: { "content-available": 1, "mutable-content": 1 },
      id: params.id,
      delete: params.delete,
    };
  }

  const hasText = Boolean(params.title || params.subtitle || params.body);
  // 端到端加密的消息，服务端手里只有密文。系统先显示占位文字，真正的标题和正文由
  // App 的通知扩展解密后替换 —— 这台设备没有密钥、解不开时，用户看到的就是这一句
  const alert =
    params.ciphertext && !hasText
      ? { title: origin?.name ?? "信鸽", body: "🔒 加密消息" }
      : { title: params.title, subtitle: params.subtitle, body: hasText ? params.body : "Empty Message" };
  const aps: Record<string, unknown> = {
    alert,
    sound: soundFor(params),
    // 没指定分组时按通道归组：通知中心里同一个通道的消息叠在一起，
    // 不同来源的告警不会混成一长串
    "thread-id": params.group ?? origin?.id,
    // iOS 里 UNNotificationCategory 的标识符。操作按钮靠它注册，对不上按钮就不出现
    // （通知本身照常送达，所以很容易漏看）。
    category,
    // 必须为 1，否则 NSE 不会被唤起，图标下载和历史归档都不会发生
    "mutable-content": 1,
  };

  const level = interruptionLevel(params.level);
  if (level) aps["interruption-level"] = level;

  if (params.badge !== undefined) {
    const badge = Number(params.badge);
    if (Number.isInteger(badge) && badge >= 0) aps.badge = badge;
  }

  const payload: Record<string, unknown> = { aps };

  // App 端从 payload 顶层读这些
  const ext: (keyof PushParams)[] = [
    "group", "call", "isArchive", "icon", "ciphertext", "iv", "level",
    "volume", "url", "copy", "autoCopy", "action", "image",
    "markdown", "id", "ttl",
  ];
  const wireName: Partial<Record<keyof PushParams, string>> = {
    isArchive: "isarchive",
    autoCopy: "autocopy",
  };
  for (const k of ext) {
    const v = params[k];
    if (v !== undefined && v !== "") payload[wireName[k] ?? k] = v;
  }

  const tags = normalizeTags(params.tags);
  if (tags) payload.tags = tags;
  if (params.status === "firing" || params.status === "resolved") payload.status = params.status;

  // App 靠这两个字段把历史按通道归类
  if (origin) {
    payload.channel_id = origin.id;
    payload.channel_name = origin.name;
  }

  return payload;
}

/** 标签：逗号分隔（中英文逗号都认），去重，最多 5 个、每个 24 字以内 —— 照单全收会把通知撑爆 */
export function normalizeTags(raw?: string): string | undefined {
  if (!raw) return undefined;
  const tags = [
    ...new Set(
      raw.split(/[,，]/).map((t) => t.trim()).filter(Boolean).map((t) => t.slice(0, 24)),
    ),
  ].slice(0, 5);
  return tags.length ? tags.join(",") : undefined;
}

export function pushHeaders(params: PushParams): ApnsHeaders {
  const silent = params.delete === "1";
  const headers: ApnsHeaders = {
    "apns-push-type": silent ? "background" : "alert",
    "apns-priority": silent ? "5" : "10",
  };
  // APNs 对 collapse-id 限 64 字节，超了整条推送会被 400 拒掉 —— 宁可不折叠也要送达
  if (params.id && new TextEncoder().encode(params.id).length <= 64) {
    headers["apns-collapse-id"] = params.id;
  }
  return headers;
}

// ── 投递 ────────────────────────────────────────────────────────────

/** 群组的通知带「我来处理」按钮，个人通道不带 —— 一个人的通道不存在「谁来接手」的问题 */
export function categoryFor(
  env: Pick<Env, "APNS_CATEGORY">,
  channel: Pick<Channel, "memberIds">,
): string {
  const base = env.APNS_CATEGORY || "pigeonNotification";
  return channel.memberIds.length > 0 ? `${base}.group` : base;
}

interface Target {
  accountId: string;
  device: Device;
}

function targetsOf(recipients: Account[]): Target[] {
  return recipients.flatMap((account) =>
    account.devices.map((device) => ({ accountId: account.id, device })),
  );
}

function originOf(channel: Channel): Origin {
  return { id: channel.id, name: channel.name };
}

/**
 * 按每个人的免打扰分成两拨。免打扰的人照样收到，只是降成静默 —— 和免打扰时段同一个
 * 原则：压低，不丢；消息照常进通知中心和历史。critical 例外：会用到它的场景，正是
 * 免打扰也该被叫醒的时候。
 */
export function partitionByMute(
  recipients: Account[],
  channelId: string,
  level: string | undefined,
  now = Date.now(),
): { loud: Account[]; quiet: Account[] } {
  if ((level ?? "").toLowerCase() === "critical") return { loud: recipients, quiet: [] };
  const loud: Account[] = [];
  const quiet: Account[] = [];
  for (const account of recipients) (isMuted(account, channelId, now) ? quiet : loud).push(account);
  return { loud, quiet };
}

/** 并发推给每台设备，死 token 按各自的账号归堆，交给 recordPushOutcome 分别清理 */
async function fanOut(
  env: Env,
  targets: Target[],
  payload: Record<string, unknown>,
  headers: ApnsHeaders,
): Promise<{ results: PushResult[]; delivered: number; deadByAccount: Map<string, string[]> }> {
  const results = await Promise.all(
    targets.map((t) => pushToDevice(env, t.device, payload, headers)),
  );
  const deadByAccount = new Map<string, string[]>();
  results.forEach((result, i) => {
    const target = targets[i];
    if (!target || !isDeadToken(result)) return;
    const list = deadByAccount.get(target.accountId) ?? [];
    list.push(result.deviceToken);
    deadByAccount.set(target.accountId, list);
  });
  return { results, delivered: results.filter((r) => r.status === 200).length, deadByAccount };
}

/**
 * 推给通道的所有接收者：创建者和每个成员名下的每一台设备。
 *
 * 通道决定「这条消息长什么样」（默认铃声、级别、策略），
 * 接收者名单决定「推给谁」。群组就是在后者上多几个人。
 */
export interface DeliveryReport {
  /** 因接收者开了免打扰而静默送达（不响、不亮屏）的设备数 */
  muted?: number;
  results: PushResult[];
  delivered: number;
  /** 被通道的去重窗口压掉了 */
  suppressed?: boolean;
  /** 被免打扰时段降级成 passive 了 */
  quieted?: boolean;
  /** 这条消息的 id。认领要靠它在各人手机上对上号 */
  messageId?: string;
}

export async function deliver(
  env: Env,
  channel: Channel,
  recipients: Account[],
  incoming: PushParams,
): Promise<DeliveryReport> {
  const targets = targetsOf(recipients);
  if (targets.length === 0) return { results: [], delivered: 0 };

  const outcome = await applyPolicy(env, channel, incoming);
  // 去重压掉的也要记一笔统计 —— 否则用户看到"这个通道很安静"，
  // 实际上它正在疯狂重复，只是被挡住了。
  if (outcome.suppressed) {
    await recordPushOutcome(env, channel.id, new Map(), true);
    return { results: [], delivered: 0, suppressed: true };
  }

  // 每条消息都要有 id：同一条通知落在群里不同人的手机上，靠它对上号；
  // 它同时是 apns-collapse-id，之后的「正在处理」才能原地替换掉原通知。
  const params: PushParams = { ...outcome.params, id: outcome.params.id || newId() };
  const category = categoryFor(env, channel);
  const origin = originOf(channel);
  const headers = pushHeaders(params);

  // 设了免打扰的人拿静默版本，其他人拿原样。两拨并发推，结果合并
  const { loud, quiet } = partitionByMute(recipients, channel.id, params.level);
  const batches = [
    { quiet: false, targets: targetsOf(loud), payload: buildPayload(params, category, origin) },
    { quiet: true, targets: targetsOf(quiet), payload: buildPayload(applyQuietHours(params), category, origin) },
  ].filter((batch) => batch.targets.length > 0);
  const outcomes = await Promise.all(
    batches.map((batch) => fanOut(env, batch.targets, batch.payload, headers)),
  );

  const results = outcomes.flatMap((o) => o.results);
  const delivered = outcomes.reduce((sum, o) => sum + o.delivered, 0);
  // 因接收者开了免打扰而静默送达的设备数。发送方问「为什么没响」时，这是第一个该看的数
  const muted = outcomes.reduce((sum, o, i) => sum + (batches[i]?.quiet ? o.delivered : 0), 0);
  const deadByAccount = new Map<string, string[]>();
  for (const o of outcomes) {
    for (const [accountId, tokens] of o.deadByAccount) {
      deadByAccount.set(accountId, [...(deadByAccount.get(accountId) ?? []), ...tokens]);
    }
  }
  await recordPushOutcome(env, channel.id, deadByAccount, delivered > 0);

  return { results, delivered, muted, quieted: outcome.quieted, messageId: params.id };
}

/**
 * 有人认领之后，告诉群里每个人。
 *
 * 用原消息的 id 作 collapse-id：通知中心里那条带「我来处理」按钮的原通知会被
 * 原地替换成「张三 正在处理」—— 按钮随之消失，别人不会再重复接手。
 * 级别是 passive：认领是状态更新，不是新告警，不该再吵一遍。
 */
export async function announceAck(
  env: Env,
  channel: Channel,
  recipients: Account[],
  messageId: string,
  who: string,
  title: string,
): Promise<{ delivered: number; devices: number }> {
  const params: PushParams = {
    title: `${who} 正在处理`,
    body: title || "一条消息",
    level: "passive",
    id: messageId,
  };
  const payload = buildPayload(
    params,
    env.APNS_CATEGORY || "pigeonNotification",
    originOf(channel),
  );
  // NSE 看到这个字段，就去历史里把原消息标成「已认领」，而不是另存一条
  payload.ack_by = who;

  const { results, delivered, deadByAccount } = await fanOut(
    env, targetsOf(recipients), payload, pushHeaders(params),
  );
  // 认领不计入通道的推送统计，但顺手清理死 token
  await recordPushOutcome(env, channel.id, deadByAccount, false);
  return { delivered, devices: results.length };
}
