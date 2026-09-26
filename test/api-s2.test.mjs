/**
 * 推送入口的长度上限与响应字段，打真跑起来的 Worker（本地 wrangler dev）。
 *
 *   BASE=http://localhost:8799 node test/api-s2.test.mjs
 *
 * 本地没有 APNs 私钥，投递必然失败（签不出 token）—— 正好拿来验失败的说法：
 * 状态码按责任归类、说明是中文、原始 reason 附在 data 里。截断、id、提示这些在
 * 失败响应里同样回带，所以不必真的送达也验得到。送达之后的 payload 在单元测试里验。
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

async function send(method, path, { json, body, headers = {}, secret } = {}) {
  const h = { ...headers };
  if (json !== undefined) h["content-type"] = "application/json";
  if (secret) h.authorization = `Bearer ${secret}`;
  const res = await fetch(BASE + path, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : body });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    /* 不是 JSON 的交给断言 */
  }
  return { status: res.status, json: parsed };
}

const created = await send("POST", "/account", {
  json: { device_token: "5".repeat(64), environment: "sandbox", device_name: "上限测试 iPhone" },
});
const account = created.json?.data ?? {};
const channel = account.channels?.[0] ?? {};
const key = channel.key;
check("建账号（前置）", created.status === 200 && typeof key === "string", JSON.stringify(created.json));

// 没有 Content-Length 的分块上传（边读边数）只在单元测试里验（test/push.test.mjs）：本地 wrangler dev
// 的代理在上传中途被回 413 之后，同一条连接上的下一个请求会得到 503 —— 那是本地代理的毛病，
// 放在这里会连累后面所有 API 测试
console.log("\n★ 请求体上限 64 KB");
{
  const big = JSON.stringify({ title: "日志", body: "x".repeat(80 * 1024) });
  const r = await send("POST", `/${key}`, { body: big, headers: { "content-type": "application/json" } });
  check("★ 80KB 的请求体 → 413「内容太长」", r.status === 413 && (r.json?.message ?? "").startsWith("内容太长"), JSON.stringify(r.json));
  const ghost = await send("POST", "/nosuchkey000000", { body: big, headers: { "content-type": "application/json" } });
  check("声明的长度超了，连 key 都不必查就回 413", ghost.status === 413, String(ghost.status));
  const batch = await send("POST", "/push", { body: JSON.stringify({ device_key: key, body: "y".repeat(80 * 1024) }), headers: { "content-type": "application/json" } });
  check("★ /push 批量接口同样 413", batch.status === 413, JSON.stringify(batch.json));
  const under = await send("POST", `/${key}`, { json: { title: "日志", body: "z".repeat(60 * 1024) } });
  check("64KB 以内照常受理（不是 413）", under.status !== 413, String(under.status));
}

console.log("\n★ webhook 的原始 payload 可以大一些（1 MB）");
{
  const padded = { zen: "x", hook_id: 1, repository: { full_name: "a/b", description: "d".repeat(200 * 1024) } };
  const r = await send("POST", `/hook/${key}/github`, { json: padded });
  check("★ 200KB 的 webhook 照常处理（不是 413）", r.status !== 413, `${r.status} ${JSON.stringify(r.json)}`);
  const huge = await send("POST", `/hook/${key}/github`, { json: { zen: "x", pad: "p".repeat(1100 * 1024) } });
  check("超过 1 MB → 413", huge.status === 413 && (huge.json?.message ?? "").includes("1 MB"), JSON.stringify(huge.json));
}

console.log("\n★ 加密消息截不动：413 并写明字节数");
{
  const r = await send("POST", `/${key}`, { json: { ciphertext: "A".repeat(5000), iv: "aXZpdml2aXZpdml2" } });
  const data = r.json?.data ?? {};
  check("★ 密文超长 → 413", r.status === 413, JSON.stringify(r.json));
  check("★ 写明当前字节数和上限", data.bytes > data.limit && data.limit === 3800 && r.json.message.includes(String(data.bytes)) && r.json.message.includes("3800"), JSON.stringify(r.json));
  check("说明是中文，并告诉怎么办", r.json?.message?.includes("缩短正文"), r.json?.message);
}

console.log("\n★ 长正文：截短后照常投递，响应带 truncated");
{
  const r = await send("POST", `/${key}`, { json: { title: "构建日志", body: "错".repeat(5000), badge: "3", call: "1" } });
  const data = r.json?.data ?? {};
  check("★ 5000 个汉字不是 413（服务端截短，不整条拒掉）", r.status !== 413, JSON.stringify(r.json));
  check("★ 响应带 truncated: true", data.truncated === true, JSON.stringify(data));
  check("★ warnings 用中文说了截掉的是正文", Array.isArray(data.warnings) && data.warnings.some((w) => w.includes("正文")), JSON.stringify(data.warnings));
  check("★ 顶层带这次的消息 id（没给就由服务端生成）", typeof data.id === "string" && data.id.length > 0, JSON.stringify(data));
  check("★ ignored 列出这一版不生效的参数", JSON.stringify(data.ignored) === JSON.stringify(["badge", "call"]), JSON.stringify(data.ignored));
}

console.log("\n★ 投递失败的说法（本地签不出 APNs token）");
{
  const r = await send("GET", `/${key}/${encodeURIComponent("磁盘满了")}?id=disk-1`);
  check("★ 服务端配置问题 → 502，不是原样的 500", r.status === 502, `${r.status} ${JSON.stringify(r.json)}`);
  check("★ 说明是中文，并说明不是发送方的错", (r.json?.message ?? "").startsWith("推送失败：") && r.json.message.includes("不是你的请求出错"), r.json?.message);
  check("原始 reason 附在 data 里", (r.json?.data?.reason ?? "").includes("签发 APNs token 失败"), JSON.stringify(r.json?.data));
  check("仍回带尝试了几台设备", r.json?.data?.devices === 1);
  check("发送方给的 id 原样回带", r.json?.data?.id === "disk-1");
  check("没有提示时 warnings 是空数组", JSON.stringify(r.json?.data?.warnings) === "[]" && JSON.stringify(r.json?.data?.ignored) === "[]");

  const longId = "长".repeat(30);
  const lr = await send("POST", `/${key}`, { json: { body: "b", id: longId, repeat: "5" } });
  check("★ id 超过 64 字节 → warnings 说重复提醒未启用", (lr.json?.data?.warnings ?? []).some((w) => w.includes("64 字节") && w.includes("重复提醒未启用")), JSON.stringify(lr.json));

  const hook = await send("POST", `/hook/${key}/uptimekuma`, { json: { heartbeat: { status: 0, msg: "timeout" }, monitor: { name: "官网" } } });
  check("webhook 的失败同样按责任归类 → 502", hook.status === 502 && (hook.json?.message ?? "").startsWith("推送失败："), `${hook.status} ${JSON.stringify(hook.json)}`);
}

console.log("\n★ 心跳失败报告：超长说明不影响记失败");
{
  const made = await send("POST", `/account/${account.account_id}/watches`, {
    secret: account.secret,
    json: { kind: "heartbeat", channelId: channel.id, name: "备份", intervalMinutes: 60 },
  });
  const hb = made.json?.data?.watch ?? {};
  check("建心跳（前置）", made.status === 200 && typeof hb.id === "string", JSON.stringify(made.json));
  const r = await send("POST", `/hb/${hb.id}/fail`, { body: "日志".repeat(40 * 1024), headers: { "content-type": "text/plain" } });
  check("★ 80KB 的失败说明：不读全文，失败照样记下 → down", r.status === 200 && r.json?.data?.status === "down", `${r.status} ${JSON.stringify(r.json)}`);
}

// ── 推送入口：一行 curl 就能推、预览不推、限流 ──────────────────────
// 本地签不出 APNs token，真走到投递的请求一律 502（服务端配置问题）—— 拿「不是 400/404」
// 证明请求被认出来、走到了投递；payload 长什么样在单元测试里验（test/push.test.mjs）。

console.log("\n★ 一行 curl：请求体原文当正文");
{
  const r = await send("POST", `/${key}`, { body: "磁盘满了", headers: { "content-type": "application/x-www-form-urlencoded" } });
  check("★ curl -d \"磁盘满了\" nfo.im/KEY 走到了投递（不是 400「没有内容可推」）", r.status === 502 && JSON.stringify(r.json?.data?.warnings) === "[]", `${r.status} ${JSON.stringify(r.json)}`);
  const plain = await send("POST", `/${key}`, { body: "纯文字\n", headers: { "content-type": "text/plain" } });
  check("text/plain 同样", plain.status === 502, `${plain.status} ${JSON.stringify(plain.json)}`);
  const header = await send("POST", `/${key}`, { body: "剩余 3%", headers: { "content-type": "text/plain", Title: Buffer.from("磁盘告警", "utf8").toString("latin1"), Priority: "high" } });
  check("请求头里带 UTF-8 中文标题不出错", header.status === 502, `${header.status} ${JSON.stringify(header.json)}`);
  const junk = await send("POST", `/${key}`, { json: { foo: "bar" } });
  check("★ 请求体一个字段都没认出来 → 400，并说出原因", junk.status === 400 && (junk.json?.message ?? "").includes("没有认得的字段"), JSON.stringify(junk.json));
  const md = await send("POST", `/${key}`, { json: { markdown: "**只有 markdown**" } });
  check("只给 markdown 不再被当成没有内容", md.status === 502, `${md.status} ${JSON.stringify(md.json)}`);
  const alias = await send("POST", `/${key}`, { json: { title: "磁盘告警", msg: "剩余 3%" } });
  check("{title, msg} 走到了投递", alias.status === 502, `${alias.status} ${JSON.stringify(alias.json)}`);
}

console.log("\n★ 根路径、Bearer、.send");
{
  const root = await send("POST", "/", { body: "磁盘满了", headers: { "content-type": "text/plain" } });
  check("★ POST 到根路径 → 400 JSON：地址少了 key", root.status === 400 && (root.json?.message ?? "").startsWith("地址少了 key，应为 https://"), `${root.status} ${JSON.stringify(root.json)}`);
  const landing = await fetch(`${BASE}/`);
  check("GET 根路径照旧是落地页", landing.status === 200 && (landing.headers.get("content-type") ?? "").includes("text/html"));
  const bearer = await send("POST", "/", { body: "来自 Bearer", headers: { "content-type": "text/plain", authorization: `Bearer ${key}` } });
  check("★ Authorization: Bearer {key} 推到根路径 → 走到了投递", bearer.status === 502, `${bearer.status} ${JSON.stringify(bearer.json)}`);
  const dotSend = await send("GET", `/${key}.send?title=t&desp=d`);
  check("★ /{key}.send 照样认 key", dotSend.status === 502, `${dotSend.status} ${JSON.stringify(dotSend.json)}`);
}

console.log("\n★ 链接预览、预取、HEAD：不推");
{
  const head = await fetch(`${BASE}/${key}/x`, { method: "HEAD" });
  check("★ HEAD → 200（不推）", head.status === 200);
  const prefetch = await send("GET", `/${key}/x`, { headers: { "sec-purpose": "prefetch" } });
  check("★ Sec-Purpose: prefetch → 200 {ok, skipped: preview}", prefetch.status === 200 && prefetch.json?.ok === true && prefetch.json?.skipped === "preview", JSON.stringify(prefetch.json));
  const bot = await send("GET", `/${key}/x`, { headers: { "user-agent": "Mozilla/5.0 (compatible; ExampleLinkBot/1.0)" } });
  check("★ 链接预览爬虫 → 200 skipped", bot.status === 200 && bot.json?.skipped === "preview", JSON.stringify(bot.json));
  const named = Buffer.from("TWljcm9NZXNzZW5nZXI=", "base64").toString();
  const chat = await send("GET", `/${key}/x`, { headers: { "user-agent": `Mozilla/5.0 (iPhone) Mobile ${named}/8.0.50` } });
  check("★ 聊天软件的链接预览（UA 里只有 App 名）→ 200 skipped", chat.status === 200 && chat.json?.skipped === "preview", JSON.stringify(chat.json));
  const real = await send("GET", `/${key}/x`, { headers: { "user-agent": "curl/8.7.1" } });
  check("curl 的 GET 照推", real.status === 502, String(real.status));
}

console.log("\n★ 只收加密：密文 + 明文也拒");
{
  const e2e = await send("POST", `/account/${account.account_id}/channels`, { secret: account.secret, json: { name: "只收加密" } });
  const ch = e2e.json?.data?.channel ?? {};
  await send("PATCH", `/account/${account.account_id}/channels/${ch.id}`, { secret: account.secret, json: { policy: { e2eOnly: true } } });
  const mixed = await send("GET", `/${ch.key}/${encodeURIComponent("明文")}?ciphertext=eA&iv=aXY`);
  check("★ /{key}/明文?ciphertext=x&iv=y → 400", mixed.status === 400 && (mixed.json?.message ?? "").startsWith("这个通道只收加密消息"), JSON.stringify(mixed.json));
  const only = await send("POST", `/${ch.key}`, { json: { ciphertext: "eA", iv: "aXY" } });
  check("只带密文照常受理", only.status === 502, `${only.status} ${JSON.stringify(only.json)}`);
}

console.log("\n★ /push 批量");
{
  const many = await send("POST", "/push", { json: { device_keys: Array.from({ length: 21 }, (_, i) => `k${i}xxxxxx`), body: "b" } });
  check("★ 一次最多 20 个 key", many.status === 400 && (many.json?.message ?? "").includes("20"), JSON.stringify(many.json));
  const dd = await send("POST", `/account/${account.account_id}/channels`, { secret: account.secret, json: { name: "去重" } });
  const ddCh = dd.json?.data?.channel ?? {};
  await send("PATCH", `/account/${account.account_id}/channels/${ddCh.id}`, { secret: account.secret, json: { policy: { dedupeWindow: 600 } } });
  const first = await send("POST", "/push", { json: { device_key: ddCh.key, title: "同一句", body: "话" } });
  check("第一次：本地投递失败，message 带上原因", first.status === 400 && (first.json?.message ?? "").startsWith("全部推送失败：推送失败："), JSON.stringify(first.json));
  const again = await send("POST", "/push", { json: { device_key: ddCh.key, title: "同一句", body: "话" } });
  check("★ 开着去重连推两次：第二次 200，标 suppressed", again.status === 200 && again.json?.data?.results?.[0]?.suppressed === "duplicate" && again.json?.data?.suppressed === "duplicate", JSON.stringify(again.json));
  const empty = await send("POST", "/push", { json: { device_key: key, level: "active" } });
  check("★ 没有内容 → 逐个 key 报「没有内容可推」，不再推出 Empty Message", empty.status === 400 && (empty.json?.message ?? "").includes("没有内容可推"), JSON.stringify(empty.json));
}

console.log("\n★ 限流：同一通道每分钟 60 条，第 61 条 429");
{
  const rl = await send("POST", `/account/${account.account_id}/channels`, { secret: account.secret, json: { name: "限流" } });
  const rlKey = rl.json?.data?.channel?.key;
  const statuses = [];
  for (let i = 0; i < 61; i++) statuses.push((await send("GET", `/${rlKey}/n${i}`)).status);
  check("前 60 条照常受理（本地投递失败 502，没被限流）", statuses.slice(0, 60).every((s) => s !== 429), JSON.stringify(statuses));
  const last = await fetch(`${BASE}/${rlKey}/n61`);
  const body = await last.json().catch(() => null);
  check("★ 第 61 条起 → 429", statuses[60] === 429 && last.status === 429, `${statuses[60]} ${last.status}`);
  check("★ 带 Retry-After: 60 和中文原因", last.headers.get("retry-after") === "60" && body?.retry_after === 60 && (body?.error ?? "").includes("推送太频繁"), JSON.stringify(body));
  const hook = await send("POST", `/hook/${rlKey}/uptimekuma`, { json: { heartbeat: { status: 0, msg: "x" }, monitor: { name: "m" } } });
  check("/hook 共用这份额度", hook.status === 429, String(hook.status));
  const other = await send("GET", `/${key}/${encodeURIComponent("别的通道")}`);
  check("别的通道不受影响", other.status === 502, String(other.status));
}

console.log("\n★ 查不存在的 key：同一 IP 每分钟 30 次，超了 429");
{
  // 用一个专门的来源 IP（本地 wrangler 认客户端给的 CF-Connecting-IP；线上由 Cloudflare 填、客户端改不了），
  // 不占其它测试的额度
  const ip = { "cf-connecting-ip": "198.51.100.23" };
  const statuses = [];
  for (let i = 0; i < 31; i++) statuses.push((await send("GET", `/nosuchkey${String(i).padStart(4, "0")}/x`, { headers: ip })).status);
  check("前 30 次 → 404", statuses.slice(0, 30).every((s) => s === 404), JSON.stringify(statuses));
  check("★ 第 31 次 → 429", statuses[30] === 429, JSON.stringify(statuses));
  const hit = await send("GET", `/${key}/${encodeURIComponent("存在的 key")}`, { headers: ip });
  check("★ 存在的 key 不受影响", hit.status === 502, String(hit.status));
}

console.log("\n★ 撤回（delete=1）与认领只管这一次");
{
  const made = await send("POST", `/account/${account.account_id}/channels`, { secret: account.secret, json: { name: "撤回" } });
  const ch = made.json?.data?.channel ?? {};
  check("建通道（前置）", made.status === 200 && typeof ch.key === "string", JSON.stringify(made.json));
  const push = (query) => send("GET", `/${ch.key}?${query}`);
  const ack = (id) => send("POST", `/account/${account.account_id}/channels/${ch.id}/ack`, { secret: account.secret, json: { message_id: id } });
  const title = (text) => `title=${encodeURIComponent(text)}`;

  const noId = await push("delete=1");
  check("★ delete=1 没带 id → 400「撤回要带上原消息的 id」", noId.status === 400 && noId.json?.message === "撤回要带上原消息的 id", JSON.stringify(noId.json));

  // 本地投递必然失败（签不出 APNs token），但撤回之前该清的在投递之前就清了
  check("认领 → 第一个", (await ack("evt-oops")).json?.data?.first === true);
  const del = await push("id=evt-oops&delete=1");
  check("★ 只带 id 和 delete=1：不再是「没有内容」，响应带 retracted 和 id", del.status !== 400 && del.json?.data?.retracted === true && del.json?.data?.id === "evt-oops", JSON.stringify(del.json));
  check("★ 撤回清掉认领记录：再认领又是第一个", (await ack("evt-oops")).json?.data?.first === true);

  check("认领一件进行中的事", (await ack("evt-disk")).json?.data?.first === true);
  check("再点一次：已经有人了", (await ack("evt-disk")).json?.data?.first === false);
  await push(`id=evt-disk&status=firing&${title("磁盘又报了一遍")}`);
  check("★ 同一次触发的重发：认领记录留着", (await ack("evt-disk")).json?.data?.first === false);
  const resolved = await push(`id=evt-disk&status=resolved&${title("磁盘恢复")}`);
  check("恢复推送受理了（本地投递失败不论）", resolved.status !== 400 && resolved.status !== 404, String(resolved.status));
  const again = await ack("evt-disk");
  check("★ 恢复之后再触发：能重新认领，first=true（原先 24 小时内拿到的都是上一次的人）", again.json?.data?.first === true, JSON.stringify(again.json));

  await send("PATCH", `/account/${account.account_id}/channels/${ch.id}`, { secret: account.secret, json: { policy: { dedupeWindow: 600 } } });
  const text = title("CPU 高");
  await push(`id=cpu&status=firing&${text}`);
  const dup = await push(`id=cpu&status=firing&${text}`);
  check("开着去重：同样的进行中第二条被压掉（前置）", dup.status === 200 && dup.json?.data?.suppressed === "duplicate", JSON.stringify(dup.json));
  const res1 = await push(`id=cpu&status=resolved&${text}`);
  check("★ 文案一模一样的已恢复不被去重", res1.json?.data?.suppressed === undefined && res1.status !== 200, `${res1.status} ${JSON.stringify(res1.json)}`);
  const res2 = await push(`id=cpu&status=resolved&${text}`);
  check("★ 已恢复再来一遍也不去重", res2.json?.data?.suppressed === undefined, JSON.stringify(res2.json));
  const other = await push(`id=cpu2&status=firing&${text}`);
  check("★ 文案一样、id 不同：另一件事，不去重", other.json?.data?.suppressed === undefined, JSON.stringify(other.json));
  const del1 = await push("id=m1&delete=1");
  const del2 = await push("id=m2&delete=1");
  check("撤回不去重：连着两条撤回都照常投递", del1.json?.data?.retracted === true && del2.json?.data?.retracted === true && del2.json?.data?.suppressed === undefined, JSON.stringify(del2.json));

  await send("PATCH", `/account/${account.account_id}/channels/${ch.id}`, { secret: account.secret, json: { policy: { e2eOnly: true } } });
  const strict = await push("id=enc-1&delete=1");
  check("★ 只收加密的通道也能撤回", strict.status !== 400 && strict.json?.data?.retracted === true, JSON.stringify(strict.json));
  check("只收加密的通道照旧拒明文", (await push(title("明文"))).status === 400);
}

await send("DELETE", `/account/${account.account_id}`, { secret: account.secret });

// Uptime Kuma 的 form-data 预设：multipart，JSON 装在 data 字段里。本地投递必然失败（502），
// 只要不是 400「请求体不是合法的 JSON」就说明 workerd 里解析通了
console.log("\n★ /hook 认 multipart 和表单里的 data 字段");
{
  const made = await send("POST", "/account", {
    json: { device_token: "a6".repeat(32), environment: "sandbox", device_name: "表单测试 iPhone" },
  });
  const acct = made.json?.data ?? {};
  const hookKey = acct.channels?.[0]?.key;
  check("建账号（前置）", made.status === 200 && typeof hookKey === "string", JSON.stringify(made.json));
  const kuma = { heartbeat: { status: 0, msg: "timeout" }, monitor: { id: 3, name: "官网" }, msg: "[官网] [🔴 Down] timeout" };

  const form = new FormData();
  form.append("data", JSON.stringify(kuma));
  const multipart = await fetch(`${BASE}/hook/${hookKey}/uptimekuma`, { method: "POST", body: form });
  const mj = await multipart.json().catch(() => null);
  check("★ multipart 的 data 字段解析通了（投递失败是本地没有私钥）", multipart.status === 502 && (mj?.message ?? "").startsWith("推送失败："), `${multipart.status} ${JSON.stringify(mj)}`);

  const urlencoded = await send("POST", `/hook/${hookKey}/uptimekuma`, {
    body: new URLSearchParams({ data: JSON.stringify(kuma) }).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  check("表单里的 data 字段也认", urlencoded.status === 502, `${urlencoded.status} ${JSON.stringify(urlencoded.json)}`);

  const broken = new FormData();
  broken.append("data", "{坏的");
  const bad = await fetch(`${BASE}/hook/${hookKey}/uptimekuma`, { method: "POST", body: broken });
  const bj = await bad.json().catch(() => null);
  check("data 不是 JSON → 400，说明 JSON 该放哪", bad.status === 400 && (bj?.message ?? "").includes("data"), `${bad.status} ${JSON.stringify(bj)}`);

  const noise = await send("POST", `/hook/${hookKey}/github`, { json: { action: "completed", repository: { full_name: "a/b" } }, headers: { "x-github-event": "workflow_job" } });
  check("GitHub 的 CI 噪声事件 → 200 skipped", noise.status === 200 && noise.json?.data?.skipped === true, JSON.stringify(noise.json));

  await send("DELETE", `/account/${acct.account_id}`, { secret: acct.secret });
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
