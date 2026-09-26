import type { ApnsEnv, Env, PushResult } from "./types";

/** 两套环境是完全独立的，token 只在签发它的那一套里有效 */
const HOSTS: Record<ApnsEnv, string> = {
  production: "api.push.apple.com",
  sandbox: "api.sandbox.push.apple.com",
};

/**
 * Apple 的规矩：provider token 有效期 1 小时，但刷新不得快于每 20 分钟一次。
 * 取 40 分钟续期，两头都留了余量。
 *
 * 缓存放模块作用域 —— Workers 的 isolate 会跨请求复用，热路径上零 KV 读写。
 */
const TOKEN_TTL_MS = 40 * 60 * 1000;

let cachedJwt: { value: string; expiresAt: number; kid: string } | null = null;
let cachedKey: { value: CryptoKey; pem: string } | null = null;
/**
 * 正在签的那一个。冷启动的 isolate 里，一次群发会同时对几十台设备调 pushToDevice：
 * 不合并的话每台都各签一个（ECDSA 带随机数，签出来各不相同），一瞬间就是几十次「换 token」，
 * 而 Apple 要求 20 分钟内最多换一次。都等同一个就好
 */
let signing: { kid: string; promise: Promise<string> } | null = null;

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of view) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlText(text: string): string {
  return b64url(new TextEncoder().encode(text));
}

/** PEM → CryptoKey。secret 里可能是真换行也可能是字面量 \n，两种都吃。 */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  if (cachedKey?.pem === pem) return cachedKey.value;

  const body = pem
    .replace(/\\n/g, "\n")
    // 剥掉任意 -----XXX----- 头尾。Apple 的 .p8 是 PKCS#8（BEGIN PRIVATE KEY），
    // 但有人会先用 openssl 转过一道，落得 BEGIN EC PRIVATE KEY —— 一并吃掉，
    // 否则残留的 "EC" 会混进 base64 里，报一句看不懂的 atob 错。
    .replace(/-----[^-]+-----/g, "")
    // 只留 base64 字符。换行、回车、以及某些 .env 解析器没剥干净的包裹引号
    // 都会混进来，留着就是一句看不懂的 atob 报错。必须在剥掉 armor 之后做,
    // 因为 "BEGIN PRIVATE KEY" 这几个字母本身也在 base64 字符集里。
    .replace(/[^A-Za-z0-9+/=]/g, "");

  if (!body) throw new Error("APNS_KEY_P8 为空或格式不对");

  const bin = atob(body);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      der,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch {
    // WebCrypto 这里只会甩一句 "Invalid keyData"，照着它排查能耗掉一下午
    throw new Error(
      "APNS_KEY_P8 不是有效的 P-256 私钥。应当是 Apple 开发者后台下载的 " +
        ".p8 文件全文（含 -----BEGIN PRIVATE KEY----- 头尾）；" +
        "设置方式：wrangler secret put APNS_KEY_P8 < AuthKey_XXXXXX.p8",
    );
  }

  cachedKey = { value: key, pem };
  return key;
}

/**
 * 签一个 ES256 的 provider token。
 *
 * WebCrypto 的 ECDSA 签名输出本来就是 r‖s 的 64 字节裸格式，
 * 正是 JWS 要的形状 —— 不需要像用 OpenSSL 那样再从 DER 解出来。
 */
async function signToken(env: Env): Promise<string> {
  const now = Date.now();
  const header = b64urlText(JSON.stringify({ alg: "ES256", kid: env.APNS_KEY_ID }));
  const claims = b64urlText(
    JSON.stringify({ iss: env.APNS_TEAM_ID, iat: Math.floor(now / 1000) }),
  );
  const signingInput = `${header}.${claims}`;

  const key = await importPrivateKey(env.APNS_KEY_P8);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );

  const jwt = `${signingInput}.${b64url(signature)}`;
  cachedJwt = { value: jwt, expiresAt: now + TOKEN_TTL_MS, kid: env.APNS_KEY_ID };
  return jwt;
}

/** 缓存里有就用；正在签就等那一个；都没有才签。签失败不留痕迹，下一次调用重新签 */
function authToken(env: Env): Promise<string> {
  if (cachedJwt && cachedJwt.expiresAt > Date.now() && cachedJwt.kid === env.APNS_KEY_ID) {
    return Promise.resolve(cachedJwt.value);
  }
  if (signing?.kid === env.APNS_KEY_ID) return signing.promise;

  const promise = signToken(env).finally(() => {
    if (signing?.promise === promise) signing = null;
  });
  signing = { kid: env.APNS_KEY_ID, promise };
  return promise;
}

/** 这个 token 被 Apple 拒了：从缓存里拿掉，下一次推送重新签。别的请求已经换上新的就不动它 */
function forgetToken(jwt: string): void {
  if (cachedJwt?.value === jwt) cachedJwt = null;
}

export interface ApnsHeaders {
  "apns-push-type"?: string;
  "apns-collapse-id"?: string;
  "apns-priority"?: string;
  "apns-expiration"?: string;
  "apns-id"?: string;
}

/** 这两种失败出在我们这边、没走到 Apple：reason 以它们开头，explainFailure 据此分辨 */
const SIGNING_FAILED = "签发 APNs token 失败";
const CONNECT_FAILED = "连接 APNs 失败";

/**
 * 瞬时失败重试一次前等多久：300–600 毫秒，带随机抖动 ——
 * 群发时几十台设备同时撞上同一次 503，不该在同一毫秒一起再撞一次。
 * 加上两次请求本身，一条推送最多多花一两秒
 */
const RETRY_BASE_MS = 300;
const RETRY_JITTER_MS = 300;

/**
 * 值得原样再试一次的失败：Apple 那边 5xx、连不上、发往这台设备太频繁（429 TooManyRequests）。
 * 4xx 是请求本身或配置的问题，再发一遍结果一样。
 *
 * 同是 429 的 TooManyProviderTokenUpdates 不算：它嫌我们换 token 太勤，
 * 半秒后换个新 token 再试，正是它在抱怨的事
 */
function isTransient(result: PushResult): boolean {
  if (result.reason === "TooManyProviderTokenUpdates") return false;
  if (result.reason?.startsWith(SIGNING_FAILED)) return false;
  return result.status === 429 || result.status >= 500;
}

/**
 * 这些拒收说明手上这个 token 不能再用了，从缓存里拿掉、下次推送重签：过期的不用说；
 * 被嫌「换得太勤」的那个，留着的话缓存有效的 40 分钟里会一直被拒
 */
const STALE_TOKEN_REASONS = new Set(["ExpiredProviderToken", "TooManyProviderTokenUpdates"]);

/**
 * 打一条推送给一台设备。不抛异常，失败信息在返回值里。
 *
 * 瞬时失败（5xx、连不上、429）等一小会儿再试一次。原先一次 503 就算失败：
 * 心跳失联、网站掉线这种只推一次的告警，碰上 Apple 抖一下就这么丢了。
 * token 过期（ExpiredProviderToken）换一个新签的立刻再试；只试一次，不会越试越多。
 */
export async function pushToDevice(
  env: Env,
  device: { token: string; env: ApnsEnv },
  payload: unknown,
  headers: ApnsHeaders = {},
): Promise<PushResult> {
  const body = JSON.stringify(payload);
  const first = await attempt(env, device, body, headers);
  if (first.result.status === 200) return first.result;

  const reason = first.result.reason ?? "";
  if (first.jwt && STALE_TOKEN_REASONS.has(reason)) forgetToken(first.jwt);
  if (reason === "ExpiredProviderToken") {
    return (await attempt(env, device, body, headers)).result;
  }
  if (!isTransient(first.result)) return first.result;

  await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MS + Math.random() * RETRY_JITTER_MS));
  return (await attempt(env, device, body, headers)).result;
}

/** 发一次。jwt 带回去，调用方据此判断被拒的是哪一个 token */
async function attempt(
  env: Env,
  device: { token: string; env: ApnsEnv },
  body: string,
  headers: ApnsHeaders,
): Promise<{ result: PushResult; jwt?: string }> {
  const deviceToken = device.token;
  let jwt: string;
  try {
    jwt = await authToken(env);
  } catch (err) {
    return {
      result: {
        deviceToken,
        env: device.env,
        status: 500,
        reason: `${SIGNING_FAILED}: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  const host = env.APNS_HOST || HOSTS[device.env];
  const outbound: Record<string, string> = {
    authorization: `bearer ${jwt}`,
    "apns-topic": env.APNS_TOPIC,
    "apns-push-type": headers["apns-push-type"] || "alert",
    "content-type": "application/json",
  };
  for (const k of ["apns-collapse-id", "apns-priority", "apns-expiration", "apns-id"] as const) {
    const v = headers[k];
    if (v) outbound[k] = v;
  }

  let res: Response;
  env.countFetch?.();
  try {
    res = await fetch(`https://${host}/3/device/${deviceToken}`, {
      method: "POST",
      headers: outbound,
      body,
    });
  } catch (err) {
    return {
      jwt,
      result: {
        deviceToken,
        env: device.env,
        status: 502,
        reason: `${CONNECT_FAILED}: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  if (res.status === 200) return { jwt, result: { deviceToken, env: device.env, status: 200 } };

  const text = await res.text();
  let reason = text;
  try {
    reason = (JSON.parse(text) as { reason?: string }).reason ?? text;
  } catch {
    // APNs 出错时未必返回 JSON，原样带回去
  }
  return { jwt, result: { deviceToken, env: device.env, status: res.status, reason } };
}

/** token 是否已经废了 —— 用户删了 App 或重装，该把它从 channel 里摘掉 */
export function isDeadToken(result: PushResult): boolean {
  return (
    result.status === 410 ||
    (result.status === 400 && (result.reason ?? "").includes("BadDeviceToken"))
  );
}

/** 回给发送方的失败：HTTP 状态码 + 中文说明（末尾括号里是原始 reason，对照 Apple 文档排查用） */
export interface FailureExplanation {
  status: number;
  message: string;
  /** APNs 或本服务给的原始 reason */
  reason: string;
}

/** 这些 reason 说明是服务端的推送配置出了问题（密钥、证书、App 标识），发送方改请求没用 */
const CONFIG_REASONS = new Set([
  "InvalidProviderToken",
  "ExpiredProviderToken",
  "MissingProviderToken",
  "TooManyProviderTokenUpdates",
  "BadCertificate",
  "BadCertificateEnvironment",
  "Forbidden",
  "BadTopic",
  "TopicDisallowed",
  "MissingTopic",
  "DeviceTokenNotForTopic",
]);

/**
 * 把一台设备的失败翻成发送方看得懂的话。
 *
 * 原先 APNs 的状态码和英文 reason 原样甩回去：403 InvalidProviderToken 很容易被读成
 * 「我的 key 没权限」，发送方分不清是自己写错了还是服务端出了问题。按责任归类：
 * - 设备失效 → 410：之后不再推给它，重新打开 App 就好
 * - 内容太长 → 413、发得太频繁 → 429：发送方能改
 * - 其余（配置、Apple 故障、连不上）→ 502：不是发送方的错，改请求没用
 */
export function explainFailure(result: PushResult): FailureExplanation {
  const reason = result.reason ?? `HTTP ${result.status}`;
  const said = (status: number, text: string): FailureExplanation => ({
    status,
    message: `推送失败：${text}（${reason}）`,
    reason,
  });
  if (isDeadToken(result)) {
    // 不说「已清理」：这里只立了失效墓碑、之后跳过它，令牌要等账号本人下次来访才从账号上摘掉（见 db.ts recordPushOutcome）
    return said(410, "设备已失效（App 被删除或重装过），之后不再推给它。在那台设备上重新打开 App 即可恢复接收");
  }
  if (result.status === 413 || reason === "PayloadTooLarge") {
    return said(413, "内容太长，超过了 Apple 单条推送 4KB 的上限");
  }
  if (result.status === 429) {
    return said(429, "发得太频繁，Apple 暂时拒收发往这台设备的推送，请稍后再试");
  }
  if (reason.startsWith(SIGNING_FAILED) || CONFIG_REASONS.has(reason)) {
    return said(502, "服务端的推送配置有问题，不是你的请求出错，请稍后再试");
  }
  if (reason.startsWith(CONNECT_FAILED)) {
    return said(502, "暂时连不上 Apple 的推送服务，请稍后再试");
  }
  if (result.status >= 500) {
    return said(502, "Apple 的推送服务暂时不可用，请稍后再试");
  }
  return said(502, "Apple 拒收了这条推送，不是你的请求出错，请稍后再试");
}

/**
 * 一台都没送到时，挑哪台的失败说给发送方听：
 * 全是失效设备才报失效（之后的推送都跳过它们，下次就是「没有可用设备」）；
 * 混着别的失败时报别的 —— 失效的已经记下了，剩下的才是发送方要知道的。
 */
export function explainFailures(results: PushResult[]): FailureExplanation {
  const failed = results.filter((r) => r.status !== 200);
  const pick = failed.find((r) => !isDeadToken(r)) ?? failed[0];
  if (!pick) return { status: 500, message: "推送失败：未知原因", reason: "" };
  return explainFailure(pick);
}
