/**
 * L2 通知交互的全链路测试：推一条带按钮的消息 → 从「APNs」收到的 payload 里取出 actions、act_sig →
 * 像 App 那样交回 actions 接口 → 看服务端真正发出去了什么：代发请求和它的签名、群里的原地广播、
 * 回调事件、回执长轮询。
 *
 *   node test/api-l2-e2e.test.mjs            （run-api.sh 会带着 BASE 调它，这里用不上 BASE）
 *
 * 为什么自己起一个 wrangler dev，而不是用 run-api.sh 起的那个：
 * - 要一把 APNs 私钥，推送才会真的「发出去」、payload 才带 act_sig / ack_sig。这里现场生成一把一次性的
 *   P-256 私钥（跟 Apple 毫无关系，测完就扔），别的 API 测试照旧按「本地没有私钥」跑，互不影响；
 * - 要 PIGEON_TEST_OUTBOUND：Worker 发往外面的请求（APNs、按钮地址、回调地址）统统改投到本测试起的
 *   本机接收端（见 src/testoutbound.ts），主机名放在 x-test-host 头里。按钮和回调写的都是
 *   hooks.example.com 这样的公网域名，校验照常走；签名签的是时间戳和请求体，改投不影响核对。
 * 本地状态放在临时目录，测完删掉。
 */
import { spawn } from "node:child_process";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `  → ${detail}` : ""}`);
  }
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 本机接收端：记下每一个进来的请求，按路径决定怎么回 ─────────────────────

/** 收到的请求：{ host（原主机名）, method, path, headers, body, at } */
const inbox = [];
const echo = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const entry = {
      host: req.headers["x-test-host"] ?? "",
      method: req.method,
      path: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString("utf8"),
      at: Date.now(),
    };
    inbox.push(entry);
    const path = req.url.split("?")[0];
    if (path === "/slow") await sleep(6500);
    if (path === "/fail") return res.writeHead(503).end("down");
    if (path === "/redir-same") return res.writeHead(302, { location: "https://hooks.example.com/landed" }).end();
    if (path === "/redir-cross") return res.writeHead(302, { location: "https://elsewhere.example.net/steal" }).end();
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  });
});
const echoPort = await freePort();
await new Promise((r) => echo.listen(echoPort, "127.0.0.1", r));

// ── 专用的 wrangler dev ──────────────────────────────────────────────

const port = await freePort();
const inspector = await freePort();
const state = mkdtempSync(join(tmpdir(), "pigeon-l2e2e-"));
// 一次性的 P-256 私钥：只为让本地能签出 APNs token、act_sig、ack_sig。改投之后请求根本到不了 Apple
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = privateKey.export({ type: "pkcs8", format: "pem" });
const dev = spawn(
  "npx",
  [
    "wrangler", "dev", "--local", "--port", String(port), "--inspector-port", String(inspector),
    "--persist-to", state, "--show-interactive-dev-session=false",
    "--var", "PIGEON_TEST_ADMIN:1",
    "--var", `APNS_KEY_P8:${pem}`,
    "--var", `PIGEON_TEST_OUTBOUND:http://127.0.0.1:${echoPort}`,
  ],
  {
    cwd: root,
    // 本机若配了代理，别让它插手 127.0.0.1 的往来
    env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  },
);
let devLog = "";
dev.stdout.on("data", (d) => (devLog += d));
dev.stderr.on("data", (d) => (devLog += d));

function shutdown() {
  try {
    process.kill(-dev.pid, "SIGTERM");
  } catch {
    /* 已经退出 */
  }
  echo.close();
  echo.closeAllConnections?.();
  rmSync(state, { recursive: true, force: true });
}

for (let i = 0; i < 90 && !devLog.includes("Ready on http"); i++) await sleep(500);
if (!devLog.includes("Ready on http")) {
  console.log("专用的 wrangler dev 起不来：\n" + devLog.slice(-2000));
  shutdown();
  process.exit(1);
}
const BASE = `http://localhost:${port}`;

async function call(method, path, { body, secret } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (secret) headers.authorization = `Bearer ${secret}`;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 不是 JSON */
  }
  return { status: res.status, json };
}

const run = Date.now().toString(16);
let seq = 0;
async function newAccount(name) {
  seq += 1;
  const token = `${run}e2e${seq}`.padEnd(64, "a").slice(0, 64);
  const r = await call("POST", "/account", { body: { device_token: token, environment: "sandbox", device_name: "测试机" } });
  const data = r.json?.data;
  const acct = { id: data?.account_id, secret: data?.secret, channel: data?.channels?.[0], token };
  await call("PATCH", `/account/${acct.id}`, { secret: acct.secret, body: { name } });
  return acct;
}
const as = (who) => (method, path, body) => call(method, path, { secret: who.secret, body });

/** 发往 APNs 的请求里，给这台设备的、payload 满足条件的那些 */
function apnsTo(token, where = () => true) {
  return inbox
    .filter((e) => e.host.endsWith("push.apple.com") && e.path === `/3/device/${token}`)
    .map((e) => ({ ...e, payload: JSON.parse(e.body) }))
    .filter((e) => where(e.payload, e));
}
const toHooks = (path) => inbox.filter((e) => e.host === "hooks.example.com" && e.path.split("?")[0] === path);

/** 接收方的核对方式（README 里写的那套）：HMAC-SHA256(回调密钥, "时间戳.请求体")，十六进制 */
function signatureValid(entry, secret) {
  const ts = entry.headers["x-pigeon-timestamp"];
  const sig = entry.headers["x-pigeon-signature"];
  if (!ts || !sig) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(`${ts}.${entry.body}`).digest("hex");
  return sig === expected;
}
const fresh = (entry) => Math.abs(Number(entry.headers["x-pigeon-timestamp"]) * 1000 - entry.at) < 10_000;

try {
  // ── 准备：王五建群，李四加入 ──────────────────────────────────────
  const O = await newAccount("王五");
  const M = await newAccount("李四");
  const cid = O.channel.id;
  const key = O.channel.key;
  await as(O)("PATCH", `/account/${O.id}/channels/${cid}`, { group: true });
  const code = (await as(O)("POST", `/account/${O.id}/channels/${cid}/invites`)).json?.data?.code;
  await as(M)("POST", `/account/${M.id}/invites/${code}`);
  let secret = (await as(O)("GET", `/account/${O.id}/channels/${cid}/callback-secret`)).json?.data?.callback_secret;
  check("准备：群建好、回调密钥拿到", typeof secret === "string" && secret.length >= 20);

  const tap = (who, body) => as(who)("POST", `/account/${who.id}/channels/${cid}/actions`, body);

  console.log("\n★ 推送：按钮定义和凭据随 payload 下发，callback 不下发");
  const pushed = await call("POST", `/${key}`, {
    body: {
      title: "生产要发版",
      body: "v2.3 灰度 10%",
      id: "deploy-42",
      actions: [
        { type: "open", label: "查看", url: "https://ci.example.com/run/42" },
        { type: "http", label: "回滚", url: "https://hooks.example.com/rollback?run=42", headers: { "X-Env": "prod" }, destructive: true },
        { type: "copy", label: "复制单号", value: "SF1234" },
      ],
      callback: "https://hooks.example.com/pigeon-events",
    },
  });
  check("推送 → 200，两台设备都送到", pushed.status === 200 && pushed.json?.data?.delivered === 2, JSON.stringify(pushed.json));
  const [toOwner] = apnsTo(O.token, (p) => p.id === "deploy-42");
  const [toMember] = apnsTo(M.token, (p) => p.id === "deploy-42");
  check("王五、李四的设备各收到一条", Boolean(toOwner && toMember));
  const p = toMember?.payload ?? {};
  let buttons = [];
  try {
    buttons = JSON.parse(p.actions);
  } catch {
    /* 下面的断言会报出来 */
  }
  check("payload.actions 是紧凑 JSON 字符串", typeof p.actions === "string" && buttons.length === 3, String(p.actions));
  check(
    "紧凑写法：t/l/u/h/d/v，默认的 POST 不写",
    buttons[0]?.t === "open" && buttons[1]?.t === "http" && buttons[1]?.h?.["X-Env"] === "prod" && buttons[1]?.d === 1 &&
      buttons[1]?.m === undefined && buttons[2]?.v === "SF1234",
    p.actions,
  );
  check("payload 带 act_sig（22 字符 base64url）", /^[A-Za-z0-9_-]{22}$/.test(p.act_sig ?? ""), String(p.act_sig));
  check("两台设备拿到的是同一份按钮和凭据", toOwner?.payload.actions === p.actions && toOwner?.payload.act_sig === p.act_sig);
  check("群消息用群组类别", p.aps?.category === "pigeonNotification.group", p.aps?.category);
  check("callback 地址不进 payload", !toMember?.body.includes("pigeon-events") && p.callback === undefined);
  check("APNs 请求头：collapse-id 是消息 id", toMember?.headers["apns-collapse-id"] === "deploy-42");

  console.log("\n★ 李四点「回滚」：服务端核对凭据后代发，带签名");
  const before = inbox.length;
  const rolled = await tap(M, { message_id: p.id, index: 1, actions: p.actions, act_sig: p.act_sig });
  check("actions 接口 → 200 {status:200, ok:true}", rolled.status === 200 && rolled.json?.data?.status === 200 && rolled.json?.data?.ok === true, JSON.stringify(rolled.json));
  const [rb] = toHooks("/rollback");
  check("按钮地址收到一次请求（路径、查询原样）", Boolean(rb) && rb.path === "/rollback?run=42" && rb.method === "POST", JSON.stringify(rb?.path));
  check("签名对得上：HMAC-SHA256(回调密钥, 时间戳.请求体)", rb && signatureValid(rb, secret), JSON.stringify(rb?.headers));
  check("时间戳是当下的秒数", rb && fresh(rb), rb?.headers["x-pigeon-timestamp"]);
  check("换一把密钥就对不上（签名真的绑着密钥）", rb && !signatureValid(rb, secret + "x"));
  check("X-Pigeon-Event: action", rb?.headers["x-pigeon-event"] === "action", rb?.headers["x-pigeon-event"]);
  check("按钮自带的请求头带上了", rb?.headers["x-env"] === "prod");
  check("User-Agent 是 Pigeon-Callback/1", rb?.headers["user-agent"] === "Pigeon-Callback/1");
  let rbBody = {};
  try {
    rbBody = JSON.parse(rb?.body ?? "");
  } catch {
    /* 下面报 */
  }
  check(
    "默认请求体和回调事件同形：event/channel_id/id/by/at/action + index",
    rbBody.event === "action" && rbBody.channel_id === cid && rbBody.id === "deploy-42" && rbBody.by === "李四" &&
      typeof rbBody.at === "number" && rbBody.action === "回滚" && rbBody.index === 1 && rbBody.message_id === undefined,
    rb?.body,
  );

  const since = inbox.slice(before);
  const bcast = since.filter((e) => e.host.endsWith("push.apple.com")).map((e) => ({ ...e, payload: JSON.parse(e.body) }));
  const bOwner = bcast.find((e) => e.path.endsWith(O.token));
  check("群里原地广播：两台设备都收到", bcast.length === 2 && Boolean(bOwner), String(bcast.length));
  const bp = bOwner?.payload ?? {};
  check("广播标题「李四 点了「回滚」· 200」", bp.aps?.alert?.title === "李四 点了「回滚」· 200", bp.aps?.alert?.title);
  check("广播带 action_by / action_label / action_status", bp.action_by === "李四" && bp.action_label === "回滚" && bp.action_status === "200", JSON.stringify(bp));
  check("成功的不带 action_ok", bp.action_ok === undefined);
  check("★ 广播带 isarchive=0：不认 action_by 的旧版 App 不会拿它替换历史里的原消息", bp.isarchive === "0", JSON.stringify(bp));
  check("广播静默（passive），沿用原消息 id 折叠", bp.aps?.["interruption-level"] === "passive" && bp.id === "deploy-42" && bOwner?.headers["apns-collapse-id"] === "deploy-42");
  check("广播不带按钮（别人不会再点一遍）", bp.actions === undefined && bp.act_sig === undefined);

  const [cb] = toHooks("/pigeon-events");
  check("回调地址收到 action 事件", cb?.headers["x-pigeon-event"] === "action", JSON.stringify(cb?.headers));
  check("回调签名对得上", cb && signatureValid(cb, secret));
  let cbBody = {};
  try {
    cbBody = JSON.parse(cb?.body ?? "");
  } catch {
    /* 下面报 */
  }
  check(
    "回调事件内容 {event, channel_id, id, by, at, action}",
    cbBody.event === "action" && cbBody.channel_id === cid && cbBody.id === "deploy-42" && cbBody.by === "李四" && cbBody.action === "回滚",
    cb?.body,
  );
  check("回调只发元数据，不带正文", cb && !cb.body.includes("灰度"));

  console.log("\n★ open、copy 在手机上完成，交给服务端被拒");
  check("open → 400", (await tap(M, { message_id: p.id, index: 0, actions: p.actions, act_sig: p.act_sig })).status === 400);
  check("copy → 400", (await tap(M, { message_id: p.id, index: 2, actions: p.actions, act_sig: p.act_sig })).status === 400);
  check("凭据挪到别的消息 id 上 → 403", (await tap(M, { message_id: "deploy-43", index: 1, actions: p.actions, act_sig: p.act_sig })).status === 403);

  console.log("\n★ 认领：payload 的 ack_sig 认得，回调收到 ack 事件");
  const acked = await as(M)("POST", `/account/${M.id}/channels/${cid}/ack`, { message_id: p.id, sig: p.ack_sig });
  check("李四认领 → 第一个", acked.status === 200 && acked.json?.data?.first === true, JSON.stringify(acked.json));
  const ackEvent = toHooks("/pigeon-events").find((e) => e.headers["x-pigeon-event"] === "ack");
  check("回调收到 ack 事件，签名对得上", ackEvent && signatureValid(ackEvent, secret) && JSON.parse(ackEvent.body).by === "李四", ackEvent?.body);
  const receipt1 = await call("GET", `/${key}/receipt/deploy-42`);
  const r1 = receipt1.json?.data ?? {};
  check("回执：认领人、按钮动作都在", r1.acked_by === "李四" && r1.actions?.length === 1 && r1.actions[0].status === 200 && r1.actions[0].ok === true, JSON.stringify(r1));

  console.log("\n★ 回执长轮询：先挂着等，再有人回话");
  await call("POST", `/${key}`, {
    body: {
      title: "要不要扩容",
      id: "ask-1",
      actions: "回一句=reply https://hooks.example.com/reply; 收到",
      callback: "https://hooks.example.com/pigeon-events",
    },
  });
  const [ask] = apnsTo(M.token, (pl) => pl.id === "ask-1");
  const ap = ask?.payload ?? {};
  check("简写的按钮也随 payload 下发", ap.actions === JSON.stringify([{ t: "reply", l: "回一句", u: "https://hooks.example.com/reply" }, { t: "http", l: "收到" }]), ap.actions);
  const t0 = Date.now();
  const polling = call("GET", `/${key}/receipt/ask-1?wait=20`);
  await sleep(1200);
  const replied = await tap(M, { message_id: "ask-1", index: 0, actions: ap.actions, act_sig: ap.act_sig, reply_text: "我在看，十分钟" });
  check("回话 → 200 {status:200, ok:true}", replied.status === 200 && replied.json?.data?.ok === true && replied.json?.data?.status === 200, JSON.stringify(replied.json));
  const polled = await polling;
  const waited = Date.now() - t0;
  const pr = polled.json?.data ?? {};
  check("长轮询在回话之后几秒内返回（不等满 20 秒）", polled.status === 200 && waited > 1000 && waited < 8000, `${waited}ms`);
  check("回执里有这句回复", pr.actions?.[0]?.type === "reply" && pr.actions[0].reply === "我在看，十分钟" && pr.actions[0].by === "李四", JSON.stringify(pr));
  const [rp] = toHooks("/reply");
  check("回复也发到了按钮地址，签名对得上，X-Pigeon-Event: reply", rp && signatureValid(rp, secret) && rp.headers["x-pigeon-event"] === "reply" && JSON.parse(rp.body).reply === "我在看，十分钟", rp?.body);
  const replyEvent = toHooks("/pigeon-events").find((e) => e.headers["x-pigeon-event"] === "reply");
  check("回调收到 reply 事件，带回复原文", replyEvent && JSON.parse(replyEvent.body).reply === "我在看，十分钟", replyEvent?.body);
  const replyCast = apnsTo(O.token, (pl) => pl.id === "ask-1" && pl.action_by);
  check("群里广播不带回复原文", replyCast.length === 1 && !replyCast[0].body.includes("十分钟"), replyCast[0]?.body);

  console.log("\n★ since：只等下一件事");
  const lastAt = Math.max(...pr.actions.map((a) => a.at));
  const t1 = Date.now();
  const idle = await call("GET", `/${key}/receipt/ask-1?wait=2&since=${lastAt}`);
  check("带上最晚的 at 再等 → 没有新事，等满 wait 才回", idle.status === 200 && Date.now() - t1 >= 1900, `${Date.now() - t1}ms`);
  const t2 = Date.now();
  const noSince = await call("GET", `/${key}/receipt/ask-1?wait=10`);
  check("不带 since → 有过动作就立刻回", noSince.status === 200 && Date.now() - t2 < 1500, `${Date.now() - t2}ms`);
  const nextPoll = call("GET", `/${key}/receipt/ask-1?wait=20&since=${lastAt}`);
  await sleep(500);
  const noted = await as(O)("POST", `/account/${O.id}/channels/${cid}/actions`, { message_id: "ask-1", index: 1, actions: ap.actions, act_sig: ap.act_sig });
  check("王五点只回报的「收到」→ 200 {ok:true}，没有状态码", noted.status === 200 && noted.json?.data?.ok === true && noted.json?.data?.status === undefined, JSON.stringify(noted.json));
  const next = (await nextPoll).json?.data ?? {};
  check("since 之后的那一次到了", next.actions?.some((a) => a.by === "王五" && a.label === "收到" && a.at > lastAt), JSON.stringify(next.actions));
  const notedCast = apnsTo(M.token, (pl) => pl.id === "ask-1" && pl.action_by === "王五");
  check("只回报的广播写「已记录」", notedCast[0]?.payload.aps?.alert?.title === "王五 点了「收到」· 已记录", notedCast[0]?.payload.aps?.alert?.title);

  console.log("\n★ 代发的边界：跳转、出错、GET、超时");
  await call("POST", `/${key}`, {
    body: {
      title: "边界",
      id: "edge-1",
      actions: [
        { type: "http", label: "同主机跳转", url: "https://hooks.example.com/redir-same" },
        { type: "http", label: "跨主机跳转", url: "https://hooks.example.com/redir-cross" },
        { type: "http", label: "出错", method: "PUT", url: "https://hooks.example.com/fail" },
      ],
    },
  });
  const edge = apnsTo(M.token, (pl) => pl.id === "edge-1")[0]?.payload ?? {};
  const same = await tap(M, { message_id: "edge-1", index: 0, actions: edge.actions, act_sig: edge.act_sig });
  const landed = toHooks("/landed")[0];
  check("同主机跳转跟过去 → 200", same.json?.data?.status === 200 && same.json?.data?.ok === true && Boolean(landed), JSON.stringify(same.json));
  check("跳过去的那一跳照样带签名", landed && signatureValid(landed, secret));
  const cross = await tap(M, { message_id: "edge-1", index: 1, actions: edge.actions, act_sig: edge.act_sig });
  check("跨主机跳转停下 → ok:false，写明原因", cross.json?.data?.ok === false && /跨主机/.test(cross.json?.data?.error ?? ""), JSON.stringify(cross.json));
  check("带签名的请求没被引到别的主机", !inbox.some((e) => e.host.startsWith("elsewhere.")));
  const failed = await tap(M, { message_id: "edge-1", index: 2, actions: edge.actions, act_sig: edge.act_sig });
  const put = toHooks("/fail")[0];
  check("接收方 503 → {status:503, ok:false}", failed.json?.data?.status === 503 && failed.json?.data?.ok === false, JSON.stringify(failed.json));
  check("PUT 原样发出", put?.method === "PUT");
  const failCast = apnsTo(O.token, (pl) => pl.id === "edge-1" && pl.action_label === "出错")[0]?.payload ?? {};
  check("失败的广播：状态码 + action_ok=0", failCast.action_status === "503" && failCast.action_ok === "0", JSON.stringify(failCast));
  const crossCast = apnsTo(O.token, (pl) => pl.id === "edge-1" && pl.action_label === "跨主机跳转")[0]?.payload ?? {};
  check("跨主机跳转的广播：写跳转的状态码，action_ok=0", crossCast.aps?.alert?.title === "李四 点了「跨主机跳转」· 302" && crossCast.action_ok === "0", JSON.stringify(crossCast));
  const edgeReceipt = (await call("GET", `/${key}/receipt/edge-1`)).json?.data ?? {};
  check("回执记下三次，失败的 ok:false", edgeReceipt.actions?.length === 3 && edgeReceipt.actions.filter((a) => a.ok === false).length === 2, JSON.stringify(edgeReceipt.actions));

  await call("POST", `/${key}`, {
    body: {
      title: "查询",
      id: "get-1",
      actions: [
        { type: "http", label: "查状态", method: "GET", url: "https://hooks.example.com/status?q=1" },
        { type: "http", label: "慢", url: "https://hooks.example.com/slow" },
      ],
    },
  });
  const gp = apnsTo(M.token, (pl) => pl.id === "get-1")[0]?.payload ?? {};
  await tap(M, { message_id: "get-1", index: 0, actions: gp.actions, act_sig: gp.act_sig });
  const got = toHooks("/status")[0];
  check("GET 不带请求体，签的是「时间戳.」", got?.method === "GET" && got.body === "" && signatureValid(got, secret), JSON.stringify(got?.headers));
  const tSlow = Date.now();
  const slow = await tap(M, { message_id: "get-1", index: 1, actions: gp.actions, act_sig: gp.act_sig });
  const slowMs = Date.now() - tSlow;
  check("接收方 5 秒不回 → ok:false「5 秒内没有响应」", slow.json?.data?.ok === false && /5 秒/.test(slow.json?.data?.error ?? ""), JSON.stringify(slow.json));
  check("不会一直等下去（约 5 秒就回）", slowMs >= 4500 && slowMs < 9000, `${slowMs}ms`);
  const slowCast = apnsTo(O.token, (pl) => pl.id === "get-1" && pl.action_label === "慢")[0]?.payload ?? {};
  check("超时的广播：没有状态码，action_ok=0，写「没送到」", slowCast.action_status === undefined && slowCast.action_ok === "0" && slowCast.aps?.alert?.title === "李四 点了「慢」· 没送到", JSON.stringify(slowCast));

  console.log("\n★ 重置回调密钥：之后用新的签，旧的对不上");
  const regen = await as(O)("POST", `/account/${O.id}/channels/${cid}/callback-secret`);
  const newSecret = regen.json?.data?.callback_secret;
  check("重置 → 新密钥", typeof newSecret === "string" && newSecret !== secret);
  await tap(M, { message_id: "deploy-42", index: 1, actions: p.actions, act_sig: p.act_sig });
  const again = toHooks("/rollback").at(-1);
  check("新的请求用新密钥签", again && signatureValid(again, newSecret) && !signatureValid(again, secret));
  secret = newSecret;

  console.log("\n★ 个人通道：点按钮照样代发，但不广播");
  const P = await newAccount("赵六");
  await call("POST", `/${P.channel.key}`, {
    body: { title: "个人", id: "solo-1", actions: [{ type: "http", label: "重启", url: "https://hooks.example.com/restart" }] },
  });
  const sp = apnsTo(P.token, (pl) => pl.id === "solo-1")[0]?.payload ?? {};
  check("个人通道用普通类别", sp.aps?.category === "pigeonNotification", sp.aps?.category);
  const beforeSolo = inbox.length;
  const solo = await as(P)("POST", `/account/${P.id}/channels/${P.channel.id}/actions`, { message_id: "solo-1", index: 0, actions: sp.actions, act_sig: sp.act_sig });
  check("自己点 → 200", solo.json?.data?.status === 200, JSON.stringify(solo.json));
  const soloAfter = inbox.slice(beforeSolo);
  check("只有代发那一个请求，没有广播", soloAfter.length === 1 && soloAfter[0].path === "/restart", soloAfter.map((e) => `${e.host}${e.path}`).join(", "));
  const soloSecret = (await as(P)("GET", `/account/${P.id}/channels/${P.channel.id}/callback-secret`)).json?.data?.callback_secret;
  check("用的是这个通道自己的回调密钥", soloAfter[0] && signatureValid(soloAfter[0], soloSecret) && !signatureValid(soloAfter[0], secret));

  console.log("\n★ 通道默认的回调地址：设一次，之后的推送都回调");
  const patch = (defaults) => as(O)("PATCH", `/account/${O.id}/channels/${cid}`, { defaults });
  check("默认回调是 http → 400", (await patch({ callback: "http://hooks.example.com/x" })).status === 400);
  check("默认回调超过 200 字 → 400（截断了地址就坏了）", (await patch({ callback: `https://hooks.example.com/${"a".repeat(200)}` })).status === 400);
  check("默认按钮写错 → 400", (await patch({ actions: "看=ftp://x.example.com" })).status === 400);
  const setDefault = await patch({ callback: "https://hooks.example.com/default-events", level: "timeSensitive" });
  check("合法的默认回调 → 200", setDefault.status === 200, JSON.stringify(setDefault.json?.message));
  await call("POST", `/${key}`, { body: { title: "没写 callback", id: "dflt-1" } });
  const dp = apnsTo(M.token, (pl) => pl.id === "dflt-1")[0]?.payload ?? {};
  check("默认回调同样不进 payload", Boolean(dp.id) && !JSON.stringify(dp).includes("default-events"));
  await as(M)("POST", `/account/${M.id}/channels/${cid}/ack`, { message_id: "dflt-1", sig: dp.ack_sig });
  const dflt = toHooks("/default-events")[0];
  check("认领之后，默认回调地址收到 ack 事件", dflt?.headers["x-pigeon-event"] === "ack" && JSON.parse(dflt.body).id === "dflt-1" && signatureValid(dflt, secret), dflt?.body);
  await call("POST", `/${key}`, { body: { title: "单独指定", id: "dflt-2", callback: "https://hooks.example.com/override" } });
  const dp2 = apnsTo(M.token, (pl) => pl.id === "dflt-2")[0]?.payload ?? {};
  await as(M)("POST", `/account/${M.id}/channels/${cid}/ack`, { message_id: "dflt-2", sig: dp2.ack_sig });
  check("推送自己带的 callback 优先于默认值", toHooks("/override").length === 1 && toHooks("/default-events").length === 1);
  await patch({});

  console.log("\n★ 出站请求只去了该去的地方");
  const hosts = new Set(inbox.map((e) => e.host));
  check("只有 APNs 和 hooks.example.com", [...hosts].every((h) => h.endsWith("push.apple.com") || h === "hooks.example.com"), [...hosts].join(", "));
  check("ci.example.com（open 按钮）从没被服务端请求过", !hosts.has("ci.example.com"));
} catch (err) {
  failures++;
  console.log(`  ✗ 测试中途出错：${err?.stack ?? err}`);
} finally {
  shutdown();
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
