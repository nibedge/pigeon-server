/**
 * 心跳报到的端到端测试：/hb/{id}/fail 只收 POST；链接预览、浏览器预取回 200、什么也不记。
 *
 *   BASE=http://localhost:8799 node test/api-s1-hb.test.mjs
 *
 * 报到地址常被贴进聊天里，对方服务器抓预览发来的 GET 不能算报到，更不能算「报告失败」。
 */
const BASE = process.env.BASE || "http://localhost:8799";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `  → ${detail}` : ""}`);
  }
}

async function call(method, path, { body, secret, headers = {} } = {}) {
  const all = { ...headers };
  if (body !== undefined) all["content-type"] = "application/json";
  if (secret) all.authorization = `Bearer ${secret}`;
  const res = await fetch(BASE + path, { method, headers: all, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 交给断言去判断 */
  }
  return { status: res.status, json };
}

/** 每次跑都换一批令牌：本地 KV 跨次保留 */
const run = Date.now().toString(36);
const token = (seed) => (seed + run).repeat(64).slice(0, 64);

async function newAccount(seed, name) {
  const r = await call("POST", "/account", {
    body: { device_token: token(seed), environment: "sandbox", device_name: name },
  });
  const data = r.json?.data ?? {};
  return { id: data.account_id, secret: data.secret, channel: data.channels?.[0] ?? {} };
}

const createWatch = (account, body) => call("POST", `/account/${account.id}/watches`, { secret: account.secret, body });

/** 这个心跳记下了没有：有状态键就是记下过报到 */
async function stateOf(id) {
  const r = await call("POST", `/__test__/watch-keys/${id}`);
  const keys = r.json?.data?.keys ?? [];
  return keys.find((k) => k.name.startsWith("hbstate:"))?.metadata ?? null;
}

const A = await newAccount("sh", "心跳测试机");

console.log("\n★ /hb/{id}/fail 只收 POST；预览、预取什么也不记");
{
  const hb = (await createWatch(A, { kind: "heartbeat", channelId: A.channel.id, intervalMinutes: 60, name: "预览测试" })).json?.data?.watch ?? {};
  const bot = { "user-agent": "TelegramBot (like TwitterBot)" };
  const preview = await call("GET", `/hb/${hb.id}`, { headers: bot });
  check("★ 聊天软件抓预览（UA 带 bot）→ 200，标明跳过", preview.status === 200 && preview.json?.data?.skipped === "preview", JSON.stringify(preview.json));
  const hitFail = await call("GET", `/hb/${hb.id}/fail`, { headers: { "user-agent": "facebookexternalhit/1.1" } });
  check("★ 预览爬虫点开 /fail → 200，不当成失败", hitFail.status === 200 && hitFail.json?.data?.skipped === "preview");
  check("浏览器预取（Sec-Purpose）→ 跳过", (await call("GET", `/hb/${hb.id}`, { headers: { "sec-purpose": "prefetch" } })).json?.data?.skipped === "preview");
  check("HEAD 也按 UA 挡", (await fetch(`${BASE}/hb/${hb.id}`, { method: "HEAD", headers: bot })).status === 200);
  check("★ 这些都没记下任何报到：还是 new，没有状态键", (await stateOf(hb.id)) === null);

  const get = await call("GET", `/hb/${hb.id}/fail?msg=${encodeURIComponent("磁盘满了")}`);
  check("★ 普通 GET /fail → 405，说明请用 POST", get.status === 405 && (get.json?.message ?? "").includes("POST"), JSON.stringify(get.json));
  check("HEAD /fail → 405", (await fetch(`${BASE}/hb/${hb.id}/fail`, { method: "HEAD" })).status === 405);
  check("405 也没记下什么", (await stateOf(hb.id)) === null);

  const ping = await call("GET", `/hb/${hb.id}`, { headers: { "user-agent": "curl/8.7.1" } });
  check("curl 的 GET 报到照常记", ping.status === 200 && ping.json?.data?.status === "up");
  const posted = await call("POST", `/hb/${hb.id}/fail`, { headers: { "user-agent": "BackupBot/1.0" }, body: { msg: "备份失败" } });
  check("★ POST 报失败照常记，哪怕 UA 里带 bot（预览从来不 POST）", posted.status === 200 && posted.json?.data?.status === "down", JSON.stringify(posted.json));
  const robot = await call("GET", `/hb/${hb.id}`, { headers: { "user-agent": "UptimeRobot/2.0" } });
  check("UA 叫某某Robot 的监控服务不算预览，照常报到", robot.json?.data?.status === "up", JSON.stringify(robot.json));
  await call("DELETE", `/account/${A.id}/watches/${hb.id}`, { secret: A.secret });
}

await call("DELETE", `/account/${A.id}`, { secret: A.secret });
console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
