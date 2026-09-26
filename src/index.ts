import { contentRejection } from "./contentfilter";
import { displayName, getAccount, getChannel, resolveChannel, setSuspended } from "./db";
import { openInvite } from "./groups";
import { allowIp } from "./guard";
import { SENDER_SCRIPT } from "./generated/sender";
import { invitePage, rateLimitedInvitePage } from "./invite";
import { landingPage } from "./landing";
import { plaintextRejection, suspensionRejection } from "./policy";
import { privacyPage } from "./privacy";
import { collectParams, deliver, runReminders } from "./push";
import { fail, html, ok, PAGE_CACHE, scriptHash } from "./respond";
import { SEND_SCRIPT, sendPage } from "./send";
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
  handleListInvites,
  handleListMembers,
  handlePreviewInvite,
  handleRemoveChannel,
  handleRemoveDevice,
  handleRemoveMember,
  handleRemoveWrappedKey,
  handleReport,
  handleResetEncryption,
  handleRevokeAllInvites,
  handleRevokeInvite,
  handleRotateKey,
  handleSetWrappedKey,
  handleUnban,
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
import { RATE_WINDOW_SECONDS } from "./ratelimit";
import { appSiteAssociation } from "./appstore";
import { iconResponse } from "./icon";
import { runScheduled } from "./watch";
import type { Env, PushParams } from "./types";

/** 这些第一段路径是接口，不能当成通道 key */
const RESERVED = new Set([
  "account", "push", "ping", "healthz", "info", "hook", "i", "tools", "hb", "send",
  "favicon.ico", "favicon.png", "apple-touch-icon.png",
  "robots.txt", "privacy", "terms", "docs", "static", "__test__", ".well-known",
]);

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  // x-pigeon-client：App 在每个请求上标明自己的版本，只读不强制
  "access-control-allow-headers": "content-type, authorization, x-pigeon-client",
  "access-control-max-age": "86400",
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

/** 这些第一段路径的 GET 不带任何凭据，明文 http 过来可以直接跳到 https */
const PAGES = new Set([
  "privacy", "terms", "send", "i", "tools", "ping", "healthz", "info",
  "favicon.ico", "favicon.png", "apple-touch-icon.png", "robots.txt", ".well-known",
]);

/**
 * 明文 http 的请求。页面跳到 https；其余（推送、/hook、/push、/account、/hb）一律 400，不跳转：
 * 请求已经以明文发出来了，推送 key、账号凭据在路上可能已被看到，跳转只会让客户端把同样的东西再发一遍，
 * 推送也就照样发了出去 —— 等于默许明文。回个错，让写脚本的人第一次试就发现、改成 https。
 *
 * 本地开发：wrangler.toml 的 [dev] 把请求报成 https，与线上一致；主机是 localhost 的也放过
 */
function plaintextResponse(request: Request, url: URL, head: string | undefined): Response | null {
  if (url.protocol !== "http:") return null;
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]") {
    return null;
  }
  const readOnly = request.method === "GET" || request.method === "HEAD";
  if (readOnly && (!head || PAGES.has(head))) {
    const target = new URL(url);
    target.protocol = "https:";
    return Response.redirect(target.toString(), 301);
  }
  return withCors(fail(400, "请用 https。明文 http 会让推送地址和内容在路上被人看到，这次请求没有处理"));
}

/** POST /push —— JSON 请求体里带 device_key 或 device_keys 的批量接口 */
async function handleJsonPush(request: Request, env: Env): Promise<Response> {
  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return fail(400, "请求体不是合法的 JSON");
  }

  const single = typeof payload.device_key === "string" ? [payload.device_key] : [];
  const many = Array.isArray(payload.device_keys)
    ? payload.device_keys.filter((k): k is string => typeof k === "string")
    : [];
  const keys = [...new Set([...single, ...many])];

  if (keys.length === 0) return fail(400, "缺少 device_key 或 device_keys");
  if (keys.length > 100) return fail(400, "一次最多推 100 个 key");

  const params: PushParams = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k === "device_key" || k === "device_keys") continue;
    if (v !== null && v !== undefined) (params as Record<string, string>)[k] = String(v);
  }

  const outcomes = await Promise.all(
    keys.map(async (key) => {
      const resolved = await resolveChannel(env, key);
      if (!resolved) return { key, delivered: 0, error: "key 不存在" };
      const { channel, recipients } = resolved;
      const suspended = suspensionRejection(channel);
      if (suspended) return { key, delivered: 0, error: suspended };
      const merged = { ...(channel.defaults ?? {}), ...params };
      const rejection = plaintextRejection(channel, merged);
      if (rejection) return { key, delivered: 0, error: rejection };
      const blocked = await contentRejection(env, channel, merged);
      if (blocked) return { key, delivered: 0, error: blocked };
      const { delivered, results, muted, repeat } = await deliver(env, channel, recipients, merged);
      return {
        key,
        delivered,
        ...(muted ? { muted } : {}),
        ...(repeat ? { repeat } : {}),
        error: delivered === 0 ? (results[0]?.reason ?? "没有可用设备") : undefined,
      };
    }),
  );

  const delivered = outcomes.reduce((sum, o) => sum + o.delivered, 0);
  if (delivered === 0) return fail(400, "全部推送失败", outcomes);
  return ok({ delivered, results: outcomes });
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
 *   GET    /account/{id}/channels/{cid}/invites         还有效的邀请，仅创建者
 *   DELETE /account/{id}/channels/{cid}/invites         作废全部邀请，仅创建者
 *   DELETE /account/{id}/channels/{cid}/invites/{code}  作废一个邀请码，仅创建者
 *   GET    /account/{id}/channels/{cid}/members         成员与禁入名单，仅创建者
 *   DELETE /account/{id}/channels/{cid}/members/{mid}   移除成员（可同时作废邀请、禁止再加入），仅创建者
 *   DELETE /account/{id}/channels/{cid}/bans/{mid}      解除禁入，仅创建者
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
      if (!subTarget) {
        if (method === "POST") return handleCreateInvite(request, env, id, target);
        if (method === "GET") return handleListInvites(request, env, id, target);
        if (method === "DELETE") return handleRevokeAllInvites(request, env, id, target);
        return fail(405, "只支持 GET、POST 或 DELETE");
      }
      if (method !== "DELETE") return fail(405, "只支持 DELETE");
      return handleRevokeInvite(request, env, id, target, subTarget);
    }
    if (sub === "bans") {
      if (!subTarget) return fail(400, "缺少账号 id");
      if (method !== "DELETE") return fail(405, "只支持 DELETE");
      return handleUnban(request, env, id, target, subTarget);
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
    const url = new URL(request.url);
    const plaintext = plaintextResponse(request, url, url.pathname.split("/").filter(Boolean)[0]);
    if (plaintext) return plaintext;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

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

    if (!head) return html(landingPage(url.host));

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
        return html(sendPage(url.host), 200, PAGE_CACHE, [await scriptHash(SEND_SCRIPT)]);

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
        // 与 App 里的预览、加入共用一个按 IP 的计数：网页上同样能挨个试邀请码
        if (!(await allowIp(env.RL_IP, request, "invite"))) {
          const limited = rateLimitedInvitePage(url.host);
          const res = html(limited.html, limited.status, "no-store");
          res.headers.set("retry-after", String(RATE_WINDOW_SECONDS));
          return res;
        }
        // 群主作废了的邀请，和过期的一样按「已失效」处理
        const invite = (await openInvite(env, segments[1] ?? ""))?.invite ?? null;
        const found = invite ? await getChannel(env, invite.channelId) : null;
        // 停用的群在公开页面上按「不存在」处理：不对外张扬审核结果，也不再替它引流
        const channel = found && !found.suspended ? found : null;
        const owner = channel ? await getAccount(env, channel.ownerId) : null;
        const page = invitePage(url.host, invite?.code ?? "", invite, channel, owner ? displayName(owner) : undefined);
        const hashes = await Promise.all((page.scripts ?? []).map(scriptHash));
        return html(page.html, page.status, "no-store", hashes);
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

    // ── 路径式推送： /{key} · /{key}/{body} · /{key}/{title}/{body}
    //                 /{key}/{title}/{subtitle}/{body}
    const resolved = await resolveChannel(env, head);
    if (!resolved) {
      return withCors(fail(404, "这个 key 不存在。先在 App 里注册，或检查有没有拼错"));
    }
    const { channel, recipients } = resolved;
    const suspended = suspensionRejection(channel);
    if (suspended) return withCors(fail(403, suspended));

    const params = await collectParams(request, url, segments.slice(1), channel);
    // 端到端加密的消息只有密文、没有明文标题正文，也是一条合法的消息
    if (!params.title && !params.subtitle && !params.body && !params.ciphertext) {
      return withCors(fail(400, "没有内容可推 —— 在路径或参数里给个 body"));
    }
    const rejection = plaintextRejection(channel, params);
    if (rejection) return withCors(fail(400, rejection));
    // 群组的明文推送过一遍违禁词表（见 contentfilter.ts）
    const blocked = await contentRejection(env, channel, params);
    if (blocked) return withCors(fail(400, blocked));

    const report = await deliver(env, channel, recipients, params);
    const { results, delivered } = report;

    // 被去重压掉也算收下了 —— 回 4xx 的话发送方会一直重试，越重试越重复
    if (report.suppressed) {
      return withCors(ok({ suppressed: "duplicate", channel: channel.name }));
    }
    if (results.length === 0) {
      return withCors(fail(410, "这个通道下没有可用设备，请在 App 里重新注册"));
    }
    if (delivered === 0) {
      // 失败时也回带尝试了几台设备 —— 群组推送失败时，知道「推了几个人」是排查的第一步
      const first = results[0];
      return withCors(
        fail(first?.status ?? 500, `推送失败: ${first?.reason ?? "未知原因"}`, {
          devices: results.length,
        }),
      );
    }
    return withCors(
      ok({
        delivered,
        devices: results.length,
        channel: channel.name,
        ...(report.quieted ? { quieted: true } : {}),
        // 因接收者开了免打扰而静默送达的设备数 —— 发送方排查「为什么没响」看这个
        ...(report.muted ? { muted: report.muted } : {}),
        // 排上了重复提醒：隔几分钟、提醒到几点、消息 id（带同一个 id 推 status=resolved 可以提前停）
        ...(report.repeat ? { repeat: report.repeat } : {}),
      }),
    );
  },
};
