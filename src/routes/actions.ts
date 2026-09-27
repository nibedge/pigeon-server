import {
  authenticate,
  getAck,
  getChannel,
  isValidId,
  recipientsOf,
  roleOf,
} from "../db";
import {
  type Action,
  actionSigValid,
  canVerifyActions,
  isServerAction,
  MAX_ACTIONS,
  parseActions,
} from "../actions";
import {
  appendReceiptAction,
  ensureCallbackSecret,
  fireCallback,
  getReceipt,
  performHttpAction,
  regenerateCallbackSecret,
  type CallbackEvent,
  type ReceiptAction,
} from "../receipts";
import { allowKeyMiss, buildPayload, pushHeaders } from "../push";
import { pushToDevice } from "../apns";
import { suspensionRejection } from "../policy";
import { allow, rateLimited } from "../ratelimit";
import { displayName } from "../db";
import { fail, ok, tooMany } from "../respond";
import { resolveSender, retiredMessage, TOKEN_DISABLED_MESSAGE } from "../tokens";
import type { Account, Channel, Env, PushParams } from "../types";

/**
 * 通知按钮的服务端一半：有人点了要经服务端的按钮（http / reply），App 把消息 id、按钮序号、
 * 按钮定义原文和 act_sig 交回来。服务端核对签名（确认这组按钮真是从这个通道推出去、没被改过），
 * 再替他去请求按钮的地址（带通道回调密钥的签名），把结果记进回执、发回调、在群里原地广播。
 *
 * 以及：通道回调密钥的读取与重置、发送方长轮询回执。
 */

/** 回复的文字上限。够写一句处理说明，又不至于成了往外发大段文字的口子 */
const MAX_REPLY = 1000;

/** Bearer secret + 账号校验，和 routes/account.ts 里同一套（那份没导出，这里就地放一份小的） */
async function requireAuth(request: Request, env: Env, accountId: string): Promise<Account | Response> {
  const header = request.headers.get("authorization") ?? "";
  const secret = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!secret) return fail(401, "缺少 Authorization: Bearer <secret>");
  if (!isValidId(accountId)) return fail(400, "account id 格式不对");
  const account = await authenticate(env, accountId, secret);
  if (!account) return fail(401, "账号不存在或凭据不正确");
  return account;
}

/** 载入通道并核对身份。needOwner 时只有创建者能过 */
async function requireChannel(
  env: Env,
  account: Account,
  channelId: string,
  needOwner: boolean,
): Promise<Channel | Response> {
  if (!isValidId(channelId)) return fail(400, "通道 id 格式不对");
  const channel = await getChannel(env, channelId);
  const role = channel ? roleOf(channel, account.id) : null;
  if (!channel || !role) return fail(404, "没有这个通道");
  if (needOwner && role !== "owner") return fail(403, "只有通道的创建者能做这个操作");
  return channel;
}

async function readJSON(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function validMessageId(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw || raw.length > 64) return null;
  if (/[\u0000-\u001f]/.test(raw)) return null;
  return raw;
}

/**
 * POST /account/{id}/channels/{cid}/actions
 * body: { message_id, index, actions, act_sig, reply_text? }
 *
 * 只有 http、reply 两类按钮要交给服务端 —— open、copy 在手机上就地完成了。
 */
export async function handleChannelActions(
  request: Request,
  env: Env,
  accountId: string,
  channelId: string,
): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  // 按账号限流：代发请求会向外部地址发请求，挡住拿脚本反复点的
  if (!(await allow(env.RL_ACCOUNT, `action:${auth.id}`))) {
    return tooMany("点得太频繁了，请过一分钟再试");
  }
  const channel = await requireChannel(env, auth, channelId, false);
  if (channel instanceof Response) return channel;
  const suspended = suspensionRejection(channel);
  if (suspended) return fail(403, suspended);

  // 没有签名密钥（自建实例没配 APNs 私钥）就核对不了按钮，一律不代发 —— 核对不了的按钮谁都能编
  if (!canVerifyActions(env)) {
    return fail(503, "这个实例没有配置签名密钥，通知按钮暂不可用");
  }

  const body = await readJSON(request);
  const messageId = validMessageId(body.message_id);
  if (!messageId) return fail(400, "message_id 格式不对");
  const index = Number(body.index);
  if (!Number.isInteger(index) || index < 0 || index >= MAX_ACTIONS) return fail(400, "index 不对");
  const actionsRaw = body.actions;
  if (typeof actionsRaw !== "string" || !actionsRaw) return fail(400, "缺少 actions（推送里带的按钮定义原文）");
  const sig = body.act_sig;
  if (typeof sig !== "string" || !sig) return fail(400, "缺少 act_sig");

  // 核对按钮凭据：这组按钮必须真是从这个通道、这条消息推出去的，一个字都没改过
  if (!(await actionSigValid(env, channel.id, messageId, actionsRaw, sig))) {
    return fail(403, "按钮凭据不对：请在最新的通知上操作");
  }

  const parsed = parseActions(actionsRaw);
  if ("error" in parsed) return fail(400, "按钮定义解析不了");
  const action = parsed.actions[index];
  if (!action) return fail(400, "没有这个按钮");
  if (!isServerAction(action)) return fail(400, "这个按钮在手机上就能完成，不用交给服务端");

  const by = displayName(auth);
  const at = Date.now();
  let reply: string | undefined;
  if (action.type === "reply") {
    const text = typeof body.reply_text === "string" ? body.reply_text : "";
    reply = Array.from(text).slice(0, MAX_REPLY).join("");
  }

  // 要向外部地址发请求（http 的按钮，或带了 url 的 reply）：用通道回调密钥签名后代发
  let status: number | undefined;
  let httpOk = true;
  let httpError: string | undefined;
  if (action.url) {
    const secret = await ensureCallbackSecret(env, channel.id);
    const method = action.type === "reply" ? "POST" : action.method ?? "POST";
    const outBody = outgoingBody(action, { channelId: channel.id, messageId, index, by, at, reply });
    const event = action.type === "reply" ? "reply" : "action";
    const result = await performHttpAction(method, action.url, action.headers, outBody, secret, at, event);
    status = result.status;
    httpOk = result.ok;
    httpError = result.error;
  }

  // 记进回执，发送方查得到；再看这条消息有没有 callback，有就发一条签名事件
  const receiptAction: ReceiptAction = {
    by,
    at,
    label: action.label,
    type: action.type,
    ...(status !== undefined ? { status } : {}),
    ...(action.url ? { ok: httpOk } : {}),
    ...(reply ? { reply } : {}),
  };
  const receipt = await appendReceiptAction(env, channel.id, messageId, receiptAction).catch(() => null);
  const followUps: Promise<unknown>[] = [];
  if (receipt?.callback) {
    const event: CallbackEvent = {
      event: action.type === "reply" ? "reply" : "action",
      channel_id: channel.id,
      id: messageId,
      by,
      at,
      action: action.label,
      ...(reply ? { reply } : {}),
    };
    followUps.push(fireCallback(env, channel.id, receipt.callback, event));
  }
  // 群里原地广播「谁点了哪个按钮 · 结果」：passive、沿用原消息 id 折叠，别人不会再重复点
  if (channel.memberIds.length > 0) {
    followUps.push(announceAction(env, channel, messageId, by, action, status, httpOk).catch(() => undefined));
  }
  // 回调和广播互不相干，一起发：点按钮的人在锁屏上等着结果，接收方慢一点不该让他多等一轮
  await Promise.all(followUps);

  return ok({
    status,
    ok: action.url ? httpOk : true,
    ...(httpError ? { error: httpError } : {}),
  });
}

/**
 * 代发请求的默认请求体：按钮没自带 body 时，POST / PUT / PATCH 发这份说明谁点了什么的 JSON。
 * 和回调事件同一个形状（外加按钮序号 index）：接收方一个解析函数两处都能用
 */
function outgoingBody(
  action: Action,
  ctx: { channelId: string; messageId: string; index: number; by: string; at: number; reply?: string },
): string | undefined {
  if (action.body !== undefined) return action.body;
  const method = action.type === "reply" ? "POST" : action.method ?? "POST";
  if (method === "GET" || method === "DELETE") return undefined;
  return JSON.stringify({
    event: action.type === "reply" ? "reply" : "action",
    channel_id: ctx.channelId,
    id: ctx.messageId,
    by: ctx.by,
    at: ctx.at,
    action: action.label,
    index: ctx.index,
    ...(ctx.reply ? { reply: ctx.reply } : {}),
  });
}

/**
 * 有人点了按钮，告诉群里每个人。沿用原消息的 id 作 collapse-id，通知中心里那条原地更新，
 * passive、不再吵；正文固定「一条消息」，各设备的通知扩展按 action_by 把这件事折进原消息的时间线。
 * 思路同 push.ts 的 announceAck，这里只推给成员、不进推送统计。
 */
async function announceAction(
  env: Env,
  channel: Channel,
  messageId: string,
  by: string,
  action: Action,
  status: number | undefined,
  ok: boolean,
): Promise<void> {
  // 措辞和 App 里「谁点过」那一行一致（MessageActionRecord.line）：有状态码写状态码，发不出去写「没送到」
  const tail = status !== undefined ? String(status) : action.url && !ok ? "没送到" : "已记录";
  const line = `${by} 点了「${action.label}」· ${tail}`;
  const params: PushParams = { title: line, body: "一条消息", level: "passive", id: messageId };
  const payload = buildPayload(params, env.APNS_CATEGORY || "pigeonNotification", { id: channel.id, name: channel.name });
  // NSE 看到这个字段，就去历史里把这件事折进原消息，而不是另存一条（和 ack_by 同一套，见 NotificationService）
  payload.action_by = by;
  // 不认 action_by 的旧版 App（构建 79、15 及更早）只特殊处理 ack_by，别的一律按 id 存进历史 ——
  // 同 id 的原消息会被这条「李四 点了「回滚」· 200」替换掉，标题正文和状态都丢了、还重新算一条未读。
  // 它们都认 isarchive=0（不进历史）；新版 App 在归档之前就按 action_by 分走了，不受影响
  payload.isarchive = "0";
  payload.action_label = action.label;
  if (status !== undefined) payload.action_status = String(status);
  // 没成的另标一下：超时、跨主机跳转这类没有状态码，App 的「谁点过」里才写得出「没送到」
  if (action.url && !ok) payload.action_ok = "0";
  payload.sent_at = Date.now();
  const headers = pushHeaders(params);
  const recipients = await recipientsOf(env, channel);
  await Promise.all(
    recipients.flatMap((account) => account.devices.map((device) => pushToDevice(env, device, payload, headers))),
  );
}

// ── 通道回调密钥 ────────────────────────────────────────────────────

/** GET /account/{id}/channels/{cid}/callback-secret —— 仅创建者。没有就生成一把，之后保持不变 */
export async function handleGetCallbackSecret(
  request: Request,
  env: Env,
  accountId: string,
  channelId: string,
): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  const channel = await requireChannel(env, auth, channelId, true);
  if (channel instanceof Response) return channel;
  const secret = await ensureCallbackSecret(env, channel.id);
  return ok({ callback_secret: secret });
}

/** POST /account/{id}/channels/{cid}/callback-secret —— 仅创建者。重置：旧的立即失效 */
export async function handleRegenCallbackSecret(
  request: Request,
  env: Env,
  accountId: string,
  channelId: string,
): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  const channel = await requireChannel(env, auth, channelId, true);
  if (channel instanceof Response) return channel;
  const secret = await regenerateCallbackSecret(env, channel.id);
  return ok({ callback_secret: secret });
}

// ── 回执长轮询 ──────────────────────────────────────────────────────

/** 长轮询上限：等太久白占一个 Worker 请求，60 秒够告警场景「等人处理」了 */
const MAX_WAIT_SECONDS = 60;
/** 每隔多久读一次 KV —— 更密也没用，KV 的新写入本来就要约 60 秒才在各机房一致 */
const POLL_INTERVAL_MS = 2000;

/**
 * GET /{key}/receipt/{id}?wait=0..60&since=毫秒 —— 发送方用推送带的 key 查回执：谁认领了、几点、点过哪些按钮。
 *
 * wait 大于 0 时长轮询：每 2 秒读一次，读到有人认领或有动作就立刻返回，到点还没有就返回当前状态（可能为空）。
 * since：只等比这个时刻新的事。脚本拿到一次结果后带上其中最晚的 at 再等，等的就是「下一件事」——
 * 不带的话，只要有过一次动作，之后每次长轮询都立刻返回，脚本就成了空转。
 * 用推送 key 鉴权 —— 能往这个通道推的人（发送方）才查得到回执，成员管不着。
 */
export async function handleReceipt(
  request: Request,
  env: Env,
  key: string,
  messageId: string,
  url: URL,
): Promise<Response> {
  const id = validMessageId(messageId);
  if (!id) return fail(400, "消息 id 格式不对");
  // 推送的 key 或发送令牌都行（见 tokens.ts）：拿令牌推的脚本，用同一个令牌等回执
  const resolved = await resolveSender(env, key);
  if (!resolved) {
    // 和推送共用「查不存在的 key」的按 IP 限流：回执接口不该成了另一个挨个试 key 的口子
    if (!(await allowKeyMiss(env, request))) return rateLimited("查询不存在的 key 太频繁了，请过一分钟再试");
    const gone = await retiredMessage(env, key, request, "回执查询");
    if (gone) return fail(410, gone);
    return fail(404, "这个 key 不存在");
  }
  if (resolved.token?.disabled) return fail(403, TOKEN_DISABLED_MESSAGE);
  const channelId = resolved.channel.id;
  // 每个通道每分钟最多查 60 次：长轮询一次最多占一分钟，正常的脚本远用不到；挡的是失控的循环
  if (!(await allow(env.RL_PUSH, `receipt:${channelId}`))) {
    return rateLimited("查回执太频繁了：请用 wait 长轮询，别连续发请求");
  }

  const waitRaw = Number(url.searchParams.get("wait"));
  const wait = Number.isFinite(waitRaw) ? Math.min(MAX_WAIT_SECONDS, Math.max(0, Math.floor(waitRaw))) : 0;
  const sinceRaw = Number(url.searchParams.get("since"));
  const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0;
  const deadline = Date.now() + wait * 1000;

  for (;;) {
    const view = await receiptView(env, channelId, id);
    // 有人认领了、或有人点过按钮（带了 since 的，要比它新）：不必再等
    const fresh =
      (view.acked_by !== null && (view.acked_at ?? Infinity) > since) || view.actions.some((a) => a.at > since);
    if (fresh || Date.now() >= deadline) {
      return ok(view);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function receiptView(
  env: Env,
  channelId: string,
  messageId: string,
): Promise<{ acked_by: string | null; acked_at: number | null; actions: ReceiptAction[] }> {
  const [ack, receipt] = await Promise.all([
    getAck(env, channelId, messageId),
    getReceipt(env, channelId, messageId),
  ]);
  return {
    acked_by: ack?.name ?? null,
    acked_at: ack?.at ?? null,
    actions: receipt?.actions ?? [],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
