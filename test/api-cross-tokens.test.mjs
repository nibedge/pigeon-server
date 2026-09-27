/**
 * 几条功能线合起来之后的衔接：发送令牌（L4）在接入面（L1）的每个入口、回执（L2）上都能用 ——
 * 群机器人格式的 /{令牌} 和兼容地址、MCP、Alertmanager 适配器、GET /{令牌}/receipt/{id}。
 * 令牌推的都带 from、按令牌的级别上限收；停用的回 403、删掉的回 410，都按各入口自己的回话格式。
 * 在进程里跑（见 l4-harness.mjs）：
 *
 *   node test/api-cross-tokens.test.mjs
 */
import { apns, call, capture, check, finish, makeEnv, newAccount } from "./l4-harness.mjs";

const env = makeEnv();
const O = await newAccount(env, "老王");
const made = (await O.as("POST", `/account/${O.id}/channels/${O.channelId}/tokens`, { name: "CI", max_level: "active" })).json?.data;
const tok = made?.value;
check("新建令牌", /^st_/.test(tok ?? ""), JSON.stringify(made));

console.log("\n★ 群机器人格式：/{令牌} 的请求体和兼容地址");
{
  const body = { msgtype: "text", text: { content: "构建失败了", mentioned_list: ["@all"] } };
  const direct = await capture(() => call(env, "POST", `/${tok}`, { body }));
  check("/{令牌} 收 msgtype 请求体 → errcode 0", direct.result.status === 200 && direct.result.json?.errcode === 0, direct.result.text);
  const p = direct.sent[0]?.payload;
  check("★ 带 from = 令牌名", p?.from === "CI", JSON.stringify(p));
  check("★ @所有人升的时效性也按令牌上限收成「普通」", p?.level === "active" && p?.aps?.["interruption-level"] === "active", JSON.stringify(p));
  check("warnings 写明按令牌上限送", (direct.result.json?.warnings ?? []).some((w) => w.includes("最高只能发")), direct.result.text);

  const mirror = await capture(() => call(env, "POST", `/cgi-bin/webhook/send?key=${tok}`, { body: { msgtype: "markdown", markdown: { content: "**部署**完成" } } }));
  check("★ 兼容地址 ?key={令牌}", mirror.result.status === 200 && mirror.result.json?.errcode === 0 && mirror.sent[0]?.payload.from === "CI", mirror.result.text);
  const card = await capture(() => call(env, "POST", `/open-apis/bot/v2/hook/${tok}`, { body: { msg_type: "text", content: { text: "卡片" } } }));
  check("★ msg_type 兼容地址 /open-apis/bot/v2/hook/{令牌}", card.result.json?.code === 0 && card.sent[0]?.payload.from === "CI", card.result.text);
  const embeds = await capture(() => call(env, "POST", `/api/webhooks/0/${tok}`, { body: { embeds: [{ title: "磁盘", description: "满了" }] } }));
  check("★ embeds 兼容地址", embeds.result.status === 204 && embeds.sent[0]?.payload.from === "CI", `${embeds.result.status} ${embeds.result.text}`);
}

console.log("\n★ MCP：/mcp/{令牌} 和 Bearer 令牌");
{
  const rpc = (body, path = `/mcp/${tok}`, headers = {}) =>
    call(env, "POST", path, { body, headers: { accept: "application/json, text/event-stream", ...headers } });
  const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  check("initialize → 200", init.status === 200 && init.json?.result?.protocolVersion === "2025-11-25", init.text);
  const { result, sent } = await capture(() =>
    rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "notify", arguments: { title: "任务完成", level: "timeSensitive" } } }),
  );
  check("★ tools/call 用令牌推出去", result.status === 200 && result.json?.result?.isError !== true && sent.length === 1, result.text);
  check("★ 带 from、级别按令牌上限收成「普通」", sent[0]?.payload.from === "CI" && sent[0]?.payload.level === "active", JSON.stringify(sent[0]?.payload));
  check("结果里写明按令牌上限送", (result.json?.result?.structuredContent?.warnings ?? []).some((w) => w.includes("最高只能发")), result.text);
  const bearer = await capture(() =>
    rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "notify", arguments: { body: "Bearer" } } }, "/mcp", { authorization: `Bearer ${tok}` }),
  );
  check("★ POST /mcp + Bearer 令牌", bearer.sent[0]?.payload.from === "CI", bearer.result.text);
}

console.log("\n★ Alertmanager 适配器：/hook/{令牌}/alertmanager");
{
  const now = Date.now();
  const alert = (fp) => ({
    status: "firing",
    labels: { alertname: "HighCPU", instance: `db-${fp}:9100`, severity: "critical" },
    annotations: { summary: `CPU 过高（${fp}）` },
    startsAt: new Date(now - 60_000).toISOString(),
    endsAt: "0001-01-01T00:00:00Z",
    fingerprint: `${fp}`.padStart(16, "0"),
  });
  const group = { version: "4", status: "firing", receiver: "pigeon", groupKey: '{}:{alertname="HighCPU"}', groupLabels: {}, commonLabels: {}, externalURL: "https://am.example", truncatedAlerts: 0, alerts: [alert(1), alert(2)] };
  const { result, sent } = await capture(() => call(env, "POST", `/hook/${tok}/alertmanager`, { body: group }));
  check("受理两条", result.status === 200 && sent.length === 2, result.text);
  check("★ 每条都带 from", sent.every((a) => a.payload.from === "CI"), JSON.stringify(sent.map((a) => a.payload.from)));
  check("★ critical 按令牌上限收成「普通」", sent.every((a) => a.payload.level === "active"), JSON.stringify(sent.map((a) => a.payload.level)));
  check("warnings 写明（只一次）", (result.json?.data?.warnings ?? []).filter((w) => w.includes("最高只能发")).length === 1, result.text);
}

console.log("\n★ 回执：GET /{令牌}/receipt/{id}");
{
  await call(env, "POST", `/${tok}`, { body: { body: "要回执", id: "job-9", actions: [{ type: "open", label: "看", url: "https://ci.example.com/9" }] } });
  const r = await call(env, "GET", `/${tok}/receipt/job-9`);
  check("★ 令牌查得到回执", r.status === 200 && "acked_by" in (r.json?.data ?? {}), r.text);
}

console.log("\n★ 停用、删除之后");
{
  const tid = made.token.id;
  await O.as("PATCH", `/account/${O.id}/channels/${O.channelId}/tokens/${tid}`, { disabled: true });
  const robot = await call(env, "POST", `/cgi-bin/webhook/send?key=${tok}`, { body: { msgtype: "text", text: { content: "x" } } });
  check("★ 兼容地址：停用 → 403，msgtype 的回话形状", robot.status === 403 && robot.json?.errcode === 403 && robot.json?.errmsg?.includes("停用"), robot.text);
  const mcp = await call(env, "POST", `/mcp/${tok}`, { body: { jsonrpc: "2.0", id: 1, method: "tools/list" }, headers: { accept: "application/json, text/event-stream" } });
  check("★ MCP：停用 → 403，JSON-RPC 错误", mcp.status === 403 && mcp.json?.error?.code === -403, mcp.text);
  const receipt = await call(env, "GET", `/${tok}/receipt/job-9`);
  check("回执：停用 → 403", receipt.status === 403, receipt.text);

  await O.as("DELETE", `/account/${O.id}/channels/${O.channelId}/tokens/${tid}`);
  const before = apns.length;
  const gone = await call(env, "POST", `/open-apis/bot/v2/hook/${tok}`, { body: { msg_type: "text", content: { text: "x" } } });
  check("★ 兼容地址：删掉的令牌 → 410，msg_type 的回话形状", gone.status === 410 && gone.json?.code === 410 && gone.json?.msg?.includes("地址已停用"), gone.text);
  const mcpGone = await call(env, "POST", `/mcp/${tok}`, { body: { jsonrpc: "2.0", id: 1, method: "tools/list" }, headers: { accept: "application/json, text/event-stream" } });
  check("★ MCP：删掉的令牌 → 410", mcpGone.status === 410 && mcpGone.json?.error?.code === -410, mcpGone.text);
  const rcpt = await call(env, "GET", `/${tok}/receipt/job-9`);
  check("★ 回执：删掉的令牌 → 410", rcpt.status === 410, rcpt.text);
  const am = await call(env, "POST", `/hook/${tok}/alertmanager`, { body: { alerts: [] } });
  check("Alertmanager：删掉的令牌 → 410", am.status === 410, am.text);
  // 创建者收到的「旧地址还有人在用」一天最多一条，不算推给他的内容
  check("删掉的令牌推不出东西（除了给创建者的提醒）", apns.slice(before).every((a) => a.payload.aps?.["interruption-level"] === "passive"));
}

finish();
