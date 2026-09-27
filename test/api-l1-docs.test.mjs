/**
 * 接入面：文档站 /docs、robots.txt、sitemap.xml、各公开页的 og 与 canonical；文档里的每条 curl 用真的 curl 跑一遍。
 *
 * 直接调 Worker 的 fetch，KV 放内存里，APNs 换成截获请求的假 fetch（见 l1-harness.mjs）—— 推出去的 payload
 * 看得见，所以能断言「推出去的正是想要的」。包由 l1-harness.mjs 自己打，不依赖别的 npm 脚本先跑过。
 * 文件名以 api 开头只是为了让 run-api.sh 顺带跑它；它不用 BASE，不连本地 wrangler dev。
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import { apns, call, check, finish, load, makeEnv, newAccount } from "./l1-harness.mjs";

const worker = (await load("index")).default;

// ── 文档站、robots.txt、sitemap、og ──────────────────────────────────

console.log("\n★ 文档站 /docs");
{
  const env = makeEnv();
  const { DOC_SECTIONS, renderMarkdown } = await load("docs");
  const r = await call(env, "GET", "/docs");
  check("★ /docs → 200 页面，没有脚本", r.status === 200 && (r.headers.get("content-type") ?? "").startsWith("text/html") && /script-src 'none'/.test(r.headers.get("content-security-policy") ?? "") && !/<script/i.test(r.text));
  const ids = DOC_SECTIONS.map((s) => s.id);
  const wanted = [
    "start", "params", "responses", "tokens", "adapters", "compat", "heartbeat", "watches", "repeat", "actions", "receipts",
    "live", "groups", "e2e", "web", "mcp", "cli", "selftest", "readthrough", "backup", "faq",
  ];
  check("★ 该有的节都在：快速开始、参数、返回码、发送令牌、适配器、兼容、心跳、监控管理、重复提醒、通知按钮、回执与回调、实时活动、群组、加密、网页发送、MCP、命令包装器、通知体检、多设备已读、备份、常见问题", wanted.every((id) => ids.includes(id) && r.text.includes(`id="${id}"`)), wanted.filter((id) => !ids.includes(id)).join(","));
  check("节的 id 不重复", new Set(ids).size === ids.length);
  const anchors = [...r.text.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  check("★ 页内锚点都有着落", anchors.length > 10 && anchors.every((id) => r.text.includes(`id="${id}"`)), anchors.filter((id) => !r.text.includes(`id="${id}"`)).join(","));
  const internal = [...new Set([...r.text.matchAll(/href="(\/[^"#]*)/g)].map((m) => m[1]))];
  const broken = [];
  for (const path of internal) {
    const res = await call(env, "GET", path);
    if (res.status !== 200) broken.push(`${path}:${res.status}`);
  }
  check("★ 站内链接都打得开", internal.length >= 4 && broken.length === 0, broken.join(" "));
  check("{site} 都换成了域名", !r.text.includes("{site}") && r.text.includes("https://nfo.im/{key}"));
  check("canonical 与 og 标签", r.text.includes('<link rel="canonical" href="https://nfo.im/docs">') && r.text.includes('property="og:title"'));
  const jump = await call(env, "GET", "/docs/mcp");
  check("★ /docs/mcp → 301 到 /docs#mcp", jump.status === 301 && jump.headers.get("location") === "https://nfo.im/docs#mcp", `${jump.status} ${jump.headers.get("location")}`);
  check("/docs/不存在 → 404", (await call(env, "GET", "/docs/nope")).status === 404);
  const plainHttp = await worker.fetch(new Request("http://nfo.im/docs"), env, {});
  check("明文 http → 301 到 https", plainHttp.status === 301);

  const md = renderMarkdown('段落 `a<b>` **粗** [链接](https://x.example) [坏](javascript:alert(1))\n\n| a | b |\n|---|---|\n| `x\\|y` | 2 |\n\n- 一\n- 二\n\n~~~\n<script>\n~~~');
  check("★ 渲染器：转义、代码、加粗、链接只放行 http(s)", md.includes("<code>a&lt;b&gt;</code>") && md.includes("<strong>粗</strong>") && md.includes('<a href="https://x.example">链接</a>') && !md.includes("javascript:alert(1)\">"), md);
  check("渲染器：表格（单元格里的 \\| 是竖线）、列表、代码块转义", md.includes("<code>x|y</code>") && md.includes("<li>一</li>") && md.includes("<pre>&lt;script&gt;</pre>"), md);
  const { docsPage } = await load("docs");
  check("主机名转义后输出", !docsPage('evil"><img src=x>').includes('"><img'));
}

console.log("\n★ README 和 /docs 讲的是同一套：参数表里的每个参数、列出的每个接口，/docs 里都讲到了");
{
  const env = makeEnv();
  // 标签换成空格再去转义：表格里相邻两格的文字不粘在一起
  const page = unescapeHtml((await call(env, "GET", "/docs")).text.replace(/<[^>]+>/g, " "));
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const table = readme.slice(readme.indexOf("### 参数"), readme.indexOf("### 写法"));
  const params = [...new Set([...table.matchAll(/^\| `([A-Za-z]+)`/gm)].map((m) => m[1]))];
  check("读出了 README 参数表", params.length >= 20 && params.includes("actions") && params.includes("live"), params.join(","));
  const missingParams = params.filter((p) => !page.includes(p));
  check("★ README 参数表里的每个参数 /docs 里都有", missingParams.length === 0, missingParams.join(","));
  // README 里写成 `METHOD /path` 的接口（去掉占位的写法差异，只比路径的骨架）
  const skeleton = (path) => path.replace(/\{[^}]*\}/g, "{}").replace(/\?.*$/, "");
  const routes = [...new Set([...readme.matchAll(/`(?:GET|POST|PUT|PATCH|DELETE) (\/[^`\s]+)`/g)].map((m) => skeleton(m[1])))];
  const docRoutes = new Set([...page.matchAll(/(\/(?:account|hb|hook|mcp|s|push|tools)[^\s`"'<>）)，。；]*)/g)].map((m) => skeleton(m[1])));
  const missingRoutes = routes.filter((r) => !docRoutes.has(r) && !page.includes(r.replaceAll("{}", "")));
  check("读出了 README 里的接口", routes.length >= 12 && routes.some((r) => r.includes("selftest")) && routes.some((r) => r.includes("activity-start-token")), routes.join(" "));
  check("★ README 列出的接口 /docs 里都讲到了", missingRoutes.length === 0, missingRoutes.join(" "));
  const kv = ["stok:", "oldkey:", "rcpt:", "cbsec:", "amseen:", "selftest:", "la:"];
  const privacy = (await call(env, "GET", "/privacy")).text;
  check("README 的 KV 清单写上了各功能新加的前缀", kv.every((p) => readme.includes(`\`${p}\``)), kv.filter((p) => !readme.includes(`\`${p}\``)).join(","));
  check("隐私政策讲到了各功能新存的东西", ["发送令牌", "换下来的地址", "回调密钥", "回执与回调", "告警分组记录", "实时活动令牌", "通知体检记录", "已读位置", "最低提醒级别"].every((w) => privacy.includes(w)));
}

console.log("\n★ robots.txt、sitemap.xml、各公开页的 og 与 canonical");
{
  const env = makeEnv();
  const robots = await call(env, "GET", "/robots.txt");
  check("★ robots.txt：公开页放行，其余（推送、心跳）一律不许抓", robots.status === 200 && robots.text.includes("Disallow: /") && robots.text.includes("Allow: /docs") && robots.text.includes("Allow: /$") && robots.text.includes("Sitemap: https://nfo.im/sitemap.xml"), robots.text);
  const sitemap = await call(env, "GET", "/sitemap.xml");
  check("★ sitemap.xml 列出公开页", sitemap.status === 200 && (sitemap.headers.get("content-type") ?? "").includes("xml") && ["/", "/docs", "/support", "/privacy", "/terms"].every((p) => sitemap.text.includes(`<loc>https://nfo.im${p}</loc>`)), sitemap.text);
  for (const path of ["/", "/docs", "/support", "/privacy", "/terms"]) {
    const page = await call(env, "GET", path);
    const canonical = `<link rel="canonical" href="https://nfo.im${path}">`;
    check(`${path}：canonical、og:title、og:description、description 各一个`, page.text.includes(canonical) && page.text.split('property="og:title"').length === 2 && page.text.split('property="og:description"').length === 2 && page.text.split('name="description"').length === 2);
  }
  const landing = await call(env, "GET", "/");
  check("★ 落地页链到文档", landing.text.includes('href="/docs"') && landing.text.includes('href="/docs#compat"') && landing.text.includes('href="/docs#mcp"') && landing.text.includes('href="/docs#cli"'));
  check("落地页的适配器列表里有 Alertmanager 和任意 JSON", landing.text.includes("/hook/{key}/alertmanager") && landing.text.includes("/hook/{key}/json"));
  for (const path of ["/support", "/privacy", "/terms"]) check(`${path} 页脚链到文档`, (await call(env, "GET", path)).text.includes('href="/docs"'));
}

// ── 文档里的每条 curl，用真的 curl 跑一遍 ────────────────────────────

/** 按 shell 的规矩把一行命令切成词：单引号、双引号、反斜杠续行 */
function shellWords(line) {
  const words = [];
  let cur = "";
  let quote = null;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && /["\\$`]/.test(line[i + 1] ?? "")) cur += line[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) words.push(cur);
      cur = "";
      started = false;
    } else if (c === "\\") {
      cur += line[++i] ?? "";
      started = true;
    } else {
      cur += c;
      started = true;
    }
  }
  if (quote) throw new Error(`引号没配对：${line}`);
  if (started) words.push(cur);
  return words;
}

function unescapeHtml(text) {
  return text.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

console.log("\n★ 文档里的每条 curl（推送、兼容地址、适配器、MCP），用真的 curl 跑一遍");
{
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
    const response = await worker.fetch(new Request(`https://nfo.im${inbound.url}`, { method: inbound.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined }), env, {});
    res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "text/plain" });
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const page = (await call(env, "GET", "/docs")).text;
  const commands = [];
  for (const m of page.matchAll(/<pre>([\s\S]*?)<\/pre>/g)) {
    for (const line of unescapeHtml(m[1]).split("\n")) if (line.trim().startsWith("curl ")) commands.push(line.trim());
  }
  const runnable = commands.filter((c) => c.includes("{key}") && !/\{id\}|\{通道加密密钥\}/.test(c) && !/\s-(s?O|fsSL)\s/.test(c));
  check("文档里至少有 12 条能直接跑的 curl", runnable.length >= 12, `${runnable.length}/${commands.length}`);
  for (const command of runnable) {
    // 回执查询不推送：不必等长轮询到点，也不要求推出东西
    const receipt = command.includes("/receipt/");
    const words = shellWords(command).slice(1).map((w) => {
      const replaced = w.replaceAll("https://nfo.im", origin).replaceAll("{key}", acct.key);
      return receipt ? replaced.replace(/wait=\d+/, "wait=0") : replaced;
    });
    const before = apns.length;
    const run = await new Promise((resolve) => {
      execFile("curl", ["-sS", "--max-time", "10", "-w", "\n%{http_code}", ...words], (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
    });
    const lines = run.stdout.split("\n");
    const status = Number(lines.pop());
    const text = lines.join("\n");
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* ok、空响应 */
    }
    const failed = json?.result?.isError || (json && "error" in json && json.jsonrpc);
    check(`★ 照抄就能用：${command.slice(0, 60)}…`, run.code === 0 && status >= 200 && status < 300 && !failed && (receipt || apns.length > before), `${run.code} ${status} ${run.stderr} ${text.slice(0, 300)}`);
  }
  server.close();
}

finish();
