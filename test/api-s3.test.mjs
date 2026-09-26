/**
 * 群组管控的端到端测试：邀请的列出与作废、移除时禁入、群主名、条款确认、认领的兼容、举报限额。
 *
 *   BASE=http://localhost:8799 node test/api-s3.test.mjs
 *
 * 本地 wrangler dev 没有 APNS_KEY_P8：认领凭据不签发也不核对，这一段在 test/groups.test.mjs 里测。
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
    /* 某些路径回的不是 JSON，交给断言去判断 */
  }
  return { status: res.status, headers: res.headers, json };
}

// 每次运行换一批 token：本地 KV 跨次保留，老账号不该影响这次的断言
const run = Date.now().toString(16);
let seq = 0;
async function newAccount(deviceName, name) {
  seq += 1;
  const token = `${run}${seq}`.padEnd(64, "e").slice(0, 64);
  const r = await call("POST", "/account", { body: { device_token: token, environment: "sandbox", device_name: deviceName } });
  const acct = { id: r.json?.data?.account_id, secret: r.json?.data?.secret, data: r.json?.data };
  if (name) await call("PATCH", `/account/${acct.id}`, { secret: acct.secret, body: { name } });
  return acct;
}

const as = (who) => (method, path, body) => call(method, path, { secret: who.secret, body });

console.log("\n★ 显示名兜底：「成员·id 后四位」");
const O = await newAccount("群主的 iPhone", "王五");
const M = await newAccount("成员的 iPhone");
const N = await newAccount("路人的 iPhone");
const byO = as(O);
const byM = as(M);
const byN = as(N);
{
  const me = (await byM("GET", `/account/${M.id}`)).json?.data;
  check("没起名字时账号上的 name 仍为空（兜底只用在别人看到的地方）", me?.name === undefined, JSON.stringify(me?.name));
}

console.log("\n★ 条款确认");
{
  check("新账号没有 terms_accepted_at", O.data?.terms_accepted_at === undefined, JSON.stringify(O.data?.terms_accepted_at));
  const plain = await byO("POST", `/account/${O.id}/channels`, { name: "不带确认", group: true });
  check("不带 accept_terms 照样建得了群（旧版 App）", plain.status === 200);
  check("也不会记下同意", (await byO("GET", `/account/${O.id}`)).json?.data?.terms_accepted_at === undefined);
  await byO("DELETE", `/account/${O.id}/channels/${plain.json?.data?.channel?.id}`);
}
const made = await byO("POST", `/account/${O.id}/channels`, { name: "值班群", group: true, accept_terms: true });
const gid = made.json?.data?.channel?.id;
{
  const accepted = (await byO("GET", `/account/${O.id}`)).json?.data?.terms_accepted_at;
  check("★ 建群时带 accept_terms → 账号上记下时刻", typeof accepted === "number" && accepted > 0, String(accepted));
  const again = await byO("PATCH", `/account/${O.id}/channels/${gid}`, { group: true, accept_terms: true });
  check("再确认一次不改时刻", again.json?.data?.terms_accepted_at === accepted, JSON.stringify(again.json?.data?.terms_accepted_at));

  const P = await newAccount("P 的 iPhone");
  const pDefault = P.data?.channels?.[0]?.id;
  const patched = await as(P)("PATCH", `/account/${P.id}/channels/${pDefault}`, { group: true, accept_terms: true });
  check("★ 设为群组时带 accept_terms → 记下", typeof patched.json?.data?.terms_accepted_at === "number", JSON.stringify(patched.json));
  const Q = await newAccount("Q 的 iPhone");
  const qDefault = Q.data?.channels?.[0]?.id;
  const inv = await as(Q)("POST", `/account/${Q.id}/channels/${qDefault}/invites`, { accept_terms: true });
  check("生成邀请带 accept_terms → 200", inv.status === 200, JSON.stringify(inv.json));
  check("★ 生成邀请时带 accept_terms → 记下", typeof (await as(Q)("GET", `/account/${Q.id}`)).json?.data?.terms_accepted_at === "number");
  const R = await newAccount("R 的 iPhone");
  await as(R)("POST", `/account/${R.id}/channels/${R.data?.channels?.[0]?.id}/invites`, { accept_terms: "yes" });
  check("accept_terms 只认布尔 true", (await as(R)("GET", `/account/${R.id}`)).json?.data?.terms_accepted_at === undefined);
}

console.log("\n★ 邀请：群主名、列出、作废");
const invite = async () => (await byO("POST", `/account/${O.id}/channels/${gid}/invites`)).json?.data?.code;
const code1 = await invite();
const code2 = await invite();
{
  const preview = await byN("GET", `/account/${N.id}/invites/${code1}`);
  check("★ 预览带 owner_name（群主显示名）", preview.status === 200 && preview.json?.data?.owner_name === "王五", JSON.stringify(preview.json));
  const page = await (await fetch(`${BASE}/i/${code1}`)).text();
  check("★ 网页邀请页写明群主", page.includes("由 王五 创建"));

  const listed = await byO("GET", `/account/${O.id}/channels/${gid}/invites`);
  const codes = (listed.json?.data?.invites ?? []).map((i) => i.code);
  check("★ 群主列得出还有效的邀请", listed.status === 200 && codes.includes(code1) && codes.includes(code2), JSON.stringify(listed.json));
  const one = (listed.json?.data?.invites ?? []).find((i) => i.code === code1);
  check("每条带 code、expires_at、created_at", typeof one?.expires_at === "number" && typeof one?.created_at === "number" && one.expires_at > one.created_at);
  check("路人列不了（不泄漏这个群存在）→ 404", (await byN("GET", `/account/${N.id}/channels/${gid}/invites`)).status === 404);

  const joined = await byM("POST", `/account/${M.id}/invites/${code1}`);
  check("成员加入（前置）", joined.status === 200 && joined.json?.data?.result === "joined");
  check("成员列不了邀请 → 403", (await byM("GET", `/account/${M.id}/channels/${gid}/invites`)).status === 403);
  check("成员作废不了邀请 → 403", (await byM("DELETE", `/account/${M.id}/channels/${gid}/invites/${code2}`)).status === 403);
  check("成员作废不了全部邀请 → 403", (await byM("DELETE", `/account/${M.id}/channels/${gid}/invites`)).status === 403);

  const revoked = await byO("DELETE", `/account/${O.id}/channels/${gid}/invites/${code2}`);
  check("★ 作废一个 → {revoked: code}", revoked.status === 200 && revoked.json?.data?.revoked === code2, JSON.stringify(revoked.json));
  check("★ 作废之后网页邀请页 → 404", (await fetch(`${BASE}/i/${code2}`)).status === 404);
  check("★ 作废之后预览 → 404", (await byN("GET", `/account/${N.id}/invites/${code2}`)).status === 404);
  check("★ 作废之后加入 → 404", (await byN("POST", `/account/${N.id}/invites/${code2}`)).status === 404);
  check("列表里没了", !((await byO("GET", `/account/${O.id}/channels/${gid}/invites`)).json?.data?.invites ?? []).some((i) => i.code === code2));
  check("再作废一次 → 404", (await byO("DELETE", `/account/${O.id}/channels/${gid}/invites/${code2}`)).status === 404);

  // 别的群的邀请码，挂在自己的群下面也删不掉
  const P = await newAccount("P2 的 iPhone");
  const pCode = (await as(P)("POST", `/account/${P.id}/channels/${P.data?.channels?.[0]?.id}/invites`)).json?.data?.code;
  check("★ 拿别的群的邀请码来作废 → 404", (await byO("DELETE", `/account/${O.id}/channels/${gid}/invites/${pCode}`)).status === 404);
  check("那个邀请照样能用", (await byN("GET", `/account/${N.id}/invites/${pCode}`)).status === 200);

  const code3 = await invite();
  const code4 = await invite();
  const all = await byO("DELETE", `/account/${O.id}/channels/${gid}/invites`);
  check("★ 全部作废 → {revoked: 个数}", all.status === 200 && all.json?.data?.revoked === 3, JSON.stringify(all.json));
  check("全部失效", (await Promise.all([code1, code3, code4].map((c) => fetch(`${BASE}/i/${c}`)))).every((r) => r.status === 404));
  check("列表空了", ((await byO("GET", `/account/${O.id}/channels/${gid}/invites`)).json?.data?.invites ?? []).length === 0);
  check("作废之后新生成的照常可用", (await byN("GET", `/account/${N.id}/invites/${await invite()}`)).status === 200);
  // 留着这一个：下面「移除时一并作废」要数到它
  check("成员不受影响，还在群里", (await byO("GET", `/account/${O.id}/channels/${gid}/members`)).json?.data?.members?.some((m) => m.account_id === M.id));
  check("邀请接口不收 PUT → 405", (await byO("PUT", `/account/${O.id}/channels/${gid}/invites`)).status === 405);
  check("单个邀请只收 DELETE → 405", (await byO("GET", `/account/${O.id}/channels/${gid}/invites/${code1}`)).status === 405);
}

console.log("\n★ 移除成员：可选同时作废邀请、禁止再加入");
{
  const members = await byO("GET", `/account/${O.id}/channels/${gid}/members`);
  const m = (members.json?.data?.members ?? []).find((x) => x.account_id === M.id);
  check("★ 成员名单里没起名字的人叫「成员·id 后四位」", m?.name === `成员·${M.id.slice(-4)}`, m?.name);
  check("起初禁入名单是空的", Array.isArray(members.json?.data?.banned) && members.json.data.banned.length === 0, JSON.stringify(members.json?.data));

  const plainCode = await invite();
  const plain = await byO("DELETE", `/account/${O.id}/channels/${gid}/members/${M.id}`);
  check("只移除 → 原有字段 + revoked_invites 0、banned false",
    plain.status === 200 && plain.json?.data?.removed === M.id && plain.json?.data?.member_count === 1 &&
      plain.json?.data?.revoked_invites === 0 && plain.json?.data?.banned === false,
    JSON.stringify(plain.json));
  check("只移除的话，凭原来的邀请还能回来", (await byM("POST", `/account/${M.id}/invites/${plainCode}`)).json?.data?.result === "joined");

  const strict = await byO("DELETE", `/account/${O.id}/channels/${gid}/members/${M.id}?revoke_invites=1&ban=1`);
  check("★ 移除 + 作废邀请 + 禁入 → 200", strict.status === 200 && strict.json?.data?.removed === M.id, JSON.stringify(strict.json));
  // 上一节全部作废之后新生成的那个 + 这一节的 plainCode
  check("★ 报告作废了几个邀请、已禁入", strict.json?.data?.revoked_invites === 2 && strict.json?.data?.banned === true, JSON.stringify(strict.json));
  check("原来的邀请失效了", (await byN("GET", `/account/${N.id}/invites/${plainCode}`)).status === 404);

  const fresh = await invite();
  const peek = await byM("GET", `/account/${M.id}/invites/${fresh}`);
  check("被禁入的人仍能预览，并被告知 banned", peek.status === 200 && peek.json?.data?.banned === true, JSON.stringify(peek.json));
  check("别人预览没有这个标记", (await byN("GET", `/account/${N.id}/invites/${fresh}`)).json?.data?.banned === undefined);
  const rejoin = await byM("POST", `/account/${M.id}/invites/${fresh}`);
  check("★ 被禁入的人拿新邀请也进不来 → 403", rejoin.status === 403, JSON.stringify(rejoin.json));
  check("★ 说明原因", rejoin.json?.message === "群主已把你移出这个群，不能再用邀请加入", rejoin.json?.message);
  check("别人照常能加入", (await byN("POST", `/account/${N.id}/invites/${fresh}`)).json?.data?.result === "joined");

  const roster = await byO("GET", `/account/${O.id}/channels/${gid}/members`);
  check("★ 成员接口带禁入名单：account_id + 名字",
    JSON.stringify(roster.json?.data?.banned) === JSON.stringify([{ account_id: M.id, name: `成员·${M.id.slice(-4)}` }]),
    JSON.stringify(roster.json?.data?.banned));
  await byM("PATCH", `/account/${M.id}`, { name: "李四" });
  const renamed = await byO("GET", `/account/${O.id}/channels/${gid}/members`);
  check("禁入名单上的名字是现查的：改了名显示新名字", renamed.json?.data?.banned?.[0]?.name === "李四", JSON.stringify(renamed.json?.data?.banned));

  check("成员解除不了禁入 → 403", (await byN("DELETE", `/account/${N.id}/channels/${gid}/bans/${M.id}`)).status === 403);
  const lifted = await byO("DELETE", `/account/${O.id}/channels/${gid}/bans/${M.id}`);
  check("★ 群主解除禁入 → 200", lifted.status === 200 && lifted.json?.data?.unbanned === M.id, JSON.stringify(lifted.json));
  check("解除之后可以重新加入", (await byM("POST", `/account/${M.id}/invites/${fresh}`)).json?.data?.result === "joined");
  check("解除一个不在名单上的人 → 404", (await byO("DELETE", `/account/${O.id}/channels/${gid}/bans/${M.id}`)).status === 404);
  check("没给账号 id → 400", (await byO("DELETE", `/account/${O.id}/channels/${gid}/bans`)).status === 400);
  check("解除禁入只收 DELETE → 405", (await byO("GET", `/account/${O.id}/channels/${gid}/bans/${M.id}`)).status === 405);
  check("移除不在群里的人 → 404（也不会记下禁入）",
    (await byO("DELETE", `/account/${O.id}/channels/${gid}/members/${O.id}?ban=1`)).status === 404 &&
      ((await byO("GET", `/account/${O.id}/channels/${gid}/members`)).json?.data?.banned ?? []).length === 0);
}

console.log("\n★ 认领：旧版 App 照常可用");
{
  const mid = `msg-${run}`;
  const ack = await byM("POST", `/account/${M.id}/channels/${gid}/ack`, { message_id: mid, title: "旧版 App 会带标题" });
  check("带 title、不带 sig 的旧式请求 → 200", ack.status === 200 && ack.json?.data?.first === true, JSON.stringify(ack.json));
  check("认领人用的是显示名", ack.json?.data?.acked_by === "李四", ack.json?.data?.acked_by);
  const withSig = await byN("POST", `/account/${N.id}/channels/${gid}/ack`, { message_id: `${mid}-2`, sig: "AAAAAAAAAAAAAAAAAAAAAA" });
  check("本地没有签发密钥：带 sig 也不核对 → 200", withSig.status === 200, JSON.stringify(withSig.json));
  check("没起名字的人认领，记的是「成员·id 后四位」", withSig.json?.data?.acked_by === `成员·${N.id.slice(-4)}`, withSig.json?.data?.acked_by);
}

console.log("\n★ 举报：每个账号每小时 5 次");
{
  const statuses = [];
  for (let i = 0; i < 5; i++) {
    statuses.push((await byN("POST", `/account/${N.id}/channels/${gid}/report`, { reason: "spam", message_id: `r-${i}` })).status);
  }
  check("前 5 次收下", statuses.every((s) => s === 200), statuses.join(","));
  const sixth = await byN("POST", `/account/${N.id}/channels/${gid}/report`, { reason: "spam", message_id: "r-5" });
  check("★ 第 6 次 → 429", sixth.status === 429, JSON.stringify(sixth.json));
  check("body 带中文原因 error 和 retry_after", typeof sixth.json?.error === "string" && sixth.json.error.includes("举报") && typeof sixth.json?.retry_after === "number", JSON.stringify(sixth.json));
  check("旧版 App 读的 message 也是这句", sixth.json?.message === sixth.json?.error);
  check("头里有 Retry-After", Number(sixth.headers.get("retry-after")) === sixth.json?.retry_after);
  check("填错的请求照常报 400，不被额度挡在前面", (await byN("POST", `/account/${N.id}/channels/${gid}/report`, { reason: "nope" })).status === 400);
}

console.log("\n★ 删群时管控状态一起删");
{
  await invite();
  const del = await byO("DELETE", `/account/${O.id}/channels/${gid}`);
  check("删群 → 200", del.status === 200 && del.json?.data?.deleted === true, JSON.stringify(del.json));
  check("删掉的群列不了邀请、也解除不了禁入 → 404",
    (await byO("GET", `/account/${O.id}/channels/${gid}/invites`)).status === 404 &&
      (await byO("DELETE", `/account/${O.id}/channels/${gid}/bans/${M.id}`)).status === 404);
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
