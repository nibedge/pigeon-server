/**
 * 移除设备的端到端测试：被移出账号的设备不能靠启动时的静默登记回来，本人亲手加回来（reclaim）才放行。
 *
 *   BASE=http://localhost:8799 node test/api-s1-devices.test.mjs
 *
 * 和别的 API 测试共用同一个 wrangler dev、同一份本地 KV：令牌每次跑都换一批（墓碑跨次保留，30 天才过期），
 * 账号也都是这个文件自己新建的。
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

/** client：带上 X-Pigeon-Client（新版 App 都带）；不给就是老版 App */
async function call(method, path, { body, secret, client } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (secret) headers.authorization = `Bearer ${secret}`;
  if (client) headers["x-pigeon-client"] = client;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 交给断言去判断 */
  }
  return { status: res.status, json };
}

const run = Date.now().toString(36);
const token = (seed) => (seed + run).repeat(64).slice(0, 64);
const NEW_APP = "ios/1.1 (20)";
const REMOVED = "这台设备已在别处被移出账号";

async function newAccount(seed, name) {
  const r = await call("POST", "/account", {
    body: { device_token: token(seed), environment: "sandbox", device_name: name },
  });
  const data = r.json?.data ?? {};
  return { id: data.account_id, secret: data.secret, channel: data.channels?.[0] ?? {} };
}

const prefixesOf = (res) => (res.json?.data?.devices ?? []).map((d) => d.token_prefix);

/** App 登记设备：silent = 启动时的静默续期（不带 reclaim）；否则是用户亲手扫码 / 点「继续使用」 */
function register(acct, tok, { reclaim, client = NEW_APP, name = "设备" } = {}) {
  const body = { device_token: tok, environment: "sandbox", device_name: name };
  if (reclaim !== undefined) body.reclaim = reclaim;
  return call("POST", `/account/${acct.id}/devices`, { secret: acct.secret, client, body });
}

// ── C5 移除设备的墓碑 ────────────────────────────────────────────────

console.log("\n移除设备：被移走的设备不能静默回来");
{
  const A = await newAccount("rma", "机主的 iPhone");
  const ipad = token("rmb");
  const added = await register(A, ipad, { name: "送人的 iPad" });
  check("登记第二台设备 → 两台", added.status === 200 && added.json?.data?.devices?.length === 2, JSON.stringify(added.json));

  const removed = await call("DELETE", `/account/${A.id}/devices/${ipad.slice(0, 12)}`, { secret: A.secret });
  check("按 12 位前缀移除 → 200，只剩一台", removed.status === 200 && removed.json?.data?.devices?.length === 1);

  const silent = await register(A, ipad);
  check("★ 被移走的设备静默重新登记 → 410", silent.status === 410, `${silent.status} ${JSON.stringify(silent.json)}`);
  check("★ 响应是标准信封：code 410 + 说明", silent.json?.code === 410 && silent.json?.message === REMOVED, JSON.stringify(silent.json));
  const after = await call("GET", `/account/${A.id}`, { secret: A.secret });
  check("★ 410 之后账号里仍只有一台，没被加回去", after.status === 200 && after.json?.data?.devices?.length === 1 && !prefixesOf(after).includes(ipad.slice(0, 12)), JSON.stringify(prefixesOf(after)));

  const legacy = await register(A, ipad, { client: null });
  check("★ 老版 App（不带 X-Pigeon-Client）也是 410", legacy.status === 410 && legacy.json?.code === 410);
  check("★ 给老版 App 的说明告诉它怎么回来：更新 App", (legacy.json?.message ?? "").startsWith(REMOVED) && legacy.json.message.includes("更新"), legacy.json?.message);

  check("reclaim 不是布尔 true（字符串）→ 仍然 410", (await register(A, ipad, { reclaim: "true" })).status === 410);
  check("reclaim: false → 仍然 410", (await register(A, ipad, { reclaim: false })).status === 410);

  const B = await newAccount("rmc", "别的账号");
  const elsewhere = await register(B, ipad, { name: "送人的 iPad" });
  check("★ 墓碑只管移走它的那个账号：登记到别的账号 → 200", elsewhere.status === 200 && prefixesOf(elsewhere).includes(ipad.slice(0, 12)), JSON.stringify(elsewhere.json));
  check("★ 墓碑不挡用这台设备新建账号", (await call("POST", "/account", { body: { device_token: ipad, environment: "sandbox", device_name: "新账号" } })).status === 200);

  const back = await register(A, ipad, { reclaim: true, name: "本人又加回来的 iPad" });
  check("★ 用户亲手加回来（reclaim: true）→ 200，又是两台", back.status === 200 && back.json?.data?.devices?.length === 2, JSON.stringify(back.json));
  const again = await register(A, ipad, { name: "本人又加回来的 iPad" });
  check("★ 加回来之后，下次静默续期照常 200（墓碑已作废）", again.status === 200 && again.json?.data?.devices?.length === 2, JSON.stringify(again.json));
  const legacyAgain = await register(A, ipad, { client: null });
  check("老版 App 的静默续期也照常", legacyAgain.status === 200);
}

console.log("\n移除设备：按完整 token 删也立墓碑；没删成的不立");
{
  const A = await newAccount("rmd", "机主");
  const old = token("rme");
  await register(A, old, { name: "旧手机" });
  const byFull = await call("DELETE", `/account/${A.id}/devices/${old}`, { secret: A.secret });
  check("按完整 token 移除 → 200", byFull.status === 200 && byFull.json?.data?.devices?.length === 1);
  check("★ 静默回来 → 410", (await register(A, old)).status === 410);

  const never = token("rmf");
  const missing = await call("DELETE", `/account/${A.id}/devices/${never}`, { secret: A.secret });
  check("删一台不在账号里的设备 → 404", missing.status === 404);
  check("★ 404 不立墓碑：那台设备登记照常 200", (await register(A, never)).status === 200);

  const wrong = await call("DELETE", `/account/${A.id}/devices/${old}`, { secret: "wrong-secret" });
  check("凭据不对删不了 → 401", wrong.status === 401);

  const self = token("rmd");
  const selfRemoved = await call("DELETE", `/account/${A.id}/devices/${self}`, { secret: A.secret });
  check("App 退出账号前把本机摘掉 → 200", selfRemoved.status === 200 && !prefixesOf(selfRemoved).includes(self.slice(0, 12)));
  check("★ 之后本机启动时的静默登记 → 410（App 据此退出登录）", (await register(A, self)).status === 410);
  check("★ 本机点「继续使用」（reclaim）→ 200", (await register(A, self, { reclaim: true })).status === 200);
}

console.log("\n删账号：凭据作废，墓碑也清掉（清理本身在 db 单测里核对）");
{
  const A = await newAccount("rmg", "要注销的人");
  const other = token("rmh");
  await register(A, other);
  await call("DELETE", `/account/${A.id}/devices/${other}`, { secret: A.secret });
  const del = await call("DELETE", `/account/${A.id}`, { secret: A.secret });
  check("立过墓碑的账号照样能删 → 200", del.status === 200 && del.json?.data?.deleted === true, JSON.stringify(del.json));
  check("删完再登记 → 401（不是 410）", (await register(A, other)).status === 401);
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
