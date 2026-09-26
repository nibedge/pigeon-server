import {
  addChannel,
  authenticate,
  blockOwner,
  claimAck,
  createAccount,
  deleteAccount,
  createInvite,
  deleteChannel,
  displayName,
  fileReport,
  getAccount,
  getChannel,
  getModChannelId,
  isBlocked,
  isValidId,
  joinChannel,
  leaveChannel,
  listChannels,
  MAX_MEMBERS,
  newId,
  putAccount,
  putChannel,
  recipientsOf,
  removeMember,
  REPORT_REASONS,
  roleOf,
  rotateKey,
  sanitizePrefs,
  unblockOwner,
  upsertDevice,
} from "../db";
import { pushToDevice } from "../apns";
import {
  ackSigValid,
  ban,
  forgetGroup,
  getGroupState,
  isBanned,
  liveInvites,
  moderatorNotice,
  openInvite,
  recordInvite,
  REPORTS_PER_HOUR,
  revokeAllInvites,
  revokeInvite,
  saveGroupState,
  takeReportQuota,
  unban,
} from "../groups";
import { allowIp } from "../guard";
import { parsePolicy, suspensionRejection } from "../policy";
import { announceAck, buildPayload, cancelRepeat, deliver, PARAM_KEYS, pushHeaders } from "../push";
import { allow } from "../ratelimit";
import { fail, ok, tooMany } from "../respond";
import {
  createWatch,
  deleteWatch,
  getWatch,
  listWatches,
  MAX_WATCHES,
  parseWatchInput,
} from "../watch";
import type { Account, ApnsEnv, Channel, Device, Env, PushParams, Report, Watch } from "../types";

/** 一个账号最多创建或加入的通道数 */
const MAX_CHANNELS = 100;
/** 显示名上限。它会出现在别人的通知标题里，太长会把正文挤没 */
const MAX_NAME = 20;
const DEFAULT_KEYS = new Set<string>(PARAM_KEYS);

interface DeviceInput {
  device_token?: string;
  environment?: string;
  device_name?: string;
}

function parseDevice(input: DeviceInput): Device | string {
  const token = (input.device_token ?? "").trim();
  if (!token) return "缺少 device_token —— App 向 APNs 注册后拿到的那个值";
  // APNs token 长度会变，但不该这么长，也不该含非十六进制字符
  if (token.length > 200 || !/^[A-Za-z0-9]+$/.test(token)) {
    return "device_token 格式不对";
  }
  // 不申报就按 production：正式发布的包占绝大多数，而把生产设备误判成
  // sandbox 会让真实用户彻底收不到推送，反过来只影响开发期调试。
  const env: ApnsEnv =
    (input.environment ?? "").toLowerCase() === "sandbox" ? "sandbox" : "production";
  const name = (input.device_name ?? "").trim().slice(0, 40) || "未命名设备";
  return { token, env, name, addedAt: Date.now() };
}

async function readJSON(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function channelView(channel: Channel, viewerId: string) {
  const role = roleOf(channel, viewerId);
  const view = {
    id: channel.id,
    name: channel.name,
    icon: channel.icon,
    role,
    member_count: channel.memberIds.length + 1,
    defaults: channel.defaults,
    policy: channel.policy,
    count: channel.count,
    last_push_at: channel.lastPushAt,
    created_at: channel.createdAt,
    // 停用状态两种身份都看得到：群主要知道为什么推不进去，成员要知道为什么不响了
    ...(channel.suspended ? { suspended: true } : {}),
    // 作为群建的：成员还没加入时，App 也要把它放在群组里
    ...(channel.group ? { group: true } : {}),
  };
  // key 是推送凭据。成员只接收，不给他看 —— 否则任何成员都能冒用这个地址
  // 往群里推消息，「只有创建者能管理这个地址」就成了空话。
  return role === "owner" ? { ...view, key: channel.key } : view;
}

/** 对外只暴露必要字段 —— secretHash 绝不能出现在任何响应里 */
async function accountView(env: Env, account: Account) {
  const channels = await listChannels(env, account);
  const visible = new Set(channels.map((c) => c.id));
  return {
    account_id: account.id,
    name: account.name,
    prefs: account.prefs ?? {},
    // 只回还在列表里的通道的密钥；已经退出的群，它的密钥没有理由再发给设备
    wrapped_keys: Object.fromEntries(
      Object.entries(account.wrappedKeys ?? {}).filter(([id]) => visible.has(id)),
    ),
    e2e_fingerprint: account.e2eFingerprint,
    blocked: (account.blocked ?? []).map((b) => ({ account_id: b.id, name: b.name, at: b.at })),
    terms_accepted_at: account.termsAcceptedAt,
    devices: account.devices.map((d) => ({
      // token 只回前 12 位：足够认出是哪台，又不至于把可用凭据摊在响应里
      token_prefix: d.token.slice(0, 12),
      environment: d.env,
      name: d.name,
      added_at: d.addedAt,
    })),
    channels: channels.map((c) => channelView(c, account.id)),
  };
}

/**
 * 请求里带了 accept_terms: true 就记下「同意了使用条款」。只记第一次。
 * 返回这次有没有新记上 —— 调用方据此决定要不要多写一次账号。不带也放行：旧版 App 不知道这个字段
 */
function acceptTerms(account: Account, body: Record<string, unknown>): boolean {
  if (body.accept_terms !== true || account.termsAcceptedAt) return false;
  account.termsAcceptedAt = Date.now();
  return true;
}

/** 从 Authorization: Bearer 里取出 secret 并验明账号 */
async function requireAuth(
  request: Request,
  env: Env,
  accountId: string,
): Promise<Account | Response> {
  const header = request.headers.get("authorization") ?? "";
  const secret = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!secret) return fail(401, "缺少 Authorization: Bearer <secret>");
  if (!isValidId(accountId)) return fail(400, "account id 格式不对");

  const account = await authenticate(env, accountId, secret);
  // 账号不存在和 secret 不对回同一个错，免得把「这个 id 存在」这件事漏出去
  if (!account) return fail(401, "账号不存在或凭据不正确");
  return account;
}

/** 载入通道并核对调用者的身份。创建者专属的操作传 needOwner */
async function requireChannel(
  env: Env,
  account: Account,
  channelId: string,
  needOwner: boolean,
): Promise<Channel | Response> {
  if (!isValidId(channelId)) return fail(400, "通道 id 格式不对");
  const channel = await getChannel(env, channelId);
  const role = channel ? roleOf(channel, account.id) : null;
  // 不存在和无权查看回同一个 404 —— 否则就能拿任意 id 探测别人的通道是否存在
  if (!channel || !role) return fail(404, "没有这个通道");
  if (needOwner && role !== "owner") return fail(403, "只有通道的创建者能做这个操作");
  return channel;
}

// ── 账号与设备 ──────────────────────────────────────────────────────

/**
 * POST /account —— 新建账号并登记第一台设备。
 * secret 只在这里返回一次，服务端只留 SHA-256。
 */
export async function handleCreateAccount(request: Request, env: Env): Promise<Response> {
  // 建账号不要凭据：按来源 IP 限流，挡住成批注册
  if (!(await allowIp(env.RL_IP, request, "acct"))) {
    return tooMany("注册太频繁了，请过一分钟再试");
  }
  const device = parseDevice(await readJSON(request));
  if (typeof device === "string") return fail(400, device);
  const { account, secret } = await createAccount(env, device);
  return ok({ ...(await accountView(env, account)), secret });
}

export async function handleGetAccount(
  request: Request,
  env: Env,
  accountId: string,
): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  return ok(await accountView(env, auth));
}

/** PATCH /account/{id} —— 目前只有显示名一项。传空串或 null 表示清掉 */
export async function handleUpdateAccount(
  request: Request,
  env: Env,
  accountId: string,
): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  const body = await readJSON(request);
  if ("name" in body) {
    const name =
      typeof body.name === "string"
        ? body.name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME)
        : "";
    if (name) auth.name = name;
    else delete auth.name;
  }
  if ("prefs" in body) {
    const prefs = sanitizePrefs(body.prefs, auth.channelIds);
    if (Object.keys(prefs).length > 0) auth.prefs = prefs;
    else delete auth.prefs;
  }
  if ("e2e_fingerprint" in body) {
    const fingerprint = typeof body.e2e_fingerprint === "string" ? body.e2e_fingerprint : "";
    if (!/^[0-9a-f]{16}$/.test(fingerprint)) return fail(400, "e2e_fingerprint 应为 16 位十六进制");
    // 指纹只能设一次。换成别的主密钥，这个账号其他设备上的加密消息就全部解不开了 ——
    // 新设备该做的是从已有设备扫码配对，把原来的主密钥带过来
    if (auth.e2eFingerprint && auth.e2eFingerprint !== fingerprint) {
      return fail(409, "这个账号已经有加密主密钥了。请在已登录的设备上出示配对码，用这台设备扫码，把密钥带过来");
    }
    auth.e2eFingerprint = fingerprint;
  }
  await putAccount(env, auth);
  return ok(await accountView(env, auth));
}

/**
 * DELETE /account/{id} —— 删除账号。服务端上和这个人有关的记录立即清掉：
 * 账号、设备令牌、自己建的通道（成员一起失去，地址立即失效）、加入的群组里的名字。
 */
export async function handleDeleteAccount(
  request: Request,
  env: Env,
  accountId: string,
): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  await deleteAccount(env, auth);
  return ok({ deleted: true });
}

/**
 * DELETE /account/{id}/e2e —— 重置加密：清掉主密钥指纹和保管的群密钥。
 *
 * 最后的办法：持有主密钥的设备全都丢了，账号却还在（比如只剩一台从没拿到过主密钥的设备）。
 * 重置之后旧的加密消息再也解不开，发送端要换新密钥，加入的加密群要重新邀请 —— App 会讲清楚再让人点。
 */
export async function handleResetEncryption(
  request: Request,
  env: Env,
  accountId: string,
): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  delete auth.e2eFingerprint;
  delete auth.wrappedKeys;
  await putAccount(env, auth);
  return ok(await accountView(env, auth));
}

/** 包裹后的群密钥：base64 / base64url，长度有上限 —— 服务端只保管，不解析 */
const WRAPPED_RE = /^[A-Za-z0-9_\-+/=]{16,200}$/;

/**
 * PUT /account/{id}/keys/{cid} —— 替这个账号的各台设备保管一份包裹后的群密钥。
 * 密文是用这个账号的主密钥加密的，主密钥从不离开设备，服务端解不开。
 */
export async function handleSetWrappedKey(
  request: Request,
  env: Env,
  accountId: string,
  channelId: string,
): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  const channel = await requireChannel(env, auth, channelId, false);
  if (channel instanceof Response) return channel;
  const body = await readJSON(request);
  const wrapped = typeof body.wrapped === "string" ? body.wrapped : "";
  if (!WRAPPED_RE.test(wrapped)) return fail(400, "wrapped 格式不对");
  auth.wrappedKeys = { ...(auth.wrappedKeys ?? {}), [channel.id]: wrapped };
  await putAccount(env, auth);
  return ok(await accountView(env, auth));
}

/** DELETE /account/{id}/keys/{cid} */
export async function handleRemoveWrappedKey(
  request: Request,
  env: Env,
  accountId: string,
  channelId: string,
): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  if (auth.wrappedKeys) delete auth.wrappedKeys[channelId];
  await putAccount(env, auth);
  return ok(await accountView(env, auth));
}

/** POST /account/{id}/devices —— 换手机时新机加入同一账号，通道全部保留 */
export async function handleAddDevice(
  request: Request,
  env: Env,
  accountId: string,
): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  const device = parseDevice(await readJSON(request));
  if (typeof device === "string") return fail(400, device);
  upsertDevice(auth, device);
  await putAccount(env, auth);
  return ok(await accountView(env, auth));
}

export async function handleRemoveDevice(
  request: Request,
  env: Env,
  accountId: string,
  token: string,
): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  // App 手里只有 12 位前缀 —— 完整 token 从不回给客户端（见 accountView）。
  // 原先这里只认完整 token，App 里删设备永远是 404，删不掉。
  const matches = auth.devices.filter(
    (d) => d.token === token || (token.length >= 12 && d.token.startsWith(token)),
  );
  if (matches.length === 0) return fail(404, "这台设备不在账号里");
  if (matches.length > 1) return fail(400, "这个前缀对应了不止一台设备，请给出完整 token");
  auth.devices = auth.devices.filter((d) => d !== matches[0]);
  await putAccount(env, auth);
  return ok(await accountView(env, auth));
}

// ── 通道 ────────────────────────────────────────────────────────────

export async function handleAddChannel(
  request: Request,
  env: Env,
  accountId: string,
): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  if (auth.channelIds.length >= MAX_CHANNELS) {
    return fail(400, `一个账号最多 ${MAX_CHANNELS} 个通道`);
  }
  const body = await readJSON(request);
  // 建群时 App 先请人确认使用条款。记在账号上，随建通道那一次写入落盘
  acceptTerms(auth, body);
  const channel = await addChannel(
    env,
    auth,
    String(body.name ?? "").slice(0, 40),
    body.icon ? String(body.icon).slice(0, 40) : undefined,
    body.group === true,
  );
  return ok({ channel: channelView(channel, auth.id) });
}

/** PATCH /account/{id}/channels/{cid} —— 仅创建者 */
export async function handleUpdateChannel(
  request: Request,
  env: Env,
  accountId: string,
  channelId: string,
): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  const channel = await requireChannel(env, auth, channelId, true);
  if (channel instanceof Response) return channel;

  const body = await readJSON(request);
  if (typeof body.name === "string") {
    channel.name = body.name.trim().slice(0, 40) || channel.name;
  }
  if (typeof body.icon === "string") channel.icon = body.icon.slice(0, 40);
  // 把已有的通道设为群组 / 取消。只收布尔：只影响 App 把它放在哪、怎么显示，不改任何权限
  if (typeof body.group === "boolean") {
    if (body.group) channel.group = true;
    else delete channel.group;
  }
  if (body.defaults && typeof body.defaults === "object") {
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.defaults as Record<string, unknown>)) {
      // 只收推送参数认识的名字，否则默认值就成了往 payload 里夹带任意字段的后门
      if (!DEFAULT_KEYS.has(k)) continue;
      if (v === null || v === undefined || v === "") continue;
      cleaned[k] = String(v).slice(0, 200);
    }
    channel.defaults = cleaned;
  }
  if ("policy" in body) {
    // 显式传 null 表示清空，传对象表示替换 —— 不做深合并，
    // 否则用户没法把已经设过的免打扰时段取消掉。
    const policy = parsePolicy(body.policy);
    channel.policy = Object.keys(policy).length > 0 ? policy : undefined;
  }
  await putChannel(env, channel);
  // 设为群组时 App 先请人确认使用条款
  if (acceptTerms(auth, body)) await putAccount(env, auth);
  return ok(await accountView(env, auth));
}

/**
 * DELETE /account/{id}/channels/{cid}
 *
 * 对创建者是「删除通道」—— 所有成员一起失去它，地址立即失效；
 * 对成员是「退出」—— 只影响自己。同一个动作「把它从我的列表里拿掉」，
 * 按身份落到不同的后果，App 里会给两种截然不同的确认提示。
 */
export async function handleRemoveChannel(
  request: Request,
  env: Env,
  accountId: string,
  channelId: string,
): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  const channel = await requireChannel(env, auth, channelId, false);
  if (channel instanceof Response) return channel;

  if (roleOf(channel, auth.id) === "member") {
    await leaveChannel(env, channel, auth);
    return ok({ left: true, ...(await accountView(env, auth)) });
  }

  // 留一个自己名下的通道，否则用户会把自己删到没有任何可用地址
  const owned = (await listChannels(env, auth)).filter((c) => c.ownerId === auth.id);
  if (owned.length <= 1) return fail(400, "至少要保留一个自己创建的通道");

  await deleteChannel(env, channel);
  // 邀请索引和禁入名单随通道一起删。地址已经失效了，这一步失败只留下一条没人读的记录
  await forgetGroup(env, channel.id).catch(() => {});
  // deleteChannel 改的是存储里的账号，内存里这份 auth 已经过时了，重读一次
  const fresh = (await getAccount(env, auth.id)) ?? auth;
  return ok({ deleted: true, ...(await accountView(env, fresh)) });
}

/** POST /account/{id}/channels/{cid}/key —— 换 key，旧地址立即作废。仅创建者 */
export async function handleRotateKey(
  request: Request,
  env: Env,
  accountId: string,
  channelId: string,
): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  const channel = await requireChannel(env, auth, channelId, true);
  if (channel instanceof Response) return channel;
  return ok({ key: await rotateKey(env, channel) });
}

// ── 群组 ────────────────────────────────────────────────────────────

/** POST /account/{id}/channels/{cid}/invites —— 生成邀请码。仅创建者 */
export async function handleCreateInvite(
  request: Request,
  env: Env,
  accountId: string,
  channelId: string,
): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  const channel = await requireChannel(env, auth, channelId, true);
  if (channel instanceof Response) return channel;
  const suspended = suspensionRejection(channel);
  if (suspended) return fail(403, suspended);
  if (channel.memberIds.length >= MAX_MEMBERS) {
    return fail(400, `群组最多 ${MAX_MEMBERS + 1} 人`);
  }
  // 第一次生成邀请之前 App 先请人确认使用条款
  if (acceptTerms(auth, await readJSON(request))) await putAccount(env, auth);
  const invite = await createInvite(env, channel, auth.id);
  // 记进索引，之后才列得出、撤得掉
  await recordInvite(env, invite);
  return ok({
    code: invite.code,
    expires_at: invite.expiresAt,
    // 发到聊天软件里用网页链接：pigeon:// 在飞书、微信里不会变成可点的链接
    link: `${new URL(request.url).origin}/i/${invite.code}`,
    app_link: `pigeon://invite?c=${invite.code}`,
  });
}

/**
 * GET /account/{id}/channels/{cid}/invites —— 还有效的邀请，按生成先后。仅创建者。
 * 上线这个功能之前生成的邀请不在索引里，列不出来；「全部作废」照样能让它们失效
 */
export async function handleListInvites(
  request: Request,
  env: Env,
  accountId: string,
  channelId: string,
): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  const channel = await requireChannel(env, auth, channelId, true);
  if (channel instanceof Response) return channel;
  const invites = liveInvites(await getGroupState(env, channel.id));
  return ok({
    invites: invites.map((i) => ({ code: i.code, expires_at: i.expiresAt, created_at: i.createdAt })),
  });
}

/**
 * DELETE /account/{id}/channels/{cid}/invites/{code} —— 作废一个邀请码。仅创建者。
 * 邀请链接转到了不该去的地方，群主不必删掉整个群（连带所有集成一起失效）才能止损
 */
export async function handleRevokeInvite(
  request: Request,
  env: Env,
  accountId: string,
  channelId: string,
  code: string,
): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  const channel = await requireChannel(env, auth, channelId, true);
  if (channel instanceof Response) return channel;
  const revoked = await revokeInvite(env, channel.id, code);
  if (!revoked) return fail(404, "没有这个邀请码，或者它已经失效了");
  return ok({ revoked });
}

/** DELETE /account/{id}/channels/{cid}/invites —— 作废这个群的全部邀请。仅创建者 */
export async function handleRevokeAllInvites(
  request: Request,
  env: Env,
  accountId: string,
  channelId: string,
): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  const channel = await requireChannel(env, auth, channelId, true);
  if (channel instanceof Response) return channel;
  const state = await getGroupState(env, channel.id);
  const revoked = await revokeAllInvites(env, state);
  await saveGroupState(env, channel.id, state);
  return ok({ revoked });
}

/** GET /account/{id}/channels/{cid}/members —— 仅创建者 */
export async function handleListMembers(
  request: Request,
  env: Env,
  accountId: string,
  channelId: string,
): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  const channel = await requireChannel(env, auth, channelId, true);
  if (channel instanceof Response) return channel;

  const state = await getGroupState(env, channel.id);
  const [members, banned] = await Promise.all([
    Promise.all(channel.memberIds.map((id) => getAccount(env, id))),
    Promise.all((state.banned ?? []).map((id) => getAccount(env, id))),
  ]);
  return ok({
    members: members
      .filter((m): m is Account => m !== null)
      .map((m) => ({
        account_id: m.id,
        name: displayName(m),
        devices: m.devices.map((d) => d.name),
      })),
    // 禁入名单只存账号 id，名字现查：改过名的显示新名字，注销了的自然消失（反正也进不来了）
    banned: banned
      .filter((m): m is Account => m !== null)
      .map((m) => ({ account_id: m.id, name: displayName(m) })),
  });
}

/** query 里的开关：1 / true / yes 算打开 */
function flag(url: URL, name: string): boolean {
  return ["1", "true", "yes"].includes((url.searchParams.get(name) ?? "").toLowerCase());
}

/**
 * DELETE /account/{id}/channels/{cid}/members/{mid}?revoke_invites=1&ban=1 —— 仅创建者
 *
 * 只移除的话，对方凭手里的邀请链接马上就能回来。两个开关补上这个口子：
 * revoke_invites 作废这个群现有的全部邀请，ban 让这个人以后凭任何邀请都进不来。
 * 两样先落盘、再移除：移除到一半失败，至少人已经回不来了，群主重试一次就好
 */
export async function handleRemoveMember(
  request: Request,
  env: Env,
  accountId: string,
  channelId: string,
  memberId: string,
): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  const channel = await requireChannel(env, auth, channelId, true);
  if (channel instanceof Response) return channel;
  if (!channel.memberIds.includes(memberId)) return fail(404, "这个人不在群组里");

  const url = new URL(request.url);
  const banning = flag(url, "ban");
  const revoking = flag(url, "revoke_invites");
  let revokedInvites = 0;
  if (banning || revoking) {
    const state = await getGroupState(env, channel.id);
    if (banning) ban(state, memberId);
    if (revoking) revokedInvites = await revokeAllInvites(env, state);
    await saveGroupState(env, channel.id, state);
  }
  if (!(await removeMember(env, channel, memberId))) return fail(404, "这个人不在群组里");
  return ok({
    removed: memberId,
    member_count: channel.memberIds.length + 1,
    revoked_invites: revokedInvites,
    banned: banning,
  });
}

/** DELETE /account/{id}/channels/{cid}/bans/{mid} —— 解除禁入，对方又能凭邀请加入。仅创建者 */
export async function handleUnban(
  request: Request,
  env: Env,
  accountId: string,
  channelId: string,
  memberId: string,
): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  const channel = await requireChannel(env, auth, channelId, true);
  if (channel instanceof Response) return channel;
  const state = await getGroupState(env, channel.id);
  if (!unban(state, memberId)) return fail(404, "这个人不在禁入名单里");
  await saveGroupState(env, channel.id, state);
  return ok({ unbanned: memberId });
}

/**
 * 预览、加入、网页邀请页共用一个按 IP 的计数（invite:{ip}）：邀请码只有 8 位，
 * 不限的话就能拿脚本成批地撞别人的群
 */
function tooManyInviteTries(): Response {
  return tooMany("打开邀请太频繁了，请过一分钟再试");
}

/**
 * GET /account/{id}/invites/{code} —— 加入之前先看看是什么群。
 *
 * App 收到邀请链接不会直接加入，而是先给用户看群名、人数，确认了再加 ——
 * 否则任何人发一个链接，点一下就被拉进陌生群里收推送。
 */
export async function handlePreviewInvite(
  request: Request,
  env: Env,
  accountId: string,
  code: string,
): Promise<Response> {
  if (!(await allowIp(env.RL_IP, request, "invite"))) return tooManyInviteTries();
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  const opened = await openInvite(env, code);
  if (!opened) return fail(404, "邀请码不存在或已过期");
  const { invite, state } = opened;
  const channel = await getChannel(env, invite.channelId);
  if (!channel) return fail(404, "这个群组已经被删除了");
  const suspended = suspensionRejection(channel);
  if (suspended) return fail(403, suspended);
  const owner = await getAccount(env, channel.ownerId);
  return ok({
    code: invite.code,
    expires_at: invite.expiresAt,
    channel: {
      id: channel.id,
      name: channel.name,
      icon: channel.icon,
      member_count: channel.memberIds.length + 1,
    },
    // 群主是谁：只凭群名，很难判断这个邀请是不是认识的人发来的
    ...(owner ? { owner_name: displayName(owner) } : {}),
    // 已经在群里了就直接告诉 App，不必再让用户确认一遍
    role: roleOf(channel, auth.id),
    // 屏蔽了群主的人照样看得到是什么群 —— App 据此说清「为什么进不去」，而不是甩一个报错
    ...(isBlocked(auth, channel.ownerId) ? { blocked: true } : {}),
    // 被群主移出并禁止再加入的人，同理
    ...(isBanned(state, auth.id) ? { banned: true } : {}),
  });
}

/**
 * POST /account/{id}/channels/{cid}/ack —— 认领一条消息：群里是「我来处理」，
 * 个人通道上是重复提醒的「知道了，别再提醒」。两种都会停掉这条消息的重复提醒。
 *
 * 第一个认领的人会被广播给群里所有人（见 announceAck）；后来者只得到
 * 「谁已经在处理」的回答，不再广播 —— 两个人前后脚点下去不该再吵一遍。
 */
export async function handleAck(
  request: Request,
  env: Env,
  accountId: string,
  channelId: string,
): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  // 第一个认领会给全群广播一条推送。按账号限流：挡住拿脚本刷广播的成员
  if (!(await allow(env.RL_ACCOUNT, `ack:${auth.id}`))) {
    return tooMany("认领太频繁了，请过一分钟再试");
  }
  const channel = await requireChannel(env, auth, channelId, false);
  if (channel instanceof Response) return channel;
  const suspended = suspensionRejection(channel);
  if (suspended) return fail(403, suspended);

  const body = await readJSON(request);
  const messageId = typeof body.message_id === "string" ? body.message_id : "";
  if (!messageId || messageId.length > 64 || /[\u0000-\u001f]/.test(messageId)) {
    return fail(400, "message_id 格式不对");
  }
  // 旧版 App 还会传 title（原消息的标题；加密消息则是解密后的明文）—— 一律不读，见 announceAck

  // 认领凭据：推送时随消息下发的 ack_sig，证明这个 id 真是从这个通道推出去的（见 groups.ts）。
  // 过渡期：没带的照样放行 —— TestFlight 1.0 (15) 及更早的 App 不认识这个字段。
  // 等旧版本退场，改成必须带
  const sig = body.sig;
  if (sig !== undefined && sig !== null && sig !== "") {
    if (typeof sig !== "string" || !(await ackSigValid(env, channel.id, messageId, sig))) {
      return fail(403, "认领凭据不对，请更新 App 后再试");
    }
  }

  const { record, first } = await claimAck(env, channel.id, messageId, auth);
  if (!first) {
    return ok({ acked_by: record.name, first: false, mine: record.accountId === auth.id });
  }
  // 有人接手了，重复提醒到此为止。先撤提醒再广播：广播出了岔子，提醒也已经停了
  await cancelRepeat(env, channel.id, messageId);
  const report = await announceAck(
    env, channel, await recipientsOf(env, channel), messageId, record.name,
  );
  return ok({ acked_by: record.name, first: true, mine: true, delivered: report.delivered });
}

/**
 * 有人凭邀请加入了：告诉群主。邀请链接常被转到别处，没有这一条，群主只能自己留意人数变化。
 *
 * passive：知会一声，不响、不亮屏；按普通消息进群主的历史。只推给群主一个人，
 * 所以用普通的 category —— 不带「我来处理」，这条通知没有什么可接手的。
 * 推不出去不影响加入本身。
 */
async function notifyOwnerOfJoin(env: Env, channel: Channel, member: Account): Promise<void> {
  try {
    const owner = await getAccount(env, channel.ownerId);
    if (!owner || owner.devices.length === 0) return;
    const params: PushParams = {
      title: channel.name,
      body: `${displayName(member)} 加入了群组`,
      level: "passive",
      id: newId(),
    };
    const payload = buildPayload(params, env.APNS_CATEGORY || "pigeonNotification", {
      id: channel.id,
      name: channel.name,
    });
    payload.sent_at = Date.now();
    const headers = pushHeaders(params);
    await Promise.all(owner.devices.map((device) => pushToDevice(env, device, payload, headers)));
  } catch {
    // 见上
  }
}

/** POST /account/{id}/invites/{code} —— 凭邀请码加入群组 */
export async function handleJoinInvite(
  request: Request,
  env: Env,
  accountId: string,
  code: string,
): Promise<Response> {
  if (!(await allowIp(env.RL_IP, request, "invite"))) return tooManyInviteTries();
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  const opened = await openInvite(env, code);
  if (!opened) return fail(404, "邀请码不存在或已过期");
  const { invite, state } = opened;
  const channel = await getChannel(env, invite.channelId);
  if (!channel) return fail(404, "这个群组已经被删除了");
  const suspended = suspensionRejection(channel);
  if (suspended) return fail(403, suspended);
  if (isBlocked(auth, channel.ownerId)) {
    return fail(403, "你屏蔽了这个群的创建者。要加入，请先在「设置 → 已屏蔽」里解除");
  }
  if (isBanned(state, auth.id)) {
    return fail(403, "群主已把你移出这个群，不能再用邀请加入");
  }

  const result = await joinChannel(env, channel, auth);
  if (result === "full") return fail(400, "群组已满");
  if (result === "joined") await notifyOwnerOfJoin(env, channel, auth);
  return ok({
    result,
    channel: channelView(channel, auth.id),
    ...(await accountView(env, auth)),
  });
}

// ── 举报与屏蔽 ──────────────────────────────────────────────────────

const REPORT_REASON_KEYS = Object.keys(REPORT_REASONS);
/** 补充说明截到这么长。够说清一件事，又不至于成了往服务端存大段文字的口子 */
const MAX_REPORT_DETAIL = 500;
/** 附上的消息原文截到这么长 —— 审核看得出是什么就够了 */
const MAX_REPORT_EXCERPT = 1000;

/** message_id：可选；给了就得像个 id（和认领同一套规则）。格式不对返回 null */
function readMessageId(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || raw.length > 64) return null;
  // 控制字符（码位小于 32）不该出现在 id 里
  for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) < 32) return null;
  return raw;
}

/**
 * POST /account/{id}/channels/{cid}/report —— 举报这个群组，或其中的一条消息。仅成员。
 *
 * 群里的内容来自群主的系统，成员删不掉也拦不住 —— 举报是 App Store 对这类内容的硬性要求，
 * 也是成员唯一能让违规内容停下来的途径。加密消息服务端看不到，所以允许举报人附上原文。
 * 超长的文字截断收下而不是报错：App 按字形计数，服务端按 UTF-16 计数，两边永远对不齐。
 */
export async function handleReport(
  request: Request,
  env: Env,
  accountId: string,
  channelId: string,
): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  const channel = await requireChannel(env, auth, channelId, false);
  if (channel instanceof Response) return channel;
  if (roleOf(channel, auth.id) !== "member") {
    return fail(400, "这是你自己创建的通道 —— 不想要它，可以直接删除");
  }

  const body = await readJSON(request);
  const reason = typeof body.reason === "string" ? body.reason : "";
  if (!REPORT_REASON_KEYS.includes(reason)) {
    return fail(400, `reason 只能是 ${REPORT_REASON_KEYS.join(" / ")}`);
  }
  const messageId = readMessageId(body.message_id);
  if (messageId === null) return fail(400, "message_id 格式不对");
  const detail = typeof body.detail === "string" ? body.detail.trim().slice(0, MAX_REPORT_DETAIL) : "";
  const excerpt = typeof body.excerpt === "string" ? body.excerpt.trim().slice(0, MAX_REPORT_EXCERPT) : "";

  // 额度在参数都合格之后才占：填错了重交，不该把次数耗掉
  const wait = await takeReportQuota(env, auth.id);
  if (wait) return tooMany(`举报太频繁了：每小时最多 ${REPORTS_PER_HOUR} 次，请稍后再试`, wait);

  const report = await fileReport(env, channel, auth, {
    reason,
    messageId,
    detail: detail || undefined,
    excerpt: excerpt || undefined,
  });
  await notifyModerators(env, report);
  return ok({ reported: true });
}

/**
 * 举报推给运营者设定的审核通道（npm run mod -- inbox）。没设就只落盘。
 * 同一个群 10 分钟内只推第一条，其余合并进下一次通知（见 moderatorNotice）。
 * 失败一律吞掉：举报已经记下了，不能因为通知没发出去就告诉举报人「提交失败」。
 */
async function notifyModerators(env: Env, report: Report): Promise<void> {
  try {
    const inboxId = await getModChannelId(env);
    if (!inboxId) return;
    const inbox = await getChannel(env, inboxId);
    // 审核通道要求端到端加密的话，服务端没法替它加密，只能不发
    if (!inbox || inbox.suspended || inbox.policy?.e2eOnly) return;
    const held = await moderatorNotice(env, report.channelId);
    if (held === null) return;
    const reasonLine = `${REPORT_REASONS[report.reason] ?? report.reason}${report.detail ? `：${report.detail}` : ""}`;
    const lines = [
      reasonLine,
      report.excerpt ? `附上的内容：${report.excerpt.slice(0, 200)}` : "",
      held > 0 ? `上次通知之后又收到 ${held} 条` : "",
      `通道 ${report.channelId}`,
    ].filter(Boolean);
    await deliver(env, inbox, await recipientsOf(env, inbox), {
      title: `举报 · ${report.channelName}`,
      body: lines.join(" · "),
      level: "timeSensitive",
      tags: "rotating_light",
      group: "moderation",
    });
  } catch {
    // 见上
  }
}

/**
 * POST /account/{id}/channels/{cid}/block —— 屏蔽群主。仅成员。
 *
 * 屏蔽 = 立即退出这个群 + 拒收此人之后的一切邀请。只退群不够：对方换个群再发一个邀请，
 * 被骚扰的人又得再点一次「退出」。
 */
export async function handleBlock(
  request: Request,
  env: Env,
  accountId: string,
  channelId: string,
): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  const channel = await requireChannel(env, auth, channelId, false);
  if (channel instanceof Response) return channel;
  if (roleOf(channel, auth.id) !== "member") return fail(400, "不能屏蔽你自己");
  const owner = await getAccount(env, channel.ownerId);
  // 先记下屏蔽再退群：退群那一步会写回账号，屏蔽名单随之落盘，少一次写入
  blockOwner(auth, channel.ownerId, owner ? displayName(owner) : "已注销的用户");
  await leaveChannel(env, channel, auth);
  return ok({ left: true, ...(await accountView(env, auth)) });
}

/** DELETE /account/{id}/blocked/{ownerId} —— 解除屏蔽 */
export async function handleUnblock(
  request: Request,
  env: Env,
  accountId: string,
  ownerId: string,
): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  if (!unblockOwner(auth, ownerId)) return fail(404, "屏蔽名单里没有这个人");
  await putAccount(env, auth);
  return ok(await accountView(env, auth));
}

// ── 网站监控 ────────────────────────────────────────────────────────

/**
 * 心跳的报到地址按请求自己的来源拼：从备用的 workers.dev 入口进来的，拿到的也是那个域名下的地址。
 * 只回给创建者 —— 这个地址就是凭据，拿到它就能替任务报平安。
 */
function watchView(watch: Watch, origin: string) {
  const pingUrl = watch.kind === "heartbeat" ? `${origin}/hb/${watch.id}` : undefined;
  return {
    id: watch.id,
    channel_id: watch.channelId,
    kind: watch.kind,
    // 心跳没有要抓的网址。按网址监控的写法把 url 当必填来解析的 App 版本，给它报到地址，列表不至于整个解析失败
    url: watch.url ?? pingUrl,
    keyword: watch.keyword,
    present: watch.present,
    interval_minutes: watch.intervalMinutes,
    name: watch.name,
    last_status: watch.lastStatus,
    last_checked_at: watch.lastCheckedAt,
    ...(pingUrl
      ? { ping_url: pingUrl, grace_minutes: watch.graceMinutes, last_ping_at: watch.lastPingAt }
      : {}),
  };
}

/** GET /account/{id}/watches —— 我建的全部监控 */
export async function handleListWatches(request: Request, env: Env, accountId: string): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  const watches = await listWatches(env, auth.id);
  const origin = new URL(request.url).origin;
  return ok({ watches: watches.map((w) => watchView(w, origin)) });
}

/** POST /account/{id}/watches —— 新建一个监控（掉线 / 关键词 / 心跳）。通道必须是自己创建的 */
export async function handleCreateWatch(request: Request, env: Env, accountId: string): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  const existing = await listWatches(env, auth.id);
  if (existing.length >= MAX_WATCHES) return fail(400, `最多同时监控 ${MAX_WATCHES} 个`);

  const parsed = parseWatchInput(await readJSON(request));
  if (typeof parsed === "string") return fail(400, parsed);

  const channel = await requireChannel(env, auth, parsed.channelId, true);
  if (channel instanceof Response) return channel;

  const watch = await createWatch(env, auth.id, parsed);
  return ok({ watch: watchView(watch, new URL(request.url).origin) });
}

/** DELETE /account/{id}/watches/{wid} */
export async function handleDeleteWatch(request: Request, env: Env, accountId: string, watchId: string): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  const watch = await getWatch(env, watchId);
  if (!watch || watch.ownerId !== auth.id) return fail(404, "没有这个监控");
  await deleteWatch(env, watchId);
  return ok({ deleted: true });
}
