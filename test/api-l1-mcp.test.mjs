/**
 * 接入面：MCP 入口 /mcp/{key} —— 上一代（initialize 握手）与新一代（每个请求自带版本）两种客户端。
 *
 * 直接调 Worker 的 fetch，KV 放内存里，APNs 换成截获请求的假 fetch（见 l1-harness.mjs）—— 推出去的 payload
 * 看得见，所以能断言「推出去的正是想要的」。包由 l1-harness.mjs 自己打，不依赖别的 npm 脚本先跑过。
 * 文件名以 api 开头只是为了让 run-api.sh 顺带跑它；它不用 BASE，不连本地 wrangler dev。
 */
import { apns, call, check, finish, lastPush, load, makeEnv, newAccount } from "./l1-harness.mjs";

const worker = (await load("index")).default;

// ── MCP ──────────────────────────────────────────────────────────────

console.log("\n★ MCP：上一代客户端（initialize 握手）");
{
  const env = makeEnv();
  const a = await newAccount(env);
  const rpc = (body, headers = {}, path = `/mcp/${a.key}`) =>
    call(env, "POST", path, { json: body, headers: { accept: "application/json, text/event-stream", ...headers } });

  let r = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  check("★ initialize → 回同一个协议版本、tools 能力、serverInfo、使用说明", r.status === 200 && r.json?.result?.protocolVersion === "2025-06-18" && r.json.result.capabilities?.tools && r.json.result.serverInfo?.name === "pigeon" && r.json.result.instructions.includes("notify"), r.text);
  check("★ 不发会话 id", r.headers.get("mcp-session-id") === null);
  check("回的是 application/json", (r.headers.get("content-type") ?? "").startsWith("application/json"));
  r = await rpc({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2099-01-01", capabilities: {} } });
  check("不认得的版本：回支持的最新一版", r.json?.result?.protocolVersion === "2025-11-25", r.text);
  r = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  check("★ 通知 → 202 空响应", r.status === 202 && r.text === "");
  r = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { "mcp-protocol-version": "2025-06-18" });
  const tool = r.json?.result?.tools?.[0];
  check("★ tools/list：只有 notify，参数是 title body level url id status repeat", r.json?.result?.tools?.length === 1 && tool?.name === "notify" && Object.keys(tool.inputSchema.properties).join(",") === "title,body,level,url,id,status,repeat", r.text);
  check("tools/list 的描述里说明内容是明文", tool?.description.includes("明文"));
  r = await rpc({ jsonrpc: "2.0", id: 4, method: "ping" });
  check("ping → {}", JSON.stringify(r.json?.result) === "{}", r.text);

  const before = apns.length;
  r = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "notify", arguments: { title: "任务完成", body: "测试全过", level: "timeSensitive", id: "job-1", url: "https://ci.example/1" } } }, { "mcp-protocol-version": "2025-11-25" });
  const p = lastPush();
  check("★ tools/call notify → 走正常投递推出去", apns.length === before + 1 && p.alert.title === "任务完成" && p.alert.body === "测试全过" && p.level === "time-sensitive" && p.sent.id === "job-1" && p.sent.url === "https://ci.example/1", JSON.stringify(p));
  check("★ 结果里有给 AI 看的文字和结构化数据", r.json?.result?.content?.[0]?.text.includes("已推送") && r.json.result.structuredContent?.id === "job-1" && r.json.result.structuredContent.delivered === 1 && r.json.result.isError === undefined, r.text);
  r = await rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "notify", arguments: { title: "t", repeat: 5, id: "job-2" } } });
  check("repeat：排上重复提醒，结果里说明", r.json?.result?.structuredContent?.repeat?.every === 5 && r.json.result.content[0].text.includes("每 5 分钟"), r.text);
  r = await rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "notify", arguments: { title: "t", id: "job-2", status: "resolved" } } });
  check("status=resolved 停下重复提醒", ![...env.PIGEON_KV.store.keys()].some((k) => k.startsWith("repeat:") && k.endsWith(":job-2")), r.text);

  r = await rpc({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "notify", arguments: { level: "loud" } } });
  check("★ 参数不对 → 工具执行错误（isError），中文原因让 AI 自己改", r.status === 200 && r.json?.result?.isError === true && r.json.result.content[0].text.includes("至少给一个"), r.text);
  r = await rpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "notify", arguments: { title: "t", level: "loud" } } });
  check("level 取值不对 → isError", r.json?.result?.isError === true && r.json.result.content[0].text.includes("level"), r.text);
  r = await rpc({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "notify", arguments: { title: "t", sound: "x" } } });
  check("多给了不认识的参数 → isError", r.json?.result?.isError === true && r.json.result.content[0].text.includes("sound"), r.text);
  r = await rpc({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "delete_everything", arguments: {} } });
  check("★ 不存在的工具 → JSON-RPC 错误 -32602", r.json?.error?.code === -32602, r.text);
  r = await rpc({ jsonrpc: "2.0", id: 12, method: "resources/list" });
  check("不认得的方法 → -32601", r.json?.error?.code === -32601, r.text);
  r = await rpc({ jsonrpc: "2.0", id: 13, method: "tools/list" }, { "mcp-protocol-version": "1999-01-01" });
  check("MCP-Protocol-Version 头不认得 → 400", r.status === 400, r.text);
  r = await rpc({ jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "notify", arguments: { title: "t" } } }, {}, "/mcp/nosuchkey000");
  check("★ key 不存在 → 404 + JSON-RPC 错误，中文原因", r.status === 404 && r.json?.error?.message.includes("key 不存在") && r.json.id === 14, r.text);
  r = await rpc({ jsonrpc: "2.0", id: 15, method: "tools/list" }, { authorization: `Bearer ${a.key}` }, "/mcp");
  check("★ /mcp + Authorization: Bearer {key} 也行", r.json?.result?.tools?.[0]?.name === "notify", r.text);
  r = await rpc({ jsonrpc: "2.0", id: 16, method: "tools/list" }, {}, "/mcp");
  check("/mcp 没带 key → 400 说明地址该怎么写", r.status === 400 && r.json?.error?.message.includes("/mcp/{key}"), r.text);
  r = await call(env, "GET", `/mcp/${a.key}`);
  check("★ GET → 405，说明该怎么配", r.status === 405 && r.headers.get("allow")?.includes("POST") && r.json?.message.includes("Streamable HTTP"), r.text);
  r = await call(env, "POST", `/mcp/${a.key}`, { raw: "{bad", headers: { "content-type": "application/json" } });
  check("写坏的 JSON → 400 -32700", r.status === 400 && r.json?.error?.code === -32700, r.text);
  r = await rpc([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
  check("批量请求 → 400", r.status === 400 && r.json?.error?.code === -32600, r.text);
  r = await rpc({ jsonrpc: "2.0", id: 17, result: {} });
  check("客户端发来的响应 → 202", r.status === 202);
  const pre = await worker.fetch(new Request(`https://nfo.im/mcp/${a.key}`, { method: "OPTIONS", headers: { origin: "https://app.example", "access-control-request-headers": "mcp-protocol-version, mcp-method, mcp-name" } }), env, {});
  check("★ 浏览器预检：放行 MCP 的几个头", pre.status === 204 && ["mcp-protocol-version", "mcp-method", "mcp-name"].every((h) => pre.headers.get("access-control-allow-headers").includes(h)));

  const e2e = makeEnv();
  const b = await newAccount(e2e);
  await call(e2e, "PATCH", `/account/${b.id}/channels/${b.channelId}`, { secret: b.secret, json: { policy: { e2eOnly: true } } });
  r = await call(e2e, "POST", `/mcp/${b.key}`, { json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "notify", arguments: { title: "明文" } } } });
  check("★ 只收加密的通道：isError，说明 MCP 是明文", r.json?.result?.isError === true && r.json.result.content[0].text.includes("明文"), r.text);
}

console.log("\n★ MCP：新一代客户端（每个请求自带版本）");
{
  const env = makeEnv();
  const a = await newAccount(env);
  const V = "2026-07-28";
  const meta = { "io.modelcontextprotocol/protocolVersion": V, "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" } };
  const modern = (method, params = {}, headers = {}) =>
    call(env, "POST", `/mcp/${a.key}`, {
      json: { jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: params._meta ?? meta } },
      headers: { accept: "application/json, text/event-stream", "mcp-protocol-version": V, "mcp-method": method, ...(method === "tools/call" ? { "mcp-name": params.name } : {}), ...headers },
    });
  let r = await modern("server/discover");
  check("★ server/discover：支持的版本、能力、说明、缓存提示、resultType", r.status === 200 && r.json?.result?.resultType === "complete" && r.json.result.supportedVersions.includes(V) && r.json.result.supportedVersions.includes("2025-11-25") && r.json.result.capabilities.tools && typeof r.json.result.ttlMs === "number" && r.json.result.cacheScope === "public", r.text);
  check("结果的 _meta 里带 serverInfo", r.json?.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name === "pigeon", r.text);
  r = await modern("tools/list");
  check("★ tools/list：resultType、ttlMs、cacheScope", r.json?.result?.resultType === "complete" && r.json.result.tools[0].name === "notify" && r.json.result.ttlMs > 0 && r.json.result.cacheScope === "public", r.text);
  const before = apns.length;
  r = await modern("tools/call", { name: "notify", arguments: { title: "新一代", body: "推送" } });
  check("★ tools/call → 推出去，resultType complete", apns.length === before + 1 && lastPush().alert.title === "新一代" && r.json?.result?.resultType === "complete", r.text);
  r = await modern("tools/call", { name: "notify", arguments: { title: "x" } }, { "mcp-name": `=?base64?${Buffer.from("notify").toString("base64")}?=` });
  check("Mcp-Name 用 base64 写法也认", r.json?.result?.resultType === "complete", r.text);
  r = await modern("tools/call", { name: "notify", arguments: { title: "x" } }, { "mcp-name": "other" });
  check("★ Mcp-Name 和请求体对不上 → 400 -32020", r.status === 400 && r.json?.error?.code === -32020, r.text);
  r = await modern("tools/list", {}, { "mcp-method": "tools/call" });
  check("★ Mcp-Method 对不上 → 400 -32020", r.status === 400 && r.json?.error?.code === -32020, r.text);
  r = await modern("tools/list", {}, { "mcp-protocol-version": "2025-11-25" });
  check("★ MCP-Protocol-Version 头和 _meta 不一致 → 400 -32020", r.status === 400 && r.json?.error?.code === -32020, r.text);
  r = await modern("tools/list", { _meta: { ...meta, "io.modelcontextprotocol/protocolVersion": "2030-01-01" } }, { "mcp-protocol-version": "2030-01-01" });
  check("★ 不支持的版本 → 400 -32022，列出支持的", r.status === 400 && r.json?.error?.code === -32022 && r.json.error.data.supported.includes(V) && r.json.error.data.requested === "2030-01-01", r.text);
  r = await modern("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": V } });
  check("★ 缺 clientCapabilities → 400 -32602", r.status === 400 && r.json?.error?.code === -32602, r.text);
  r = await modern("prompts/list");
  check("★ 不认得的方法 → 404 -32601", r.status === 404 && r.json?.error?.code === -32601, r.text);
  r = await call(env, "POST", `/mcp/${a.key}`, { json: { jsonrpc: "2.0", id: 1, method: "tools/list" }, headers: { "mcp-protocol-version": V } });
  check("头说新一代、请求体没带 _meta → 400 -32602", r.status === 400 && r.json?.error?.code === -32602, r.text);
}

finish();
