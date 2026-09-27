/**
 * 群与令牌（L4）的端到端测试：发送令牌的增删改查与校验、令牌推送走到投递、限流绑定 RL_TOKEN 真的生效、
 * 换地址后旧地址 410、/s/{令牌} 网页、成员发消息的开关与权限、接收方偏好的读写。
 *
 *   BASE=http://localhost:8799 node test/api-l4-tokens.test.mjs
 *
 * run-api.sh 起的这个 wrangler dev 没有 APNs 私钥，推到投递那一步就是 502 —— 这里看的是「走没走到投递」，
 * 推出去的 payload 长什么样在 test/api-l4-e2e.test.mjs（另起一个带假 APNs 的 wrangler dev）和 api-l4-fanout.test.mjs 里看。
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

// 每次运行换一批 token：本地 KV 跨次保留，老账号不该影响这次的断言
const run = Date.now().toString(16);
let seq = 0;
async function newAccount(name) {
  seq += 1;
  const token = `${run}l4${seq}`.padEnd(64, "4").slice(0, 64);
  const r = await call("POST", "/account", { body: { device_token: token, environment: "sandbox", device_name: `${name} 的手机` } });
  const data = r.json?.data;
  await call("PATCH", `/account/${data.account_id}`, { secret: data.secret, body: { name } });
  const acct = { id: data.account_id, secret: data.secret, channelId: data.channels[0].id, key: data.channels[0].key };
  acct.as = (method, path, body) => call(method, path, { secret: acct.secret, body });
  return acct;
}

const O = await newAccount("群主");
const M = await newAccount("成员");
const made = await O.as("POST", `/account/${O.id}/channels`, { name: "值班群", group: true });
const gid = made.json?.data?.channel?.id;
let gkey = made.json?.data?.channel?.key;
const code = (await O.as("POST", `/account/${O.id}/channels/${gid}/invites`)).json?.data?.code;
await M.as("POST", `/account/${M.id}/invites/${code}`);
const tokens = `/account/${O.id}/channels/${gid}/tokens`;

console.log("\n★ 发送令牌：新建与校验");
let nas;
{
  check("没名字 → 400", (await O.as("POST", tokens, {})).status === 400);
  check("名字全是空白 → 400", (await O.as("POST", tokens, { name: "   " })).status === 400);
  check("max_level 认不出 → 400", (await O.as("POST", tokens, { name: "x", max_level: "loud" })).status === 400);
  check("per_minute 超出 1–60 → 400", (await O.as("POST", tokens, { name: "x", per_minute: 61 })).status === 400);
  check("per_minute 不是整数 → 400", (await O.as("POST", tokens, { name: "x", per_minute: 1.5 })).status === 400);
  const r = await O.as("POST", tokens, { name: "  NAS 备份脚本加上一长串超出二十个字的名字  " });
  check("新建 → 200", r.status === 200, r.text);
  nas = r.json?.data;
  check("名字截到 20 字", nas?.token?.name === "NAS 备份脚本加上一长串超出二十个字的名".slice(0, 20), JSON.stringify(nas?.token?.name));
  check("令牌格式 st_…", /^st_[A-Za-z0-9_-]{43}$/.test(nas?.value ?? ""), nas?.value);
  // 本地 wrangler dev 按 routes 把请求地址报成 nfo.im（见 wrangler.toml 的 [dev]），这里只看路径
  check("推送地址、网页地址：/{令牌}、/s/{令牌}", nas?.push_url?.endsWith(`/${nas?.value}`) && nas?.page_url?.endsWith(`/s/${nas?.value}`) && /^https:\/\//.test(nas?.push_url ?? ""), `${nas?.push_url} ${nas?.page_url}`);
  check("重名 → 400", (await O.as("POST", tokens, { name: nas?.token?.name })).status === 400);
  for (let i = 1; i < 10; i++) await O.as("POST", tokens, { name: `令牌${i}` });
  const eleventh = await O.as("POST", tokens, { name: "第十一个" });
  check("★ 一个通道最多 10 个 → 第 11 个 400", eleventh.status === 400 && eleventh.json?.message?.includes("最多 10 个"), eleventh.text);
  const list = await O.as("GET", tokens);
  check("列出 10 个", list.json?.data?.tokens?.length === 10, String(list.json?.data?.tokens?.length));
  for (const t of list.json?.data?.tokens ?? []) {
    if (t.id !== nas?.token?.id) await O.as("DELETE", `${tokens}/${t.id}`);
  }
  check("删到只剩一个", (await O.as("GET", tokens)).json?.data?.tokens?.length === 1);
  check("PATCH 不存在的 → 404", (await O.as("PATCH", `${tokens}/nosuchtoken01`, { disabled: true })).status === 404);
  check("PATCH 认不出的字段值 → 400", (await O.as("PATCH", `${tokens}/${nas?.token?.id}`, { disabled: "yes" })).status === 400);
  check("PUT → 405", (await O.as("PUT", tokens, {})).status === 405);
  check("成员 → 403", (await M.as("GET", `/account/${M.id}/channels/${gid}/tokens`)).status === 403);
  check("成员新建 → 403", (await M.as("POST", `/account/${M.id}/channels/${gid}/tokens`, { name: "偷偷" })).status === 403);
}

console.log("\n★ 用令牌推送：和 key 走同一条路");
{
  const path = await call("GET", `/${nas.value}/${encodeURIComponent("备份完成")}`);
  check("★ 路径式 → 走到投递（本地 502），不是 404", path.status === 502, path.text);
  const hook = await call("POST", `/hook/${nas.value}/uptimekuma`, { body: { heartbeat: { status: 0, msg: "timeout" }, monitor: { name: "m" } } });
  check("★ /hook → 走到投递", hook.status === 502, hook.text);
  const batch = await call("POST", "/push", { body: { device_key: nas.value, body: "批量" } });
  check("★ /push 批量 → 走到投递（本地整批失败 400，原因是推送失败而不是 key 不存在）", batch.status === 400 && batch.json?.message?.startsWith("全部推送失败：推送失败"), batch.text);
  const fake = await call("GET", `/st_${"Z".repeat(43)}/x`);
  check("编出来的令牌 → 404", fake.status === 404);
}

console.log("\n★ 每分钟上限（真的限流绑定 RL_TOKEN）");
{
  const r = await O.as("POST", tokens, { name: "限流测试", per_minute: 2 });
  const t = r.json?.data;
  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await call("GET", `/${t.value}/n${i}`)).status);
  check("★ 前两条走到投递，第三条 429", statuses.join() === "502,502,429", statuses.join());
  const again = await call("GET", `/${t.value}/n9`);
  check("429 带 Retry-After: 60", again.status === 429 && again.headers.get("retry-after") === "60", again.text);
  check("★ 通道的 key 不受这个令牌的上限影响", (await call("GET", `/${gkey}/ok`)).status === 502);
  const off = await O.as("PATCH", `${tokens}/${t.token.id}`, { per_minute: null });
  check("去掉上限", off.status === 200 && off.json?.data?.token?.per_minute === undefined, off.text);
}

console.log("\n★ 停用、删除、换地址");
{
  await O.as("PATCH", `${tokens}/${nas.token.id}`, { disabled: true });
  const refused = await call("GET", `/${nas.value}/x`);
  check("★ 停用 → 403", refused.status === 403 && refused.json?.message?.includes("停用"), refused.text);
  const page = await call("GET", `/s/${nas.value}`);
  check("网页：403 已停用", page.status === 403 && page.text.includes("已停用"));
  await O.as("PATCH", `${tokens}/${nas.token.id}`, { disabled: false });
  const readyPage = await call("GET", `/s/${nas.value}`);
  check("★ 恢复后网页：200，写明发给「值班群」", readyPage.status === 200 && readyPage.text.includes("发给：<strong>值班群</strong>"));
  check("网页带 CSP、不缓存", (readyPage.headers.get("content-security-policy") ?? "").includes("script-src 'sha256-") && readyPage.headers.get("cache-control") === "no-store");

  await O.as("DELETE", `${tokens}/${nas.token.id}`);
  const gone = await call("GET", `/${nas.value}/x`);
  check("★ 删掉的令牌 → 410", gone.status === 410 && gone.json?.message?.startsWith("地址已停用"), gone.text);
  check("网页 → 410", (await call("GET", `/s/${nas.value}`)).status === 410);

  const oldKey = gkey;
  gkey = (await O.as("POST", `/account/${O.id}/channels/${gid}/key`)).json?.data?.key;
  const old = await call("GET", `/${oldKey}/x`);
  check("★ 换地址后旧地址 → 410「地址已停用：请到 App 里复制新地址」", old.status === 410 && old.json?.message === "地址已停用：请到 App 里复制新地址", old.text);
  check("新地址走到投递", (await call("GET", `/${gkey}/x`)).status === 502);
  const hookOld = await call("POST", `/hook/${oldKey}/github`, { body: {} });
  check("/hook 旧地址 → 410", hookOld.status === 410, hookOld.text);
}

console.log("\n★ 成员发消息");
{
  const post = (who, body) => who.as("POST", `/account/${who.id}/channels/${gid}/messages`, body);
  check("★ 默认关：成员 → 403", (await post(M, { body: "x" })).status === 403);
  check("群主随时能发（本地投递 502）", (await post(O, { body: "x" })).status === 502);
  check("GET → 405", (await M.as("GET", `/account/${M.id}/channels/${gid}/messages`)).status === 405);
  const on = await O.as("PATCH", `/account/${O.id}/channels/${gid}`, { member_send: "yes" });
  check("member_send 只收布尔", on.json?.data?.channels?.find((c) => c.id === gid)?.member_send === undefined);
  await O.as("PATCH", `/account/${O.id}/channels/${gid}`, { member_send: true });
  check("★ 打开后成员能发（走到投递）", (await post(M, { body: "我来看看" })).status === 502);
  check("critical → 400", (await post(M, { body: "x", level: "critical" })).status === 400);
}

console.log("\n★ 接收方偏好");
{
  const r = await M.as("PATCH", `/account/${M.id}`, { prefs_patch: { critical: { [gid]: true }, minLevel: { [gid]: "timeSensitive" } } });
  check("★ 存得下、读得回", r.json?.data?.prefs?.critical?.[gid] === true && r.json?.data?.prefs?.minLevel?.[gid] === "timeSensitive", JSON.stringify(r.json?.data?.prefs));
  const read = await M.as("GET", `/account/${M.id}`);
  check("GET 账号带着", read.json?.data?.prefs?.minLevel?.[gid] === "timeSensitive");
  const cleared = await M.as("PATCH", `/account/${M.id}`, { prefs_patch: { critical: null, minLevel: { [gid]: null } } });
  check("清掉", cleared.json?.data?.prefs?.critical === undefined && cleared.json?.data?.prefs?.minLevel === undefined, JSON.stringify(cleared.json?.data?.prefs));
}

console.log("\n★ 删通道之后令牌失效");
{
  const t = (await O.as("POST", tokens, { name: "删通道前" })).json?.data;
  await O.as("DELETE", `/account/${O.id}/channels/${gid}`);
  check("★ 令牌 → 404（通道没了，墓碑也不留）", (await call("GET", `/${t.value}/x`)).status === 404);
  check("旧 key → 404", (await call("GET", `/${gkey}/x`)).status === 404);
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
