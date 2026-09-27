# 信鸽 Pigeon · 服务端

[![test-and-deploy](https://github.com/nibedge/pigeon-server/actions/workflows/deploy.yml/badge.svg)](https://github.com/nibedge/pigeon-server/actions/workflows/deploy.yml)

把任何服务的 webhook 变成一条看得懂的 iOS 通知。运行在 Cloudflare Workers 上，存储用 KV。

线上实例：<https://nfo.im> · 隐私政策：<https://nfo.im/privacy>

## 为什么开源

推送服务经手你的通知。与其让你「相信我们」，不如让你能核对：

- **服务端存了什么**：KV 里只有这几类记录 —— `acct:` 账号、`chan:` 通道、`ch:` 推送地址指针、`stok:` 发送令牌（令牌只存摘要，明文只在新建时给创建者一次；另有每个通道的令牌清单和各令牌的使用次数）、`oldkey:` 换掉的推送地址和删掉的令牌（只存摘要，30 天过期）、`inv:` 邀请码（7 天过期）、`ack:` 认领记录（24 小时过期）、`dedupe:` 去重哈希（最长 1 小时过期）、`report:` 举报记录（90 天过期）、`watch:` 网站监控与心跳的配置（`wown:` 按创建者的索引、`hbstate:` / `wstate:` 最近一次状态、`watchdel:` 刚删除的监控，10 分钟过期）、`repeat:` 重复提醒（最长约 70 分钟过期）、`rptslot:` 重复提醒占位（只有 id，用来数同时在响几条，最长一小时过期）、`rlnote:` 推送被限流时「已通知过创建者」的标记（1 小时过期）、`stat:` 通道的推送条数、`susp:` 通道停用标记、`dead:` 已失效推送令牌的摘要（30 天过期）、`rmdev:` 被移出账号的设备（令牌的摘要，30 天过期）、`sweep:` 定时巡检最近一轮的时刻和条数、`config:` 服务端设置。**推送内容不落盘**（例外只有两个：举报时举报人自己选择附上的那条消息；要求重复提醒的消息在提醒期间暂存，有人处理、消息恢复或满一小时即删除）。
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

### 参数

| 参数 | 说明 |
|---|---|
| `title` | 标题 |
| `subtitle` | 副标题。也可以叫 `summary` |
| `body` | 正文，App 里按 Markdown 显示。也可以叫 `text` `message` `content` `msg` `desp` `description` |
| `markdown` | 只给了它、没给 `body` 时当正文；和 `body` 一起给时不显示 |
| `level` | `passive` 静默 · `active` 普通（默认） · `timeSensitive` 时效性，专注模式下也会提醒 · `critical`（未获 Apple 授权前按时效性送）。critical 会突破接收者自己的免打扰，但只对通道的创建者、以及在 App 里给这个群打开了「允许紧急消息」的成员；其余成员按时效性收到，照样守自己的免打扰（见[群组](#群组)） |
| `sound` | 铃声；不给就用系统默认，`none` 静音，`passive` 的消息本来就不出声。接收者在 App 里给这个通道选过铃声的，以接收者选的为准 |
| `url` | 点通知打开的链接 |
| `group` | 通知中心里的分组；不给就按通道分组 |
| `tags` | 逗号分隔，最多 5 个。认得的表情短码（`warning` `rotating_light` `white_check_mark`…）显示成表情，其余显示成可筛选的标签 |
| `image` | 大图地址（https，10 MB 以内），显示在通知里，App 历史里也留着。加入别人的群时，默认不加载群里的图片，接收者可以在通道详情里打开 |
| `icon` | 小图地址（https，2 MB 以内），显示成通知右侧的缩略图。同时给了 `image` 时让位给大图 |
| `copy` | 要一键复制的内容：通知上多一个「复制」按钮，App 历史里也能一键复制。没给时 App 会自己从文字里认验证码 |
| `autoCopy` | `1`：展开通知或点开进 App 时自动复制 `copy`（认出的验证码总是自动复制） |
| `isArchive` | `0`：不存进 App 历史 |
| `id` | 同一件事的标识。同 id 的新消息原地替换旧的（通知中心和 App 历史都是），撤回、停止重复提醒也靠它。超过 64 字节照样送达，只是不能原地替换，也排不上重复提醒 |
| `status` | `firing` / `resolved`。同一个 `id` 从进行中变成已恢复，App 会算出持续了多久；恢复之后这件事的认领随之结束，下次再触发要重新有人接手。`resolved` 从不被去重 |
| `repeat` | 重复提醒：每隔几分钟再推一次（5–60，`1` / `true` 即 5），直到有人点「知道了 / 我来处理」、同 `id` 推来 `status=resolved` 或 `delete=1`，最长一小时。`passive` 的消息不重复。响应里的 `repeat.id` 就是这条消息的 `id`。每个通道同时最多 10 条、同一个人名下的通道加起来最多 30 条在重复提醒，满了的照常送达，只是不再重复 |
| `delete` | `1` 撤回同 `id` 的消息，必须带 `id`，不用给标题正文：锁屏和通知中心里的原通知换成「此消息已撤回」，App 历史里删掉这条（旧版 App 是把历史里那条换成「此消息已撤回」）；它的重复提醒和认领也一并结束。已经被人看到的收不回来 |
| `ciphertext` `iv` | 端到端加密的内容，见下 |
| `badge` | 不生效：角标由 App 按未读条数自己管，传了也会被覆盖 |
| `call` `volume` `ttl` `action` | 认得，但这一版不生效 |

`badge` `call` `volume` `ttl` `action`，以及和 `body` 一起给的 `markdown`，会列在响应的 `data.ignored` 里，免得对着一个不生效的参数调半天。

### 写法

参数可以放在路径、query、请求头、请求体（JSON、表单）里，后面的覆盖前面的，路径最优先。通道在 App 里设过默认值的，垫在最底下。

- 路径式：`/{key}/{正文}`、`/{key}/{标题}/{正文}`、`/{key}/{标题}/{副标题}/{正文}`。只适合没有空格和特殊字符的短句，其余放请求体。
- 请求体直接是一句话也行：`text/*`、没写类型，或者 `curl -d "…"` 这种没有字段名的表单，整句当正文。请求体里一个字段都没认出来时，响应的 `warnings` 会说明（没有别的正文时回 400 并说明原因）。
- 请求头认 `Title`、`Priority`（`1`–`5` 或 `min` `low` `default` `high` `max` `urgent`，最高到 `timeSensitive`）、`Tags`、`Click`（点通知打开的链接）、`Id`。标题可以直接写中文。
- 参数名不分大小写。开关参数（`isArchive` `autoCopy` `delete`）写 `true` / `false` / `yes` / `no` 等同 `1` / `0`。
- key 也可以放在 `Authorization: Bearer {key}` 里，地址写根路径 `https://nfo.im/`。地址末尾的 `.send` 会被忽略。根路径没带 key 的推送回 400。
- 凡是能写 key 的地方（路径、`Authorization: Bearer`、`/push` 的 `device_key(s)`、`/hook/{key}/…`）都可以换成[发送令牌](#发送令牌)。
- 批量：`POST https://nfo.im/push`，JSON 里给 `device_key` 或 `device_keys`（一次最多 20 个），其余参数同上，每个 key 各自合上自己通道的默认值。结果逐个列在 `data.results` 里：每个 key 各有自己的 `id`、`warnings`、按需的 `truncated`（顶层没有这几项）；被去重压掉的标 `"suppressed": "duplicate"`，不算失败。一批牵涉的人和设备太多（估算的存储读写和推送请求超过 900 个：每人算一次读取、每台设备算三个，约四个每人一台设备的满员群）会整批回 400，请分批发送。

```bash
curl https://nfo.im/push -H 'content-type: application/json' \
     -d '{"device_keys":["{key1}","{key2}"],"title":"发版完成","body":"v2.3 已上线"}'
```

**不推送的请求**：`HEAD`、浏览器的预取（带 `Sec-Purpose` / `Purpose: prefetch`）、聊天软件抓链接预览的 GET，一律回 200 `{"ok":true,"skipped":"preview"}`，什么也不推 —— 把推送地址贴进聊天里不会误推一条。

**限流**：每个通道每分钟最多 60 条（路径式、`/push`、`/hook` 和心跳告警共用一份；心跳撞上额度时这次报到不记、回 429），超了回 429，带 `Retry-After: 60` 和中文原因；通道创建者会收到一条提醒，一小时最多一次。同一个 IP 查询不存在的 key，每分钟最多 30 次。

**长度上限**：Apple 限制一条推送最多 4KB，扣掉其它字段，标题加正文大约放得下 1100 个汉字。超出的部分由服务端截掉、末尾标上「…（已截断）」，照常送达，响应里带 `"truncated": true`（先截 `markdown`，再依次截 `body` `copy` `subtitle` `title`）。端到端加密的消息没法截，超出直接回 413，并写明当前字节数和上限。请求体最多 64 KB（`/hook` 最多 1 MB），超了回 413。

### 响应

都是 JSON：`{"code": 状态码, "message": "说明", "data": {…}, "timestamp": 秒}`。

- `data.id` 是这条消息的 `id`（没给就由服务端生成，之后替换、撤回、停提醒都靠它）；`data.delivered` / `data.devices` 是送到了几台、一共几台；`data.warnings` 是中文提示，比如截短了什么、`id` 太长当不了折叠标识；`data.ignored` 列出这一版不生效的参数。
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

### 直接接第三方 webhook

`POST https://nfo.im/hook/{key}/{适配器}`，不用写任何转换代码：

| 适配器 | 说明 |
|---|---|
| `github` | 构建失败或超时、需要审批、PR / Issue 的新建关闭合并、Release、push（含删分支、推标签）。取消和跳过的构建、check_run 这类细碎的 CI 事件不推。在仓库 Settings → Webhooks 里 Content type 选 `application/json`，事件选「Let me select individual events」并勾上 Workflow runs、Issues、Pull requests、Releases —— 默认只有 push |
| `grafana` | 告警触发与恢复（同一组告警合并成一件事，显示持续时长）。建好 contact point 之后，要在 Notification policies 里把它挂上才会收到 |
| `uptimekuma` | 掉线与恢复（待确认、维护中安静地推），证书和域名快到期的提醒。JSON 和 form-data 两种格式都认。要在每个监控项的设置里勾上这条通知 |

### 心跳监控

定时任务（备份、cron 脚本）跑完来报个到，过了约定的时间没来就提醒你。在 App 的监控里新建「心跳」，拿到报到地址：

```bash
curl -fsS https://nfo.im/hb/{id}                     # 跑完报到（GET / POST / HEAD 都行）
curl -fsS https://nfo.im/hb/{id}/fail -d "磁盘满了"  # 出错时报告失败，立刻提醒；只收 POST，说明也可以放在 ?msg= 里
```

第一次报到之前不会提醒；失联只提醒一次，任务回来报到时推「恢复」。心跳删掉（或者它推给的通道、所在的账号删掉）之后地址随之作废，报到回 404；通道被停用期间回 403。
报告失败只收 POST（`curl -X POST` 或 `-d`），GET 回 405：地址贴进聊天时，链接预览不会替你报失败。链接预览和浏览器预取来的请求回 200，不算报到。

网站监控从 Cloudflare 的境外节点发起，每次最多等 5 秒；连续两次失败才推「掉线了」。关键词只在 2xx 的文本页面里找，错误页、验证页判断不了就保持上次的状态。连续多次等不到回应的，改成每天试一次，并告诉你一声。

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
- `level` `id` `status` `group` `sound` `repeat` `isArchive` `delete` 不加密 —— 服务端投递时要用
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

## 自建

可以部署自己的实例（`wrangler deploy`）来研究、审计，但要知道：**iOS 推送必须用 App 开发者的密钥签名**，官方信鸽 App 只能收到 nfo.im 发出的推送，别人部署的实例推不到它；iOS App 也不开源。想让服务端看不到内容，用上面的端到端加密。

`wrangler.toml` 里的 KV id、Team ID、自定义域名都是线上实例的值，自己部署时换成你自己的。

## 开发

```bash
npm install
npm test          # 单元测试 + 起一个本地 Worker 跑端到端的 API 测试
npm run dev       # 本地 wrangler dev
```

本地调试需要 `.dev.vars` 里的 `APNS_KEY_P8`（不入库）。

API 测试共用的那个本地 Worker 没有 APNs 私钥，推到投递就是 502。要看每台设备实际收到的 payload（群里每个人按自己的设置拿到哪一版、令牌推的带不带 `from`），`test/api-l4-e2e.test.mjs` 另起一个 wrangler dev：临时私钥、`APNS_HOST` 指到测试进程里的假 APNs（openssl 现签的自签证书，经 `NODE_EXTRA_CA_CERTS` 信任），服务端代码不为测试改一行。需要本机有 `openssl`。

## 许可

AGPL-3.0-only。你可以自由使用、修改、自建；拿去对外提供服务时，改动也必须以同样的许可公开。
