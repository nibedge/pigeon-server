import { pushToDevice } from "./apns";
import { getAccount, sha256 } from "./db";
import { allow } from "./ratelimit";
import type { Account, Device, Env, PushResult, RateLimiter } from "./types";

/**
 * 入口防滥用：按来源 IP 限流、登记设备前验明推送令牌、一台设备最多挂几个账号。
 *
 * 建账号不要任何凭据（App 第一次打开就得能用），所以「每个账号最多几个通道、几个监控」这类上限，
 * 只有在账号本身不能随手成批造出来时才算数。这里几道闸门就是为此而设。
 */

/** 本机回环地址。线上的来源不可能是它，只有本地 wrangler dev 会这么填 */
const LOOPBACK = /^(?:127\.|::1$|::ffff:127\.)/;

/**
 * 请求的来源 IP。Cloudflare 在边缘填好，客户端改不了。
 * 拿不到、或者是本机回环地址，只会是本地开发 —— 那就不按 IP 限，免得本地测试彼此挤占额度
 */
export function clientIp(request: Request): string | null {
  const ip = request.headers.get("cf-connecting-ip");
  return ip && !LOOPBACK.test(ip) ? ip : null;
}

/** 按来源 IP 限一次流，放行返回 true。bucket 区分用途（acct、invite），各记各的 */
export async function allowIp(
  limiter: RateLimiter | undefined,
  request: Request,
  bucket: string,
): Promise<boolean> {
  const ip = clientIp(request);
  if (!ip) return true;
  return allow(limiter, `${bucket}:${ip}`);
}

// ── 登记设备 ────────────────────────────────────────────────────────

/** 一台设备最多登记在几个账号里 */
export const MAX_ACCOUNTS_PER_DEVICE = 3;
/**
 * 验令牌的推送最多等这么久。APNs 慢了就放行 ——
 * 宁可放进一个验不了的 token，也不能让真用户卡在建账号这一步
 */
const PROBE_TIMEOUT_MS = 5_000;
/** 索引最多核对最近这么多条。正常只有两三条，多出来的只会是早已移除的旧记录，不值得一条条去读 */
const MAX_CHECKED = 10;
/**
 * 索引最后一次写入一年后过期。它只用来计数：还在用的设备，过期后下次启动 App 静默重新登记时会补回来；
 * 被移出、被删掉的账号则不会在这里挂一辈子
 */
const INDEX_TTL_SECONDS = 365 * 86_400;
const TOKEN_INDEX = "tok:";

export const INVALID_TOKEN = "设备推送令牌无效，请重启 App 再试";
export const TOO_MANY_ACCOUNTS = "这台设备登记的账号太多了，请先在别的账号里移除这台设备";

/**
 * 验令牌用的后台推送：不响、不显示，App 收到 probe 就直接结束。
 * apns-expiration 0：设备不在线时 APNs 不替它存着 —— 过一阵才送到的验证没有任何用处，只会白白唤醒一次 App
 */
const PROBE_PAYLOAD = { aps: { "content-available": 1 }, probe: "1" };
const PROBE_HEADERS = { "apns-push-type": "background", "apns-priority": "5", "apns-expiration": "0" };

export type ProbeResult = "valid" | "invalid" | "unknown";

/** APNs 明确说这个 token 用不了：格式不对、不是发给本 App 的、或者已经注销 */
function refusedByApns(result: PushResult): boolean {
  if (result.status === 410) return true;
  return (
    result.status === 400 &&
    (result.reason === "BadDeviceToken" || result.reason === "DeviceTokenNotForTopic")
  );
}

/**
 * 向这个 token 发一条后台推送，看 APNs 认不认。
 * 只有 APNs 明确拒收才算 invalid；超时、5xx、我们自己的签名出错一律 unknown —— 调用方照常放行
 */
export async function probeToken(
  env: Env,
  device: Device,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const result = await Promise.race([
      pushToDevice(env, device, PROBE_PAYLOAD, PROBE_HEADERS),
      timeout,
    ]);
    if (!result) return "unknown";
    if (result.status === 200) return "valid";
    return refusedByApns(result) ? "invalid" : "unknown";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function indexKey(token: string): Promise<string> {
  return TOKEN_INDEX + (await sha256(token));
}

async function readIndex(env: Env, key: string): Promise<string[]> {
  try {
    const raw = await env.PIGEON_KV.get<unknown>(key, "json");
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

async function writeIndex(env: Env, key: string, ids: string[]): Promise<void> {
  if (ids.length === 0) await env.PIGEON_KV.delete(key);
  else await env.PIGEON_KV.put(key, JSON.stringify(ids), { expirationTtl: INDEX_TTL_SECONDS });
}

/** 索引里这些账号，哪些现在真的还挂着这台设备。删掉的账号、移除了这台设备的账号不算 */
async function stillHolding(env: Env, ids: string[], token: string): Promise<string[]> {
  const accounts = await Promise.all(ids.map((id) => getAccount(env, id)));
  return ids.filter((_, i) => accounts[i]?.devices.some((d) => d.token === token));
}

/** 放行后拿到的回执：设备写进账号之后调 commit，把账号记进这台设备的索引 */
export interface Admission {
  commit(accountId: string): Promise<void>;
}

const NOTHING_TO_RECORD: Admission = { commit: async () => {} };

/**
 * 登记一台设备之前的检查（C15）。返回字符串 = 拒绝的原因；否则返回回执。
 * account 为空表示这是新建账号。
 *
 * 没有 APNs 私钥（本地开发、没配推送的自建环境）就整段跳过：验不了 token 的真假，
 * 按 token 计数也就没有意义 —— 随手编一个新的就绕过去了。
 *
 * 索引 tok:{sha256(token)} 记的是「哪些账号登记过这台设备」，不求时时准确：计数时逐个核对
 * 这些账号是否还挂着这台设备，不在了就顺手剔掉。所以移除设备时不改索引也不会算错；
 * 这一版之前登记的设备不在索引里，App 下次启动静默重新登记时补上。
 */
export async function admitDevice(
  env: Env,
  device: Device,
  account: Account | null,
): Promise<string | Admission> {
  if (!env.APNS_KEY_P8) return NOTHING_TO_RECORD;
  const key = await indexKey(device.token);
  const listed = await readIndex(env, key);

  // 已经在这个账号里的设备：App 每次启动都会静默重新登记一遍，改名也走这里。
  // 它早就在收推送了，不再验、不再数，只把索引补齐
  if (account?.devices.some((d) => d.token === device.token)) {
    return {
      commit: async (accountId) => {
        if (listed.includes(accountId)) return;
        try {
          await writeIndex(env, key, [...listed, accountId]);
        } catch {
          // 索引只是计数用的，写不进去不该让登记失败
        }
      },
    };
  }

  const others = await stillHolding(
    env,
    listed.filter((id) => id !== account?.id).slice(-MAX_CHECKED),
    device.token,
  );
  if (others.length >= MAX_ACCOUNTS_PER_DEVICE) return TOO_MANY_ACCOUNTS;
  // 先数后验：超了上限就不必再打一次 APNs
  if ((await probeToken(env, device)) === "invalid") return INVALID_TOKEN;

  return {
    commit: async (accountId) => {
      const next = [...others, accountId];
      if (next.length === listed.length && next.every((id, i) => listed[i] === id)) return;
      try {
        await writeIndex(env, key, next);
      } catch {
        // 同上
      }
    },
  };
}

/**
 * 删除账号时把它从各台设备的索引里摘掉。不摘也不会算错（见 admitDevice），
 * 但删账号的承诺是「和这个人有关的记录立即清掉」，一个指向它的计数也不该留下
 */
export async function forgetAccountDevices(env: Env, account: Account): Promise<void> {
  await Promise.all(
    account.devices.map(async (device) => {
      try {
        const key = await indexKey(device.token);
        const listed = await readIndex(env, key);
        if (listed.includes(account.id)) {
          await writeIndex(env, key, listed.filter((id) => id !== account.id));
        }
      } catch {
        // 删账号本身不能因为这一步失败
      }
    }),
  );
}
