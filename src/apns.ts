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
async function authToken(env: Env): Promise<string> {
  const now = Date.now();
  if (cachedJwt && cachedJwt.expiresAt > now && cachedJwt.kid === env.APNS_KEY_ID) {
    return cachedJwt.value;
  }

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

export interface ApnsHeaders {
  "apns-push-type"?: string;
  "apns-collapse-id"?: string;
  "apns-priority"?: string;
  "apns-expiration"?: string;
  "apns-id"?: string;
}

/** 打一条推送给一台设备。不抛异常，失败信息在返回值里。 */
export async function pushToDevice(
  env: Env,
  device: { token: string; env: ApnsEnv },
  payload: unknown,
  headers: ApnsHeaders = {},
): Promise<PushResult> {
  const deviceToken = device.token;
  let jwt: string;
  try {
    jwt = await authToken(env);
  } catch (err) {
    return {
      deviceToken,
      env: device.env,
      status: 500,
      reason: `签发 APNs token 失败: ${err instanceof Error ? err.message : String(err)}`,
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
  try {
    res = await fetch(`https://${host}/3/device/${deviceToken}`, {
      method: "POST",
      headers: outbound,
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return {
      deviceToken,
      env: device.env,
      status: 502,
      reason: `连接 APNs 失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (res.status === 200) return { deviceToken, env: device.env, status: 200 };

  const text = await res.text();
  let reason = text;
  try {
    reason = (JSON.parse(text) as { reason?: string }).reason ?? text;
  } catch {
    // APNs 出错时未必返回 JSON，原样带回去
  }
  return { deviceToken, env: device.env, status: res.status, reason };
}

/** token 是否已经废了 —— 用户删了 App 或重装，该把它从 channel 里摘掉 */
export function isDeadToken(result: PushResult): boolean {
  return (
    result.status === 410 ||
    (result.status === 400 && (result.reason ?? "").includes("BadDeviceToken"))
  );
}
