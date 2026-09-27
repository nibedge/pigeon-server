import { updateAccount } from "../db";
import { parseActivityToken, registerActivity, validMessageId } from "../live";
import { suspensionRejection } from "../policy";
import { allow } from "../ratelimit";
import { fail, ok, tooMany } from "../respond";
import type { Account, Device, Env } from "../types";
import { readJSON, requireAuth, requireChannel } from "./account";

/**
 * 实时活动的两个登记接口，只给 App 用（发送方用不着）：
 *
 *   PUT    /account/{id}/devices/{token}/activity-start-token   这台设备的 push-to-start 令牌
 *   DELETE /account/{id}/devices/{token}/activity-start-token   本机关掉了「事件用实时活动显示」
 *   PUT    /account/{id}/activities/{cid}/{mid}                 某件事在这台设备上的活动的更新令牌
 *
 * 推送本身怎么开、怎么更新、怎么结束，见 live.ts。
 */

/** 两个接口共用一份额度：同一个账号一分钟最多登记这么多次（RL_ACCOUNT 的上限）。告警风暴里一件事一次，够用 */
function limited(env: Env, account: Account): Promise<boolean> {
  return allow(env.RL_ACCOUNT, `live:${account.id}`).then((ok) => !ok);
}

/** 按完整推送令牌或 ≥12 位前缀找本账号的设备，和移除设备同一个规矩（App 手里可能只有前缀） */
function findDevice(account: Account, token: unknown): Device | "none" | "ambiguous" {
  if (typeof token !== "string" || !token) return "none";
  const matches = account.devices.filter((d) => d.token === token || (token.length >= 12 && d.token.startsWith(token)));
  if (matches.length > 1) return "ambiguous";
  return matches[0] ?? "none";
}

const NOT_HERE = "这台设备不在账号里";
const AMBIGUOUS = "这个前缀对应了不止一台设备，请给出完整 token";
const BAD_TOKEN = "token 格式不对：应为 ActivityKit 给的令牌（十六进制）";

/**
 * PUT / DELETE /account/{id}/devices/{token}/activity-start-token
 *
 * PUT body {"token": "<push-to-start 令牌>"}：记在这台设备的记录上，之后带 live 的告警就会在它上面开实时活动。
 * 和记着的一样就不写 —— 账号记录每秒只能写一次，App 每次启动都会来核对一遍。
 * DELETE：本机关掉了「事件用实时活动显示」，或者系统设置里不让信鸽显示实时活动了
 */
export async function handleActivityStartToken(
  request: Request,
  env: Env,
  accountId: string,
  deviceToken: string,
): Promise<Response> {
  const method = request.method;
  if (method !== "PUT" && method !== "DELETE") return fail(405, "只支持 PUT 或 DELETE");
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  if (await limited(env, auth)) return tooMany("登记实时活动太频繁了，请过一分钟再试");
  const device = findDevice(auth, deviceToken);
  if (device === "none") return fail(404, NOT_HERE);
  if (device === "ambiguous") return fail(400, AMBIGUOUS);

  // 改的是这台设备的一条记录。撞上 KV 同键每秒一次的上限（升级后第一次启动，同一秒还有已读水位要存）时，
  // updateAccount 重读账号、在最新的记录上再改一遍（见 db.ts）；那时按推送令牌重新找这台设备
  const onDevice = (account: Account, change: (d: Device) => boolean): boolean => {
    const found = account.devices.find((d) => d.token === device.token);
    return found ? change(found) : false;
  };

  if (method === "DELETE") {
    await updateAccount(
      env,
      auth,
      (account) =>
        onDevice(account, (d) => {
          if (!d.activityStartToken) return false;
          delete d.activityStartToken;
          delete d.activityStartTokenAt;
          return true;
        }),
      (changed) => changed,
    );
    return ok({ live_activities: false });
  }

  const token = parseActivityToken((await readJSON(request)).token);
  if (!token) return fail(400, BAD_TOKEN);
  await updateAccount(
    env,
    auth,
    (account) =>
      onDevice(account, (d) => {
        if (d.activityStartToken === token) return false;
        d.activityStartToken = token;
        d.activityStartTokenAt = Date.now();
        return true;
      }),
    (changed) => changed,
  );
  return ok({ live_activities: true });
}

/**
 * PUT /account/{id}/activities/{cid}/{mid}
 *
 * body {"token": "<这个活动的更新令牌>", "device": "<本机推送令牌>", "started_at": 毫秒}
 * 群成员也可以（认领、恢复要推给群里每个人的活动）。响应见 live.ts ActivityRegistration：
 * 这件事已经结束了会回 ended，App 当场收起；已经有人认领了会带上是谁
 */
export async function handleActivityToken(
  request: Request,
  env: Env,
  accountId: string,
  channelId: string,
  messageId: string,
): Promise<Response> {
  if (request.method !== "PUT") return fail(405, "只支持 PUT");
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  if (await limited(env, auth)) return tooMany("登记实时活动太频繁了，请过一分钟再试");
  const channel = await requireChannel(env, auth, channelId, false);
  if (channel instanceof Response) return channel;
  const suspended = suspensionRejection(channel);
  if (suspended) return fail(403, suspended);
  if (!validMessageId(messageId)) return fail(400, "消息 id 格式不对");

  const body = await readJSON(request);
  const token = parseActivityToken(body.token);
  if (!token) return fail(400, BAD_TOKEN);
  const device = findDevice(auth, body.device);
  if (device === "none") return fail(404, NOT_HERE);
  if (device === "ambiguous") return fail(400, AMBIGUOUS);
  const started = typeof body.started_at === "number" && Number.isFinite(body.started_at) ? body.started_at : undefined;

  return ok(await registerActivity(env, channel.id, messageId, auth.id, device, token, started));
}
