import { explainFailures } from "./apns";
import { BodyTooLarge, bodyTooLarge, declaredTooLarge, readBodyText } from "./body";
import { getChannel, getInvite, resolveChannel, setSuspended } from "./db";
import { SENDER_SCRIPT } from "./generated/sender";
import { invitePage } from "./invite";
import { landingPage } from "./landing";
import { plaintextRejection, suspensionRejection } from "./policy";
import { isPreviewRequest } from "./preview";
import { privacyPage } from "./privacy";
import {
  allowKeyMiss,
  allowPush,
  BATCH_BUDGET,
  batchCost,
  collectRequest,
  deliver,
  hasContent,
  ignoredParams,
  KEY_MISS_MESSAGE,
  MAX_BATCH_KEYS,
  OVER_BUDGET_MESSAGE,
  paramsFromJson,
  reportFields,
  runReminders,
  throttledMessage,
  withDefaults,
} from "./push";
import { rateLimited } from "./ratelimit";
import { fail, html, ok } from "./respond";
import { sendPage } from "./send";
import { termsPage } from "./terms";
import {
  handleAddChannel,
  handleAck,
  handleAddDevice,
  handleBlock,
  handleCreateAccount,
  handleCreateInvite,
  handleDeleteAccount,
  handleGetAccount,
  handleJoinInvite,
  handleListMembers,
  handlePreviewInvite,
  handleRemoveChannel,
  handleRemoveDevice,
  handleRemoveMember,
  handleRemoveWrappedKey,
  handleReport,
  handleResetEncryption,
  handleRotateKey,
  handleSetWrappedKey,
  handleUnblock,
  handleCreateWatch,
  handleDeleteWatch,
  handleListWatches,
  handleUpdateAccount,
  handleUpdateChannel,
} from "./routes/account";
import { handleHeartbeat } from "./routes/heartbeat";
import { handleHook } from "./routes/hook";
import { handleHealthz, handleInfo, handlePing } from "./routes/misc";
import { appSiteAssociation } from "./appstore";
import { iconResponse } from "./icon";
import { runScheduled } from "./watch";
import type { Account, Channel, Env } from "./types";

/** 这些第一段路径是接口，不能当成通道 key */
const RESERVED = new Set([
  "account", "push", "ping", "healthz", "info", "hook", "i", "tools", "hb", "send",
  "favicon.ico", "favicon.png", "apple-touch-icon.png",
  "robots.txt", "privacy", "terms", "docs", "static", "__test__", ".well-known",
]);

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-max-age": "86400",
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

/** Authorization: Bearer {key} 里的推送 key。脚本不想把 key 写进地址（会进各种日志）时用 */
function bearerKey(request: Request): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "");
  return match?.[1] ?? null;
}

/**
 * 链接预览、预取、HEAD：不推送，回 200 说明原因（回 4xx 的话，有的预览器会反复重试）。
 * 信封照旧，另带 ok、skipped 两个顶层字段，一眼看得出这次什么也没发生
 */
function previewSkipped(): Response {
  return new Response(
    JSON.stringify({
      code: 200,
      message: "没有推送：这像是链接预览或预取，不是真要推送",
      ok: true,
      skipped: "preview",
      data: { skipped: "preview" },
      timestamp: Math.floor(Date.now() / 1000),
    }),
    { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } },
  );
}

/** 路径末尾的 .send 去掉：`/{key}.send` 这种写法（从别处迁来的地址常见）照样认。key 里不会有「.」 */
function stripSendSuffix(segments: string[]): string[] {
  const last = segments.at(-1);
  if (last === undefined || !last.endsWith(".send")) return segments;
  const trimmed = last.slice(0, -".send".length);
  return trimmed ? [...segments.slice(0, -1), trimmed] : segments.slice(0, -1);
}

function missingKey(url: URL): Response {
  return fail(400, `地址少了 key，应为 https://${url.host}/{key}`);
}

interface BatchOutcome {
  key: string;
  id?: string;
  delivered: number;
  suppressed?: "duplicate";
  quieted?: true;
  muted?: number;
  repeat?: { every: number; until: number; id: string };
  truncated?: true;
  warnings?: string[];
  error?: string;
}

/** 批量里一个 key 没推成的原因分类：整批都是同一类时，状态码跟着它走 */
type BatchFailure = "tooLarge" | "limited" | "other";

type Resolved = { channel: Channel; recipients: Account[] };

/** 查整批 key 时一次并发几个：太多了超预算时白读的多，太少了一批 20 个要排很久 */
const RESOLVE_CONCURRENCY = 5;

/**
 * 先把整批 key 查一遍、估一遍开销，一条都不推。几个一组并发地查，查到超预算就停手 ——
 * 拿一堆大群的 key 来的请求，在这一步花掉的读取也有上限
 */
async function resolveBatch(
  env: Env,
  keys: string[],
): Promise<{ entries: { key: string; found: Resolved | null }[]; overBudget: boolean }> {
  const entries: { key: string; found: Resolved | null }[] = [];
  let cost = 0;
  for (let i = 0; i < keys.length; i += RESOLVE_CONCURRENCY) {
    const chunk = keys.slice(i, i + RESOLVE_CONCURRENCY);
    const found = await Promise.all(chunk.map((key) => resolveChannel(env, key)));
    chunk.forEach((key, j) => {
      const hit = found[j] ?? null;
      cost += hit ? batchCost(hit.channel) : 1;
      entries.push({ key, found: hit });
    });
    if (cost > BATCH_BUDGET) return { entries, overBudget: true };
  }
  return { entries, overBudget: false };
}

/**
 * POST /push —— JSON 请求体里带 device_key 或 device_keys 的批量接口。App 的「推一条试试」、快捷指令也走这里。
 *
 * 参数和路径式推送同一套解析（别名、开关、markdown），每个 key 各自合上自己通道的默认值、各自检查。
 * 被去重压掉的算收下了，不算失败 —— 和路径式一样：回 4xx 的话发送方会一直重试，越重试越重复。
 */
async function handleJsonPush(request: Request, env: Env): Promise<Response> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(await readBodyText(request)) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof BodyTooLarge) return bodyTooLarge();
    return fail(400, "请求体不是合法的 JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return fail(400, "请求体不是合法的 JSON");

  const single = typeof payload.device_key === "string" ? [payload.device_key] : [];
  const many = Array.isArray(payload.device_keys)
    ? payload.device_keys.filter((k): k is string => typeof k === "string")
    : [];
  const keys = [...new Set([...single, ...many])];
  const bearer = bearerKey(request);
  if (keys.length === 0 && bearer) keys.push(bearer);

  if (keys.length === 0) return fail(400, "缺少 device_key 或 device_keys");
  if (keys.length > MAX_BATCH_KEYS) return fail(400, `一次最多推 ${MAX_BATCH_KEYS} 个 key，请分批发送`);

  const own = paramsFromJson(payload);
  const { entries, overBudget } = await resolveBatch(env, keys);
  if (overBudget) return fail(400, OVER_BUDGET_MESSAGE);

  const failures = new Map<string, BatchFailure>();
  const failed = (key: string, error: string, kind: BatchFailure = "other"): BatchOutcome => {
    failures.set(key, kind);
    return { key, delivered: 0, error };
  };

  const outcomes = await Promise.all(
    entries.map(async ({ key, found }): Promise<BatchOutcome> => {
      if (!found) {
        if (!(await allowKeyMiss(env, request))) return failed(key, KEY_MISS_MESSAGE, "limited");
        return failed(key, "key 不存在");
      }
      const { channel, recipients } = found;
      const suspended = suspensionRejection(channel);
      if (suspended) return failed(key, suspended);
      if (!(await allowPush(env, channel, recipients))) return failed(key, throttledMessage(channel), "limited");

      const merged = withDefaults(channel, own);
      if (!hasContent(merged)) return failed(key, "没有内容可推 —— 给个 body（或 title）");
      const rejection = plaintextRejection(channel, merged, own);
      if (rejection) return failed(key, rejection);

      const report = await deliver(env, channel, recipients, merged);
      if (report.rejection) return failed(key, report.rejection.message, "tooLarge");
      const common = {
        key,
        ...(report.messageId ? { id: report.messageId } : {}),
        ...(report.truncated ? { truncated: true as const } : {}),
        ...(report.warnings?.length ? { warnings: report.warnings } : {}),
      };
      if (report.suppressed) return { ...common, delivered: 0, suppressed: "duplicate" };
      const { delivered, results } = report;
      if (delivered === 0) {
        failures.set(key, "other");
        return { ...common, delivered, error: results.length ? explainFailures(results).message : "没有可用设备" };
      }
      return {
        ...common,
        delivered,
        ...(report.quieted ? { quieted: true as const } : {}),
        ...(report.muted ? { muted: report.muted } : {}),
        ...(report.repeat ? { repeat: report.repeat } : {}),
      };
    }),
  );

  const delivered = outcomes.reduce((sum, o) => sum + o.delivered, 0);
  if (failures.size === outcomes.length) {
    const kinds = new Set(failures.values());
    const first = outcomes[0]?.error ?? "推送失败";
    // 整批都是同一类原因时，状态码跟着它走：内容太长 413（该缩短内容，不是换 key 重试）、限流 429（该等一会儿）
    if (kinds.size === 1 && kinds.has("tooLarge")) return fail(413, first, outcomes);
    if (kinds.size === 1 && kinds.has("limited")) return rateLimited(first);
    return fail(400, `全部推送失败：${first}`, outcomes);
  }
  const allSuppressed = outcomes.every((o) => o.suppressed);
  return ok({
    delivered,
    results: outcomes,
    ignored: ignoredParams(own),
    ...(allSuppressed ? { suppressed: "duplicate" } : {}),
  });
}

/**
 * 路径式推送： /{key} · /{key}/{body} · /{key}/{title}/{body} · /{key}/{title}/{subtitle}/{body}，
 * 或者根路径 / 加 Authorization: Bearer {key}。
 */
async function handlePathPush(
  request: Request,
  env: Env,
  url: URL,
  key: string,
  pathText: string[],
): Promise<Response> {
  if (isPreviewRequest(request)) return previewSkipped();
  // 声明的长度已经超了：连 KV 都不必查
  if (declaredTooLarge(request)) return bodyTooLarge();
  const resolved = await resolveChannel(env, key);
  if (!resolved) {
    if (!(await allowKeyMiss(env, request))) return rateLimited(KEY_MISS_MESSAGE);
    return fail(404, "这个 key 不存在。先在 App 里注册，或检查有没有拼错");
  }
  const { channel, recipients } = resolved;
  const suspended = suspensionRejection(channel);
  if (suspended) return fail(403, suspended);
  // 限流放在读请求体之前：失控的脚本连请求体都不必读
  if (!(await allowPush(env, channel, recipients))) return rateLimited(throttledMessage(channel));

  let collected;
  try {
    collected = await collectRequest(request, url, pathText, channel);
  } catch (err) {
    if (err instanceof BodyTooLarge) return bodyTooLarge();
    throw err;
  }
  const { params, own, warnings } = collected;
  if (!hasContent(params)) {
    // 请求体不为空却没认出正文：把原因说出来，比一句「没有内容」好查得多
    return fail(400, warnings.length ? `没有内容可推：${warnings.join("；")}` : "没有内容可推 —— 在路径或参数里给个 body");
  }
  const rejection = plaintextRejection(channel, params, own);
  if (rejection) return fail(400, rejection);

  const report = await deliver(env, channel, recipients, params);
  const { results, delivered } = report;
  // 解析请求时的提示排在前面：它们说的是「你发来的东西」，截断之类说的是「推出去的样子」
  report.warnings = [...warnings, ...(report.warnings ?? [])];
  const ignored = ignoredParams(own);

  if (report.rejection) {
    const { status, message, bytes, limit } = report.rejection;
    return fail(status, message, { bytes, limit });
  }
  // 被去重压掉也算收下了 —— 回 4xx 的话发送方会一直重试，越重试越重复
  if (report.suppressed) {
    return ok({ suppressed: "duplicate", channel: channel.name, ...reportFields(report, ignored) });
  }
  if (results.length === 0) {
    return fail(410, "这个通道下没有可用设备，请在 App 里重新注册");
  }
  if (delivered === 0) {
    // 失败时也回带尝试了几台设备 —— 群组推送失败时，知道「推了几个人」是排查的第一步。
    // 状态码按责任归类（设备失效 410、服务端或 Apple 的问题 502），原始 reason 附在 data 里
    const failure = explainFailures(results);
    return fail(failure.status, failure.message, {
      devices: results.length,
      reason: failure.reason,
      ...reportFields(report, ignored),
    });
  }
  return ok({
    ...reportFields(report, ignored),
    delivered,
    devices: results.length,
    channel: channel.name,
    ...(report.quieted ? { quieted: true } : {}),
    // 因接收者开了免打扰而静默送达的设备数 —— 发送方排查「为什么没响」看这个
    ...(report.muted ? { muted: report.muted } : {}),
    // 排上了重复提醒：隔几分钟、提醒到几点、消息 id（带同一个 id 推 status=resolved 可以提前停）
    ...(report.repeat ? { repeat: report.repeat } : {}),
  });
}

/**
 * /account 及其子路径。
 *
 *   POST   /account
 *   GET    /account/{id}
 *   PATCH  /account/{id}                                显示名、个人偏好、加密主密钥指纹
 *   DELETE /account/{id}                                删除账号
 *   DELETE /account/{id}/e2e                            重置加密（主密钥丢了时的最后办法）
 *   PUT    /account/{id}/keys/{cid}                     保管包裹后的群密钥
 *   DELETE /account/{id}/keys/{cid}
 *   POST   /account/{id}/devices
 *   DELETE /account/{id}/devices/{token}
 *   POST   /account/{id}/channels
 *   PATCH  /account/{id}/channels/{cid}                 仅创建者
 *   DELETE /account/{id}/channels/{cid}                 创建者=删除，成员=退出
 *   POST   /account/{id}/channels/{cid}/key             换 key，仅创建者
 *   POST   /account/{id}/channels/{cid}/invites         生成邀请码，仅创建者
 *   GET    /account/{id}/channels/{cid}/members         仅创建者
 *   DELETE /account/{id}/channels/{cid}/members/{mid}   仅创建者
 *   POST   /account/{id}/channels/{cid}/ack             认领一条消息，成员也可以
 *   POST   /account/{id}/channels/{cid}/report          举报这个群或其中一条消息，仅成员
 *   POST   /account/{id}/channels/{cid}/block           屏蔽群主：退群并拒收他之后的邀请，仅成员
 *   DELETE /account/{id}/blocked/{ownerId}              解除屏蔽
 *   GET    /account/{id}/invites/{code}                 加入前预览
 *   POST   /account/{id}/invites/{code}                 凭邀请码加入
 *   GET    /account/{id}/watches                        我建的监控
 *   POST   /account/{id}/watches                        新建监控（掉线 / 关键词 / 心跳）
 *   DELETE /account/{id}/watches/{wid}                  删除监控
 */
async function routeAccount(
  request: Request,
  env: Env,
  segments: string[],
): Promise<Response> {
  const [, id, section, target, sub, subTarget] = segments;
  const method = request.method;

  if (!id) {
    if (method !== "POST") return fail(405, "新建账号请用 POST /account");
    return handleCreateAccount(request, env);
  }

  if (!section) {
    if (method === "GET") return handleGetAccount(request, env, id);
    if (method === "PATCH") return handleUpdateAccount(request, env, id);
    if (method === "DELETE") return handleDeleteAccount(request, env, id);
    return fail(405, "只支持 GET、PATCH 或 DELETE");
  }

  if (section === "e2e") {
    if (method !== "DELETE") return fail(405, "只支持 DELETE");
    return handleResetEncryption(request, env, id);
  }

  if (section === "keys") {
    if (!target) return fail(400, "缺少通道 id");
    if (method === "PUT") return handleSetWrappedKey(request, env, id, target);
    if (method === "DELETE") return handleRemoveWrappedKey(request, env, id, target);
    return fail(405, "只支持 PUT 或 DELETE");
  }

  if (section === "devices") {
    if (!target) {
      if (method !== "POST") return fail(405, "只支持 POST");
      return handleAddDevice(request, env, id);
    }
    if (method !== "DELETE") return fail(405, "只支持 DELETE");
    return handleRemoveDevice(request, env, id, target);
  }

  if (section === "invites") {
    if (!target) return fail(400, "缺少邀请码");
    if (method === "GET") return handlePreviewInvite(request, env, id, target);
    if (method === "POST") return handleJoinInvite(request, env, id, target);
    return fail(405, "只支持 GET 或 POST");
  }

  if (section === "blocked") {
    if (!target) return fail(400, "缺少被屏蔽者的账号 id");
    if (method !== "DELETE") return fail(405, "只支持 DELETE");
    return handleUnblock(request, env, id, target);
  }

  if (section === "watches") {
    if (!target) {
      if (method === "GET") return handleListWatches(request, env, id);
      if (method === "POST") return handleCreateWatch(request, env, id);
      return fail(405, "只支持 GET 或 POST");
    }
    if (method !== "DELETE") return fail(405, "只支持 DELETE");
    return handleDeleteWatch(request, env, id, target);
  }

  if (section === "channels") {
    if (!target) {
      if (method !== "POST") return fail(405, "只支持 POST");
      return handleAddChannel(request, env, id);
    }
    if (!sub) {
      if (method === "PATCH") return handleUpdateChannel(request, env, id, target);
      if (method === "DELETE") return handleRemoveChannel(request, env, id, target);
      return fail(405, "只支持 PATCH 或 DELETE");
    }
    if (sub === "key") {
      if (method !== "POST") return fail(405, "只支持 POST");
      return handleRotateKey(request, env, id, target);
    }
    if (sub === "invites") {
      if (method !== "POST") return fail(405, "只支持 POST");
      return handleCreateInvite(request, env, id, target);
    }
    if (sub === "ack") {
      if (method !== "POST") return fail(405, "只支持 POST");
      return handleAck(request, env, id, target);
    }
    if (sub === "report") {
      if (method !== "POST") return fail(405, "只支持 POST");
      return handleReport(request, env, id, target);
    }
    if (sub === "block") {
      if (method !== "POST") return fail(405, "只支持 POST");
      return handleBlock(request, env, id, target);
    }
    if (sub === "members") {
      if (!subTarget) {
        if (method !== "GET") return fail(405, "只支持 GET");
        return handleListMembers(request, env, id, target);
      }
      if (method !== "DELETE") return fail(405, "只支持 DELETE");
      return handleRemoveMember(request, env, id, target, subTarget);
    }
  }

  return fail(404, "没有这个接口");
}

export default {
  /** cron 触发（见 wrangler.toml 的 triggers.crons）：把到点的监控抓一遍、看心跳有没有按时报到、补发重复提醒 */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // 用计划时刻而不是 Date.now()。实际触发会晚几百毫秒到几秒，每轮还不一样：按实际时刻记下
    // 「上次检查 / 下次提醒」，下一轮只要比上一轮早到一毫秒就算没到点，5 分钟一次的事整整晚一轮。
    // 计划时刻正好落在 5 分钟整点上，没有这种抖动
    const now = event.scheduledTime || Date.now();
    ctx.waitUntil(runScheduled(env, now));
    ctx.waitUntil(runReminders(env, now));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const segments = url.pathname
      .split("/")
      .filter(Boolean)
      .map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      });

    const head = segments[0];

    if (!head) {
      // 推送 key 也可以放在 Authorization: Bearer 里，地址就只剩根路径
      const bearer = bearerKey(request);
      if (bearer) return withCors(await handlePathPush(request, env, url, bearer, []));
      if (request.method === "GET" || request.method === "HEAD") return html(landingPage(url.host));
      // 原先落到落地页上：POST 回一整页 HTML，脚本只看到 200，以为推成功了
      return withCors(missingKey(url));
    }

    switch (head) {
      case "ping":
        return withCors(handlePing());
      case "healthz":
        return handleHealthz();
      case "info":
        return withCors(handleInfo(env));
      case "privacy":
        return html(privacyPage(url.host));
      // 站点图标，与 App 图标同源
      case "favicon.ico":
      case "favicon.png":
        return iconResponse(32);
      case "apple-touch-icon.png":
        return iconResponse(180);

      case "terms":
        return html(termsPage(url.host));

      // 网页发送页。推送 key 在链接 # 之后，服务器看不到；页面本身不含任何 key，可以照常缓存
      case "send":
        if (segments.length > 1) return withCors(fail(404, "没有这个页面"));
        return html(sendPage(url.host));

      // 心跳报到：定时任务跑完 curl 一下 /hb/{id}，失败了打 /hb/{id}/fail
      case "hb": {
        const [, id, action, extra] = segments;
        if (!id || extra !== undefined) {
          return withCors(fail(404, "用法：/hb/{id} 报到，/hb/{id}/fail 报告失败"));
        }
        return withCors(await handleHeartbeat(request, env, url, id, action));
      }

      // 通用链接校验文件。iOS 装 App 时会来拉这个，必须是 JSON、不重定向、不鉴权
      case ".well-known":
        if (segments[1] === "apple-app-site-association") {
          return new Response(appSiteAssociation(), {
            headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
          });
        }
        return withCors(fail(404, "没有这个文件"));

      // 仅供本地 API 测试（run-api.sh 以 --var PIGEON_TEST_ADMIN:1 启动 wrangler dev）。
      // 线上从不设置这个变量，这些路径在 nfo.im 上永远 404；线上的停用走 npm run mod。
      case "__test__": {
        const [, action, target] = segments;
        if (env.PIGEON_TEST_ADMIN !== "1" || request.method !== "POST") {
          return withCors(fail(404, "没有这个接口"));
        }
        const channel = target ? await getChannel(env, target) : null;
        if (!channel || (action !== "suspend" && action !== "restore")) {
          return withCors(fail(404, "没有这个接口"));
        }
        await setSuspended(env, channel, action === "suspend", "测试");
        return withCors(ok({ id: channel.id, suspended: action === "suspend" }));
      }

      // 端到端加密推送工具。和仓库里的 tools/pigeon-send.mjs 逐字节一致（测试会核对）
      case "tools":
        if (segments[1] === "pigeon-send.mjs") {
          return new Response(SENDER_SCRIPT, {
            headers: {
              "content-type": "text/javascript; charset=utf-8",
              "cache-control": "public, max-age=300",
            },
          });
        }
        return withCors(fail(404, "没有这个工具"));

      // 群组邀请落地页。不缓存：邀请会过期、群会被删、人数会变
      case "i": {
        const invite = await getInvite(env, segments[1] ?? "");
        const found = invite ? await getChannel(env, invite.channelId) : null;
        // 停用的群在公开页面上按「不存在」处理：不对外张扬审核结果，也不再替它引流
        const channel = found && !found.suspended ? found : null;
        const page = invitePage(url.host, invite?.code ?? "", invite, channel);
        return html(page.html, page.status, "no-store");
      }

      case "account":
        return withCors(await routeAccount(request, env, segments));

      case "push":
        if (request.method !== "POST") return withCors(fail(405, "/push 只接受 POST"));
        return withCors(await handleJsonPush(request, env));

      case "hook": {
        const [, key, adapter] = segments;
        if (!key || !adapter) {
          return withCors(fail(400, "用法：POST /hook/{key}/{适配器名}"));
        }
        return withCors(await handleHook(request, env, key, adapter));
      }
    }

    if (RESERVED.has(head)) return withCors(fail(404, "没有这个接口"));

    // ── 路径式推送
    const [key, ...pathText] = stripSendSuffix(segments);
    if (!key) return withCors(missingKey(url));
    return withCors(await handlePathPush(request, env, url, key, pathText));
  },
};
