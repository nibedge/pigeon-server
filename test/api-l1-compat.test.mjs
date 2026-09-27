/**
 * 接入面：群机器人格式（/{key} 与兼容地址）、国内推送服务的参数写法、通用 JSON 兜底与 /hook/{key}/json。
 *
 * 直接调 Worker 的 fetch，KV 放内存里，APNs 换成截获请求的假 fetch（见 l1-harness.mjs）—— 推出去的 payload
 * 看得见，所以能断言「推出去的正是想要的」。包由 l1-harness.mjs 自己打，不依赖别的 npm 脚本先跑过。
 * 文件名以 api 开头只是为了让 run-api.sh 顺带跑它；它不用 BASE，不连本地 wrangler dev。
 */
import { apns, call, check, finish, lastPush, load, makeEnv, newAccount } from "./l1-harness.mjs";

const worker = (await load("index")).default;

// ── 群机器人格式：/{key} ─────────────────────────────────────────────

console.log("\n★ 群机器人格式推到 /{key}：按结构读、按原来那一家的样子回话");
{
  const env = makeEnv();
  const a = await newAccount(env);

  let r = await call(env, "POST", `/${a.key}`, {
    json: { msgtype: "text", text: { content: "服务器 CPU 告警\n主机：db-1\n使用率 95%", mentioned_list: ["@all"] } },
  });
  let p = lastPush();
  check("★ msgtype text：第一行当标题、其余当正文", p.alert.title === "服务器 CPU 告警" && p.alert.body === "主机：db-1\n使用率 95%", JSON.stringify(p.alert));
  check("★ @all → 时效性", p.level === "time-sensitive", p.level);
  check("★ 成功回 {errcode:0, errmsg:'ok'}，HTTP 200", r.status === 200 && r.json?.errcode === 0 && r.json?.errmsg === "ok", r.text);
  check("顺带回消息 id（不影响对方判断）", typeof r.json?.id === "string" && r.json.id === p.sent.id, r.text);

  r = await call(env, "POST", `/${a.key}`, {
    json: {
      msgtype: "markdown",
      markdown: { title: "[🔴 Down] 官网", text: "## [🔴 Down] 官网 \n> timeout\n> <font color=\"warning\">超时</font>" },
      at: { isAtAll: false },
    },
  });
  p = lastPush();
  check("★ msgtype markdown：title 当标题，正文里重复的标题行、引用号、<font> 去掉", p.alert.title === "[🔴 Down] 官网" && p.alert.body === "timeout\n超时", JSON.stringify(p.alert));
  check("原样的 Markdown 放在 markdown 字段（App 以后按块渲染用）", typeof p.sent.markdown === "string" && p.sent.markdown.includes("> timeout"), JSON.stringify(p.sent.markdown));
  check("没 @ 所有人：不升级", p.level === undefined, p.level);
  check("markdown 是我们自己放的，不列进 ignored", !r.text.includes("ignored"), r.text);

  r = await call(env, "POST", `/${a.key}`, {
    json: { msgtype: "link", link: { title: "新文章", text: "摘要", messageUrl: "weird://client/page/link?url=https%3A%2F%2Fexample.com%2Fa&pc_slide=false", picUrl: "https://img.example/y.png" } },
  });
  p = lastPush();
  check("★ link：客户端内打开的包装拆掉，点开是真地址", p.sent.url === "https://example.com/a", p.sent.url);
  check("link 的图片当大图", p.sent.image === "https://img.example/y.png");

  await call(env, "POST", `/${a.key}`, {
    json: { msgtype: "news", news: { articles: [{ title: "A", description: "a 的摘要", url: "https://a.example", picurl: "https://a.example/a.png" }, { title: "B" }, { title: "C" }] } },
  });
  p = lastPush();
  check("★ news：第一条展开，其余列标题", p.alert.title === "A" && p.alert.body.includes("a 的摘要") && p.alert.body.includes("另 2 条") && p.alert.body.includes("• B"), JSON.stringify(p.alert));

  await call(env, "POST", `/${a.key}`, {
    json: { msgtype: "template_card", template_card: { main_title: { title: "审批", desc: "请处理" }, horizontal_content_list: [{ keyname: "申请人", value: "张三" }], card_action: { type: 1, url: "https://work.example" } } },
  });
  p = lastPush();
  check("template_card：主标题、副标题、键值、点击链接", p.alert.title === "审批" && p.alert.subtitle === "请处理" && p.alert.body.includes("申请人：张三") && p.sent.url === "https://work.example", JSON.stringify(p));

  r = await call(env, "POST", `/${a.key}`, { json: { msg_type: "text", content: { text: '<at user_id="all">所有人</at> 发版了' }, timestamp: "1", sign: "x" } });
  p = lastPush();
  check("★ msg_type text：<at user_id=all> → @所有人、时效性", p.alert.body === "@所有人 发版了" && p.level === "time-sensitive", JSON.stringify(p));
  check("★ 成功回 {code:0, msg:'success'}（还有 StatusCode:0）", r.status === 200 && r.json?.code === 0 && r.json?.msg === "success" && r.json?.StatusCode === 0, r.text);

  await call(env, "POST", `/${a.key}`, {
    json: { msg_type: "post", content: { post: { zh_cn: { title: "项目更新", content: [[{ tag: "text", text: "有更新：" }, { tag: "a", text: "请查看", href: "https://www.example.com/" }]] } } } },
  });
  p = lastPush();
  check("msg_type post：标题、链接写成 Markdown、第一个链接当点击链接", p.alert.title === "项目更新" && p.alert.body === "有更新：[请查看](https://www.example.com/)" && p.sent.url === "https://www.example.com/", JSON.stringify(p));

  await call(env, "POST", `/${a.key}`, {
    json: { msg_type: "interactive", card: { header: { title: { tag: "plain_text", content: "告警" }, template: "red" }, elements: [{ tag: "div", text: { tag: "plain_text", content: "CPU 95%" } }, { tag: "action", actions: [{ tag: "button", text: { content: "看看" }, url: "https://grafana.example/x" }] }] } },
  });
  p = lastPush();
  check("★ msg_type interactive：卡片标题、正文、按钮链接", p.alert.title === "告警" && p.alert.body === "CPU 95%" && p.sent.url === "https://grafana.example/x", JSON.stringify(p));
  check("卡片颜色不决定级别（只有 @所有人 才升级）", p.level === undefined);

  await call(env, "POST", `/${a.key}`, {
    json: { msg_type: "interactive", card: JSON.stringify({ schema: "2.0", header: { title: { content: "卡片 2.0" } }, body: { elements: [{ tag: "markdown", content: "**正文** <at id=all></at>" }] } }) },
  });
  p = lastPush();
  check("interactive 卡片 2.0、card 是字符串：照样读", p.alert.title === "卡片 2.0" && p.alert.body === "**正文** @所有人" && p.level === "time-sensitive", JSON.stringify(p));

  r = await call(env, "POST", `/${a.key}`, {
    json: { username: "监控", content: "@everyone", embeds: [{ title: "❌ 官网 掉线", color: 16711680, fields: [{ name: "Service Name", value: "官网" }, { name: "Error", value: "timeout" }] }] },
  });
  p = lastPush();
  check("★ embeds：标题、字段写成「名：值」", p.alert.title === "❌ 官网 掉线" && p.alert.body.includes("Service Name：官网") && p.alert.body.includes("Error：timeout"), JSON.stringify(p.alert));
  check("★ @everyone → 时效性", p.level === "time-sensitive");
  check("★ 成功回 204 空响应", r.status === 204 && r.text === "", `${r.status} ${r.text}`);
  r = await call(env, "POST", `/${a.key}?wait=true`, { json: { embeds: [{ description: "v2.3", url: "https://ci.example", image: { url: "https://img.example/x.png" } }] } });
  check("★ ?wait=true：回带 id 的消息对象", r.status === 200 && typeof r.json?.id === "string" && r.json.id.length > 0 && r.json.id === lastPush().sent.id, r.text);
  check("embeds 的链接、图片", lastPush().sent.url === "https://ci.example" && lastPush().sent.image === "https://img.example/x.png");

  r = await call(env, "POST", `/${a.key}`, {
    json: { text: "<!channel> 线上 *挂了* 看 <https://status.example|状态页>", blocks: [{ type: "section", text: { type: "mrkdwn", text: "<!channel> 线上 *挂了* 看 <https://status.example|状态页>" } }] },
  });
  p = lastPush();
  check("★ blocks：<url|文字> → Markdown 链接，*加粗* → **加粗**，<!channel> → @所有人", p.alert.body === "@所有人 线上 **挂了** 看 [状态页](https://status.example)", JSON.stringify(p.alert));
  check("★ <!channel> → 时效性", p.level === "time-sensitive");
  check("★ 成功回纯文字 ok", r.status === 200 && r.text === "ok" && (r.headers.get("content-type") ?? "").startsWith("text/plain"), `${r.status} ${r.text}`);

  await call(env, "POST", `/${a.key}`, {
    json: { username: "Grafana", attachments: [{ title: "[FIRING:1] HighCPU", title_link: "https://grafana.example/alerting", text: "Value: 95", fields: null }], blocks: null },
  });
  p = lastPush();
  check("attachments（blocks 为 null）：标题、链接、正文", p.alert.title === "[FIRING:1] HighCPU" && p.sent.url === "https://grafana.example/alerting" && p.alert.body === "Value: 95", JSON.stringify(p));

  await call(env, "POST", `/${a.key}?level=passive&repeat=5&id=q1`, { json: { msgtype: "text", text: { content: "@all 也静默" }, at: { isAtAll: true } } });
  p = lastPush();
  check("★ 地址上拼的信鸽参数盖过消息里读出来的（level=passive）", p.level === "passive" && p.sent.id === "q1", JSON.stringify(p.sent));

  r = await call(env, "POST", `/${a.key}`, { json: { msgtype: "image", image: { base64: "xx", md5: "yy" } } });
  check("图片消息转不过来：推一句 [图片]，响应里说明", lastPush().alert.body === "[图片]" && (r.json?.warnings ?? []).some((w) => w.includes("图片")), r.text);

  const before = apns.length;
  r = await call(env, "POST", `/${a.key}`, { json: { text: "只有 text 的普通推送" } });
  check("★ 只有 text（没有 blocks）的还是信鸽自己的格式，回我们的信封", r.json?.code === 200 && lastPush().alert.body === "只有 text 的普通推送" && apns.length === before + 1, r.text);
  r = await call(env, "POST", `/${a.key}`, { json: { content: "只有 content" } });
  check("只有 content（没有 embeds）同样", r.json?.code === 200 && lastPush().alert.body === "只有 content", r.text);
  r = await call(env, "POST", `/${a.key}/路径正文`, { json: { msgtype: "text", text: { content: "x" } } });
  check("路径里给了正文的，照旧按路径式推送", r.json?.code === 200 && lastPush().alert.body === "路径正文", r.text);
}

console.log("\n★ 失败时同样按对方的样子回话，原因是中文");
{
  const env = makeEnv();
  let r = await call(env, "POST", "/nosuchkey000", { json: { msgtype: "text", text: { content: "x" } } });
  check("★ key 不存在（msgtype）→ 404 + {errcode:404, errmsg:中文}", r.status === 404 && r.json?.errcode === 404 && /key 不存在/.test(r.json?.errmsg ?? ""), r.text);
  r = await call(env, "POST", "/nosuchkey000", { json: { msg_type: "text", content: { text: "x" } } });
  check("key 不存在（msg_type）→ 404 + {code:404, msg}", r.status === 404 && r.json?.code === 404 && r.json?.msg?.includes("key 不存在"), r.text);
  r = await call(env, "POST", "/nosuchkey000", { json: { embeds: [{ title: "x" }] } });
  check("key 不存在（embeds）→ 404 + {code, message}", r.status === 404 && r.json?.code === 404 && r.json?.message?.includes("key 不存在"), r.text);
  r = await call(env, "POST", "/nosuchkey000", { json: { blocks: [{ type: "section", text: { text: "x" } }] } });
  check("key 不存在（blocks）→ 404 纯文字中文原因", r.status === 404 && r.text.includes("key 不存在"), r.text);

  // 限流：每种格式都回 429 + Retry-After
  const limited = makeEnv({ RL_PUSH: { limit: async () => ({ success: false }) } });
  const a = await newAccount(limited);
  r = await call(limited, "POST", `/cgi-bin/webhook/send?key=${a.key}`, { json: { msgtype: "text", text: { content: "x" } } });
  check("★ 限流 → 429、Retry-After、errcode 429", r.status === 429 && r.headers.get("retry-after") === "60" && r.json?.errcode === 429 && r.json?.errmsg.includes("太频繁"), r.text);
  r = await call(limited, "POST", `/services/T0/B0/${a.key}`, { json: { text: "x" } });
  check("限流（blocks 地址）→ 429 纯文字 + Retry-After", r.status === 429 && r.headers.get("retry-after") === "60" && r.text.includes("太频繁"), r.text);

  // 只收加密的通道：群机器人发来的是明文
  const e2e = makeEnv();
  const b = await newAccount(e2e);
  await call(e2e, "PATCH", `/account/${b.id}/channels/${b.channelId}`, { secret: b.secret, json: { policy: { e2eOnly: true } } });
  r = await call(e2e, "POST", `/open-apis/bot/v2/hook/${b.key}`, { json: { msg_type: "text", content: { text: "明文" } } });
  check("★ 只收加密的通道 → 400 {code:400, msg:只收加密…}", r.status === 400 && r.json?.code === 400 && r.json?.msg.includes("只收加密"), r.text);
}

// ── 兼容地址 ─────────────────────────────────────────────────────────

console.log("\n★ 群机器人的兼容地址：换个域名就行");
{
  const env = makeEnv();
  const a = await newAccount(env);
  let r = await call(env, "POST", `/cgi-bin/webhook/send?key=${a.key}`, { json: { msgtype: "markdown", markdown: { content: "# 构建失败\n**main** 分支" } } });
  check("★ /cgi-bin/webhook/send?key= → 推出去、回 errcode 0", r.json?.errcode === 0 && lastPush().alert.title === "构建失败" && lastPush().alert.body === "**main** 分支", r.text);
  r = await call(env, "POST", `/robot/send?access_token=${a.key}&timestamp=1690000000000&sign=abc%3D`, { json: { msgtype: "text", text: { content: "签名参数不看" } } });
  check("★ /robot/send?access_token=…&timestamp&sign → 签名参数不看，照推", r.json?.errcode === 0 && lastPush().alert.body === "签名参数不看", r.text);
  r = await call(env, "POST", `/open-apis/bot/v2/hook/${a.key}`, { json: { timestamp: "1690000000", sign: "abc", msg_type: "text", content: { text: "来自 msg_type 地址" } } });
  check("★ /open-apis/bot/v2/hook/{key} → 回 code 0", r.json?.code === 0 && lastPush().alert.body === "来自 msg_type 地址", r.text);
  r = await call(env, "POST", `/api/webhooks/123456/${a.key}`, { json: { content: "来自 embeds 地址" } });
  check("★ /api/webhooks/{id}/{key} → 204；只有 content 也认", r.status === 204 && lastPush().alert.body === "来自 embeds 地址", `${r.status} ${r.text}`);
  r = await call(env, "POST", `/api/v10/webhooks/1/${a.key}?wait=true`, { json: { embeds: [{ title: "带版本号" }] } });
  check("/api/v10/webhooks/… 也认，?wait=true 回 id", r.status === 200 && r.json?.id === lastPush().sent.id && lastPush().alert.title === "带版本号", r.text);
  r = await call(env, "POST", `/api/webhooks/${a.key}`, { json: { content: "一段的" } });
  check("/api/webhooks/{key}（一段）也认", r.status === 204 && lastPush().alert.body === "一段的", `${r.status}`);
  r = await call(env, "POST", `/services/T000/B000/${a.key}`, { json: { text: "来自 blocks 地址" } });
  check("★ /services/…/{key} → 纯文字 ok", r.status === 200 && r.text === "ok" && lastPush().alert.body === "来自 blocks 地址", r.text);
  r = await call(env, "POST", `/services/T000/B000/${a.key}`, {
    raw: `payload=${encodeURIComponent(JSON.stringify({ text: "表单里的 payload" }))}`,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  check("表单里装着 JSON 的 payload 字段也认", r.text === "ok" && lastPush().alert.body === "表单里的 payload", r.text);
  r = await call(env, "POST", `/robot/send?access_token=${a.key}`, { json: { title: "信鸽自己的", body: "参数也认" } });
  check("★ 兼容地址收到信鸽自己的参数也认（回话仍按地址的格式）", r.json?.errcode === 0 && lastPush().alert.title === "信鸽自己的" && lastPush().alert.body === "参数也认", r.text);
  r = await call(env, "POST", `/robot/send?access_token=${a.key}`, { json: { event: "备份", status: "失败", host: "nas" } });
  check("不是任何格式的 JSON：按通用 JSON 推", r.json?.errcode === 0 && lastPush().alert.title === "备份 · 失败" && lastPush().alert.body === "host：nas", JSON.stringify(lastPush().alert));
  r = await call(env, "POST", `/cgi-bin/webhook/send?key=${a.key}`, { json: { msgtype: "text", text: { content: "@all 上线了" } } });
  check("正文里写 @all 不算 @所有人（要用 mentioned_list）", lastPush().level === undefined);
  r = await call(env, "GET", `/cgi-bin/webhook/send?key=${a.key}`);
  check("★ GET → 405，按格式回话并说明只收 POST", r.status === 405 && r.json?.errcode === 405 && r.json?.errmsg.includes("POST"), r.text);
  r = await call(env, "POST", "/cgi-bin/webhook/send", { json: { msgtype: "text", text: { content: "x" } } });
  check("少了 key → 400，说明该怎么写", r.status === 400 && r.json?.errmsg.includes("?key="), r.text);
  r = await call(env, "POST", `/cgi-bin/webhook/other?key=${a.key}`, { json: {} });
  check("认不出的兼容地址 → 404", r.status === 404, r.text);
  r = await call(env, "POST", `/robot/send?access_token=${a.key}`, { raw: "{写坏了", headers: { "content-type": "application/json" } });
  check("写坏的 JSON → 400 中文原因", r.status === 400 && r.json?.errmsg.includes("JSON"), r.text);
  const plain = await worker.fetch(new Request(`http://nfo.im/robot/send?access_token=${a.key}`, { method: "POST", body: "{}" }), env, {});
  check("★ 明文 http → 400，不推送（和别的推送入口一样）", plain.status === 400);
}

// ── 国内推送服务的参数写法 ───────────────────────────────────────────

console.log("\n★ 国内推送服务的参数写法");
{
  const env = makeEnv();
  const a = await newAccount(env);
  let r = await call(env, "POST", `/${a.key}`, { raw: "text=构建完成&desp=main 分支", headers: { "content-type": "application/x-www-form-urlencoded" } });
  check("★ text + desp：text 是标题、desp 是正文", lastPush().alert.title === "构建完成" && lastPush().alert.body === "main 分支", JSON.stringify(lastPush().alert));
  await call(env, "GET", `/${a.key}.send?title=${encodeURIComponent("签到成功")}&desp=${encodeURIComponent("连续 12 天")}`);
  check("/{key}.send?title=&desp=", lastPush().alert.title === "签到成功" && lastPush().alert.body === "连续 12 天");
  await call(env, "POST", `/${a.key}`, { json: { title: "t", content: "正文", summary: "摘要" } });
  check("content + summary：正文 + 副标题", lastPush().alert.body === "正文" && lastPush().alert.subtitle === "摘要");
  await call(env, "POST", `/${a.key}`, { json: { title: "t", short: "一句摘要", desp: "正文" } });
  check("short 当副标题", lastPush().alert.subtitle === "一句摘要" && lastPush().alert.body === "正文");
  r = await call(env, "POST", `/${a.key}`, { json: { token: "别家令牌", title: "t", content: "<p><b>粗</b></p><p>第二段 <a href='https://x.example'>链接</a></p>", template: "html", channel: "ch1", topic: "g1" } });
  check("★ template=html：HTML 转成文字（加粗、链接保留成 Markdown）", lastPush().alert.body === "**粗**\n\n第二段 [链接](https://x.example)", JSON.stringify(lastPush().alert.body));
  check("★ 别家特有的参数列进 ignored，值不进推送", JSON.stringify(r.json?.data?.ignored) === JSON.stringify(["token", "channel", "topic"]) && !JSON.stringify(apns.at(-1)).includes("别家令牌"), r.text);
  await call(env, "POST", `/${a.key}`, { json: { token: "x", title: "t", content: "默认也是 <br>HTML" } });
  check("带着 token、没写 template、正文像 HTML：按 HTML 转", lastPush().alert.body === "默认也是\nHTML", JSON.stringify(lastPush().alert.body));
  await call(env, "POST", `/${a.key}`, { json: { title: "t", content: "a<br>b" } });
  check("没有这些迹象的正文不动", lastPush().alert.body === "a<br>b");
  await call(env, "POST", `/${a.key}`, { json: { title: "t", content: JSON.stringify({ cpu: "95%", host: { name: "db-1" } }), template: "json" } });
  check("★ template=json：正文排成「键：值」", lastPush().alert.body === "cpu：95%\nhost.name：db-1", JSON.stringify(lastPush().alert.body));
  await call(env, "POST", `/${a.key}`, { json: { content: "<p>x</p>", contentType: 2 } });
  check("contentType=2 = HTML", lastPush().alert.body === "x");
  r = await call(env, "GET", `/${a.key}?pushkey=k&text=${encodeURIComponent("https://img.example/p.png")}&type=image`);
  check("★ type=image：正文是图片地址 → 大图，正文写 [图片]", lastPush().sent.image === "https://img.example/p.png" && lastPush().alert.body === "[图片]" && r.json?.data?.ignored?.includes("pushkey"), r.text);
  r = await call(env, "POST", `/${a.key}`, { json: { title: "宝塔", msg: "磁盘满了", type: "disk" } });
  check("认不出的 type 值列进 ignored；msg 是正文", lastPush().alert.body === "磁盘满了" && r.json?.data?.ignored?.includes("type"), r.text);
  await call(env, "POST", `/${a.key}`, { json: { body: "b", tags: "warning|prod" } });
  check("tags 用竖线分隔", lastPush().sent.tags === "warning,prod", lastPush().sent.tags);
}

// ── 通用 JSON ────────────────────────────────────────────────────────

console.log("\n★ 通用 JSON：认不出字段也推一条看得懂的");
{
  const env = makeEnv();
  const a = await newAccount(env);
  let r = await call(env, "POST", `/${a.key}`, {
    json: { event: "backup", status: "failed", host: "nas", size: 123, api_token: "SECRET", details: { disk: "/data", ok: false }, url: "https://nas.example/log" },
  });
  let p = lastPush();
  check("★ 标题取 event + status", p.alert.title === "backup · failed", p.alert.title);
  check("★ 正文是前几个字段「键：值」，信鸽认得的参数（url）不排进去", p.alert.body === "host：nas\nsize：123\ndetails.disk：/data\ndetails.ok：否", JSON.stringify(p.alert.body));
  check("★ 像凭据的字段不进推送", !JSON.stringify(p.sent).includes("SECRET"));
  check("url 照样当点击链接", p.sent.url === "https://nas.example/log");
  check("响应 warnings 里说按通用 JSON 推了", r.json?.data?.warnings?.some((w) => w.includes("通用 JSON")), r.text);

  const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${i}`, i]));
  await call(env, "POST", `/${a.key}`, { json: many });
  check("超过 6 个字段：只排前 6 个，末尾写另有几个", lastPush().alert.body.split("\n").length === 7 && lastPush().alert.body.endsWith("…另有 3 个字段"), lastPush().alert.body);
  await call(env, "POST", `/${a.key}`, { json: { severity: "critical", name: "磁盘" } });
  check("severity=critical → 时效性", lastPush().level === "time-sensitive" && lastPush().alert.title === "磁盘");
  await call(env, "POST", `/${a.key}`, { json: [{ name: "a" }, { name: "b" }] });
  check("数组：取第一条、标题写共几条", lastPush().alert.title === "a（共 2 条）", lastPush().alert.title);
  await call(env, "POST", `/${a.key}`, { json: { id: "x1", status: "resolved", host: "db" } });
  p = lastPush();
  check("id、status 照样当参数用，状态接进标题", p.sent.id === "x1" && p.sent.status === "resolved" && p.alert.title === "状态：resolved" && p.alert.body === "host：db", JSON.stringify(p));

  r = await call(env, "POST", `/hook/${a.key}/json`, { json: { title: "部署", message: "v2.3 上线", level: "whatever", id: "not-mine" } });
  p = lastPush();
  check("★ /hook/{key}/json：title、message 当标题正文", p.alert.title === "部署" && p.alert.body === "v2.3 上线", JSON.stringify(p.alert));
  check("★ /hook/{key}/json 不把别人家的 id 当推送参数", p.sent.id !== "not-mine", p.sent.id);
  r = await call(env, "POST", `/hook/${a.key}/json`, { json: {} });
  check("/hook/{key}/json 空对象：200 skipped（不让对方一直重试）", r.status === 200 && r.json?.data?.skipped === true, r.text);
}

finish();
