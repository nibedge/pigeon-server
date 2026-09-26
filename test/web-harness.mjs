/**
 * 页面与推送入口测试共用的桩：内存 KV、截获 APNs 的假 fetch、直接调 Worker 的 fetch，以及建号、建群的几步。
 * 和 web.test.mjs 同一套做法；引入即把全局 fetch 换成假的 APNs。
 *
 * 用 npm run test:web 构建出的 .test-build/s3web/ 。文件名不以 api 开头：run-api.sh 只跑 test/api*.test.mjs
 */
import { generateKeyPairSync } from "node:crypto";
import worker from "../.test-build/s3web/index.mjs";

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

export function req(method, path, { body, secret, origin = "https://nfo.im", headers: extra = {} } = {}) {
  const headers = { ...extra };
  if (body) headers["content-type"] = "application/json";
  if (secret) headers.authorization = `Bearer ${secret}`;
  return new Request(`${origin}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

export async function call(env, method, path, opts = {}) {
  const res = await worker.fetch(req(method, path, opts), env, {});
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 页面 */
  }
  return { status: res.status, headers: res.headers, text, json };
}

let tokenSeq = 0;
export async function newAccount(env, name) {
  tokenSeq += 1;
  const token = `${tokenSeq}`.padStart(4, "0").repeat(16);
  const r = await call(env, "POST", "/account", { body: { device_token: token, environment: "sandbox", device_name: "测试机" } });
  const data = r.json?.data;
  if (name) await call(env, "PATCH", `/account/${data.account_id}`, { secret: data.secret, body: { name } });
  return { id: data.account_id, secret: data.secret, key: data.channels[0].key, channelId: data.channels[0].id };
}

/** 群主建一个群、生成邀请，另一个人加入。返回群主、成员、群的 id 和 key、邀请码 */
export async function makeGroup(env, name = "家庭群") {
  const owner = await newAccount(env, "老王");
  const made = (await call(env, "POST", `/account/${owner.id}/channels`, { secret: owner.secret, body: { name, group: true } })).json.data.channel;
  const code = (await call(env, "POST", `/account/${owner.id}/channels/${made.id}/invites`, { secret: owner.secret })).json.data.code;
  const member = await newAccount(env);
  const joined = await call(env, "POST", `/account/${member.id}/invites/${code}`, { secret: member.secret });
  if (joined.json?.data?.result !== "joined") throw new Error(`加入失败：${joined.text}`);
  return { owner, member, id: made.id, key: made.key, code };
}

/** 去掉标签、还原实体、空白并成一个空格：检查文案时不被 HTML 的换行和标签绊住 */
export function plain(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}
