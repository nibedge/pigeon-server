/**
 * 通知体检与告警演练的完整来回：在进程里跑整个 Worker，内存 KV + 截获 APNs 的假 fetch，手动触发重复提醒的 cron。
 *
 *   node test/api-l5-selftest-flow.test.mjs
 *
 * 本地 wrangler dev 没有 APNs 私钥，推送一律失败、演练也就排不上提醒 —— 那一路（真推出去、约一分钟后补一次、
 * 点「知道了」、推「已恢复」）只能在这里走通。文件名以 api 开头是为了让 run-api.sh 顺带跑它（它不用 BASE），
 * 用不着再往 package.json 的 test 里加一段。
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = `${ROOT}.test-build/l5/index.mjs`;
mkdirSync(`${ROOT}.test-build/l5`, { recursive: true });
await build({ entryPoints: [`${ROOT}src/index.ts`], bundle: true, format: "esm", outfile: OUT, logLevel: "error" });
const { default: worker } = await import(OUT);

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `  → ${detail}` : ""}`);
  }
}

// ── 桩：内存 KV（带 metadata 和过期时刻）、假 APNs ────────────────────

function memoryKV() {
  const store = new Map();
  const meta = new Map();
  const expiry = new Map();
  return {
    store,
    meta,
    expiry,
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value, opts = {}) {
      store.set(key, value);
      if (opts.metadata !== undefined) meta.set(key, opts.metadata);
      else meta.delete(key);
      if (opts.expiration) expiry.set(key, opts.expiration);
      else if (opts.expirationTtl) expiry.set(key, Math.floor(Date.now() / 1000) + opts.expirationTtl);
      else expiry.delete(key);
    },
    async delete(key) {
      store.delete(key);
      meta.delete(key);
      expiry.delete(key);
    },
    async list({ prefix = "" } = {}) {
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .sort()
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

/** 截下来的 APNs 请求。refuse 里的 token 回 410 Unregistered，模拟删了 App 的设备 */
const apns = [];
const refuse = new Set();
globalThis.fetch = async (url, init) => {
  const token = String(url).split("/").at(-1);
  apns.push({ url: String(url), token, headers: init.headers, payload: JSON.parse(init.body) });
  if (refuse.has(token)) return new Response(JSON.stringify({ reason: "Unregistered" }), { status: 410 });
  return new Response("", { status: 200 });
};
const since = (mark) => apns.slice(mark);

const env = {
  PIGEON_KV: memoryKV(),
  APNS_KEY_P8: privateKey,
  APNS_KEY_ID: "ABC1234DEF",
  APNS_TEAM_ID: "TEAM567890",
  APNS_TOPIC: "im.nfo.pigeon",
};
const kv = env.PIGEON_KV;

async function call(method, path, { body, secret } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (secret) headers.authorization = `Bearer ${secret}`;
  const res = await worker.fetch(
    new Request(`https://nfo.im${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }),
    env,
    {},
  );
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 交给断言 */
  }
  return { status: res.status, json, data: json?.data };
}

/** 跑一轮重复提醒的 cron（scheduledTime = at），等它做完 */
async function reminderCron(at) {
  const pending = [];
  await worker.scheduled({ cron: "2-59/5 * * * *", scheduledTime: at }, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
}

let seq = 0;
const token = () => `${(++seq).toString(16).padStart(4, "0")}l5`.padEnd(64, "a").replace(/[^0-9a-f]/g, "b");

async function newAccount() {
  const t = token();
  const r = await call("POST", "/account", { body: { device_token: t, environment: "sandbox", device_name: "iPhone" } });
  return { id: r.data.account_id, secret: r.data.secret, channel: r.data.channels[0].id, token: t };
}

// ── 往返测速 ────────────────────────────────────────────────────────

console.log("\n往返测速：本机推测试通知，别的设备只探测");
const A = await newAccount();
const ipadToken = token();
await call("POST", `/account/${A.id}/devices`, { secret: A.secret, body: { device_token: ipadToken, environment: "production", device_name: "iPad" } });
const selftest = (body, who = A) => call("POST", `/account/${who.id}/selftest`, { secret: who.secret, body });
{
  const mark = apns.length;
  const before = Date.now();
  const r = await selftest({ token_prefix: A.token.slice(0, 12), environment: "sandbox" });
  const d = r.data ?? {};
  check("★ 200", r.status === 200, JSON.stringify(r.json));
  check("回 nonce、发出时刻、过期时刻（10 分钟）", typeof d.nonce === "string" && d.sent_at >= before && d.expires_at === d.sent_at + 600_000, JSON.stringify(d));
  check("★ 本机在账号里、推送环境对得上", d.this_device?.registered === true && d.this_device?.environment === "sandbox" && d.this_device?.environment_matches === true && d.this_device?.name === "iPhone", JSON.stringify(d.this_device));
  const mine = d.devices?.find((x) => x.this_device);
  const ipad = d.devices?.find((x) => !x.this_device);
  check("★ 本机：推了测试通知，APNs 收下", mine?.kind === "alert" && mine?.status === 200 && mine?.token_prefix === A.token.slice(0, 12), JSON.stringify(d.devices));
  check("★ 另一台：只探测，不打扰", ipad?.kind === "probe" && ipad?.status === 200 && ipad?.name === "iPad" && ipad?.environment === "production", JSON.stringify(ipad));
  check("delivered 只数测试通知", d.delivered === 1);
  check("没有毛病", Array.isArray(d.problems) && d.problems.length === 0, JSON.stringify(d.problems));
  check("没有被压成静默的通道", Array.isArray(d.silenced) && d.silenced.length === 0, JSON.stringify(d.silenced));

  const sent = since(mark);
  const alert = sent.find((a) => a.token === A.token);
  const probe = sent.find((a) => a.token === ipadToken);
  check("一共打了两次 APNs", sent.length === 2, JSON.stringify(sent.map((s) => s.token.slice(0, 6))));
  check("★ 测试通知带 selftest = nonce、sent_at", alert?.payload.selftest === d.nonce && alert?.payload.sent_at === d.sent_at, JSON.stringify(alert?.payload));
  check("★ 不进历史（isarchive=0，老版 App 也认）、静默、不带声音", alert?.payload.isarchive === "0" && alert?.payload.aps["interruption-level"] === "passive" && alert?.payload.aps.sound === undefined);
  check("不挂在任何通道上", alert && !("channel_id" in alert.payload) && !("ack_sig" in alert.payload));
  check("★ 立即送达、折叠成一条、10 分钟后作废", alert?.headers["apns-priority"] === "10" && alert?.headers["apns-collapse-id"] === "pigeon-selftest" && alert?.headers["apns-expiration"] === String(Math.floor(d.expires_at / 1000)), JSON.stringify(alert?.headers));
  check("★ 探测是后台推送，不显示", probe?.payload.probe === "1" && probe?.headers["apns-push-type"] === "background" && probe?.payload.aps["content-available"] === 1, JSON.stringify(probe));
  const stored = await kv.get(`selftest:${A.id}:${d.nonce}`, "json");
  check("★ 记下 selftest:{账号}:{nonce}，10 分钟后过期，不含内容", stored?.kind === "roundtrip" && stored?.sentAt === d.sent_at && kv.expiry.get(`selftest:${A.id}:${d.nonce}`) === Math.floor(d.expires_at / 1000), JSON.stringify(stored));

  const full = await selftest({ token_prefix: A.token });
  check("给完整令牌也认得出本机", full.data?.this_device?.registered === true && full.data?.devices?.find((x) => x.this_device)?.kind === "alert");
}
{
  const r = await selftest({ token_prefix: A.token.slice(0, 12), environment: "production" });
  check("★ App 实际环境和登记的不一样 → environment_matches=false", r.data?.this_device?.environment_matches === false, JSON.stringify(r.data?.this_device));
  check("★ 并说清怎么修", r.data?.problems?.[0]?.code === "environment_mismatch" && /重新登记/.test(r.data?.problems?.[0]?.message ?? ""), JSON.stringify(r.data?.problems));

  const mark = apns.length;
  const ghost = await selftest({ token_prefix: "0123456789ab" });
  check("★ 本机不在账号里 → registered=false，并说明", ghost.status === 200 && ghost.data?.this_device?.registered === false && ghost.data?.problems?.[0]?.code === "not_registered", JSON.stringify(ghost.data));
  check("★ 这时一条测试通知都不推，账号里的设备照样探测", ghost.data?.delivered === 0 && since(mark).every((a) => a.payload.probe === "1") && since(mark).length === 2);

  const mark2 = apns.length;
  const any = await selftest({});
  check("★ 不指定本机（拿 curl 来试）：每台都推测试通知", any.data?.devices?.every((x) => x.kind === "alert") && since(mark2).length === 2 && since(mark2).every((a) => a.payload.selftest === any.data?.nonce), JSON.stringify(any.data?.devices));
  check("不指定本机就没有 this_device", !("this_device" in (any.data ?? {})));
}
{
  refuse.add(ipadToken);
  const r = await selftest({ token_prefix: A.token.slice(0, 12) });
  const bad = r.data?.problems?.find((p) => p.code === "device_invalid");
  check("★ 删了 App 的设备：状态 410、原因原样带回", r.data?.devices?.find((x) => x.name === "iPad")?.status === 410 && r.data?.devices?.find((x) => x.name === "iPad")?.reason === "Unregistered");
  check("★ 说清是哪台、怎么恢复", bad?.token_prefix === ipadToken.slice(0, 12) && /「iPad」/.test(bad?.message ?? "") && /打开一次 App/.test(bad?.message ?? ""), JSON.stringify(r.data?.problems));
  const tombstones = [...kv.store.keys()].filter((k) => k.startsWith("dead:"));
  check("★ 和平常推送一样立失效墓碑", tombstones.length === 1, JSON.stringify(tombstones));
  refuse.delete(ipadToken);
  const again = await call("GET", `/account/${A.id}`, { secret: A.secret });
  check("失效的设备在本人下次来访时从账号上摘掉", again.data?.devices?.length === 1);
  // 把 iPad 加回来，后面的演练还要用两台设备
  await call("POST", `/account/${A.id}/devices`, { secret: A.secret, body: { device_token: ipadToken, environment: "production", device_name: "iPad" } });
}
{
  // 此刻被压成静默的通道：自己开了免打扰的、正在免打扰时段里的，照投递时的规则算
  const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);
  const night = (await call("POST", `/account/${A.id}/channels`, { secret: A.secret, body: { name: "夜里别吵" } })).data.channel.id;
  await call("PATCH", `/account/${A.id}/channels/${night}`, {
    secret: A.secret,
    body: { policy: { quietHours: { start: hhmm(Date.now() - 3600_000), end: hhmm(Date.now() + 3600_000), timezone: "UTC" } } },
  });
  const later = (await call("POST", `/account/${A.id}/channels`, { secret: A.secret, body: { name: "白天" } })).data.channel.id;
  await call("PATCH", `/account/${A.id}/channels/${later}`, {
    secret: A.secret,
    body: { policy: { quietHours: { start: hhmm(Date.now() + 3 * 3600_000), end: hhmm(Date.now() + 4 * 3600_000), timezone: "UTC" } } },
  });
  await call("PATCH", `/account/${A.id}`, { secret: A.secret, body: { prefs_patch: { mutes: { [A.channel]: 0 } } } });
  // 最低提醒级别（接收方自己的设置）：设到时效性、紧急，普通消息就不响了，也算「此刻被压成静默」；设到普通不算
  const floor = (await call("POST", `/account/${A.id}/channels`, { secret: A.secret, body: { name: "只要紧急" } })).data.channel.id;
  const mild = (await call("POST", `/account/${A.id}/channels`, { secret: A.secret, body: { name: "普通以上" } })).data.channel.id;
  await call("PATCH", `/account/${A.id}`, { secret: A.secret, body: { prefs_patch: { minLevel: { [floor]: "critical", [mild]: "active" } } } });
  const r = await selftest({ token_prefix: A.token.slice(0, 12) });
  const byId = Object.fromEntries((r.data?.silenced ?? []).map((c) => [c.channel_id, c]));
  check("★ 列出自己开了免打扰的通道（0 = 一直）", byId[A.channel]?.muted_until === 0 && typeof byId[A.channel]?.name === "string", JSON.stringify(r.data?.silenced));
  check("★ 列出正在免打扰时段里的通道，带上时段", byId[night]?.quiet_hours?.timezone === "UTC" && !("muted_until" in byId[night]), JSON.stringify(byId[night]));
  check("★ 列出最低提醒级别设到紧急的通道，带上 min_level", byId[floor]?.min_level === "critical" && !("muted_until" in byId[floor]), JSON.stringify(byId[floor]));
  check("最低级别只到普通的不列（普通消息照响）", !(mild in byId));
  check("时段还没到的不列", !(later in byId) && r.data?.silenced?.length === 3);
  check("静默不算毛病：推送照常送达", r.data?.problems?.length === 0 && r.data?.delivered === 1);
  await call("PATCH", `/account/${A.id}`, { secret: A.secret, body: { prefs_patch: { mutes: null, minLevel: null } } });
  for (const cid of [night, later, floor, mild]) await call("DELETE", `/account/${A.id}/channels/${cid}`, { secret: A.secret });
}
{
  check("token_prefix 太短 → 400", (await selftest({ token_prefix: "abc" })).status === 400);
  check("token_prefix 有怪字符 → 400", (await selftest({ token_prefix: "0123456789ab/../" })).status === 400);
  check("environment 乱写 → 400", (await selftest({ environment: "dev" })).status === 400);
  check("没带凭据 → 401", (await call("POST", `/account/${A.id}/selftest`, { body: {} })).status === 401);
  check("凭据不对 → 401", (await call("POST", `/account/${A.id}/selftest`, { secret: "x".repeat(43), body: {} })).status === 401);
  check("GET → 405", (await call("GET", `/account/${A.id}/selftest`, { secret: A.secret })).status === 405);
}

// ── 告警演练 ────────────────────────────────────────────────────────

console.log("\n告警演练：真告警的全套路子，约一分钟后补一次");
let drill;
{
  const mark = apns.length;
  const r = await selftest({ drill: true, token_prefix: A.token.slice(0, 12), environment: "sandbox" });
  const d = r.data ?? {};
  drill = d;
  check("★ 200", r.status === 200, JSON.stringify(r.json));
  check("★ 演练 id 就是 nonce，挑的是自己的个人通道", d.drill?.id === d.nonce && d.drill?.channel_id === A.channel && typeof d.drill?.channel_name === "string", JSON.stringify(d.drill));
  check("两台设备都响（和真告警一样）", d.delivered === 2 && d.devices?.length === 2 && d.devices.every((x) => x.kind === "alert" && x.status === 200));
  check("本机标出来", d.devices?.filter((x) => x.this_device).length === 1 && d.this_device?.registered === true);
  const remindAt = d.drill?.remind_at;
  const minute = new Date(remindAt).getUTCMinutes();
  check("★ 第二次提醒落在 sent_at + 1 分钟之后的第一轮提醒巡检（每小时 2、7、12…分）",
    typeof remindAt === "number" && remindAt >= d.sent_at + 60_000 && remindAt < d.sent_at + 60_000 + 5 * 60_000 && remindAt % 60_000 === 0 && minute % 5 === 2,
    `${new Date(d.sent_at).toISOString()} → ${remindAt && new Date(remindAt).toISOString()}`);
  check("提醒截止在第一次补发之后不到一个间隔", d.drill?.remind_until === d.sent_at + 60_000 + 4 * 60_000, JSON.stringify(d.drill));
  check("没有毛病", d.problems?.length === 0 && d.warnings?.length === 0, JSON.stringify(d));

  const sent = since(mark);
  const p = sent[0]?.payload ?? { aps: {} };
  check("★ 时效性、带铃声", p.aps["interruption-level"] === "time-sensitive" && p.aps.sound === "default", JSON.stringify(p.aps));
  check("★ 个人通道的重复提醒按钮（「知道了，别再提醒」）", p.aps.category === "pigeonNotification.remind");
  check("★ 走真告警的字段：id、firing、repeat、认领凭据、通道", p.id === d.nonce && p.status === "firing" && p.repeat === "5" && typeof p.ack_sig === "string" && p.channel_id === A.channel, JSON.stringify(p));
  check("★ 带 selftest（NSE 记送达时刻），不进历史", p.selftest === d.nonce && p.isarchive === "0");
  check("按 id 折叠：补发原地替换", sent[0]?.headers["apns-collapse-id"] === d.nonce);

  const record = await kv.get(`repeat:${A.channel}:${d.nonce}`, "json");
  check("★ 重复提醒排上了：一分钟后第一次，截止在那之后 4 分钟", record?.nextAt === d.sent_at + 60_000 && record?.until === d.sent_at + 300_000 && record?.every === 5, JSON.stringify(record));
  check("★ 和真提醒一样占一个名额（满额规则照旧）", [...kv.store.keys()].some((k) => k === `rptslot:${A.id}:${A.channel}:${d.nonce}`));
  const stored = await kv.get(`selftest:${A.id}:${d.nonce}`, "json");
  check("记下演练推到哪个通道", stored?.kind === "drill" && stored?.channelId === A.channel);

  const early = apns.length;
  await reminderCron(remindAt - 5 * 60_000);
  check("没到点的那一轮不补发", since(early).length === 0);
  const due = apns.length;
  await reminderCron(remindAt);
  const reminders = since(due);
  check("★ 到点那一轮补发一次，两台设备都响", reminders.length === 2 && reminders.every((a) => a.payload.id === d.nonce), JSON.stringify(reminders.map((a) => a.payload.reminder)));
  check("★ 补发标着「第 2 次」、沿用原来的发出时刻", reminders[0]?.payload.reminder === "2" && reminders[0]?.payload.sent_at === d.sent_at);
  check("★ 补完一次就结束：记录和名额都删了", (await kv.get(`repeat:${A.channel}:${d.nonce}`)) === null && ![...kv.store.keys()].some((k) => k.startsWith(`rptslot:${A.id}:`)));
  const later = apns.length;
  await reminderCron(remindAt + 5 * 60_000);
  check("下一轮不再响", since(later).length === 0);
}
{
  const mark = apns.length;
  const r = await selftest({ drill_resolve: drill.nonce });
  const d = r.data ?? {};
  check("★ 收尾 → 200，没人点过「知道了」", r.status === 200 && d.drill?.id === drill.nonce && typeof d.drill?.resolved_at === "number" && d.drill?.acked === false, JSON.stringify(r.json));
  const sent = since(mark);
  const p = sent[0]?.payload ?? { aps: {} };
  check("★ 推「已恢复」：同一个 id、resolved、普通级别", sent.length === 2 && p.id === drill.nonce && p.status === "resolved" && p.aps["interruption-level"] === "active", JSON.stringify(p));
  check("「已恢复」也带 selftest、不进历史", p.selftest === drill.nonce && p.isarchive === "0");
  check("「已恢复」不带重复提醒", !("repeat" in p));
  const again = await selftest({ drill_resolve: drill.nonce });
  check("★ 重复收尾：不再推，回第一次收尾的时刻", again.status === 200 && again.data?.drill?.already_resolved === true && again.data?.drill?.resolved_at === d.drill?.resolved_at && apns.length === mark + 2);
}
{
  console.log("\n演练里点「知道了」：走平常的认领接口");
  const r = await selftest({ drill: true });
  const id = r.data?.nonce;
  const sig = apns.at(-1)?.payload.ack_sig;
  const ack = await call("POST", `/account/${A.id}/channels/${A.channel}/ack`, { secret: A.secret, body: { message_id: id, sig } });
  check("★ 认领 → 第一个", ack.status === 200 && ack.data?.first === true, JSON.stringify(ack.json));
  check("★ 认领撤掉了演练的补发", (await kv.get(`repeat:${A.channel}:${id}`)) === null);
  const mark = apns.length;
  await reminderCron(r.data?.drill?.remind_at);
  check("到点也不再响", since(mark).length === 0);
  const done = await selftest({ drill_resolve: id });
  check("★ 收尾时说得出点过「知道了」", done.data?.drill?.acked === true, JSON.stringify(done.data));
  check("收尾之后认领记录清掉（和真告警恢复一样）", (await kv.get(`ack:${A.channel}:${id}`)) === null);
}

console.log("\n演练挑通道、碰上真告警也会碰上的事");
{
  // 群：通道 id 指向群 → 400；默认挑的是个人通道
  const group = (await call("POST", `/account/${A.id}/channels`, { secret: A.secret, body: { name: "值班群", group: true } })).data.channel.id;
  const invite = (await call("POST", `/account/${A.id}/channels/${group}/invites`, { secret: A.secret })).data.code;
  const B = await newAccount();
  await call("POST", `/account/${B.id}/invites/${invite}`, { secret: B.secret });
  const inGroup = await selftest({ drill: true, channel_id: group });
  check("★ 群里不能演练（补发会吵到全群）", inGroup.status === 400 && /只有你自己/.test(inGroup.json?.message ?? ""), JSON.stringify(inGroup.json));
  const member = await selftest({ drill: true, channel_id: group }, B);
  check("成员拿群 id 来演练 → 404", member.status === 404);
  check("不存在的通道 → 404", (await selftest({ drill: true, channel_id: "nosuchchannel01" })).status === 404);
  check("通道 id 格式不对 → 400", (await selftest({ drill: true, channel_id: "a/b" })).status === 400);
  const fallback = await selftest({ drill: true }, B);
  check("★ B 自己的个人通道照样能演练", fallback.status === 200 && fallback.data?.drill?.channel_id === B.channel, JSON.stringify(fallback.json));
  await selftest({ drill_resolve: fallback.data?.drill?.id }, B);

  // 只收加密的通道：指定了 → 400；默认跳过它，挑下一个
  await call("PATCH", `/account/${B.id}/channels/${B.channel}`, { secret: B.secret, body: { policy: { e2eOnly: true } } });
  const sealed = await selftest({ drill: true, channel_id: B.channel }, B);
  check("★ 只收加密的通道 → 400，说明原因", sealed.status === 400 && /明文/.test(sealed.json?.message ?? ""), JSON.stringify(sealed.json));
  const none = await selftest({ drill: true }, B);
  check("★ 一个能演练的都没有 → 400，说清要什么样的通道", none.status === 400 && /只有你自己/.test(none.json?.message ?? ""), JSON.stringify(none.json));
  const second = (await call("POST", `/account/${B.id}/channels`, { secret: B.secret, body: { name: "第二个" } })).data.channel.id;
  const skip = await selftest({ drill: true }, B);
  check("★ 默认跳过只收加密的，挑下一个", skip.status === 200 && skip.data?.drill?.channel_id === second, JSON.stringify(skip.data?.drill));
  await selftest({ drill_resolve: skip.data?.drill?.id }, B);

  const lost = await selftest({ drill: true, token_prefix: "0123456789ab" });
  check("★ 本机不在账号里 → 409，不去吵别的设备", lost.status === 409 && lost.json?.data?.this_device?.registered === false, JSON.stringify(lost.json));
}
{
  const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);
  const C = await newAccount();
  await call("PATCH", `/account/${C.id}/channels/${C.channel}`, {
    secret: C.secret,
    body: { policy: { quietHours: { start: hhmm(Date.now() - 3600_000), end: hhmm(Date.now() + 3600_000), timezone: "UTC" } } },
  });
  const mark = apns.length;
  const quiet = await selftest({ drill: true }, C);
  check("★ 免打扰时段：quieted，并说明真告警这时也不响", quiet.data?.drill?.quieted === true && quiet.data?.problems?.some((p) => p.code === "quiet_hours"), JSON.stringify(quiet.data));
  check("推出去的确实是静默的", apns.at(-1)?.payload.aps["interruption-level"] === "passive" && since(mark).length === 1);
  await selftest({ drill_resolve: quiet.data?.drill?.id }, C);
  await call("PATCH", `/account/${C.id}/channels/${C.channel}`, { secret: C.secret, body: { policy: null } });

  await call("PATCH", `/account/${C.id}`, { secret: C.secret, body: { prefs_patch: { mutes: { [C.channel]: 0 } } } });
  const muted = await selftest({ drill: true }, C);
  check("★ 个人静音：muted 是静默送达的设备数，并说明", muted.data?.drill?.muted === 1 && muted.data?.problems?.some((p) => p.code === "muted"), JSON.stringify(muted.data));
  await selftest({ drill_resolve: muted.data?.drill?.id }, C);
  await call("PATCH", `/account/${C.id}`, { secret: C.secret, body: { prefs_patch: { mutes: null } } });

  // 自己设的最低提醒级别也管演练（和真告警一样走接收方的设置，见 receivers.ts）：设到紧急，时效性的演练静默送达
  await call("PATCH", `/account/${C.id}`, { secret: C.secret, body: { prefs_patch: { minLevel: { [C.channel]: "critical" } } } });
  const floored = await selftest({ drill: true }, C);
  check("★ 最低级别「只提醒紧急的」：演练静默送达，muted 计数", floored.data?.drill?.muted === 1 && apns.at(-1)?.payload.aps["interruption-level"] === "passive", JSON.stringify(floored.data));
  check("★ 说明是最低提醒级别（min_level），不说成免打扰", floored.data?.problems?.some((p) => p.code === "min_level" && p.message.includes("最低提醒级别")) && !floored.data?.problems?.some((p) => p.code === "muted"), JSON.stringify(floored.data?.problems));
  await selftest({ drill_resolve: floored.data?.drill?.id }, C);
  await call("PATCH", `/account/${C.id}`, { secret: C.secret, body: { prefs_patch: { minLevel: { [C.channel]: "timeSensitive" } } } });
  const sensitive = await selftest({ drill: true }, C);
  check("最低级别到时效性：时效性的演练照响，不报毛病", !sensitive.data?.drill?.muted && apns.at(-1)?.payload.aps["interruption-level"] === "time-sensitive" && !sensitive.data?.problems?.some((p) => p.code === "min_level" || p.code === "muted"), JSON.stringify(sensitive.data));
  await selftest({ drill_resolve: sensitive.data?.drill?.id }, C);
  await call("PATCH", `/account/${C.id}`, { secret: C.secret, body: { prefs_patch: { minLevel: null } } });

  // 这个通道已经有 10 条在重复提醒：演练照样推，但补发不排，说明这时的真告警也只响一次
  const key = (await call("GET", `/account/${C.id}`, { secret: C.secret })).data.channels[0].key;
  for (let i = 0; i < 10; i++) {
    await call("POST", "/push", { body: { device_key: key, title: `告警 ${i}`, body: "x", id: `busy-${i}`, repeat: "5" } });
  }
  const full = await selftest({ drill: true }, C);
  check("★ 重复提醒满额：照推，repeat_skipped，并说明", full.status === 200 && full.data?.delivered === 1 && full.data?.drill?.repeat_skipped === "channel_limit" && !("remind_at" in full.data.drill) && full.data?.problems?.some((p) => p.code === "repeat_skipped"), JSON.stringify(full.data));
  check("满额时的提示也进 warnings", full.data?.warnings?.length === 1);
  check("满额时推出去的不带 repeat（App 不说会重复）", !("repeat" in (apns.at(-1)?.payload ?? {})));
}
{
  console.log("\n收尾的各种情形");
  const unknown = await selftest({ drill_resolve: "nosuchdrill0001" });
  check("不认识的 id → 404", unknown.status === 404, JSON.stringify(unknown.json));
  check("id 格式不对 → 400", (await selftest({ drill_resolve: "../x" })).status === 400);
  check("id 不是字符串 → 400", (await selftest({ drill_resolve: 5 })).status === 400);
  const rt = await selftest({});
  check("拿往返测速的 nonce 来收尾 → 404", (await selftest({ drill_resolve: rt.data?.nonce })).status === 404);
  const other = await newAccount();
  const theirs = await selftest({ drill: true }, other);
  check("别人的演练收不了 → 404", (await selftest({ drill_resolve: theirs.data?.nonce })).status === 404);

  // 演练中途通道删了：只记结束，不推
  const D = await newAccount();
  const extra = (await call("POST", `/account/${D.id}/channels`, { secret: D.secret, body: { name: "要删的" } })).data.channel.id;
  const run = await selftest({ drill: true, channel_id: extra }, D);
  await call("DELETE", `/account/${D.id}/channels/${extra}`, { secret: D.secret });
  const mark = apns.length;
  const gone = await selftest({ drill_resolve: run.data?.nonce }, D);
  check("★ 通道没了：记为结束、不推", gone.status === 200 && gone.data?.delivered === 0 && typeof gone.data?.drill?.resolved_at === "number" && apns.length === mark, JSON.stringify(gone.json));
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
