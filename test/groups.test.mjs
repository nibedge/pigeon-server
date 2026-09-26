/**
 * 群组防滥用的测试：认领凭据、认领限流、举报限额、给运营者的通知合并。
 *
 * 认领凭据只在有 APNS_KEY_P8 时才签发、才核对，本地 wrangler dev 没有这把钥匙 ——
 * 所以「伪造的凭据被拒」「广播里不带原消息的文字」这些只能在这里测：直接调接口处理函数，
 * KV 放内存里，APNs 换成截获请求的假 fetch。
 */
import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import {
  ackSignature,
  ackSigValid,
  MOD_NOTIFY_WINDOW_MS,
  moderatorNotice,
  REPORTS_PER_HOUR,
  stampAckSig,
  takeReportQuota,
} from "../.test-build/s3/groups.mjs";
import { deliver } from "../.test-build/s3/push.mjs";
import {
  handleAck,
  handleAddChannel,
  handleCreateAccount,
  handleCreateInvite,
  handleJoinInvite,
  handleReport,
  handleUpdateAccount,
} from "../.test-build/s3/routes/account.mjs";


let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `  → ${detail}` : ""}`);
  }
}

function memoryKV() {
  const store = new Map();
  const ttl = new Map();
  return {
    store,
    ttl,
    /** 置为 true 时每次写入都失败，模拟撞上 KV 同一个键每秒一次的写入上限 */
    failPut: false,
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value, opts) {
      if (this.failPut) throw new Error("KV put failed: 429 Too Many Requests");
      store.set(key, value);
      if (opts?.expirationTtl) ttl.set(key, opts.expirationTtl);
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

/** 截下来的 APNs 请求 */
const apns = [];
globalThis.fetch = async (url, init) => {
  apns.push({ url: String(url), headers: init.headers, payload: JSON.parse(init.body) });
  return new Response("", { status: 200 });
};

function makeEnv(extra = {}) {
  return {
    PIGEON_KV: memoryKV(),
    APNS_KEY_P8: privateKey,
    APNS_KEY_ID: "ABC1234DEF",
    APNS_TEAM_ID: "TEAM567890",
    APNS_TOPIC: "im.nfo.pigeon",
    ...extra,
  };
}

/** 照着 App 的调用方式造请求，直接交给处理函数 */
function req(method, path, { body, secret } = {}) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (secret) headers.authorization = `Bearer ${secret}`;
  return new Request(`https://nfo.im${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

async function json(res) {
  return { status: res.status, headers: res.headers, json: await res.json() };
}

const fakeToken = (seed) => seed.repeat(64).slice(0, 64);

async function newAccount(env, seed, name) {
  const r = await json(await handleCreateAccount(req("POST", "/account", {
    body: { device_token: fakeToken(seed), environment: "sandbox", device_name: `${seed} 的手机` },
  }), env));
  const acct = { id: r.json.data.account_id, secret: r.json.data.secret, token: fakeToken(seed) };
  if (name) await handleUpdateAccount(req("PATCH", `/account/${acct.id}`, { secret: acct.secret, body: { name } }), env, acct.id);
  return acct;
}

/** 群主 O 建一个群，成员 M 凭邀请加入 */
async function makeGroup(env) {
  const O = await newAccount(env, "o", "王五");
  const M = await newAccount(env, "m", "李四");
  const made = await json(await handleAddChannel(req("POST", `/account/${O.id}/channels`, {
    secret: O.secret, body: { name: "值班群", group: true },
  }), env, O.id));
  const gid = made.json.data.channel.id;
  const inv = await json(await handleCreateInvite(req("POST", `/account/${O.id}/channels/${gid}/invites`, { secret: O.secret }), env, O.id, gid));
  const joined = await json(await handleJoinInvite(req("POST", `/account/${M.id}/invites/${inv.json.data.code}`, { secret: M.secret }), env, M.id, inv.json.data.code));
  return { O, M, gid, code: inv.json.data.code, joined };
}

// ── 认领凭据 ────────────────────────────────────────────────────────

console.log("\n★ 认领凭据的算法（与约定逐字节一致）");
{
  const env = { APNS_KEY_P8: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" };
  // K = SHA-256("pigeon ack-sig v1|" ‖ APNS_KEY_P8)；sig = base64url(HMAC-SHA256(K, 通道 id|消息 id) 前 16 字节)
  const k = createHash("sha256").update("pigeon ack-sig v1|" + env.APNS_KEY_P8, "utf8").digest();
  const expected = createHmac("sha256", k).update("chan0001|msg-1", "utf8").digest().subarray(0, 16).toString("base64url");
  const sig = await ackSignature(env, "chan0001", "msg-1");
  check("★ 与独立实现算出的一样", sig === expected, `${sig} vs ${expected}`);
  check("22 个字符、base64url、无填充", /^[A-Za-z0-9_-]{22}$/.test(sig ?? ""), sig);
  check("换一条消息就不一样", (await ackSignature(env, "chan0001", "msg-2")) !== sig);
  check("换一个通道就不一样", (await ackSignature(env, "chan0002", "msg-1")) !== sig);
  check("换一把钥匙就不一样", (await ackSignature({ APNS_KEY_P8: "other" }, "chan0001", "msg-1")) !== sig);
  check("对的凭据 → 通过", await ackSigValid(env, "chan0001", "msg-1", sig));
  check("★ 拿别的消息的凭据 → 不通过", !(await ackSigValid(env, "chan0001", "msg-2", sig)));
  check("改一个字符 → 不通过", !(await ackSigValid(env, "chan0001", "msg-1", (sig[0] === "A" ? "B" : "A") + sig.slice(1))));
  check("长度不对 → 不通过", !(await ackSigValid(env, "chan0001", "msg-1", sig + "x")));

  check("没有 APNS_KEY_P8：不签发", (await ackSignature({}, "chan0001", "msg-1")) === undefined);
  check("没有 APNS_KEY_P8：不核对，一律放行（本地测试）", await ackSigValid({}, "chan0001", "msg-1", "anything"));

  const payloads = [{ a: 1 }, { b: 2 }];
  await stampAckSig(env, "chan0001", "msg-1", payloads);
  check("一次投递的每一份 payload 都盖上", payloads.every((p) => p.ack_sig === sig));
  const bare = [{}];
  await stampAckSig({}, "chan0001", "msg-1", bare);
  check("没有钥匙就不带这个字段", !("ack_sig" in bare[0]));
}

console.log("\n★ deliver 推出去的每条消息都带 ack_sig");
{
  const env = makeEnv();
  const me = { id: "acct0001", secretHash: "x", channelIds: ["chan0001"], createdAt: 0, updatedAt: 0,
    devices: [{ token: "a".repeat(64), env: "sandbox", name: "iPhone", addedAt: 0 }] };
  const mate = { id: "acct0002", secretHash: "x", channelIds: ["chan0001"], createdAt: 0, updatedAt: 0,
    // 把这个群设成了免打扰：拿到的是另一份静默 payload，同样要带
    prefs: { mutes: { chan0001: 0 } },
    devices: [{ token: "b".repeat(64), env: "sandbox", name: "iPhone", addedAt: 0 }] };
  const channel = { id: "chan0001", key: "key0000000001", name: "告警", ownerId: me.id, memberIds: [mate.id], createdAt: 0, count: 0 };
  env.PIGEON_KV.store.set("chan:chan0001", JSON.stringify(channel));
  const before = apns.length;
  const report = await deliver(env, channel, [me, mate], { title: "磁盘满了", id: "disk-1" });
  const sent = apns.slice(before);
  const expected = await ackSignature(env, "chan0001", "disk-1");
  check("两台设备都推了（一份原样、一份静默）", sent.length === 2 && report.muted === 1, JSON.stringify(report));
  check("★ 两份都带同一个 ack_sig", sent.every((a) => a.payload.ack_sig === expected), JSON.stringify(sent.map((a) => a.payload.ack_sig)));

  const before2 = apns.length;
  const auto = await deliver(env, channel, [me], { body: "没给 id" });
  check("没给 id 的消息：按服务端生成的 id 签", apns[before2]?.payload.ack_sig === (await ackSignature(env, "chan0001", auto.messageId)));
}

console.log("\n★ 认领接口：凭据、不转发标题、限流");
{
  const env = makeEnv();
  const { O, M, gid, joined } = await makeGroup(env);
  check("成员加入（前置）", joined.status === 200 && joined.json.data.result === "joined", JSON.stringify(joined.json));
  const ack = (who, body, e = env) =>
    handleAck(req("POST", `/account/${who.id}/channels/${gid}/ack`, { secret: who.secret, body }), e, who.id, gid).then(json);

  const sig = await ackSignature(env, gid, "real-1");
  const before = apns.length;
  const good = await ack(M, { message_id: "real-1", sig, title: "数据库密码是 hunter2" });
  const broadcast = apns.slice(before);
  check("★ 带对的凭据 → 200，第一个认领", good.status === 200 && good.json.data.first === true, JSON.stringify(good.json));
  check("广播给了群里两个人", broadcast.length === 2);
  check("★ 广播正文固定「一条消息」", broadcast.every((a) => a.payload.aps.alert.body === "一条消息"));
  check("★ 旧版 App 传上来的标题一个字也没带出去", broadcast.every((a) => !JSON.stringify(a.payload).includes("hunter2")));
  check("广播带 ack_by 和被认领的消息 id", broadcast.every((a) => a.payload.ack_by === "李四" && a.payload.id === "real-1"));

  const forged = await ack(M, { message_id: "made-up", sig });
  check("★ 拿别的消息的凭据认领编出来的 id → 403", forged.status === 403 && forged.json.message === "认领凭据不对，请更新 App 后再试", JSON.stringify(forged.json));
  check("凭据不是字符串 → 403", (await ack(M, { message_id: "made-up", sig: 123 })).status === 403);
  check("被拒的认领没有留下记录", !env.PIGEON_KV.store.has(`ack:${gid}:made-up`));

  const legacy = await ack(M, { message_id: "old-app-1" });
  check("★ 过渡期：旧版 App 不带凭据 → 照样放行", legacy.status === 200 && legacy.json.data.first === true, JSON.stringify(legacy.json));
  check("空字符串按没带处理", (await ack(M, { message_id: "old-app-2", sig: "" })).status === 200);

  // 限流绑定：按账号计数，假的限流器数一数它被问了什么
  const asked = [];
  const limited = { ...env, RL_ACCOUNT: { limit: async ({ key }) => (asked.push(key), { success: false }) } };
  const before3 = apns.length;
  const tooFast = await ack(M, { message_id: "real-2", sig: await ackSignature(env, gid, "real-2") }, limited);
  check("★ 超出限流 → 429", tooFast.status === 429, JSON.stringify(tooFast.json));
  check("按账号计：键是 ack:{账号 id}", asked[0] === `ack:${M.id}`, asked.join(","));
  check("body 带 error、retry_after，信封的 message 照旧（旧版 App 读它）",
    tooFast.json.error && tooFast.json.message === tooFast.json.error && tooFast.json.retry_after === 60, JSON.stringify(tooFast.json));
  check("头里有 Retry-After: 60", tooFast.headers.get("retry-after") === "60");
  check("被限流的认领没有广播", apns.length === before3);
  const open = { ...env, RL_ACCOUNT: { limit: async () => ({ success: true }) } };
  check("没超 → 照常", (await ack(M, { message_id: "real-3" }, open)).status === 200);
  const broken = { ...env, RL_ACCOUNT: { limit: async () => { throw new Error("down"); } } };
  check("限流服务自己出错 → 放行", (await ack(M, { message_id: "real-4" }, broken)).status === 200);
  void O;
}

// ── 举报 ────────────────────────────────────────────────────────────

console.log("\n★ 举报额度：每个账号每小时 5 次");
{
  const env = makeEnv();
  const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const at = hour + 30 * 60_000;
  const results = [];
  for (let i = 0; i < REPORTS_PER_HOUR + 1; i++) results.push(await takeReportQuota(env, "acct0001", at));
  check("前 5 次放行", results.slice(0, REPORTS_PER_HOUR).every((w) => w === 0), results.join(","));
  check("★ 第 6 次拦下，要等到整点（30 分钟）", results[REPORTS_PER_HOUR] === 1800, String(results[REPORTS_PER_HOUR]));
  const key = `rl:report:acct0001:${hour / 3_600_000}`;
  check("计数键按约定命名，2 小时后自动过期", env.PIGEON_KV.store.get(key) === "5" && env.PIGEON_KV.ttl.get(key) === 7200, key);
  check("别的账号不受影响", (await takeReportQuota(env, "acct0002", at)) === 0);
  check("下一个小时重新计", (await takeReportQuota(env, "acct0001", hour + 3_600_000)) === 0);
  env.PIGEON_KV.failPut = true;
  check("★ 计数写不进去按超限处理（刷举报的一秒连发正好撞上 KV 写入上限）", (await takeReportQuota(env, "acct0003", at)) === 60);
}

console.log("\n★ 给运营者的举报通知：同一个群 10 分钟合并一次");
{
  const env = makeEnv();
  const t0 = 1_000_000_000_000;
  check("第一条立刻推（此前没合并掉的）", (await moderatorNotice(env, "chan0001", t0)) === 0);
  check("10 分钟内的第二条不推", (await moderatorNotice(env, "chan0001", t0 + 60_000)) === null);
  check("第三条也不推", (await moderatorNotice(env, "chan0001", t0 + 120_000)) === null);
  check("别的群不受影响", (await moderatorNotice(env, "chan0002", t0 + 120_000)) === 0);
  check("★ 过了窗口的下一条推，并带上中间合并掉的 2 条", (await moderatorNotice(env, "chan0001", t0 + MOD_NOTIFY_WINDOW_MS)) === 2);
  check("然后重新开始计", (await moderatorNotice(env, "chan0001", t0 + MOD_NOTIFY_WINDOW_MS + 1)) === null);
}

console.log("\n★ 举报接口：额度与通知合并接上了");
{
  const env = makeEnv();
  const { O, M, gid } = await makeGroup(env);
  // 运营者的审核通道：群主的另一个通道充当，npm run mod -- inbox 写的就是这个键
  const inbox = await json(await handleAddChannel(req("POST", `/account/${O.id}/channels`, { secret: O.secret, body: { name: "审核" } }), env, O.id));
  env.PIGEON_KV.store.set("config:mod_channel", inbox.json.data.channel.id);
  const report = (body) =>
    handleReport(req("POST", `/account/${M.id}/channels/${gid}/report`, { secret: M.secret, body }), env, M.id, gid).then(json);
  const toInbox = () => apns.filter((a) => a.payload.channel_id === inbox.json.data.channel.id);

  const before = toInbox().length;
  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await report({ reason: "spam", message_id: `m-${i}` })).status);
  check("连交 3 条都收下", statuses.every((s) => s === 200), statuses.join(","));
  check("★ 运营者只收到第一条的通知", toInbox().length === before + 1, String(toInbox().length - before));
  check("3 条举报都落了盘", [0, 1, 2].every((i) => env.PIGEON_KV.store.has(`report:${gid}:${M.id}:m-${i}`)));

  // 窗口过去了
  const note = JSON.parse(env.PIGEON_KV.store.get(`modnote:${gid}`));
  env.PIGEON_KV.store.set(`modnote:${gid}`, JSON.stringify({ ...note, until: Date.now() - 1 }));
  await report({ reason: "harassment", message_id: "m-3" });
  const latest = toInbox().at(-1)?.payload.aps.alert.body ?? "";
  check("★ 下一次通知写明「又收到 2 条」", latest.includes("上次通知之后又收到 2 条"), latest);

  check("第 5 条仍收下", (await report({ reason: "spam", message_id: "m-4" })).status === 200);
  const sixth = await report({ reason: "spam", message_id: "m-5" });
  check("★ 第 6 条 → 429", sixth.status === 429, JSON.stringify(sixth.json));
  check("说明了每小时的上限", (sixth.json.error ?? "").includes("每小时最多 5 次"), sixth.json.error);
  const wait = Number(sixth.headers.get("retry-after"));
  check("Retry-After 是到整点的秒数，与 body 一致", wait >= 1 && wait <= 3600 && sixth.json.retry_after === wait, String(wait));
  check("被拦下的举报没落盘", !env.PIGEON_KV.store.has(`report:${gid}:${M.id}:m-5`));

  const bad = await report({ reason: "nope" });
  check("填错参数的 400 不占额度（已经满了也照样先报参数错）", bad.status === 400);
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
