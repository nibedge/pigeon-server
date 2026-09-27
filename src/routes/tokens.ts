import { suspensionRejection } from "../policy";
import { allowKeyMiss } from "../push";
import { RATE_WINDOW_SECONDS } from "../ratelimit";
import { fail, html, ok, scriptHash } from "../respond";
import { TOKEN_SEND_SCRIPT, tokenPageStatus, tokenSendPage, type TokenPageState } from "../tokenpage";
import {
  createToken,
  deleteToken,
  isRetired,
  isTokenFormat,
  listTokens,
  lookupToken,
  MAX_TOKENS_PER_CHANNEL,
  parseTokenInput,
  readUse,
  tokenView,
  updateToken,
} from "../tokens";
import type { Env } from "../types";
import { readJSON, requireAuth, requireChannel } from "./account";

/**
 * 发送令牌的管理，仅通道创建者（令牌本身的规矩见 tokens.ts）：
 *
 *   GET    /account/{id}/channels/{cid}/tokens          全部令牌（名字、限制、用量），不含令牌明文
 *   POST   /account/{id}/channels/{cid}/tokens          新建。令牌明文只在这一次回给你
 *   PATCH  /account/{id}/channels/{cid}/tokens/{tid}    改名、改限制、停用或恢复
 *   DELETE /account/{id}/channels/{cid}/tokens/{tid}    删除。还在用它的来源之后 30 天收到 410
 */
export async function handleTokens(
  request: Request,
  env: Env,
  accountId: string,
  channelId: string,
  tokenId: string | undefined,
): Promise<Response> {
  const method = request.method;
  if (tokenId === undefined && method !== "GET" && method !== "POST") return fail(405, "只支持 GET 或 POST");
  if (tokenId !== undefined && method !== "PATCH" && method !== "DELETE") return fail(405, "只支持 PATCH 或 DELETE");

  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  // 成员回 403、外人回 404，和别的管理接口一样：令牌等于推送地址，只有创建者碰得到
  const channel = await requireChannel(env, auth, channelId, true);
  if (channel instanceof Response) return channel;

  if (method === "GET") {
    const tokens = await listTokens(env, channel.id);
    return ok({ tokens: tokens.map((t) => tokenView(t.token, t.use)), limit: MAX_TOKENS_PER_CHANNEL });
  }

  if (method === "POST") {
    // 停用的通道推不进去，发新令牌也没有意义
    const suspended = suspensionRejection(channel);
    if (suspended) return fail(403, suspended);
    const input = parseTokenInput(await readJSON(request), true);
    if (typeof input === "string") return fail(400, input);
    const made = await createToken(env, channel, input);
    if (typeof made === "string") return fail(400, made);
    const origin = new URL(request.url).origin;
    return ok({
      token: tokenView(made.token, null),
      // 令牌明文只有这一次：服务端只存它的摘要，之后谁也拿不出来。丢了就删掉重建
      value: made.value,
      push_url: `${origin}/${made.value}`,
      // 只能发通知的网页，给不写代码的人用
      page_url: `${origin}/s/${made.value}`,
    });
  }

  if (method === "PATCH") {
    const input = parseTokenInput(await readJSON(request), false);
    if (typeof input === "string") return fail(400, input);
    const updated = await updateToken(env, channel, tokenId ?? "", input);
    if (updated === null) return fail(404, "没有这个发送令牌");
    if (typeof updated === "string") return fail(400, updated);
    return ok({ token: tokenView(updated, await readUse(env, updated.id)) });
  }

  if (!(await deleteToken(env, channel, tokenId ?? ""))) return fail(404, "没有这个发送令牌");
  return ok({ deleted: tokenId });
}

/**
 * GET /s/{令牌} —— 只能发通知的网页（见 tokenpage.ts）。不缓存：令牌随时可能被停用、删除。
 * 查不到的按 IP 计数，和推送入口查不存在的 key 共用一份额度（nokey:{ip}）
 */
export async function handleTokenPage(request: Request, env: Env, url: URL, segments: string[]): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return fail(405, "这个页面只支持 GET");
  const [, value = "", extra] = segments;
  let state: TokenPageState;
  const found = extra === undefined ? await lookupToken(env, value) : null;
  if (!found) {
    if (!(await allowKeyMiss(env, request))) state = { kind: "limited" };
    else if (isTokenFormat(value) && (await isRetired(env, value))) state = { kind: "retired" };
    else state = { kind: "missing" };
  } else if (suspensionRejection(found.channel)) {
    state = { kind: "suspended" };
  } else if (found.token.disabled) {
    state = { kind: "disabled" };
  } else {
    state = {
      kind: "ready",
      channelName: found.channel.name,
      tokenName: found.token.name,
      ...(found.token.maxLevel ? { maxLevel: found.token.maxLevel } : {}),
    };
  }
  const hashes = state.kind === "ready" ? [await scriptHash(TOKEN_SEND_SCRIPT)] : [];
  const res = html(tokenSendPage(url.host, state), tokenPageStatus(state), "no-store", hashes);
  if (state.kind === "limited") res.headers.set("retry-after", String(RATE_WINDOW_SECONDS));
  return res;
}
