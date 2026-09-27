/**
 * 群与令牌（L4）端到端：真的 wrangler dev（workerd、本地 KV、真的限流绑定）加一个假的 APNs，
 * 看每台设备实际收到的 payload —— 发送令牌、换掉的地址、成员发消息、接收方各自的「紧急」授权与最低级别。
 *
 *   node test/api-l4-e2e.test.mjs
 *
 * run-api.sh 起的那个 wrangler dev 没有 APNs 私钥，推到投递那一步就 502，看不到推出去的样子。这里自己另起一个：
 * - 假 APNs 是本进程里的 HTTPS 服务，证书是临时用 openssl 给 127.0.0.1 签的一张自签证书，
 *   NODE_EXTRA_CA_CERTS 让 wrangler dev 信任它（miniflare 把它交给 workerd）。服务端代码一行不改，
 *   走的就是线上那条 https://{APNS_HOST}/3/device/{token}
 * - APNS_HOST 写 IP 不写 localhost：CI 的 Linux 上 localhost 可能先解析成 ::1，而假 APNs 只听 127.0.0.1。
 *   APNS_KEY_P8 给一把临时生成的 P-256 私钥
 * - 本地 KV 放临时目录：不碰 .wrangler/state，也不和 run-api.sh 那个实例抢
 * 所以 run-api.sh 传进来的 BASE 这里不用。进程里跑的那两份（l4-harness.mjs）量的是同一套规则，
 * 这一份确认它们在真的运行时里也一样：KV 是真的异步存储、限流是 workerd 自己的绑定、APNs 是走网络出去的
 */
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttps } from "node:https";
import { createServer as createNet } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPayload as sealWithTool } from "../tools/pigeon-send.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `  → ${detail}` : ""}`);
  }
}

// ── 假 APNs 与 wrangler dev ─────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), "pigeon-l4-e2e-"));
const certFile = join(dir, "apns-cert.pem");
const keyFile = join(dir, "apns-key.pem");
execFileSync(
  "openssl",
  [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", keyFile, "-out", certFile, "-days", "1", "-subj", "/CN=localhost",
    // 两个扩展都写明：macOS 自带的 LibreSSL 不会像 OpenSSL 3 那样默认加上 CA:TRUE，
    // 而 workerd 只把标了 CA 的证书当信任根
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-addext", "basicConstraints=critical,CA:TRUE",
  ],
  { stdio: "ignore" },
);

/** 假 APNs 收到的每一条：推给哪台设备、请求头、payload。一律回 200 */
const apns = [];
const fake = createHttps({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, (req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let payload = null;
    try {
      payload = JSON.parse(body);
    } catch {
      /* 不会发生：服务端只推 JSON */
    }
    apns.push({ device: req.url.split("/").pop(), headers: req.headers, payload });
    res.writeHead(200);
    res.end();
  });
});
await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));

function freePort() {
  return new Promise((resolve) => {
    const s = createNet();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const { privateKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
// 只给 base64 正文（apns.ts 两种都认）：--var 的值里放不进换行
const p8 = privateKey.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
const port = await freePort();
const BASE = `http://localhost:${port}`;
// 直接起 wrangler 的入口、自成一个进程组：收尾时连它拉起来的 workerd 一起结束，不留一个占着端口的孤儿
const dev = spawn(
  process.execPath,
  [
    join(ROOT, "node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--port", String(port),
    "--persist-to", join(dir, "state"),
    "--var", "PIGEON_TEST_ADMIN:1",
    "--var", `APNS_KEY_P8:${p8}`,
    "--var", `APNS_HOST:127.0.0.1:${fake.address().port}`,
  ],
  { cwd: ROOT, env: { ...process.env, NODE_EXTRA_CA_CERTS: certFile }, stdio: ["ignore", "pipe", "pipe"], detached: true },
);
let log = "";
dev.stdout.on("data", (d) => (log += d));
dev.stderr.on("data", (d) => (log += d));

let stopped = false;
function stop() {
  if (stopped) return;
  stopped = true;
  try {
    process.kill(-dev.pid, "SIGTERM");
  } catch {
    /* 已经退出了 */
  }
  fake.close();
  rmSync(dir, { recursive: true, force: true });
}
process.on("exit", stop);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stop();
    process.exit(130);
  });
}

for (let i = 0; i < 120 && !log.includes("Ready on http"); i++) await new Promise((r) => setTimeout(r, 500));
if (!log.includes("Ready on http")) {
  console.log("wrangler dev 起不来：");
  console.log(log.split("\n").slice(-20).join("\n"));
  process.exit(1);
}

// ── 请求与断言的小工具 ──────────────────────────────────────────────

async function call(method, path, { body, secret, headers: extra = {} } = {}) {
  const headers = { ...extra };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (secret) headers.authorization = `Bearer ${secret}`;
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
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
async function capture(fn) {
  const before = apns.length;
  const result = await fn();
  return { result, sent: apns.slice(before).filter((a) => a.payload?.probe === undefined) };
}

/**
 * 一台设备上这条通知实际怎么响：系统只看 aps 里的 interruption-level，App 的历史按顶层 level 记。
 * 两处都对得上才算数 —— 只改一处，要么照样响、要么历史里记错
 */
function ring(payload) {
  if (!payload) return "没收到";
  const il = payload.aps?.["interruption-level"];
  const level = payload.level ?? "active";
  if (il === "passive" && level === "passive" && payload.aps.sound === undefined) return "静默";
  if (level === "critical" && il === "time-sensitive" && payload.aps.sound) return "紧急";
  if (level === "timeSensitive" && il === "time-sensitive" && payload.aps.sound) return "时效性";
  if (level === "active" && (il === undefined || il === "active") && payload.aps.sound) return "普通";
  return `对不上（level=${payload.level} interruption-level=${il} sound=${payload.aps?.sound}）`;
}

/** 断言每个人的每台设备各自怎么响。who → 期望；没列出的人不该收到 */
function expectRings(label, sent, expected) {
  const got = [];
  const want = [];
  for (const [who, ringAs] of expected) {
    for (const token of who.tokens) {
      want.push(`${who.name}:${ringAs}`);
      got.push(`${who.name}:${ring(sent.find((a) => a.device === token)?.payload)}`);
    }
  }
  const everyone = new Set(expected.flatMap(([who]) => who.tokens));
  const strays = sent.filter((a) => !everyone.has(a.device)).length;
  check(label, got.join(" ") === want.join(" ") && strays === 0 && sent.length === want.length, `${got.join(" ")}${strays ? ` 另有 ${strays} 条推给了别人` : ""}`);
}

const devicesOf = (sent, who) => sent.filter((a) => who.tokens.includes(a.device));

// 每次运行换一批设备令牌：本地 KV 在临时目录里、每次都是空的，这里只是和别的测试文件的令牌也分开
const run = Date.now().toString(16);
let seq = 0;
function deviceToken() {
  seq += 1;
  return `${run}e2e${seq}`.padEnd(64, "e").slice(0, 64);
}

async function newAccount(name) {
  const token = deviceToken();
  const r = await call("POST", "/account", { body: { device_token: token, environment: "sandbox", device_name: `${name} 的手机` } });
  const data = r.json?.data;
  if (!data) throw new Error(`建账号失败：${r.text}`);
  await call("PATCH", `/account/${data.account_id}`, { secret: data.secret, body: { name } });
  const acct = { id: data.account_id, secret: data.secret, name, tokens: [token], channelId: data.channels[0].id };
  acct.as = (method, path, body, headers) => call(method, path, { secret: acct.secret, body, headers });
  acct.prefs = (patch) => acct.as("PATCH", `/account/${acct.id}`, { prefs_patch: patch });
  return acct;
}

// ── 场景 ────────────────────────────────────────────────────────────

console.log("\n★ 准备：群主两台设备，三个成员各有各的设置");
// 群主老王：手机和 iPad。成员：李四加入时允许了「紧急」、最低级别设成时效性；张三什么都没设；王五把群设成了免打扰
const O = await newAccount("老王");
const A = await newAccount("李四");
const B = await newAccount("张三");
const C = await newAccount("王五");
const pad = deviceToken();
const added = await O.as("POST", `/account/${O.id}/devices`, { device_token: pad, environment: "sandbox", device_name: "老王的 iPad" });
check("群主再登记一台 iPad", added.status === 200 && added.json?.data?.devices?.length === 2, added.text);
O.tokens.push(pad);

const made = await O.as("POST", `/account/${O.id}/channels`, { name: "值班群", group: true });
const gid = made.json?.data?.channel?.id;
let gkey = made.json?.data?.channel?.key;
const code = (await O.as("POST", `/account/${O.id}/channels/${gid}/invites`)).json?.data?.code;
for (const m of [A, B, C]) {
  const joined = await m.as("POST", `/account/${m.id}/invites/${code}`);
  check(`${m.name} 凭邀请加入`, joined.json?.data?.result === "joined", joined.text);
}
// App 在加入之后才存「紧急」授权：服务端只收自己所在的群的条目
const consent = await A.prefs({ critical: { [gid]: true }, minLevel: { [gid]: "timeSensitive" } });
check("李四：允许紧急、最低级别时效性", consent.json?.data?.prefs?.critical?.[gid] === true && consent.json?.data?.prefs?.minLevel?.[gid] === "timeSensitive", JSON.stringify(consent.json?.data?.prefs));
const mute = await C.prefs({ mutes: { [gid]: 0 } });
check("王五：把群设成免打扰", mute.json?.data?.prefs?.mutes?.[gid] === 0, JSON.stringify(mute.json?.data?.prefs));

const pushKey = (body) => capture(() => call("POST", `/${gkey}`, { body }));

console.log("\n★ 群主用推送地址推：每个人按自己的设置拿一版");
{
  const critical = await pushKey({ title: "机房断电", body: "UPS 还能撑 20 分钟", level: "critical" });
  check("受理，送达 5 台", critical.result.status === 200 && critical.result.json?.data?.delivered === 5, critical.result.text);
  expectRings("★ 紧急：群主两台照响、李四（允许了）照响、张三（没允许）降成时效性、王五（免打扰）静默", critical.sent, [
    [O, "紧急"], [A, "紧急"], [B, "时效性"], [C, "静默"],
  ]);
  check("响应里 muted = 1（王五）", critical.result.json?.data?.muted === 1, JSON.stringify(critical.result.json?.data));
  check("五份是同一条消息：id、collapse-id 都一样", new Set(critical.sent.map((a) => a.payload.id)).size === 1 && critical.sent.every((a) => a.headers["apns-collapse-id"] === a.payload.id));
  check("正文一字不差地到了每一台", critical.sent.every((a) => a.payload.aps.alert.body === "UPS 还能撑 20 分钟"));

  const urgent = await pushKey({ body: "磁盘 92%", level: "timeSensitive" });
  expectRings("★ 时效性：除了免打扰的王五都照响", urgent.sent, [[O, "时效性"], [A, "时效性"], [B, "时效性"], [C, "静默"]]);

  const normal = await pushKey({ body: "日报：一切正常" });
  expectRings("★ 普通：李四的最低级别是时效性，静默收下", normal.sent, [[O, "普通"], [A, "静默"], [B, "普通"], [C, "静默"]]);
  check("muted = 2（李四的最低级别也算）", normal.result.json?.data?.muted === 2, JSON.stringify(normal.result.json?.data));

  const quiet = await pushKey({ body: "备份开始", level: "passive" });
  expectRings("静默的消息谁那里都静默", quiet.sent, [[O, "静默"], [A, "静默"], [B, "静默"], [C, "静默"]]);
}

console.log("\n★ 接收方改自己的设置，下一条就按新的来");
{
  await B.prefs({ critical: { [gid]: true } });
  await C.prefs({ critical: { [gid]: true } });
  await A.prefs({ minLevel: { [gid]: "critical" } });
  const critical = await pushKey({ body: "主库挂了", level: "critical" });
  expectRings("★ 张三允许了 → 照响；王五开着免打扰但允许了 → 紧急突破他的免打扰", critical.sent, [[O, "紧急"], [A, "紧急"], [B, "紧急"], [C, "紧急"]]);
  check("没有人被降级：muted 不出现", critical.result.json?.data?.muted === undefined, JSON.stringify(critical.result.json?.data));

  const urgent = await pushKey({ body: "磁盘 95%", level: "timeSensitive" });
  expectRings("★ 李四改成「只提醒紧急的」：时效性也静默", urgent.sent, [[O, "时效性"], [A, "静默"], [B, "时效性"], [C, "静默"]]);

  await B.prefs({ critical: { [gid]: null } });
  const again = await pushKey({ body: "主库又挂了", level: "critical" });
  check("★ 张三收回授权（条目删掉）：紧急又降成时效性", ring(devicesOf(again.sent, B)[0]?.payload) === "时效性", ring(devicesOf(again.sent, B)[0]?.payload));

  await O.prefs({ mutes: { [gid]: 0 } });
  const own = await pushKey({ body: "自己的群", level: "critical" });
  check("★ 群主把自己的群设成免打扰：紧急照样突破（地址是他自己给出去的）", devicesOf(own.sent, O).map((a) => ring(a.payload)).join() === "紧急,紧急");
  const ownNormal = await pushKey({ body: "自己的群，普通" });
  check("群主免打扰时普通消息两台都静默", devicesOf(ownNormal.sent, O).map((a) => ring(a.payload)).join() === "静默,静默");
  await O.prefs({ mutes: { [gid]: null } });

  // 回到开头的设置：李四时效性、张三没允许、王五免打扰且没允许
  await A.prefs({ minLevel: { [gid]: "timeSensitive" } });
  await C.prefs({ critical: null });
}

console.log("\n★ 发送令牌：和推送地址走同一条路，推出去带「来自」");
const tokens = `/account/${O.id}/channels/${gid}/tokens`;
let nas;
{
  nas = (await O.as("POST", tokens, { name: "NAS" })).json?.data;
  check("新建令牌 NAS", /^st_[A-Za-z0-9_-]{43}$/.test(nas?.value ?? ""), JSON.stringify(nas));
  const path = await capture(() => call("GET", `/${nas.value}/${encodeURIComponent("备份完成")}`));
  check("★ 路径式：受理，5 台都带 from = NAS", path.result.status === 200 && path.sent.length === 5 && path.sent.every((a) => a.payload.from === "NAS" && a.payload.sender === undefined), path.result.text);
  const critical = await capture(() => call("POST", `/${nas.value}`, { body: { body: "RAID 降级", level: "critical" } }));
  expectRings("★ 令牌推的紧急：接收方的设置照样各管各的", critical.sent, [[O, "紧急"], [A, "紧急"], [B, "时效性"], [C, "静默"]]);
  const hook = await capture(() => call("POST", `/hook/${nas.value}/uptimekuma`, { body: { heartbeat: { status: 0, msg: "timeout" }, monitor: { name: "路由器" } } }));
  check("★ /hook 适配器认令牌", hook.result.status === 200 && hook.sent.length === 5 && hook.sent.every((a) => a.payload.from === "NAS"), hook.result.text);
  const batch = await capture(() => call("POST", "/push", { body: { device_keys: [nas.value, gkey], body: "批量" } }));
  check("★ /push 批量里令牌和推送地址混着用：令牌那份带 from，地址那份不带", batch.result.status === 200 && batch.sent.filter((a) => a.payload.from === "NAS").length === 5 && batch.sent.filter((a) => a.payload.from === undefined).length === 5, batch.result.text);
  const bearer = await capture(() => call("POST", "/", { body: { body: "根路径" }, headers: { authorization: `Bearer ${nas.value}` } }));
  check("Authorization: Bearer 令牌", bearer.result.status === 200 && bearer.sent.every((a) => a.payload.from === "NAS"), bearer.result.text);
  const spoof = await capture(() => call("POST", `/${gkey}`, { body: { body: "冒充", from: "老板", sender: "老板" } }));
  check("★ from、sender 冒充不了", spoof.sent.length === 5 && spoof.sent.every((a) => a.payload.from === undefined && a.payload.sender === undefined));
  check("★ 令牌当不了账号凭据", (await call("GET", `/account/${O.id}`, { secret: nas.value })).status === 401);
  const list = await O.as("GET", tokens);
  const view = list.json?.data?.tokens?.find((t) => t.id === nas.token.id);
  check("★ 列表里记着用量和最近一次的时刻", view?.count >= 1 && typeof view?.last_used_at === "number" && !list.text.includes(nas.value), JSON.stringify(view));
  check("成员看不了令牌 → 403", (await A.as("GET", `/account/${A.id}/channels/${gid}/tokens`)).status === 403);
}

console.log("\n★ 令牌的限制：最高级别、每分钟上限、停用");
let family;
{
  family = (await O.as("POST", tokens, { name: "家人网页", max_level: "active" })).json?.data;
  // 和网页 /s/{令牌} 发出去的请求一模一样：JSON 的 title（可能是空串）、body、level
  const sent = await capture(() => call("POST", `/${family.value}`, { body: { title: "", body: "快回家吃饭", level: "timeSensitive" } }));
  check("受理", sent.result.status === 200, sent.result.text);
  expectRings("★ 上限「普通」：时效性按普通送（李四的最低级别再把它压成静默）", sent.sent, [[O, "普通"], [A, "静默"], [B, "普通"], [C, "静默"]]);
  check("warnings 写明照上限改了", (sent.result.json?.data?.warnings ?? []).some((w) => w.includes("最高只能发「普通」")), JSON.stringify(sent.result.json?.data?.warnings));
  check("空标题不当标题：通知上只有正文", sent.sent.every((a) => a.payload.aps.alert.title === undefined && a.payload.from === "家人网页"), JSON.stringify(sent.sent[0]?.payload.aps.alert));
  const critical = await capture(() => call("POST", `/${family.value}`, { body: { body: "急", level: "critical", repeat: "5", id: "dinner" } }));
  check("★ 紧急也压成普通、不排重复提醒", critical.sent.every((a) => a.payload.level !== "critical" && a.payload.repeat === undefined) && critical.result.json?.data?.repeat === undefined, critical.result.text);

  const script = (await O.as("POST", tokens, { name: "脚本", per_minute: 2 })).json?.data;
  const statuses = [];
  let delivered = 0;
  for (let i = 0; i < 3; i++) {
    const r = await capture(() => call("GET", `/${script.value}/n${i}`));
    statuses.push(r.result.status);
    delivered += r.sent.length;
  }
  check("★ 每分钟 2 条（workerd 的限流绑定）：200、200、429", statuses.join() === "200,200,429", statuses.join());
  check("被拦下的那条一台都没推", delivered === 10, String(delivered));
  const over = await call("GET", `/${script.value}/n9`);
  check("429 带 Retry-After: 60、说的是这个令牌", over.status === 429 && over.headers.get("retry-after") === "60" && over.text.includes("「脚本」每分钟最多 2 条"), over.text);
  check("★ 推送地址、别的令牌不受它影响", (await call("GET", `/${gkey}/ok`)).status === 200 && (await call("GET", `/${nas.value}/ok`)).status === 200);

  await O.as("PATCH", `${tokens}/${family.token.id}`, { disabled: true });
  const refused = await capture(() => call("GET", `/${family.value}/x`));
  check("★ 停用 → 403，一台都没推", refused.result.status === 403 && refused.result.text.includes("停用") && refused.sent.length === 0, refused.result.text);
  const page = await call("GET", `/s/${family.value}`);
  check("网页：403「已停用」，没有表单", page.status === 403 && page.text.includes("已停用") && !page.text.includes("<form"));
  await O.as("PATCH", `${tokens}/${family.token.id}`, { disabled: false });
  check("恢复之后照常推", (await call("GET", `/${family.value}/x`)).status === 200);
}

console.log("\n★ 发送令牌的网页 /s/{令牌}");
{
  const page = await call("GET", `/s/${nas.value}`);
  check("★ 200，发之前写明发给哪个群、收到的人看到来自谁", page.status === 200 && page.text.includes("发给：<strong>值班群</strong>") && page.text.includes("来自：NAS"));
  check("不缓存、CSP 只放行页面自己的脚本", page.headers.get("cache-control") === "no-store" && /script-src 'sha256-/.test(page.headers.get("content-security-policy") ?? ""));
  check("页面里没有推送地址", !page.text.includes(gkey));
  const capped = await call("GET", `/s/${family.value}`);
  check("上限「普通」的令牌：没有「重要」可选", capped.status === 200 && !capped.text.includes('value="timeSensitive"') && capped.text.includes('data-level="active"'));
  check("编出来的令牌 → 404", (await call("GET", `/s/st_${"Q".repeat(43)}`)).status === 404);

  await call("POST", `/__test__/suspend/${gid}`);
  const suspended = await call("GET", `/s/${nas.value}`);
  check("★ 群被停用：网页 403 说明停用，令牌推送 403", suspended.status === 403 && suspended.text.includes("已被停用") && (await call("GET", `/${nas.value}/x`)).status === 403, suspended.text.slice(0, 120));
  await call("POST", `/__test__/restore/${gid}`);
  check("恢复之后网页 200", (await call("GET", `/s/${nas.value}`)).status === 200);

  await O.as("PATCH", `/account/${O.id}/channels/${gid}`, { policy: { e2eOnly: true } });
  const sealed = await call("GET", `/s/${nas.value}`);
  check("★ 只收加密的群：网页直接说发不了，不给表单（网页发的是明文）", sealed.status === 403 && sealed.text.includes("只收端到端加密") && !sealed.text.includes("<form"), sealed.text.slice(0, 200));
  check("明文推给令牌 → 400", (await call("POST", `/${nas.value}`, { body: { body: "明文" } })).status === 400);
  // 加密工具带着令牌照样推得进来：README 里写的就是这一行 node pigeon-send.mjs https://nfo.im/st_xxxx --key …
  const groupKey = Buffer.alloc(32, 7).toString("base64url");
  const encrypted = await capture(() => call("POST", `/${nas.value}`, { body: sealWithTool({ body: "剩余 3%", level: "timeSensitive" }, groupKey) }));
  check("★ 加密工具用令牌推：受理，密文原样到每台、带 from", encrypted.result.status === 200 && encrypted.sent.length === 5 && encrypted.sent.every((a) => a.payload.ciphertext && a.payload.from === "NAS" && !JSON.stringify(a.payload).includes("剩余")), encrypted.result.text);
  await O.as("PATCH", `/account/${O.id}/channels/${gid}`, { policy: null });
  check("关掉之后网页 200", (await call("GET", `/s/${nas.value}`)).status === 200);
}

console.log("\n★ 删掉的令牌、换掉的地址：410，并告诉群主（一天一次）");
{
  const doomed = (await O.as("POST", tokens, { name: "旧路由器" })).json?.data;
  await O.as("DELETE", `${tokens}/${doomed.token.id}`);
  const first = await capture(() => call("GET", `/${doomed.value}/x`, { headers: { "user-agent": "Wget/1.21.4" } }));
  check("★ 删掉的令牌 → 410，请向群主要新地址", first.result.status === 410 && first.result.json?.message?.includes("请向他要新的地址"), first.result.text);
  expectRings("★ 只提醒群主（两台都到），静默", first.sent, [[O, "静默"]]);
  const notice = first.sent[0]?.payload;
  check("提醒写明哪个令牌、从哪来，归到这个群", notice?.aps.alert.title === "删掉的发送令牌还有人在用" && notice.aps.alert.body.includes("「旧路由器」") && notice.aps.alert.body.includes("路径式推送，Wget/1.21.4") && notice.channel_id === gid, JSON.stringify(notice?.aps.alert));
  check("提醒里没有令牌本身", !JSON.stringify(notice).includes(doomed.value));
  const second = await capture(() => call("GET", `/${doomed.value}/y`));
  check("★ 当天再用：照样 410，不再提醒", second.result.status === 410 && second.sent.length === 0);
  check("网页 410「已失效」，打开网页不算在用", (await capture(() => call("GET", `/s/${doomed.value}`))).sent.length === 0 && (await call("GET", `/s/${doomed.value}`)).status === 410);

  const oldKey = gkey;
  const rotated = await O.as("POST", `/account/${O.id}/channels/${gid}/key`);
  gkey = rotated.json?.data?.key;
  check("换地址", typeof gkey === "string" && gkey !== oldKey, rotated.text);
  const old = await capture(() => call("POST", `/${oldKey}`, { body: { body: "旧脚本" }, headers: { "user-agent": "curl/8.4.0" } }));
  check("★ 旧地址 → 410「地址已停用：请到 App 里复制新地址」", old.result.status === 410 && old.result.json?.message === "地址已停用：请到 App 里复制新地址", old.result.text);
  expectRings("★ 群主两台各收到一条静默提醒，成员一条都没有", old.sent, [[O, "静默"]]);
  check("提醒说的是旧地址、来源是 curl", old.sent[0]?.payload.aps.alert.title === "旧地址还有人在用" && old.sent[0].payload.aps.alert.body.includes("路径式推送，curl/8.4.0"), JSON.stringify(old.sent[0]?.payload.aps.alert));
  const hook = await capture(() => call("POST", `/hook/${oldKey}/github`, { body: {} }));
  check("★ 同一天从 /hook 再用：410，不再提醒", hook.result.status === 410 && hook.sent.length === 0, hook.result.text);
  const batch = await capture(() => call("POST", "/push", { body: { device_key: oldKey, body: "x" } }));
  check("/push 批量：410，不再提醒", batch.result.status === 410 && batch.sent.length === 0, batch.result.text);
  const fresh = await capture(() => call("GET", `/${gkey}/${encodeURIComponent("新地址")}`));
  check("新地址照常推", fresh.result.status === 200 && fresh.sent.length === 5);
  check("令牌不受换地址影响", (await call("GET", `/${nas.value}/still`)).status === 200);
}

console.log("\n★ 成员在群里发消息");
const post = (who, body) => capture(() => who.as("POST", `/account/${who.id}/channels/${gid}/messages`, body));
{
  const closed = await post(B, { body: "我到了" });
  check("★ 群主没开：成员 → 403「群主没有开放成员发消息」，一台都没推", closed.result.status === 403 && closed.result.json?.message === "群主没有开放成员发消息" && closed.sent.length === 0, closed.result.text);
  check("成员的通道视图里没有 member_send", (await B.as("GET", `/account/${B.id}`)).json?.data?.channels?.find((c) => c.id === gid)?.member_send === undefined);

  const byOwner = await post(O, { body: "晚上八点开会", level: "timeSensitive" });
  check("群主随时能发", byOwner.result.status === 200 && byOwner.result.json?.data?.delivered === 5, byOwner.result.text);
  expectRings("★ 群主自己的两台静默收下，别人按各自的设置", byOwner.sent, [[O, "静默"], [A, "时效性"], [B, "时效性"], [C, "静默"]]);
  check("sender = 老王、标题是他的名字", byOwner.sent.every((a) => a.payload.sender === "老王" && a.payload.aps.alert.title === "老王"));

  check("成员开不了这个开关 → 403", (await B.as("PATCH", `/account/${B.id}/channels/${gid}`, { member_send: true })).status === 403);
  await O.as("PATCH", `/account/${O.id}/channels/${gid}`, { member_send: true });
  check("★ 群主打开后，成员看得到 member_send", (await B.as("GET", `/account/${B.id}`)).json?.data?.channels?.find((c) => c.id === gid)?.member_send === true);

  const said = await post(B, { body: "服务器我重启了", level: "timeSensitive" });
  check("★ 成员发 → 200", said.result.status === 200 && typeof said.result.json?.data?.id === "string", said.result.text);
  expectRings("★ 张三自己静默、群主两台和李四照响、王五免打扰静默", said.sent, [[O, "时效性"], [A, "时效性"], [B, "静默"], [C, "静默"]]);
  check("sender = 张三，没带 from", said.sent.every((a) => a.payload.sender === "张三" && a.payload.from === undefined));
  const titled = await post(B, { title: "收到", body: "我来处理" });
  expectRings("普通级别：李四的最低级别把它压成静默", titled.sent, [[O, "普通"], [A, "静默"], [B, "静默"], [C, "静默"]]);
  check("写了标题就用他的标题", titled.sent.every((a) => a.payload.aps.alert.title === "收到" && a.payload.sender === "张三"));
  const echo = await post(A, { title: "收到", body: "我来处理" });
  check("★ 另一个人发同一句不会被当成重复压掉", echo.result.status === 200 && echo.result.json?.data?.suppressed === undefined && echo.sent.length === 5 && echo.sent.every((a) => a.payload.sender === "李四"), echo.result.text);
  check("★ 成员发不了紧急 → 400", (await post(B, { body: "x", level: "critical" })).result.status === 400);

  await O.as("PATCH", `/account/${O.id}/channels/${gid}`, { member_send: false });
  const off = await post(B, { body: "还能发吗" });
  check("★ 关掉之后成员又 → 403", off.result.status === 403 && off.sent.length === 0);
}

console.log("\n★ 退群、删群");
{
  const left = await C.as("DELETE", `/account/${C.id}/channels/${gid}`);
  check("王五退群：这个群的免打扰、授权跟着清掉", left.status === 200 && left.json?.data?.prefs?.mutes?.[gid] === undefined, left.text);
  const after = await capture(() => call("GET", `/${gkey}/${encodeURIComponent("少了一个人")}`));
  check("退群之后不再推给他", after.sent.length === 4 && devicesOf(after.sent, C).length === 0);
  await O.as("DELETE", `/account/${O.id}/channels/${gid}`);
  check("★ 删群之后令牌 → 404（墓碑一起删了）", (await call("GET", `/${nas.value}/x`)).status === 404);
  check("网页 → 404", (await call("GET", `/s/${nas.value}`)).status === 404);
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
stop();
process.exit(failures === 0 ? 0 : 1);
