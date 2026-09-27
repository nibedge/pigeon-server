/**
 * 多设备已读水位（prefs.readThrough）的端到端测试：只进不退，按项合并和老版 App 的整份提交都取较大的。
 *
 *   BASE=http://localhost:8799 node test/api-l5-prefs.test.mjs
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

async function call(method, path, { body, secret, client = "ios/1.2 (90)" } = {}) {
  const headers = {};
  if (client) headers["x-pigeon-client"] = client;
  if (body !== undefined) headers["content-type"] = "application/json";
  if (secret) headers.authorization = `Bearer ${secret}`;
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 交给断言 */
  }
  return { status: res.status, json, data: json?.data };
}

const run = Date.now().toString(36);
const token = (seed) => (seed + run).repeat(64).slice(0, 64);

const r0 = await call("POST", "/account", { body: { device_token: token("rtA"), environment: "sandbox", device_name: "iPhone" } });
const A = { id: r0.data?.account_id, secret: r0.data?.secret, c1: r0.data?.channels?.[0]?.id };
const addChannel = async (name) =>
  (await call("POST", `/account/${A.id}/channels`, { secret: A.secret, body: { name } })).data?.channel?.id;
A.c2 = await addChannel("第二个");
A.c3 = await addChannel("第三个");
const patch = (prefs_patch) => call("PATCH", `/account/${A.id}`, { secret: A.secret, body: { prefs_patch } });
const readThrough = (r) => r.data?.prefs?.readThrough ?? {};
const now = Date.now();

console.log("\n已读水位：按项合并取较大的");
{
  const first = await patch({ readThrough: { [A.c1]: now - 60_000, [A.c2]: now - 120_000 } });
  check("★ 存下两个通道的水位", first.status === 200 && readThrough(first)[A.c1] === now - 60_000 && readThrough(first)[A.c2] === now - 120_000, JSON.stringify(first.json));

  // iPad 手里是旧快照：它交上来的 c1 比 iPhone 刚交的早
  const stale = await patch({ readThrough: { [A.c1]: now - 600_000 } });
  check("★ 旧快照拉不回去：c1 还是较大的那个", readThrough(stale)[A.c1] === now - 60_000, JSON.stringify(readThrough(stale)));
  const newer = await patch({ readThrough: { [A.c2]: now - 1_000 } });
  check("★ 更晚的照常前进", readThrough(newer)[A.c2] === now - 1_000);
  check("只交一条，别的通道不动", readThrough(newer)[A.c1] === now - 60_000);
  const frac = await patch({ readThrough: { [A.c3]: now - 5_000.7 } });
  check("取整", readThrough(frac)[A.c3] === Math.floor(now - 5_000.7));

  const junk = await patch({ readThrough: { [A.c1]: "later", [A.c2]: -5, nosuchchannel1: now } });
  check("★ 坏数据丢掉，原有的不动；不认识的通道不收", readThrough(junk)[A.c1] === now - 60_000 && readThrough(junk)[A.c2] === now - 1_000 && !("nosuchchannel1" in readThrough(junk)), JSON.stringify(readThrough(junk)));
  const notObject = await patch({ readThrough: [now] });
  check("给的不是对象 → 丢掉，整项不清空", notObject.status === 200 && readThrough(notObject)[A.c1] === now - 60_000);

  const future = await patch({ readThrough: { [A.c3]: now + 24 * 3600_000 } });
  const capped = readThrough(future)[A.c3];
  check("★ 时钟快了一天交上来的：截到「现在 + 10 分钟」以内", capped <= Date.now() + 10 * 60_000 && capped >= now + 9 * 60_000, `${capped - now}`);

  const removed = await patch({ readThrough: { [A.c3]: null } });
  check("★ 条目值 null → 只删这一条", !(A.c3 in readThrough(removed)) && readThrough(removed)[A.c1] === now - 60_000);
}

console.log("\n老版 App 的整份提交");
{
  const legacy = await call("PATCH", `/account/${A.id}`, { secret: A.secret, client: null, body: { prefs: { pins: [A.c2] } } });
  check("★ 整份提交里没提到水位（老版 App 不认识它）：原样保留", legacy.status === 200 && readThrough(legacy)[A.c1] === now - 60_000 && legacy.data?.prefs?.pins?.[0] === A.c2, JSON.stringify(legacy.data?.prefs));
  const snapshot = await call("PATCH", `/account/${A.id}`, { secret: A.secret, body: { prefs: { readThrough: { [A.c1]: now - 3600_000, [A.c3]: now - 30_000 } } } });
  check("★ 整份提交带着旧快照：各取较大的", readThrough(snapshot)[A.c1] === now - 60_000 && readThrough(snapshot)[A.c3] === now - 30_000, JSON.stringify(readThrough(snapshot)));
  const got = await call("GET", `/account/${A.id}`, { secret: A.secret });
  check("GET 账号能读到", readThrough(got)[A.c2] === now - 1_000);
}

console.log("\n通道离开列表时连带清掉");
{
  const del = await call("DELETE", `/account/${A.id}/channels/${A.c3}`, { secret: A.secret });
  check("★ 删掉的通道，水位一起删", del.status === 200 && !(A.c3 in readThrough(del)) && readThrough(del)[A.c1] === now - 60_000, JSON.stringify(del.data?.prefs));

  const group = await addChannel("值班群");
  const invite = (await call("POST", `/account/${A.id}/channels/${group}/invites`, { secret: A.secret })).data?.code;
  const r1 = await call("POST", "/account", { body: { device_token: token("rtB"), environment: "sandbox", device_name: "iPad" } });
  const B = { id: r1.data?.account_id, secret: r1.data?.secret };
  await call("POST", `/account/${B.id}/invites/${invite}`, { secret: B.secret });
  const set = await call("PATCH", `/account/${B.id}`, { secret: B.secret, body: { prefs_patch: { readThrough: { [group]: now } } } });
  check("加入的群也能记水位", readThrough(set)[group] === now, JSON.stringify(set.data?.prefs));
  const left = await call("DELETE", `/account/${B.id}/channels/${group}`, { secret: B.secret });
  check("★ 退群之后水位跟着清掉", left.status === 200 && !(group in readThrough(left)), JSON.stringify(left.data?.prefs));
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
