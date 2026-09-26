/**
 * 对外页面与合规：帮助与支持页、隐私政策与代码逐条对照、使用条款、落地页（示例命令用真的 curl 跑一遍）、
 * 几处指路文案、删号时连带删掉自己群的管控状态。
 *
 * 直接调 Worker 的 fetch，KV 放内存里，APNs 换成截获请求的假 fetch（见 web-harness.mjs）。
 * 由 npm run test:web 在同一次构建之后运行。
 */
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../.test-build/s3web/index.mjs";
import { ACK_TTL_SECONDS, INVITE_TTL_SECONDS, REPORT_TTL_SECONDS } from "../.test-build/s3web/db.mjs";
import { REPORTS_PER_HOUR } from "../.test-build/s3web/groups.mjs";
import { MAX_ACCOUNTS_PER_DEVICE } from "../.test-build/s3web/guard.mjs";
import { landingPage } from "../.test-build/s3web/landing.mjs";
import { DEDUPE_MAX_SECONDS, isDuplicate } from "../.test-build/s3web/policy.mjs";
import { privacyPage } from "../.test-build/s3web/privacy.mjs";
import { REPEAT_WINDOW_MS } from "../.test-build/s3web/push.mjs";
import { CONTACT, ISSUES_URL, supportPage } from "../.test-build/s3web/support.mjs";
import { termsPage } from "../.test-build/s3web/terms.mjs";
import { apns, call, makeEnv, makeGroup, newAccount, plain, req } from "./web-harness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `  → ${detail}` : ""}`);
  }
}

// ── 帮助与支持 ───────────────────────────────────────────────────────

console.log("\n★ 帮助与支持页 /support");
{
  const env = makeEnv({ APNS_KEY_P8: "" });
  const r = await call(env, "GET", "/support");
  check("★ /support → 200 页面", r.status === 200 && r.headers.get("content-type")?.startsWith("text/html"), String(r.status));
  const csp = r.headers.get("content-security-policy") ?? "";
  check("安全头齐全、没有脚本（script-src 'none'）", /script-src 'none'/.test(csp) && /frame-ancestors 'none'/.test(csp) &&
    r.headers.get("strict-transport-security") === "max-age=31536000" && !/<script/i.test(r.text), csp);
  const text = plain(r.text);
  for (const phrase of [
    "举报这条消息", "举报这个群组", "屏蔽群主", "设置 → 隐私与安全 → 已屏蔽", "设置 → 删除账号", "设置 → 我的设备",
    "更换推送地址", "在另一台设备上使用", "继续使用", "24 小时内",
  ]) {
    check(`写到「${phrase}」`, text.includes(phrase));
  }
  check("举报、删除、联系三处都有锚点（App 和别的页面链过来）", ['id="report"', 'id="delete"', 'id="contact"'].every((a) => r.text.includes(a)));
  check("公开渠道：GitHub issue，并提醒别贴凭据", r.text.includes(`href="${ISSUES_URL}"`) && text.includes("别贴推送地址"));
  check("★ 运营者和私下联系的邮箱还没定：不编一个出来", CONTACT.email === "" && CONTACT.operator === "" && !r.text.includes("mailto:"));
  check("链到隐私政策和使用条款", r.text.includes('href="/privacy"') && r.text.includes('href="/terms"'));
  const deeper = await call(env, "GET", "/support/x");
  check("/support/x → 404", deeper.status === 404);
  const plainHttp = await worker.fetch(req("GET", "/support", { origin: "http://nfo.im" }), env, {});
  check("明文 http → 301 到 https", plainHttp.status === 301 && plainHttp.headers.get("location") === "https://nfo.im/support");

  const withMail = supportPage("nfo.im", { operator: "", email: 'help"x@example.test' });
  check("★ 定了邮箱：出现私下联系，mailto 转义过", withMail.includes("私下联系") && withMail.includes('mailto:help&quot;x@example.test') && !withMail.includes('help"x'));
  check("主机名转义后输出", !supportPage('evil"><img src=x>').includes('"><img'));
}

console.log("\n★ 各页都链到帮助与支持");
{
  const env = makeEnv({ APNS_KEY_P8: "" });
  for (const path of ["/", "/privacy", "/terms", "/send"]) {
    const r = await call(env, "GET", path);
    check(`${path} 链到 /support`, r.text.includes('href="/support"'));
  }
  const groupEnv = makeEnv();
  const g = await makeGroup(groupEnv);
  check("/i/{code} 链到 /support", (await call(groupEnv, "GET", `/i/${g.code}`)).text.includes('href="/support"'));
}

// ── 隐私政策与代码逐条对照 ────────────────────────────────────────────

console.log("\n★ 隐私政策与代码逐条对照");
{
  const page = privacyPage("nfo.im");
  const text = plain(page);

  const env = makeEnv();
  await isDuplicate(env, "chan0001", { title: "验证码", body: "123456" }, 60);
  const hash = [...env.PIGEON_KV.store.keys()].find((k) => k.startsWith("dedupe:"))?.split(":")[2] ?? "";
  check("去重哈希实际是 24 个十六进制字符", /^[0-9a-f]{24}$/.test(hash), hash);
  check(`★ 政策写的长度与代码一致（前 ${hash.length} 个十六进制字符，${hash.length * 4} 位）`,
    text.includes(`取前 ${hash.length} 个十六进制字符（${hash.length * 4} 位）`));
  check("不再是错的「前 12 个十六进制字符」", !text.includes("前 12 个十六进制字符"));
  check("★ 如实写明短内容可以被穷举", text.includes("挨个算一遍") && text.includes("验证码"));
  check("去重窗口最长 1 小时", DEDUPE_MAX_SECONDS === 3600 && text.includes("最长 1 小时"));

  check("认领记录 24 小时，与 ACK_TTL_SECONDS 一致", ACK_TTL_SECONDS === 24 * 3600 && text.includes("24 小时后自动删除"));
  check("认领记录不含内容", text.includes("不含通知的任何内容"));
  check("邀请码 7 天，与 INVITE_TTL_SECONDS 一致", INVITE_TTL_SECONDS === 7 * 86400 && text.includes("7 天后自动删除"));
  check("举报 90 天，与 REPORT_TTL_SECONDS 一致", REPORT_TTL_SECONDS === 90 * 86400 && text.includes("90 天后自动删除"));
  check("重复提醒窗口一小时 + 余量 → 政策写「最长保留约 70 分钟」", REPEAT_WINDOW_MS === 3600_000 && text.includes("最长保留约 70 分钟"));
  check("一台设备最多 3 个账号，与 MAX_ACCOUNTS_PER_DEVICE 一致", MAX_ACCOUNTS_PER_DEVICE === 3 && text.includes("最多登记 3 个账号"));

  for (const [label, phrase] of [
    ["铃声和备注名", "群备注名"],
    ["图片加载偏好", "是否加载某个群的图片"],
    ["条款确认时刻", "条款确认时刻"],
    ["iCloud 钥匙串", "iCloud 钥匙串"],
    ["附加字段不加密", "图标、图片网址和「复制内容」"],
    ["设备直接访问发送方的图片地址", "由你的设备直接从发送方给的网址下载"],
    ["加入的群默认不加载图片", "加载此群的图片"],
    ["禁入名单", "禁止再加入"],
    ["显示名会出现在公开的邀请页上", "邀请页上会显示你的显示名"],
    ["兜底名", "成员·账号 id 后四位"],
    ["验令牌的后台推送", "不显示的后台推送"],
    ["违禁词过滤", "违禁词表"],
    ["短信与验证码", "验证码识别和一键复制只在你的设备上进行"],
    ["不满 14 周岁", "不满 14 周岁"],
    ["境外接收方：Apple", "Apple Inc."],
    ["境外接收方：Cloudflare", "Cloudflare, Inc."],
    ["境外接收方的联系方式", "privacyquestions@cloudflare.com"],
    ["行使权利的方式", "15 个工作日内答复"],
    ["IP 只用于限流", "只在限流时临时用来计数"],
    ["日志里没有内容", "不记录请求地址、推送 key 和推送内容"],
  ]) {
    check(`写到${label}`, text.includes(phrase), phrase);
  }
  check("Apple 的隐私联系入口是链接", page.includes('href="https://www.apple.com/legal/privacy/contact/"'));
  check("不再写 13 岁、不再说「不要你的账号」", !text.includes("13 岁") && !text.includes("不要你的账号"));
  check("运营者没定时不出现「谁在处理」一节", !text.includes("谁在处理你的信息"));
  const named = privacyPage("nfo.im", { operator: "<某某>", email: "a@example.test" });
  check("★ 定了运营者：写明处理者（转义过），联系里有邮箱", named.includes("谁在处理你的信息") && named.includes("&lt;某某&gt;") && named.includes("mailto:a@example.test"));

  // 运行日志：政策说日志里没有请求地址，靠的是关掉调用日志
  const toml = readFileSync(join(ROOT, "wrangler.toml"), "utf8");
  check("★ wrangler.toml 关掉了调用日志（invocation_logs = false）", /\[observability\.logs\][^[]*invocation_logs\s*=\s*false/.test(toml));

  // KV 键前缀：src 里声明的每一个都要写进 privacy.ts 的清单
  const source = readFileSync(join(ROOT, "src/privacy.ts"), "utf8");
  const declared = new Set();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== "generated") walk(path);
      } else if (name.endsWith(".ts")) {
        const code = readFileSync(path, "utf8");
        for (const m of code.matchAll(/const\s+[A-Z][A-Z0-9_]*\s*=\s*"([a-z][a-z_]*:[a-z_:]*)"/g)) declared.add(m[1]);
        for (const m of code.matchAll(/const\s+key\s*=\s*`([a-z][a-z_]*:)/g)) declared.add(m[1]);
      }
    }
  };
  walk(join(ROOT, "src"));
  check("扫到了已知的几个前缀（扫描本身没失灵）", ["acct:", "grp:", "tok:", "repeat:", "dedupe:", "config:blocklist"].every((p) => declared.has(p)), [...declared].join(" "));
  const missing = [...declared].filter((p) => !source.includes("`" + p + "`"));
  check("★ 每个 KV 键前缀都写进了 privacy.ts 的清单", missing.length === 0, `没写的：${missing.join(" ")}`);
}

console.log("\n★ 使用条款");
{
  const text = plain(termsPage("nfo.im"));
  check("★ 屏蔽名单的路径是「设置 → 隐私与安全 → 已屏蔽」", text.includes("设置 → 隐私与安全 → 已屏蔽") && !text.includes("「设置 → 已屏蔽」"));
  check("举报一条消息的入口写对了", text.includes("消息详情 → 举报这条消息"));
  check("建群、设为群组、第一次邀请之前确认条款", text.includes("新建群组、把通道设为群组、第一次生成邀请之前"));
  check("写明违禁词过滤", text.includes("违禁词表"));
  check("举报频率与代码一致", REPORTS_PER_HOUR === 5 && text.includes("每小时最多举报 5 次"));
  check("每台设备 3 个账号", text.includes("一台设备最多登记 3 个账号"));
  check("不满 14 周岁要监护人同意", text.includes("不满 14 周岁"));
  check("群主的管理手段", text.includes("禁止此人再用邀请加入") && text.includes("邀请页上会显示群主的显示名"));
}

// ── 落地页与示例命令 ──────────────────────────────────────────────────

/** 按 shell 的规矩拆一行命令：认双引号、单引号，不处理转义（示例里用不到） */
function shellWords(line) {
  const words = [];
  let cur = "";
  let quote = null;
  let started = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) words.push(cur);
      cur = "";
      started = false;
      continue;
    }
    cur += ch;
    started = true;
  }
  if (quote) throw new Error(`引号没配对：${line}`);
  if (started) words.push(cur);
  return words;
}

/** 页面里 <pre>、<code> 中的每一条 curl 命令（去掉标签、还原实体） */
function curlCommands(html) {
  const out = [];
  for (const m of html.matchAll(/<(pre|code)[^>]*>([\s\S]*?)<\/\1>/g)) {
    const inner = m[2]
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
    for (const line of inner.split("\n")) if (line.trim().startsWith("curl ")) out.push(line.trim());
  }
  return out;
}

/** 从命令里读出它想推的参数：地址后面的路径段、-d、--data-urlencode */
function intended(words) {
  const params = {};
  const path = decodeURIComponent(new URL(words[1].replace("{key}", "KEY")).pathname).split("/").filter(Boolean).slice(1);
  if (path.length === 1) params.body = path[0];
  if (path.length === 2) [params.title, params.body] = path;
  for (let i = 2; i < words.length; i += 2) {
    if (words[i] !== "-d" && words[i] !== "--data-urlencode") throw new Error(`不认识的参数 ${words[i]}`);
    const [k, ...v] = words[i + 1].split("=");
    params[k] = v.join("=");
  }
  return params;
}

function runCurl(args) {
  return new Promise((resolve) => {
    execFile("curl", ["-sS", "--max-time", "10", ...args], (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
  });
}

console.log("\n★ 落地页：如实，示例照抄就能用");
{
  const page = landingPage("nfo.im");
  const text = plain(page);
  check("★ 没有「早期预览」「正在开发中」", !text.includes("早期预览") && !text.includes("开发中"));
  check("★ 不再说「一条命令部署…数据只在你的服务器之间流动」", !text.includes("一条命令部署") && !text.includes("你的服务器和 Apple 之间"));
  check("★ 如实写明官方 App 只接收本站的推送", text.includes("官方信鸽 App 只接收 nfo.im 发出的推送"));
  check("开源可核对：链到源码和 /info", page.includes('href="https://github.com/nibedge/pigeon-server"') && page.includes('href="/info"'));
  check("加密指向 /tools/pigeon-send.mjs", page.includes('href="/tools/pigeon-send.mjs"'));
  check("没上架时如实说「即将上架」，不放会 404 的链接", text.includes("即将上架 App Store") && !page.includes("apps.apple.com"));
  const r = await call(makeEnv({ APNS_KEY_P8: "" }), "GET", "/");
  check("首页照样没有脚本（script-src 'none'）", /script-src 'none'/.test(r.headers.get("content-security-policy") ?? "") && !/<script/i.test(r.text));
}

console.log("\n★ 落地页和帮助页上的每条 curl，用真的 curl 跑一遍");
{
  // 一个本地 http 服务把 curl 发来的请求原样交给 Worker（当作 https://nfo.im 收到），APNs 仍是假的
  const env = makeEnv();
  const acct = await newAccount(env);
  const server = http.createServer(async (inbound, res) => {
    const chunks = [];
    for await (const chunk of inbound) chunks.push(chunk);
    const headers = new Headers();
    for (const [k, v] of Object.entries(inbound.headers)) {
      if (typeof v === "string" && !["host", "connection", "content-length", "transfer-encoding"].includes(k)) headers.set(k, v);
    }
    const hasBody = inbound.method !== "GET" && inbound.method !== "HEAD";
    const response = await worker.fetch(
      new Request(`https://nfo.im${inbound.url}`, { method: inbound.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined }),
      env,
      {},
    );
    res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "text/plain" });
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const commands = [
    ...curlCommands(landingPage("nfo.im")).map((c) => ["落地页", c]),
    ...curlCommands(supportPage("nfo.im")).map((c) => ["帮助页", c]),
  ];
  check("落地页至少 4 条、帮助页至少 2 条示例", commands.filter(([w]) => w === "落地页").length >= 4 && commands.filter(([w]) => w === "帮助页").length >= 2, String(commands.length));
  for (const [where, command] of commands) {
    const words = shellWords(command);
    check(`${where}：「${command.slice(0, 48)}…」地址以 https://nfo.im/{key} 开头`, words[1]?.startsWith("https://nfo.im/{key}"), words[1]);
    let want;
    try {
      want = intended(words);
    } catch (err) {
      check(`${where}：参数都是 -d / --data-urlencode 成对出现`, false, `${err.message}：${command}`);
      continue;
    }
    const args = words.slice(1).map((w) => w.replace("https://nfo.im/{key}", `${origin}/${acct.key}`));
    const before = apns.length;
    const run = await runCurl(args);
    let json = null;
    try {
      json = JSON.parse(run.stdout);
    } catch {
      /* 下面报 */
    }
    check(`★ ${where}：照抄执行成功（curl 退出码 0，推送 200）`, run.code === 0 && json?.code === 200 && apns.length > before, `${run.code} ${run.stderr} ${run.stdout}`);
    const sent = apns.at(-1)?.payload ?? {};
    const alert = sent.aps?.alert ?? {};
    const got = {
      title: alert.title,
      body: alert.body,
      id: sent.id,
      status: sent.status,
      repeat: sent.repeat,
      level: sent.aps?.["interruption-level"],
    };
    const levels = { passive: "passive", active: "active", timeSensitive: "time-sensitive", critical: "time-sensitive" };
    const expected = { ...want, level: want.level ? levels[want.level] : undefined };
    const diff = Object.keys(got).filter((k) => expected[k] !== undefined && expected[k] !== got[k]);
    check(`${where}：推出去的正是命令里写的内容`, diff.length === 0, `${diff.map((k) => `${k}: 想要 ${expected[k]} 实际 ${got[k]}`).join("；")}`);
    if (want.repeat) {
      check(`${where}：排上了重复提醒，响应里给出同一个 id`, json?.data?.repeat?.id === want.id, JSON.stringify(json?.data));
    }
  }
  check("★ 最后那条 resolved 把 db-01 的重复提醒停了", ![...env.PIGEON_KV.store.keys()].some((k) => k.startsWith("repeat:") && k.endsWith(":db-01")));

  // 反例：旧落地页那种写法，curl 自己就会报错 —— 证明上面的检查真能抓住它
  const broken = await runCurl([`${origin}/${acct.key}/生产告警/CPU 95%`]);
  check("反例：地址里带空格的旧写法，curl 直接失败", broken.code !== 0, String(broken.code));
  server.close();
}

// ── 指路文案 ────────────────────────────────────────────────────────

console.log("\n★ 几处指路文案");
{
  const env = makeEnv();
  const owner = await newAccount(env);
  await call(env, "PATCH", `/account/${owner.id}/channels/${owner.channelId}`, { secret: owner.secret, body: { policy: { e2eOnly: true } } });
  const hook = await call(env, "POST", `/hook/${owner.key}/github`, { body: { zen: "x" } });
  check("★ 只收加密的通道拒收 webhook 时，指向 /tools/pigeon-send.mjs", hook.status === 400 && hook.json?.message?.includes("https://nfo.im/tools/pigeon-send.mjs"), hook.text);
  check("不再提不存在的「加密中继」", !hook.json?.message?.includes("中继"));

  const g = await makeGroup(env);
  const blocked = await call(env, "POST", `/account/${g.member.id}/channels/${g.id}/block`, { secret: g.member.secret });
  check("成员屏蔽群主", blocked.status === 200, blocked.text);
  const code = (await call(env, "POST", `/account/${g.owner.id}/channels/${g.id}/invites`, { secret: g.owner.secret })).json.data.code;
  const again = await call(env, "POST", `/account/${g.member.id}/invites/${code}`, { secret: g.member.secret });
  check("★ 再加入被拦，路径写成「设置 → 隐私与安全 → 已屏蔽」", again.status === 403 && again.json?.message?.includes("「设置 → 隐私与安全 → 已屏蔽」"), again.text);

  const send = plain((await call(makeEnv({ APNS_KEY_P8: "" }), "GET", "/send")).text);
  check("发送页如实写明重复提醒的暂存", send.includes("只有通道设了重复提醒时，会暂存到提醒结束（最长约 70 分钟）"));
}

// ── 删除账号时连带删掉自己群的管控状态 ────────────────────────────────

console.log("\n★ 删除账号：自己建的群的邀请索引、禁入名单一起删");
{
  const env = makeEnv();
  const g = await makeGroup(env);
  // 成员自己也建一个群，把群主拉进去：删群主的账号时，这个群的管控状态不能动
  const other = (await call(env, "POST", `/account/${g.member.id}/channels`, { secret: g.member.secret, body: { name: "成员的群", group: true } })).json.data.channel;
  const otherCode = (await call(env, "POST", `/account/${g.member.id}/channels/${other.id}/invites`, { secret: g.member.secret })).json.data.code;
  await call(env, "POST", `/account/${g.owner.id}/invites/${otherCode}`, { secret: g.owner.secret });
  check("删之前两个群都有管控状态", env.PIGEON_KV.store.has(`grp:${g.id}`) && env.PIGEON_KV.store.has(`grp:${other.id}`));
  const del = await call(env, "DELETE", `/account/${g.owner.id}`, { secret: g.owner.secret });
  check("删除账号 → 200", del.status === 200, del.text);
  check("★ 自己建的群的管控状态删掉了", !env.PIGEON_KV.store.has(`grp:${g.id}`));
  check("加入的别人的群，管控状态原样", env.PIGEON_KV.store.has(`grp:${other.id}`));
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
