/**
 * 监控管理的整条链路：真的 Worker、真的巡检、真的推送出口。
 *
 *   node test/api-l3-lifecycle.test.mjs        （run-api.sh 会顺带跑它；它不用 BASE，自己起一套）
 *
 * api-l3-watches.test.mjs 跑在共用的本地 Worker 上，那里没有 APNs 私钥：告警一条也推不出去，
 * 「推了什么、推给谁、推没推」只能靠单元测试里的假 APNs 核对。这里把整套搬到真的 Worker 上：
 *   - 自己起一个 wrangler dev（独立的本地 KV），APNS_HOST 指向本机一个假的 APNs（https，自签证书靠
 *     NODE_EXTRA_CA_CERTS 让 Worker 信任）：告警真的从 deliver() 发出来，payload 逐条核对
 *   - 被监控的网址是本机一个小 http 服务，状态码、正文由测试随时改，还数着被抓了几次
 *   - 巡检走 /__test__/cron/watches?now=（拨钟、只看指定的监控），另有一次走 /__scheduled —— 真的 scheduled() 入口
 * 心跳的报到、编辑、立即检测都用真的时钟；拨钟只拨巡检。所有请求只发往本机，从不碰线上。
 */
import { spawn, execFileSync } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIN = 60_000;

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `  → ${detail}` : ""}`);
  }
}

const freePort = () =>
  new Promise((resolve) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// ── 假的 APNs：收下每一条，按测试的要求回状态码 ─────────────────────
const dir = mkdtempSync(join(tmpdir(), "pigeon-l3-e2e-"));
execFileSync(
  "openssl",
  [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", join(dir, "apns.key"), "-out", join(dir, "apns.crt"), "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-addext", "basicConstraints=critical,CA:TRUE",
  ],
  { stdio: "ignore" },
);
/** 收到的每一条：{ token, headers, payload } */
const pushes = [];
/** 假 APNs 回什么：200 收下；5xx 模拟 Apple 那边出了问题 */
let apnsStatus = 200;
const apns = createHttpsServer({ key: readFileSync(join(dir, "apns.key")), cert: readFileSync(join(dir, "apns.crt")) }, (req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let payload = null;
    try {
      payload = JSON.parse(body);
    } catch {
      /* 不是 JSON 的当没收到 */
    }
    pushes.push({ token: req.url.split("/").pop(), headers: req.headers, payload, status: apnsStatus });
    if (apnsStatus === 200) {
      res.writeHead(200);
      res.end();
    } else {
      res.writeHead(apnsStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ reason: "ServiceUnavailable" }));
    }
  });
});
await new Promise((resolve) => apns.listen(0, "127.0.0.1", resolve));

// ── 被监控的网站：/site/{名字}，状态码和正文随时改，数着被抓了几次 ─────
const sites = new Map();
const site = (name) => {
  if (!sites.has(name)) sites.set(name, { status: 200, body: "ok", hits: 0 });
  return sites.get(name);
};
const target = createHttpServer((req, res) => {
  const name = decodeURIComponent(req.url.replace(/^\/site\//, "").split("?")[0]);
  const s = site(name);
  s.hits += 1;
  res.writeHead(s.status, { "content-type": "text/html; charset=utf-8" });
  res.end(s.body);
});
await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
const TARGET = `http://127.0.0.1:${target.address().port}`;

// ── 起 Worker：独立的 KV、假 APNs 的地址、一把现生成的私钥 ─────────
const { privateKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const p8 = privateKey.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
const port = await freePort();
const inspector = await freePort();
const worker = spawn(
  "npx",
  [
    "wrangler", "dev", "--local", "--port", String(port), "--inspector-port", String(inspector),
    "--persist-to", join(dir, "state"), "--test-scheduled",
    "--var", "PIGEON_TEST_ADMIN:1", "--var", `APNS_KEY_P8:${p8}`, "--var", `APNS_HOST:localhost:${apns.address().port}`,
  ],
  // 自己一个进程组：收摊时连 workerd 一起收，不留占着端口的孤儿
  { cwd: ROOT, env: { ...process.env, NODE_EXTRA_CA_CERTS: join(dir, "apns.crt") }, stdio: ["ignore", "pipe", "pipe"], detached: true },
);
let log = "";
worker.stdout.on("data", (d) => (log += d));
worker.stderr.on("data", (d) => (log += d));

function shutdown() {
  try {
    process.kill(-worker.pid, "SIGTERM");
  } catch {
    /* 已经退了 */
  }
  apns.close();
  target.close();
  rmSync(dir, { recursive: true, force: true });
}
process.on("exit", shutdown);

for (let i = 0; i < 120 && !log.includes("Ready on http"); i++) await new Promise((r) => setTimeout(r, 500));
if (!log.includes("Ready on http")) {
  console.log("wrangler dev 起不来：\n" + log.split("\n").slice(-20).join("\n"));
  process.exit(1);
}
const BASE = `http://localhost:${port}`;

async function call(method, path, { body, secret, headers = {} } = {}) {
  const all = { ...headers };
  if (body !== undefined) all["content-type"] = typeof body === "string" ? "text/plain" : "application/json";
  if (secret) all.authorization = `Bearer ${secret}`;
  const res = await fetch(BASE + path, {
    method,
    headers: all,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 交给断言 */
  }
  return { status: res.status, json, headers: res.headers };
}

const account = (await call("POST", "/account", {
  body: { device_token: "ab".repeat(32), environment: "sandbox", device_name: "监控链路测试机" },
})).json?.data ?? {};
const A = { id: account.account_id, secret: account.secret, channel: account.channels?.[0] ?? {} };
if (!A.id) {
  console.log("建账号失败，后面没法测");
  process.exit(1);
}

const createWatch = async (body) =>
  (await call("POST", `/account/${A.id}/watches`, { secret: A.secret, body: { channelId: A.channel.id, ...body } })).json?.data?.watch ?? {};
const patch = (w, body) => call("PATCH", `/account/${A.id}/watches/${w.id}`, { secret: A.secret, body });
const checkNow = (w) => call("POST", `/account/${A.id}/watches/${w.id}/check`, { secret: A.secret });
const history = async (w, tz = "Asia/Shanghai") =>
  (await call("GET", `/account/${A.id}/watches/${w.id}/history?tz=${encodeURIComponent(tz)}`, { secret: A.secret })).json?.data ?? {};
const listed = async (w) =>
  ((await call("GET", `/account/${A.id}/watches`, { secret: A.secret })).json?.data?.watches ?? []).find((x) => x.id === w.id);
const sweep = async (now, ...ws) =>
  (await call("POST", `/__test__/cron/watches?now=${now}&only=${ws.map((w) => w.id).join(",")}`)).json?.data ?? {};
async function stateOf(w) {
  const keys = (await call("POST", `/__test__/watch-keys/${w.id}`)).json?.data?.keys ?? [];
  return keys.find((k) => k.name.startsWith("wstate:") || k.name.startsWith("hbstate:"))?.metadata ?? {};
}
const hb = (w, action = "", init = {}) => call(init.method ?? "GET", `/hb/${w.id}${action ? `/${action}` : ""}`, init);

/** 从上次取过之后新到的告警（带 alert 的；建账号时的静默探测不算），只看这个监控的 */
let seen = 0;
function newAlerts(ref) {
  const fresh = pushes.slice(seen);
  seen = pushes.length;
  return fresh.filter((p) => p.payload?.aps?.alert && (ref === undefined || p.payload.watch_id === ref));
}
const alertOf = (p) => ({
  title: p?.payload?.aps?.alert?.title ?? "",
  body: p?.payload?.aps?.alert?.body ?? "",
  level: p?.payload?.aps?.["interruption-level"],
  status: p?.payload?.status,
  id: p?.payload?.id,
  watchId: p?.payload?.watch_id,
  repeat: p?.payload?.repeat,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** 每 200 毫秒问一次，拿到结果（不是 null）就返回；等满 timeout 还没有就返回 null */
async function waitFor(fn, timeout = 10_000) {
  for (const until = Date.now() + timeout; Date.now() < until; await sleep(200)) {
    const got = await fn();
    if (got !== null && got !== undefined) return got;
  }
  return null;
}

/** 整分钟：历史按秒记、按小时切，起点对齐到整分钟，可用率才算得出整数 */
const wholeMinute = (ms) => Math.ceil(ms / MIN) * MIN;

/** 某个时区里 ms 那一刻是星期几（1 = 周一 … 7 = 周日）、几点几分 */
function localClock(ms, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  const days = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return { day: days[get("weekday")], time: `${String(Number(get("hour")) % 24).padStart(2, "0")}:${get("minute")}` };
}
/** 从 from 到 to（整分钟）的一次性维护窗口，按北京时间写：星期几取开始那天，跨午夜照样对 */
function windowBetween(from, to, tz = "Asia/Shanghai") {
  const start = localClock(from, tz);
  return { days: [start.day], start: start.time, end: localClock(to, tz).time, tz };
}

try {
  console.log("\n★ 真的 scheduled() 入口：整 5 分钟那个 cron 查网址，错开的那个只补发提醒");
  {
    const w = await createWatch({ kind: "up", url: `${TARGET}/site/cron`, intervalMinutes: 5, name: "cron 入口" });
    // scheduled() 把活交给 waitUntil 就返回了：/__scheduled 回来时巡检可能还在跑，只能等着看结果
    let r = await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent("2-59/5 * * * *")}`);
    await sleep(1500);
    check("提醒那个 cron 跑完：网址没被抓", r.ok && site("cron").hits === 0 && (await stateOf(w)).lastCheckedAt === undefined, `${r.status} hits=${site("cron").hits}`);
    r = await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent("*/5 * * * *")}`);
    const v = await waitFor(async () => {
      const found = await listed(w);
      return found?.last_status ? found : null;
    });
    check("★ 监控那个 cron：抓了一次，列表里有这次的状态和响应时间", r.ok && site("cron").hits === 1 && v?.last_status === "up" && typeof v.last_response_ms === "number", JSON.stringify(v));
    check("第一次就在线：不推", newAlerts(w.id).length === 0);
    await call("DELETE", `/account/${A.id}/watches/${w.id}`, { secret: A.secret });
  }

  console.log("\n★ 网址监控：连续两次失败才推「掉线了」，好了推「恢复了」，历史和可用率对得上");
  const T = wholeMinute(Date.now()) + MIN;
  {
    const w = await createWatch({ kind: "up", url: `${TARGET}/site/shop`, intervalMinutes: 5, name: "商城", level: "timeSensitive", repeat: 5 });
    await sweep(T, w);
    site("shop").status = 503;
    let report = await sweep(T + 5 * MIN, w);
    check("第一次失败：只记下，不推", report.checked === 1 && report.alerted === 0 && newAlerts(w.id).length === 0 && (await stateOf(w)).failCount === 1);
    report = await sweep(T + 10 * MIN, w);
    const down = newAlerts(w.id);
    const a = alertOf(down[0]);
    check(
      "★ 第二次失败：推「掉线了」，带 watch_id、重要级别、每 5 分钟重复",
      report.alerted === 1 && down.length === 1 && a.title === "🔴 商城 掉线了" && a.body.includes("HTTP 503") &&
        a.level === "time-sensitive" && a.status === "firing" && a.watchId === w.id && a.id === `watch-${w.id}` && a.repeat === "5",
      JSON.stringify(down.map((p) => p.payload)),
    );
    check("推给的是这台设备", down[0]?.token === "ab".repeat(32) && down[0]?.headers?.["apns-collapse-id"] === `watch-${w.id}`);
    await sweep(T + 15 * MIN, w);
    check("还挂着：不重复推（重复提醒另有 cron 管）", newAlerts(w.id).length === 0);
    site("shop").status = 200;
    report = await sweep(T + 20 * MIN, w);
    const up = alertOf(newAlerts(w.id)[0]);
    check(
      "★ 恢复：推「恢复了」，同一个事件 id，不带重复",
      report.alerted === 1 && up.title === "🟢 商城 恢复了" && up.status === "resolved" && up.id === `watch-${w.id}` && up.watchId === w.id && up.repeat === undefined,
      JSON.stringify(up),
    );
    const h = await history(w);
    check(
      "★ 历史：上线 → 掉线 → 恢复，说明照实",
      h.changes?.map((c) => c.status).join(",") === "up,down,up" && h.changes[1].detail === "HTTP 503" && h.changes[1].at === T + 10 * MIN && h.changes[2].detail === "HTTP 200",
      JSON.stringify(h.changes),
    );
    check(
      "逐次检查五次，失败的三次标着 ok: false，都有响应时间",
      h.checks?.length === 5 && h.checks.map((c) => (c.ok ? 1 : 0)).join("") === "10001" && h.checks.every((c) => typeof c.ms === "number"),
      JSON.stringify(h.checks),
    );
    // T → T+5 在线，T+5 → T+20 看到的都是失败（第一次失败就算异常，不等确认）
    check("★ 可用率按时长：20 分钟里 15 分钟异常 = 25%", h.uptime_24h === 25 && h.uptime_30d === 25, JSON.stringify(h));
    const sum = (key) => (h.daily ?? []).reduce((s, d) => s + d[key], 0);
    check("按天汇总加起来 300 秒正常、900 秒异常", sum("up_seconds") === 300 && sum("down_seconds") === 900, JSON.stringify(h.daily));
    check("列表视图的可用率和历史一致", (await listed(w))?.uptime_24h === 25);
    await call("DELETE", `/account/${A.id}/watches/${w.id}`, { secret: A.secret });
  }

  console.log("\n★ 维护窗口：窗口里掉线只记不推，窗口结束还挂着就补推一条");
  {
    const T2 = T + 60 * MIN;
    const window = windowBetween(T2 + 10 * MIN, T2 + 40 * MIN);
    const w = await createWatch({ kind: "up", url: `${TARGET}/site/nas`, intervalMinutes: 5, name: "家里 NAS", maintenance: window });
    check("新建时带上维护窗口", w.maintenance?.start === window.start && w.maintenance.tz === "Asia/Shanghai", JSON.stringify(w));
    await sweep(T2, w);
    site("nas").status = 502;
    await sweep(T2 + 10 * MIN, w);
    const report = await sweep(T2 + 15 * MIN, w);
    let st = await stateOf(w);
    check(
      "★ 窗口里确认掉线：一条不推，记下「压下之前是在线」和窗口结束的时刻",
      report.quieted === 1 && report.alerted === 0 && newAlerts(w.id).length === 0 && st.lastStatus === "down" &&
        st.quiet?.from === "up" && st.quiet.why === "maint" && st.quiet.until === T2 + 40 * MIN,
      JSON.stringify({ report, st }),
    );
    for (const k of [20, 25, 30, 35]) await sweep(T2 + k * MIN, w);
    check("窗口里一直挂着：还是不推", newAlerts(w.id).length === 0);
    await sweep(T2 + 40 * MIN, w);
    const late = newAlerts(w.id);
    const a = alertOf(late[0]);
    check(
      "★ 窗口一结束：补推「掉线了」，写明是维护窗口内出的事",
      late.length === 1 && a.title === "🔴 家里 NAS 掉线了" && a.body.includes("（维护窗口内掉线，到现在还没恢复）") && a.level === "time-sensitive" && a.watchId === w.id,
      JSON.stringify(late.map((p) => p.payload)),
    );
    st = await stateOf(w);
    check("补推之后不再压着", st.quiet === undefined && st.lastStatus === "down", JSON.stringify(st));
    const h = await history(w);
    check(
      "★ 历史：窗口里的掉线标着 quiet；窗口里的异常不算进可用率",
      h.changes?.[1]?.status === "down" && h.changes[1].quiet === true && h.uptime_24h === 100,
      JSON.stringify({ changes: h.changes, uptime: h.uptime_24h }),
    );
    await call("DELETE", `/account/${A.id}/watches/${w.id}`, { secret: A.secret });
  }

  console.log("\n★ 维护窗口：之前推过的掉线在窗口里恢复，静默送达；窗口里掉了又好，什么都不推");
  {
    const T3 = T + 3 * 60 * MIN;
    const w = await createWatch({ kind: "up", url: `${TARGET}/site/api`, intervalMinutes: 5, name: "接口" });
    await sweep(T3, w);
    site("api").status = 500;
    await sweep(T3 + 5 * MIN, w);
    await sweep(T3 + 10 * MIN, w);
    check("窗口之前掉线：照常推", alertOf(newAlerts(w.id)[0]).status === "firing");
    const r = await patch(w, { maintenance: windowBetween(T3 + 15 * MIN, T3 + 45 * MIN) });
    check("编辑加上维护窗口", r.status === 200 && r.json?.data?.watch?.maintenance?.days?.length === 1, JSON.stringify(r.json));
    site("api").status = 200;
    await sweep(T3 + 15 * MIN, w);
    const back = newAlerts(w.id);
    const a = alertOf(back[0]);
    check(
      "★ 窗口里恢复：照推「恢复了」，但是静默（passive、不出声）",
      back.length === 1 && a.title === "🟢 接口 恢复了" && a.status === "resolved" && a.level === "passive" && back[0].payload.aps.sound === undefined,
      JSON.stringify(back.map((p) => p.payload)),
    );
    site("api").status = 500;
    await sweep(T3 + 20 * MIN, w);
    await sweep(T3 + 25 * MIN, w);
    check("窗口里又掉线：压着", (await stateOf(w)).quiet?.from === "up" && newAlerts(w.id).length === 0);
    site("api").status = 200;
    await sweep(T3 + 30 * MIN, w);
    check("窗口里又好了：压着的一笔勾销", (await stateOf(w)).quiet === undefined && newAlerts(w.id).length === 0);
    await sweep(T3 + 45 * MIN, w);
    check("★ 窗口结束：什么都不推", newAlerts(w.id).length === 0);
    await call("DELETE", `/account/${A.id}/watches/${w.id}`, { secret: A.secret });
  }

  console.log("\n★ 暂停：巡检不抓；暂停中立即检测照查、告警压着；恢复后还挂着就补推，换网址后推「恢复了」");
  {
    const T4 = T + 5 * 60 * MIN;
    const w = await createWatch({ kind: "up", url: `${TARGET}/site/blog`, intervalMinutes: 5, name: "博客" });
    await sweep(T4, w);
    site("blog").status = 500;
    await sweep(T4 + 5 * MIN, w);
    let r = await patch(w, { paused_until: 0 });
    check("一直暂停", r.status === 200 && r.json?.data?.watch?.paused_until === 0);
    const hits = site("blog").hits;
    const report = await sweep(T4 + 30 * MIN, w);
    check("★ 暂停着：巡检一次也不抓", report.checked === 0 && site("blog").hits === hits, JSON.stringify(report));
    r = await checkNow(w);
    check(
      "★ 暂停中立即检测：照查，第二次失败确认掉线，但不推",
      r.status === 200 && r.json?.data?.result?.status === "down" && r.json.data.result.detail === "HTTP 500" && r.json.data.alerted === false &&
        r.json.data.watch.last_status === "down" && newAlerts(w.id).length === 0,
      JSON.stringify(r.json),
    );
    const st = await stateOf(w);
    check("压下之前是在线，暂停没有结束时刻", st.quiet?.from === "up" && st.quiet.why === "pause" && st.quiet.until === 0, JSON.stringify(st));
    r = await checkNow(w);
    check("★ 马上再查 → 429，说几秒后再试", r.status === 429 && /秒前刚检查过.*秒后再试/.test(r.json?.error ?? "") && Number(r.headers.get("retry-after")) > 0, JSON.stringify(r.json));
    r = await patch(w, { paused_until: null });
    check("恢复监控", r.status === 200 && !("paused_until" in r.json.data.watch));
    await sweep(Date.now() + 1000, w);
    const late = newAlerts(w.id);
    check(
      "★ 恢复之后第一轮：还挂着，补推一条，写明是暂停期间掉的",
      late.length === 1 && alertOf(late[0]).body.includes("（暂停期间掉线，到现在还没恢复）"),
      JSON.stringify(late.map((p) => p.payload)),
    );
    r = await patch(w, { url: `${TARGET}/site/blog-new` });
    check("换到新网址：状态还是掉线", r.status === 200 && r.json?.data?.watch?.last_status === "down" && r.json.data.watch.url === `${TARGET}/site/blog-new`);
    await sweep(Date.now() + 2000, w);
    const up = alertOf(newAlerts(w.id)[0]);
    check("★ 新网址好的：下一轮就推「恢复了」，正文是新网址", up.status === "resolved" && up.body.startsWith(`${TARGET}/site/blog-new`), JSON.stringify(up));
    await call("DELETE", `/account/${A.id}/watches/${w.id}`, { secret: A.secret });
  }

  console.log("\n★ 编辑的时机：改间隔马上按新间隔排；暂停到某时，到点接着查；压着告警时去掉维护窗口，下一轮就补判");
  {
    // 暂停用的是真的时钟（编辑时刻 + 30 分钟），巡检的钟也得从现在拨起：上一次检查要是记在几个小时之后，
    // 暂停结束时它还没到期，看不出「到点接着查」
    const TE = wholeMinute(Date.now());
    const w = await createWatch({ kind: "up", url: `${TARGET}/site/docs`, intervalMinutes: 60, name: "文档站" });
    await sweep(TE, w);
    check("每小时查一次：下次在一小时后", (await stateOf(w)).nextDueAt === TE + 60 * MIN);
    let r = await patch(w, { intervalMinutes: 5 });
    check("★ 改成每 5 分钟：下次跟着提前", r.status === 200 && (await stateOf(w)).nextDueAt === TE + 5 * MIN, JSON.stringify(await stateOf(w)));

    const until = Date.now() + 30 * MIN;
    await patch(w, { paused_until: until });
    const hits = site("docs").hits;
    let report = await sweep(until - 60_000, w);
    check("暂停到某时：之前巡检不抓", report.checked === 0 && site("docs").hits === hits, JSON.stringify(report));
    report = await sweep(until, w);
    check("★ 到点：接着查", report.checked === 1 && site("docs").hits === hits + 1, JSON.stringify(report));
    // 巡检的钟已经拨过了暂停结束，真的时钟还没到：手动恢复一下，免得后面的编辑还当它在暂停里
    await patch(w, { paused_until: null });

    const from = wholeMinute(until + 5 * MIN);
    await patch(w, { maintenance: windowBetween(from, from + 60 * MIN) });
    site("docs").status = 500;
    await sweep(from, w);
    await sweep(from + 5 * MIN, w);
    check("窗口里掉线：压着", (await stateOf(w)).quiet?.why === "maint" && newAlerts(w.id).length === 0);
    r = await patch(w, { maintenance: null });
    check("去掉维护窗口：压着的告警改成现在就该补判", r.status === 200 && (await stateOf(w)).quiet?.until <= Date.now(), JSON.stringify(await stateOf(w)));
    await sweep(from + 6 * MIN, w);
    const late = alertOf(newAlerts(w.id)[0]);
    check("★ 下一轮：补推「掉线了」，还是写明维护窗口内出的事", late.status === "firing" && late.body.includes("（维护窗口内掉线，到现在还没恢复）"), JSON.stringify(late));
    await call("DELETE", `/account/${A.id}/watches/${w.id}`, { secret: A.secret });
  }

  console.log("\n★ 关键词：立即检测查出来的推一次，之后的巡检不再重复推");
  {
    site("tickets").body = "<p>暂无余票</p>";
    const w = await createWatch({ kind: "keyword", url: `${TARGET}/site/tickets`, keyword: "有票", present: true, intervalMinutes: 5, name: "演唱会" });
    const T5 = T + 7 * 60 * MIN;
    await sweep(T5, w);
    check("第一次：没有，也不推", (await stateOf(w)).lastStatus === "absent" && newAlerts(w.id).length === 0);
    site("tickets").body = "<p>有票了！</p>";
    const r = await checkNow(w);
    const got = newAlerts(w.id);
    check(
      "★ 立即检测：找到了，推「出现了」（事件 id 带 -present），回 alerted: true",
      r.json?.data?.result?.status === "present" && r.json.data.alerted === true && got.length === 1 &&
        alertOf(got[0]).body.startsWith("「有票」出现了") && alertOf(got[0]).id === `watch-${w.id}-present` && alertOf(got[0]).watchId === w.id,
      JSON.stringify({ r: r.json, got: got.map((p) => p.payload) }),
    );
    await sweep(T5 + 10 * MIN, w);
    check("★ 下一轮巡检还是有票：不再推", newAlerts(w.id).length === 0);
    await call("DELETE", `/account/${A.id}/watches/${w.id}`, { secret: A.secret });
  }

  console.log("\n★ APNs 出问题：告警不算发出，状态不动，下一轮重推");
  {
    const w = await createWatch({ kind: "up", url: `${TARGET}/site/flaky`, intervalMinutes: 5, name: "偶尔抽风" });
    const T6 = T + 9 * 60 * MIN;
    await sweep(T6, w);
    site("flaky").status = 500;
    await sweep(T6 + 5 * MIN, w);
    apnsStatus = 503;
    let report = await sweep(T6 + 10 * MIN, w);
    let st = await stateOf(w);
    check(
      "★ 推不出去：记成重试，状态还是在线",
      report.retrying === 1 && report.alerted === 0 && st.lastStatus === "up" && st.pendingAlertAttempts === 1 && st.nextDueAt === T6 + 15 * MIN,
      JSON.stringify({ report, st }),
    );
    newAlerts();
    apnsStatus = 200;
    report = await sweep(T6 + 15 * MIN, w);
    st = await stateOf(w);
    check("★ APNs 好了：下一轮推出去，状态记成掉线", report.alerted === 1 && st.lastStatus === "down" && st.pendingAlertAttempts === undefined && alertOf(newAlerts(w.id)[0]).status === "firing", JSON.stringify({ report, st }));
    await call("DELETE", `/account/${A.id}/watches/${w.id}`, { secret: A.secret });
  }

  console.log("\n★ 心跳：/start 计时、退出码、失联、恢复，告警里只有 ref、没有报到凭据");
  {
    const w = await createWatch({ kind: "heartbeat", intervalMinutes: 5, graceMinutes: 5, name: "夜间备份" });
    check("心跳的 ref 是单向推出来的", /^hb-[0-9a-f]{24}$/.test(w.ref ?? ""), JSON.stringify(w));
    let r = await hb(w, "start");
    const startedAt = r.json?.data?.started_at;
    check("/start → 记下开始", r.status === 200 && typeof startedAt === "number");
    check("列表里写着正在跑", (await listed(w))?.running_since === startedAt);
    r = await hb(w, "0");
    check("★ 退出码 0：第一次报到，回这次用时，不推", r.status === 200 && r.json?.data?.status === "up" && typeof r.json.data.duration_ms === "number" && newAlerts(w.ref).length === 0, JSON.stringify(r.json));
    r = await hb(w, "start");
    check("4 分钟内又 /start（比约定还勤）：不记，回的还是上一次的开始", r.status === 200 && r.json?.data?.started_at === startedAt, JSON.stringify(r.json));
    r = await hb(w, "3", { method: "POST", body: "磁盘满了" });
    const failed = newAlerts(w.ref);
    const f = alertOf(failed[0]);
    check(
      "★ 退出码 3：推「报告失败」，写退出码和说明（这一轮没记开始，就没有用时）",
      r.json?.data?.status === "down" && !("duration_ms" in r.json.data) && failed.length === 1 && f.title === "🔴「夜间备份」报告失败" &&
        f.body === "退出码 3：磁盘满了" && f.status === "firing" && f.id === w.ref,
      JSON.stringify({ r: r.json, got: failed.map((p) => p.payload) }),
    );
    check("★ 告警里的 watch_id 是 ref；整条 payload 里找不到报到凭据", f.watchId === w.ref && !JSON.stringify(failed[0]?.payload).includes(w.id));
    r = await hb(w);
    const back = alertOf(newAlerts(w.ref)[0]);
    check("正常报到：推「恢复上报」", back.title === "🟢「夜间备份」恢复上报" && back.status === "resolved" && back.watchId === w.ref, JSON.stringify(back));
    const lastPing = Date.now();
    let report = await sweep(lastPing + 9 * MIN, w);
    check("还没过「间隔 + 宽限」：不推", report.alerted === 0 && newAlerts(w.ref).length === 0);
    report = await sweep(lastPing + 11 * MIN, w);
    const lost = alertOf(newAlerts(w.ref)[0]);
    check(
      "★ 过了 10 分钟没来：推「没有按时上报」",
      report.alerted === 1 && lost.title === "🔴「夜间备份」没有按时上报" && lost.body.includes("预期每 5 分钟一次") && lost.watchId === w.ref,
      JSON.stringify(lost),
    );
    await sweep(lastPing + 20 * MIN, w);
    check("失联只推一次", newAlerts(w.ref).length === 0);
    await hb(w, "0");
    const h = await history(w);
    check(
      "★ 历史：开始上报 → 退出码 3 → 恢复上报 → 没有按时上报 → 恢复上报",
      h.changes?.map((c) => c.detail).join(",") === "开始上报,退出码 3,恢复上报,没有按时上报,恢复上报",
      JSON.stringify(h.changes),
    );
    check("逐次记录五次：只有记过开始的那次带用时", h.checks?.length === 5 && h.checks.filter((c) => typeof c.ms === "number").length === 1 && typeof h.checks[0].ms === "number", JSON.stringify(h.checks));
    await call("DELETE", `/account/${A.id}/watches/${w.id}`, { secret: A.secret });
  }

  console.log("\n★ 心跳：按约定的节奏 /start，失败的提醒里写这次用了多久");
  {
    const w = await createWatch({ kind: "heartbeat", intervalMinutes: 60, name: "编译" });
    await hb(w);
    // 同一把键一秒内写两次要等（KV 的限制），这一秒会算进用时里：先错开，让用时只是下面那 1.1 秒
    await sleep(1100);
    let r = await hb(w, "start");
    check("上一次报到之后第一次 /start：记下", typeof r.json?.data?.started_at === "number" && (await listed(w))?.running_since === r.json.data.started_at);
    await sleep(1100);
    r = await hb(w, "7?msg=" + encodeURIComponent("测试没过"));
    const got = alertOf(newAlerts(w.ref)[0]);
    check(
      "★ GET …/7?msg=：推「报告失败」，写退出码、说明和这次用时",
      r.json?.data?.duration_ms >= 1000 && got.body.startsWith("退出码 7：测试没过\n这次用时 1 秒") && got.watchId === w.ref,
      JSON.stringify({ r: r.json, got }),
    );
    const v = await listed(w);
    check("列表带 last_duration_ms，不再「正在跑」", v?.last_duration_ms >= 1000 && !("running_since" in v), JSON.stringify(v));
    const h = await history(w);
    check("历史里这次失败带着用时，说明不存（只记退出码）", h.checks?.at(-1)?.ok === false && h.checks.at(-1).ms >= 1000 && h.changes?.at(-1)?.detail === "退出码 7", JSON.stringify(h));
    await call("DELETE", `/account/${A.id}/watches/${w.id}`, { secret: A.secret });
  }

  console.log("\n★ 心跳：开始了却一直没报到，失联提醒里说这一轮已经跑了多久");
  {
    const w = await createWatch({ kind: "heartbeat", intervalMinutes: 5, graceMinutes: 5, name: "导出报表" });
    await hb(w);
    const lastPing = Date.now();
    await sleep(1100);
    await hb(w, "start");
    await sweep(lastPing + 11 * MIN, w);
    const lost = alertOf(newAlerts(w.ref)[0]);
    check(
      "★ 「没有按时上报」里多一句：这一轮已经跑了 10 分钟，还没结束",
      lost.title === "🔴「导出报表」没有按时上报" && /^上次上报在 1[01] 分钟前，预期每 5 分钟一次。这一轮已经跑了 \d+ 分钟，还没结束。$/.test(lost.body),
      JSON.stringify(lost),
    );
    check("列表里还写着正在跑", typeof (await listed(w))?.running_since === "number");
    await call("DELETE", `/account/${A.id}/watches/${w.id}`, { secret: A.secret });
  }

  console.log("\n★ 心跳 + 维护窗口：窗口里失联不推，窗口结束还没来就补推「仍未恢复」");
  {
    const w = await createWatch({ kind: "heartbeat", intervalMinutes: 5, graceMinutes: 5, name: "同步任务" });
    await hb(w);
    const R = Date.now();
    const from = wholeMinute(R + 8 * MIN);
    const until = from + 22 * MIN;
    await patch(w, { maintenance: windowBetween(from, until) });
    let report = await sweep(R + 11 * MIN, w);
    let st = await stateOf(w);
    check(
      "★ 窗口里失联：不推，记成掉线、压着",
      report.quieted === 1 && report.alerted === 0 && newAlerts(w.ref).length === 0 && st.lastStatus === "down" && st.quiet?.from === "up" && st.quiet.until === until && st.nextDueAt === until - 1,
      JSON.stringify({ report, st }),
    );
    report = await sweep(R + 20 * MIN, w);
    check("窗口里：不到结束不再看", report.due === 0);
    await sweep(until, w);
    const late = newAlerts(w.ref);
    const a = alertOf(late[0]);
    check(
      "★ 窗口结束还没来：补推「仍未恢复」，写明是维护窗口内没有按时上报",
      late.length === 1 && a.title === "🔴「同步任务」仍未恢复" && a.body.startsWith("维护窗口内没有按时上报，到现在还没恢复。") && a.watchId === w.ref,
      JSON.stringify(late.map((p) => p.payload)),
    );
    st = await stateOf(w);
    check("补推之后：不再压着，也不用再排队", st.quiet === undefined && st.nextDueAt === 0, JSON.stringify(st));
    await hb(w);
    check("回来报到：推「恢复上报」", alertOf(newAlerts(w.ref)[0]).status === "resolved");
    await call("DELETE", `/account/${A.id}/watches/${w.id}`, { secret: A.secret });
  }

  console.log("\n★ 心跳 + 暂停：暂停中报了失败不推，恢复监控后还没好就补推");
  {
    const w = await createWatch({ kind: "heartbeat", intervalMinutes: 5, graceMinutes: 5, name: "日志清理" });
    await hb(w);
    await patch(w, { paused_until: 0 });
    let r = await hb(w, "2");
    check("★ 暂停中退出码 2：记成失败，不推", r.json?.data?.status === "down" && newAlerts(w.ref).length === 0, JSON.stringify(r.json));
    const report = await sweep(Date.now() + 60 * MIN, w);
    check("一直暂停：巡检不看它", report.due === 0 && newAlerts(w.ref).length === 0, JSON.stringify(report));
    r = await patch(w, { paused_until: null });
    check("恢复监控", r.status === 200 && !("paused_until" in r.json.data.watch));
    await sweep(Date.now() + 1000, w);
    const late = alertOf(newAlerts(w.ref)[0]);
    check("★ 恢复后第一轮：补推「仍未恢复」，说明取自历史（退出码 2）", late.title === "🔴「日志清理」仍未恢复" && late.body.startsWith("暂停期间退出码 2，到现在还没恢复。"), JSON.stringify(late));
    await call("DELETE", `/account/${A.id}/watches/${w.id}`, { secret: A.secret });
  }

  console.log("\n★ 删掉之后：报到地址作废，巡检不再碰它");
  {
    const w = await createWatch({ kind: "heartbeat", intervalMinutes: 5, name: "临时" });
    await hb(w);
    await call("DELETE", `/account/${A.id}/watches/${w.id}`, { secret: A.secret });
    check("报到 → 404", (await hb(w)).status === 404);
    const report = await sweep(Date.now() + 60 * MIN, w);
    check("巡检里没有它，也不推", report.due === 0 && newAlerts(w.ref).length === 0, JSON.stringify(report));
  }

  await call("DELETE", `/account/${A.id}`, { secret: A.secret });
} catch (err) {
  failures++;
  console.log(`  ✗ 测试中途出错：${err?.stack ?? err}`);
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
