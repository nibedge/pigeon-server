import { explainFailures } from "../apns";
import { contentRejection } from "../contentfilter";
import { displayName, newId, recipientsOf, roleOf } from "../db";
import { plaintextRejection, suspensionRejection } from "../policy";
import { deliver, reportFields } from "../push";
import { allow } from "../ratelimit";
import { fail, ok, tooMany } from "../respond";
import type { Env, PushParams } from "../types";
import { readJSON, requireAuth, requireChannel } from "./account";

/**
 * POST /account/{id}/channels/{cid}/messages —— 在群里发一条消息。
 *
 * 群原本是群主的推送入口：脚本、监控往里推，成员只接收。有的群用着用着需要回一句（「我到家了」「服务器我重启了」），
 * 群主可以打开「允许成员发消息」（通道的 memberSend），成员就能从 App 里往群里发；群主自己随时能发。
 *
 * 和推送地址推来的消息比，这里刻意收得很窄：
 * - 只有标题、正文、级别（或加密后的密文）。没有链接、图片、按钮、重复提醒 —— 那些是给集成用的
 * - 级别最高到时效性，从不是 critical：成员之间没有「把别人从免打扰里叫醒」的权力
 * - 通道的默认参数不垫底：默认值是群主给集成配的（比如一律重复提醒），不该套到人发的消息上
 * - 群里的违禁词过滤、只收加密、停用、每个通道每分钟 60 条照样管
 * - 每个人每分钟最多 20 条（和认领共用账号的限流绑定，各计各的）
 *
 * payload 带 sender（发消息的人的名字），App 显示「某某 发的」；发消息的人自己的设备静默收下，只进历史
 */

/** 成员发的消息能用的级别 */
const MEMBER_LEVELS = new Set(["passive", "active", "timeSensitive"]);
/** 标题、正文截到这么长：和网页发送一样的上限，再长就不是在群里说一句话了 */
const MAX_TITLE = 100;
const MAX_BODY = 1000;
/** 密文的样子：base64，长度够放下上面那点文字加密后的结果 */
const CIPHER_RE = /^[A-Za-z0-9+/=_-]{1,6000}$/;
const IV_RE = /^[A-Za-z0-9+/=_-]{8,64}$/;

function text(raw: unknown, max: number): string {
  return typeof raw === "string" ? raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, max) : "";
}

export async function handleMemberMessage(
  request: Request,
  env: Env,
  accountId: string,
  channelId: string,
): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  // 按人限流：挡住拿脚本往群里刷屏的成员。放在读通道之前，刷的人连存储都少读
  if (!(await allow(env.RL_ACCOUNT, `msg:${auth.id}`))) return tooMany("发得太频繁了，请过一分钟再试");
  const channel = await requireChannel(env, auth, channelId, false);
  if (channel instanceof Response) return channel;
  const suspended = suspensionRejection(channel);
  if (suspended) return fail(403, suspended);
  if (roleOf(channel, auth.id) === "member" && !channel.memberSend) {
    return fail(403, "群主没有开放成员发消息");
  }

  const body = await readJSON(request);
  const level = body.level === undefined || body.level === null || body.level === "" ? "active" : body.level;
  if (typeof level !== "string" || !MEMBER_LEVELS.has(level)) {
    return fail(400, "level 只能是 passive、active 或 timeSensitive —— 在群里发的消息最高到时效性");
  }
  const params: PushParams = { level };
  const title = text(body.title, MAX_TITLE);
  const content = text(body.body, MAX_BODY);
  if (title) params.title = title;
  if (content) params.body = content;
  if (body.ciphertext !== undefined || body.iv !== undefined) {
    if (typeof body.ciphertext !== "string" || !CIPHER_RE.test(body.ciphertext) || typeof body.iv !== "string" || !IV_RE.test(body.iv)) {
      return fail(400, "ciphertext、iv 格式不对：应为 base64，两个都要给");
    }
    params.ciphertext = body.ciphertext;
    params.iv = body.iv;
  }
  if (!params.title && !params.body && !params.ciphertext) return fail(400, "没有内容可发 —— 给个 body（或 title）");

  const name = displayName(auth);
  // 没写标题就用发消息的人的名字当标题：通知上一眼看得出是谁说的，不认识 sender 的旧版 App 也一样。
  // 加密的消息不补：补上明文标题，系统就不显示「加密消息」的占位，而正文还在密文里
  if (!params.title && params.body && !params.ciphertext) params.title = name;

  const rejection = plaintextRejection(channel, params);
  if (rejection) return fail(400, rejection);
  const blocked = await contentRejection(env, channel, params);
  if (blocked) return fail(400, blocked);
  // 和推送地址推来的共用这个通道每分钟 60 条的额度。超了不去提醒群主 —— 那条提醒说的是「发送脚本在循环重发」
  if (!(await allow(env.RL_PUSH, `push:${channel.id}`))) {
    return tooMany("群里这会儿消息太多了，请过一分钟再发");
  }

  // 服务端给 id、而且当成发送方给的：去重按 id 区分，两个人先后回同一句「收到」不会被当成重复压掉
  params.id = newId();
  const report = await deliver(env, channel, await recipientsOf(env, channel), params, {
    sender: name,
    senderId: auth.id,
  });
  if (report.rejection) {
    const { status, message, bytes, limit } = report.rejection;
    return fail(status, message, { bytes, limit });
  }
  const { results, delivered } = report;
  if (results.length > 0 && delivered === 0) {
    const failure = explainFailures(results);
    return fail(failure.status, failure.message, { devices: results.length, reason: failure.reason, ...reportFields(report) });
  }
  return ok({
    ...reportFields(report),
    delivered,
    devices: results.length,
  });
}
