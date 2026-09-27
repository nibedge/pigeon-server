import { explainFailure, isDeadToken, pushToDevice, type ApnsHeaders } from "../apns";
import { getChannel, isAcked, isMuted, isValidId, listChannels, markDeadTokens, newId, roleOf } from "../db";
import { PROBE_HEADERS, PROBE_PAYLOAD } from "../guard";
import { isQuietNow, type QuietHours } from "../policy";
import {
  buildPayload,
  deliver,
  MAX_REPEATS_PER_ACCOUNT,
  MAX_REPEATS_PER_CHANNEL,
  REPEAT_MIN_MINUTES,
  type DeliveryReport,
} from "../push";
import { allow } from "../ratelimit";
import { fail, ok, tooMany } from "../respond";
import { alertParams, REMINDER_CRON } from "../watch";
import type { Account, ApnsEnv, Channel, Device, Env, PushResult } from "../types";
import { readJSON, requireAuth } from "./account";

/**
 * 通知体检：POST /account/{id}/selftest。
 *
 * 「设置全开却收不到」是这类 App 差评里的头一号，而用户手里没有任何办法分辨毛病出在哪一段：
 * 本机根本不在账号里、登记的推送环境和 App 对不上、令牌早就失效、Apple 拒收、送到了却被系统收进摘要……
 * 这个接口替 App 把服务端这一侧能查的都查一遍，每台设备给一个 APNs 的原始答复：
 *
 * - 往返测速（默认）：给本机推一条带 nonce 的静默测试通知，NSE 收到后把 nonce 和送达时刻写进 App Group，
 *   App 拿它和发请求的时刻一比，就是「服务器 → 本机」花了多久；同账号的其它设备只发一条后台探测，
 *   看 APNs 还认不认它们的令牌，不打扰人。没给 token_prefix 时（比如拿 curl 来试），每台设备都推测试通知。
 *   顺带列出此刻被压成静默的通道（自己开了免打扰、正在免打扰时段里）。
 * - 告警演练（drill: true）：在一个只有自己的通道上推一条时效性的测试告警，走的是真告警的全套路子 ——
 *   同样的级别、铃声、「知道了，别再提醒」按钮、重复提醒，只是第一次补发提早到约一分钟后、只补一次。
 *   点「知道了」走的就是平常的认领接口；再用 {drill_resolve: id} 推一条「已恢复」收尾。
 *   真告警会碰上的拦路虎（免打扰时段、个人静音、重复提醒满额）演练一样会碰上，响应里逐条说清楚。
 *
 * nonce 记在 selftest:{账号 id}:{nonce}，10 分钟后自动过期。只有时刻和通道 id，不含任何内容。
 */

const SELFTEST = "selftest:";
/** 体检记录留多久。演练在几分钟里就走完，过了这个时候再来收尾的，按「演练已过期」处理 */
const SELFTEST_TTL_SECONDS = 10 * 60;
/** 演练的第一次补发：推出去一分钟之后的那一轮重复提醒巡检 */
const DRILL_FIRST_REMINDER_MS = 60_000;
/**
 * 演练的提醒截止：第一次补发之后不到一个间隔。补完一次，下一次就落在截止之后，提醒随之结束 ——
 * 真告警要响满一小时，演练只要看一眼「第 2 次提醒」长什么样
 */
const DRILL_WINDOW_MS = (REPEAT_MIN_MINUTES - 1) * 60_000;
/** 每台设备最多等 APNs 这么久。体检是给人看的，页面不能转上半分钟 */
const PUSH_TIMEOUT_MS = 8_000;
/** 往返测速的通知都用这一个折叠标识：连点几次，通知中心里也只留最新的一条 */
const ROUNDTRIP_COLLAPSE_ID = "pigeon-selftest";

interface SelftestRecord {
  kind: "roundtrip" | "drill";
  sentAt: number;
  expiresAt: number;
  /** 演练推到的通道。演练那条消息的 id 就是 nonce */
  channelId?: string;
  resolvedAt?: number;
}

/** 响应里的一台设备。status 是 APNs 的 HTTP 状态码（200 = 收下了），失败时带 APNs 的原始 reason */
interface DeviceCheck {
  token_prefix: string;
  name: string;
  environment: ApnsEnv;
  /** alert = 推了测试通知；probe = 只发了后台探测，看令牌还认不认 */
  kind: "alert" | "probe";
  status: number;
  reason?: string;
  this_device?: true;
}

/** 查出来的毛病。code 给 App 挑修复按钮，message 直接给人看 */
interface Problem {
  code:
    | "not_registered"
    | "environment_mismatch"
    | "device_invalid"
    | "push_failed"
    | "repeat_skipped"
    | "quiet_hours"
    | "muted"
    | "min_level"
    | "no_devices";
  message: string;
  token_prefix?: string;
}

function recordKey(accountId: string, nonce: string): string {
  return `${SELFTEST}${accountId}:${nonce}`;
}

async function readRecord(env: Env, accountId: string, nonce: string): Promise<SelftestRecord | null> {
  return env.PIGEON_KV.get<SelftestRecord>(recordKey(accountId, nonce), "json");
}

async function writeRecord(env: Env, accountId: string, nonce: string, record: SelftestRecord): Promise<void> {
  // KV 的过期时刻至少要在 60 秒之后；收尾时离截止已经不到一分钟的，就再留一分钟
  const expiration = Math.max(Math.floor(record.expiresAt / 1000), Math.ceil(Date.now() / 1000) + 60);
  await env.PIGEON_KV.put(recordKey(accountId, nonce), JSON.stringify(record), { expiration });
}

function environmentName(env: ApnsEnv): string {
  return env === "sandbox" ? "开发环境（sandbox）" : "正式环境";
}

/** App 手里是自己的完整令牌，也可能只交前 12 位（账号快照里给的就是前 12 位） */
function findDevice(account: Account, prefix: string): Device | null {
  return account.devices.find((d) => d.token === prefix) ?? account.devices.find((d) => d.token.startsWith(prefix)) ?? null;
}

/** 推一台设备，最多等 PUSH_TIMEOUT_MS。等不到按 504 记：和 Apple 那边出错一个说法 */
async function pushTimed(
  env: Env,
  device: Device,
  payload: unknown,
  headers: ApnsHeaders,
): Promise<PushResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<PushResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ deviceToken: device.token, env: device.env, status: 504, reason: `等了 ${PUSH_TIMEOUT_MS / 1000} 秒 APNs 还没回应` }),
      PUSH_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([pushToDevice(env, device, payload, headers), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 每台设备的结果，外加失败的那几台各一条说明 */
function checksOf(
  account: Account,
  results: { result: PushResult; kind: DeviceCheck["kind"] }[],
  thisDevice: Device | null,
): { devices: DeviceCheck[]; problems: Problem[] } {
  const devices: DeviceCheck[] = [];
  const problems: Problem[] = [];
  for (const { result, kind } of results) {
    const device = account.devices.find((d) => d.token === result.deviceToken);
    const prefix = result.deviceToken.slice(0, 12);
    const name = device?.name ?? "未命名设备";
    devices.push({
      token_prefix: prefix,
      name,
      environment: result.env,
      kind,
      status: result.status,
      ...(result.status !== 200 && result.reason ? { reason: result.reason } : {}),
      ...(thisDevice && thisDevice.token === result.deviceToken ? { this_device: true as const } : {}),
    });
    if (result.status === 200) continue;
    problems.push(
      isDeadToken(result)
        ? {
            code: "device_invalid",
            message: `「${name}」的推送令牌已失效（App 被删除、重装过，或者推送环境登记错了），之后不再推给它。在那台设备上打开一次 App 就会重新登记`,
            token_prefix: prefix,
          }
        : { code: "push_failed", message: `「${name}」${explainFailure(result).message}`, token_prefix: prefix },
    );
  }
  return { devices, problems };
}

/** 本机的登记情况：在不在账号里、登记的推送环境和 App 实际用的对不对得上 */
function checkThisDevice(
  prefix: string,
  device: Device | null,
  declared: ApnsEnv | undefined,
): { view: Record<string, unknown>; problems: Problem[] } {
  if (!device) {
    return {
      view: { token_prefix: prefix.slice(0, 12), registered: false },
      problems: [{
        code: "not_registered",
        message: "这台设备不在账号里，推送到不了这里：可能在别的设备上被移除了，或者 App 还没来得及登记",
        token_prefix: prefix.slice(0, 12),
      }],
    };
  }
  const matches = declared === undefined ? undefined : declared === device.env;
  const problems: Problem[] = matches === false
    ? [{
        code: "environment_mismatch",
        message: `这台设备登记的是${environmentName(device.env)}，App 实际用的是${environmentName(declared as ApnsEnv)}：Apple 会拒收发给它的推送。重新登记一次本机就好`,
        token_prefix: device.token.slice(0, 12),
      }]
    : [];
  return {
    view: {
      token_prefix: device.token.slice(0, 12),
      registered: true,
      name: device.name,
      environment: device.env,
      ...(matches === undefined ? {} : { environment_matches: matches }),
    },
    problems,
  };
}

/**
 * 重复提醒巡检下一次在什么时候跑（毫秒）：不早于 after 的第一个整分钟，分钟数合上 wrangler.toml 里
 * 那条 cron（REMINDER_CRON，现在是「2-59/5」：每小时的 2、7、12…分）。给 App 显示「第 2 次提醒约在几点几分」。
 * cron 的写法认不出来时按每 5 分钟、从 0 分起算，只是估得粗一点
 */
export function nextReminderRun(after: number, cron: string = REMINDER_CRON): number {
  const match = /^(\*|\d+)(?:-\d+)?\/(\d+)\s/.exec(cron);
  const start = match && match[1] !== "*" ? Number(match[1]) : 0;
  const step = match ? Number(match[2]) : 5;
  let t = Math.ceil(after / 60_000) * 60_000;
  for (let i = 0; i < 60; i++, t += 60_000) {
    const minute = new Date(t).getUTCMinutes();
    if (minute >= start && (minute - start) % step === 0) return t;
  }
  return t;
}

/**
 * 演练用哪个通道：指定了就用指定的，没指定就挑第一个只有自己、没停用、不要求加密的。
 *
 * 只能是只有自己的通道：演练的提醒几分钟后由巡检补发，补发推给通道里的每一个人 —— 在群里演练，
 * 全群都会被吵一遍。只收加密的通道也不行：演练的内容由服务端生成、只能是明文（和监控一个道理）
 */
async function drillChannel(env: Env, account: Account, requested: unknown): Promise<Channel | Response> {
  const usable = (channel: Channel | null): channel is Channel =>
    channel !== null && roleOf(channel, account.id) === "owner";
  if (requested !== undefined && requested !== null && requested !== "") {
    const id = typeof requested === "string" ? requested : "";
    if (!isValidId(id)) return fail(400, "channel_id 格式不对");
    const channel = await getChannel(env, id);
    // 不存在和不是自己的回同一个 404，和别的通道接口一样
    if (!usable(channel)) return fail(404, "没有这个通道");
    if (channel.suspended) return fail(403, "这个通道已被停用，不能演练");
    if (channel.memberIds.length > 0) {
      return fail(400, "演练几分钟后会再提醒一次，群里每个人都会收到。请选一个只有你自己的通道");
    }
    if (channel.policy?.e2eOnly) {
      return fail(400, "这个通道只收加密消息，而演练的提醒由服务端生成、只能是明文。请换一个通道");
    }
    return channel;
  }
  // 按账号里的顺序一个个读，找到就停：头一个通常就是注册时建的那个个人通道
  for (const id of account.channelIds) {
    const channel = await getChannel(env, id);
    if (usable(channel) && !channel.suspended && channel.memberIds.length === 0 && !channel.policy?.e2eOnly) {
      return channel;
    }
  }
  return fail(400, "没有可以演练的通道：演练要在一个只有你自己、不要求加密的通道上做。先建一个通道再试");
}

/**
 * 此刻被压成静默的一个通道。muted_until：自己开的免打扰到几点（毫秒，0 = 一直）；quiet_hours：通道的免打扰时段；
 * min_level：自己给这个通道设的最低提醒级别（只列 timeSensitive、critical —— 普通消息在这两档下都静默送达）
 */
interface SilencedChannel {
  channel_id: string;
  name: string;
  muted_until?: number;
  quiet_hours?: QuietHours;
  min_level?: "timeSensitive" | "critical";
}

/** 最低提醒级别高到连普通消息都不响的那两档 */
function loudFloor(account: Account, channelId: string): "timeSensitive" | "critical" | undefined {
  const floor = account.prefs?.minLevel?.[channelId];
  return floor === "timeSensitive" || floor === "critical" ? floor : undefined;
}

/**
 * 此刻被压成静默的通道：自己开了免打扰的、正在通道免打扰时段里的、自己设了最低提醒级别让普通消息不响的。
 * 这些通道的消息照常送达，只是不响、不亮屏 —— 「推送是通的，可就是没响」多半是这个。
 * 按服务端投递时同一套规则算（时段按通道设的时区，最低级别见 receivers.ts），和实际推送对得上
 */
async function silencedChannels(env: Env, account: Account, now: number): Promise<SilencedChannel[]> {
  const silenced: SilencedChannel[] = [];
  for (const channel of await listChannels(env, account)) {
    const muted = isMuted(account, channel.id, now);
    const quiet = channel.policy?.quietHours;
    const inQuietHours = Boolean(quiet && isQuietNow(quiet, new Date(now)));
    const floor = loudFloor(account, channel.id);
    if (!muted && !inQuietHours && !floor) continue;
    silenced.push({
      channel_id: channel.id,
      name: channel.name,
      ...(muted ? { muted_until: account.prefs?.mutes?.[channel.id] ?? 0 } : {}),
      ...(inQuietHours && quiet ? { quiet_hours: quiet } : {}),
      ...(floor ? { min_level: floor } : {}),
    });
  }
  return silenced;
}

/** 账号里一台设备都没有（设备全被移除、令牌全失效了）：推什么都到不了任何地方 */
const NO_DEVICES: Problem = {
  code: "no_devices",
  message: "账号里一台能收推送的设备都没有。在手机上重新打开 App，它会自动登记",
};

/** 演练碰上的、真告警也会碰上的事：提醒没排上、免打扰时段、个人静音、自己设的最低提醒级别 */
function drillProblems(account: Account, channel: Channel, report: DeliveryReport, now: number): Problem[] {
  const problems: Problem[] = [];
  if (report.repeatSkipped) {
    const scope = report.repeatSkipped === "channel"
      ? `「${channel.name}」同时在重复提醒的消息已经有 ${MAX_REPEATS_PER_CHANNEL} 条`
      : `你名下同时在重复提醒的消息已经有 ${MAX_REPEATS_PER_ACCOUNT} 条`;
    problems.push({
      code: "repeat_skipped",
      message: `${scope}，这次演练不会再提醒第二次；这时来的真告警也一样只响一次。先点掉几条「知道了」`,
    });
  }
  if (report.quieted) {
    problems.push({
      code: "quiet_hours",
      message: `「${channel.name}」此刻在免打扰时段：真告警这时也会静默送达，不响铃、不亮屏`,
    });
  }
  // report.muted 数的是被压成静默的设备：个人免打扰和最低提醒级别都算在里面（见 receivers.ts），这里分开说
  if (report.muted && isMuted(account, channel.id, now)) {
    problems.push({
      code: "muted",
      message: `你给「${channel.name}」开了免打扰：真告警这时也会静默送达，不响铃、不亮屏`,
    });
  } else if (report.muted && loudFloor(account, channel.id) === "critical") {
    problems.push({
      code: "min_level",
      message: `你给「${channel.name}」设了最低提醒级别「只提醒紧急的」：时效性的告警到你这里静默送达，真告警这时也一样。要它响，在通道设置里把「最低提醒级别」调低`,
    });
  }
  return problems;
}

/** POST /account/{id}/selftest —— 见文件开头 */
export async function handleSelftest(request: Request, env: Env, accountId: string): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  // 每次体检都要推给这个人的每台设备：按账号限流，和认领共用一个绑定、各记各的键
  if (!(await allow(env.RL_ACCOUNT, `selftest:${auth.id}`))) {
    return tooMany("体检太频繁了，请过一分钟再试");
  }
  const body = await readJSON(request);
  // null 当没给：有的客户端把没有的字段写成 null
  if (body.drill_resolve !== undefined && body.drill_resolve !== null) return resolveDrill(env, auth, body.drill_resolve);

  const rawPrefix = body.token_prefix;
  const prefix = typeof rawPrefix === "string" ? rawPrefix.trim() : "";
  if (rawPrefix !== undefined && rawPrefix !== null && !/^[A-Za-z0-9]{12,200}$/.test(prefix)) {
    return fail(400, "token_prefix 应为这台设备推送令牌的前 12 位，或者完整的令牌");
  }
  let declared: ApnsEnv | undefined;
  if (body.environment !== undefined && body.environment !== null) {
    if (body.environment !== "sandbox" && body.environment !== "production") {
      return fail(400, "environment 只能是 sandbox 或 production");
    }
    declared = body.environment;
  }
  const thisDevice = prefix ? findDevice(auth, prefix) : null;
  const self = prefix ? checkThisDevice(prefix, thisDevice, declared) : null;

  if (body.drill === true) return startDrill(env, auth, body.channel_id, thisDevice, self);
  return roundTrip(env, auth, prefix, thisDevice, self);
}

/**
 * 往返测速：给本机推一条带 nonce 的测试通知，其它设备只发后台探测。
 *
 * 测试通知是静默的（passive）、不进历史（isarchive=0，老版 App 也认），有效期 10 分钟：
 * 手机这会儿不在线的，过后也不会冒出来一条早就没人等的测试。优先级照常是 10 —— 量的就是平常的送达速度
 */
async function roundTrip(
  env: Env,
  auth: Account,
  prefix: string,
  thisDevice: Device | null,
  self: ReturnType<typeof checkThisDevice> | null,
): Promise<Response> {
  const nonce = newId();
  const sentAt = Date.now();
  const expiresAt = sentAt + SELFTEST_TTL_SECONDS * 1000;
  try {
    await writeRecord(env, auth.id, nonce, { kind: "roundtrip", sentAt, expiresAt });
  } catch {
    // 往返测速只靠推送本身，记录写不进去不耽误；演练才离不开它
  }

  // 指定了本机：只给本机推通知，本机不在账号里就一台都不推；没指定：每台都推
  const alerts = prefix ? (thisDevice ? [thisDevice] : []) : auth.devices;
  const probes = auth.devices.filter((d) => !alerts.includes(d));
  const payload = buildPayload(
    {
      title: "通知体检",
      body: "看到这条，说明推送是通的。它用来量从服务器到这台设备要多久",
      level: "passive",
      isArchive: "0",
      group: "selftest",
    },
    env.APNS_CATEGORY || "pigeonNotification",
  );
  payload.selftest = nonce;
  payload.sent_at = sentAt;
  const headers: ApnsHeaders = {
    "apns-push-type": "alert",
    "apns-priority": "10",
    "apns-collapse-id": ROUNDTRIP_COLLAPSE_ID,
    "apns-expiration": String(Math.floor(expiresAt / 1000)),
  };
  const [results, silenced] = await Promise.all([
    Promise.all([
      ...alerts.map(async (d) => ({ kind: "alert" as const, result: await pushTimed(env, d, payload, headers) })),
      ...probes.map(async (d) => ({ kind: "probe" as const, result: await pushTimed(env, d, PROBE_PAYLOAD, PROBE_HEADERS) })),
    ]),
    // 读不出通道也不耽误体检本身
    silencedChannels(env, auth, sentAt).catch(() => []),
  ]);
  // 和平常推送一样：APNs 说失效的令牌立墓碑，之后的推送跳过它们
  const dead = results.filter((r) => isDeadToken(r.result)).map((r) => r.result.deviceToken);
  if (dead.length > 0) await markDeadTokens(env, dead);

  const { devices, problems } = checksOf(auth, results, thisDevice);
  return ok({
    nonce,
    sent_at: sentAt,
    expires_at: expiresAt,
    ...(self ? { this_device: self.view } : {}),
    devices,
    delivered: results.filter((r) => r.kind === "alert" && r.result.status === 200).length,
    silenced,
    problems: [...(self?.problems ?? []), ...(auth.devices.length === 0 ? [NO_DEVICES] : []), ...problems],
  });
}

/** 告警演练的第一步：推一条时效性的测试告警，排上约一分钟后的一次补发 */
async function startDrill(
  env: Env,
  auth: Account,
  requestedChannel: unknown,
  thisDevice: Device | null,
  self: ReturnType<typeof checkThisDevice> | null,
): Promise<Response> {
  // 本机不在账号里还演练，响的是别的设备，看着这台手机的人什么也等不到
  if (self && !thisDevice) {
    return fail(409, "这台设备不在账号里，演练推不到这里。先重新登记本机再演练", { this_device: self.view });
  }
  const channel = await drillChannel(env, auth, requestedChannel);
  if (channel instanceof Response) return channel;

  const nonce = newId();
  const sentAt = Date.now();
  const expiresAt = sentAt + SELFTEST_TTL_SECONDS * 1000;
  const firstAt = sentAt + DRILL_FIRST_REMINDER_MS;
  // 先记下再推：收尾（drill_resolve）要靠它认出这次演练
  await writeRecord(env, auth.id, nonce, { kind: "drill", sentAt, expiresAt, channelId: channel.id });

  // 和监控告警同一套叠法（见 watch.ts alertParams）：通道设的铃声、分组这些照用，级别和重复提醒由演练定。
  // 不进历史：演练不是一件真发生过的事，不该留在通道的记录里
  const params = alertParams(channel, {}, {
    title: "告警演练",
    body: "这是一次演练，不是真的告警。约一分钟后会再提醒一次；点「知道了，别再提醒」就停",
    level: "timeSensitive",
    status: "firing",
    id: nonce,
    tags: "rotating_light",
    repeat: String(REPEAT_MIN_MINUTES),
    isArchive: "0",
  });
  const report = await deliver(env, channel, [auth], params, {
    sentAt,
    reminderPlan: { firstAt, until: firstAt + DRILL_WINDOW_MS },
    selftest: nonce,
  });

  const { devices, problems } = checksOf(
    auth,
    report.results.map((result) => ({ kind: "alert" as const, result })),
    thisDevice,
  );
  return ok({
    nonce,
    sent_at: sentAt,
    expires_at: expiresAt,
    ...(self ? { this_device: self.view } : {}),
    devices,
    delivered: report.delivered,
    drill: {
      id: nonce,
      channel_id: channel.id,
      channel_name: channel.name,
      // 排上了才有：一台都没送到、或者提醒满额时不补发
      ...(report.repeat ? { remind_at: nextReminderRun(firstAt), remind_until: report.repeat.until } : {}),
      ...(report.repeatSkipped ? { repeat_skipped: `${report.repeatSkipped}_limit` } : {}),
      ...(report.quieted ? { quieted: true } : {}),
      ...(report.muted ? { muted: report.muted } : {}),
    },
    warnings: report.warnings ?? [],
    problems: [
      ...(self?.problems ?? []),
      ...(auth.devices.length === 0 ? [NO_DEVICES] : []),
      ...drillProblems(auth, channel, report, sentAt),
      ...problems,
    ],
  });
}

/**
 * 告警演练收尾：{drill_resolve: id}。同一个 id 推一条「已恢复」—— 和真告警恢复时一样，
 * 还没补发的提醒随之撤掉、认领也清掉。重复调用不再推，回第一次收尾的时刻
 */
async function resolveDrill(env: Env, auth: Account, raw: unknown): Promise<Response> {
  const id = typeof raw === "string" ? raw : "";
  if (!isValidId(id)) return fail(400, "drill_resolve 应为开始演练时拿到的 id");
  const record = await readRecord(env, auth.id, id);
  if (!record || record.kind !== "drill" || !record.channelId) {
    return fail(404, "没有这次演练：可能已经过了 10 分钟，或者 id 不对");
  }
  if (record.resolvedAt) {
    return ok({ drill: { id, channel_id: record.channelId, resolved_at: record.resolvedAt, already_resolved: true } });
  }

  const now = Date.now();
  const channel = await getChannel(env, record.channelId);
  // 演练期间通道被删了、停用了：提醒随之作废（巡检见通道不在或停用就撤），只把演练记为结束
  if (!channel || roleOf(channel, auth.id) !== "owner" || channel.suspended) {
    await writeRecord(env, auth.id, id, { ...record, resolvedAt: now });
    return ok({ sent_at: now, devices: [], delivered: 0, drill: { id, channel_id: record.channelId, resolved_at: now } });
  }
  // 先看有没有人点过「知道了」：推「已恢复」时认领会被清掉
  const acked = await isAcked(env, channel.id, id).catch(() => false);
  const params = alertParams(channel, {}, {
    title: "演练结束",
    body: "这是演练的「已恢复」。真告警恢复时也是这样收尾",
    level: "active",
    status: "resolved",
    id,
    tags: "white_check_mark",
    isArchive: "0",
  });
  // 只推给自己：通道后来要是加了人，收尾也不该吵到别人
  const report = await deliver(env, channel, [auth], params, { sentAt: now, selftest: id });
  await writeRecord(env, auth.id, id, { ...record, resolvedAt: now });

  const { devices, problems } = checksOf(
    auth,
    report.results.map((result) => ({ kind: "alert" as const, result })),
    null,
  );
  return ok({
    sent_at: now,
    devices,
    delivered: report.delivered,
    drill: { id, channel_id: channel.id, resolved_at: now, acked },
    problems,
  });
}
