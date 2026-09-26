/**
 * 监控存储改版的端到端测试：配置、索引、状态分开存之后，在真跑的 Worker 和本地 KV 上核对 ——
 * 删号、删通道时监控一起删干净；报到只动状态键；停用的通道不删监控、报到回 403；删掉的不复活。
 *
 *   BASE=http://localhost:8799 node test/api-s1-watches.test.mjs
 *
 * KV 里留下了哪些键，走 /__test__/watch-keys/{id} 看（只在 PIGEON_TEST_ADMIN=1 的本地实例上有）。
 * 本地连不上 APNs，告警推送一律投递失败；这里只核对存储和回应，不核对推没推出去。
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

async function call(method, path, { body, secret } = {}) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (secret) headers.authorization = `Bearer ${secret}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 交给断言去判断 */
  }
  return { status: res.status, json, headers: res.headers };
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

async function newWatch(account, body) {
  const r = await call("POST", `/account/${account.id}/watches`, { secret: account.secret, body });
  return r.json?.data?.watch ?? {};
}

/** 这个监控在 KV 里的键：{ names, meta(前缀), config } */
async function footprint(id) {
  const r = await call("POST", `/__test__/watch-keys/${id}`);
  const keys = r.json?.data?.keys ?? [];
  return {
    names: keys.map((k) => k.name.split(":")[0]).sort(),
    meta: (prefix) => keys.find((k) => k.name.startsWith(prefix))?.metadata ?? null,
    config: r.json?.data?.config ?? null,
  };
}

const listOf = async (account) =>
  (await call("GET", `/account/${account.id}/watches`, { secret: account.secret })).json?.data?.watches ?? [];

console.log("\n监控分开存：配置、索引、状态");
const A = await newAccount("wa", "监控测试机");
const B = await newAccount("wb", "旁人");
const spare = (await call("POST", `/account/${A.id}/channels`, { secret: A.secret, body: { name: "备用" } })).json?.data?.channel ?? {};
const hb = await newWatch(A, { kind: "heartbeat", channelId: A.channel.id, intervalMinutes: 60, name: "夜间备份" });
const hbSpare = await newWatch(A, { kind: "heartbeat", channelId: spare.id, intervalMinutes: 60, name: "备用通道上的心跳" });
const site = await newWatch(A, { kind: "up", channelId: A.channel.id, url: "https://example.invalid/", intervalMinutes: 99999 });
const theirs = await newWatch(B, { kind: "heartbeat", channelId: B.channel.id, intervalMinutes: 30 });
{
  check("建好三个监控", Boolean(hb.id && hbSpare.id && site.id && theirs.id), JSON.stringify({ hb, spare }));
  check("★ 网址监控的间隔封顶 1 天", site.interval_minutes === 1440, String(site.interval_minutes));

  const fresh = await footprint(hb.id);
  check("★ 新建：只有配置和索引，状态键等第一次报到", fresh.names.join() === "watch,wown", fresh.names.join());
  check("★ 索引的 metadata 带通道和类型", fresh.meta("wown")?.channelId === A.channel.id && fresh.meta("wown")?.kind === "heartbeat");

  const ping = await call("GET", `/hb/${hb.id}`);
  check("报到 → 200", ping.status === 200 && ping.json?.data?.status === "up");
  const after = await footprint(hb.id);
  const state = after.meta("hbstate");
  check("★ 报到只写状态键，metadata 里算好了何时算失联", after.names.join() === "hbstate,watch,wown" && state?.lastStatus === "up" && state?.nextDueAt === state?.lastPingAt + 66 * 60_000, JSON.stringify(state));
  check("★ 配置里没有状态字段（报到不改配置）", after.config && after.config.lastPingAt === undefined && after.config.lastStatus === undefined);
  const listed = (await listOf(A)).find((w) => w.id === hb.id);
  check("列表里是配置 + 状态", listed?.last_status === "up" && listed?.last_ping_at === state?.lastPingAt, JSON.stringify(listed));

  const mine = await listOf(A);
  check("★ 只列自己的（3 个），看不到别人的", mine.length === 3 && !mine.some((w) => w.id === theirs.id), mine.map((w) => w.name).join());
  check("测试接口只收 POST", (await call("GET", `/__test__/watch-keys/${hb.id}`)).status === 404);
}

console.log("\n★ 删通道：推给它的监控一起删");
{
  check("删之前报到正常", (await call("GET", `/hb/${hbSpare.id}`)).status === 200);
  const del = await call("DELETE", `/account/${A.id}/channels/${spare.id}`, { secret: A.secret });
  check("删备用通道 → 200", del.status === 200, JSON.stringify(del.json));
  check("★ 报到地址随之作废 → 404", (await call("GET", `/hb/${hbSpare.id}`)).status === 404);
  const left = await footprint(hbSpare.id);
  check("★ KV 里只剩一块墓碑", left.names.join() === "watchdel" && left.config === null, left.names.join());
  check("别的监控还在", (await listOf(A)).length === 2);
}

console.log("\n★ 停用：监控不删，报到回 403；恢复后接着用");
{
  const suspended = await call("POST", `/__test__/suspend/${A.channel.id}`);
  check("停用默认通道", suspended.status === 200);
  const failReport = await call("POST", `/hb/${hb.id}/fail`, { body: { msg: "停用期间的失败" } });
  check("★ 停用期间报失败 → 403，说明原因", failReport.status === 403 && (failReport.json?.message ?? "").includes("停用"), JSON.stringify(failReport.json));
  check("★ 停用期间在停用通道上建监控 → 403", (await call("POST", `/account/${A.id}/watches`, { secret: A.secret, body: { kind: "heartbeat", channelId: A.channel.id, intervalMinutes: 60 } })).status === 403);
  check("★ 监控没被删", (await listOf(A)).some((w) => w.id === hb.id) && (await footprint(hb.id)).config !== null);

  await call("POST", `/__test__/restore/${A.channel.id}`);
  const back = await call("POST", `/hb/${hb.id}/fail`, { body: { msg: "恢复之后的失败" } });
  check("★ 恢复之后还是那个地址：报失败照常记下", back.status === 200 && back.json?.data?.status === "down", JSON.stringify(back.json));
  check("恢复之后照常报到", (await call("GET", `/hb/${hb.id}`)).json?.data?.status === "up");
}

console.log("\n★ 删一个监控：留墓碑，不复活");
{
  const del = await call("DELETE", `/account/${A.id}/watches/${site.id}`, { secret: A.secret });
  check("删除 → 200", del.status === 200);
  const left = await footprint(site.id);
  check("★ 配置、索引都删了，只剩墓碑", left.names.join() === "watchdel", left.names.join());
  check("再删一次 → 404", (await call("DELETE", `/account/${A.id}/watches/${site.id}`, { secret: A.secret })).status === 404);
  check("别人删不了我的监控", (await call("DELETE", `/account/${B.id}/watches/${hb.id}`, { secret: B.secret })).status === 404);
}

console.log("\n★ 删号：这个人的监控一把不剩");
{
  check("删号之前报到正常", (await call("GET", `/hb/${hb.id}`)).status === 200);
  const del = await call("DELETE", `/account/${A.id}`, { secret: A.secret });
  check("删号 → 200", del.status === 200);
  check("★ 报到地址作废 → 404", (await call("GET", `/hb/${hb.id}`)).status === 404);
  check("报失败也 404", (await call("POST", `/hb/${hb.id}/fail`)).status === 404);
  const left = await footprint(hb.id);
  check("★ KV 里没有 watch: 记录，状态、索引也都删了", left.config === null && left.names.join() === "watchdel", left.names.join());
  check("别人的监控不受影响", (await listOf(B)).some((w) => w.id === theirs.id) && (await call("GET", `/hb/${theirs.id}`)).status === 200);
  await call("DELETE", `/account/${B.id}`, { secret: B.secret });
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
