/**
 * 群与令牌（L4）在进程里跑的测试共用的桩：自己打包 Worker、内存 KV、截获 APNs 的假 fetch、限流绑定的桩，
 * 以及建号、建群的几步。和 web-harness.mjs 同一套做法。
 *
 * 要看「推到每台设备上的 payload 长什么样」，本地 wrangler dev 连不上 APNs、看不到 —— 所以把 Worker 打包进来
 * 直接调它的 fetch。打包在这里自己做（.test-build/l4/），不依赖别的测试先跑过，也不必改 package.json：
 * 用它的测试文件以 api 开头，由 run-api.sh 跟着 API 测试一起跑。本文件名不以 api 开头，run-api.sh 不会单独跑它
 */
import { generateKeyPairSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, ".test-build/l4");
await build({
  entryPoints: ["src/index.ts", "src/receivers.ts", "src/push.ts"].map((p) => join(ROOT, p)),
  bundle: true,
  format: "esm",
  outbase: join(ROOT, "src"),
  outdir: OUT,
  outExtension: { ".js": ".mjs" },
  logLevel: "error",
});
export const worker = (await import(join(OUT, "index.mjs"))).default;
export const receivers = await import(join(OUT, "receivers.mjs"));
export const push = await import(join(OUT, "push.mjs"));

let failures = 0;
export function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `  → ${detail}` : ""}`);
  }
}

/** 收尾：报告结果，有失败就以非零退出 */
export function finish() {
  console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
  process.exit(failures === 0 ? 0 : 1);
}

export function memoryKV() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = "" } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true, cacheStatus: null };
    },
  };
}

/** 限流绑定的桩：每个键在一个窗口里最多放 limit 次；reset() 当作进了下一分钟 */
export function limiter(limit) {
  const counts = new Map();
  return {
    counts,
    async limit({ key }) {
      const n = counts.get(key) ?? 0;
      counts.set(key, n + 1);
      return { success: n < limit };
    },
    reset() {
      counts.clear();
    },
  };
}

const { privateKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

/** 截下来的 APNs 请求：推给了哪台设备、payload 是什么。一律回 200 */
export const apns = [];
globalThis.fetch = async (url, init) => {
  const device = String(url).split("/").pop();
  apns.push({ device, headers: init.headers, payload: JSON.parse(init.body) });
  return new Response("", { status: 200 });
};

export function makeEnv() {
  return {
    PIGEON_KV: memoryKV(),
    APNS_KEY_P8: privateKey,
    APNS_KEY_ID: "ABC1234DEF",
    APNS_TEAM_ID: "TEAM567890",
    APNS_TOPIC: "im.nfo.pigeon",
    APNS_CATEGORY: "pigeonNotification",
    RL_TOKEN: limiter(1),
    RL_ACCOUNT: limiter(20),
  };
}

export async function call(env, method, path, { body, secret, headers: extra = {}, raw } = {}) {
  const headers = { ...extra };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (secret) headers.authorization = `Bearer ${secret}`;
  const request = new Request(`https://nfo.im${path}`, {
    method,
    headers,
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const res = await worker.fetch(request, env, {});
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 页面 */
  }
  return { status: res.status, headers: res.headers, text, json };
}

/** 这段操作推出去的通知（不含登记设备时验令牌的后台推送） */
export async function capture(fn) {
  const before = apns.length;
  const result = await fn();
  return { result, sent: apns.slice(before).filter((a) => a.payload.probe === undefined) };
}

let seq = 0;
export async function newAccount(env, name) {
  seq += 1;
  const token = `${seq}`.padStart(4, "0").repeat(16);
  const r = await call(env, "POST", "/account", { body: { device_token: token, environment: "sandbox", device_name: `${name} 的手机` } });
  const data = r.json.data;
  await call(env, "PATCH", `/account/${data.account_id}`, { secret: data.secret, body: { name } });
  const acct = { id: data.account_id, secret: data.secret, token, name, key: data.channels[0].key, channelId: data.channels[0].id };
  acct.as = (method, path, body) => call(env, method, path, { secret: acct.secret, body });
  return acct;
}

/** 群主建群，其余几个人凭邀请加入 */
export async function makeGroup(env, owner, members, name = "家庭群") {
  const made = (await owner.as("POST", `/account/${owner.id}/channels`, { name, group: true })).json.data.channel;
  const code = (await owner.as("POST", `/account/${owner.id}/channels/${made.id}/invites`)).json.data.code;
  for (const m of members) {
    const joined = await m.as("POST", `/account/${m.id}/invites/${code}`);
    if (joined.json?.data?.result !== "joined") throw new Error(`加入失败：${joined.text}`);
  }
  return { id: made.id, key: made.key };
}

export const to = (sent, who) => sent.filter((a) => a.device === who.token);
export const one = (sent, who) => to(sent, who)[0]?.payload;
