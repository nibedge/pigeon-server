import { DOC_STYLE } from "./docstyle";
import { escapeHtml } from "./invite";
import { pageMeta } from "./seo";

/**
 * 文档站：https://nfo.im/docs
 *
 * 一页写完，按节排：每节是一段 Markdown（DOC_SECTIONS 里的一项），渲染成 HTML 时套用隐私政策、帮助页那套样式。
 * 以后加内容就在 DOC_SECTIONS 里追加一节 —— README 里新写的接口说明原样贴进来就能用（{site} 换成当前域名）。
 * 这一页和 README 讲同一套功能：README 给读源码的人、写得更全，这里按功能分节给接入的人；改了接口两边一起改
 * （test/api-l1-docs.test.mjs 核对 README 参数表里的每个参数、README 列出的每个接口，这里都讲到了）。
 * 渲染器只认这里用到的几种写法（见 renderMarkdown），不是完整的 Markdown。
 *
 * 示例命令照抄就要能用：test/api-l1-docs.test.mjs 把每一条 curl https://{site}/{key}… 用真的 curl 跑一遍。
 * 页面没有脚本，CSP 按 script-src 'none' 出。
 */

export interface DocSection {
  /** 锚点：/docs#id，/docs/id 也跳到这里 */
  id: string;
  title: string;
  /** Markdown。{site} 换成当前域名；代码块用 ~~~ 围起来（模板字符串里少写反引号） */
  md: string;
}

export const DOCS_UPDATED = "2026-09-27";

export const DOC_SECTIONS: DocSection[] = [
  {
    id: "start",
    title: "快速开始",
    md: `
信鸽把一次 HTTP 请求变成一条 iOS 通知。每个通道有一个推送地址 \`https://{site}/{key}\`，在信鸽 App 的通道设置里复制；\`{key}\` 是地址最后那一段，拿到它的人都能往这个通道推送，别公开贴出来。

~~~
curl https://{site}/{key}/服务器挂了
curl https://{site}/{key} --data-urlencode "title=磁盘告警" --data-urlencode "body=剩余 3%"
curl https://{site}/{key} -H 'content-type: application/json' -d '{"title":"发版完成","body":"v2.3 已上线","tags":"white_check_mark"}'
~~~

接下来看你手里有什么：

- 一个会发 webhook 的服务（GitHub、Grafana、Uptime Kuma、Alertmanager……）：用[适配器](#adapters)，不写代码。
- 一个原本推到群机器人、或者别家推送服务的工具：[换个域名就行](#compat)。
- 好几个来源往同一个通道推：给每个来源一个[发送令牌](#tokens)，通知上写着「来自：NAS」，哪个吵就停哪个，不必把通道的 key 交出去。
- 一条定时任务：用[心跳](#heartbeat)盯着它有没有按时跑完；网站和定时任务的暂停、维护窗口、可用率见[监控管理](#watches)。
- 一条要跑很久的命令：用[命令包装器](#cli)，跑完把成败推过来。
- 一个 AI 助手、编码助手：用 [MCP](#mcp) 让它自己推。
- 要紧的事：[重复提醒](#repeat)到有人处理为止；进行中的事挂在锁屏和灵动岛上，用[实时活动](#live)。
- 想在通知上直接处理（回滚、复制单号、回一句话），想让脚本知道谁几点处理了：[通知按钮](#actions)、[回执与回调](#receipts)。
- 一家人、一个值班组一起收：[群组](#groups)。
- 不想让服务器看到内容：用[端到端加密](#e2e)。
`,
  },
  {
    id: "params",
    title: "参数",
    md: `
参数可以放在路径、query、请求头、请求体（JSON 或表单）里，后面的覆盖前面的，路径最优先；通道在 App 里设过的默认值垫在最底下。参数名不分大小写。

| 参数 | 说明 |
|---|---|
| \`title\` | 标题 |
| \`subtitle\` | 副标题。也可以叫 \`summary\` \`short\` |
| \`body\` | 正文，App 里按 Markdown 显示（加粗、链接）。也可以叫 \`text\` \`message\` \`content\` \`msg\` \`desp\` \`description\` |
| \`markdown\` | 只给了它、没给 \`body\` 时当正文 |
| \`level\` | \`passive\` 静默 · \`active\` 普通（默认） · \`timeSensitive\` 时效性，专注模式下也会提醒 · \`critical\`（未获 Apple 授权前按时效性送）。critical 只突破通道创建者、以及自己允许了的群成员的免打扰，其余成员按时效性收到，见[群组](#groups) |
| \`sound\` | 铃声；不给就用系统默认，\`none\` 静音。接收者给这个通道选过铃声的，以接收者选的为准 |
| \`url\` | 点通知打开的链接 |
| \`group\` | 通知中心里的分组；不给就按通道分组 |
| \`tags\` | 逗号或竖线分隔，最多 5 个。认得的表情短码（\`warning\` \`rotating_light\` \`white_check_mark\`…）显示成表情 |
| \`image\` | 大图地址（https，10 MB 以内） |
| \`icon\` | 小图地址（https，2 MB 以内），通知右侧的缩略图 |
| \`copy\` | 要一键复制的内容；没给时 App 会自己认验证码 |
| \`autoCopy\` | \`1\`：展开通知或点开 App 时自动复制 \`copy\` |
| \`isArchive\` | \`0\`：不存进 App 历史 |
| \`id\` | 同一件事的标识（64 字节以内）。同 id 的新消息原地替换旧的；撤回、停止重复提醒、实时活动、回执也靠它 |
| \`status\` | \`firing\` / \`resolved\`：同一个 \`id\` 从进行中变成已恢复，App 算出持续了多久 |
| \`repeat\` | 每隔几分钟再提醒一次（5–60），直到有人处理，最长一小时。见[重复提醒与认领](#repeat) |
| \`live\` | \`1\`：带 \`id\` 的 \`status=firing\` 在接收者的锁屏和灵动岛上开一个实时活动，见[实时活动](#live)；\`0\`：这条不开（盖过通道默认值） |
| \`actions\` | 通知上的按钮，最多 3 个：打开链接、复制、由服务端代发请求、回一句话。见[通知按钮](#actions) |
| \`callback\` | 事件回调地址（https）：有人认领、点了按钮、重复提醒响到头还没人认领时，服务端 POST 一条签名事件过去。不进推送内容。见[回执与回调](#receipts) |
| \`delete\` | \`1\`：撤回同 \`id\` 的消息，必须带 \`id\` |
| \`ciphertext\` \`iv\` | 端到端加密的内容，见[端到端加密](#e2e) |

\`badge\` \`call\` \`volume\` \`ttl\` \`action\`，以及和 \`body\` 一起给的 \`markdown\`，认得但这一版不生效，会列在响应的 \`data.ignored\` 里。

### 写法

- 路径式：\`/{key}/{正文}\`、\`/{key}/{标题}/{正文}\`、\`/{key}/{标题}/{副标题}/{正文}\`。只适合没有空格和特殊字符的短句。
- 内容里有空格，或者 \`&\` \`#\` \`+\` \`%\` \`/\` \`?\` 这些字符时，别拼进地址，用 \`--data-urlencode\` 或 JSON。
- 请求体直接是一句话也行：\`curl -d "磁盘满了"\` 整句当正文。
- JSON 里有标题、没有正文字段的，其余字段排成「键：值」当正文；有正文、没有标题的，\`subject\` 当标题。什么都认不出的按[通用 JSON](#adapters)取。
- 请求头认 \`Title\`、\`Priority\`（\`1\`–\`5\` 或 \`min\` \`low\` \`default\` \`high\` \`max\` \`urgent\`）、\`Tags\`、\`Click\`、\`Id\`，标题可以直接写中文。
- 开关参数（\`isArchive\` \`autoCopy\` \`delete\` \`live\`）写 \`true\` / \`false\` / \`yes\` / \`no\` 等同 \`1\` / \`0\`。
- key 也可以放在 \`Authorization: Bearer {key}\` 里，地址写根路径 \`https://{site}/\`，免得 key 进各种日志。凡是能写 key 的地方都可以换成[发送令牌](#tokens)。
- 批量：\`POST https://{site}/push\`，JSON 里给 \`device_keys\`（一次最多 20 个），其余参数同上；每个 key 的结果（\`id\`、\`warnings\`、\`truncated\`、\`live\`）逐个列在 \`data.results\` 里。

~~~
curl https://{site}/{key} -H "Title: 磁盘告警" -H "Priority: 4" -d "剩余 3%"
curl https://{site}/ -H "Authorization: Bearer {key}" --data-urlencode "body=key 不在地址里"
~~~
`,
  },
  {
    id: "responses",
    title: "返回码",
    md: `
都是 JSON：\`{"code": 状态码, "message": "说明", "data": {…}, "timestamp": 秒}\`。\`data.id\` 是这条消息的 id（没给就由服务端生成）；\`data.delivered\` / \`data.devices\` 是送到了几台、一共几台；\`data.warnings\` 是中文提示（截短了什么、发送令牌的限制改了什么）；\`data.ignored\` 是这一版不生效的参数；要了实时活动时 \`data.live\` 是开出了几个（\`started\`），恢复、撤回时是收起了几个（\`ended\`）。

| 状态码 | 意思 |
|---|---|
| 200 | 收下了。\`data.suppressed\` 为 \`"duplicate"\` 是和刚才那条一样、被去重合并了，不必重发；\`quieted\` 说明赶上了通道的免打扰时段，\`muted\` 是因为接收者静音了这个通道、或者给它设了更高的最低提醒级别而静默送达的设备数 |
| 400 | 请求本身有问题：没有内容可推、只收加密的通道收到了明文、撤回没带 \`id\`、按钮或回调地址写错了，\`message\` 里写着原因 |
| 403 | 这个通道已被停用，或者这个发送令牌被通道的创建者停用了 |
| 404 | key 不存在：检查推送地址有没有抄错 |
| 410 | 地址已停用：通道换了推送地址、或者删掉了这个发送令牌（30 天内都这样回）。也可能是这个通道下没有能收的设备 —— 在手机上重新打开 App 即可恢复。\`message\` 写明是哪一种 |
| 413 | 太长：请求体超过 64 KB（\`/hook\` 和兼容地址 1 MB），或者截短文字之后仍然放不下 |
| 429 | 发得太频繁：每个通道每分钟最多 60 条，发送令牌还可以有自己的每分钟上限，带 \`Retry-After\` |
| 502 | 服务端或 Apple 的问题，不是你的请求出错，稍后再试 |

群机器人格式的请求按原来那一家的样子回话，见[兼容别家格式](#compat)；MCP 回 JSON-RPC，见 [MCP](#mcp)。
`,
  },
  {
    id: "tokens",
    title: "发送令牌：给每个来源一个地址",
    md: `
一个通道除了自己的推送地址，还可以发出最多 10 个发送令牌：给 NAS 一个、给 Grafana 一个、给家里人的网页链接一个。每个令牌有名字，推出去的通知上写着「来自：NAS」（payload 带 \`from\`，重复提醒的补发也带）；可以单独停用、限定最高级别和每分钟条数，哪个来源最吵也看得出来。令牌只能推送，看不到通道收到的其他消息，也改不了任何设置。在 App 的通道设置里「发送令牌」一节新建。

令牌长这样：\`st_\` 加 43 个字符。凡是能写 key 的地方都能用它：路径、\`Authorization: Bearer\`、\`/push\`、\`/hook/{令牌}/…\`、群机器人的兼容地址、\`/mcp/{令牌}\`、回执查询、[加密工具](#e2e)。

~~~
curl https://{site}/st_xxxx/备份完成
curl https://{site}/ -H "Authorization: Bearer st_xxxx" -d "磁盘满了"
curl https://{site}/hook/st_xxxx/grafana -H 'content-type: application/json' -d @alert.json
~~~

- **最高级别**：\`passive\` / \`active\` / \`timeSensitive\`。高于它的按它送，响应的 \`warnings\` 里写明；设在 \`active\` 及以下的，也不能要求重复提醒。
- **每分钟条数**：1–60。超了回 429，不占通道每分钟 60 条的额度 —— 一个吵闹的来源先被拦下，别的照常推得进来。Alertmanager 一组里单独推出去的每一条都算一条。
- **停用**：推送回 403「已被通道的创建者停用」，恢复之后照常能用。
- **消息 id**：令牌推的消息，id 前面自动加上这个令牌的前缀（\`~\` + 8 个字符 + \`~\`，响应里的 \`id\` 就是加过的；加上之后超过 64 字节的换成摘要）。同一个令牌之后带原来的 id 或响应里的 id 都行 —— 替换、撤回、\`status=resolved\`、查回执；别的来源用了同一个 id 也互不影响：令牌碰不着群主和别的令牌推的消息，也查不到它们的回执。用推送 key 查令牌推的消息，要用加过前缀的 id。
- **按钮**：令牌推的消息可以带打开链接、复制和不带地址的[按钮](#actions)；要服务端代发请求的按钮（\`http\`、带地址的 \`reply\`）回 400 —— 代发的请求带着通道回调密钥的签名，去哪、带什么只能由通道的创建者定：用推送 key 推，或者请他设成通道默认按钮。
- **令牌明文只在新建时给一次**：服务端只存它的 SHA-256，丢了就删掉重建。
- **网页**：每个令牌还有一个 \`https://{site}/s/{令牌}\`，打开先写明「发给：{通道名}」，只能填标题、内容和级别，适合发给不写代码的人。令牌停用、删掉之后这一页直接说「已停用」「已失效」；通道只收加密消息时，这一页打开就说发不了（网页发出的是明文）。

**换了推送地址之后**（App 里「更换推送地址」，即 \`POST /account/{id}/channels/{cid}/key\`），旧地址立即失效，30 天内再用它推的收到 410「地址已停用：请到 App 里复制新地址」，而不是「key 不存在」；通道的创建者一天最多收到一条静默提醒「旧地址还有人在用」，写明请求从哪个入口、用什么程序发来（比如「路径式推送，curl/8.4.0」），方便找出还没换地址的脚本。删掉的发送令牌同样处理。

管理接口只有通道的创建者能调（成员 403），请求头 \`Authorization: Bearer {账号凭据}\`：

| 接口 | 说明 |
|---|---|
| \`GET /account/{id}/channels/{cid}/tokens\` | 全部令牌，不含明文：\`{"tokens": [{id, name, hint, max_level?, per_minute?, disabled, created_at, count, last_used_at?}], "limit": 10}\` |
| \`POST /account/{id}/channels/{cid}/tokens\` | 新建：\`{"name", "max_level"?, "per_minute"?}\`，名字 20 字以内、同一通道不重名；回 \`{"token", "value": "st_…", "push_url", "page_url"}\` |
| \`PATCH /account/{id}/channels/{cid}/tokens/{tid}\` | 改 \`name\`、\`max_level\`、\`per_minute\`（给 \`null\` 去掉限制）、\`disabled\` |
| \`DELETE /account/{id}/channels/{cid}/tokens/{tid}\` | 删除；之后 30 天里还用它推的收到 410 |
`,
  },
  {
    id: "adapters",
    title: "适配器：直接接第三方 webhook",
    md: `
\`POST https://{site}/hook/{key}/{适配器}\`，把这个地址填进对应服务的 webhook 设置，不用写转换代码。

| 适配器 | 说明 |
|---|---|
| \`github\` | 构建失败、需要审批、PR 与 Issue、Release、push。Content type 选 \`application/json\`，事件勾上 Workflow runs、Issues、Pull requests、Releases |
| \`grafana\` | 告警触发与恢复，同一组告警合并成一件事、显示持续时长。建好 contact point 后要在 Notification policies 里挂上 |
| \`uptimekuma\` | 掉线与恢复、证书快到期。要在每个监控项里勾上这条通知 |
| \`alertmanager\` | 每条告警单独一条消息：按 fingerprint 各自计时、各自恢复；严重程度决定提醒强度；点开是 runbook 或告警来源 |
| \`json\` | 任意 JSON：标题取 title、name、event、status 这类常见字段，正文取前 6 个字段，排成「键：值」 |

地址里的 key 可以换成[发送令牌](#tokens)：推出去的每一条都带「来自：{令牌名}」、按令牌的限制收。

### Alertmanager

~~~
receivers:
  - name: pigeon
    webhook_configs:
      - url: https://{site}/hook/{key}/alertmanager
        send_resolved: true
~~~

- 每条告警的 \`id\` 是 \`am-{fingerprint}\`：几台机器上同名的告警各算各的，一台恢复只了结它自己。
- \`severity\` 是 \`critical\` 的按时效性提醒，\`warning\` 普通，\`info\` 静默；恢复一律静默。
- 一组有好几条时，副标题写着「本组 3 条触发」，通知中心里按组叠在一起。组里有新告警加入、有告警恢复时，只推新的和恢复的；已经推过、还在触发的不再响一遍，在新消息里点名。推过哪几条按组记在服务端（只有告警指纹和触发时刻）；没推出去的不记，下次照推。
- 组里什么都没变的重发（\`repeat_interval\` 到了）整组照推：那是 Alertmanager 在提醒「还没好」。
- 一次最多推 10 条消息：超出的并成最后一条「另有 N 条」（它不重复提醒）。通道每分钟的额度按条算。
- 点开通知打开 \`runbook_url\`，没有就打开 \`generatorURL\`。

### 任意 JSON

~~~
curl https://{site}/hook/{key}/json -H 'content-type: application/json' -d '{"event":"备份","status":"失败","host":"nas","disk":"/data"}'
~~~

推出去是「备份 · 失败」，正文是 \`host：nas\`、\`disk：/data\`。字段名像凭据的（token、secret、password、sign……）一律不进推送。\`severity\`（或 \`level\`、\`priority\`）按严重程度读：\`critical\`、\`high\` 按时效性提醒，\`info\`、\`low\` 静默送达；请求体里的 \`id\`、\`repeat\` 不当推送参数。直接推到 \`/{key}\` 的 JSON 里没有认得的正文字段时，也按这个规则兜底。
`,
  },
  {
    id: "compat",
    title: "兼容别家格式：换个域名就能迁过来",
    md: `
### 群机器人地址

只会往群机器人发消息的工具（面板、监控、CI、签到脚本），把机器人地址的域名换成 \`{site}\`、把 key 换成信鸽的（或者一个[发送令牌](#tokens)）就行，请求体不用改。信鸽 App 的「通道设置 → 从别的工具迁过来」里列着这个通道的每一条，点一下就复制；把原来的地址粘贴进去，它会认出该换哪条。

| 原来的地址长这样 | 换成 |
|---|---|
| \`https://…/cgi-bin/webhook/send?key=…\` | \`https://{site}/cgi-bin/webhook/send?key={key}\` |
| \`https://…/robot/send?access_token=…\` | \`https://{site}/robot/send?access_token={key}\` |
| \`https://…/open-apis/bot/v2/hook/…\` | \`https://{site}/open-apis/bot/v2/hook/{key}\` |
| \`https://…/api/webhooks/{数字}/…\` | \`https://{site}/api/webhooks/0/{key}\` |
| \`https://…/services/…/…/…\` | \`https://{site}/services/x/{key}\` |

~~~
curl 'https://{site}/cgi-bin/webhook/send?key={key}' -H 'content-type: application/json' -d '{"msgtype":"text","text":{"content":"部署完成\\nv2.3 已上线"}}'
~~~

- 认得四种消息结构：\`{msgtype, text | markdown | link | actionCard | feedCard | news | template_card}\`、\`{msg_type, content: {text | post}, card}\`、\`{content, embeds: [{title, description, url, fields, image}]}\`、\`{text, blocks, attachments}\`。这几种结构的 JSON 直接推到 \`https://{site}/{key}\` 也认。
- 取法：卡片或图文的标题当标题；多行文字第一行当标题、其余当正文；按钮和标题上的链接当点击链接，没有时用名字里带 URL、链接、地址的字段；图片当大图；字段排成「名字：值」。块级的 Markdown 标记换成通知里读得顺的样子（\`#\` 标题、\`>\` 引用去掉，列表换成「• 」，表格一行排成「a · b」），\`<font>\` 这类标签去掉，加粗和链接保留。图文、卡片一次带好几条的，第一条展开，其余列出标题。
- 消息里 @ 了所有人（\`isAtAll\`、\`@all\`、\`<!channel>\`、\`@everyone\`……）的，按时效性提醒。
- 请求里的 \`timestamp\`、\`sign\` 不看：信鸽靠地址里的 key 认人，地址本身就是凭据。
- 回话也按原来那一家的样子：成功回 \`{"errcode":0,"errmsg":"ok"}\`、\`{"code":0,"msg":"success"}\`、\`204\`（带 \`?wait=true\` 时回带 \`id\` 的消息）或纯文字 \`ok\`；失败时 HTTP 状态码照实给（停用的令牌 403、换掉的地址和删掉的令牌 410），原因是中文。
- 地址后面还可以拼信鸽自己的参数，比如 \`&level=passive\`、\`&repeat=5\`、\`&actions=…\`，它们盖过从消息里读出来的。
- 图片、文件、语音这类消息转不过来，只推一句「[图片]」提示。

### 国内推送服务的参数写法

签到脚本、面板、RSS 工具里内置的写法，换掉域名和 key 照样能用：

| 写法 | 信鸽怎么读 |
|---|---|
| \`/{key}.send?title=…&desp=…\` | 地址末尾的 \`.send\` 忽略；\`desp\` 是正文，按 Markdown 读：标题、引用的记号去掉，列表换成「• 」，表格一行排成「a · b」 |
| \`text\` + \`desp\` | \`text\` 是标题、\`desp\` 是正文（只有 \`text\` 时它是正文） |
| \`title\` + \`content\` | 标题 + 正文 |
| \`content\` + \`summary\` | 正文 + 摘要（摘要当副标题） |
| \`template\`、\`contentType\`、\`type\` | 正文的格式：\`html\`（或 \`contentType=2\`）转成文字；\`json\` 排成「键：值」；\`markdown\`（或 \`contentType=3\`）同 \`desp\` 的处理；\`txt\` 照原样；\`type=image\` 时正文是图片地址 |
| \`tags=a\\|b\` | 竖线分隔的标签 |
| \`channel\` \`topic\` \`token\` \`openid\` \`callbackUrl\` \`uids\` … | 别家特有、信鸽用不上：不生效，列在响应的 \`data.ignored\` 里，值不进推送 |

~~~
curl https://{site}/{key}.send --data-urlencode "title=签到成功" --data-urlencode "desp=连续 12 天"
curl https://{site}/{key} -d text=构建完成 --data-urlencode "desp=**main** 分支 · 用时 3 分钟"
~~~
`,
  },
  {
    id: "heartbeat",
    title: "心跳：定时任务有没有按时跑完",
    md: `
在 App 的监控里新建「心跳」，拿到报到地址。定时任务跑完来报个到，过了约定的时间没来就提醒你：

~~~
curl -fsS https://{site}/hb/{id}
curl -fsS https://{site}/hb/{id}/fail -d "磁盘满了"
curl -fsS https://{site}/hb/{id}/start
curl -fsS https://{site}/hb/{id}/$?
~~~

- 报到用 GET、POST、HEAD 都行；报告失败只收 POST（\`-d\` 或 \`-X POST\`），失败会立刻提醒，说明也可以放在 \`?msg=\` 里。
- 按退出码报：\`/hb/{id}/0\` 是正常报到，\`1\`–\`255\` 是失败，提醒里写「退出码 N」。\`curl …/$?\` 默认是 GET，也收。
- \`/start\` 记下开始跑的时刻：下一次报到（正常、失败、退出码都算）的回应里带 \`duration_ms\`，提醒里写「这次用时 3 分 20 秒」；开始了却一直没报到的，「没有按时上报」里会多一句「这一轮已经跑了 40 分钟，还没结束」，分得清是没跑起来还是跑起来卡住了。\`/start\` 本身不算报到；离上次记下的开始不到 4 分钟的不记。
- 第一次报到之前不会提醒；失联只提醒一次，任务回来报到时推「恢复」。
- 地址贴进聊天时，链接预览和浏览器预取不算报到，也不会替你报失败。
- 和[命令包装器](#cli)一起用：\`pigeon run -- ./backup.sh && curl -fsS https://{site}/hb/{id}\`，失败时有详细输出，成功时只报到。

一个脚本从头到尾这样接：

~~~
curl -fsS https://{site}/hb/{id}/start
./backup.sh
curl -fsS https://{site}/hb/{id}/$?
~~~

网站监控也在 App 的监控里建：从 Cloudflare 的境外节点访问，每次最多等 5 秒，连续两次失败才推「掉线了」。暂停、每周的维护窗口、立即检测、历史和可用率见[监控管理](#watches)。
`,
  },
  {
    id: "watches",
    title: "监控管理：暂停、维护窗口、立即检测、可用率",
    md: `
这些在 App 的监控详情里都点得到；下面是 App 用的接口，凭账号的 \`Authorization: Bearer {secret}\`，只有监控的创建者能调，别人的一律 404。

| 接口 | 说明 |
|---|---|
| \`GET /account/{id}/watches\` | 我建的全部监控 |
| \`POST /account/{id}/watches\` | 新建：\`kind\`（\`up\` / \`keyword\` / \`heartbeat\`）、\`channelId\`、\`url\`、\`keyword\`、\`present\`、\`intervalMinutes\`、\`graceMinutes\`、\`name\`、\`level\`、\`repeat\`、\`maintenance\` |
| \`PATCH /account/{id}/watches/{wid}\` | 编辑：只放要改的字段，校验和新建一样 |
| \`POST /account/{id}/watches/{wid}/check\` | 立即检测（网址监控） |
| \`GET /account/{id}/watches/{wid}/history?tz=Asia/Shanghai\` | 历史与可用率 |
| \`DELETE /account/{id}/watches/{wid}\` | 删除；它排着的重复提醒一并停掉 |

### 暂停和维护窗口

- \`paused_until\`：毫秒时刻 = 暂停到那时（最长一年），\`0\` = 一直暂停，\`null\` = 恢复。暂停期间网址不抓、心跳不判失联；恢复后心跳重新计时，给一整个「间隔 + 宽限」。
- \`maintenance\`：每周的维护窗口，\`{"days": [7], "start": "03:00", "end": "04:00", "tz": "Asia/Shanghai"}\`，\`null\` 去掉。\`days\` 是窗口开始的那几天（1 = 周一 … 7 = 周日），\`end\` 不晚于 \`start\` 时跨到第二天，两者相同是整整 24 小时。窗口里照常检查、照常记录，只是不推告警。
- 这两段时间里压下的告警不会丢：结束时还没恢复，补推一条并写明「维护窗口内掉线，到现在还没恢复」；期间已经好了就什么都不推。之前推过「掉线了」的事在这期间恢复，照样推「恢复了」，只是静默送达。

### 编辑的规矩

- 掉线（\`up\`）和关键词（\`keyword\`）可以互换；网址监控和心跳不能互相改。心跳改了什么报到地址都不变。
- 换通道时新通道也得是自己建的、没被停用、不是只收加密的。\`level\`、\`repeat\` 给 \`null\` / \`0\` 去掉。
- 名字当初没起的，换网址时跟着换；心跳的宽限当初是缺省值的，改间隔时按新间隔重算。
- 换了盯法（类型、关键词、出现还是消失）按新建处理，第一次检查不提醒；暂停、换通道、换盯法时，原来那件事排着的重复提醒一并停掉。

### 立即检测、历史

- 立即检测回 \`{"result": {"status", "ok", "detail", "response_ms", "checked_at"}, "alerted", "watch"}\`。真的掉线了照样推告警，同一次掉线只推一次。每个监控每分钟最多一次（刚被定时检查过也算），超了回 429；心跳没有网址可查，回 400。
- 历史：\`changes\` 最近 20 次状态变化；\`checks\` 最近 24 小时的每次检查（心跳是每次报到，\`ms\` 是运行用时）；\`daily\` 最近 30 天按 \`tz\` 的日期汇总；\`uptime_24h\` \`uptime_7d\` \`uptime_30d\`。可用率按时长算，暂停期间、维护窗口里的异常不计入，还没有数据时是 \`null\`。
- 监控和心跳的告警 payload 都带 \`watch_id\`，等于监控视图里的 \`ref\`，App 凭它打开监控详情。心跳的 \`ref\` 由报到地址单向推出来，群成员拿不到报到凭据。
`,
  },
  {
    id: "repeat",
    title: "重复提醒与认领",
    md: `
要紧的事可以一直提醒，直到有人处理：

~~~
curl https://{site}/{key} -d id=db-01 -d repeat=5 -d level=timeSensitive --data-urlencode "title=主库连不上" --data-urlencode "body=db-01 无响应"
curl https://{site}/{key} -d id=db-01 -d status=resolved --data-urlencode "body=db-01 已恢复"
curl https://{site}/{key} -d id=db-01 -d delete=1
~~~

- \`repeat\` 是间隔分钟数（5–60，\`1\` / \`true\` 即 5），从第一次推送算起最长一小时。\`passive\` 的消息不重复。
- 停下来的办法：点通知上的「知道了，别再提醒」（个人通道）或「我来处理」（群组）；同一个 \`id\` 推 \`status=resolved\`；或者 \`delete=1\` 撤回。
- 群组里第一个点「我来处理」的人会广播给所有人，各人的原通知原地换成「某某 正在处理」。同一个 \`id\` 推来 \`status=resolved\` 之后，下次再触发要重新有人接手。
- 每个通道同时最多 10 条、同一个人名下的通道加起来最多 30 条在重复提醒；满了的照常送达，只是不再重复，响应里带 \`repeat_skipped\`。
- 推送带了 \`callback\` 的，最后一次提醒也响过了还没人认领时，回调收到一条 \`expired\` 事件，见[回执与回调](#receipts)。
- 撤回（\`delete=1\`）：锁屏和通知中心里的原通知换成「此消息已撤回」，App 历史里删掉这条。已经被人看到的收不回来。
`,
  },
  {
    id: "actions",
    title: "通知按钮",
    md: `
\`actions\` 让通知上带按钮，最多 3 个。长按通知（或在通知里展开）就能直接处理，不用先打开 App；历史里的卡片和详情里也点得到。

~~~
curl https://{site}/{key} -d id=deploy-42 --data-urlencode "title=生产要发版" --data-urlencode "actions=查看=https://ci.example.com/run/42; !回滚=POST https://ci.example.com/rollback/42"
curl https://{site}/{key} -H 'content-type: application/json' -d '{"title":"验证码 482910","body":"有人在登录","actions":[{"type":"copy","label":"复制","value":"482910"},{"type":"reply","label":"回一句","url":"https://bot.example.com/reply"}]}'
~~~

简写是 \`名字=目标\`，分号或换行隔开；名字前加 \`!\` 是危险操作（红色、点之前要解锁手机）：

| 简写 | 按钮 |
|---|---|
| \`查看=https://…\` | 打开链接 |
| \`回滚=POST https://…\` | 由服务端代发请求（\`GET\` \`PUT\` \`PATCH\` \`DELETE\` 同理） |
| \`单号=copy:SF1234\` | 复制 |
| \`回复=reply\` 或 \`回复=reply https://…\` | 弹出输入框回一句话，给了地址就把回复也发过去 |
| \`收到\` | 只有名字：点了只记进回执、发给回调 |

JSON 写法每个按钮的字段：\`type\`（\`open\` \`http\` \`copy\` \`reply\`）、\`label\`（必填，20 字以内）、\`url\`、\`method\`、\`headers\`（最多 8 个，\`Host\`、\`X-Pigeon-*\` 这类由服务端定的不能改；按钮连同请求头会发到每个接收者手机上，\`Authorization\`、\`Cookie\` 这类凭据不收，别的头里也别放密钥 —— 接收方靠[签名](#receipts)确认请求来自信鸽）、\`body\`、\`value\`（\`copy\` 要复制的内容）、\`destructive\`、\`auth\`。

- \`open\`、\`copy\` 在手机上就地完成。\`http\`、\`reply\` 交给服务端代发：payload 里带着按钮定义和服务端签的 \`act_sig\`，点按时 App 原样交回 \`POST /account/{id}/channels/{cid}/actions\`（\`{message_id, index, actions, act_sig, reply_text}\`，回 \`{status, ok, error}\`），服务端确认这组按钮真是这个通道推出去、一个字没改过，再替你去请求。
- 地址只收 https 的公网域名（不收 IP、内网域名、带账号密码的地址、信鸽自己）。代发最多等 5 秒，重定向只跟同主机、同端口的 https，最多 3 跳。
- 按钮的定义算进 4KB 的额度（最多约 1.5KB）；只收加密的通道不收按钮（名字和地址没法加密）：推送带了、设成通道默认值都回 400，打开「只收加密」之前设下的默认按钮也不再随推送下发。写错了当场回 400。
- 代发的请求带上通道回调密钥的签名头（\`X-Pigeon-Timestamp\`、\`X-Pigeon-Signature\`、\`X-Pigeon-Event: action\` 或 \`reply\`，签名绑着方法、地址和事件，核对方法见[回执与回调](#receipts)）。按钮没给 \`body\` 时，\`POST\` / \`PUT\` / \`PATCH\` 发一份说明谁点了什么的 JSON：\`{"event","channel_id","id","by","at","action","index"}\`。
- 点完按钮，那条通知原地换成结果（「回滚 · 200」，没成就写原因，再点就是重试）。群里有人点了，会像认领那样原地广播一条「李四 点了「回滚」· 200」。
- 普通和群组的通知默认还带「30 分钟后再提醒」「本通道静音 1 小时」两个按钮，只在还有空位时补上；接收的人可以在 App 的「设置 → 通知与铃声」里关掉。
`,
  },
  {
    id: "receipts",
    title: "回执与回调",
    md: `
想让脚本知道「谁、几点处理了」，有两条路：回调（即时）和回执（查询、长轮询）。

### 回调

推送时带 \`callback=https://…\`（或者给通道设个默认的），下面这几件事一发生，服务端就 POST 一条带签名的 JSON 事件过去，\`X-Pigeon-Event\` 头就是事件名：

| 事件 | 什么时候 | 额外的字段 |
|---|---|---|
| \`ack\` | 第一个人认领（点了「我来处理 / 知道了」） | \`by\` |
| \`action\` | 有人点了 \`http\` 按钮 | \`by\` \`action\`（按钮名） |
| \`reply\` | 有人点了 \`reply\` 按钮、写了一句 | \`by\` \`action\` \`reply\`（写的原文） |
| \`expired\` | 重复提醒的最后一次也响过了，还是没人认领 | \`reminders\`（连原消息一共响了几次） |

~~~
{"event":"reply","channel_id":"…","id":"deploy-42","by":"李四","at":1700000000000,"action":"回一句","reply":"稍等，我在看"}
~~~

回调只发元数据、不带推送正文，地址本身也不进推送内容。尽力而为：最多等 5 秒、失败不重试 —— 靠回执兜底。通道的创建者可以在 App 的通道设置「通知按钮与回调」里设一个默认回调地址（\`defaults.callback\`），推送自己带的 \`callback\` 优先；默认的 \`callback\`、\`actions\` 保存时就校验，写错了回 400。

### 回执

\`GET https://{site}/{key}/receipt/{消息 id}?wait=0..60&since=毫秒\`，用推送的 key 或发送令牌鉴权（能推的人才查得到；令牌只查得到自己推的消息）：

~~~
curl "https://{site}/{key}/receipt/deploy-42?wait=30"
~~~

返回 \`{acked_by, acked_at, actions: [{by, at, label, type, status, ok, reply}]}\`。\`wait\` 大于 0 时长轮询：有人认领或点按钮就立刻返回，到点还没有就返回当前状态；接着等下一件事时把最晚的 \`at\` 作为 \`since\` 带上。回执存在各地机房的缓存里，别处刚发生的事可能要约一分钟才查得到，所以长轮询头几秒每两三秒看一次、之后每 10 秒看一次 —— 要即时就用回调。每个通道每分钟最多查 60 次，回执保留 7 天。

### 签名

回调和代发的按钮请求都带这几个头，签名用的是通道回调密钥（只有创建者看得到、能重置，App 里在通道设置的「通知按钮与回调」）：

~~~
X-Pigeon-Timestamp: <秒级时间戳>
X-Pigeon-Signature: sha256=<hex(HMAC-SHA256(通道回调密钥, 时间戳 + "\\n" + 方法 + "\\n" + 完整地址 + "\\n" + 事件 + "\\n" + 请求体))>
X-Pigeon-Event: ack | action | reply | expired
User-Agent: Pigeon-Callback/1
~~~

签名绑着这一次请求的方法、完整地址和事件名。完整地址就是信鸽请求的那个地址：\`https://\` + 主机名 + 路径和查询（主机名小写、默认端口不写、\`#\` 之后的不算），也就是你这个接收地址本身 —— 别处收到的签名挪到你这里、改了 \`X-Pigeon-Event\`，都核对不过。核对时请求体要用收到的原始字节（没有请求体时那一段是空的），地址用你对外公开的那个（放在反向代理后面时别拿内网看到的地址），5 分钟以外的时间戳当重放丢掉：

~~~
import hashlib, hmac, time
def from_pigeon(secret, headers, method, url, raw_body):
    ts = headers["X-Pigeon-Timestamp"]
    signed = f"{ts}\\n{method}\\n{url}\\n{headers['X-Pigeon-Event']}\\n".encode() + raw_body
    expected = "sha256=" + hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, headers["X-Pigeon-Signature"]) and abs(time.time() - int(ts)) < 300
~~~

创建者也可以用接口读取、重置这把密钥：\`GET\` / \`POST /account/{id}/channels/{cid}/callback-secret\`（\`Authorization: Bearer {账号凭据}\`；\`POST\` 重置，旧的立即失效）。
`,
  },
  {
    id: "live",
    title: "实时活动（灵动岛）",
    md: `
一件事从出事到恢复，一直挂在锁屏和灵动岛上：「主库连不上 · 已持续 12:34」，按秒走；群里有人认领就换成「张三 正在处理」；恢复了定格成「已恢复 · 持续 18 分钟」，15 分钟后收起。

~~~
curl https://{site}/{key} -d id=db-01 -d status=firing -d live=1 -d level=timeSensitive --data-urlencode "title=主库连不上"
curl https://{site}/{key} -d id=db-01 -d status=resolved --data-urlencode "body=已恢复"
~~~

- 只认发送方给的 \`id\`：恢复、认领、撤回都靠它找到那一块。同一个 \`id\` 在进行中再推 \`firing\` 不会叠出第二块；恢复、撤回不用带 \`live\`，撤回（\`delete=1\`）立即收起。
- 接收者这边：iOS 17.2 及以上，App 的「设置 → 事件用实时活动显示」开着（默认开），系统设置里没关掉信鸽的实时活动。
- 和普通通知一样会被压低：接收者静音了这个通道、设了更高的最低提醒级别、赶上通道的免打扰时段、级别是 \`passive\`，都只推普通通知，不开实时活动；\`critical\` 到了没授权的成员那里降成时效性，照样开。
- 不想每条都带 \`live=1\`：通道的创建者在 App 的通道详情里打开「进行中的事件用实时活动显示」（通道默认值 \`live\`），这个通道带 \`id\` 的 \`firing\` 就都会开，适配器和监控的告警也一样；单独某一条不想开，带 \`live=0\`。
- 标题在开始那一刻随推送发到手机上，服务端不留；端到端加密的消息服务端看不到标题，手机上解开之后显示真标题。

实时活动的令牌由 App 自己登记，发送方用不着，列在这里是为了能核对服务端存了什么（都要 \`Authorization: Bearer {账号凭据}\`，同一个账号每分钟最多 20 次）：

| 请求 | 说明 |
|---|---|
| \`PUT /account/{id}/devices/{推送令牌}/activity-start-token\` | \`{"token"}\`：这台设备的 push-to-start 令牌；账号视图的设备项里随之多一个 \`activity_start_token_prefix\` |
| \`DELETE /account/{id}/devices/{推送令牌}/activity-start-token\` | 本机关掉了「事件用实时活动显示」 |
| \`PUT /account/{id}/activities/{通道 id}/{消息 id}\` | \`{"token", "device", "started_at"}\`：登记某件事在这台设备上的更新令牌；这件事已经结束了就回 \`{"registered": false, "ended": true, …}\`，App 当场收起 |
`,
  },
  {
    id: "groups",
    title: "群组：一起收、成员发消息、各人自己的提醒级别",
    md: `
一个通道可以邀请别人一起接收。只有创建者能看到推送地址、改设置、管成员；成员调管理接口一律 403，接口和推送里都拿不到地址。邀请码 8 位、7 天有效，加入前必须确认。群组通知带「我来处理」按钮，见[重复提醒与认领](#repeat)。

### 成员发消息

群主可以打开「允许成员发消息」（\`PATCH /account/{id}/channels/{cid}\` 带 \`"member_send": true\`，默认关），成员就能在 App 里往群里发一句话；群主自己随时能发：

~~~
POST /account/{id}/channels/{cid}/messages
{"title"?: "…", "body": "…", "level"?: "passive" | "active" | "timeSensitive"}
~~~

- 只有标题（100 字以内）、正文（1000 字以内）、级别，最高到时效性；只收加密的群改交 \`ciphertext\` 和 \`iv\`。通道的默认参数不垫底，没有链接、图片、重复提醒。
- 群里的违禁词过滤、只收加密、停用、每个通道每分钟 60 条照样管；每个人每分钟最多 20 条。
- 推出去的 payload 带 \`sender\`（发消息的人的显示名），没写标题时标题就是这个名字；发消息的人自己的设备静默收下，只进历史。

### 接收者自己说了算

群主定的是「这条消息长什么样」，每个接收者还可以在 App 的通道设置「提醒级别」里按自己的意思调（存在账号偏好里，\`PATCH /account/{id}\` 的 \`prefs_patch\` 逐条合并）：

- **允许紧急**（\`critical\`：\`{通道 id: true}\`）：允许这个群的 \`critical\` 突破自己的免打扰。没有条目就是不允许 —— 群主或拿到地址的人写 \`critical\`，到你这里按时效性送，免打扰、通道的免打扰时段照样管它。自己建的通道不看这一项，照旧能突破。
- **最低提醒级别**（\`minLevel\`：\`{通道 id: "passive" | "active" | "timeSensitive" | "critical"}\`）：低于它的一律静默送达（照样进通知中心和历史）。设成 \`timeSensitive\`，这个通道只有要紧的才响；设成 \`critical\` 就只有紧急的响 —— 和免打扰不同，没授权的紧急照样按时效性响。

推送的响应里 \`muted\` 把这两种压下的都算进去；[实时活动](#live)跟着一起压。
`,
  },
  {
    id: "e2e",
    title: "端到端加密",
    md: `
标题、正文、链接、标签在发送端就加密好，信鸽服务器和 Apple 只经手密文，由你设备上的 App 解密。

~~~
curl -sO https://{site}/tools/pigeon-send.mjs
node pigeon-send.mjs https://{site}/{key} --key {通道加密密钥} --title "磁盘满了" --body "剩余 3%"
~~~

- 工具就是源码仓库里的 \`tools/pigeon-send.mjs\`，逐字节一致，只用 Node 自带的模块。通道加密密钥在 App 的「通道设置 → 端到端加密」里，也可以放在环境变量 \`PIGEON_KEY\` 里。地址里的 key 可以换成[发送令牌](#tokens)。
- 格式：AES-256-GCM，12 字节随机 nonce；\`ciphertext\` = base64(密文 ‖ 16 字节标签)，\`iv\` = base64(nonce)；明文是 JSON 对象 \`{title, subtitle, body, url, tags}\`。
- \`level\` \`id\` \`status\` \`group\` \`sound\` \`repeat\` \`isArchive\` \`delete\` \`live\` 不加密：服务端投递时要用。通知按钮和回调地址没法加密（服务端要照着它们去请求）。
- 通道可以设成「只接受加密消息」：没带密文、或者在密文之外还带着明文内容的推送，一律回 400；也不收按钮。第三方 webhook、群机器人格式、MCP、网页发送发来的都是明文，这样的通道收不了。
`,
  },
  {
    id: "web",
    title: "网页发送",
    md: `
不写代码的人也能发：把 \`https://{site}/send#{key}\` 发给他，在浏览器里填好就能推。key 在 \`#\` 之后，浏览器不会把它发给服务器；网页发出的内容不做端到端加密。

更好的办法是给他一个[发送令牌](#tokens)的网页链接 \`https://{site}/s/{令牌}\`：页面先写明「发给：{通道名}」，只能填标题、内容和级别；令牌可以单独停用、限定最高级别，用不着把通道的地址交出去。
`,
  },
  {
    id: "mcp",
    title: "AI 助手（MCP）",
    md: `
支持 MCP 的 AI 助手、编码助手可以自己往信鸽推通知：长任务做完了、出错了、需要你回来拿主意时，手机上响一下。在它的 MCP 设置里加一个远程服务器，传输方式选 Streamable HTTP（有的写作 \`http\`）：

~~~
{
  "mcpServers": {
    "pigeon": { "type": "http", "url": "https://{site}/mcp/{key}" }
  }
}
~~~

信鸽 App 的「玩法 → AI 编程助手」里能直接复制填好这个通道地址的配置。不想把 key 写进地址的，地址写 \`https://{site}/mcp\`，另加请求头 \`Authorization: Bearer {key}\`。

它提供一个工具 \`notify\`，参数和推送接口一致：\`title\`、\`body\`、\`level\`（\`passive\` / \`active\` / \`timeSensitive\`）、\`url\`、\`id\`、\`status\`（\`firing\` / \`resolved\`）、\`repeat\`（分钟）。推送走的是同一条路：去重、免打扰、重复提醒、限流、群组规则都一样。

~~~
curl https://{site}/mcp/{key} -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"notify","arguments":{"title":"测试","body":"来自 MCP"}}}'
~~~

- 无状态：不发会话 id、不开 SSE 流，每个请求回一个 JSON。协议版本认 \`2026-07-28\`（每个请求自带版本，要带 \`MCP-Protocol-Version\`、\`Mcp-Method\` 头），也认 \`2025-11-25\`、\`2025-06-18\`、\`2025-03-26\`（先 \`initialize\` 握手）。
- 经 MCP 发来的内容以**明文**经过信鸽服务器，别让助手把密码、密钥写进通知；要端到端加密，用 [pigeon-send.mjs](#e2e)。只收加密的通道用不了 MCP。
- 建议给每个助手一个单独的[发送令牌](#tokens)，地址写 \`https://{site}/mcp/{令牌}\`：通知上写着「来自：{令牌名}」，可以限定最高级别和每分钟条数，想关掉时删掉那一个就行（之后它收到 410）。
`,
  },
  {
    id: "cli",
    title: "命令包装器",
    md: `
一个 POSIX shell 脚本，只要 \`sh\` 和 \`curl\`。信鸽 App 的「玩法 → 命令跑完推结果」里有填好这个通道推送地址的安装命令：

~~~
mkdir -p ~/.local/bin ~/.config/pigeon
curl -fsSL https://{site}/tools/pigeon.sh -o ~/.local/bin/pigeon
chmod +x ~/.local/bin/pigeon
echo '{key}' > ~/.config/pigeon/key && chmod 600 ~/.config/pigeon/key
~~~

macOS 默认没把 \`~/.local/bin\` 放进 \`PATH\`：想直接敲 \`pigeon\`，往 \`~/.zshrc\` 里加一行 \`export PATH="$HOME/.local/bin:$PATH"\`，或者写全路径 \`~/.local/bin/pigeon\`。

~~~
pigeon send "备份完成" "用了 3 分钟"
df -h | pigeon send "磁盘" -
pigeon run -- make release
pigeon run --id nightly -- ./backup.sh
~~~

- \`pigeon run\` 照常把输出显示在终端上，跑完推「✅ 成功」或「❌ 失败」，正文是退出码、用时、机器名和最后 5 行输出；失败的按时效性提醒。它自己的退出码就是那条命令的退出码，放进脚本和 cron 里不改变原来的行为。
- 带 \`--id\` 时，失败推 \`status=firing\`、成功推 \`status=resolved\`：上次失败时排下的[重复提醒](#repeat)随着这次成功停下。\`--quiet\` 让成功的静默送达，只有失败才响。
- 其他选项：\`--level\`、\`--url\`、\`--group\`、\`--repeat\`、\`--status\`、\`--title\`。
- 推送 key 读环境变量 \`PIGEON_KEY\`，没有再读 \`~/.config/pigeon/key\`；写 key、[发送令牌](#tokens)或整个推送地址都行。key 经标准输入交给 curl，不出现在命令行参数里。
- 脚本就是源码仓库里的 \`tools/pigeon.sh\`，逐字节一致，下载前可以先在浏览器里[打开看看](/tools/pigeon.sh)。
`,
  },
  {
    id: "selftest",
    title: "通知体检与告警演练",
    md: `
App 的「设置 → 通知体检」查的是「设置全开却收不到」的那一段：本机不在账号里、登记的推送环境和 App 对不上、令牌早已失效、Apple 拒收……它先看手机上的通知设置，再让服务端真推一条，量「服务器 → 本机」花了多久。背后是 \`POST /account/{id}/selftest\`（\`Authorization: Bearer {账号凭据}\`，每个账号每分钟最多 20 次），请求体都可选：

| 字段 | 说明 |
|---|---|
| \`token_prefix\` | 本机推送令牌的前 12 位（或完整令牌）。给了就只给本机推测试通知，其它设备只发后台探测、不打扰人 |
| \`environment\` | 本机实际用的推送环境 \`sandbox\` / \`production\`，和登记的比对 |
| \`drill\` | \`true\` = 告警演练 |
| \`channel_id\` | 演练用哪个通道，不给就挑第一个只有自己、不要求加密的 |
| \`drill_resolve\` | 演练的 \`id\`：推一条「已恢复」收尾 |

- **往返测速**：测试通知是静默的、不进历史，10 分钟内没送到就作废，payload 里带 \`selftest\`（这一次的随机标识）。响应列出每台设备 APNs 的原始答复（\`devices\`）、本机的登记情况（\`this_device\`）、此刻被压成静默的通道（\`silenced\`：自己开的免打扰、通道的免打扰时段、把最低提醒级别设到了时效性或紧急的），和查出来的毛病（\`problems\`：\`not_registered\`、\`environment_mismatch\`、\`device_invalid\`、\`push_failed\`、\`no_devices\`）。
- **告警演练**：在一个只有自己的通道上推一条时效性的测试告警，带「知道了，别再提醒」；约一分钟后的那一轮巡检补发一次（\`drill.remind_at\`）；点「知道了」走平常的认领；最后 \`drill_resolve\` 推「已恢复」。真告警会碰上的免打扰时段、个人静音、最低提醒级别、重复提醒满额，演练一样会碰上，写在 \`problems\` 里（\`quiet_hours\`、\`muted\`、\`min_level\`、\`repeat_skipped\`）。通道默认开了[实时活动](#live)的，演练也在锁屏上开一块，收尾时收起。群组和只收加密的通道不能演练。
- 体检记录只有随机标识、时刻和通道 id，10 分钟后自动删除。
`,
  },
  {
    id: "readthrough",
    title: "多设备已读",
    md: `
一台设备上读了，别的设备刷新时照着它标成已读、收走通知中心里读过的那几条。存在账号偏好的 \`readThrough\` 里：通道 id → 毫秒时刻，这个通道里发出时刻（\`sent_at\`）不晚于它的消息都算读过了（\`PATCH /account/{id}\` 的 \`prefs_patch\`）。

- 只进不退：交上来的比已有的早就不理，逐条合并和整份提交都一样；老版 App 整份提交时不带这一项，原样保留。条目给 \`null\` 才删掉。
- 比服务端此刻晚 10 分钟以上的截到那一刻：时钟快了的设备不会把之后来的消息都标成已读。
- 只是一个时间点，不记读了哪几条；删除通道、退出群组时对应的条目一起清掉。
`,
  },
  {
    id: "backup",
    title: "备份与恢复（运营者）",
    md: `
KV 是这个服务唯一的存储。服务端没有导出接口：备份用本机 wrangler 的登录态直接读 KV，能部署这个 Worker 的人才备份得了、恢复得了。

~~~
npm run backup
npm run backup -- --verify ~/pigeon-backups/pigeon-kv-20260927-031500.json.gz
npm run backup -- --restore <备份文件>
npm run backup -- --restore <备份文件> --apply
~~~

- 导出：默认存到 \`~/pigeon-backups/\`，gzip 压缩的 JSON，文件权限 600，带整份的 SHA-256；和线上数据一样敏感，脚本不许把它写进仓库目录。\`--prefix\` 可以只导出某些前缀。
- 检查（\`--verify\`）：格式版本、条数、校验和、每一条的形状，改过一个字节都会报出来。
- 恢复（\`--restore\`）默认只演练：说清会新建几个、覆盖几个、跳过几个已经过期的；加 \`--apply\` 才写，只写不删。
- 都能加 \`--local\`（本地 \`wrangler dev\` 的 KV）或 \`--persist-to <目录>\`（别的本地库），全程不碰线上地演练一遍灾难恢复。
`,
  },
  {
    id: "faq",
    title: "常见问题",
    md: `
### 收不到通知

- 先在 App 的「设置 → 通知体检」里测一次：它会说出是哪一段出了问题，见[通知体检](#selftest)。
- 系统「设置 → 通知 → 信鸽」要允许通知；专注模式可能把它挡住，要紧的消息用 \`level=timeSensitive\`。
- 看推送的响应：\`delivered\` 是送到了几台设备，\`muted\` 是其中因为接收者静音了这个通道、或者设了更高的最低提醒级别而静默送达的，\`quieted\` 说明赶上了通道的免打扰时段。

### 推送地址泄露了

打开通道设置，点「更换推送地址」：旧地址立即失效（30 天内再用它推的收到 410），配在别处的服务要改成新地址。以后给每个来源一个[发送令牌](#tokens)，泄露了只删那一个。

### 能推多长

Apple 限制一条推送最多 4KB，标题加正文大约放得下 1100 个汉字。超出的部分由服务端截掉、末尾标上「…（已截断）」，照常送达，响应里带 \`"truncated": true\`。

### 可以用 http 吗

不行。明文 http 的推送一律回 400：推送地址和内容在路上会被看到。

### 服务端存了什么

推送内容不落盘，例外只有三个：要求重复提醒的消息在提醒期间暂存，举报时举报人自己附上的那条，有人点了通知按钮时回执里记下的按钮名和回复（7 天）。完整清单见[隐私政策](/privacy)；服务端[开源](https://github.com/nibedge/pigeon-server)，\`/info\` 给出线上正在跑的 commit，可以对照。

### 能自己部署服务端吗

可以部署来研究、审计。但 iOS 推送必须用 App 开发者的密钥签名，官方信鸽 App 只接收 {site} 发出的推送。想让服务端看不到内容，用[端到端加密](#e2e)。

更多问题见[帮助与支持](/support)。
`,
  },
];

// ── 渲染 ────────────────────────────────────────────────────────────

/** 行内：`代码`、**加粗**、[文字](链接)。先按反引号切开，代码里的只转义、不再处理 */
function inline(text: string): string {
  return text
    .split(/(`[^`]+`)/)
    .map((part) => {
      if (part.length >= 2 && part.startsWith("`") && part.endsWith("`")) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      return escapeHtml(part)
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/|#)[^)\s]*)\)/g, '<a href="$2">$1</a>');
    })
    .join("");
}

/** 表格的一行：去掉首尾的竖线，按竖线切；\| 是单元格里的竖线 */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));
}

const BLOCK_START = /^(~~~|```|#{3,4}\s|\||- |\d+\.\s|>\s?)/;

/**
 * 文档用到的 Markdown：### 小标题、段落、- 列表、1. 列表、| 表格 |、> 提示框、~~~ 代码块、行内的代码加粗链接。
 * 所有文字都转义；链接只放行 http(s)、站内路径和锚点
 */
export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const fence = /^(~~~|```)/.exec(line.trim());
    if (fence) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith(fence[1] ?? "~~~")) code.push(lines[i++] ?? "");
      i += 1;
      out.push(`<pre>${escapeHtml(code.join("\n"))}</pre>`);
      continue;
    }
    const heading = /^(#{3,4})\s+(.+)$/.exec(line);
    if (heading) {
      const tag = heading[1] === "###" ? "h3" : "h4";
      out.push(`<${tag}>${inline(heading[2] ?? "")}</${tag}>`);
      i += 1;
      continue;
    }
    if (line.trim().startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").trim().startsWith("|")) rows.push(cells(lines[i++] ?? ""));
      const [head = [], , ...body] = rows;
      out.push(
        `<div class="table"><table>\n<tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr>\n` +
          body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("\n") +
          "\n</table></div>",
      );
      continue;
    }
    const bullet = /^(- |\d+\.\s)/.exec(line);
    if (bullet) {
      const ordered = bullet[1] !== "- ";
      const items: string[] = [];
      while (i < lines.length && /^(- |\d+\.\s)/.test(lines[i] ?? "")) {
        let item = (lines[i++] ?? "").replace(/^(- |\d+\.\s)/, "");
        // 缩进的续行并进这一项
        while (i < lines.length && /^\s{2,}\S/.test(lines[i] ?? "")) item += ` ${(lines[i++] ?? "").trim()}`;
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(ordered ? `<ol>\n${items.join("\n")}\n</ol>` : `<ul>\n${items.join("\n")}\n</ul>`);
      continue;
    }
    if (line.startsWith(">")) {
      const quoted: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith(">")) quoted.push((lines[i++] ?? "").replace(/^>\s?/, ""));
      out.push(`<div class="callout"><p>${inline(quoted.join(" "))}</p></div>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() && !BLOCK_START.test(lines[i] ?? "")) para.push((lines[i++] ?? "").trim());
    out.push(`<p>${inline(para.join(""))}</p>`);
  }
  return out.join("\n");
}

const EXTRA_STYLE = `
  :root{color-scheme:light dark}
  pre{
    margin:0 0 1rem;background:var(--surface);border:1px solid var(--line);border-radius:8px;
    padding:.8rem 1rem;overflow-x:auto;font:13px/1.65 ui-monospace,"SF Mono",Menlo,Consolas,monospace;color:var(--ink-2);
  }
  .table{overflow-x:auto;margin:0 0 1rem}
  .table table{margin:0}
  td code{overflow-wrap:anywhere}
  .toc{columns:2 12rem;column-gap:1.5rem;margin:0 0 1rem;padding-left:1.3rem;color:var(--ink-2)}
  .toc li{margin-bottom:.3rem;break-inside:avoid}
  section{scroll-margin-top:1rem}
  h2 a.self{color:inherit;text-decoration:none}
  h2 a.self:hover::after{content:" #";color:var(--ink-3)}
`;

/** 把 {site} 换成当前域名 */
function withSite(md: string, host: string): string {
  return md.replaceAll("{site}", host);
}

export function docsPage(host: string, sections: DocSection[] = DOC_SECTIONS): string {
  const site = escapeHtml(host);
  const toc = sections.map((s) => `<li><a href="#${escapeHtml(s.id)}">${escapeHtml(s.title)}</a></li>`).join("\n");
  const body = sections
    .map(
      (s) =>
        `<section id="${escapeHtml(s.id)}">\n<h2><a class="self" href="#${escapeHtml(s.id)}">${escapeHtml(s.title)}</a></h2>\n${renderMarkdown(withSite(s.md, host))}\n</section>`,
    )
    .join("\n\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>文档 — 信鸽Push</title>
${pageMeta(host, "/docs", "信鸽Push 文档", "推送参数、返回码、发送令牌、适配器、群机器人与国内推送服务的兼容写法、心跳与监控、重复提醒、通知按钮与回执、实时活动、群组、端到端加密、MCP 与命令包装器。")}
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>${DOC_STYLE}${EXTRA_STYLE}</style>
</head>
<body>
<div class="wrap">

<h1>文档</h1>
<p class="meta">信鸽Push · 最后更新 ${DOCS_UPDATED}</p>

<ul class="toc">
${toc}
</ul>

${body}

<footer>信鸽Push · ${site} · <a href="/">首页</a> · <a href="/support">帮助与支持</a> · <a href="/privacy">隐私政策</a> · <a href="/terms">使用条款</a></footer>

</div>
</body>
</html>`;
}

/** /docs/{id}：有这一节就跳到 /docs#{id}；没有返回 null（入口回 404） */
export function docsRedirect(id: string): string | null {
  return DOC_SECTIONS.some((s) => s.id === id) ? `/docs#${id}` : null;
}
