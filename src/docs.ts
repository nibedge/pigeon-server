import { DOC_STYLE } from "./docstyle";
import { escapeHtml } from "./invite";
import { pageMeta } from "./seo";

/**
 * 文档站：https://nfo.im/docs
 *
 * 一页写完，按节排：每节是一段 Markdown（DOC_SECTIONS 里的一项），渲染成 HTML 时套用隐私政策、帮助页那套样式。
 * 以后加内容就在 DOC_SECTIONS 里追加一节 —— README 里新写的接口说明原样贴进来就能用（{site} 换成当前域名）。
 * 渲染器只认这里用到的几种写法（见 renderMarkdown），不是完整的 Markdown。
 *
 * 示例命令照抄就要能用：test/api-l1-units.test.mjs 把每一条 curl https://{site}/{key}… 用真的 curl 跑一遍。
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
- 一条定时任务：用[心跳](#heartbeat)盯着它有没有按时跑完。
- 一条要跑很久的命令：用[命令包装器](#cli)，跑完把成败推过来。
- 一个 AI 助手、编码助手：用 [MCP](#mcp) 让它自己推。
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
| \`level\` | \`passive\` 静默 · \`active\` 普通（默认） · \`timeSensitive\` 时效性，专注模式下也会提醒 · \`critical\`（未获 Apple 授权前按时效性送） |
| \`sound\` | 铃声；不给就用系统默认，\`none\` 静音 |
| \`url\` | 点通知打开的链接 |
| \`group\` | 通知中心里的分组；不给就按通道分组 |
| \`tags\` | 逗号或竖线分隔，最多 5 个。认得的表情短码（\`warning\` \`rotating_light\` \`white_check_mark\`…）显示成表情 |
| \`image\` | 大图地址（https，10 MB 以内） |
| \`icon\` | 小图地址（https，2 MB 以内），通知右侧的缩略图 |
| \`copy\` | 要一键复制的内容；没给时 App 会自己认验证码 |
| \`autoCopy\` | \`1\`：展开通知或点开 App 时自动复制 \`copy\` |
| \`isArchive\` | \`0\`：不存进 App 历史 |
| \`id\` | 同一件事的标识（64 字节以内）。同 id 的新消息原地替换旧的；撤回、停止重复提醒也靠它 |
| \`status\` | \`firing\` / \`resolved\`：同一个 \`id\` 从进行中变成已恢复，App 算出持续了多久 |
| \`repeat\` | 每隔几分钟再提醒一次（5–60），直到有人处理，最长一小时。见[重复提醒与认领](#repeat) |
| \`delete\` | \`1\`：撤回同 \`id\` 的消息，必须带 \`id\` |
| \`ciphertext\` \`iv\` | 端到端加密的内容，见[端到端加密](#e2e) |

\`badge\` \`call\` \`volume\` \`ttl\` \`action\`，以及和 \`body\` 一起给的 \`markdown\`，认得但这一版不生效，会列在响应的 \`data.ignored\` 里。

### 写法

- 路径式：\`/{key}/{正文}\`、\`/{key}/{标题}/{正文}\`、\`/{key}/{标题}/{副标题}/{正文}\`。只适合没有空格和特殊字符的短句。
- 内容里有空格，或者 \`&\` \`#\` \`+\` \`%\` \`/\` \`?\` 这些字符时，别拼进地址，用 \`--data-urlencode\` 或 JSON。
- 请求体直接是一句话也行：\`curl -d "磁盘满了"\` 整句当正文。
- 请求头认 \`Title\`、\`Priority\`（\`1\`–\`5\` 或 \`min\` \`low\` \`default\` \`high\` \`max\` \`urgent\`）、\`Tags\`、\`Click\`、\`Id\`，标题可以直接写中文。
- key 也可以放在 \`Authorization: Bearer {key}\` 里，地址写根路径 \`https://{site}/\`，免得 key 进各种日志。
- 批量：\`POST https://{site}/push\`，JSON 里给 \`device_keys\`（一次最多 20 个），其余参数同上。

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
都是 JSON：\`{"code": 状态码, "message": "说明", "data": {…}, "timestamp": 秒}\`。\`data.id\` 是这条消息的 id（没给就由服务端生成）；\`data.delivered\` / \`data.devices\` 是送到了几台、一共几台；\`data.warnings\` 是中文提示；\`data.ignored\` 是这一版不生效的参数。

| 状态码 | 意思 |
|---|---|
| 200 | 收下了。\`data.suppressed\` 为 \`"duplicate"\` 是和刚才那条一样、被去重合并了，不必重发；\`quieted\`、\`muted\` 说明有接收者在免打扰，静默送达 |
| 400 | 请求本身有问题：没有内容可推、只收加密的通道收到了明文、撤回没带 \`id\`，\`message\` 里写着原因 |
| 403 | 这个通道已被停用 |
| 404 | key 不存在：检查推送地址有没有抄错 |
| 410 | 这个通道下没有能收的设备；在手机上重新打开 App 即可恢复 |
| 413 | 太长：请求体超过 64 KB（\`/hook\` 1 MB），或者截短文字之后仍然放不下 |
| 429 | 发得太频繁：每个通道每分钟最多 60 条，带 \`Retry-After\` |
| 502 | 服务端或 Apple 的问题，不是你的请求出错，稍后再试 |

群机器人格式的请求按原来那一家的样子回话，见[兼容别家格式](#compat)；MCP 回 JSON-RPC，见 [MCP](#mcp)。
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
- 一组有好几条时，副标题写着「本组 3 条触发」，通知中心里按组叠在一起。组里有新告警加入时，只推新的，已经推过、还在触发的不再响一遍，在新消息里点名。
- 一次最多推 10 条消息：超出的并成最后一条「另有 N 条」（它不重复提醒）。通道每分钟的额度按条算。
- 点开通知打开 \`runbook_url\`，没有就打开 \`generatorURL\`。

### 任意 JSON

~~~
curl https://{site}/hook/{key}/json -H 'content-type: application/json' -d '{"event":"备份","status":"失败","host":"nas","disk":"/data"}'
~~~

推出去是「备份 · 失败」，正文是 \`host：nas\`、\`disk：/data\`。字段名像凭据的（token、secret、password、sign……）一律不进推送。直接推到 \`/{key}\` 的 JSON 里没有认得的正文字段时，也按这个规则兜底。
`,
  },
  {
    id: "compat",
    title: "兼容别家格式：换个域名就能迁过来",
    md: `
### 群机器人地址

只会往群机器人发消息的工具（面板、监控、CI、签到脚本），把机器人地址的域名换成 \`{site}\`、把 key 换成信鸽的就行，请求体不用改。信鸽 App 的「通道设置 → 从别的工具迁过来」里列着这个通道的每一条，点一下就复制；把原来的地址粘贴进去，它会认出该换哪条。

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
- 取法：卡片或图文的标题当标题；多行文字第一行当标题、其余当正文；按钮和标题上的链接当点击链接；图片当大图。块级的 Markdown 标记（\`#\` 标题、\`>\` 引用）和 \`<font>\` 这类标签去掉，加粗和链接保留。图文、卡片一次带好几条的，第一条展开，其余列出标题。
- 消息里 @ 了所有人（\`isAtAll\`、\`@all\`、\`<!channel>\`、\`@everyone\`……）的，按时效性提醒。
- 请求里的 \`timestamp\`、\`sign\` 不看：信鸽靠地址里的 key 认人，地址本身就是凭据。
- 回话也按原来那一家的样子：成功回 \`{"errcode":0,"errmsg":"ok"}\`、\`{"code":0,"msg":"success"}\`、\`204\`（带 \`?wait=true\` 时回带 \`id\` 的消息）或纯文字 \`ok\`；失败时 HTTP 状态码照实给，原因是中文。
- 地址后面还可以拼信鸽自己的参数，比如 \`&level=passive\`、\`&repeat=5\`，它们盖过从消息里读出来的。
- 图片、文件、语音这类消息转不过来，只推一句「[图片]」提示。

### 国内推送服务的参数写法

签到脚本、面板、RSS 工具里内置的写法，换掉域名和 key 照样能用：

| 写法 | 信鸽怎么读 |
|---|---|
| \`/{key}.send?title=…&desp=…\` | 地址末尾的 \`.send\` 忽略；\`desp\` 是正文 |
| \`text\` + \`desp\` | \`text\` 是标题、\`desp\` 是正文（只有 \`text\` 时它是正文） |
| \`title\` + \`content\` | 标题 + 正文 |
| \`content\` + \`summary\` | 正文 + 摘要（摘要当副标题） |
| \`template\`、\`contentType\`、\`type\` | 正文的格式：\`html\`（或 \`contentType=2\`）转成文字；\`json\` 排成「键：值」；\`markdown\`、\`txt\` 照原样；\`type=image\` 时正文是图片地址 |
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
~~~

- 报到用 GET、POST、HEAD 都行；报告失败只收 POST（\`-d\` 或 \`-X POST\`），失败会立刻提醒，说明也可以放在 \`?msg=\` 里。
- 第一次报到之前不会提醒；失联只提醒一次，任务回来报到时推「恢复」。
- 地址贴进聊天时，链接预览和浏览器预取不算报到，也不会替你报失败。
- 和[命令包装器](#cli)一起用：\`pigeon run -- ./backup.sh && curl -fsS https://{site}/hb/{id}\`，失败时有详细输出，成功时只报到。

网站监控也在 App 的监控里建：从 Cloudflare 的境外节点访问，每次最多等 5 秒，连续两次失败才推「掉线了」。
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
- 撤回（\`delete=1\`）：锁屏和通知中心里的原通知换成「此消息已撤回」，App 历史里删掉这条。已经被人看到的收不回来。
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

- 工具就是源码仓库里的 \`tools/pigeon-send.mjs\`，逐字节一致，只用 Node 自带的模块。通道加密密钥在 App 的「通道设置 → 端到端加密」里，也可以放在环境变量 \`PIGEON_KEY\` 里。
- 格式：AES-256-GCM，12 字节随机 nonce；\`ciphertext\` = base64(密文 ‖ 16 字节标签)，\`iv\` = base64(nonce)；明文是 JSON 对象 \`{title, subtitle, body, url, tags}\`。
- \`level\` \`id\` \`status\` \`group\` \`sound\` \`repeat\` \`isArchive\` 不加密：服务端投递时要用。
- 通道可以设成「只接受加密消息」：没带密文、或者在密文之外还带着明文内容的推送，一律回 400。第三方 webhook、群机器人格式、MCP 发来的都是明文，这样的通道收不了。
`,
  },
  {
    id: "web",
    title: "网页发送",
    md: `
不写代码的人也能发：把 \`https://{site}/send#{key}\` 发给他，在浏览器里填好就能推。key 在 \`#\` 之后，浏览器不会把它发给服务器；网页发出的内容不做端到端加密。
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
- 建议给每个助手单独建一个通道，想关掉时删掉那个通道或更换它的推送地址就行。
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
- 推送 key 读环境变量 \`PIGEON_KEY\`，没有再读 \`~/.config/pigeon/key\`；写 key 或整个推送地址都行。key 经标准输入交给 curl，不出现在命令行参数里。
- 脚本就是源码仓库里的 \`tools/pigeon.sh\`，逐字节一致，下载前可以先在浏览器里[打开看看](/tools/pigeon.sh)。
`,
  },
  {
    id: "faq",
    title: "常见问题",
    md: `
### 收不到通知

- 先在 App 里给这个通道推一条测试消息，看这台手机能不能收到。
- 系统「设置 → 通知 → 信鸽」要允许通知；专注模式可能把它挡住，要紧的消息用 \`level=timeSensitive\`。
- 看推送的响应：\`delivered\` 是送到了几台设备，\`muted\` 是其中因为免打扰静默送达的，\`quieted\` 说明赶上了通道的免打扰时段。

### 推送地址泄露了

打开通道设置，点「更换推送地址」：旧地址立即失效，配在别处的服务要改成新地址。

### 能推多长

Apple 限制一条推送最多 4KB，标题加正文大约放得下 1100 个汉字。超出的部分由服务端截掉、末尾标上「…（已截断）」，照常送达，响应里带 \`"truncated": true\`。

### 可以用 http 吗

不行。明文 http 的推送一律回 400：推送地址和内容在路上会被看到。

### 服务端存了什么

推送内容不落盘（例外只有要求重复提醒的消息在提醒期间暂存，以及举报时举报人自己附上的那条）。完整清单见[隐私政策](/privacy)；服务端[开源](https://github.com/nibedge/pigeon-server)，\`/info\` 给出线上正在跑的 commit，可以对照。

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
${pageMeta(host, "/docs", "信鸽Push 文档", "推送参数、返回码、适配器、群机器人与国内推送服务的兼容写法、心跳、重复提醒、端到端加密、MCP 与命令包装器。")}
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
