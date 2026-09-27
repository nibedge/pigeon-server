/**
 * 接入面（兼容格式、通用 JSON、Alertmanager、MCP、文档站）单元测试共用的桩。
 *
 * 自己用 esbuild 打一份包到 .test-build/l1/（不依赖别的 npm 脚本先跑过），然后：内存 KV、截获 APNs 的假 fetch、
 * 直接调 Worker 的 fetch。和 web-harness.mjs 同一套做法；引入即把全局 fetch 换成假的 APNs。
 * 文件名不以 api 开头：run-api.sh 只跑 test/api*.test.mjs
 */
import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, ".test-build/l1");

await build({
  // 测试要单独 import 的模块也各打一份（load("docs") 这样取）
  entryPoints: ["src/index.ts", "src/compat/robot.ts", "src/compat/generic.ts", "src/compat/params.ts", "src/docs.ts"]
    .map((p) => join(ROOT, p))
    .filter((p) => existsSync(p)),
  bundle: true,
  format: "esm",
  outbase: join(ROOT, "src"),
  outdir: OUT,
  outExtension: { ".js": ".mjs" },
  logLevel: "error",
});

/** 打好的模块：modules("compat/robot") → 那个文件导出的东西 */
export const load = (name) => import(join(OUT, `${name}.mjs`));

const worker = (await load("index")).default;

export function memoryKV() {
  const store = new Map();
  const meta = new Map();
  return {
    store,
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value, options = {}) {
      store.set(key, value);
      if (options.metadata !== undefined) meta.set(key, options.metadata);
    },
    async delete(key) {
      store.delete(key);
      meta.delete(key);
    },
    async list({ prefix = "" } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name, metadata: meta.get(name) }));
      return { keys, list_complete: true, cacheStatus: null };
    },
  };
}

const { privateKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

/** 截下来的 APNs 请求，一律回 200 */
export const apns = [];
globalThis.fetch = async (url, init) => {
  apns.push({ url: String(url), headers: init.headers, payload: JSON.parse(init.body) });
  return new Response("", { status: 200 });
};

export function makeEnv(extra = {}) {
  return {
    PIGEON_KV: memoryKV(),
    APNS_KEY_P8: privateKey,
    APNS_KEY_ID: "ABC1234DEF",
    APNS_TEAM_ID: "TEAM567890",
    APNS_TOPIC: "im.nfo.pigeon",
    ...extra,
  };
}

/** 发一个请求给 Worker。json 给对象就按 JSON 发；raw 给字符串就原样发（headers 自己带类型） */
export async function call(env, method, path, { json, raw, secret, headers = {}, origin = "https://nfo.im" } = {}) {
  const h = { ...headers };
  if (json !== undefined) h["content-type"] ??= "application/json";
  if (secret) h.authorization = `Bearer ${secret}`;
  const body = json !== undefined ? JSON.stringify(json) : raw;
  const res = await worker.fetch(new Request(`${origin}${path}`, { method, headers: h, body }), env, {});
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* 页面、纯文字 */
  }
  return { status: res.status, headers: res.headers, text, json: parsed };
}

let tokenSeq = 0;
export async function newAccount(env) {
  tokenSeq += 1;
  const token = `${tokenSeq}`.padStart(4, "0").repeat(16);
  const r = await call(env, "POST", "/account", { json: { device_token: token, environment: "sandbox", device_name: "测试机" } });
  const data = r.json?.data;
  return { id: data.account_id, secret: data.secret, key: data.channels[0].key, channelId: data.channels[0].id };
}

/** 最近一次推出去的 payload 与它的 alert */
export function lastPush() {
  const sent = apns.at(-1)?.payload ?? {};
  return { sent, alert: sent.aps?.alert ?? {}, level: sent.aps?.["interruption-level"] };
}

let failures = 0;
export function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `  → ${detail}` : ""}`);
  }
}

export function finish() {
  console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
  process.exit(failures === 0 ? 0 : 1);
}
