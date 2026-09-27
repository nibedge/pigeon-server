/**
 * 接入面（兼容地址、群机器人格式、国内推送参数写法、通用 JSON 和后来加上的各个入口）打真跑起来的 Worker（本地 wrangler dev）。
 *
 *   BASE=http://localhost:8799 node test/api-l1.test.mjs
 *
 * 本地没有 APNs 私钥，投递必然失败（502）—— 正好拿来验「失败时也按对方的样子回话、原因是中文」。
 * 推出去的 payload 长什么样在 api-l1-*.test.mjs 的其余几个文件里验（内存 KV、假 APNs）。
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

async function send(method, path, { json, body, headers = {} } = {}) {
  const h = { ...headers };
  if (json !== undefined) h["content-type"] = "application/json";
  const res = await fetch(BASE + path, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : body, redirect: "manual" });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* 页面、纯文字 */
  }
  return { status: res.status, headers: res.headers, text, json: parsed };
}

const created = await send("POST", "/account", { json: { device_token: "7".repeat(64), environment: "sandbox", device_name: "接入面测试" } });
const key = created.json?.data?.channels?.[0]?.key;
check("建账号（前置）", created.status === 200 && typeof key === "string", created.text);

console.log("\n★ 群机器人格式：推送失败时也按对方的样子回话");
{
  let r = await send("POST", `/${key}`, { json: { msgtype: "text", text: { content: "部署完成" } } });
  check("★ /{key} 收到 msgtype：502 + {errcode:502, errmsg:推送失败…}", r.status === 502 && r.json?.errcode === 502 && r.json?.errmsg?.startsWith("推送失败"), r.text);
  r = await send("POST", `/cgi-bin/webhook/send?key=${key}`, { json: { msgtype: "markdown", markdown: { content: "# 标题\n正文" } } });
  check("★ /cgi-bin/webhook/send?key= 走到了投递", r.status === 502 && r.json?.errcode === 502, r.text);
  r = await send("POST", `/robot/send?access_token=${key}&timestamp=1&sign=x`, { json: { msgtype: "text", text: { content: "x" }, at: { isAtAll: true } } });
  check("★ /robot/send?access_token=…&timestamp&sign 走到了投递", r.status === 502 && r.json?.errcode === 502, r.text);
  r = await send("POST", `/open-apis/bot/v2/hook/${key}`, { json: { msg_type: "text", content: { text: "x" } } });
  check("★ /open-apis/bot/v2/hook/{key} → {code:502, msg}", r.status === 502 && r.json?.code === 502 && r.json?.msg?.startsWith("推送失败"), r.text);
  r = await send("POST", `/api/webhooks/1/${key}`, { json: { embeds: [{ title: "x" }] } });
  check("★ /api/webhooks/{id}/{key} → {code:502, message}", r.status === 502 && r.json?.code === 502 && r.json?.message?.startsWith("推送失败"), r.text);
  r = await send("POST", `/services/T/B/${key}`, { json: { text: "x", blocks: [] } });
  check("★ /services/…/{key} → 502 纯文字", r.status === 502 && r.text.startsWith("推送失败") && (r.headers.get("content-type") ?? "").startsWith("text/plain"), r.text);
  r = await send("POST", "/robot/send?access_token=nosuchkey000", { json: { msgtype: "text", text: { content: "x" } } });
  check("key 不存在 → 404 {errcode:404}", r.status === 404 && r.json?.errcode === 404, r.text);
  r = await send("GET", `/open-apis/bot/v2/hook/${key}`);
  check("GET → 405", r.status === 405 && r.json?.code === 405, r.text);
}

console.log("\n★ 国内推送参数写法、通用 JSON");
{
  let r = await send("POST", `/${key}`, { json: { text: "标题", desp: "正文", token: "别家令牌", channel: 9 } });
  check("★ text + desp 走到了投递；别家参数列进 ignored", r.status === 502 && JSON.stringify(r.json?.data?.ignored) === JSON.stringify(["token", "channel"]), r.text);
  r = await send("POST", `/${key}`, { json: { event: "backup", status: "failed" } });
  check("★ 认不出正文的 JSON 按通用 JSON 推（走到投递）", r.status === 502 && r.json?.data?.warnings?.some((w) => w.includes("通用 JSON")), r.text);
  r = await send("POST", `/hook/${key}/json`, { json: { name: "x", value: 1 } });
  check("★ /hook/{key}/json 走到了投递", r.status === 502, r.text);
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
