/**
 * 实时活动两份进程内测试共用的底子：打包 src、内存里的 KV、截获请求的假 APNs、造账号和通道。
 *
 *   api-l6-live-apns.test.mjs     开始、认领、结束各种情形下发给 APNs 的样子，什么时候不该发
 *   api-l6-live-samples.test.mjs  生成给 App 核对的样本（test/fixtures/live-activity-samples.json）
 *
 * 文件名不以 api 开头：run-api.sh 只跑 test/api*.test.mjs，这个文件自己不是测试。
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = fileURLToPath(new URL("../.test-build/l6-live.mjs", import.meta.url));
await build({
  stdin: {
    contents: [
      'export * from "./src/push.ts";',
      'export { ATTRIBUTES_TYPE, LIVE_DISMISS_AFTER_MS, LIVE_START_EXPIRATION_SECONDS, LIVE_TTL_SECONDS, SEALED_TITLE, liveCost, liveTitle, registerActivity } from "./src/live.ts";',
      'export { default as worker } from "./src/index.ts";',
      'export { alertParams } from "./src/watch.ts";',
    ].join("\n"),
    resolveDir: ROOT,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  outfile: OUT,
  logLevel: "error",
});
export const live = await import(OUT);

let failures = 0;
export function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `  → ${detail}` : ""}`);
  }
}

/** 收尾：有失败就以 1 退出 */
export function finish(passed) {
  if (failures > 0) {
    console.log(`\n${failures} 项失败`);
    process.exit(1);
  }
  console.log(`\n${passed}`);
}

// ── 假 APNs ─────────────────────────────────────────────────────────

/**
 * 截下来的请求放在 fake.requests：{ token, host, headers, payload }。
 * fake.reply 按请求决定回什么：返回 [状态码, reason]
 */
export const fake = { requests: [], reply: () => [200, ""] };
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  const entry = { token: u.pathname.split("/").pop(), host: u.host, headers: init.headers, payload: JSON.parse(init.body) };
  fake.requests.push(entry);
  const [status, reason] = fake.reply(entry);
  return new Response(status === 200 ? "" : JSON.stringify({ reason }), { status });
};
export const liveRequests = () => fake.requests.filter((a) => a.headers["apns-push-type"] === "liveactivity");
export const alerts = () => fake.requests.filter((a) => a.headers["apns-push-type"] === "alert");
export const reset = () => {
  fake.requests = [];
  fake.reply = () => [200, ""];
};

/**
 * strictWrites：照线上的样子，同一个键一秒之内写第二次抛 429（本地 wrangler dev 和默认的内存 KV 都不管这个）
 */
export function memoryKV({ strictWrites = false } = {}) {
  const store = new Map();
  const meta = new Map();
  const ttl = new Map();
  const writtenAt = new Map();
  let failList = false;
  return {
    store, meta, ttl,
    set failList(v) { failList = v; },
    /** 被一秒一次的上限拒掉了几次 */
    rejectedWrites: 0,
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value, opts) {
      if (strictWrites) {
        const last = writtenAt.get(key);
        if (last !== undefined && Date.now() - last < 1000) {
          this.rejectedWrites += 1;
          throw new Error("KV PUT failed: 429 Too Many Requests");
        }
        writtenAt.set(key, Date.now());
      }
      store.set(key, value);
      if (opts?.metadata !== undefined) meta.set(key, opts.metadata);
      else meta.delete(key);
      if (opts?.expirationTtl) ttl.set(key, opts.expirationTtl);
    },
    async delete(key) {
      store.delete(key);
      meta.delete(key);
    },
    async list({ prefix = "" } = {}) {
      if (failList) throw new Error("KV list 出错（测试）");
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort()
        .map((name) => (meta.has(name) ? { name, metadata: meta.get(name) } : { name }));
      return { keys, list_complete: true, cacheStatus: null };
    },
  };
}

// 每次跑现生成一把，不在仓库里放私钥 —— 认领凭据因此每次都不一样，要比对的地方自己处理
const { privateKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
export const sha = (text) => createHash("sha256").update(text).digest("hex");
export const SECRET = "secret-for-tests";

/** 设备：推送令牌 + 可选的开始令牌。令牌都是十六进制，一眼看得出是谁的 */
export const device = (tag, { start = true, env = "sandbox" } = {}) => ({
  token: tag.padEnd(64, "0"),
  env,
  name: tag,
  addedAt: 0,
  ...(start ? { activityStartToken: `5${tag}`.padEnd(64, "a"), activityStartTokenAt: 0 } : {}),
});

export function makeEnv({ group = false, defaults, policy, ownerPrefs, memberPrefs, ownerDevices, memberDevices, strictWrites } = {}) {
  const kv = memoryKV({ strictWrites });
  const owner = {
    id: "owner001", secretHash: sha(SECRET), name: "机主", channelIds: ["chanL001"], createdAt: 0, updatedAt: 0,
    devices: ownerDevices ?? [device("a1")], ...(ownerPrefs ? { prefs: ownerPrefs } : {}),
  };
  const member = {
    id: "member01", secretHash: sha(SECRET), name: "张三", channelIds: ["chanL001"], createdAt: 0, updatedAt: 0,
    devices: memberDevices ?? [device("b1")], ...(memberPrefs ? { prefs: memberPrefs } : {}),
  };
  const channel = {
    id: "chanL001", key: "keyL00000001", name: "线上告警", ownerId: owner.id, memberIds: group ? [member.id] : [],
    createdAt: 0, count: 0, ...(defaults ? { defaults } : {}), ...(policy ? { policy } : {}),
  };
  kv.store.set(`acct:${owner.id}`, JSON.stringify(owner));
  kv.store.set(`acct:${member.id}`, JSON.stringify(member));
  kv.store.set(`chan:${channel.id}`, JSON.stringify(channel));
  kv.store.set(`ch:${channel.key}`, JSON.stringify({ id: channel.id }));
  const env = { PIGEON_KV: kv, APNS_KEY_P8: privateKey, APNS_KEY_ID: "ABC1234DEF", APNS_TEAM_ID: "TEAM567890", APNS_TOPIC: "im.nfo.pigeon" };
  const recipients = group ? [owner, member] : [owner];
  return { env, kv, channel, owner, member, recipients };
}

export const recordOf = (kv, mid) => {
  const raw = kv.store.get(`la:chanL001:${encodeURIComponent(mid)}`);
  return raw === undefined ? null : JSON.parse(raw);
};
export const entriesOf = (kv, mid) => [...kv.store.keys()].filter((k) => k.startsWith(`la:chanL001:${encodeURIComponent(mid)}:`));

/** 走真的 Worker 入口（index.ts 的路由），不经过网络 */
export const hit = (env, path, init = {}) => live.worker.fetch(new Request(`https://nfo.im${path}`, init), env);
export const put = (body) => ({ method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` }, body: JSON.stringify(body) });

/** 手机登记这件事的更新令牌（走真的接口） */
export async function register(env, who, dev, mid, token, startedAt) {
  const res = await hit(env, `/account/${who.id}/activities/chanL001/${encodeURIComponent(mid)}`, put({ token, device: dev.token, started_at: startedAt }));
  return { status: res.status, json: await res.json() };
}
