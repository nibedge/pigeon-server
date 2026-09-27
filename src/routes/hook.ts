import { getAdapter } from "../adapters";
import { explainFailures } from "../apns";
import { BodyTooLarge, bodyTooLarge, declaredTooLarge, MAX_HOOK_BODY_BYTES, readBody } from "../body";
import { contentRejection } from "../contentfilter";
import { clearAck } from "../db";
import { suspensionRejection } from "../policy";
import {
  allowKeyMiss,
  allowPush,
  cancelRepeat,
  deliver,
  KEY_MISS_MESSAGE,
  reportFields,
  throttledMessage,
  withDefaults,
} from "../push";
import { rateLimited } from "../ratelimit";
import { fail, ok } from "../respond";
import { limitToToken, resolveSender, retiredMessage, senderRefusal } from "../tokens";
import type { Env, PushParams } from "../types";
import { deliverAlertGroup } from "./alertmanager";

/**
 * 表单里装着 JSON 的字段。GitHub 选 form 编码时放在 payload 里；
 * Uptime Kuma 选 form-data 时放在 data 里（multipart）
 */
const EMBEDDED_JSON_FIELDS = ["payload", "data"];

/** 表单（urlencoded 或 multipart）→ payload：有装 JSON 的字段就解它，没有就把各个文字字段原样交给适配器 */
function fromForm(entries: [string, unknown][]): unknown {
  for (const name of EMBEDDED_JSON_FIELDS) {
    const raw = entries.find(([key]) => key === name)?.[1];
    if (typeof raw === "string") return JSON.parse(raw);
  }
  return Object.fromEntries(entries.filter(([, value]) => typeof value === "string"));
}

/** 按内容类型解析请求体。解析不了抛异常，由入口回 400 */
async function parsePayload(raw: Uint8Array, contentType: string): Promise<unknown> {
  const type = contentType.toLowerCase();
  if (type.includes("multipart/form-data")) {
    // 原先 multipart 一律当 JSON 解析，Uptime Kuma 的 form-data 预设只能拿到 400
    const form = await new Response(raw, { headers: { "content-type": contentType } }).formData();
    return fromForm([...form.entries()] as [string, unknown][]);
  }
  const text = new TextDecoder().decode(raw);
  if (type.includes("form-urlencoded")) return fromForm([...new URLSearchParams(text).entries()]);
  return JSON.parse(text);
}

/** 适配器没给的字段不带 undefined 进去 —— 否则会把通道默认值里的同名字段盖成「没有」 */
function defined(params: PushParams): PushParams {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined)) as PushParams;
}

/**
 * POST /hook/{key}/{adapter}
 *
 * 用独立的 /hook 前缀而不是 /{key}/{adapter}，是为了避免和路径式推送的
 * /{key}/{body} 撞车 —— `/abc/github` 到底是「推一条内容为 github 的消息」
 * 还是「走 github 适配器」，靠猜是不行的。告警系统里静默走错路由是最坏的
 * 失败方式，所以这里选择显式。
 */
export async function handleHook(
  request: Request,
  env: Env,
  key: string,
  adapterName: string,
): Promise<Response> {
  if (request.method !== "POST") return fail(405, "webhook 入口只接受 POST");

  const adapter = getAdapter(adapterName);
  if (!adapter) return fail(404, `没有名为 ${adapterName} 的适配器`);
  if (declaredTooLarge(request, MAX_HOOK_BODY_BYTES)) return bodyTooLarge(MAX_HOOK_BODY_BYTES);

  // key 或发送令牌都行（见 tokens.ts）
  const resolved = await resolveSender(env, key);
  if (!resolved) {
    if (!(await allowKeyMiss(env, request))) return rateLimited(KEY_MISS_MESSAGE);
    const gone = await retiredMessage(env, key, request, `/hook 的 ${adapter.name} 适配器`);
    if (gone) return fail(410, gone);
    return fail(404, "这个 key 不存在");
  }
  const { channel, recipients } = resolved;
  const suspended = suspensionRejection(channel);
  if (suspended) return fail(403, suspended);
  const refused = await senderRefusal(env, resolved);
  if (refused) return refused.status === 429 ? rateLimited(refused.message) : fail(refused.status, refused.message);
  // 和路径式推送共用同一份额度：一个通道每分钟最多推这么多，不管从哪个入口进来
  if (!(await allowPush(env, channel, recipients))) return rateLimited(throttledMessage(channel));
  // 第三方服务不会替你加密，发到这里的必然是明文
  if (channel.policy?.e2eOnly) {
    return fail(400, `这个通道只接受端到端加密的消息，而第三方 webhook 无法加密。请换一个通道，或者在自己的机器上用 ${new URL(request.url).origin}/tools/pigeon-send.mjs 加密后再推`);
  }

  let body: unknown;
  try {
    // 按上限读原文再解析：request.json() / formData() 不看大小
    body = await parsePayload(await readBody(request, MAX_HOOK_BODY_BYTES), request.headers.get("content-type") ?? "");
  } catch (err) {
    if (err instanceof BodyTooLarge) return bodyTooLarge(err.limit);
    return fail(400, "请求体不是合法的 JSON（用表单发的话，JSON 要放在 payload 或 data 字段里）");
  }

  // Alertmanager 一次带一组告警：逐条推、逐条恢复（见 routes/alertmanager.ts）
  if (adapter.name === "alertmanager") return deliverAlertGroup(env, channel, recipients, body, resolved.token);

  let rendered;
  try {
    rendered = await adapter.render(body, request.headers);
  } catch (err) {
    return fail(
      500,
      `${adapter.label} 适配器渲染失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 适配器判定这个事件不值得推（GitHub 的 ping、成功的构建……），
  // 仍然回 200，否则对方会当成投递失败一直重试。
  if (!rendered) return ok({ skipped: true, adapter: adapter.name });

  // 通道默认值垫底，适配器的判断优先 —— 适配器比通道更清楚这条事件的轻重。用发送令牌推的，再按令牌的上限收一收
  const limited = limitToToken(withDefaults(channel, defined(rendered)), resolved.token);
  const params = limited.params;
  // 适配器渲染出来的文字照样是推进群里的内容，和路径式推送过同一份违禁词表
  const blocked = await contentRejection(env, channel, params);
  if (blocked) return fail(400, blocked);
  // 适配器换过 id 的算法：上线前以旧 id 开始的事件，恢复时连旧 id 的重复提醒和认领一起了结（见 Adapter.legacyIds）
  if (params.status === "resolved" && adapter.legacyIds) {
    for (const id of adapter.legacyIds(body)) {
      if (id === params.id) continue;
      await cancelRepeat(env, channel.id, id);
      await clearAck(env, channel.id, id);
    }
  }
  const report = await deliver(env, channel, recipients, params, { from: resolved.token?.name });
  report.warnings = [...limited.warnings, ...(report.warnings ?? [])];
  const { results, delivered } = report;

  if (report.rejection) {
    const { status, message, bytes, limit } = report.rejection;
    return fail(status, message, { bytes, limit });
  }
  if (report.suppressed) return ok({ adapter: adapter.name, suppressed: "duplicate", ...reportFields(report) });
  if (results.length === 0) return fail(410, "这个通道下没有可用设备，请在 App 里重新注册");
  if (delivered === 0) {
    // 按责任归类：设备失效 410，服务端或 Apple 的问题 502 —— 对方的重试策略据此分得清
    const failure = explainFailures(results);
    return fail(failure.status, failure.message, {
      devices: results.length,
      reason: failure.reason,
      ...reportFields(report),
    });
  }
  return ok({
    ...reportFields(report),
    adapter: adapter.name,
    delivered,
    devices: results.length,
    ...(report.quieted ? { quieted: true } : {}),
    // 因接收者开了免打扰而静默送达的设备数 —— 发送方排查「为什么没响」看这个
    ...(report.muted ? { muted: report.muted } : {}),
    // 通道默认值里设了 repeat 的话，适配器推来的告警也会重复提醒；恢复事件会把它停下
    ...(report.repeat ? { repeat: report.repeat } : {}),
  });
}
