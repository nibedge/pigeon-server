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

await send("DELETE", `/account/${account.account_id}`, { secret: account.secret });

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
