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

console.log("\n★ 令牌推的按钮：要服务端代发请求的不收");
{
  const rollback = [{ type: "http", label: "回滚", url: "https://ci.example.com/rollback" }];
  const proxied = await call(env, "POST", `/${tok}`, { body: { body: "要回滚吗", actions: rollback } });
  check("★ 令牌推带地址的 http 按钮 → 400，说明只能由创建者定", proxied.status === 400 && proxied.json?.message?.includes("只能由通道的创建者定"), proxied.text);
  const reply = await call(env, "POST", `/${tok}`, { body: { body: "x", actions: "回一句=reply https://bot.example.com/r" } });
  check("令牌推带地址的 reply → 400", reply.status === 400, reply.text);
  const batch = await call(env, "POST", "/push", { body: { device_key: tok, body: "x", actions: rollback } });
  check("/push 批量用令牌推同样拒", batch.status === 400 && JSON.stringify(batch.json).includes("代发"), batch.text);
  const robot = await call(env, "POST", `/cgi-bin/webhook/send?key=${tok}&actions=${encodeURIComponent("回滚=POST https://ci.example.com/r")}`, { body: { msgtype: "text", text: { content: "x" } } });
  check("群机器人兼容地址上拼的也拒", robot.json?.errcode === 400 && robot.json?.errmsg?.includes("代发"), robot.text);
  const fine = await capture(() =>
    call(env, "POST", `/${tok}`, {
      body: { body: "看看", actions: [{ type: "open", label: "看", url: "https://ci.example.com/1" }, { type: "http", label: "收到" }], callback: "https://hooks.example.com/e" },
    }),
  );
  check("★ 打开链接、不带地址的按钮、callback 照收", fine.result.status === 200 && JSON.parse(fine.sent[0]?.payload.actions ?? "[]").length === 2, fine.result.text);
  const byKey = await call(env, "POST", `/${O.key}`, { body: { body: "要回滚吗", actions: rollback } });
  check("用推送 key 推同样的按钮照收", byKey.status === 200, byKey.text);
}

console.log("\n★ 令牌推的消息 id 在令牌自己的地盘里：碰不着别的来源的消息");
{
  // 群主用 key 推一条要重复提醒、带回调的，认领掉（有了认领记录）；另一条不认领、留着提醒
  const own = await call(env, "POST", `/${O.key}`, { body: { title: "主库挂了", id: "db-01", repeat: 5, callback: "https://hooks.example.com/owner" } });
  check("群主用 key 推 db-01（带重复提醒）", own.status === 200 && own.json?.data?.id === "db-01" && own.json?.data?.repeat, own.text);
  const repeatKey = `repeat:${O.channelId}:db-01`;
  check("重复提醒排上了", env.PIGEON_KV.store.has(repeatKey));

  const clash = await capture(() => call(env, "POST", `/${tok}`, { body: { title: "我也叫 db-01", id: "db-01", status: "resolved", callback: "https://evil.example.com/steal" } }));
  const scopedId = clash.result.json?.data?.id;
  check("★ 令牌推同一个 id：响应里的 id 加上了令牌的前缀", typeof scopedId === "string" && /^~[A-Za-z0-9_-]{8}~db-01$/.test(scopedId), clash.result.text);
  check("★ 推出去的 payload 用的也是加过前缀的 id（不会在手机上替换群主那条）", clash.sent[0]?.payload.id === scopedId && clash.sent[0]?.headers["apns-collapse-id"] === scopedId, JSON.stringify(clash.sent[0]?.payload));
  check("★ 群主那条的重复提醒没被令牌的 resolved 停掉", env.PIGEON_KV.store.has(repeatKey));
  check("★ 群主那条的回调地址没被令牌改掉", JSON.parse(env.PIGEON_KV.store.get(`rcpt:${O.channelId}:db-01`) ?? "{}").callback === "https://hooks.example.com/owner");

  await O.as("POST", `/account/${O.id}/channels/${O.channelId}/ack`, { message_id: "db-01" });
  const byKey = await call(env, "GET", `/${O.key}/receipt/db-01`);
  check("用 key 查 db-01：群主认领了", byKey.json?.data?.acked_by === "老王", byKey.text);
  const byToken = await call(env, "GET", `/${tok}/receipt/db-01`);
  check("★ 用令牌查 db-01：查的是令牌自己那条，看不到群主那条是谁认领的", byToken.status === 200 && byToken.json?.data?.acked_by === null, byToken.text);
  const byScoped = await call(env, "GET", `/${tok}/receipt/${encodeURIComponent(scopedId)}`);
  check("令牌拿响应里加过前缀的 id 来查也行（不会叠两层前缀）", byScoped.status === 200 && byScoped.json?.data?.acked_by === null, byScoped.text);
  const keySeesToken = await call(env, "GET", `/${O.key}/receipt/${encodeURIComponent(scopedId)}`);
  check("key 是创建者的：拿加过前缀的 id 查得到令牌那条", keySeesToken.status === 200, keySeesToken.text);

  const retract = await capture(() => call(env, "POST", `/${tok}`, { body: { id: "db-01", delete: 1 } }));
  check("★ 令牌撤回 db-01：撤的是它自己那条", retract.result.json?.data?.id === scopedId && retract.sent.every((a) => a.payload.id === scopedId), retract.result.text);
  const still = await call(env, "GET", `/${O.key}/receipt/db-01`);
  check("★ 群主那条的认领还在（没被令牌的撤回了结）", still.json?.data?.acked_by === "老王", still.text);

  const bare = await call(env, "POST", `/${tok}`, { body: { body: "没给 id" } });
  const generated = bare.json?.data?.id;
  check("没给 id 的：服务端补的 id 也带令牌的前缀", typeof generated === "string" && generated.startsWith(scopedId.slice(0, 10)), bare.text);
  const long = await call(env, "POST", `/${tok}`, { body: { body: "长 id", id: "x".repeat(60) } });
  const longId = long.json?.data?.id ?? "";
  check("★ 加上前缀超过 64 字节的：换成摘要，照样能当 collapse-id", longId.startsWith(scopedId.slice(0, 10)) && longId.length <= 64 && (long.json?.data?.warnings ?? []).length === 0, long.text);
  const longAgain = await call(env, "POST", `/${tok}`, { body: { body: "长 id 又一版", id: "x".repeat(60) } });
  check("同一个长 id 再推，换出来的还是同一个", longAgain.json?.data?.id === longId, longAgain.text);
}

console.log("\n★ Alertmanager：令牌的每分钟条数按条算");
{
  const limited = (await O.as("POST", `/account/${O.id}/channels/${O.channelId}/tokens`, { name: "AM", per_minute: 2 })).json?.data?.value;
  const now = Date.now();
  const alert = (fp) => ({
    status: "firing",
    labels: { alertname: "DiskFull", instance: `node-${fp}:9100` },
    annotations: { summary: `磁盘满了（${fp}）` },
    startsAt: new Date(now - 60_000).toISOString(),
    endsAt: "0001-01-01T00:00:00Z",
    fingerprint: `a${fp}`.padStart(16, "0"),
  });
  const group = { version: "4", status: "firing", receiver: "pigeon", groupKey: '{}:{alertname="DiskFull"}', groupLabels: {}, commonLabels: {}, externalURL: "https://am.example", truncatedAlerts: 0, alerts: [1, 2, 3, 4].map(alert) };
  const { result, sent } = await capture(() => call(env, "POST", `/hook/${limited}/alertmanager`, { body: group }));
  check("★ 令牌每分钟 2 条：一组 4 条只推出 2 条", result.status === 200 && sent.length === 2, `${sent.length} ${result.text}`);
  check("★ warnings 写明是令牌的上限，还有几条没推", (result.json?.data?.warnings ?? []).some((w) => w.includes("「AM」每分钟最多 2 条") && w.includes("还有 2 条没推")), result.text);
  check("推出去的 id 都在令牌的地盘里", sent.every((a) => /^~[A-Za-z0-9_-]{8}~/.test(a.payload.id)), JSON.stringify(sent.map((a) => a.payload.id)));
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
