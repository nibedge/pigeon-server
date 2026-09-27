# 信鸽 Pigeon · 服务端

[![test-and-deploy](https://github.com/nibedge/pigeon-server/actions/workflows/deploy.yml/badge.svg)](https://github.com/nibedge/pigeon-server/actions/workflows/deploy.yml)

把任何服务的 webhook 变成一条看得懂的 iOS 通知。运行在 Cloudflare Workers 上，存储用 KV。

线上实例：<https://nfo.im> · 文档：<https://nfo.im/docs> · 隐私政策：<https://nfo.im/privacy>

## 为什么开源

推送服务经手你的通知。与其让你「相信我们」，不如让你能核对：

- **服务端存了什么**：KV 里只有这几类记录 —— `acct:` 账号、`chan:` 通道、`ch:` 推送地址指针、`stok:` 发送令牌（令牌只存摘要，明文只在新建时给创建者一次；另有每个通道的令牌清单和各令牌的使用次数）、`oldkey:` 换掉的推送地址和删掉的令牌（只存摘要，30 天过期）、`inv:` 邀请码（7 天过期）、`ack:` 认领记录（24 小时过期）、`dedupe:` 去重哈希（最长 1 小时过期）、`report:` 举报记录（90 天过期）、`watch:` 网站监控与心跳的配置（`wown:` 按创建者的索引、`hbstate:` / `wstate:` 最近一次状态和历史 —— 最近 20 次状态变化、24 小时的每次检查、30 天按小时的可用时长、`watchdel:` 刚删除的监控，10 分钟过期）、`repeat:` 重复提醒（最长约 70 分钟过期）、`la:` 实时活动（每件事的开始结束时刻、认领人、各台设备的活动令牌，不含内容，最长 12 小时过期）、`rptslot:` 重复提醒占位（只有 id，用来数同时在响几条，最长一小时过期）、`amseen:` Alertmanager 每组告警里推过哪几条（只有告警指纹和触发时刻，2 天过期）、`rlnote:` 推送被限流时「已通知过创建者」的标记（1 小时过期）、`stat:` 通道的推送条数、`susp:` 通道停用标记、`dead:` 已失效推送令牌的摘要（30 天过期）、`rmdev:` 被移出账号的设备（令牌的摘要，30 天过期）、`sweep:` 定时巡检最近一轮的时刻和条数、`config:` 服务端设置。**推送内容不落盘**（例外只有两个：举报时举报人自己选择附上的那条消息；要求重复提醒的消息在提醒期间暂存，有人处理、消息恢复或满一小时即删除）。
- **线上跑的是哪一版**：`GET /info` 返回当前运行的 `commit`。线上只从本仓库的 `main` 分支经 GitHub Actions 自动部署，构建日志公开。
- **看不到内容的办法**：端到端加密（见下）。开源是「你可以检查我们」，加密是「你不需要相信我们」。

## 推送

每个通道一个推送地址 `https://nfo.im/{key}`，在 App 的通道设置里复制。

```bash
curl https://nfo.im/{key}/服务器挂了                       # 路径里直接写一句正文
curl https://nfo.im/{key} -d "磁盘满了，剩余 3%"             # 请求体直接是一句话：整句当正文
curl https://nfo.im/{key} --data-urlencode "title=磁盘告警" --data-urlencode "body=剩余 3%，/data 快满了"
curl https://nfo.im/{key} -H "Title: 磁盘告警" -H "Priority: 4" -d "剩余 3%"
curl https://nfo.im/{key} -H 'content-type: application/json' \
     -d '{"title":"磁盘满了","body":"剩余 3%","level":"timeSensitive","tags":"warning,prod"}'
```

内容里有空格，或者 `&` `#` `+` `%` `/` `?` 这些字符时，别拼进地址里（带空格的地址 curl 直接拒绝，没加引号的话 shell 会把它拆成两截），放进请求体：`--data-urlencode "body=…"` 或者 JSON。

要紧的事可以一直提醒，直到有人处理：

```bash
# 每 5 分钟再响一次，直到有人点「知道了 / 我来处理」，最长一小时
curl https://nfo.im/{key} -d id=db-01 -d repeat=5 -d level=timeSensitive \
     --data-urlencode "title=主库连不上" --data-urlencode "body=db-01 无响应"
# 修好了：同一个 id 推一条 status=resolved，提醒随之停下，App 里显示这件事持续了多久
curl https://nfo.im/{key} -d id=db-01 -d status=resolved --data-urlencode "body=已恢复"
# 或者整条撤回
curl https://nfo.im/{key} -d id=db-01 -d delete=1
```

### 实时活动（灵动岛）

一件事从出事到恢复，一直挂在锁屏和灵动岛上：

```bash
# 带 id 的 status=firing 加 live=1：接收者的锁屏和灵动岛上出现「主库连不上 · 已持续 12:34」，按秒走
curl https://nfo.im/{key} -d id=db-01 -d status=firing -d live=1 -d level=timeSensitive \
     --data-urlencode "title=主库连不上"
# 群里有人点了「我来处理」（通知上、小组件上、实时活动上都行）：每个人的那一块换成「张三 正在处理」
# 恢复了：定格成「已恢复 · 持续 18 分钟」，15 分钟后收起；撤回（delete=1）立即收起
curl https://nfo.im/{key} -d id=db-01 -d status=resolved --data-urlencode "body=已恢复"
# JSON 里写成开关也行
curl https://nfo.im/{key} -H 'content-type: application/json' \
     -d '{"id":"db-01","status":"firing","live":true,"level":"timeSensitive","title":"主库连不上"}'
```

- 只认发送方给的 `id`：恢复、认领、撤回都靠它找到那一块。同一个 `id` 在进行中再推 `firing`（周期性重发）不会叠出第二块。恢复、撤回不用带 `live`。
- 接收者这边：iOS 17.2 及以上，App 的「设置 → 事件用实时活动显示」开着（默认开，按设备各自设），系统设置里没关掉信鸽的实时活动。
- 和普通通知一样会被压低：接收者给这个通道开了免打扰（`critical` 除外）、赶上通道的免打扰时段、级别是 `passive`，都只推普通通知，不开实时活动。
- 不想每条都带 `live=1`：通道的创建者在 App 的通道详情里「这个通道的默认值」一栏打开「进行中的事件用实时活动显示」，这个通道带 `id` 的 `firing` 就都会开，GitHub、Grafana、Uptime Kuma 的告警和监控的掉线、失联告警也一样。单独某一条不想开，带 `live=0`。
- 标题在开始那一刻随推送发到手机上，服务端不留；端到端加密的消息服务端看不到标题，手机上解开之后显示真标题。

### 参数

| 参数 | 说明 |
|---|---|
| `title` | 标题 |
| `subtitle` | 副标题。也可以叫 `summary` `short` |
| `body` | 正文，App 里按 Markdown 显示。也可以叫 `text` `message` `content` `msg` `desp` `description` |
| `markdown` | 只给了它、没给 `body` 时当正文；和 `body` 一起给时不显示 |
| `level` | `passive` 静默 · `active` 普通（默认） · `timeSensitive` 时效性，专注模式下也会提醒 · `critical`（未获 Apple 授权前按时效性送）。critical 会突破接收者自己的免打扰，但只对通道的创建者、以及在 App 里给这个群打开了「允许紧急消息」的成员；其余成员按时效性收到，照样守自己的免打扰（见[群组](#群组)） |
| `sound` | 铃声；不给就用系统默认，`none` 静音，`passive` 的消息本来就不出声。接收者在 App 里给这个通道选过铃声的，以接收者选的为准 |
| `url` | 点通知打开的链接 |
| `group` | 通知中心里的分组；不给就按通道分组 |
| `tags` | 逗号或竖线分隔，最多 5 个。认得的表情短码（`warning` `rotating_light` `white_check_mark`…）显示成表情，其余显示成可筛选的标签 |
| `image` | 大图地址（https，10 MB 以内），显示在通知里，App 历史里也留着。加入别人的群时，默认不加载群里的图片，接收者可以在通道详情里打开 |
| `icon` | 小图地址（https，2 MB 以内），显示成通知右侧的缩略图。同时给了 `image` 时让位给大图 |
| `copy` | 要一键复制的内容：通知上多一个「复制」按钮，App 历史里也能一键复制。没给时 App 会自己从文字里认验证码 |
| `autoCopy` | `1`：展开通知或点开进 App 时自动复制 `copy`（认出的验证码总是自动复制） |
| `isArchive` | `0`：不存进 App 历史 |
| `id` | 同一件事的标识。同 id 的新消息原地替换旧的（通知中心和 App 历史都是），撤回、停止重复提醒也靠它。超过 64 字节照样送达，只是不能原地替换，也排不上重复提醒 |
| `status` | `firing` / `resolved`。同一个 `id` 从进行中变成已恢复，App 会算出持续了多久；恢复之后这件事的认领随之结束，下次再触发要重新有人接手。`resolved` 从不被去重 |
| `repeat` | 重复提醒：每隔几分钟再推一次（5–60，`1` / `true` 即 5），直到有人点「知道了 / 我来处理」、同 `id` 推来 `status=resolved` 或 `delete=1`，最长一小时。`passive` 的消息不重复。响应里的 `repeat.id` 就是这条消息的 `id`。每个通道同时最多 10 条、同一个人名下的通道加起来最多 30 条在重复提醒，满了的照常送达，只是不再重复 |
| `live` | `1`：带 `id` 的 `status=firing` 在接收者的锁屏和灵动岛上开一个实时活动，显示已持续多久、谁在处理，恢复后定格，见下文「实时活动」。`0`：这条不开（盖过通道默认值） |
| `delete` | `1` 撤回同 `id` 的消息，必须带 `id`，不用给标题正文：锁屏和通知中心里的原通知换成「此消息已撤回」，App 历史里删掉这条（旧版 App 是把历史里那条换成「此消息已撤回」）；它的重复提醒和认领也一并结束。已经被人看到的收不回来 |
| `actions` | 通知上的自定义按钮，最多 3 个：长按通知就能「打开链接、复制、由服务端代发请求、回一句话」。JSON 数组或简写，见下文《通知按钮》 |
| `callback` | 事件回调地址（https）：有人认领、点了按钮，或重复提醒响到头还没人认领时，服务端 POST 一条带签名的 JSON 事件到这里。不进推送内容，接收的人看不到。也可以设成通道默认值（App 里通道设置的「通知按钮与回调」）。见下文《回执与回调》 |
| `ciphertext` `iv` | 端到端加密的内容，见下 |
| `badge` | 不生效：角标由 App 按未读条数自己管，传了也会被覆盖 |
| `call` `volume` `ttl` `action` | 认得，但这一版不生效 |

`badge` `call` `volume` `ttl` `action`，以及和 `body` 一起给的 `markdown`，会列在响应的 `data.ignored` 里，免得对着一个不生效的参数调半天。别家推送服务特有、信鸽用不上的参数（见下面的「兼容别家格式」）也列在这里。

### 写法

参数可以放在路径、query、请求头、请求体（JSON、表单）里，后面的覆盖前面的，路径最优先。通道在 App 里设过默认值的，垫在最底下。

- 路径式：`/{key}/{正文}`、`/{key}/{标题}/{正文}`、`/{key}/{标题}/{副标题}/{正文}`。只适合没有空格和特殊字符的短句，其余放请求体。
- 请求体直接是一句话也行：`text/*`、没写类型，或者 `curl -d "…"` 这种没有字段名的表单，整句当正文。
- JSON 请求体里没有认得的正文字段时，按通用 JSON 兜底：标题取 `title` `name` `event` `status` 这类常见字段（状态接在后面：「备份 · failed」），正文取前 6 个字段排成「键：值」，字段名像凭据的（token、secret、password、sign……）一律不进推送；响应的 `warnings` 里说明。什么也取不出（比如 `{}`）时回 400 并说明原因。
- 认出了标题、没有正文（`{"title":"备份失败","host":"nas","error":"disk full"}`）：其余字段排成「键：值」当正文，信鸽自己的参数（`id` `level` `url`……）不排进去。认出了正文、没有标题：有 `subject` 就拿它当标题（`{"subject":…,"message":…}` 这种邮件式的写法）。这样猜出来的标题正文，不盖过 query、请求头里明写的。
- 请求头认 `Title`、`Priority`（`1`–`5` 或 `min` `low` `default` `high` `max` `urgent`，最高到 `timeSensitive`）、`Tags`、`Click`（点通知打开的链接）、`Id`。标题可以直接写中文。
- 参数名不分大小写。开关参数（`isArchive` `autoCopy` `delete` `live`）写 `true` / `false` / `yes` / `no` 等同 `1` / `0`。
- key 也可以放在 `Authorization: Bearer {key}` 里，地址写根路径 `https://nfo.im/`。地址末尾的 `.send` 会被忽略。根路径没带 key 的推送回 400。
- 凡是能写 key 的地方（路径、`Authorization: Bearer`、`/push` 的 `device_key(s)`、`/hook/{key}/…`）都可以换成[发送令牌](#发送令牌)。
- 批量：`POST https://nfo.im/push`，JSON 里给 `device_key` 或 `device_keys`（一次最多 20 个），其余参数同上，每个 key 各自合上自己通道的默认值。结果逐个列在 `data.results` 里：每个 key 各有自己的 `id`、`warnings`、按需的 `truncated` `live`（顶层没有这几项）；被去重压掉的标 `"suppressed": "duplicate"`，不算失败。一批牵涉的人和设备太多（估算的存储读写和推送请求超过 900 个：每人算一次读取、每台设备算三个，约四个每人一台设备的满员群）会整批回 400，请分批发送。

```bash
curl https://nfo.im/push -H 'content-type: application/json' \
     -d '{"device_keys":["{key1}","{key2}"],"title":"发版完成","body":"v2.3 已上线"}'
```

**不推送的请求**：`HEAD`、浏览器的预取（带 `Sec-Purpose` / `Purpose: prefetch`）、聊天软件抓链接预览的 GET，一律回 200 `{"ok":true,"skipped":"preview"}`，什么也不推 —— 把推送地址贴进聊天里不会误推一条。

**限流**：每个通道每分钟最多 60 条（路径式、`/push`、`/hook` 和心跳告警共用一份；心跳撞上额度时这次报到不记、回 429），超了回 429，带 `Retry-After: 60` 和中文原因；通道创建者会收到一条提醒，一小时最多一次。同一个 IP 查询不存在的 key，每分钟最多 30 次。

**长度上限**：Apple 限制一条推送最多 4KB，扣掉其它字段，标题加正文大约放得下 1100 个汉字。超出的部分由服务端截掉、末尾标上「…（已截断）」，照常送达，响应里带 `"truncated": true`（先截 `markdown`，再依次截 `body` `copy` `subtitle` `title`）。端到端加密的消息没法截，超出直接回 413，并写明当前字节数和上限。请求体最多 64 KB（`/hook` 最多 1 MB），超了回 413。

### 响应

都是 JSON：`{"code": 状态码, "message": "说明", "data": {…}, "timestamp": 秒}`。

- `data.id` 是这条消息的 `id`（没给就由服务端生成，之后替换、撤回、停提醒都靠它）；`data.delivered` / `data.devices` 是送到了几台、一共几台；`data.warnings` 是中文提示，比如截短了什么、`id` 太长当不了折叠标识；`data.ignored` 列出这一版不生效的参数；要了实时活动时 `data.live` 是开出了几个（`started`），恢复、撤回时是收起了几个（`ended`）。
- 撤回的响应带 `"retracted": true`；排上了重复提醒带 `repeat`（隔几分钟、到几点、消息 `id`）；要求了重复提醒、但同时在响的已经满额时带 `"repeat_skipped"`（`channel_limit` 或 `account_limit`）；赶上通道的免打扰时段、被降成静默送达时带 `"quieted": true`；有接收者把这个通道静音了、或者给它设了更高的最低提醒级别时，`muted` 是静默送达的设备数 —— 查「为什么没响」先看这两个。用发送令牌推、被令牌的限制改了级别或去掉了重复提醒的，`warnings` 里写明。

| 状态码 | 意思 |
|---|---|
| 200 | 收下了。`data.suppressed` 为 `"duplicate"` 时是和刚才那条一模一样、被去重合并了（开了去重的通道），不必重发；`skipped` 为 `"preview"` 时是链接预览，什么也没推 |
| 400 | 请求本身有问题：没有内容可推、只收加密的通道收到了明文、撤回没带 `id`、地址少了 key、`/push` 一次太多，`message` 里写着具体原因 |
| 403 | 这个通道已被停用，或者这个发送令牌被通道的创建者停用了 |
| 404 | key 不存在：检查推送地址有没有抄错 |
| 410 | 地址已停用：通道换了推送地址、或者删掉了这个发送令牌（30 天内都这样回，同时一天最多提醒创建者一次「旧地址还有人在用」）。也可能是这个通道下没有能收的设备，或者设备都已失效（之后不再推给它们）—— 在手机上重新打开 App 即可恢复。`message` 写明是哪一种 |
| 413 | 太长：请求体超过上限，或者截短文字之后仍然放不下（加密的内容没法截） |
| 429 | 发得太频繁，等一会儿再发：超了通道每分钟 60 条，或者发送令牌自己的每分钟上限。本服务的限流带 `Retry-After: 60` |
| 502 | 服务端或 Apple 的问题，不是你的请求出错，稍后再试。原始原因在 `data.reason` 里 |

### App 用的接口：实时活动令牌

实时活动的令牌由 App 自己登记，发送方用不着。列在这里是为了能核对服务端存了什么（见隐私政策「实时活动令牌」）。都要 `Authorization: Bearer {账号凭据}`：

| 请求 | 说明 |
|---|---|
| `PUT /account/{id}/devices/{推送令牌}/activity-start-token` | body `{"token": "…"}`：这台设备的 push-to-start 令牌（十六进制）。推送令牌可以只给 12 位以上的前缀。和记着的一样就不写。响应 `{"live_activities": true}`；账号视图的设备项里随之多一个 `activity_start_token_prefix`（前 12 位） |
| `DELETE /account/{id}/devices/{推送令牌}/activity-start-token` | 本机关掉了「事件用实时活动显示」：删掉，之后不再给这台开。响应 `{"live_activities": false}` |
| `PUT /account/{id}/activities/{通道 id}/{消息 id}` | body `{"token": "…", "device": "{推送令牌}", "started_at": 毫秒}`：某件事的活动在这台设备上开起来了，登记它的更新令牌（群成员也可以）。响应 `{"registered": true, "status": "firing"}`，已经有人认领时 `"status": "acked", "ack_by": "张三"`；这件事已经结束了（结束得不早于 `started_at`）就不登记，回 `{"registered": false, "ended": true, "status": "resolved" 或 "retracted", "ended_at": 毫秒}`，App 当场收起 |

两者共用一份额度：同一个账号每分钟最多 20 次，超了回 429。消息 id 里有 `/` 之类的字符要百分号编码。

### 直接接第三方 webhook

`POST https://nfo.im/hook/{key}/{适配器}`，不用写任何转换代码：

| 适配器 | 说明 |
|---|---|
| `github` | 构建失败或超时、需要审批、PR / Issue 的新建关闭合并、Release、push（含删分支、推标签）。取消和跳过的构建、check_run 这类细碎的 CI 事件不推。在仓库 Settings → Webhooks 里 Content type 选 `application/json`，事件选「Let me select individual events」并勾上 Workflow runs、Issues、Pull requests、Releases —— 默认只有 push |
| `grafana` | 告警触发与恢复（同一组告警合并成一件事，显示持续时长）。建好 contact point 之后，要在 Notification policies 里把它挂上才会收到 |
| `uptimekuma` | 掉线与恢复（待确认、维护中安静地推），证书和域名快到期的提醒。JSON 和 form-data 两种格式都认。要在每个监控项的设置里勾上这条通知 |
| `alertmanager` | Prometheus Alertmanager 的 `webhook_configs`（记得 `send_resolved: true`）。每条告警单独一条消息：`id` 是 `am-{fingerprint}`，几台机器上同名的告警各自计时、各自恢复；`severity` 为 `critical` 的按时效性提醒、`warning` 普通、`info` 静默，恢复一律静默；副标题写着「本组 N 条触发」，同一组在通知中心叠在一起；点开是 `runbook_url`，没有就是 `generatorURL`。组里有变化（新触发、刚恢复）时只推变了的：推过哪几条按组记在服务端（`amseen:`，只有告警指纹和触发时刻），推过、还在触发的不再响一遍、在新消息里点名；没推出去的（额度用完、推送失败）不记，下次照推；没有记录时（第一次见到这一组）按 `startsAt` 猜，30 分钟内触发的算新的。什么都没变的重发（`repeat_interval` 到了）整组照推。一次最多推 10 条消息，超出的并成最后一条「另有 N 条」（它不重复提醒）；通道每分钟的额度按条算。响应的 `data.messages` 逐条列出 `id`、`status`、`delivered` |
| `json` | 任意 JSON：标题取常见字段、正文取成段的文字或前 6 个字段（规则同上面的通用 JSON 兜底）。请求体里的 `id` `level` `repeat` 不当推送参数 —— 别的服务的这几个字段和信鸽的意思多半对不上；`severity` `priority` `level` 这类字段只按严重程度读（`critical` `high` → 时效性，`warning` `error` → 普通，`info` `low` → 静默） |

Alertmanager 的配置：

```yaml
receivers:
  - name: pigeon
    webhook_configs:
      - url: https://nfo.im/hook/{key}/alertmanager
        send_resolved: true
```

### 兼容别家格式

**群机器人地址**：只会往群机器人发消息的工具，把地址的域名换成 `nfo.im`、key 换成信鸽的，请求体不用改（App 的「通道设置 → 从别的工具迁过来」列着这个通道的每一条，粘贴原地址能认出该换哪条）。代码只按消息结构命名：

| 地址 | 消息结构（按结构命名） | 成功时回 |
|---|---|---|
| `/cgi-bin/webhook/send?key={key}` | msgtype 风格：`{msgtype, text \| markdown \| markdown_v2 \| link \| actionCard \| feedCard \| news \| template_card, at}` | `{"errcode":0,"errmsg":"ok"}` |
| `/robot/send?access_token={key}` | 同上；后面拼的 `timestamp` `sign` 不看 | 同上 |
| `/open-apis/bot/v2/hook/{key}` | msg_type 风格：`{msg_type: text \| post \| interactive, content, card}`；请求体里的 `timestamp` `sign` 不看 | `{"code":0,"msg":"success",…}` |
| `/api/webhooks/{任意}/{key}`（也认 `/api/v10/webhooks/…`、`/api/webhooks/{key}`） | embeds 风格：`{content, embeds: [{title, description, url, fields, image, thumbnail}]}` | `204`；带 `?wait=true` 时回 `{"id":…}` |
| `/services/{任意…}/{key}` | blocks 风格：`{text, blocks, attachments}`（也认表单里的 `payload`） | 纯文字 `ok` |

- 这四种结构的 JSON 直接推到 `/{key}` 也认（路径里没有正文时），回话按认出的结构。只有 `text` 或只有 `content` 的，仍按信鸽自己的参数读、回信鸽的信封。兼容地址上只有 `content`（embeds 风格的地址）或只有 `text`（blocks 风格的地址）的，按地址的格式读：多行时第一行当标题，`<url|文字>`、`<!channel>` 照样转。
- 取法：卡片、图文的标题当标题；多行文字第一行（不超过 60 字）当标题、其余当正文；一句话的 `content` 加一张没标题的卡片时，`content` 当标题。按钮和标题上的链接当点击链接（`私有协议://…?url=` 和 `…/web_url/open?url=` 这类客户端内打开的包装会拆掉），都没有时用名字里带 URL、链接、地址的字段；图片当大图、缩略图当小图。字段排成「名字：值」（「**名字**」换行再写值的，并成一行）。块级 Markdown 标记去掉或换掉（`#` 标题、`>` 引用去掉，`-` 列表换成「• 」，表格一行排成「a · b」，代码块的围栏去掉），标题里的 `<font>` 这类标签去掉，加粗和链接保留；换之前的原文放在 payload 的 `markdown` 里。`<url|文字>` 写成 `[文字](url)`、`*加粗*` 写成 `**加粗**`。一次带好几条的，第一条展开、其余列标题。图片、文件、语音只推一句「[图片]」之类，`warnings` 里说明。
- @所有人（`at.isAtAll`、`mentioned_list: ["@all"]`、`<at user_id="all">`、`<!channel>` `<!here>` `<!everyone>`、`@everyone` `@here`）→ `level=timeSensitive`。
- 地址后面可以拼信鸽参数（`&level=passive&repeat=5&id=…`），盖过从消息里读出来的；`ignored` 只看这些。
- 失败时 HTTP 状态码照实给（400、403、404、410、413、429 带 `Retry-After`、502），正文用对方的形状、中文原因：`{"errcode":404,"errmsg":"…"}`、`{"code":404,"msg":"…"}`、`{"code":404,"message":"…"}` 或纯文字。兼容地址收到的请求体不是这几种结构时，先按信鸽自己的参数读，再按通用 JSON 兜底。请求体上限 1 MB。

**国内推送服务的参数写法**（路径式推送、query、表单、JSON 都认）：

| 写法 | 信鸽怎么读 |
|---|---|
| `text` + `desp` | `text` 是标题、`desp` 是正文（只有 `text` 时它是正文） |
| `title` + `desp` / `content` / `msg` | 标题 + 正文。`desp` 按 Markdown 读（那一家本来就这样渲染）：`##` 标题、`>` 引用去掉，列表换成「• 」，表格一行排成「a · b」 |
| `content` + `summary` / `short` | 正文 + 副标题 |
| `template=html`、`contentType=2`、`type=html` | 正文是 HTML：转成文字，加粗和链接保留成 Markdown。带着 `token`、没写格式、正文像 HTML 的也按 HTML 转 |
| `template=json` | 正文是一段 JSON：排成「键：值」 |
| `template=markdown`、`contentType=3`、`type=markdown` | 正文按 Markdown 读，块级标记同 `desp` 的处理 |
| `template=txt`、`contentType=1`、`type=text` | 照原样 |
| `type=image` | 正文是图片地址：当大图，正文写「[图片]」 |
| `tags=a\|b` | 竖线分隔的标签 |
| `channel` `openid` `noip` `topic` `topicIds` `uids` `webhook` `callbackUrl` `to` `pre` `option` `appToken` `verifyPay` `verifyPayType` `token` `pushkey` `sendkey` `spt` `timestamp` `sign`，以及认不出取值的 `template` `contentType` `type` | 不生效，列在 `data.ignored` 里，值不进推送 |

### AI 助手（MCP）

`POST https://nfo.im/mcp/{key}`（或 `POST https://nfo.im/mcp` 加 `Authorization: Bearer {key}`），Streamable HTTP、无状态：每个请求回一个 `application/json` 的 JSON-RPC 响应，不发会话 id、不开 SSE 流；`GET` 回 405 并说明怎么配。

```json
{ "mcpServers": { "pigeon": { "type": "http", "url": "https://nfo.im/mcp/{key}" } } }
```

App 的「玩法 → AI 编程助手」里能复制填好这个通道地址的配置。

- 协议版本：`2026-07-28`（没有握手，每个请求在 `params._meta` 里带 `io.modelcontextprotocol/protocolVersion` 和 `clientCapabilities`，头 `MCP-Protocol-Version`、`Mcp-Method`、`tools/call` 的 `Mcp-Name` 必须和请求体一致，否则 400 `-32020`；版本不认得 400 `-32022`；方法不认得 404 `-32601`；实现 `server/discover`，`tools/list` 带 `ttlMs`、`cacheScope`）；也认 `2025-11-25`、`2025-06-18`、`2025-03-26`（先 `initialize`、`notifications/initialized`）。方法：`initialize`、`server/discover`、`ping`、`tools/list`、`tools/call`；通知一律 202。
- 一个工具 `notify`，参数 `title` `body` `level`（`passive` / `active` / `timeSensitive`）`url` `id` `status`（`firing` / `resolved`）`repeat`（0–60 分钟），`title` 和 `body` 至少一个。推送走 `deliver`：去重、免打扰、重复提醒、每分钟额度、群组违禁词都一样。
- 参数不对、推送失败、限流、只收加密的通道 → 结果里 `isError: true` 加中文原因（AI 看得到、能自己改）；工具名不对 → JSON-RPC `-32602`。key 不存在 404、通道停用 403、查不存在的 key 太频繁 429，错误码是 HTTP 状态码的负数（MCP 要求自定义错误码放在 JSON-RPC 保留段之外）。
- 成功的结果：文字说明加 `structuredContent`（`id` `delivered` `devices` `channel`，按需 `repeat` `suppressed` `warnings`）。
- 经 MCP 发来的内容以明文经过服务端；`Origin` 头不拦（公网服务，凭据是 key，推送接口本身也对任何来源开放），CORS 放行 `mcp-protocol-version` `mcp-method` `mcp-name` `mcp-session-id` `last-event-id`。

### 命令包装器

`https://nfo.im/tools/pigeon.sh` 就是本仓库的 `tools/pigeon.sh`（逐字节一致，只要 `sh` 和 `curl`）：

```bash
mkdir -p ~/.local/bin ~/.config/pigeon            # 没有这个目录时 curl -o 会失败（macOS 默认没有，也不在 PATH 里）
curl -fsSL https://nfo.im/tools/pigeon.sh -o ~/.local/bin/pigeon
chmod +x ~/.local/bin/pigeon
echo '{key}' > ~/.config/pigeon/key && chmod 600 ~/.config/pigeon/key   # 或者环境变量 PIGEON_KEY；写整个推送地址也行
pigeon send "备份完成" "用了 3 分钟"             # 一个参数时它是正文；正文写 - 从标准输入读
pigeon run --id nightly -- ./backup.sh          # 跑完推「✅ 成功 / ❌ 失败 · 命令」，正文是退出码、用时、机器名、最后 5 行
```

- App 的「玩法 → 命令跑完推结果」里有填好推送地址的安装命令（key 文件里写的是整个推送地址，服务器地址跟着走）。
- `run` 照常输出（标准输出和标准错误并在一起），退出码就是命令的退出码；失败默认 `timeSensitive`，`--quiet` 让成功的静默送达；带 `--id` 时失败推 `status=firing`、成功推 `status=resolved`。其他选项 `--level` `--url` `--group` `--repeat` `--status` `--title`。
- 推送 key 经标准输入交给 curl（`curl --config -`），不出现在命令行参数里；发到根路径 `Authorization: Bearer`。`PIGEON_KEY` 是 43 位的（`pigeon-send.mjs` 的通道加密密钥）直接拒绝，不发给服务器。`PIGEON_SERVER` 换服务器地址。

### 心跳监控

定时任务（备份、cron 脚本）跑完来报个到，过了约定的时间没来就提醒你。在 App 的监控里新建「心跳」，拿到报到地址：

```bash
curl -fsS https://nfo.im/hb/{id}                     # 跑完报到（GET / POST / HEAD 都行）
curl -fsS https://nfo.im/hb/{id}/fail -d "磁盘满了"  # 出错时报告失败，立刻提醒；只收 POST，说明也可以放在 ?msg= 里
curl -fsS https://nfo.im/hb/{id}/start               # 开始跑了：下一次报到算出这次用了多久
curl -fsS https://nfo.im/hb/{id}/$?                  # 按退出码报：0 是正常报到，1–255 是失败，提醒里写「退出码 N」
```

一个脚本从头到尾这样接：

```bash
curl -fsS https://nfo.im/hb/{id}/start
./backup.sh
curl -fsS https://nfo.im/hb/{id}/$?
```

第一次报到之前不会提醒；失联只提醒一次，任务回来报到时推「恢复」。心跳删掉（或者它推给的通道、所在的账号删掉）之后地址随之作废，报到回 404；通道被停用期间回 403。
报告失败只收 POST（`curl -X POST` 或 `-d`），GET 回 405：地址贴进聊天时，链接预览不会替你报失败。退出码的地址 GET 也收（`curl …/$?` 默认就是 GET）；链接预览和浏览器预取来的请求一律回 200，不算报到。

调过 `/start` 的，下一次报到（正常、失败、退出码都算）的回应里带 `duration_ms`，失败和恢复的提醒里写「这次用时 3 分 20 秒」，App 的监控详情里能看到每次的用时。开始了却一直没报到的，「没有按时上报」里会多一句「这一轮已经跑了 40 分钟，还没结束」：一眼分得清是任务根本没跑起来，还是跑起来卡住了。`/start` 本身不算报到：不改状态、不影响失联的判定；离上次记下的开始不到 4 分钟的不记（比约定还勤的任务只记一部分用时）。退出码只认 0–255，别的数字回 404。

**暂停和维护窗口**：监控可以暂停（到某个时刻，或者一直暂停到手动恢复），也可以设每周的维护窗口（比如每周日 03:00–04:00，按你选的时区）。暂停期间网址不抓、心跳不判失联；维护窗口里照常检查、照常记录，只是不推告警。这两段时间里压下的告警不会丢：结束时还没恢复，补推一条并写明「维护窗口内掉线，到现在还没恢复」；期间已经好了就什么都不推。之前推过「掉线了」的事在这期间恢复，照样推「恢复了」，只是静默送达。心跳暂停结束（或手动恢复）后重新计时，给一整个「间隔 + 宽限」。

网站监控从 Cloudflare 的境外节点发起，每次最多等 5 秒；连续两次失败才推「掉线了」。关键词只在 2xx 的文本页面里找，错误页、验证页判断不了就保持上次的状态。连续多次等不到回应的，改成每天试一次，并告诉你一声。

### 监控管理接口

App 用的接口，凭账号的 `Authorization: Bearer {secret}`，只有监控的创建者能调，别人的一律 404。

| 接口 | 说明 |
|---|---|
| `GET /account/{id}/watches` | 我建的全部监控 |
| `POST /account/{id}/watches` | 新建：`kind`（`up` / `keyword` / `heartbeat`）、`channelId`、`url`、`keyword`、`present`、`intervalMinutes`、`graceMinutes`、`name`、`level`、`repeat`、`maintenance`（写法见下） |
| `PATCH /account/{id}/watches/{wid}` | 编辑，见下 |
| `POST /account/{id}/watches/{wid}/check` | 立即检测（网址监控） |
| `GET /account/{id}/watches/{wid}/history?tz=Asia/Shanghai` | 历史与可用率 |
| `DELETE /account/{id}/watches/{wid}` | 删除；它排着的重复提醒一并停掉 |

**编辑**：body 里只放要改的字段，字段名同新建（也认列表里的下划线写法 `interval_minutes` `grace_minutes` `channel_id`），校验和新建完全一样，写错回 400 并说明原因。心跳改了什么报到地址都不变。

- `name` `url` `keyword` `present` `intervalMinutes` `graceMinutes` `channelId`：同新建。换通道时新通道也得是自己建的、没被停用、不是只收加密的。名字当初没起（用的是网址的域名）的，换网址时名字跟着换；心跳的宽限当初是缺省值的，改间隔时按新间隔重算
- `kind`：掉线（`up`）和关键词（`keyword`）可以互换；网址监控和心跳不能互相改
- `level` `repeat`：给 `null` / `0` 去掉
- `paused_until`：毫秒时刻 = 暂停到那时（最长一年），`0` = 一直暂停，`null` = 恢复
- `maintenance`：`{"days": [7], "start": "03:00", "end": "04:00", "tz": "Asia/Shanghai"}`，`null` 去掉。`days` 是窗口开始的那几天（1 = 周一 … 7 = 周日），`end` 不晚于 `start` 时跨到第二天，两者相同是整整 24 小时

换网址后下一轮就查新网址；换了盯法（类型、关键词、出现还是消失）按新建处理，第一次检查不提醒。暂停、换通道、换盯法时，原来那件事排着的重复提醒一并停掉。

**立即检测**：现在就抓一次，回 `{"result": {"status", "ok", "detail", "response_ms", "checked_at"}, "alerted", "watch"}`。结果和定时检查走同一条路：真的掉线了照样推告警，而且同一次掉线只推一次 —— 手动查出来推过的，定时检查不会再推。每个监控每分钟最多一次（刚被定时检查过也算），超了回 429 和 `Retry-After`。心跳没有网址可查，回 400。

**历史**：`changes` 最近 20 次状态变化（`at` `status` `detail`，暂停或维护期间发生的带 `quiet`）；`checks` 最近 24 小时的每次检查（`at` `ok` `ms`，心跳是每次报到，`ms` 是运行用时）；`daily` 最近 30 天按 `tz` 的日期汇总（`date` `up_seconds` `down_seconds` `uptime`，没数据的日子不列）；`uptime_24h` `uptime_7d` `uptime_30d`。`tz` 不给就用维护窗口的时区，再没有按 UTC。

可用率按时长算：每次检查时，上一次以来的那段时间算在上一次的结论名下；暂停期间、维护窗口里的异常不计入；往下取两位，有过异常就不会显示成 100。还没有数据时是 `null`。改版之前建的监控从第一次检查起开始记。

**监控视图**（列表、新建、编辑、立即检测都回）在原有字段之外多几项：`ref`、`paused_until`（暂停着才有）、`maintenance` 和 `in_maintenance`、`uptime_24h` `uptime_7d` `uptime_30d`、`last_response_ms`（网址监控）或 `last_duration_ms`（心跳）、`running_since`（心跳调过 `/start` 还没报到）。

**告警里的 `watch_id`**：监控和心跳的告警 payload 都带 `watch_id`，值等于这个监控视图里的 `ref`，App 凭它打开监控详情。网址监控的 `ref` 就是监控 id；心跳的 id 就是报到地址里的凭据，群成员不该拿到，所以 `ref` 是由 id 单向推出来的一串（和心跳告警的消息 id 相同）。`watch_id` 不是推送参数，发送方给不了。

### 网页发送

不写代码的人也能发：把 `https://nfo.im/send#{key}` 发给他，在浏览器里填好就能推。key 在 `#` 之后，浏览器不会把它发给服务器；网页发出的内容不做端到端加密。

更好的办法是给他一个[发送令牌](#发送令牌)的网页链接 `https://nfo.im/s/{令牌}`：页面先写明「发给：{通道名}」，只能填标题、内容和级别；令牌可以单独停用、限定最高级别，用不着把通道的地址交出去。令牌停用、删掉之后，这一页直接说「已停用」「已失效」；通道设了「只接受加密消息」时，这一页打开就说发不了（网页发出的是明文），不必等填完点了发送才知道。

## 发送令牌

一个通道除了自己的推送地址，还可以发出最多 10 个**发送令牌**：给 NAS 一个、给 Grafana 一个、给家里人的网页链接一个。每个令牌有名字，推出去的通知上写着「来自：NAS」（payload 带 `from`，重复提醒的补发也带）；可以单独停用、限定最高级别和每分钟条数，哪个来源最吵也看得出来。令牌只能推送，看不到通道收到的其他消息，也改不了任何设置。

令牌长这样：`st_` 加 43 个字符（和 22 个字符的推送 key 一眼分得开）。凡是能写 key 的地方都能用它：

```bash
curl https://nfo.im/st_xxxx/备份完成
curl https://nfo.im/ -H "Authorization: Bearer st_xxxx" -d "磁盘满了"
curl https://nfo.im/hook/st_xxxx/grafana -H 'content-type: application/json' -d @alert.json
node pigeon-send.mjs https://nfo.im/st_xxxx --key {通道加密密钥} --body "剩余 3%"   # 加密工具也认令牌
```

管理接口只有通道的创建者能调（成员 403），请求头都是 `Authorization: Bearer {账号凭据}`：

| 接口 | 说明 |
|---|---|
| `GET /account/{id}/channels/{cid}/tokens` | 全部令牌：`{"tokens": [令牌…], "limit": 10}`，不含令牌明文 |
| `POST /account/{id}/channels/{cid}/tokens` | 新建。请求体 `{"name", "max_level"?, "per_minute"?}`；响应 `{"token": 令牌, "value": "st_…", "push_url", "page_url"}`。**令牌明文只有这一次**：服务端只存它的 SHA-256，丢了就删掉重建 |
| `PATCH /account/{id}/channels/{cid}/tokens/{tid}` | 改名、改限制、停用或恢复：`name`、`max_level`、`per_minute`（给 `null` 去掉限制）、`disabled`（true / false）。响应 `{"token": 令牌}` |
| `DELETE /account/{id}/channels/{cid}/tokens/{tid}` | 删除：`{"deleted": tid}`。之后 30 天里还用它推的，收到 410 |

一个「令牌」是 `{"id", "name", "hint", "max_level"?, "per_minute"?, "disabled", "created_at", "count", "last_used_at"?}`：`hint` 是令牌的末四位，`count` 和 `last_used_at` 是用了几次、最近一次的时刻（毫秒，最多晚一分钟）。

- `name`：必填，20 字以内，同一个通道里不重名 —— 通知上靠它分出是谁发的
- `max_level`：`passive` / `active` / `timeSensitive`。高于它的按它送，响应的 `warnings` 里写明；设在 `active` 及以下的，也不能要求重复提醒（`repeat` 被去掉）。不设、或给 `null`、`critical` 就是不限
- `per_minute`：1–60。超了回 429，不占通道每分钟 60 条的额度 —— 一个吵闹的来源先被拦下，别的照常推得进来
- 一个通道最多 10 个；通道删掉时，它的令牌一并删掉
- 网页 `GET /s/{令牌}`：200 可以发；403 令牌停用了、通道被停用了、或者通道只收加密消息；410 令牌删掉了；404 没有这个令牌；429 同一网络查不存在的地址太频繁。页面不缓存，打开它不算「用过」

**换了推送地址之后**（App 里「更换推送地址」，即 `POST /account/{id}/channels/{cid}/key`）旧地址立即失效，30 天内再用它推的收到 410「地址已停用：请到 App 里复制新地址」，而不是「key 不存在」；通道的创建者一天最多收到一条静默提醒「旧地址还有人在用」，写明请求从哪个入口、用什么程序发来（比如 `路径式推送，curl/8.4.0`），方便找出还没换地址的脚本。删掉的发送令牌同样处理。

## 端到端加密

标题、正文、链接、标签在发送端就加密好，服务端和 Apple 只经手密文，由你设备上的 App 解密。

```bash
curl -sO https://nfo.im/tools/pigeon-send.mjs          # 就是本仓库的 tools/pigeon-send.mjs，逐字节一致
node pigeon-send.mjs https://nfo.im/{key} --key {通道加密密钥} --title "磁盘满了" --body "剩余 3%"
node pigeon-send.mjs https://nfo.im/{key} --key {通道加密密钥} --id db-01 --repeat 5 --title "主库连不上" --body "db-01 无响应"
node pigeon-send.mjs https://nfo.im/{key} --delete --id db-01    # 撤回：只发 id，用不着密钥
```

密钥也可以放在环境变量 `PIGEON_KEY` 里。拼错或不认识的参数直接报错（退出码 2），不会悄悄丢掉；`--image` `--icon` `--copy` 这类也是内容、得一起加密，App 还没接上，暂不支持。

通道加密密钥在 App 的「通道设置 → 端到端加密」里。通道可以设成「只接受加密消息」：没带密文的推送，和在密文之外还带着明文标题、副标题、正文、链接、标签、复制内容的推送，服务端一律回 400（创建者在 App 里设的通道默认值不算）。

格式（写别的语言的发送端时照这个来）：

- 算法：AES-256-GCM，12 字节随机 nonce，16 字节认证标签
- `ciphertext` = base64(密文 ‖ 标签)，`iv` = base64(nonce)
- 明文是 UTF-8 的 JSON 对象：`title` `subtitle` `body` `url` `tags`，都可选
- `level` `id` `status` `group` `sound` `repeat` `isArchive` `delete` `live` 不加密 —— 服务端投递时要用
- 通道密钥 = HKDF-SHA256(账号主密钥, salt `pigeon-e2e-v1`, info `channel:{通道 id}`)，32 字节。主密钥在设备上生成、从不上传；群成员从邀请链接 `#` 后面那段拿到群密钥，浏览器从不把这一段发给服务器

边界：通道名、推送时间、级别这类投递要用的字段不加密，图标、图片网址和 `copy` 目前也不在密文里；第三方 webhook 不会替你加密，发往适配器的内容以明文经过服务端（处理完即释放，通道设了重复提醒时暂存到提醒结束）。完整的说明见[隐私政策](https://nfo.im/privacy)。

## 群组

一个通道可以邀请别人一起接收。只有创建者能看到推送地址、改设置、管成员 —— 成员调管理接口一律 403，接口和推送里都拿不到地址。邀请码 8 位、7 天有效，加入前必须确认。群组通知带「我来处理」按钮：第一个认领的人会广播给所有人，各人的原通知被原地替换成「某某 正在处理」。认领管到这件事结束：同一个 `id` 推来 `status=resolved` 或被撤回之后，下次再触发要重新有人接手；同一次触发的重发（没写 `status` 或仍是 `firing`）不会把认领清掉。

**成员发消息**：群主可以打开「允许成员发消息」（`PATCH /account/{id}/channels/{cid}` 带 `"member_send": true`，默认关；通道视图里有 `"member_send": true`，成员也看得到），成员就能在 App 里往群里发一句话；群主自己随时能发：

```
POST /account/{id}/channels/{cid}/messages
{"title"?: "…", "body": "…", "level"?: "passive" | "active" | "timeSensitive"}
```

- 只有标题（100 字以内）、正文（1000 字以内）、级别，最高到时效性，不能是 `critical`；只收加密的群改交 `ciphertext` 和 `iv`
- 通道的默认参数不垫底（那是给集成配的，比如一律重复提醒），没有链接、图片、重复提醒
- 群里的违禁词过滤、只收加密、停用、每个通道每分钟 60 条照样管；每个人每分钟最多 20 条
- 推出去的 payload 带 `sender`（发消息的人的显示名）；没写标题时标题就是这个名字。发消息的人自己的设备静默收下，只进历史
- 成员没开放 → 403「群主没有开放成员发消息」；响应 `{"id", "delivered", "devices", "warnings", …}`，`delivered` 和 `devices` 里含发消息的人自己的设备

**接收者自己说了算**：群主定的是「这条消息长什么样」，每个接收者还可以按自己的意思调，存在账号的偏好里（`PATCH /account/{id}` 的 `prefs_patch`，逐条合并）：

- `critical`：`{通道 id: true}` 允许这个群的 `critical` 突破自己的免打扰。**没有条目就是不允许**：群主或拿到地址的人写 `critical`，到你这里按时效性送，免打扰、通道的免打扰时段照样管它。自己建的通道不看这一项，照旧能突破
- `minLevel`：`{通道 id: "passive" | "active" | "timeSensitive" | "critical"}` 最低提醒级别，低于它的一律静默送达（照样进通知中心和历史）。比如设成 `timeSensitive`，这个通道只有要紧的才响；设成 `critical` 就只有紧急的响 —— 和免打扰不同，没授权的紧急照样按时效性响

## 通知按钮

`actions` 让通知上带按钮，最多 3 个。长按通知（或在通知里展开）就能直接处理，不用先打开 App。

```bash
# 简写：名字=目标，分号或换行隔开。名字前加 ! 是危险操作（红色、点之前要解锁手机）
curl https://nfo.im/{key} -d id=deploy-42 --data-urlencode "title=生产要发版" \
     --data-urlencode "actions=查看=https://ci.example.com/run/42; !回滚=POST https://ci.example.com/rollback/42"
# JSON 写法，字段更全
curl https://nfo.im/{key} -H 'content-type: application/json' \
     -d '{"title":"验证码 482910","body":"有人在登录","actions":[{"type":"copy","label":"复制","value":"482910"},{"type":"reply","label":"回一句","url":"https://bot.example.com/reply"}]}'
```

每个按钮的字段：

| 字段 | 说明 |
|---|---|
| `type` | `open` 打开链接 · `http` 由服务端代发请求 · `copy` 复制内容 · `reply` 弹出输入框回一句话。不写时按其它字段猜：有 `url` 无方法是 `open`，有方法/请求头/请求体是 `http` |
| `label` | 按钮名，最多 20 字（必填） |
| `url` | `open`/`http` 的目标地址；只收 https 的公网域名（不收 IP、内网域名、带账号密码的地址）。`reply` 给了 `url` 就把回复也发过去 |
| `method` | `http` 的方法：`GET` `POST`（默认）`PUT` `PATCH` `DELETE` |
| `headers` | `http` 自带的请求头（英文、最多 8 个；`Host`、`X-Pigeon-*` 这类由服务端定的不能改） |
| `body` | `http` 的请求体原文；不给时 `POST`/`PUT`/`PATCH` 发一份说明「谁点了什么」的 JSON |
| `value` | `copy` 要复制的内容（也可写成 `text`） |
| `destructive` | `true` 按钮显示成红色 |
| `auth` | `true` 点之前要解锁手机 |

`open`、`copy` 在手机上就地完成。`http`、`reply` 交给服务端代发：推送 payload 里带着按钮定义和一份服务端签的 `act_sig`，点按时 App 把它们原样交回 `POST /account/{id}/channels/{cid}/actions`（请求体 `{message_id, index, actions, act_sig, reply_text}`，回 `{status, ok, error}`：对方回的状态码、成没成、没成的原因），服务端核对签名（确认这组按钮真是从这个通道推出去、一个字没改过），再替你去请求。所以按钮的定义会算进 4KB 的额度（最多约 1.5KB），也不能带进只收加密的通道（按钮的名字和地址没法加密）。

服务端代发的请求原样带上按钮给的方法、请求头、请求体，再加上通道回调密钥的签名头，接收方据此确认请求确实出自信鸽：

```
X-Pigeon-Timestamp: <秒级时间戳>
X-Pigeon-Signature: sha256=<hex(HMAC-SHA256(通道回调密钥, "时间戳.请求体"))>
X-Pigeon-Event: action          （回话的按钮是 reply）
User-Agent: Pigeon-Callback/1
```

按钮没给 `body` 时，`POST`/`PUT`/`PATCH` 发一份说明谁点了什么的 JSON，和下文的回调事件同一个形状，多一个按钮序号 `index`；`GET`/`DELETE` 不带请求体，签名签的就是「时间戳.」：

```json
{"event":"action","channel_id":"…","id":"deploy-42","by":"李四","at":1700000000000,"action":"回滚","index":1}
```

代发只走 https、只请求公网域名，最多等 5 秒，重定向只跟同主机、最多 3 跳 —— 这个代发口子不会被拿去探内网或把带签名的请求引到别处。点按钮的人拿到的结果就是对方回的状态码（「回滚 · 200」）；5 秒没回、跳去了别的主机，写明原因。群里有人点了按钮，会像认领那样原地广播一条「李四 点了「回滚」· 200」（回话的原文不广播，只进回执和回调）。

在 App 里：点完按钮，那条通知原地换成结果（「回滚 · 200」，没成就写原因，按钮还在、再点就是重试）；
带按钮的消息在历史的卡片和详情里也能点，详情里列出谁点过（群主看自己的群时取的是回执，别人回的原文也在）。通知上「复制」「我来处理」排最前，发送方的按钮跟在后面、一个不丢。
另外，普通和群组的通知默认带「30 分钟后再提醒」「本通道静音 1 小时」两个按钮（验证码、个人通道的重复提醒不带），
只在还有空位时补上；接收的人可以在「设置 → 通知与铃声」里关掉。

## 回执与回调

想让脚本知道「谁、几点处理了」，有两条路：

- **回调**（即时）：推送时带 `callback=https://…`（或者给通道设个默认的），下面这几件事一发生，服务端就 POST 一条带上面同一套签名头的 JSON 事件，`X-Pigeon-Event` 头就是事件名：

  | 事件 | 什么时候 | 额外的字段 |
  |---|---|---|
  | `ack` | 第一个人认领（点了「我来处理 / 知道了」） | `by` |
  | `action` | 有人点了 `http` 按钮 | `by` `action`（按钮名） |
  | `reply` | 有人点了 `reply` 按钮、写了一句 | `by` `action` `reply`（写的原文） |
  | `expired` | 重复提醒（`repeat`）的最后一次也响过了，还是没人认领。之后仍可能有人认领，那时照样再来一条 `ack` | `reminders`（连原消息一共响了几次） |

  ```json
  {"event":"reply","channel_id":"…","id":"deploy-42","by":"李四","at":1700000000000,"action":"回一句","reply":"稍等，我在看"}
  ```

  回调只发元数据、不带推送正文，地址本身也不进推送内容。尽力而为：最多等 5 秒、失败不重试 —— 靠下面的回执兜底。

- **回执**（查询 / 长轮询）：`GET https://nfo.im/{key}/receipt/{消息 id}?wait=0..60&since=毫秒`，用推送的 key 鉴权（能推的人才查得到）：

  ```bash
  curl "https://nfo.im/{key}/receipt/deploy-42?wait=60"
  ```

  返回 `{acked_by, acked_at, actions:[{by, at, label, type, status, ok, reply}]}`：谁认领的、几点（毫秒），点过哪些按钮、代发请求的状态码和成没成、回的原文。
  `wait` 大于 0 时长轮询：有人认领或点按钮就立刻返回，到点还没有就返回当前状态。拿到一次结果之后想接着等下一件事，把其中最晚的 `at` 作为 `since` 带上，否则有过动作的回执每次都立刻返回。
  回执存在各地机房的缓存里：别处刚发生的事，可能要约一分钟才查得到 —— 要即时就用回调。每个通道每分钟最多查 60 次，回执保留 7 天。

签名的核对方法（以 Python 为例；请求体要用收到的原始字节，别先解析再序列化）：

```python
import hashlib, hmac, time
def from_pigeon(secret: str, timestamp: str, signature: str, raw_body: bytes) -> bool:
    expected = "sha256=" + hmac.new(secret.encode(), timestamp.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    # 时间戳也要看：5 分钟以外的当重放丢掉
    return hmac.compare_digest(expected, signature) and abs(time.time() - int(timestamp)) < 300
```

**通道回调密钥**用来签名上面这些出站请求，只有创建者看得到、能重置（App 里在通道设置的「通知按钮与回调」，显示、复制、重置之前先验本人）：

```bash
curl -H "Authorization: Bearer {secret}" https://nfo.im/account/{id}/channels/{cid}/callback-secret        # 查看（没有就生成一把）
curl -X POST -H "Authorization: Bearer {secret}" https://nfo.im/account/{id}/channels/{cid}/callback-secret  # 重置：旧的立即失效
```

**通道默认的回调地址**：同一个地方还能设「默认回调地址」，之后这个通道的每条推送都按它回调，推送自己带的 `callback` 优先。它存在通道的默认参数里（`defaults.callback`，最多 200 字）；默认的 `callback`、`actions` 保存时就校验，写错了回 400，不会等到推送时才悄悄丢掉。
## 通知体检与告警演练

App 设置里的「通知体检」调的是 `POST /account/{id}/selftest`（带账号凭据 `Authorization: Bearer {secret}`，每个账号每分钟最多 20 次）。
「设置全开却收不到」的原因多半出在服务端和 Apple 之间看不见的那一段：本机不在账号里、登记的推送环境和 App 对不上、令牌早已失效、Apple 拒收……
这里把服务端这一侧能查的都查一遍，每台设备给一个 APNs 的原始答复。请求体（JSON，都可选）：

| 字段 | 说明 |
|---|---|
| `token_prefix` | 本机推送令牌的前 12 位（或完整令牌）。给了就只给本机推测试通知，同账号的其它设备只发后台探测、不打扰人，并回 `this_device`：本机在不在账号里（`registered`）、登记的推送环境 |
| `environment` | 本机 App 实际用的推送环境 `sandbox` / `production`，和登记的比对，回 `this_device.environment_matches` |
| `drill` | `true` = 告警演练，见下 |
| `channel_id` | 演练用哪个通道。不给就挑第一个只有自己、不要求加密的通道 |
| `drill_resolve` | 演练的 `id`：推一条「已恢复」收尾 |

**往返测速**（默认）：测试通知是静默的、不进历史，10 分钟内没送到就作废。payload 里带 `selftest`（这一次的随机标识）和 `sent_at`，App 的通知扩展收到后记下送达时刻，和发请求的时刻一比，就是「服务器 → 本机」花了多久。响应：

- `nonce`、`sent_at`、`expires_at`（毫秒）
- `devices`：每台设备 `{token_prefix, name, environment, kind, status, reason?, this_device?}`。`kind` 为 `alert`（推了测试通知）或 `probe`（只探测）；`status` 是 APNs 的 HTTP 状态码，200 是收下了，失败时 `reason` 是 APNs 的原始原因
- `delivered`：APNs 收下的测试通知条数
- `silenced`：此刻被压成静默的通道 `{channel_id, name, muted_until?, quiet_hours?, min_level?}` —— 自己开了免打扰的（`muted_until` 毫秒，`0` 是一直），正在通道免打扰时段里的（带上时段），自己把最低提醒级别设到了 `timeSensitive` 或 `critical`、普通消息不响的（带上 `min_level`，见[群组](#群组)里的接收方设置）。这些通道的消息照常送达，只是不响、不亮屏
- `problems`：查出来的毛病 `{code, message, token_prefix?}`，`message` 可以直接给人看。`code` 有 `not_registered`（本机不在账号里）、`environment_mismatch`、`device_invalid`（令牌已失效）、`push_failed`、`no_devices`，演练还有 `repeat_skipped`、`quiet_hours`、`muted`、`min_level`（最低提醒级别设成了只提醒紧急的，时效性的演练静默送达）

**告警演练**（`drill: true`）走真告警的全套路子：在一个只有自己的通道上推一条时效性的测试告警，带「知道了，别再提醒」按钮；约一分钟后的那一轮重复提醒巡检补发一次（时刻在 `drill.remind_at`），之后不再补；点「知道了」走平常的认领接口；最后 `{"drill_resolve": id}` 推一条 `status=resolved` 的「已恢复」，响应里 `drill.acked` 说明之前有没有人点过「知道了」，重复调用不再推。
真告警会碰上的免打扰时段、个人静音、自己设的最低提醒级别、重复提醒满额，演练一样会碰上，写在 `drill.quieted`、`drill.muted`、`drill.repeat_skipped` 和 `problems` 里。
演练和真告警一样推给账号里的每台设备，不进历史；群组（补发会吵到全群）和只收加密的通道不能演练；本机不在账号里时回 409。

体检记录存在 KV 的 `selftest:{账号 id}:{nonce}`，只有时刻和通道 id，10 分钟后自动删除。

## 多设备已读

账号偏好里的 `readThrough`（`PATCH /account/{id}` 的 `prefs_patch`）：通道 id → 毫秒时刻，这个通道里发出时刻（`sent_at`）不晚于它的消息都算读过了。一台设备上读了，别的设备刷新账号时照着它标成已读。

- 只进不退：交上来的比已有的早就不理，按项合并（`prefs_patch`）和整份提交（`prefs`）都一样；老版 App 整份提交时不带这一项，原样保留。条目给 `null` 才删掉
- 比服务端此刻晚 10 分钟以上的截到那一刻：时钟快了的设备不会把之后来的消息都标成已读
- 删除通道、退出群组时，对应的条目一起清掉

## 举报、屏蔽与停用

群组成员可以在 App 里举报整个群，或其中一条消息；也可以屏蔽群主 —— 立即退群，此后这个人再发邀请也进不来。
[使用条款](https://nfo.im/terms) 对违规内容零容忍，这也是 App Store 对用户生成内容的要求。

群组（有成员的通道）的明文标题、副标题、正文在推送入口过一遍最小的违禁词表（`src/contentfilter.ts`），命中回 400、不送达。
词表可以用 KV 的 `config:blocklist` 整份替换（JSON 字符串数组，`[]` 为关闭），一分钟内生效：

```bash
npx wrangler kv key put --binding PIGEON_KV --remote config:blocklist '["词一","词二"]'
```

举报存在 KV 的 `report:` 下，90 天自动删除。**服务端没有任何管理接口**，处理举报用的是本机 wrangler 的登录态 ——
能处理举报的，只有能部署这个 Worker 的人：

```bash
npm run mod -- reports                       # 看举报
npm run mod -- suspend <通道 id> 理由          # 停用：推送、邀请、认领一律拒绝
npm run mod -- restore <通道 id>               # 恢复
npm run mod -- suspend-owner <账号 id> 理由    # 停用这个人创建的全部通道
npm run mod -- inbox <通道 id>                 # 指定接收举报通知的通道
```

## 备份与恢复

KV 是这个服务唯一的存储：账号、通道、群组、监控全在里面。和处理举报一样，备份用本机 wrangler 的登录态直接读 KV，
服务端没有导出接口。能部署这个 Worker 的人才备份得了、恢复得了：

```bash
npm run backup                                    # 导出线上 KV 的每一个键：值、metadata、过期时刻
npm run backup -- --verify ~/pigeon-backups/pigeon-kv-20260927-031500.json.gz   # 检查备份
npm run backup -- --restore <备份文件>              # 演练恢复：只说会写哪些键，什么都不写
npm run backup -- --restore <备份文件> --apply      # 真的写回（先问一句，--yes 不问）
```

- **导出**：默认存到 `~/pigeon-backups/pigeon-kv-{年月日-时分秒}.json.gz`（`--out` 换目录或文件名，或者设 `PIGEON_BACKUP_DIR`），gzip 压缩的 JSON，文件权限 600。
  备份里有账号凭据的摘要、设备推送令牌、举报原文和暂存的重复提醒 —— 和线上数据一样敏感，脚本不许把它写进仓库目录。
  每个键要单独读一次（wrangler 一次只读一个），线上每秒约 3 个，一千个键五六分钟。`--prefix acct:` 可以只导出某些前缀（能叠加）。
  导出过程中别处还在写 KV，备份是这几分钟里陆续读到的样子，不是同一瞬间的快照。
- **检查**（`--verify`）：格式版本、条数、整份的 SHA-256 校验和、每一条的键名长度、值、metadata 大小、过期时刻，按前缀列出条数。改过一个字节都会报出来。
- **恢复**（`--restore`）：先检查备份，再列出目标里现有的键，说清会新建几个、覆盖几个、跳过几个已经过期的，目标里另有几个键不在备份里（不会动它们）。
  只有加 `--apply` 才写，用的是 `wrangler kv bulk put`。只写不删：要回到备份那一刻的完整状态，得先自己清空命名空间。
  `--prefix` 可以只恢复一部分，比如只把一个账号的记录写回去：`--restore <文件> --prefix acct:{账号 id} --apply`（它建的通道在 `chan:`、`ch:` 下，要一起恢复就再加上）。

以上都能加 `--local`，对本地 `wrangler dev` 的那份 KV 做，先拿它试一遍恢复流程；本地库直接打开读写，上千个键一两秒。
`--persist-to <目录>` 指定别的本地库目录（隐含 `--local`，和 `wrangler dev --persist-to` 同一个意思）。演练灾难恢复就用它，全程不碰线上：

```bash
npm run backup -- --restore ~/pigeon-backups/pigeon-kv-….json.gz --persist-to /tmp/pigeon-drill --apply   # 写进一个空目录
npx wrangler dev --local --persist-to /tmp/pigeon-drill                                             # 用它起一个本地服务
curl -H "Authorization: Bearer {secret}" http://localhost:8787/account/{id}                        # 账号、通道都回来了没有
```

## 自建

可以部署自己的实例（`wrangler deploy`）来研究、审计，但要知道：**iOS 推送必须用 App 开发者的密钥签名**，官方信鸽 App 只能收到 nfo.im 发出的推送，别人部署的实例推不到它；iOS App 也不开源。想让服务端看不到内容，用上面的端到端加密。

`wrangler.toml` 里的 KV id、Team ID、自定义域名都是线上实例的值，自己部署时换成你自己的。

## 文档站

`https://nfo.im/docs` 是给用户看的文档（`src/docs.ts`：每节一段 Markdown，按顺序渲染；`/docs/{节}` 跳到对应锚点）。`/robots.txt` 只放行首页、文档、帮助、隐私政策、使用条款（其余路径都是接口，抓一次就是推一次），`/sitemap.xml` 列出这几页，各页带 `canonical` 和 `og:` 标签。

## 开发

```bash
npm install
npm test          # 单元测试 + 起一个本地 Worker 跑端到端的 API 测试
npm run dev       # 本地 wrangler dev
```

API 测试共用的那个本地 Worker 没有 APNs 私钥，告警推不出去。`test/api-l3-lifecycle.test.mjs` 另起一个：接上本机一个假的 APNs（自签证书，要有 `openssl`）和一个状态码随时可改的假网站，拨着巡检的钟，把网址监控和心跳从掉线、恢复、维护窗口、暂停到退出码、失联整条链路真推一遍，逐条核对推出去的内容。它只连本机，不碰线上。

本地调试需要 `.dev.vars` 里的 `APNS_KEY_P8`（不入库）。

API 测试共用的那个本地 Worker 没有 APNs 私钥，推到投递就是 502。要看每台设备实际收到的 payload（群里每个人按自己的设置拿到哪一版、令牌推的带不带 `from`），`test/api-l4-e2e.test.mjs` 另起一个 wrangler dev：临时私钥、`APNS_HOST` 指到测试进程里的假 APNs（openssl 现签的自签证书，经 `NODE_EXTRA_CA_CERTS` 信任），服务端代码不为测试改一行。需要本机有 `openssl`。

改了实时活动推送或登记接口的样子，`test/api-l6-live-samples.test.mjs` 会失败：确认 App 解得开之后，
`UPDATE_FIXTURES=1 node test/api-l6-live-samples.test.mjs` 重新生成 `test/fixtures/live-activity-samples.json` —— App 的测试拿同一份样本按系统的规矩解码。

## 许可

AGPL-3.0-only。你可以自由使用、修改、自建；拿去对外提供服务时，改动也必须以同样的许可公开。
