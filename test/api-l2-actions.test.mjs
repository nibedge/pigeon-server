/**
 * L2 通知交互的端到端测试：自定义按钮 actions、按钮凭据 act_sig、代发按钮的 actions 接口、
 * 通道回调密钥、回调地址 callback、回执长轮询。
 *
 *   BASE=http://localhost:8799 node test/api-l2-actions.test.mjs
 *
 * 本地 wrangler dev 由 run-api.sh 带 PIGEON_TEST_ADMIN:1 起：这时按钮凭据用一段公开的测试材料
 * 签发、核对（见 actions.ts），/__test__/sign-actions 用服务端自己的签名器出 (actions, act_sig)，
 * 测试拿它去打 actions 接口 —— payload 里真正下发的 act_sig 测试看不到，靠这个预言机对齐。
 * APNS_KEY_P8 为空，投递本身发不出真推送，但接口的解析、鉴权、签名、回执这些都不依赖 APNs。
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

async function call(method, path, { body, secret, raw, headers: extra } = {}) {
  const headers = { ...(extra ?? {}) };
  if (body !== undefined && !raw) headers["content-type"] = "application/json";
  if (secret) headers.authorization = `Bearer ${secret}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 某些路径回的不是 JSON */
  }
  return { status: res.status, headers: res.headers, json };
}

const run = Date.now().toString(16);
let seq = 0;
async function newAccount(name) {
  seq += 1;
  const token = `${run}l2${seq}`.padEnd(64, "e").slice(0, 64);
  const r = await call("POST", "/account", { body: { device_token: token, environment: "sandbox", device_name: "测试机" } });
  const data = r.json?.data;
  const acct = { id: data?.account_id, secret: data?.secret, channel: data?.channels?.[0] };
  if (name) await call("PATCH", `/account/${acct.id}`, { secret: acct.secret, body: { name } });
  return acct;
}
const as = (who) => (method, path, body) => call(method, path, { secret: who.secret, body });

// 服务端自己的签名器：给 (通道, 消息, 按钮定义) 出 (紧凑 actions, act_sig)
async function sign(cid, mid, actionsInput) {
  const r = await call("POST", `/__test__/sign-actions/${cid}?mid=${encodeURIComponent(mid)}`, {
    body: JSON.stringify(actionsInput),
    raw: true,
  });
  return r.json?.data;
}

const O = await newAccount("王五");
const M = await newAccount("李四");
const N = await newAccount("路人");
const byO = as(O);
const byM = as(M);
const byN = as(N);
const cid = O.channel?.id;
const key = O.channel?.key;

// 本地 wrangler dev 没有 APNS_KEY_P8，真正投递到设备这一步必然失败（502）——
// 所以「合法」验的是「过了参数校验、走到投递」，即不是 400，且响应里回带了这条消息的 id
console.log("\n★ 推送带 actions：合法就收下（过校验、进投递）");
{
  const r = await call("POST", `/${key}`, {
    body: { title: "生产要发版", id: "deploy-1", actions: [{ type: "open", label: "查看", url: "https://ci.example.com/run/1" }] },
  });
  check("带一个 open 按钮 → 不被校验挡下（非 400）", r.status !== 400, `${r.status} ${JSON.stringify(r.json?.message)}`);
  check("响应带这条消息的 id", r.json?.data?.id === "deploy-1", JSON.stringify(r.json?.data?.id));
}
{
  const r = await call("POST", `/${key}`, {
    body: { title: "简写", id: "sc-1", actions: "查看=https://a.example.com; !回滚=POST https://b.example.com/rollback" },
  });
  check("简写字符串也认 → 非 400", r.status !== 400, `${r.status} ${JSON.stringify(r.json?.message)}`);
}

console.log("\n★ 按钮写错了当场回绝，不推一条没按钮的通知");
{
  const bad = (actions) => call("POST", `/${key}`, { body: { title: "x", id: "b", actions } });
  check("http 按钮指向 http（非 https）→ 400", (await bad([{ type: "http", label: "点", url: "http://x.example.com" }])).status === 400);
  check("指向 IP → 400", (await bad([{ type: "open", label: "点", url: "https://10.0.0.1/x" }])).status === 400);
  check("指向 localhost → 400", (await bad([{ type: "open", label: "点", url: "https://localhost/x" }])).status === 400);
  check("指向单段主机（无点）→ 400", (await bad([{ type: "open", label: "点", url: "https://intranet/x" }])).status === 400);
  check("指向内网后缀 .internal → 400", (await bad([{ type: "open", label: "点", url: "https://svc.internal/x" }])).status === 400);
  check("地址里带账号密码 → 400", (await bad([{ type: "open", label: "点", url: "https://u:p@host.example.com/x" }])).status === 400);
  check("指回信鸽自己 → 400", (await bad([{ type: "open", label: "点", url: "https://nfo.im/x" }])).status === 400);
  check("★ 指回信鸽在 workers.dev 上的备用入口 → 400", (await bad([{ type: "http", label: "点", url: "https://pigeon.someone.workers.dev/abc" }])).status === 400);
  const other = await bad([{ type: "http", label: "点", url: "https://hooks.someone.workers.dev/abc" }]);
  check("别人部署在 workers.dev 上的服务照收（非 400）", other.status !== 400, `${other.status} ${JSON.stringify(other.json?.message)}`);
  check("按钮没名字 → 400", (await bad([{ type: "open", url: "https://a.example.com" }])).status === 400);
  check("名字超过 20 字 → 400", (await bad([{ type: "open", label: "一二三四五六七八九十一二三四五六七八九十一", url: "https://a.example.com" }])).status === 400);
  check("超过 3 个按钮 → 400", (await bad([1, 2, 3, 4].map((i) => ({ type: "open", label: `x${i}`, url: `https://a${i}.example.com` })))).status === 400);
  check("copy 按钮没 value → 400", (await bad([{ type: "copy", label: "复制" }])).status === 400);
  check("open 按钮没 url → 400", (await bad([{ type: "open", label: "打开" }])).status === 400);
  check("认不得的类型 → 400", (await bad([{ type: "detonate", label: "炸" }])).status === 400);
}

console.log("\n★ 信鸽自己发出的代发、回调绕回来：入口直接拒");
{
  const loop = await call("POST", `/${key}`, { body: { title: "绕回来的回调" }, headers: { "user-agent": "Pigeon-Callback/1" } });
  check("★ User-Agent 是 Pigeon-Callback → 403，不推", loop.status === 403 && /自己发出/.test(loop.json?.message ?? ""), `${loop.status} ${JSON.stringify(loop.json?.message)}`);
  const signed = await call("POST", `/${key}`, { body: { title: "带签名头" }, headers: { "x-pigeon-signature": "sha256=00" } });
  check("带 X-Pigeon-Signature 头 → 403", signed.status === 403, `${signed.status}`);
}

console.log("\n★ 4KB 预算：按钮定义太长整条回绝");
{
  const huge = "https://x.example.com/" + "a".repeat(1600);
  const r = await call("POST", `/${key}`, { body: { title: "x", id: "big", actions: [{ type: "open", label: "长", url: huge }] } });
  check("单个按钮定义超过 1.5KB → 400", r.status === 400, JSON.stringify(r.json?.message));
}

console.log("\n★ 只收加密的通道不收按钮");
{
  const E = await newAccount("加密君");
  await as(E)("PATCH", `/account/${E.id}/channels/${E.channel.id}`, { policy: { e2eOnly: true } });
  const r = await call("POST", `/${E.channel.key}`, {
    body: { ciphertext: "AAAA", iv: "BBBB", actions: [{ type: "open", label: "看", url: "https://a.example.com" }] },
  });
  check("密文通道带 actions → 400", r.status === 400, JSON.stringify(r.json?.message));
  const setDefaults = (body) => as(E)("PATCH", `/account/${E.id}/channels/${E.channel.id}`, body);
  const dflt = await setDefaults({ defaults: { actions: "看=https://a.example.com" } });
  check("★ 密文通道设默认按钮 → 400（默认按钮会随每条密文明文下发）", dflt.status === 400 && /只收加密/.test(dflt.json?.message ?? ""), JSON.stringify(dflt.json?.message));
  const P = await newAccount("明文君");
  const both = await as(P)("PATCH", `/account/${P.id}/channels/${P.channel.id}`, { policy: { e2eOnly: true }, defaults: { actions: "看=https://a.example.com" } });
  check("★ 同一个请求里打开只收加密、又设默认按钮 → 400", both.status === 400, JSON.stringify(both.json?.message));
  const cb = await setDefaults({ defaults: { callback: "https://hooks.example.com/e" } });
  check("密文通道设默认回调照收（回调地址不进推送内容）", cb.status === 200, JSON.stringify(cb.json?.message));
}

console.log("\n★ callback 地址：写错了回绝");
{
  check("callback 是 http → 400", (await call("POST", `/${key}`, { body: { title: "x", id: "cb", callback: "http://x.example.com" } })).status === 400);
  check("callback 指向 IP → 400", (await call("POST", `/${key}`, { body: { title: "x", id: "cb", callback: "https://127.0.0.1/h" } })).status === 400);
  const good = await call("POST", `/${key}`, { body: { title: "x", id: "cb-ok", callback: "https://hooks.example.com/pigeon" } });
  check("合法 callback → 非 400（过校验）", good.status !== 400, `${good.status} ${JSON.stringify(good.json?.message)}`);
}

console.log("\n★ 通道回调密钥：创建者可读可重置，成员不行");
let secret1;
{
  const g = await byO("GET", `/account/${O.id}/channels/${cid}/callback-secret`);
  secret1 = g.json?.data?.callback_secret;
  check("创建者 GET → 拿到密钥", g.status === 200 && typeof secret1 === "string" && secret1.length >= 20, JSON.stringify(g.json));
  const again = await byO("GET", `/account/${O.id}/channels/${cid}/callback-secret`);
  check("再 GET → 同一把（没有就生成、之后不变）", again.json?.data?.callback_secret === secret1);
  const post = await byO("POST", `/account/${O.id}/channels/${cid}/callback-secret`);
  check("创建者 POST → 换了一把", post.status === 200 && post.json?.data?.callback_secret && post.json.data.callback_secret !== secret1, JSON.stringify(post.json));
  check("还没入群的人读回调密钥 → 404（连通道都看不到）", (await byM("GET", `/account/${M.id}/channels/${cid}/callback-secret`)).status === 404);
}

console.log("\n★ 群：成员加入后，点按钮要核对身份与凭据");
// O 把 cid 设成群并邀请 M 进来
await byO("PATCH", `/account/${O.id}/channels/${cid}`, { group: true });
const code = (await byO("POST", `/account/${O.id}/channels/${cid}/invites`)).json?.data?.code;
await byM("POST", `/account/${M.id}/invites/${code}`);
check("入群后的成员读回调密钥 → 403（只有创建者能看）", (await byM("GET", `/account/${M.id}/channels/${cid}/callback-secret`)).status === 403);
{
  const mid = "act-1";
  const actionsInput = [
    { type: "http", label: "回滚" }, // 只回报：不带 url，代发那步跳过，结果 ok
    { type: "reply", label: "回一句" },
    { type: "copy", label: "复制", value: "SF123" },
  ];
  const signed = await sign(cid, mid, actionsInput);
  check("签名预言机给出 actions 和 act_sig", signed?.actions && signed?.act_sig, JSON.stringify(signed));

  const post = (who, body) => as(who)("POST", `/account/${who.id}/channels/${cid}/actions`, body);

  check("不是成员 → 404", (await post(N, { message_id: mid, index: 0, actions: signed.actions, act_sig: signed.act_sig })).status === 404);
  check("缺 act_sig → 400", (await post(M, { message_id: mid, index: 0, actions: signed.actions })).status === 400);
  check("缺 actions → 400", (await post(M, { message_id: mid, index: 0, act_sig: signed.act_sig })).status === 400);
  check("index 越界 → 400", (await post(M, { message_id: mid, index: 9, actions: signed.actions, act_sig: signed.act_sig })).status === 400);
  check("message_id 不对 → 400", (await post(M, { message_id: "", index: 0, actions: signed.actions, act_sig: signed.act_sig })).status === 400);

  const wrong = await post(M, { message_id: mid, index: 0, actions: signed.actions, act_sig: "AAAABBBBCCCCDDDDEEEEFFFF" });
  check("act_sig 不对 → 403", wrong.status === 403, JSON.stringify(wrong.json?.message));

  // 篡改按钮定义（改一个字节），凭据就对不上
  const tampered = signed.actions.replace("回滚", "删库");
  const t = await post(M, { message_id: mid, index: 0, actions: tampered, act_sig: signed.act_sig });
  check("按钮定义被改过 → 403", t.status === 403, JSON.stringify(t.json?.message));

  const copyTap = await post(M, { message_id: mid, index: 2, actions: signed.actions, act_sig: signed.act_sig });
  check("copy 按钮交给服务端 → 400（手机上就能完成）", copyTap.status === 400, JSON.stringify(copyTap.json?.message));

  const ok0 = await post(M, { message_id: mid, index: 0, actions: signed.actions, act_sig: signed.act_sig });
  check("成员 + 正确凭据点 http（无 url，只回报）→ 200 {ok:true}", ok0.status === 200 && ok0.json?.data?.ok === true, JSON.stringify(ok0.json));

  const reply = await post(M, { message_id: mid, index: 1, actions: signed.actions, act_sig: signed.act_sig, reply_text: "我在看" });
  check("成员点 reply 带回复 → 200", reply.status === 200, JSON.stringify(reply.json));
}

console.log("\n★ 回执：谁认领、点过哪些按钮");
{
  const r = await call("GET", `/${key}/receipt/act-1`);
  check("GET 回执 → 200", r.status === 200, JSON.stringify(r.json?.message));
  const actions = r.json?.data?.actions ?? [];
  check("记下了两次按钮动作（回滚 + 回一句）", actions.length === 2, JSON.stringify(actions.map((a) => a.label)));
  check("回复文字记进回执", actions.some((a) => a.type === "reply" && a.reply === "我在看"), JSON.stringify(actions));
  check("还没人认领 → acked_by 为 null", r.json?.data?.acked_by === null, JSON.stringify(r.json?.data));

  // 认领它
  await byM("POST", `/account/${M.id}/channels/${cid}/ack`, { message_id: "act-1" });
  const after = await call("GET", `/${key}/receipt/act-1`);
  check("认领之后 → acked_by 是李四", after.json?.data?.acked_by === "李四", JSON.stringify(after.json?.data));
  check("acked_at 是个时刻", typeof after.json?.data?.acked_at === "number", JSON.stringify(after.json?.data?.acked_at));
}

console.log("\n★ 回执长轮询与鉴权");
{
  const t0 = Date.now();
  const r = await call("GET", `/${key}/receipt/never-acked?wait=1`);
  const waited = Date.now() - t0;
  check("空回执 wait=1 → 约 1 秒后返回", r.status === 200 && waited >= 900 && waited < 4000, `${waited}ms`);
  check("空回执 → acked_by null、actions 空", r.json?.data?.acked_by === null && (r.json?.data?.actions ?? []).length === 0, JSON.stringify(r.json?.data));

  const acked = await call("GET", `/${key}/receipt/act-1?wait=30`);
  check("已有认领 → 立刻返回，不等满 wait", acked.status === 200 && acked.json?.data?.acked_by === "李四");

  const nokey = await call("GET", `/no-such-key-xxxx/receipt/act-1`);
  check("key 不存在 → 404", nokey.status === 404, JSON.stringify(nokey.json?.message));
}

console.log("\n★ 删通道之后回调密钥读不到");
{
  const solo = await newAccount("独");
  // 至少要保留一个自己建的通道，所以先多建一个用来删
  const extra = (await as(solo)("POST", `/account/${solo.id}/channels`, { name: "临时" })).json?.data?.channel;
  const eid = extra?.id;
  await as(solo)("GET", `/account/${solo.id}/channels/${eid}/callback-secret`); // 生成一把
  const del = await as(solo)("DELETE", `/account/${solo.id}/channels/${eid}`);
  check("删掉多出来的通道 → 200", del.status === 200 && del.json?.data?.deleted === true, JSON.stringify(del.json));
  const gone = await as(solo)("GET", `/account/${solo.id}/channels/${eid}/callback-secret`);
  // 这里只看得到「通道没了」：密钥本身删没删（cbsec: 键）在 db.test.mjs 里用内存 KV 直接核对
  check("删了通道后再读回调密钥 → 404（通道没了）", gone.status === 404, JSON.stringify(gone.json?.message));
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
