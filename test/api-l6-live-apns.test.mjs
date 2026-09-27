/**
 * 实时活动的推送：开始、认领更新、结束三种事件真正发给 APNs 的样子，以及什么时候不该发。
 *
 *   node test/api-l6-live-apns.test.mjs
 *
 * 不连 wrangler dev：在进程里打包 src（推送、实时活动、整个 Worker 入口），KV 放内存里，APNs 换成截获请求的假 fetch。
 * 放在 api 测试一起跑（run-api.sh 会带上 BASE，这里用不着）—— 实时活动出错的方式全是静默的：主题少了后缀、
 * 状态字段名对不上、时刻单位错了，APNs 照样回 200 或者手机上什么都不发生，只有逐项钉死。
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
    ].join("\n"),
    resolveDir: ROOT,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  outfile: OUT,
  logLevel: "error",
});
const live = await import(OUT);
const { announceAck, deliver, deliveryCost, runReminders, worker, ATTRIBUTES_TYPE, LIVE_DISMISS_AFTER_MS } = live;

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `  → ${detail}` : ""}`);
  }
}

// ── 假 APNs ─────────────────────────────────────────────────────────

/** 截下来的请求：{ token, host, headers, payload } */
let apns = [];
/** 按请求决定回什么：返回 [状态码, reason] */
let reply = () => [200, ""];
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  const entry = { token: u.pathname.split("/").pop(), host: u.host, headers: init.headers, payload: JSON.parse(init.body) };
  apns.push(entry);
  const [status, reason] = reply(entry);
  return new Response(status === 200 ? "" : JSON.stringify({ reason }), { status });
};
const liveRequests = () => apns.filter((a) => a.headers["apns-push-type"] === "liveactivity");
const alerts = () => apns.filter((a) => a.headers["apns-push-type"] === "alert");
const reset = () => {
  apns = [];
  reply = () => [200, ""];
};

function memoryKV() {
  const store = new Map();
  const meta = new Map();
  const ttl = new Map();
  let failList = false;
  return {
    store, meta, ttl,
    set failList(v) { failList = v; },
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value, opts) {
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

const { privateKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const sha = (text) => createHash("sha256").update(text).digest("hex");
const SECRET = "secret-for-tests";

/** 设备：推送令牌 + 可选的开始令牌。令牌都是十六进制，一眼看得出是谁的 */
const device = (tag, { start = true, env = "sandbox" } = {}) => ({
  token: tag.padEnd(64, "0"),
  env,
  name: tag,
  addedAt: 0,
  ...(start ? { activityStartToken: `5${tag}`.padEnd(64, "a"), activityStartTokenAt: 0 } : {}),
});

function makeEnv({ group = false, defaults, policy, ownerPrefs, memberPrefs, ownerDevices, memberDevices } = {}) {
  const kv = memoryKV();
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

const recordOf = (kv, mid) => {
  const raw = kv.store.get(`la:chanL001:${encodeURIComponent(mid)}`);
  return raw === undefined ? null : JSON.parse(raw);
};
const entriesOf = (kv, mid) => [...kv.store.keys()].filter((k) => k.startsWith(`la:chanL001:${encodeURIComponent(mid)}:`));

const hit = (env, path, init = {}) => worker.fetch(new Request(`https://nfo.im${path}`, init), env);
const put = (body) => ({ method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` }, body: JSON.stringify(body) });

/** 手机登记这件事的更新令牌（走真的接口） */
async function register(env, who, dev, mid, token, startedAt) {
  const res = await hit(env, `/account/${who.id}/activities/chanL001/${encodeURIComponent(mid)}`, put({ token, device: dev.token, started_at: startedAt }));
  return { status: res.status, json: await res.json() };
}

// ── 开始 ────────────────────────────────────────────────────────────

console.log("\n★ 开始：push-to-start 的样子");
{
  const { env, kv, channel, recipients, owner } = makeEnv();
  reset();
  const before = Date.now();
  const report = await deliver(env, channel, recipients, {
    title: "主库连不上", body: "db-01 无响应", id: "db-01", status: "firing", level: "timeSensitive", live: "1",
  });
  const [req] = liveRequests();
  check("普通通知照常送达", report.delivered === 1 && alerts().length === 1);
  check("★ 另发一条实时活动的推送，响应里 live.started = 1", liveRequests().length === 1 && report.live?.started === 1, JSON.stringify(report.live));
  check("★ 发往这台设备的 push-to-start 令牌，不是推送令牌", req?.token === owner.devices[0].activityStartToken);
  check("沙盒设备走沙盒主机", req?.host === "api.sandbox.push.apple.com");
  check("★ apns-push-type = liveactivity", req?.headers["apns-push-type"] === "liveactivity");
  check("★ apns-topic 带 .push-type.liveactivity 后缀", req?.headers["apns-topic"] === "im.nfo.pigeon.push-type.liveactivity", req?.headers["apns-topic"]);
  check("普通通知的主题不受影响", alerts()[0]?.headers["apns-topic"] === "im.nfo.pigeon");
  check("apns-priority 10", req?.headers["apns-priority"] === "10");
  const expiration = Number(req?.headers["apns-expiration"]);
  check("★ 最多在 APNs 那里等 8 小时", expiration >= Math.floor(before / 1000) + 8 * 3600 - 1 && expiration <= Math.floor(Date.now() / 1000) + 8 * 3600 + 1, String(expiration));
  const aps = req?.payload.aps ?? {};
  check("aps.event = start", aps.event === "start");
  check("★ timestamp 是 1970 年起的秒（不是毫秒）", Number.isInteger(aps.timestamp) && Math.abs(aps.timestamp - Date.now() / 1000) < 5, String(aps.timestamp));
  check("★ attributes-type 与 App 的类型名一致", aps["attributes-type"] === "IncidentAttributes" && ATTRIBUTES_TYPE === "IncidentAttributes");
  const sentAt = alerts()[0]?.payload.sent_at;
  check("★ content-state：标题、firing、开始时刻（毫秒，就是普通通知的 sent_at）",
    JSON.stringify(aps["content-state"]) === JSON.stringify({ title: "主库连不上", status: "firing", startedAt: sentAt }), JSON.stringify(aps["content-state"]));
  const attrs = aps.attributes ?? {};
  check("★ attributes：通道、消息 id、通道名、标题、开始时刻",
    attrs.channelId === "chanL001" && attrs.messageId === "db-01" && attrs.channelName === "线上告警" && attrs.title === "主库连不上" && attrs.startedAt === sentAt,
    JSON.stringify(attrs));
  check("★ attributes 带认领凭据，与普通通知的 ack_sig 相同", typeof attrs.ackSig === "string" && attrs.ackSig === alerts()[0]?.payload.ack_sig);
  check("明文消息不标 sealed", attrs.sealed === undefined);
  check("★ 开始必带 alert（Apple 的要求），标题 + 通道名", aps.alert?.title === "主库连不上" && aps.alert?.body === "线上告警", JSON.stringify(aps.alert));
  check("★ alert 不带铃声：普通通知已经在响", aps.alert && !("sound" in aps.alert) && !("sound" in aps));
  check("iOS 18 要显式要更新令牌：input-push-token = 1", aps["input-push-token"] === 1);
  check("时效性的排前面：relevance-score 100", aps["relevance-score"] === 100);
  check("payload 顶层只有 aps（不夹带普通通知的字段）", Object.keys(req?.payload ?? {}).join() === "aps");
  const record = recordOf(kv, "db-01");
  check("★ 记下这件事：只有开始时刻，没有标题正文", record && record.startedAt === sentAt && Object.keys(record).join() === "startedAt", JSON.stringify(record));

  reset();
  const again = await deliver(env, channel, recipients, { title: "主库连不上", id: "db-01", status: "firing", level: "timeSensitive", live: "1" });
  check("★ 进行中再推一次 firing：普通通知照发，不再开第二块", alerts().length === 1 && liveRequests().length === 0 && again.live?.started === 0, JSON.stringify(again.live));
  check("开始时刻不被改写", recordOf(kv, "db-01")?.startedAt === sentAt);
}

console.log("\n★ 开始：标题从哪来");
{
  const { env, channel, recipients } = makeEnv();
  reset();
  await deliver(env, channel, recipients, { body: "\n\n  磁盘剩 3%\n第二行", id: "disk", status: "firing", live: "1" });
  const aps = liveRequests()[0]?.payload.aps ?? {};
  check("没标题：取正文第一个非空行", aps.attributes?.title === "磁盘剩 3%" && aps["content-state"]?.title === "磁盘剩 3%", JSON.stringify(aps.attributes));
  check("普通级别：relevance-score 50", aps["relevance-score"] === 50);

  reset();
  await deliver(env, channel, recipients, { ciphertext: "Y2lwaGVy", iv: "aXY=", id: "sealed", status: "firing", live: "1" });
  const sealed = liveRequests()[0]?.payload.aps ?? {};
  check("★ 只有密文：标题是占位「加密消息」，标上 sealed，手机从历史里换真标题",
    sealed.attributes?.title === "加密消息" && sealed.attributes?.sealed === true && sealed.alert?.title === "加密消息", JSON.stringify(sealed.attributes));
  check("★ 密文不进实时活动的推送", !JSON.stringify(liveRequests()[0]?.payload ?? {}).includes("Y2lwaGVy"));

  reset();
  const long = "很长的标题".repeat(100);
  await deliver(env, channel, recipients, { title: long, id: "long", status: "firing", live: "1" });
  const big = liveRequests()[0];
  check("超长标题截到 80 字", Array.from(big?.payload.aps.attributes.title ?? "").length === 80);
  check("★ 实时活动的 payload 不超过 4KB", Buffer.byteLength(JSON.stringify(big?.payload ?? {})) <= 4096);
}

console.log("\n★ 开始：什么时候不开");
{
  const cases = [
    ["没要 live", {}, { title: "t", id: "x1", status: "firing" }],
    ["live=0", {}, { title: "t", id: "x2", status: "firing", live: "0" }],
    ["没有 status", {}, { title: "t", id: "x3", live: "1" }],
    ["★ 没给 id（服务端补的 id 以后没人能引用，开了永远等不到结束）", {}, { title: "t", status: "firing", live: "1" }],
    ["★ passive：本来就是「别打扰」", {}, { title: "t", id: "x5", status: "firing", live: "1", level: "passive" }],
    ["★ 通道免打扰时段：和普通通知一样压低", { policy: { quietHours: { start: "00:00", end: "23:59", timezone: "UTC" } } }, { title: "t", id: "x6", status: "firing", live: "1" }],
    ["★ 接收者给这个通道开了免打扰", { ownerPrefs: { mutes: { chanL001: 0 } } }, { title: "t", id: "x7", status: "firing", live: "1" }],
    ["设备没登记开始令牌（关着「事件用实时活动显示」或旧版 App）", { ownerDevices: [device("c1", { start: false })] }, { title: "t", id: "x8", status: "firing", live: "1" }],
  ];
  for (const [label, setup, params] of cases) {
    const { env, channel, recipients, kv } = makeEnv(setup);
    reset();
    const report = await deliver(env, channel, recipients, params);
    const stored = [...kv.store.keys()].filter((k) => k.startsWith("la:"));
    check(label, liveRequests().length === 0 && stored.length === 0 && alerts().length >= 1, `${liveRequests().length} 条实时活动推送，${stored.join(" ")}`);
    void report;
  }

  {
    const { env, channel, recipients } = makeEnv();
    reset();
    await deliver(env, channel, recipients, { title: "t", id: "x4", status: "resolved", live: "1" });
    check("status=resolved 从不开新的（结束才用它）", !liveRequests().some((r) => r.payload.aps.event === "start"));
  }

  const { env, channel, recipients } = makeEnv({ ownerPrefs: { mutes: { chanL001: 0 } } });
  reset();
  await deliver(env, channel, recipients, { title: "t", id: "crit", status: "firing", live: "1", level: "critical" });
  check("★ critical 穿过接收者的免打扰，照样开", liveRequests().length === 1);

  const mixed = makeEnv({ group: true, memberPrefs: { mutes: { chanL001: 0 } } });
  reset();
  const report = await deliver(mixed.env, mixed.channel, mixed.recipients, { title: "t", id: "grp", status: "firing", live: "1" });
  check("★ 群里只有设了免打扰的那个人不开，其他人照开", liveRequests().length === 1 && liveRequests()[0].token === mixed.owner.devices[0].activityStartToken && report.live?.started === 1);

  const failed = makeEnv({ ownerDevices: [device("d1"), device("d2")] });
  reset();
  reply = (req) => (req.token === failed.owner.devices[1].token ? [410, "Unregistered"] : [200, ""]);
  await deliver(failed.env, failed.channel, failed.recipients, { title: "t", id: "dead", status: "firing", live: "1" });
  check("★ 普通通知没送到的设备（令牌失效）不开", liveRequests().length === 1 && liveRequests()[0].token === failed.owner.devices[0].activityStartToken);

  const byDefault = makeEnv({ defaults: { live: "1" } });
  reset();
  await deliver(byDefault.env, byDefault.channel, byDefault.recipients, live.withDefaults(byDefault.channel, { title: "t", id: "dflt", status: "firing" }));
  check("★ 通道默认值开着 live：不带参数也开", liveRequests().length === 1);
  reset();
  await deliver(byDefault.env, byDefault.channel, byDefault.recipients, live.withDefaults(byDefault.channel, { title: "t", id: "dflt2", status: "firing", live: "0" }));
  check("★ 这一条带 live=0：盖过通道默认值，不开", liveRequests().length === 0);

  // 通道默认值原样存（接口不规整开关），用接口设成 "true" 的也认
  const spelled = makeEnv({ defaults: { live: "true" } });
  reset();
  await deliver(spelled.env, spelled.channel, spelled.recipients, live.withDefaults(spelled.channel, { title: "t", id: "dflt3", status: "firing" }));
  check("通道默认值写成 \"true\" 也算开着", liveRequests().length === 1);
}

// ── 登记、认领、结束的完整来回 ───────────────────────────────────────

console.log("\n★ 登记更新令牌 → 认领 → 恢复");
{
  const { env, kv, channel, recipients, owner, member } = makeEnv({ group: true });
  reset();
  await deliver(env, channel, recipients, { title: "官网 掉线了", id: "site:down", status: "firing", live: "1", level: "timeSensitive" });
  check("群里两个人的设备各开一块", liveRequests().length === 2);
  const startedAt = recordOf(kv, "site:down")?.startedAt;

  const mine = await register(env, owner, owner.devices[0], "site:down", "ab".repeat(40), startedAt);
  check("★ 登记更新令牌 → registered、firing", mine.status === 200 && mine.json?.data?.registered === true && mine.json?.data?.status === "firing", JSON.stringify(mine.json));
  const keys = entriesOf(kv, "site:down");
  check("★ 一台设备一条，键里只有账号 id 和令牌摘要，令牌在 metadata 里",
    keys.length === 1 && keys[0].endsWith(`:owner001.${sha(owner.devices[0].token).slice(0, 16)}`) && kv.meta.get(keys[0])?.t === "ab".repeat(40) && kv.meta.get(keys[0])?.s === startedAt,
    keys.join(" "));
  check("★ 消息 id 里的冒号编了码：前缀列不到别的 id", keys[0].startsWith("la:chanL001:site%3Adown:"));
  check("更新令牌 12 小时后自己过期", kv.ttl.get(keys[0]) === 12 * 3600);
  const again = await register(env, owner, owner.devices[0], "site:down", "cd".repeat(40), startedAt);
  check("同一台设备换了令牌：覆盖，不多一条", again.json?.data?.registered === true && entriesOf(kv, "site:down").length === 1 && kv.meta.get(keys[0])?.t === "cd".repeat(40));
  await register(env, member, member.devices[0], "site:down", "ef".repeat(40), startedAt);
  check("群成员也能登记", entriesOf(kv, "site:down").length === 2);

  reset();
  const ack = await announceAck(env, channel, recipients, "site:down", "张三");
  const updates = liveRequests();
  check("认领广播照发", ack.delivered === 2 && alerts().length === 2);
  check("★ 给两块活动各推一次 update", updates.length === 2 && updates.every((u) => u.payload.aps.event === "update"), updates.map((u) => u.token).join());
  check("★ 推给更新令牌", new Set(updates.map((u) => u.token)).has("cd".repeat(40)) && new Set(updates.map((u) => u.token)).has("ef".repeat(40)));
  const state = updates[0]?.payload.aps["content-state"] ?? {};
  check("★ content-state：acked、谁、开始时刻；不带标题（服务端不存标题，手机沿用开始时的）",
    JSON.stringify(state) === JSON.stringify({ status: "acked", ackBy: "张三", startedAt }), JSON.stringify(state));
  check("有人在管了：relevance-score 降到 30", updates[0]?.payload.aps["relevance-score"] === 30);
  check("update 不带 alert（认领不该再吵一遍）", !("alert" in (updates[0]?.payload.aps ?? {})));
  check("★ 记录里记下谁在处理", recordOf(kv, "site:down")?.ackBy === "张三");

  // 认领之后才开起来的手机：登记时直接告诉它
  const late = makeEnv({ group: true });
  void late;
  const lateReg = await register(env, member, member.devices[0], "site:down", "ef".repeat(40), startedAt);
  check("★ 认领之后才来登记：回 acked 和谁", lateReg.json?.data?.status === "acked" && lateReg.json?.data?.ack_by === "张三", JSON.stringify(lateReg.json));

  reset();
  const resolvedAt = Date.now();
  const report = await deliver(env, channel, recipients, { body: "已恢复", id: "site:down", status: "resolved" });
  const ends = liveRequests();
  check("★ 恢复（这条没带 live）：照样结束两块", ends.length === 2 && ends.every((e) => e.payload.aps.event === "end") && report.live?.ended === 2, JSON.stringify(report.live));
  const endState = ends[0]?.payload.aps["content-state"] ?? {};
  check("★ content-state：resolved、开始与恢复时刻（毫秒）、认领人",
    endState.status === "resolved" && endState.startedAt === startedAt && endState.resolvedAt >= resolvedAt && endState.ackBy === "张三" && !("title" in endState), JSON.stringify(endState));
  const dismiss = ends[0]?.payload.aps["dismissal-date"];
  check("★ dismissal-date：恢复后 15 分钟（秒）", Math.abs(dismiss - (endState.resolvedAt + LIVE_DISMISS_AFTER_MS) / 1000) <= 2, `${dismiss} vs ${(endState.resolvedAt + LIVE_DISMISS_AFTER_MS) / 1000}`);
  check("end 走同样的主题和推送类型", ends.every((e) => e.headers["apns-topic"] === "im.nfo.pigeon.push-type.liveactivity" && e.headers["apns-priority"] === "10"));
  check("★ 更新令牌删光了", entriesOf(kv, "site:down").length === 0);
  const tomb = recordOf(kv, "site:down");
  check("★ 记录留作墓碑：结束时刻、方式、认领人", tomb?.endedAt === endState.resolvedAt && tomb?.end === "resolved" && tomb?.ackBy === "张三" && tomb?.startedAt === startedAt, JSON.stringify(tomb));

  const straggler = await register(env, owner, owner.devices[0], "site:down", "99".repeat(40), startedAt);
  check("★ 结束之后才来登记（推送晚到）：不登记，回 ended，App 当场收起",
    straggler.json?.data?.registered === false && straggler.json?.data?.ended === true && straggler.json?.data?.status === "resolved" && straggler.json?.data?.ended_at === tomb.endedAt,
    JSON.stringify(straggler.json));
  check("没有多出令牌", entriesOf(kv, "site:down").length === 0);

  reset();
  await announceAck(env, channel, recipients, "site:down", "李四");
  check("已经结束的：再认领也不推 update", liveRequests().length === 0);

  // 同一个 id 又触发了一次
  reset();
  await deliver(env, channel, recipients, { title: "官网 掉线了", id: "site:down", status: "firing", live: "1" });
  const second = recordOf(kv, "site:down");
  check("★ 恢复之后同一个 id 再触发：重新开，墓碑换成新的记录", liveRequests().length === 2 && second && !second.endedAt && second.startedAt > startedAt && !second.ackBy, JSON.stringify(second));
  const fresh = await register(env, owner, owner.devices[0], "site:down", "77".repeat(40), second.startedAt);
  check("新一次的活动照常登记，上一次的认领不算数", fresh.json?.data?.registered === true && fresh.json?.data?.status === "firing", JSON.stringify(fresh.json));
}

console.log("\n★ 撤回：立即收起");
{
  const { env, kv, channel, recipients, owner } = makeEnv();
  reset();
  await deliver(env, channel, recipients, { title: "误报", id: "oops", status: "firing", live: "1" });
  const startedAt = recordOf(kv, "oops").startedAt;
  await register(env, owner, owner.devices[0], "oops", "12".repeat(40), startedAt);
  reset();
  const report = await deliver(env, channel, recipients, { id: "oops", delete: "1" });
  const [end] = liveRequests();
  check("撤回照常推「此消息已撤回」", report.retracted === true && alerts().length === 1);
  check("★ 推 end，dismissal-date 已经过去（立即收起）", end?.payload.aps.event === "end" && end.payload.aps["dismissal-date"] < Date.now() / 1000, JSON.stringify(end?.payload.aps));
  check("撤回的最终状态写「此消息已撤回」", end?.payload.aps["content-state"]?.title === "此消息已撤回");
  check("★ 墓碑记为 retracted，令牌删掉", recordOf(kv, "oops")?.end === "retracted" && entriesOf(kv, "oops").length === 0);
  const after = await register(env, owner, owner.devices[0], "oops", "34".repeat(40), startedAt);
  check("撤回之后来登记：回 ended、retracted", after.json?.data?.ended === true && after.json?.data?.status === "retracted");
}

console.log("\n★ 结束：什么时候读、什么时候写");
{
  const { env, kv, channel, recipients } = makeEnv({ ownerDevices: [device("e1", { start: false })] });
  reset();
  await deliver(env, channel, recipients, { body: "好了", id: "plain", status: "resolved" });
  check("★ 接收者都没登记开始令牌：恢复消息不碰实时活动（老用户的推送不多一次读写）", liveRequests().length === 0 && ![...kv.store.keys()].some((k) => k.startsWith("la:")));

  const tokens = makeEnv();
  reset();
  await deliver(tokens.env, tokens.channel, tokens.recipients, { body: "好了", id: "never", status: "resolved" });
  check("有开始令牌、但这件事从没开过活动：不推、不立墓碑", liveRequests().length === 0 && recordOf(tokens.kv, "never") === null);

  reset();
  const report = await deliver(tokens.env, tokens.channel, tokens.recipients, { body: "好了", id: "race", status: "resolved", live: "1" });
  check("★ 这条恢复自己要了 live、却什么都没读到（开始的记录还没同步过来）：立一块墓碑", recordOf(tokens.kv, "race")?.endedAt > 0 && liveRequests().length === 0 && report.live === undefined, JSON.stringify(recordOf(tokens.kv, "race")));
  const late = await register(tokens.env, tokens.owner, tokens.owner.devices[0], "race", "56".repeat(40), recordOf(tokens.kv, "race").endedAt - 5000);
  check("随后开起来的活动来登记：告诉它已经结束了", late.json?.data?.ended === true);
}

console.log("\n★ 实时活动出错不影响普通推送");
{
  const { env, kv, channel, recipients, owner } = makeEnv();
  reset();
  reply = (req) => (req.headers["apns-push-type"] === "liveactivity" ? [400, "BadDeviceToken"] : [200, ""]);
  const report = await deliver(env, channel, recipients, { title: "t", id: "bad", status: "firing", live: "1" });
  check("★ 实时活动被 APNs 拒了：普通推送照样算送达，结果里只有它自己", report.delivered === 1 && report.results.length === 1 && report.live?.started === 0, JSON.stringify(report));
  check("失败的开始令牌不当成推送令牌立失效墓碑", ![...kv.store.keys()].some((k) => k.startsWith("dead:")));
  check("★ 一块都没开成：不记「开着」", recordOf(kv, "bad") === null);
  reset();
  const retry = await deliver(env, channel, recipients, { title: "t", id: "bad", status: "firing", live: "1" });
  check("★ 发送方下一次重发 firing：再试一次，这回开成了", retry.live?.started === 1 && recordOf(kv, "bad") !== null);

  reset();
  await register(env, owner, owner.devices[0], "bad", "78".repeat(40), recordOf(kv, "bad").startedAt);
  kv.failList = true;
  const broken = await deliver(env, channel, recipients, { body: "好了", id: "bad", status: "resolved" });
  kv.failList = false;
  check("★ 结束时列不出令牌（存储出错）：恢复消息照常送达，不抛", broken.delivered === 1);

  reset();
  await deliver(env, channel, recipients, { title: "t", id: "gone", status: "firing", live: "1" });
  await register(env, owner, owner.devices[0], "gone", "9a".repeat(40), recordOf(kv, "gone").startedAt);
  reply = (req) => (req.headers["apns-push-type"] === "liveactivity" ? [410, "Unregistered"] : [200, ""]);
  await announceAck(env, channel, recipients, "gone", "机主");
  check("★ 更新令牌失效（活动被划掉了）：删掉那一条", entriesOf(kv, "gone").length === 0);
}

console.log("\n★ 补发的提醒不重开");
{
  const { env, kv, channel, recipients } = makeEnv();
  reset();
  await deliver(env, channel, recipients, { title: "t", id: "rep", status: "firing", live: "1", repeat: "5", level: "timeSensitive" });
  check("原消息开了一块", liveRequests().length === 1);
  // 让记录消失（过期）也不该在补发时重开
  kv.store.delete(`la:chanL001:rep`);
  const record = JSON.parse(kv.store.get("repeat:chanL001:rep"));
  kv.store.set("repeat:chanL001:rep", JSON.stringify({ ...record, nextAt: 0 }));
  kv.meta.set("repeat:chanL001:rep", { nextAt: 0 });
  reset();
  await runReminders(env, Date.now() + 1000);
  check("★ 补发照常响，但不开实时活动", alerts().length === 1 && alerts()[0].payload.reminder === "2" && liveRequests().length === 0, `${alerts().length} / ${liveRequests().length}`);
}

console.log("\n★ 退了群的人不再更新");
{
  const { env, kv, channel, recipients, owner, member } = makeEnv({ group: true });
  reset();
  await deliver(env, channel, recipients, { title: "t", id: "left", status: "firing", live: "1" });
  const startedAt = recordOf(kv, "left").startedAt;
  await register(env, owner, owner.devices[0], "left", "a1".repeat(40), startedAt);
  await register(env, member, member.devices[0], "left", "b2".repeat(40), startedAt);
  reset();
  await announceAck(env, { ...channel, memberIds: [] }, [owner], "left", "机主");
  check("只推给还在群里的人", liveRequests().length === 1 && liveRequests()[0].token === "a1".repeat(40));
}

console.log("\n★ 子请求预算");
{
  const plain = [{ devices: [device("p1", { start: false }), device("p2", { start: false })] }];
  const withLive = [{ devices: [device("p1"), device("p2", { start: false })] }];
  check("没登记开始令牌：预算和以前一样", deliveryCost(plain) === 12 + 3 * 2, String(deliveryCost(plain)));
  check("★ 登记了的设备另算（读写记录 + 每台推送、删令牌）", deliveryCost(withLive) === 12 + 3 * 2 + 4 + 3, String(deliveryCost(withLive)));
}

console.log("\n★ 参数：live 是开关");
{
  const params = live.paramsFromJson({ title: "t", live: true });
  check("live: true → \"1\"", params.live === "1");
  check("live=yes → \"1\"，off → \"0\"", live.paramsFromJson({ live: "yes" }).live === "1" && live.paramsFromJson({ live: "off" }).live === "0");
  check("live 不算「不生效的参数」", !live.ignoredParams({ live: "1" }).includes("live"));
  check("普通通知的 payload 里不带 live", !("live" in live.buildPayload({ body: "b", live: "1" }, "c")));
}

if (failures > 0) {
  console.log(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\n实时活动（进程内）全部通过");
