/**
 * 接入面：文档站 /docs、robots.txt、sitemap.xml、各公开页的 og 与 canonical；文档里的每条 curl 用真的 curl 跑一遍。
 *
 * 直接调 Worker 的 fetch，KV 放内存里，APNs 换成截获请求的假 fetch（见 l1-harness.mjs）—— 推出去的 payload
 * 看得见，所以能断言「推出去的正是想要的」。包由 l1-harness.mjs 自己打，不依赖别的 npm 脚本先跑过。
 * 文件名以 api 开头只是为了让 run-api.sh 顺带跑它；它不用 BASE，不连本地 wrangler dev。
 */
import { execFile } from "node:child_process";
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
  const wanted = ["start", "params", "responses", "adapters", "compat", "heartbeat", "repeat", "e2e", "web", "mcp", "cli", "faq"];
  check("★ 该有的节都在：快速开始、参数、返回码、适配器、兼容、心跳、重复提醒、加密、网页发送、MCP、命令包装器、常见问题", wanted.every((id) => ids.includes(id) && r.text.includes(`id="${id}"`)), ids.join(","));
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
    const words = shellWords(command).slice(1).map((w) => w.replaceAll("https://nfo.im", origin).replaceAll("{key}", acct.key));
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
    check(`★ 照抄就能用：${command.slice(0, 60)}…`, run.code === 0 && status >= 200 && status < 300 && !failed && apns.length > before, `${run.code} ${status} ${run.stderr} ${text.slice(0, 300)}`);
  }
  server.close();
}

finish();
