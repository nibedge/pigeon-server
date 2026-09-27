/**
 * 发送令牌、换掉的地址、成员发消息（L4）：令牌推出去带 from、按令牌的限制收一收、停用和每分钟上限、
 * /s/{令牌} 网页、换地址后旧地址 410 并提醒创建者、成员在群里发消息带 sender、发消息的人自己静默收下。
 * 看的是推到每台设备上的 payload，所以在进程里跑（见 l4-harness.mjs）：
 *
 *   node test/api-l4-senders.test.mjs
 */
import {
  call,
  capture,
  check,
  finish,
  makeEnv,
  makeGroup,
  newAccount,
  one,
  push,
  worker,
} from "./l4-harness.mjs";

const { runReminders } = push;
const env = makeEnv();
const O = await newAccount(env, "老王");
const M = await newAccount(env, "李四");
const N = await newAccount(env, "张三");
const G = await makeGroup(env, O, [M, N]);
// 张三给这个群设了最低级别时效性：令牌的级别上限和接收方自己的设置叠在一起时，各管各的
await N.as("PATCH", `/account/${N.id}`, { prefs_patch: { minLevel: { [G.id]: "timeSensitive" } } });

// ── 发送令牌 ────────────────────────────────────────────────────────

console.log("\n★ 发送令牌：新建、推送带 from、只能推不能管");
let nas;
{
  const made = await O.as("POST", `/account/${O.id}/channels/${G.id}/tokens`, { name: "NAS" });
  check("新建 → 200", made.status === 200, made.text);
  nas = made.json?.data;
  check("★ 令牌是 st_ 开头、和 key 长得不一样", /^st_[A-Za-z0-9_-]{43}$/.test(nas?.value ?? "") && nas.value.length !== G.key.length, nas?.value);
  check("给出推送地址和网页地址", nas?.push_url === `https://nfo.im/${nas?.value}` && nas?.page_url === `https://nfo.im/s/${nas?.value}`);
  check("视图：名字、末四位、未停用、用量 0", nas?.token?.name === "NAS" && nas.token.hint === nas.value.slice(-4) && nas.token.disabled === false && nas.token.count === 0, JSON.stringify(nas?.token));
  check("★ 服务端不存令牌明文", ![...env.PIGEON_KV.store.entries()].some(([k, v]) => k.includes(nas.value) || v.includes(nas.value)));

  const { result, sent } = await capture(() => call(env, "GET", `/${nas.value}/${encodeURIComponent("备份完成")}`));
  check("★ 用令牌推：受理", result.status === 200 && result.json?.data?.delivered === 3, result.text);
  check("★ payload 带 from = 令牌名", sent.length === 3 && sent.every((a) => a.payload.from === "NAS"), JSON.stringify(sent.map((a) => a.payload.from)));
  check("不带 sender", sent.every((a) => a.payload.sender === undefined));
  const byKey = await capture(() => call(env, "GET", `/${G.key}/${encodeURIComponent("直接用 key")}`));
  check("用 key 推的不带 from", byKey.sent.every((a) => a.payload.from === undefined));
  const spoof = await capture(() => call(env, "POST", `/${G.key}`, { body: { body: "冒充", from: "老板", sender: "老板" } }));
  check("★ from、sender 不是推送参数：发送方冒充不了", spoof.sent.every((a) => a.payload.from === undefined && a.payload.sender === undefined));

  const bearer = await capture(() => call(env, "POST", "/", { body: { body: "根路径" }, headers: { authorization: `Bearer ${nas.value}` } }));
  check("★ Authorization: Bearer 令牌 → 照样推", bearer.result.status === 200 && bearer.sent[0]?.payload.from === "NAS", bearer.result.text);
  const batch = await capture(() => call(env, "POST", "/push", { body: { device_keys: [nas.value, O.key], body: "批量" } }));
  check("★ /push 批量里令牌和 key 混着用", batch.result.status === 200 && batch.result.json?.data?.results?.every((r) => r.delivered > 0), batch.result.text);
  check("批量：令牌那一份带 from，key 那一份不带", batch.sent.filter((a) => a.payload.from === "NAS").length === 3 && batch.sent.filter((a) => a.payload.from === undefined).length === 1);
  const hook = await capture(() => call(env, "POST", `/hook/${nas.value}/uptimekuma`, { body: { heartbeat: { status: 0, msg: "timeout" }, monitor: { name: "路由器" } } }));
  check("★ /hook 适配器也认令牌", hook.result.status === 200 && hook.sent[0]?.payload.from === "NAS", hook.result.text);

  const list = await O.as("GET", `/account/${O.id}/channels/${G.id}/tokens`);
  check("列出令牌", list.status === 200 && list.json?.data?.tokens?.length === 1 && list.json.data.limit === 10, list.text);
  check("列表里没有令牌明文", !list.text.includes(nas.value));
  check("★ 用量记上了（第一条就落盘）", list.json?.data?.tokens?.[0]?.count >= 1 && typeof list.json.data.tokens[0].last_used_at === "number", JSON.stringify(list.json?.data?.tokens?.[0]));

  check("★ 成员管不了令牌 → 403", (await M.as("GET", `/account/${M.id}/channels/${G.id}/tokens`)).status === 403);
  const outsider = await newAccount(env, "路人");
  check("外人 → 404", (await outsider.as("GET", `/account/${outsider.id}/channels/${G.id}/tokens`)).status === 404);
  check("★ 令牌当不了账号凭据", (await call(env, "GET", `/account/${O.id}`, { secret: nas.value })).status === 401);
  const view = (await O.as("GET", `/account/${O.id}`)).json?.data?.channels?.find((c) => c.id === G.id);
  check("通道的 key 没变", view?.key === G.key);
}

console.log("\n★ 令牌的限制：最高级别、不能重复提醒、每分钟上限、停用");
{
  const made = await O.as("POST", `/account/${O.id}/channels/${G.id}/tokens`, { name: "家人网页", max_level: "active" });
  const family = made.json?.data;
  check("新建带 max_level", family?.token?.max_level === "active", made.text);
  const { result, sent } = await capture(() => call(env, "POST", `/${family.value}`, { body: { body: "快回家吃饭", level: "critical", repeat: "5", id: "dinner" } }));
  check("受理", result.status === 200, result.text);
  // 张三（N）设了最低级别时效性，收到「普通」就静默 —— 那是他自己的设置，这里只看另外两个人
  const others = (list) => list.filter((a) => a.device !== N.token);
  check("★ 级别收到「普通」", others(sent).length === 2 && others(sent).every((a) => a.payload.level === "active" && a.payload.aps["interruption-level"] === "active"), JSON.stringify(sent.map((a) => a.payload.level)));
  check("最低级别时效性的人：收到的「普通」静默", one(sent, N)?.level === "passive");
  check("★ 不重复提醒", sent.every((a) => a.payload.repeat === undefined) && result.json?.data?.repeat === undefined);
  const warnings = result.json?.data?.warnings ?? [];
  check("★ warnings 说明两处都照限制改了", warnings.some((w) => w.includes("最高只能发「普通」")) && warnings.some((w) => w.includes("不能要求重复提醒")), JSON.stringify(warnings));
  const header = await capture(() => call(env, "POST", `/${family.value}`, { raw: "急", headers: { priority: "5", "content-type": "text/plain" } }));
  check("Priority: 5 也收到「普通」", others(header.sent).every((a) => a.payload.level === "active") && header.sent.length === 3, JSON.stringify(header.sent.map((a) => a.payload.level)));
  await O.as("PATCH", `/account/${O.id}/channels/${G.id}`, { defaults: { level: "timeSensitive" } });
  const byDefault = await capture(() => call(env, "POST", `/${family.value}`, { body: { body: "通道默认是时效性" } }));
  check("通道默认值里的级别也按令牌的上限收", others(byDefault.sent).every((a) => a.payload.level === "active") && byDefault.sent.length === 3);
  await O.as("PATCH", `/account/${O.id}/channels/${G.id}`, { defaults: {} });

  const loud = await O.as("POST", `/account/${O.id}/channels/${G.id}/tokens`, { name: "值班", max_level: "timeSensitive" });
  const pager = loud.json?.data;
  const rep = await capture(() => call(env, "POST", `/${pager.value}`, { body: { body: "主库挂了", level: "critical", repeat: "5", id: "db" } }));
  check("★ 上限时效性：critical 按时效性送，重复提醒照排", rep.sent.every((a) => a.payload.level === "timeSensitive") && rep.result.json?.data?.repeat?.every === 5, rep.result.text);
  // 令牌推的 id 在令牌自己的地盘里（加了前缀，见 tokens.ts tokenIdScope）：按响应里回的 id 找
  const repId = rep.result.json?.data?.id;
  check("响应里的 id 带着令牌的前缀", typeof repId === "string" && repId.endsWith("~db") && repId.startsWith("~"), String(repId));
  const record = JSON.parse(env.PIGEON_KV.store.get(`repeat:${G.id}:${repId}`) ?? "null");
  check("★ 重复提醒记下 from", record?.from === "值班", JSON.stringify(record));
  const reminded = await capture(() => runReminders(env, Date.now() + 6 * 60_000));
  check("★ 补发的那一次也带「来自：值班」", reminded.sent.length === 3 && reminded.sent.every((a) => a.payload.from === "值班" && a.payload.reminder === "2"), JSON.stringify(reminded.sent.map((a) => a.payload)));
  await call(env, "POST", `/${pager.value}`, { body: { id: "db", status: "resolved", body: "恢复了" } });
  check("同一个令牌带原来的 id 推 resolved：停得下自己的提醒", !env.PIGEON_KV.store.has(`repeat:${G.id}:${repId}`));

  const limitedToken = (await O.as("POST", `/account/${O.id}/channels/${G.id}/tokens`, { name: "脚本", per_minute: 2 })).json?.data;
  env.RL_TOKEN.reset();
  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await call(env, "GET", `/${limitedToken.value}/x${i}`)).status);
  check("★ 每分钟 2 条：前两条受理，第三条 429", statuses.join() === "200,200,429", statuses.join());
  const over = await call(env, "GET", `/${limitedToken.value}/x9`);
  check("429 带 Retry-After 和令牌名", over.status === 429 && over.headers.get("retry-after") === "60" && over.json?.error?.includes("「脚本」每分钟最多 2 条"), over.text);
  check("★ 别的令牌、通道的 key 不受影响", (await call(env, "GET", `/${nas.value}/ok`)).status === 200 && (await call(env, "GET", `/${G.key}/ok`)).status === 200);
  env.RL_TOKEN.reset();

  const off = await O.as("PATCH", `/account/${O.id}/channels/${G.id}/tokens/${family.token.id}`, { disabled: true });
  check("停用 → 200", off.status === 200 && off.json?.data?.token?.disabled === true, off.text);
  const refused = await capture(() => call(env, "GET", `/${family.value}/${encodeURIComponent("还能发吗")}`));
  check("★ 停用的令牌 → 403，说清楚是停用", refused.result.status === 403 && refused.result.json?.message?.includes("已被通道的创建者停用") && refused.sent.length === 0, refused.result.text);
  const batchOff = await call(env, "POST", "/push", { body: { device_key: family.value, body: "x" } });
  check("批量里停用的令牌 → 失败，原因写明", batchOff.status === 400 && batchOff.text.includes("停用"), batchOff.text);
  const on = await O.as("PATCH", `/account/${O.id}/channels/${G.id}/tokens/${family.token.id}`, { disabled: false, name: "家人", max_level: null });
  check("恢复、改名、去掉上限", on.json?.data?.token?.disabled === false && on.json.data.token.name === "家人" && on.json.data.token.max_level === undefined, on.text);
  const back = await capture(() => call(env, "POST", `/${family.value}`, { body: { body: "又能发了", level: "timeSensitive" } }));
  check("恢复之后照常推、按新名字带 from、级别不再收", back.result.status === 200 && back.sent.every((a) => a.payload.from === "家人" && a.payload.level === "timeSensitive"), back.result.text);
}

console.log("\n★ 发送令牌的网页 /s/{令牌}");
{
  await O.as("PATCH", `/account/${O.id}/channels/${G.id}`, { name: "<b>家</b>" });
  const page = await call(env, "GET", `/s/${nas.value}`);
  check("200、HTML", page.status === 200 && (page.headers.get("content-type") ?? "").startsWith("text/html"));
  check("★ 发之前写明发给哪个通道（转义过）", page.text.includes("发给：<strong>&lt;b&gt;家&lt;/b&gt;</strong>") && !page.text.includes("<b>家</b>"), page.text.slice(0, 200));
  check("写明收到的人看到「来自：NAS」", page.text.includes("来自：NAS"));
  check("不缓存", page.headers.get("cache-control") === "no-store");
  check("CSP 只放行这一页的脚本", /script-src 'sha256-[^']+'$|script-src 'sha256-[^' ]+';/.test(page.headers.get("content-security-policy") ?? ""), page.headers.get("content-security-policy"));
  check("页面里没有第二个令牌以外的凭据（没有通道 key）", !page.text.includes(G.key));
  check("级别可选普通、重要", page.text.includes('value="timeSensitive"'));

  const capped = (await O.as("POST", `/account/${O.id}/channels/${G.id}/tokens`, { name: "奶奶", max_level: "active" })).json?.data;
  const cappedPage = await call(env, "GET", `/s/${capped.value}`);
  check("★ 上限是普通的令牌：页面上没有「重要」可选", cappedPage.status === 200 && !cappedPage.text.includes('value="timeSensitive"') && cappedPage.text.includes('data-level="active"'));
  await O.as("PATCH", `/account/${O.id}/channels/${G.id}/tokens/${capped.token.id}`, { disabled: true });
  const disabledPage = await call(env, "GET", `/s/${capped.value}`);
  check("★ 停用的令牌：403 页面说已停用，不给表单、不带脚本", disabledPage.status === 403 && disabledPage.text.includes("已停用") && !disabledPage.text.includes("<form") && !disabledPage.text.includes("<script"));
  check("编出来的令牌 → 404 页面", (await call(env, "GET", `/s/st_${"A".repeat(43)}`)).status === 404);
  check("不像令牌的（推送 key）→ 404，不认 key", (await call(env, "GET", `/s/${G.key}`)).status === 404);
  check("多一段路径 → 404", (await call(env, "GET", `/s/${nas.value}/x`)).status === 404);
  check("POST 这一页 → 405（发送走 /{令牌}）", (await call(env, "POST", `/s/${nas.value}`, { body: {} })).status === 405);
  const http = await worker.fetch(new Request(`http://nfo.im/s/${nas.value}`), env, {});
  check("★ 明文 http 打开 → 400，不跳转（地址里就是凭据）", http.status === 400);
  await O.as("PATCH", `/account/${O.id}/channels/${G.id}`, { name: "家庭群" });
}

// ── 换掉的地址、删掉的令牌 ──────────────────────────────────────────

console.log("\n★ 换地址：旧地址回 410，创建者一天最多收到一次提醒");
{
  const oldKey = G.key;
  const rotated = await O.as("POST", `/account/${O.id}/channels/${G.id}/key`);
  G.key = rotated.json?.data?.key;
  check("换地址 → 新 key", typeof G.key === "string" && G.key !== oldKey);
  const first = await capture(() => call(env, "GET", `/${oldKey}/${encodeURIComponent("旧脚本")}`, { headers: { "user-agent": "curl/8.4.0" } }));
  check("★ 旧地址 → 410「地址已停用：请到 App 里复制新地址」", first.result.status === 410 && first.result.json?.message === "地址已停用：请到 App 里复制新地址", first.result.text);
  const notice = first.sent;
  check("★ 只提醒创建者一个人、静默", notice.length === 1 && notice[0].device === O.token && notice[0].payload.aps["interruption-level"] === "passive", JSON.stringify(notice.map((a) => a.device)));
  check("提醒写明是哪个通道、从哪来", notice[0]?.payload.aps.alert.title === "旧地址还有人在用" && notice[0].payload.aps.alert.body.includes("「家庭群」") && notice[0].payload.aps.alert.body.includes("路径式推送，curl/8.4.0"), JSON.stringify(notice[0]?.payload.aps.alert));
  check("提醒归到这个通道", notice[0]?.payload.channel_id === G.id);
  check("★ 提醒里没有旧地址本身", !JSON.stringify(notice[0]?.payload).includes(oldKey));
  const second = await capture(() => call(env, "GET", `/${oldKey}/x`));
  check("★ 当天再用：照样 410，不再提醒", second.result.status === 410 && second.sent.length === 0);
  const retiredKey = [...env.PIGEON_KV.store.keys()].find((k) => k.startsWith("oldkey:"));
  check("墓碑只存摘要", retiredKey && !retiredKey.includes(oldKey) && /^oldkey:[0-9a-f]{64}$/.test(retiredKey), retiredKey);
  const record = JSON.parse(env.PIGEON_KV.store.get(retiredKey));
  record.noticedAt -= 25 * 3600_000;
  env.PIGEON_KV.store.set(retiredKey, JSON.stringify(record));
  const nextDay = await capture(() => call(env, "POST", `/hook/${oldKey}/github`, { body: {}, headers: { "user-agent": "GitHub-Hookshot/abc" } }));
  check("★ 过了一天再用：再提醒一次", nextDay.result.status === 410 && nextDay.sent.length === 1 && nextDay.sent[0].payload.aps.alert.body.includes("/hook 的 github 适配器，GitHub-Hookshot/abc"), JSON.stringify(nextDay.sent.map((a) => a.payload.aps.alert)));
  const batch = await call(env, "POST", "/push", { body: { device_key: oldKey, body: "x" } });
  check("★ 批量里全是旧地址 → 410", batch.status === 410 && batch.json?.data?.[0]?.error === "地址已停用：请到 App 里复制新地址", batch.text);
  const mixed = await call(env, "POST", "/push", { body: { device_keys: [oldKey, G.key], body: "x" } });
  check("批量里新旧混着：新的照推，旧的逐个报原因", mixed.status === 200 && mixed.json?.data?.results?.find((r) => r.key === oldKey)?.error?.startsWith("地址已停用"), mixed.text);
  check("新地址照常", (await call(env, "GET", `/${G.key}/ok`)).status === 200);
  check("编出来的 key 仍是 404", (await call(env, "GET", `/nosuchkey0001/x`)).status === 404);
}

console.log("\n★ 删掉的令牌：410，创建者收到提醒（写明令牌名）");
{
  const doomed = (await O.as("POST", `/account/${O.id}/channels/${G.id}/tokens`, { name: "旧路由器" })).json?.data;
  const del = await O.as("DELETE", `/account/${O.id}/channels/${G.id}/tokens/${doomed.token.id}`);
  check("删除 → {deleted: id}", del.status === 200 && del.json?.data?.deleted === doomed.token.id, del.text);
  const { result, sent } = await capture(() => call(env, "GET", `/${doomed.value}/x`));
  check("★ 删掉的令牌 → 410，请向创建者要新地址", result.status === 410 && result.json?.message?.includes("请向他要新的地址"), result.text);
  check("★ 提醒写明是哪个令牌", sent.length === 1 && sent[0].payload.aps.alert.title === "删掉的发送令牌还有人在用" && sent[0].payload.aps.alert.body.includes("「旧路由器」"), JSON.stringify(sent.map((a) => a.payload.aps.alert)));
  const page = await call(env, "GET", `/s/${doomed.value}`);
  check("★ 网页：410「已失效」", page.status === 410 && page.text.includes("已失效"));
  const afterPage = await capture(() => call(env, "GET", `/s/${doomed.value}`));
  check("打开网页不算「还在用」，不提醒", afterPage.sent.length === 0);
  check("再删一次 → 404", (await O.as("DELETE", `/account/${O.id}/channels/${G.id}/tokens/${doomed.token.id}`)).status === 404);
  check("列表里没了", !(await O.as("GET", `/account/${O.id}/channels/${G.id}/tokens`)).json?.data?.tokens?.some((t) => t.id === doomed.token.id));
}

// ── 成员发消息 ──────────────────────────────────────────────────────

console.log("\n★ 成员在群里发消息");
{
  const post = (who, body) => capture(() => who.as("POST", `/account/${who.id}/channels/${G.id}/messages`, body));
  const closed = await post(M, { body: "我到家了" });
  check("★ 群主没开：成员 → 403", closed.result.status === 403 && closed.result.json?.message === "群主没有开放成员发消息" && closed.sent.length === 0, closed.result.text);
  const byOwner = await post(O, { body: "晚饭好了" });
  check("★ 群主自己随时能发", byOwner.result.status === 200 && byOwner.result.json?.data?.delivered === 3, byOwner.result.text);
  check("payload 带 sender = 群主名", byOwner.sent.every((a) => a.payload.sender === "老王"));

  const on = await O.as("PATCH", `/account/${O.id}/channels/${G.id}`, { member_send: true });
  check("群主打开「允许成员发消息」", on.status === 200 && on.json?.data?.channels?.find((c) => c.id === G.id)?.member_send === true);
  const memberView = (await M.as("GET", `/account/${M.id}`)).json?.data?.channels?.find((c) => c.id === G.id);
  check("★ 成员看得到这个开关（App 据此显示发消息的入口）", memberView?.member_send === true && memberView.key === undefined);
  check("★ 成员改不了这个开关 → 403", (await M.as("PATCH", `/account/${M.id}/channels/${G.id}`, { member_send: false })).status === 403);

  const said = await post(M, { body: "我到家了", level: "timeSensitive" });
  check("★ 成员发 → 200", said.result.status === 200 && typeof said.result.json?.data?.id === "string", said.result.text);
  check("★ payload 带 sender = 李四", said.sent.length === 3 && said.sent.every((a) => a.payload.sender === "李四"));
  check("★ 没写标题：标题是发消息的人（旧版 App 也看得出是谁）", said.sent.every((a) => a.payload.aps.alert.title === "李四" && a.payload.aps.alert.body === "我到家了"));
  check("★ 发消息的人自己：静默收下", one(said.sent, M)?.aps["interruption-level"] === "passive");
  check("别人：按他选的级别", one(said.sent, O)?.aps["interruption-level"] === "time-sensitive");
  check("群里的消息照样带「我来处理」", one(said.sent, O)?.aps.category === "pigeonNotification.group");
  const titled = await post(N, { title: "买菜", body: "要葱吗" });
  check("写了标题就用他的标题", titled.sent.every((a) => a.payload.aps.alert.title === "买菜" && a.payload.sender === "张三"));
  const twice = await post(N, { title: "买菜", body: "要葱吗" });
  check("★ 同一句话再发一次不会被当成重复压掉", twice.result.status === 200 && twice.result.json?.data?.suppressed === undefined && twice.sent.length === 3);

  check("★ critical → 400", (await post(M, { body: "x", level: "critical" })).result.status === 400);
  check("认不出的级别 → 400", (await post(M, { body: "x", level: "loud" })).result.status === 400);
  check("没有内容 → 400", (await post(M, { title: "  " })).result.status === 400);
  const spam = await post(M, { body: "加我 裸 聊" });
  check("★ 群里的违禁词过滤照样管", spam.result.status === 400 && spam.sent.length === 0, spam.result.text);
  const extra = await post(M, { body: "带链接", url: "https://example.com", repeat: "5", image: "https://example.com/a.png" });
  check("★ 只收标题、正文、级别：链接、重复提醒、图片不带", extra.sent.every((a) => a.payload.url === undefined && a.payload.repeat === undefined && a.payload.image === undefined));
  await O.as("PATCH", `/account/${O.id}/channels/${G.id}`, { defaults: { repeat: "5", url: "https://example.com/x" } });
  const noDefaults = await post(M, { body: "默认值不垫底" });
  check("★ 通道默认值不套到人发的消息上", noDefaults.sent.every((a) => a.payload.repeat === undefined && a.payload.url === undefined), JSON.stringify(noDefaults.sent[0]?.payload));
  await O.as("PATCH", `/account/${O.id}/channels/${G.id}`, { defaults: {} });

  const outsider = await newAccount(env, "外人");
  check("外人 → 404", (await post(outsider, { body: "x" })).result.status === 404);

  await O.as("PATCH", `/account/${O.id}/channels/${G.id}`, { policy: { e2eOnly: true } });
  check("只收加密的群：明文 → 400", (await post(M, { body: "明文" })).result.status === 400);
  const sealed = await post(M, { ciphertext: "Y2lwaGVydGV4dA==", iv: "aXZpdml2aXZpdml2" });
  check("★ 只收加密的群：带密文 → 200，不补明文标题（系统照常显示「加密消息」）", sealed.result.status === 200 && sealed.sent.every((a) => a.payload.ciphertext && a.payload.aps.alert.body.includes("加密") && a.payload.sender === "李四"), sealed.result.text);
  check("密文格式不对 → 400", (await post(M, { ciphertext: "x", iv: "<bad>" })).result.status === 400);
  await O.as("PATCH", `/account/${O.id}/channels/${G.id}`, { policy: null });

  env.RL_ACCOUNT.reset();
  let last;
  for (let i = 0; i < 21; i++) last = await M.as("POST", `/account/${M.id}/channels/${G.id}/messages`, { body: `第 ${i} 条` });
  check("★ 每人每分钟 20 条，第 21 条 429", last.status === 429 && last.headers.get("retry-after") === "60", last.text);
  env.RL_ACCOUNT.reset();

  await O.as("PATCH", `/account/${O.id}/channels/${G.id}`, { member_send: false });
  check("关掉之后成员又 → 403", (await post(M, { body: "x" })).result.status === 403);
}


console.log("\n★ 删通道清掉令牌、用量、清单和墓碑");
{
  const tokenKeys = () => [...env.PIGEON_KV.store.keys()].filter((k) => k.startsWith("stok:") || k.startsWith("oldkey:"));
  check("删之前：令牌、清单、墓碑都在（前置）", tokenKeys().some((k) => k.startsWith("stok:ch:")) && tokenKeys().some((k) => k.startsWith("oldkey:")));
  const deleted = await O.as("DELETE", `/account/${O.id}/channels/${G.id}`);
  check("删通道", deleted.status === 200 && deleted.json?.data?.deleted === true, deleted.text);
  check("★ 令牌、用量、清单、换下来的地址的墓碑一把不剩", tokenKeys().length === 0, tokenKeys().join(" "));
  check("令牌推不进来了 → 404", (await call(env, "GET", `/${nas.value}/x`)).status === 404);
}

finish();
