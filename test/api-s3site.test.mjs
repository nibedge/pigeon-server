/**
 * 对外页面与合规的端到端测试：帮助与支持页、落地页示例命令、隐私政策和使用条款的关键说法、
 * 邀请页的应用内浏览器提示、几处指路文案。
 *
 *   BASE=http://localhost:8799 node test/api-s3site.test.mjs
 *
 * 本地 wrangler dev 没有 APNS_KEY_P8，推送走到签发 APNs token 那一步就失败 —— 这里要的是请求被正常受理
 * （内容解析对了），推出去的 payload 长什么样在 test/site.test.mjs 里核对。
 */
import { execFile } from "node:child_process";

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
  if (body) headers["content-type"] = "application/json";
  if (secret) headers.authorization = `Bearer ${secret}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 页面 */
  }
  return { status: res.status, headers: res.headers, text, json };
}

// 每次运行换一批 token：本地 KV 跨次保留
const run = Date.now().toString(16);
let seq = 0;
async function newAccount(name) {
  seq += 1;
  const token = `${run}${seq}`.padEnd(64, "a").slice(0, 64);
  const r = await call("POST", "/account", { body: { device_token: token, environment: "sandbox", device_name: "测试机" } });
  const data = r.json?.data;
  if (name) await call("PATCH", `/account/${data.account_id}`, { secret: data.secret, body: { name } });
  return { id: data?.account_id, secret: data?.secret, key: data?.channels?.[0]?.key, channelId: data?.channels?.[0]?.id };
}

function plain(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

/** 推送被正常受理：成功，或者（本地没有 APNs 私钥）走到了投递那一步才失败 */
const accepted = (r) => r.status === 200 || (r.status >= 500 && /推送失败|APNs/.test(r.json?.message ?? ""));

console.log("\n★ 帮助与支持页");
{
  const r = await call("GET", "/support");
  check("★ /support → 200", r.status === 200 && (r.headers.get("content-type") ?? "").startsWith("text/html"), String(r.status));
  check("没有脚本、带安全头", /script-src 'none'/.test(r.headers.get("content-security-policy") ?? "") && r.headers.get("x-frame-options") === "DENY");
  const text = plain(r.text);
  check("举报、屏蔽、删号的路径都在", ["举报这条消息", "举报这个群组", "设置 → 隐私与安全 → 已屏蔽", "设置 → 删除账号"].every((p) => text.includes(p)));
  check("联系方式：GitHub issue", r.text.includes("https://github.com/nibedge/pigeon-server/issues"));
  check("/support/x → 404", (await call("GET", "/support/x")).status === 404);
  check("落地页、隐私政策、使用条款都链到它", (await Promise.all(["/", "/privacy", "/terms"].map((p) => call("GET", p)))).every((p) => p.text.includes('href="/support"')));
}

console.log("\n★ 落地页");
{
  const r = await call("GET", "/");
  const text = plain(r.text);
  check("★ 不再写「早期预览 / 正在开发中」", !text.includes("早期预览") && !text.includes("开发中"));
  check("★ 如实写明官方 App 只接收 nfo.im 的推送", text.includes("官方信鸽 App 只接收 nfo.im 发出的推送"));

  // 示例命令照抄：换成本地地址和真的 key，用系统的 curl 跑
  const A = await newAccount();
  const commands = [...r.text.matchAll(/<pre>([\s\S]*?)<\/pre>/g)]
    .flatMap((m) => plain(m[1].replace(/\n/g, "\u0000")).split("\u0000"))
    .map((l) => l.trim())
    .filter((l) => l.startsWith("curl "));
  check("落地页有 4 条示例", commands.length === 4, String(commands.length));
  for (const command of commands) {
    const args = [];
    for (const m of command.slice(5).matchAll(/"([^"]*)"|(\S+)/g)) args.push(m[1] ?? m[2]);
    const local = args.map((a) => a.replace("https://nfo.im/{key}", `${BASE}/${A.key}`));
    const out = await new Promise((resolve) => {
      execFile("curl", ["-sS", "--max-time", "10", ...local], (err, stdout) => resolve({ code: err ? (err.code ?? 1) : 0, stdout }));
    });
    let json = null;
    try {
      json = JSON.parse(out.stdout);
    } catch {
      /* 下面报 */
    }
    const r2 = { status: json?.code, json };
    check(`★ 「${command.slice(0, 50)}…」照抄能发（curl 0，请求被受理）`, out.code === 0 && accepted(r2), `${out.code} ${out.stdout}`);
  }
}

console.log("\n★ 隐私政策、使用条款的关键说法");
{
  const privacy = plain((await call("GET", "/privacy")).text);
  for (const phrase of ["取前 24 个十六进制字符（96 位）", "挨个算一遍", "不满 14 周岁", "Cloudflare, Inc.", "Apple Inc.", "加载此群的图片", "最长保留约 70 分钟", "15 个工作日内答复"]) {
    check(`隐私政策：「${phrase}」`, privacy.includes(phrase));
  }
  const terms = plain((await call("GET", "/terms")).text);
  check("使用条款：「设置 → 隐私与安全 → 已屏蔽」", terms.includes("设置 → 隐私与安全 → 已屏蔽"));
  check("使用条款：违禁词过滤", terms.includes("违禁词表"));
}

console.log("\n★ 建一个群");
const O = await newAccount("老王");
const made = await call("POST", `/account/${O.id}/channels`, { secret: O.secret, body: { name: "页面测试群", group: true } });
const group = made.json?.data?.channel ?? {};
const code = (await call("POST", `/account/${O.id}/channels/${group.id}/invites`, { secret: O.secret })).json?.data?.code ?? "";
const M = await newAccount();
{
  const joined = await call("POST", `/account/${M.id}/invites/${code}`, { secret: M.secret });
  check("成员加入", joined.json?.data?.result === "joined", joined.text);
}

console.log("\n★ 邀请页：应用内浏览器提示、复制完整链接、群主");
{
  const inApp = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 SomeChat/8.0.49";
  const safari = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
  const inside = await call("GET", `/i/${code}`, { headers: { "user-agent": inApp } });
  check("★ 应用内打开 → 提示「在 Safari 中打开」", inside.status === 200 && plain(inside.text).includes("在 Safari 中打开"), String(inside.status));
  const outside = await call("GET", `/i/${code}`, { headers: { "user-agent": safari } });
  check("Safari 打开 → 没有提示", outside.status === 200 && !outside.text.includes("在 Safari 中打开"));
  check("「复制完整邀请链接」和「由 老王 创建」都在", outside.text.includes("复制完整邀请链接") && plain(outside.text).includes("由 老王 创建"));
}

console.log("\n★ 指路文案");
{
  const E = await newAccount();
  await call("PATCH", `/account/${E.id}/channels/${E.channelId}`, { secret: E.secret, body: { policy: { e2eOnly: true } } });
  const hook = await call("POST", `/hook/${E.key}/github`, { body: { zen: "x" } });
  check("★ 只收加密的通道拒收 webhook，指向 /tools/pigeon-send.mjs", hook.status === 400 && (hook.json?.message ?? "").includes("/tools/pigeon-send.mjs"), hook.text);

  const blocked = await call("POST", `/account/${M.id}/channels/${group.id}/block`, { secret: M.secret });
  check("成员屏蔽群主", blocked.status === 200, blocked.text);
  const again = (await call("POST", `/account/${O.id}/channels/${group.id}/invites`, { secret: O.secret })).json?.data?.code;
  const join = await call("POST", `/account/${M.id}/invites/${again}`, { secret: M.secret });
  check("★ 再加入被拦，路径是「设置 → 隐私与安全 → 已屏蔽」", join.status === 403 && (join.json?.message ?? "").includes("设置 → 隐私与安全 → 已屏蔽"), join.text);
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
