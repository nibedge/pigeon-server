# 信鸽 Pigeon · 服务端

[![test-and-deploy](https://github.com/nibedge/pigeon-server/actions/workflows/deploy.yml/badge.svg)](https://github.com/nibedge/pigeon-server/actions/workflows/deploy.yml)

把任何服务的 webhook 变成一条看得懂的 iOS 通知。运行在 Cloudflare Workers 上，存储用 KV。

线上实例：<https://nfo.im> · 隐私政策：<https://nfo.im/privacy>

## 为什么开源

推送服务经手你的通知。与其让你「相信我们」，不如让你能核对：

- **服务端存了什么**：KV 里只有这几类记录 —— `acct:` 账号、`chan:` 通道、`ch:` 推送地址指针、`inv:` 邀请码（7 天过期）、`ack:` 认领记录（24 小时过期）、`dedupe:` 去重哈希（最长 1 小时过期）、`report:` 举报记录（90 天过期）、`watch:` 网站监控与心跳的配置（`wown:` 按创建者的索引、`hbstate:` / `wstate:` 最近一次状态和历史 —— 最近 20 次状态变化、24 小时的每次检查、30 天按小时的可用时长、`watchdel:` 刚删除的监控，10 分钟过期）、`repeat:` 重复提醒（最长约 70 分钟过期）、`rptslot:` 重复提醒占位（只有 id，用来数同时在响几条，最长一小时过期）、`rlnote:` 推送被限流时「已通知过创建者」的标记（1 小时过期）、`stat:` 通道的推送条数、`susp:` 通道停用标记、`dead:` 已失效推送令牌的摘要（30 天过期）、`rmdev:` 被移出账号的设备（令牌的摘要，30 天过期）、`sweep:` 定时巡检最近一轮的时刻和条数、`config:` 服务端设置。**推送内容不落盘**（例外只有两个：举报时举报人自己选择附上的那条消息；要求重复提醒的消息在提醒期间暂存，有人处理、消息恢复或满一小时即删除）。
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
| `level` | `passive` 静默 · `active` 普通（默认） · `timeSensitive` 时效性，专注模式下也会提醒 · `critical`（未获 Apple 授权前按时效性送） |
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
- 撤回的响应带 `"retracted": true`；排上了重复提醒带 `repeat`（隔几分钟、到几点、消息 `id`）；要求了重复提醒、但同时在响的已经满额时带 `"repeat_skipped"`（`channel_limit` 或 `account_limit`）；赶上通道的免打扰时段、被降成静默送达时带 `"quieted": true`；有接收者把这个通道静音了时，`muted` 是静默送达的设备数 —— 查「为什么没响」先看这两个。

| 状态码 | 意思 |
|---|---|
| 200 | 收下了。`data.suppressed` 为 `"duplicate"` 时是和刚才那条一模一样、被去重合并了（开了去重的通道），不必重发；`skipped` 为 `"preview"` 时是链接预览，什么也没推 |
| 400 | 请求本身有问题：没有内容可推、只收加密的通道收到了明文、撤回没带 `id`、地址少了 key、`/push` 一次太多，`message` 里写着具体原因 |
| 403 | 这个通道已被停用 |
| 404 | key 不存在：检查推送地址有没有抄错 |
| 410 | 这个通道下没有能收的设备，或者设备都已失效（之后不再推给它们）。在手机上重新打开 App 即可恢复 |
| 413 | 太长：请求体超过上限，或者截短文字之后仍然放不下（加密的内容没法截） |
| 429 | 发得太频繁，等一会儿再发。本服务的限流带 `Retry-After: 60` |
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

调过 `/start` 的，下一次报到（正常、失败、退出码都算）的回应里带 `duration_ms`，失败和恢复的提醒里写「这次用时 3 分 20 秒」，App 的监控详情里能看到每次的用时。`/start` 本身不算报到：不改状态、不影响失联的判定；离上次记下的开始不到 4 分钟的不记（比约定还勤的任务只记一部分用时）。退出码只认 0–255，别的数字回 404。

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

## 许可

AGPL-3.0-only。你可以自由使用、修改、自建；拿去对外提供服务时，改动也必须以同样的许可公开。
