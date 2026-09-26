/**
 * 存储结构调整的端到端测试：推送热路径不再整条改写通道和账号记录之后，
 * 统计、停用、失效令牌各自走独立的键 —— 这里核对它们在真跑的 Worker 里接得上。
 *
 *   BASE=http://localhost:8799 node test/api-s1.test.mjs
 *
 * 和 api.test.mjs 共用同一个 wrangler dev、同一份本地 KV，所以账号、令牌都用这个文件自己的种子，
 * 不和别的测试文件撞上。本地连不上 APNs，推送一律投递失败 —— 统计只能靠「被去重压掉也记一笔」来验。
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

/** 每次跑都换一批令牌：本地 KV 跨次保留，墓碑会一直留在上一次的令牌上 */
const run = Date.now().toString(36);
const token = (seed) => (seed + run).repeat(64).slice(0, 64);

async function newAccount(seed, name) {
  const r = await call("POST", "/account", {
    body: { device_token: token(seed), environment: "sandbox", device_name: name },
  });
  const data = r.json?.data ?? {};
  return { id: data.account_id, secret: data.secret, channel: data.channels?.[0] ?? {} };
}

const tokensOf = (view) => (view?.devices ?? []).map((d) => d.token_prefix);

console.log("\n顶层兜底：没接住的异常回 JSON 500");
{
  const r = await call("POST", "/__test__/throw");
  check("★ 回 500 而不是运行时的错误页", r.status === 500, String(r.status));
  check("★ 响应是 JSON，带中文说明", r.json?.code === 500 && typeof r.json?.message === "string" && r.json.message.length > 0, JSON.stringify(r.json));
  check("★ 带 CORS 头：网页发送页也读得到这个错误", r.headers.get("access-control-allow-origin") === "*");
  check("不缓存", (r.headers.get("cache-control") ?? "").includes("no-store"));
}

console.log("\n推送统计：记在 stat: 上，账号快照里合并显示");
{
  const A = await newAccount("sta", "统计测试机");
  check("建账号 → 拿到默认通道", typeof A.id === "string" && typeof A.channel.key === "string");
  check("新通道条数是 0", A.channel.count === 0 && A.channel.last_push_at === undefined, JSON.stringify(A.channel));
  const set = await call("PATCH", `/account/${A.id}/channels/${A.channel.id}`, {
    secret: A.secret,
    body: { policy: { dedupeWindow: 600 } },
  });
  check("开去重窗口 → 200", set.status === 200, JSON.stringify(set.json));

  const first = await call("GET", `/${A.channel.key}/同一条`);
  check("第一条照常处理（本地 APNs 不通，投递失败）", first.status !== 403 && first.json?.data?.suppressed === undefined, JSON.stringify(first.json));
  const second = await call("GET", `/${A.channel.key}/同一条`);
  check("一模一样的第二条被去重压掉", second.status === 200 && second.json?.data?.suppressed === "duplicate", JSON.stringify(second.json));

  const view = await call("GET", `/account/${A.id}`, { secret: A.secret });
  const ch = (view.json?.data?.channels ?? []).find((c) => c.id === A.channel.id);
  check("★ 账号快照里的条数算上了 stat: 里记的那一笔", ch?.count === 1, JSON.stringify(ch));
  check("★ 最近推送时刻也有了", typeof ch?.last_push_at === "number" && Math.abs(ch.last_push_at - Date.now()) < 60_000, String(ch?.last_push_at));
  check("策略原样还在（推送没把通道记录写回去）", ch?.policy?.dedupeWindow === 600, JSON.stringify(ch?.policy));
}

console.log("\n停用：记在 susp: 上，通道记录怎么改写都抹不掉");
{
  const O = await newAccount("sus", "群主");
  const cid = O.channel.id;
  const suspended = await call("POST", `/__test__/suspend/${cid}`);
  check("（本地测试接口）停用 → 200", suspended.status === 200, JSON.stringify(suspended.json));
  check("停用后推送被拒 → 403", (await call("GET", `/${O.channel.key}/还能推吗`)).status === 403);

  const renamed = await call("PATCH", `/account/${O.id}/channels/${cid}`, { secret: O.secret, body: { name: "改个名" } });
  check("群主照样能改名（整条改写通道记录）", renamed.status === 200);
  const rotated = await call("POST", `/account/${O.id}/channels/${cid}/key`, { secret: O.secret });
  const newKey = rotated.json?.data?.key;
  check("群主照样能换地址", rotated.status === 200 && typeof newKey === "string", JSON.stringify(rotated.json));
  check("★ 改名、换地址之后仍是停用：新地址推送 → 403", (await call("GET", `/${newKey}/还能推吗`)).status === 403);
  const view = await call("GET", `/account/${O.id}`, { secret: O.secret });
  check("★ 账号快照里仍标着「已停用」", (view.json?.data?.channels ?? []).find((c) => c.id === cid)?.suspended === true);

  await call("POST", `/__test__/restore/${cid}`);
  check("恢复后新地址不再被拒", (await call("GET", `/${newKey}/恢复了`)).status !== 403);
  const after = await call("GET", `/account/${O.id}`, { secret: O.secret });
  const ch = (after.json?.data?.channels ?? []).find((c) => c.id === cid);
  check("恢复后「已停用」标记消失，改的名字还在", ch?.suspended === undefined && ch?.name === "改个名", JSON.stringify(ch));
}

console.log("\n失效令牌：推送只立墓碑，账号本人下次来访时摘掉");
{
  const A = await newAccount("dea", "好的那台");
  const old = token("deb");
  const added = await call("POST", `/account/${A.id}/devices`, {
    secret: A.secret,
    body: { device_token: old, environment: "sandbox", device_name: "删了 App 的旧手机" },
  });
  check("登记第二台设备 → 两台", added.status === 200 && added.json?.data?.devices?.length === 2);

  const marked = await call("POST", `/__test__/dead-token/${old}`);
  check("（本地测试接口）立墓碑 → 200", marked.status === 200, JSON.stringify(marked.json));

  const view = await call("GET", `/account/${A.id}`, { secret: A.secret });
  check("★ 本人来访：设备列表里不再有失效的那台", view.status === 200 && !tokensOf(view.json?.data).includes(old.slice(0, 12)) && tokensOf(view.json?.data).length === 1,
    JSON.stringify(tokensOf(view.json?.data)));

  const third = token("dec");
  const next = await call("POST", `/account/${A.id}/devices`, {
    secret: A.secret,
    body: { device_token: third, environment: "sandbox", device_name: "新手机" },
  });
  check("★ 下一次写账号时一并落盘：好的那台 + 新手机",
    next.status === 200 && tokensOf(next.json?.data).length === 2 && !tokensOf(next.json?.data).includes(old.slice(0, 12)),
    JSON.stringify(tokensOf(next.json?.data)));

  const back = await call("POST", `/account/${A.id}/devices`, {
    secret: A.secret,
    body: { device_token: old, environment: "sandbox", device_name: "重装后的旧手机" },
  });
  check("★ 同一个令牌重新登记：又回到设备列表", back.status === 200 && tokensOf(back.json?.data).includes(old.slice(0, 12)), JSON.stringify(tokensOf(back.json?.data)));
  const again = await call("GET", `/account/${A.id}`, { secret: A.secret });
  check("★ 墓碑随重新登记作废，再来访也不会被摘", tokensOf(again.json?.data).length === 3, JSON.stringify(tokensOf(again.json?.data)));
  check("测试接口只收 POST", (await call("GET", `/__test__/dead-token/${old}`)).status === 404);
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
