/**
 * 接入面端到端：真实场景里的请求体，打真跑起来的 Worker（本地 wrangler dev，随机端口），看 Apple 收到的通知。
 *
 * 群机器人的四种结构（照各类工具实际发出的样子写）、国内推送服务的参数写法、通用 JSON、
 * Alertmanager 一组告警从触发到部分恢复再到全部恢复、MCP 从 initialize 到 tools/call 的完整往来、
 * 命令包装器 pigeon.sh —— 每一条都断言两头：发送方拿到的回话，和推到 APNs 的 payload、请求头。
 *
 * APNs 是本机的一个假 HTTPS 服务（见 l1-live.mjs），其余全是线上那一套。自己起、自己收，不用 BASE。
 */
import { spawn } from "node:child_process";
import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startLive } from "./l1-live.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `  → ${detail}` : ""}`);
  }
}

const live = await startLive();
const { base, take } = live;

async function send(method, path, { json, form, raw, headers = {} } = {}) {
  const h = { ...headers };
  let body;
  if (json !== undefined) {
    h["content-type"] ??= "application/json";
    body = JSON.stringify(json);
  } else if (form !== undefined) {
    h["content-type"] ??= "application/x-www-form-urlencoded";
    body = new URLSearchParams(form).toString();
  } else body = raw;
  const res = await fetch(base + path, { method, headers: h, body, redirect: "manual" });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* 纯文字、空响应 */
  }
  return { status: res.status, headers: res.headers, text, json: parsed };
}

/** 推到 APNs 的一条 → 断言要看的几样 */
function view(push) {
  const aps = push?.payload?.aps ?? {};
  return {
    title: aps.alert?.title,
    subtitle: aps.alert?.subtitle,
    body: aps.alert?.body,
    level: aps["interruption-level"] ?? "active",
    thread: aps["thread-id"],
    collapse: push?.headers?.["apns-collapse-id"],
    payload: push?.payload ?? {},
    headers: push?.headers ?? {},
  };
}
const show = (v) => JSON.stringify({ title: v.title, subtitle: v.subtitle, body: v.body, level: v.level, url: v.payload?.url });

let deviceSeq = 0;
async function newAccount(name) {
  deviceSeq += 1;
  const token = `${deviceSeq}`.padStart(2, "0").repeat(32);
  const r = await send("POST", "/account", { json: { device_token: token, environment: "sandbox", device_name: name } });
  const data = r.json?.data;
  return { id: data?.account_id, secret: data?.secret, key: data?.channels?.[0]?.key, channelId: data?.channels?.[0]?.id, token };
}

try {
  console.log("\n★ 准备：登记设备，推送签名走真的 TLS 到本机的假 APNs");
  const a = await newAccount("接入面端到端");
  check("建账号", typeof a.key === "string" && a.key.length > 0);
  const probe = live.pushes.find((p) => p.payload?.probe === "1");
  check("登记设备前的令牌校验推送到了假 APNs（后台推送、优先级 5）", probe?.headers["apns-push-type"] === "background" && probe?.headers["apns-priority"] === "5" && probe?.token === a.token, JSON.stringify(probe?.headers));
  const [header64, claims64, sig64] = (probe?.headers.authorization ?? "").replace(/^bearer /, "").split(".");
  const jwtHeader = JSON.parse(Buffer.from(header64 ?? "", "base64url").toString() || "{}");
  const signed = verify("sha256", Buffer.from(`${header64}.${claims64}`), { key: createPublicKey(live.publicKey), dsaEncoding: "ieee-p1363" }, Buffer.from(sig64 ?? "", "base64url"));
  check("★ 推送带的 JWT 是 ES256、用这把私钥签的，验签通过", jwtHeader.alg === "ES256" && signed, JSON.stringify(jwtHeader));
  take();

  // ── 群机器人格式 ─────────────────────────────────────────────────

  console.log("\n★ msgtype 风格（?key= 地址）：CI 的构建通知、告警、卡片");
  {
    let r = await send("POST", `/cgi-bin/webhook/send?key=${a.key}`, {
      json: {
        msgtype: "markdown",
        markdown: {
          content:
            '## 构建失败 <font color="warning">pigeon-server #182</font>\n> 分支：<font color="comment">main</font>\n> 提交：3f2a9c1 修复重复提醒\n> 耗时：3 分 12 秒\n\n[查看日志](https://ci.example.com/job/182/console)',
        },
      },
    });
    let [p] = take().map(view);
    check("★ 回 {errcode:0, errmsg:'ok'}，顺带消息 id", r.status === 200 && r.json?.errcode === 0 && r.json?.errmsg === "ok" && r.json?.id === p?.collapse, r.text);
    check("★ 标题行里的 <font> 去掉：「构建失败 pigeon-server #182」", p?.title === "构建失败 pigeon-server #182", show(p ?? {}));
    check("★ 引用号、<font> 去掉，链接保留成 Markdown", p?.body === "分支：main\n提交：3f2a9c1 修复重复提醒\n耗时：3 分 12 秒\n\n[查看日志](https://ci.example.com/job/182/console)", JSON.stringify(p?.body));
    check("原文放在 payload 的 markdown 里", typeof p?.payload.markdown === "string" && p.payload.markdown.includes('<font color="comment">main</font>'), p?.payload.markdown);
    check("普通级别、按通道分组、apns-topic 是 App 的 Bundle ID", p?.level === "active" && p?.thread === a.channelId && p?.headers["apns-topic"] === "im.nfo.pigeon" && p?.headers["apns-push-type"] === "alert");

    r = await send("POST", `/cgi-bin/webhook/send?key=${a.key}`, {
      json: { msgtype: "text", text: { content: "【生产告警】订单服务 5xx 比例 12%\n时间：2026-09-27 10:42\n影响：下单接口", mentioned_list: ["@all"], mentioned_mobile_list: [] } },
    });
    [p] = take().map(view);
    check("★ text：第一行当标题，其余当正文", p?.title === "【生产告警】订单服务 5xx 比例 12%" && p?.body === "时间：2026-09-27 10:42\n影响：下单接口", show(p ?? {}));
    check("★ mentioned_list 里有 @all → 时效性", p?.level === "time-sensitive", p?.level);

    await send("POST", `/cgi-bin/webhook/send?key=${a.key}`, {
      json: {
        msgtype: "template_card",
        template_card: {
          card_type: "text_notice",
          source: { desc: "运维平台" },
          main_title: { title: "数据库备份失败", desc: "nightly-backup · 02:00 任务" },
          emphasis_content: { title: "3", desc: "连续失败次数" },
          sub_title_text: "磁盘空间不足，备份已中止",
          horizontal_content_list: [{ keyname: "主机", value: "db-01" }, { keyname: "剩余空间", value: "1.2 GB" }],
          jump_list: [{ type: 1, url: "https://ops.example.com/backup/182", title: "查看详情" }],
          card_action: { type: 1, url: "https://ops.example.com/backup" },
        },
      },
    });
    [p] = take().map(view);
    check("★ template_card：主标题、副标题、重点数据、键值、点击链接",
      p?.title === "数据库备份失败" && p?.subtitle === "nightly-backup · 02:00 任务" && p?.body === "连续失败次数：3\n\n磁盘空间不足，备份已中止\n\n主机：db-01\n剩余空间：1.2 GB" && p?.payload.url === "https://ops.example.com/backup",
      show(p ?? {}));
  }

  console.log("\n★ msgtype 风格（?access_token= 地址，后面拼着 timestamp、sign）");
  {
    let r = await send("POST", `/robot/send?access_token=${a.key}&timestamp=1790000000000&sign=dGVzdA%3D%3D`, {
      json: {
        msgtype: "markdown",
        markdown: { title: "发布通知", text: "#### 发布通知\n- 服务：api-gateway\n- 版本：v2.4.1\n- 状态：**成功**\n\n> 发布人：张三\n\n[查看发布单](https://deploy.example.com/r/991)" },
        at: { atMobiles: [], isAtAll: true },
      },
    });
    let [p] = take().map(view);
    check("★ 签名参数不看，照推、回 errcode 0", r.json?.errcode === 0 && p !== undefined, r.text);
    check("★ 标题取 title，正文里重复的标题行去掉，列表换成「• 」", p?.title === "发布通知" && p?.body === "• 服务：api-gateway\n• 版本：v2.4.1\n• 状态：**成功**\n\n发布人：张三\n\n[查看发布单](https://deploy.example.com/r/991)", JSON.stringify(p?.body));
    check("★ isAtAll → 时效性", p?.level === "time-sensitive");

    await send("POST", `/robot/send?access_token=${a.key}`, {
      json: {
        msgtype: "actionCard",
        actionCard: {
          title: "待审批：合并请求 #88",
          text: "### 待审批：合并请求 #88\n**feat: 重复提醒上限**\n\n作者：李四",
          btnOrientation: "0",
          btns: [{ title: "去审批", actionURL: "someapp://client/page/link?url=https%3A%2F%2Fgit.example.com%2Fmr%2F88&pc_slide=false" }],
        },
      },
    });
    [p] = take().map(view);
    check("★ actionCard：按钮上「客户端内打开」的包装拆掉，点开是真地址", p?.title === "待审批：合并请求 #88" && p?.body === "**feat: 重复提醒上限**\n\n作者：李四" && p?.payload.url === "https://git.example.com/mr/88", show(p ?? {}));

    await send("POST", `/robot/send?access_token=${a.key}`, {
      json: { msgtype: "feedCard", feedCard: { links: [{ title: "周报：9 月第 4 周", messageURL: "https://blog.example.com/w39", picURL: "https://blog.example.com/w39.png" }, { title: "发布说明 v2.4", messageURL: "https://blog.example.com/v24" }] } },
    });
    [p] = take().map(view);
    check("feedCard：第一条展开（链接、大图），其余列标题", p?.title === "周报：9 月第 4 周" && p?.body === "另 1 条：\n• 发布说明 v2.4" && p?.payload.image === "https://blog.example.com/w39.png", show(p ?? {}));
  }

  console.log("\n★ msg_type 风格（/open-apis/bot/v2/hook/{key}）：卡片、富文本");
  {
    let r = await send("POST", `/open-apis/bot/v2/hook/${a.key}`, {
      json: {
        timestamp: "1790000000",
        sign: "c2lnbg==",
        msg_type: "interactive",
        card: {
          config: { wide_screen_mode: true },
          header: { template: "red", title: { tag: "plain_text", content: "【P1】支付回调超时" } },
          elements: [
            { tag: "div", text: { tag: "plain_text", content: "过去 5 分钟 38 次超时，影响 12 笔订单" } },
            { tag: "div", fields: [{ is_short: true, text: { tag: "plain_text", content: "**服务**\npay-callback" } }, { is_short: true, text: { tag: "plain_text", content: "**值班：**\n<at id=all></at>" } }] },
            { tag: "hr" },
            { tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: "查看面板" }, type: "primary", url: "https://grafana.example.com/d/pay" }] },
            { tag: "note", elements: [{ tag: "plain_text", content: "来自 监控平台 · 2026-09-27 10:42" }] },
          ],
        },
      },
    });
    let [p] = take().map(view);
    check("★ 回 {code:0, msg:'success', StatusCode:0}", r.status === 200 && r.json?.code === 0 && r.json?.msg === "success" && r.json?.StatusCode === 0, r.text);
    check("★ 卡片标题；并排字段「**服务**\\n值」并成「服务：值」", p?.title === "【P1】支付回调超时" && p?.body === "过去 5 分钟 38 次超时，影响 12 笔订单\n服务：pay-callback\n值班：@所有人\n来自 监控平台 · 2026-09-27 10:42", JSON.stringify(p?.body));
    check("★ 按钮链接当点击链接；<at id=all> → 时效性；卡片的红色不决定级别", p?.payload.url === "https://grafana.example.com/d/pay" && p?.level === "time-sensitive");

    await send("POST", `/open-apis/bot/v2/hook/${a.key}`, {
      json: {
        msg_type: "post",
        content: {
          post: {
            zh_cn: {
              title: "每日构建报告",
              content: [
                [{ tag: "text", text: "构建 #312 " }, { tag: "text", text: "成功", style: ["bold"] }],
                [{ tag: "text", text: "产物：" }, { tag: "a", text: "下载", href: "https://ci.example.com/a/312" }],
              ],
            },
          },
        },
      },
    });
    [p] = take().map(view);
    check("post 富文本：标题、链接写成 Markdown 并当点击链接", p?.title === "每日构建报告" && p?.body === "构建 #312 成功\n产物：[下载](https://ci.example.com/a/312)" && p?.payload.url === "https://ci.example.com/a/312" && p?.level === "active", show(p ?? {}));

    await send("POST", `/open-apis/bot/v2/hook/${a.key}`, {
      json: {
        msg_type: "interactive",
        card: {
          schema: "2.0",
          header: { title: { tag: "plain_text", content: "部署完成" }, subtitle: { tag: "plain_text", content: "prod · 3 个服务" }, template: "green" },
          body: {
            elements: [
              { tag: "markdown", content: "**api** v2.4.1 ✅\n**web** v1.9.0 ✅" },
              { tag: "column_set", columns: [{ tag: "column", elements: [{ tag: "markdown", content: "耗时 **4m12s**" }] }] },
              { tag: "button", text: { tag: "plain_text", content: "发布记录" }, behaviors: [{ type: "open_url", default_url: "https://deploy.example.com/r/992" }] },
            ],
          },
        },
      },
    });
    [p] = take().map(view);
    check("卡片 2.0：副标题、分栏里的文字、按钮的 open_url", p?.subtitle === "prod · 3 个服务" && p?.body === "**api** v2.4.1 ✅\n**web** v1.9.0 ✅\n耗时 **4m12s**" && p?.payload.url === "https://deploy.example.com/r/992", show(p ?? {}));
  }

  console.log("\n★ embeds 风格（/api/webhooks/{id}/{key}）：Uptime Kuma、Grafana 这类监控发来的");
  {
    let r = await send("POST", `/api/webhooks/1234567890/${a.key}`, {
      json: {
        username: "Uptime Kuma",
        avatar_url: "https://uptime.example.com/icon.png",
        embeds: [
          {
            title: "❌ Your service 官网 went down. ❌",
            color: 16711680,
            timestamp: "2026-09-27T02:42:00.000Z",
            fields: [
              { name: "Service Name", value: "官网" },
              { name: "Service URL", value: "https://www.example.com" },
              { name: "Time (Asia/Shanghai)", value: "2026-09-27 10:42:00" },
              { name: "Error", value: "timeout of 48000ms exceeded" },
            ],
          },
        ],
      },
    });
    let [p] = take().map(view);
    check("★ 成功回 204 空响应", r.status === 204 && r.text === "", `${r.status} ${r.text}`);
    check("★ 字段排成「名：值」", p?.title === "❌ Your service 官网 went down. ❌" && p?.body === "Service Name：官网\nService URL：https://www.example.com\nTime (Asia/Shanghai)：2026-09-27 10:42:00\nError：timeout of 48000ms exceeded", show(p ?? {}));
    check("★ 卡片没给链接：点开是名字里带 URL 的字段", p?.payload.url === "https://www.example.com", p?.payload.url);

    r = await send("POST", `/api/webhooks/1234567890/${a.key}?wait=true`, {
      json: {
        content: "@everyone 磁盘告警",
        embeds: [
          {
            title: "[FIRING:1] DiskFull nas-01",
            url: "https://grafana.example.com/alerting/list",
            description: "**Value:** 96%\n**Labels:**\n- mountpoint = /data\n- instance = nas-01",
            color: 15158332,
            footer: { text: "Grafana v11" },
            image: { url: "https://grafana.example.com/render/disk.png" },
          },
        ],
      },
    });
    [p] = take().map(view);
    check("★ ?wait=true：回带 id 的消息对象，id 就是通知的 collapse id", r.status === 200 && r.json?.id === p?.collapse && r.json?.type === 0, r.text);
    check("★ 描述里的列表换成「• 」，@everyone 写成 @所有人、按时效性", p?.body === "@所有人 磁盘告警\n\n**Value:** 96%\n**Labels:**\n• mountpoint = /data\n• instance = nas-01" && p?.level === "time-sensitive", JSON.stringify(p?.body));
    check("卡片的链接、大图", p?.payload.url === "https://grafana.example.com/alerting/list" && p?.payload.image === "https://grafana.example.com/render/disk.png");

    await send("POST", `/api/webhooks/${a.key}`, { json: { content: "备份完成", embeds: [{ description: "耗时 3 分钟，1.2 GB" }] } });
    [p] = take().map(view);
    check("★ 一句话的 content 加一张没标题的卡片：content 当标题", p?.title === "备份完成" && p?.body === "耗时 3 分钟，1.2 GB", show(p ?? {}));

    await send("POST", `/api/v10/webhooks/1/${a.key}`, { json: { content: "夜间同步完成\n共 1,204 条，用时 3 分 12 秒" } });
    [p] = take().map(view);
    check("★ 地址是 embeds 风格、请求体只有 content：多行的第一行当标题", p?.title === "夜间同步完成" && p?.body === "共 1,204 条，用时 3 分 12 秒", show(p ?? {}));
  }

  console.log("\n★ blocks 风格（/services/…/{key}）：attachments、blocks、表单里的 payload");
  {
    let r = await send("POST", `/services/T0000/B0000/${a.key}`, {
      json: {
        channel: "#alerts",
        username: "AlertManager",
        icon_emoji: ":fire:",
        attachments: [
          {
            color: "danger",
            title: "[FIRING:2] HighCPU (prod)",
            title_link: "https://am.example.com/#/alerts?receiver=ops",
            text: "*告警：* CPU 使用率 97% - `critical`\n*主机：* db-01:9100\n*详情：* <https://grafana.example.com/d/cpu|CPU 面板>",
            fallback: "[FIRING:2] HighCPU",
            footer: "Prometheus",
            mrkdwn_in: ["text"],
          },
        ],
      },
    });
    let [p] = take().map(view);
    check("★ 回纯文字 ok", r.status === 200 && r.text === "ok" && (r.headers.get("content-type") ?? "").startsWith("text/plain"), r.text);
    check("★ attachments：标题、*加粗* → **加粗**、<url|文字> → Markdown 链接、标题链接当点击链接",
      p?.title === "[FIRING:2] HighCPU (prod)" && p?.body === "**告警：** CPU 使用率 97% - `critical`\n**主机：** db-01:9100\n**详情：** [CPU 面板](https://grafana.example.com/d/cpu)" && p?.payload.url === "https://am.example.com/#/alerts?receiver=ops",
      show(p ?? {}));

    await send("POST", `/services/T0000/B0000/${a.key}`, {
      json: {
        text: "发布 v2.4.1 完成",
        blocks: [
          { type: "header", text: { type: "plain_text", text: "发布 v2.4.1 完成" } },
          { type: "section", text: { type: "mrkdwn", text: "<!here> *api-gateway* 已发布到 prod" }, fields: [{ type: "mrkdwn", text: "*环境*\nprod" }, { type: "mrkdwn", text: "*耗时*\n4 分钟" }] },
          { type: "context", elements: [{ type: "mrkdwn", text: "发布人 张三" }] },
          { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "发布记录" }, url: "https://deploy.example.com/r/991" }] },
        ],
      },
    });
    [p] = take().map(view);
    check("★ blocks：header 当标题，字段并成「环境：prod」，按钮链接，<!here> → 时效性",
      p?.title === "发布 v2.4.1 完成" && p?.body === "@所有人 **api-gateway** 已发布到 prod\n环境：prod\n耗时：4 分钟\n发布人 张三" && p?.payload.url === "https://deploy.example.com/r/991" && p?.level === "time-sensitive",
      show(p ?? {}));

    r = await send("POST", `/services/T0000/B0000/${a.key}`, { form: { payload: JSON.stringify({ text: "夜间任务完成：同步 1,204 条记录\n耗时 3 分 12 秒 <https://jobs.example.com/88|详情>" }) } });
    [p] = take().map(view);
    check("★ 表单里的 payload、只有 text：第一行当标题，<url|文字> 照样转", r.text === "ok" && p?.title === "夜间任务完成：同步 1,204 条记录" && p?.body === "耗时 3 分 12 秒 [详情](https://jobs.example.com/88)", show(p ?? {}));
  }

  console.log("\n★ 直接推到 /{key}、地址上拼信鸽参数、失败时的回话");
  {
    let r = await send("POST", `/${a.key}`, { json: { msgtype: "text", text: { content: "证书 30 天后过期：api.example.com" } } });
    let [p] = take().map(view);
    check("★ /{key} 收到 msgtype：按它的样子回话", r.json?.errcode === 0 && p?.body === "证书 30 天后过期：api.example.com", r.text);
    r = await send("POST", `/cgi-bin/webhook/send?key=${a.key}&level=passive&id=deploy-42&repeat=5`, { json: { msgtype: "text", text: { content: "发布开始", mentioned_list: ["@all"] } } });
    [p] = take().map(view);
    check("★ 地址上拼的 level、id 盖过消息里读出来的：静默、collapse id 是 deploy-42", p?.level === "passive" && p?.collapse === "deploy-42" && r.json?.id === "deploy-42", r.text);
    for (const [path, shape] of [
      [`/cgi-bin/webhook/send?key=nosuchkey00000`, (x) => x.json?.errcode === 404],
      [`/open-apis/bot/v2/hook/nosuchkey00000`, (x) => x.json?.code === 404 && typeof x.json?.msg === "string"],
      [`/api/webhooks/1/nosuchkey00000`, (x) => x.json?.code === 404 && typeof x.json?.message === "string"],
      [`/services/T/B/nosuchkey00000`, (x) => x.text.includes("key 不存在")],
    ]) {
      r = await send("POST", path, { json: { msgtype: "text", msg_type: "text", text: { content: "x" }, content: { text: "x" } } });
      check(`key 不存在 → 404，按地址的样子回中文原因（${path.split("/")[1]}）`, r.status === 404 && shape(r), r.text);
    }
    check("失败的请求一条也没推", take().length === 0);
  }

  // ── 国内推送服务的参数写法 ───────────────────────────────────────

  console.log("\n★ 国内推送服务的参数写法");
  {
    const b = await newAccount("参数写法");
    let r = await send("POST", `/${b.key}.send`, { form: { title: "签到成功", desp: "## 今日签到\n- 连续 **12** 天\n- 获得 5 积分\n\n| 项目 | 状态 |\n|---|---|\n| 论坛 | ✅ |\n| 云盘 | ✅ |" } });
    let [p] = take().map(view);
    check("★ /{key}.send + title + desp：desp 按 Markdown 读，标题、列表、表格换成读得顺的样子",
      r.json?.code === 200 && p?.title === "签到成功" && p?.body === "今日签到\n• 连续 **12** 天\n• 获得 5 积分\n\n项目 · 状态\n论坛 · ✅\n云盘 · ✅", JSON.stringify(p?.body));

    await send("GET", `/${b.key}?text=${encodeURIComponent("服务器重启")}&desp=${encodeURIComponent("原因：内核更新")}`);
    [p] = take().map(view);
    check("★ GET 的 text + desp：text 是标题", p?.title === "服务器重启" && p?.body === "原因：内核更新", show(p ?? {}));

    r = await send("POST", `/${b.key}`, {
      json: { token: "0123456789abcdef0123", title: "余额提醒", content: '<p>账户余额 <b>12.30</b> 元</p><p>请及时充值：<a href="https://pay.example.com">充值</a></p>', template: "html", channel: "cp", topic: "ops" },
    });
    [p] = take().map(view);
    check("★ template=html：转成文字，加粗、链接保留成 Markdown", p?.body === "账户余额 **12.30** 元\n\n请及时充值：[充值](https://pay.example.com)", JSON.stringify(p?.body));
    check("★ 别家特有的参数列进 ignored，令牌的值不进推送", JSON.stringify(r.json?.data?.ignored) === '["token","channel","topic"]' && !JSON.stringify(p?.payload).includes("0123456789abcdef0123"), r.text);

    r = await send("POST", `/${b.key}`, { json: { appToken: "AT_test", content: "**构建成功**\n分支 main", summary: "CI 通知", contentType: 3, uids: ["UID_test"], url: "https://ci.example.com/1" } });
    [p] = take().map(view);
    check("content + summary + contentType=3：正文、副标题、链接；appToken、uids 列进 ignored",
      p?.subtitle === "CI 通知" && p?.body === "**构建成功**\n分支 main" && p?.payload.url === "https://ci.example.com/1" && JSON.stringify(r.json?.data?.ignored) === '["appToken","uids"]', `${show(p ?? {})} ${r.text}`);

    await send("POST", `/${b.key}`, { json: { title: "监控截图", content: "https://img.example.com/shot.png", type: "image" } });
    [p] = take().map(view);
    check("type=image：正文的图片地址当大图，正文写 [图片]", p?.payload.image === "https://img.example.com/shot.png" && p?.body === "[图片]");
  }

  // ── 通用 JSON ────────────────────────────────────────────────────

  console.log("\n★ 通用 JSON：各种服务五花八门的 webhook");
  {
    const c = await newAccount("通用 JSON");
    let r = await send("POST", `/${c.key}`, {
      json: { event: "backup", status: "failed", job: { name: "nightly", duration_s: 312 }, host: "nas-01", error_code: 28, api_token: "sk-live-0000", link: "https://nas.example.com/backup/312", severity: "error" },
    });
    let [p] = take().map(view);
    check("★ 标题「backup · failed」，正文是前几个字段，链接当点击链接", p?.title === "backup · failed" && p?.body === "job.name：nightly\njob.duration_s：312\nhost：nas-01\nerror_code：28\nseverity：error" && p?.payload.url === "https://nas.example.com/backup/312", show(p ?? {}));
    check("★ 像凭据的字段（api_token）不进推送", !JSON.stringify(p?.payload).includes("sk-live"));
    check("severity=error → 普通；响应 warnings 说按通用 JSON 推了", p?.level === "active" && r.json?.data?.warnings?.some((w) => w.includes("通用 JSON")), r.text);

    await send("POST", `/${c.key}`, { json: [{ name: "cert-expiry", state: "warning", domain: "api.example.com", days_left: 12 }, { name: "cert-expiry", state: "ok", domain: "www.example.com", days_left: 80 }] });
    [p] = take().map(view);
    check("数组：取第一条，标题写共几条", p?.title === "cert-expiry · warning（共 2 条）" && p?.body === "domain：api.example.com\ndays_left：12", show(p ?? {}));

    await send("POST", `/${c.key}`, { json: { subject: "新用户注册", message: "用户 wynn 于 2026-09-27 10:42 注册", meta: { ip: "203.0.113.5" } } });
    [p] = take().map(view);
    check("★ {subject, message}：subject 当标题（原先只推了正文）", p?.title === "新用户注册" && p?.body === "用户 wynn 于 2026-09-27 10:42 注册", show(p ?? {}));

    r = await send("POST", `/${c.key}`, { json: { title: "备份失败", host: "nas-01", error: "No space left on device", id: "backup-nightly" } });
    [p] = take().map(view);
    check("★ 有标题、没正文：其余字段排成正文（原先只推一个标题）", p?.title === "备份失败" && p?.body === "host：nas-01\nerror：No space left on device" && p?.collapse === "backup-nightly", show(p ?? {}));
    check("响应 warnings 说其余字段排成了正文", r.json?.data?.warnings?.some((w) => w.includes("其余字段")), r.text);

    r = await send("POST", `/hook/${c.key}/json`, { json: { id: "evt_77", level: "critical", type: "payment.failed", data: { amount: 42, currency: "CNY" } } });
    [p] = take().map(view);
    check("★ /hook/{key}/json：别人家的 id 不当消息 id；level=critical 按严重程度读成时效性",
      r.json?.data?.adapter === "json" && p?.collapse !== "evt_77" && p?.title === "payment.failed" && p?.body.includes("data.amount：42") && p?.level === "time-sensitive", show(p ?? {}));
  }

  // ── Alertmanager ─────────────────────────────────────────────────

  console.log("\n★ Alertmanager：一组告警从触发、部分恢复、重发到全部恢复");
  {
    const d = await newAccount("Alertmanager");
    const now = Date.now();
    const iso = (ms) => new Date(ms).toISOString();
    const cpu = (host, fp, severity, startsAt, extra = {}) => ({
      status: "firing",
      labels: { alertname: "HighCPU", instance: `${host}:9100`, job: "node", severity, env: "prod" },
      annotations: { summary: `${host} CPU 使用率过高`, description: "过去 5 分钟平均 CPU 使用率超过 90%", ...(severity === "critical" ? { runbook_url: "https://runbook.example.com/cpu" } : {}) },
      startsAt: iso(startsAt),
      endsAt: "0001-01-01T00:00:00Z",
      generatorURL: "https://prom.example.com/graph?g0.expr=node_cpu",
      fingerprint: fp,
      ...extra,
    });
    const group = (alerts) => ({
      receiver: "pigeon",
      status: alerts.some((x) => x.status === "firing") ? "firing" : "resolved",
      alerts,
      groupLabels: { alertname: "HighCPU" },
      commonLabels: { alertname: "HighCPU", env: "prod", job: "node" },
      commonAnnotations: {},
      externalURL: "https://am.example.com",
      version: "4",
      groupKey: '{}/{env="prod"}:{alertname="HighCPU"}',
      truncatedAlerts: 0,
    });
    const db1 = cpu("db-01", "b1a2c3d4e5f60718", "critical", now - 90_000);
    const db2 = cpu("db-02", "c2b3d4e5f6071829", "critical", now - 80_000);
    const web3 = cpu("web-03", "d3c4e5f60718293a", "warning", now - 60_000);

    let r = await send("POST", `/hook/${d.key}/alertmanager`, { json: group([db1, db2, web3]) });
    let pushed = take().map(view);
    check("★ 三条告警 → 三条通知，id 是 am-{fingerprint}", pushed.map((x) => x.collapse).join(",") === "am-b1a2c3d4e5f60718,am-c2b3d4e5f6071829,am-d3c4e5f60718293a", pushed.map((x) => x.collapse).join(","));
    check("★ critical → 时效性，warning → 普通", pushed.map((x) => x.level).join(",") === "time-sensitive,time-sensitive,active", pushed.map((x) => x.level).join(","));
    check("★ 标题「🔴 触发 · HighCPU」，副标题写机器、严重程度、本组 3 条触发", pushed[0]?.title === "🔴 触发 · HighCPU" && pushed[0]?.subtitle === "db-01:9100 · critical · 本组 3 条触发" && pushed[0]?.body === "db-01 CPU 使用率过高\n过去 5 分钟平均 CPU 使用率超过 90%", show(pushed[0] ?? {}));
    check("★ 同一组叠在一起（thread-id 相同）", pushed.every((x) => x.thread === pushed[0]?.thread && x.thread?.startsWith("alertmanager-")), pushed.map((x) => x.thread).join(","));
    check("点开：有 runbook_url 用它，没有用 generatorURL", pushed[0]?.payload.url === "https://runbook.example.com/cpu" && pushed[2]?.payload.url === "https://prom.example.com/graph?g0.expr=node_cpu");
    check("响应逐条列出 id、status、delivered", r.status === 200 && r.json?.data?.messages?.length === 3 && r.json.data.delivered === 3 && r.json.data.messages.every((m) => m.status === "firing" && m.delivered === 1), r.text);

    // 几分钟后 Alertmanager 把整组再发一遍：db-01 恢复了，nas-01 新来一条，db-02 和 web-03 还在触发（startsAt 不变）
    const nas = { ...cpu("nas-01", "e4d5f60718293a4b", "critical", now - 20_000), labels: { alertname: "HighCPU", instance: "nas-01:9100", job: "node", severity: "critical", env: "prod" } };
    const db1Resolved = { ...db1, status: "resolved", endsAt: iso(now + 17 * 60_000) };
    r = await send("POST", `/hook/${d.key}/alertmanager`, { json: group([db1Resolved, db2, web3, nas]) });
    pushed = take().map(view);
    check("★ 组里有变化：只推新来的和刚恢复的，还在触发的两条不再响", pushed.map((x) => `${x.collapse}:${x.payload.status}`).join(",") === "am-e4d5f60718293a4b:firing,am-b1a2c3d4e5f60718:resolved", pushed.map((x) => `${x.collapse}:${x.payload.status}`).join(","));
    check("★ 新的那条里点名同组仍在触发的", pushed[0]?.body.includes("同组仍在触发：db-02:9100、web-03:9100"), pushed[0]?.body);
    check("★ 恢复：静默、标题「🟢 恢复」、正文写持续多久，原地替换触发时那条（同一个 collapse id）",
      pushed[1]?.level === "passive" && pushed[1]?.title === "🟢 恢复 · HighCPU" && pushed[1]?.body.endsWith("持续 19 分钟") && pushed[1]?.collapse === "am-b1a2c3d4e5f60718", show(pushed[1] ?? {}));
    check("副标题的计数跟着变：本组 3 条触发 · 1 条恢复", pushed[0]?.subtitle === "nas-01:9100 · critical · 本组 3 条触发 · 1 条恢复", pushed[0]?.subtitle);
    check("响应里说有 2 条没变、没重推", r.json?.data?.unchanged === 2, r.text);

    // repeat_interval 到了：组里没有变化，Alertmanager 整组再发一遍提醒「还没好」
    await send("POST", `/hook/${d.key}/alertmanager`, { json: group([db2, web3, nas]) });
    pushed = take().map(view);
    check("★ 没有变化的重发：整组照推（不漏）", pushed.map((x) => x.collapse).sort().join(",") === "am-c2b3d4e5f6071829,am-d3c4e5f60718293a,am-e4d5f60718293a4b", pushed.map((x) => x.collapse).join(","));

    // 通道默认值带重复提醒：还在响的那条恢复时，提醒随之停下
    await send("PATCH", `/account/${d.id}/channels/${d.channelId}`, { json: { defaults: { repeat: "5" } }, headers: { authorization: `Bearer ${d.secret}` } });
    const disk = { ...cpu("db-05", "f5e6071829304a5b", "critical", now - 10_000), labels: { alertname: "DiskFull", instance: "db-05:9100", severity: "critical" } };
    r = await send("POST", `/hook/${d.key}/alertmanager`, { json: { ...group([disk]), groupKey: '{}:{alertname="DiskFull"}', groupLabels: { alertname: "DiskFull" }, commonLabels: {} } });
    const repeat = r.json?.data?.messages?.[0]?.repeat;
    check("★ 通道默认要重复提醒：告警排上了（响应里有 repeat，id 就是 am-{fingerprint}）", repeat?.every === 5 && repeat?.id === "am-f5e6071829304a5b", r.text);
    const reminded = take().map(view)[0];
    check("推出去的 payload 带 repeat、个人通道「知道了，别再提醒」的按钮类别", reminded?.payload.repeat === "5" && reminded?.payload.aps?.category === "pigeonNotification.remind", JSON.stringify(reminded?.payload.aps));

    r = await send("POST", `/hook/${d.key}/alertmanager`, { json: group([db2, web3, nas].map((x) => ({ ...x, status: "resolved", endsAt: iso(now + 26 * 60_000) }))) });
    pushed = take().map(view);
    check("★ 全部恢复：三条恢复消息，都静默、不带 repeat", pushed.length === 3 && pushed.every((x) => x.level === "passive" && x.payload.status === "resolved" && x.payload.repeat === undefined), pushed.map(show).join(" | "));
    check("恢复的副标题写「3 条恢复」", pushed[0]?.subtitle === "db-02:9100 · critical · 3 条恢复", pushed[0]?.subtitle);
  }

  // ── MCP ──────────────────────────────────────────────────────────

  console.log("\n★ MCP：上一代协议，initialize → notifications/initialized → tools/list → tools/call");
  {
    const e = await newAccount("MCP");
    const mcp = (message, headers = {}) =>
      send("POST", `/mcp/${e.key}`, { json: message, headers: { accept: "application/json, text/event-stream", ...headers } });
    let r = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { roots: {} }, clientInfo: { name: "e2e-client", version: "1.0.0" } } });
    check("★ initialize：回同一版本、serverInfo、tools 能力、给 AI 的说明",
      r.status === 200 && r.json?.id === 1 && r.json?.result?.protocolVersion === "2025-06-18" && r.json.result.serverInfo?.name === "pigeon" && r.json.result.capabilities?.tools && r.json.result.instructions?.includes("notify"), r.text);
    check("无状态：不发会话 id，回的是 application/json", r.headers.get("mcp-session-id") === null && (r.headers.get("content-type") ?? "").startsWith("application/json"));
    r = await mcp({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-protocol-version": "2025-06-18" });
    check("notifications/initialized → 202 空响应", r.status === 202 && r.text === "", `${r.status} ${r.text}`);
    r = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-protocol-version": "2025-06-18" });
    const tool = r.json?.result?.tools?.[0];
    check("★ tools/list：一个 notify，参数表和推送接口一致", r.json?.result?.tools?.length === 1 && tool?.name === "notify" && ["title", "body", "level", "url", "id", "status", "repeat"].every((k) => tool.inputSchema?.properties?.[k]), r.text.slice(0, 300));
    take();
    r = await mcp(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "notify", arguments: { title: "重构跑完了：214 个测试全过", body: "改了 **12** 个文件，等你看一眼 PR", url: "https://git.example.com/pr/231", id: "agent-task-7", level: "timeSensitive" } } },
      { "mcp-protocol-version": "2025-06-18" },
    );
    let [p] = take().map(view);
    check("★ tools/call notify：推到了手机上，标题、正文、链接、级别照给的", p?.title === "重构跑完了：214 个测试全过" && p?.body === "改了 **12** 个文件，等你看一眼 PR" && p?.payload.url === "https://git.example.com/pr/231" && p?.level === "time-sensitive" && p?.collapse === "agent-task-7", show(p ?? {}));
    check("★ 结果：文字说明 + structuredContent（id、送达几台）", r.json?.result?.isError === undefined && r.json.result.content?.[0]?.text?.includes("送达 1/1 台设备") && r.json.result.structuredContent?.id === "agent-task-7" && r.json.result.structuredContent.delivered === 1, r.text);
    r = await mcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "notify", arguments: { title: "PR 已合并", id: "agent-task-7", status: "resolved" } } }, { "mcp-protocol-version": "2025-06-18" });
    [p] = take().map(view);
    check("同一个 id 推 status=resolved：原地替换、带 status", p?.collapse === "agent-task-7" && p?.payload.status === "resolved" && r.json?.result?.structuredContent?.id === "agent-task-7", show(p ?? {}));
    r = await mcp({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "notify", arguments: { title: "x", level: "urgent" } } }, { "mcp-protocol-version": "2025-06-18" });
    check("★ 参数不对：isError + 中文原因（AI 看得到、能自己改），不推", r.status === 200 && r.json?.result?.isError === true && r.json.result.content?.[0]?.text?.includes("level 只能是") && take().length === 0, r.text);
    r = await mcp({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "send_sms", arguments: {} } }, { "mcp-protocol-version": "2025-06-18" });
    check("工具名不对 → JSON-RPC -32602", r.json?.error?.code === -32602 && r.json?.id === 6, r.text);
  }

  console.log("\n★ MCP：新一代协议（2026-07-28），key 放在 Authorization 里");
  {
    const e = await newAccount("MCP 新协议");
    const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
    const call = (id, method, params = {}, extra = {}) =>
      send("POST", "/mcp", {
        json: { jsonrpc: "2.0", id, method, params: { ...params, _meta: meta } },
        headers: { authorization: `Bearer ${e.key}`, "mcp-protocol-version": "2026-07-28", "mcp-method": method, ...extra },
      });
    let r = await call(1, "server/discover");
    check("★ server/discover：支持的版本、能力、可缓存", r.status === 200 && r.json?.result?.supportedVersions?.includes("2026-07-28") && r.json.result.supportedVersions.includes("2025-06-18") && r.json.result.resultType === "complete" && r.json.result._meta?.["io.modelcontextprotocol/serverInfo"]?.name === "pigeon", r.text);
    r = await call(2, "tools/list");
    check("tools/list：带 ttlMs、cacheScope", r.json?.result?.tools?.[0]?.name === "notify" && r.json.result.ttlMs > 0 && r.json.result.cacheScope === "public", r.text.slice(0, 200));
    take();
    r = await call(3, "tools/call", { name: "notify", arguments: { title: "长任务卡住了", body: "迁移脚本在第 3 步等你确认" } }, { "mcp-name": "notify" });
    const [p] = take().map(view);
    check("★ tools/call（Mcp-Name 头和工具名一致）：推到了", r.json?.result?.structuredContent?.delivered === 1 && p?.title === "长任务卡住了" && p?.body === "迁移脚本在第 3 步等你确认", `${r.text} ${show(p ?? {})}`);
    r = await call(4, "tools/call", { name: "notify", arguments: { title: "x" } }, { "mcp-name": "other" });
    check("★ Mcp-Name 头和请求体对不上 → 400 -32020，不推", r.status === 400 && r.json?.error?.code === -32020 && take().length === 0, r.text);
  }

  // ── 命令包装器 ───────────────────────────────────────────────────

  console.log("\n★ 命令包装器 pigeon.sh：从这台机器的 sh + curl 推到真跑的 Worker");
  {
    const f = await newAccount("命令包装器");
    const home = mkdtempSync(join(tmpdir(), "pigeon-l1-home-"));
    const noProxy = "localhost,127.0.0.1,::1";
    // 必须异步地跑：假 APNs 就在这个进程里，同步等子进程会把它也卡住，Worker 推不出去、curl 干等到超时
    const pigeon = (args, env = {}) =>
      new Promise((resolve) => {
        const child = spawn("sh", [join(ROOT, "tools/pigeon.sh"), ...args], {
          env: { PATH: process.env.PATH, HOME: home, NO_PROXY: noProxy, no_proxy: noProxy, PIGEON_KEY: f.key, PIGEON_SERVER: base, ...env },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (c) => (stdout += c));
        child.stderr.on("data", (c) => (stderr += c));
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      });
    let out = await pigeon(["send", "备份完成", "用了 3 分钟"]);
    let [p] = take().map(view);
    check("★ pigeon send：标题、正文", out.status === 0 && p?.title === "备份完成" && p?.body === "用了 3 分钟", `${out.status} ${out.stderr} ${show(p ?? {})}`);

    out = await pigeon(["run", "--id", "nightly", "--", "sh", "-c", "echo 开始同步; echo 连接数据库失败 >&2; exit 3"]);
    [p] = take().map(view);
    check("★ pigeon run 失败：退出码原样传出，推「❌ 失败」、时效性、status=firing", out.status === 3 && p?.title?.startsWith("❌ 失败 · sh -c") && p?.level === "time-sensitive" && p?.payload.status === "firing" && p?.collapse === "nightly", `${out.status} ${show(p ?? {})}`);
    check("正文有退出码和最后几行输出（标准错误也在）", p?.body?.includes("退出码 3") && p.body.includes("开始同步") && p.body.includes("连接数据库失败"), p?.body);
    check("命令的输出照常显示在终端上", out.stdout.includes("开始同步") && out.stdout.includes("连接数据库失败"), out.stdout);

    out = await pigeon(["run", "--id", "nightly", "--quiet", "--", "true"], { PIGEON_KEY: `${base}/${f.key}` });
    [p] = take().map(view);
    check("★ 再跑成功（key 写成整个推送地址也行）：推「✅ 成功」、status=resolved、--quiet 静默，原地替换失败那条", out.status === 0 && p?.title === "✅ 成功 · true" && p?.payload.status === "resolved" && p?.level === "passive" && p?.collapse === "nightly", `${out.status} ${out.stderr} ${show(p ?? {})}`);
    rmSync(home, { recursive: true, force: true });
  }
} catch (err) {
  failures++;
  console.log(`  ✗ 测试中途出错：${err instanceof Error ? err.stack : String(err)}`);
  console.log(live.log().slice(-1500));
} finally {
  await live.stop();
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
