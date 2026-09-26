# 信鸽 Pigeon · 服务端

[![test-and-deploy](https://github.com/nibedge/pigeon-server/actions/workflows/deploy.yml/badge.svg)](https://github.com/nibedge/pigeon-server/actions/workflows/deploy.yml)

把任何服务的 webhook 变成一条看得懂的 iOS 通知。运行在 Cloudflare Workers 上，存储用 KV。

线上实例：<https://nfo.im> · 隐私政策：<https://nfo.im/privacy>

## 为什么开源

推送服务经手你的通知。与其让你「相信我们」，不如让你能核对：

- **服务端存了什么**：KV 里只有这几类记录 —— `acct:` 账号、`chan:` 通道、`ch:` 推送地址指针、`inv:` 邀请码（7 天过期）、`ack:` 认领记录（24 小时过期）、`dedupe:` 去重哈希（最长 1 小时过期）、`report:` 举报记录（90 天过期）、`watch:` 网站监控与心跳、`repeat:` 重复提醒（最长约 70 分钟过期）、`rptslot:` 重复提醒占位（只有 id，用来数同时在响几条，最长一小时过期）、`config:` 服务端设置。**推送内容不落盘**（例外只有两个：举报时举报人自己选择附上的那条消息；要求重复提醒的消息在提醒期间暂存，有人处理、消息恢复或满一小时即删除）。
- **线上跑的是哪一版**：`GET /info` 返回当前运行的 `commit`。线上只从本仓库的 `main` 分支经 GitHub Actions 自动部署，构建日志公开。
- **看不到内容的办法**：端到端加密（见下）。开源是「你可以检查我们」，加密是「你不需要相信我们」。

## 推送

每个通道一个推送地址 `https://nfo.im/{key}`，在 App 的通道设置里复制。

```bash
curl https://nfo.im/{key}/服务器挂了                       # 只有正文
curl https://nfo.im/{key}/标题/正文
curl -d "磁盘满了，剩余 3%" https://nfo.im/{key}            # 请求体直接是一句话：整句当正文
curl -H "Title: 磁盘告警" -H "Priority: 4" -d "剩余 3%" https://nfo.im/{key}
curl -X POST https://nfo.im/{key} -H 'content-type: application/json' \
     -d '{"title":"磁盘满了","body":"剩余 3%","level":"timeSensitive","tags":"warning,prod"}'
```

| 参数 | 说明 |
|---|---|
| `title` `subtitle` `body` | 标题、副标题、正文（正文支持 Markdown） |
| `level` | `passive` 静默 · `active` 普通 · `timeSensitive` 时效性 · `critical`（未获 Apple 授权前按时效性送） |
| `sound` | 铃声；不给就用系统默认，`none` 静音 |
| `badge` | 目前不生效：角标由 App 按未读条数自己算 |
| `url` | 点通知打开的链接 |
| `group` | 通知中心里的分组；不给就按通道分组 |
| `id` | 同一件事的标识。同 id 的新消息会原地替换旧的（通知中心和 App 历史都是） |
| `status` | `firing` / `resolved`。同一个 `id` 从进行中变成已恢复，App 会算出持续了多久；恢复之后这件事的认领随之结束，下次再触发要重新有人接手。`resolved` 从不被去重 |
| `tags` | 逗号分隔。认得的表情短码（`warning` `rotating_light` `white_check_mark`…）显示成表情，其余显示成可筛选的标签 |
| `icon` | 通知图标 URL（https，2 MB 以内） |
| `isArchive` | `0` 不存进 App 历史 |
| `delete` | `1` 撤回同 `id` 的消息，必须带 `id`，不用给标题正文：锁屏和通知中心里的原通知换成「此消息已撤回」，App 历史里删掉这条（旧版 App 是把历史里那条换成「此消息已撤回」）；它的重复提醒和认领也一并结束。已经被人看到的收不回来 |
| `repeat` | 重复提醒：每隔几分钟再推一次（5–60，`1` / `true` 即 5），直到有人点「知道了 / 我来处理」、同 `id` 推来 `status=resolved` 或 `delete=1`，最长一小时。响应里的 `repeat.id` 就是这条消息的 `id`。每个通道同时最多 10 条、同一个人名下的通道加起来最多 30 条在重复提醒，满了的照常送达，只是不再重复 |
| `ciphertext` `iv` | 端到端加密的内容，见下 |

**写法**：参数可以放在路径、query、请求头、请求体（JSON、表单）里，后面的覆盖前面的，路径最优先。

- 请求体直接是一句话也行：`text/*`、没写类型，或者 `curl -d "…"` 这种没有字段名的表单，整句当正文。请求体里一个字段都没认出来时，响应的 `warnings` 会说明（没有别的正文时回 400 并说明原因）。
- 请求头认 `Title`、`Priority`（`1`–`5` 或 `min` `low` `default` `high` `max` `urgent`，最高到 `timeSensitive`）、`Tags`、`Click`（点通知打开的链接）、`Id`。标题可以直接写中文。
- 正文也可以叫 `text` `message` `content` `msg` `desp` `description`，副标题也可以叫 `summary`；只给 `markdown` 时它就是正文。开关参数（`isArchive` `autoCopy` `delete`）写 `true` / `false` / `yes` / `no` 等同 `1` / `0`。
- key 也可以放在 `Authorization: Bearer {key}` 里，地址写根路径 `https://nfo.im/`。地址末尾的 `.send` 会被忽略。根路径没带 key 的推送回 400。
- 批量：`POST https://nfo.im/push`，JSON 里给 `device_key` 或 `device_keys`（一次最多 20 个），其余参数同上，每个 key 各自合上自己通道的默认值。结果逐个列在 `data.results` 里；被去重压掉的标 `"suppressed": "duplicate"`，不算失败。一批牵涉的人太多（估算的存储读取超过 300 次，约五个满员的群）会整批回 400，请分批发送。

**不推送的请求**：`HEAD`、浏览器的预取（带 `Sec-Purpose` / `Purpose: prefetch`）、聊天软件抓链接预览的 GET，一律回 200 `{"ok":true,"skipped":"preview"}`，什么也不推 —— 把推送地址贴进聊天里不会误推一条。

**限流**：每个通道每分钟最多 60 条（路径式、`/push`、`/hook` 共用一份），超了回 429，带 `Retry-After: 60` 和中文原因；通道创建者会收到一条提醒，一小时最多一次。同一个 IP 查询不存在的 key，每分钟最多 30 次。

**长度上限**：Apple 限制一条推送最多 4KB，扣掉其它字段，标题加正文大约放得下 1100 个汉字。超出的部分由服务端截掉、末尾标上「…（已截断）」，照常送达，响应里带 `"truncated": true`（先截 `markdown`，再依次截 `body` `copy` `subtitle` `title`）。端到端加密的消息没法截，超出直接回 413，并写明当前字节数和上限。请求体最多 64 KB（`/hook` 最多 1 MB），超了回 413。

**响应**：`data.id` 是这条消息的 `id`（没给就由服务端生成，之后替换、撤回、停提醒都靠它）；`data.warnings` 是中文提示，比如截短了什么、`id` 太长当不了折叠标识；`data.ignored` 列出这一版不生效的参数。撤回的响应带 `"retracted": true`；要求了重复提醒、但同时在响的已经满额时带 `"repeat_skipped"`（`channel_limit` 或 `account_limit`）。推送失败时，设备失效回 410（已自动清理，重新打开 App 即可），服务端或 Apple 的问题回 502，原始原因在 `data.reason` 里。

### 直接接第三方 webhook

`POST https://nfo.im/hook/{key}/{适配器}`，不用写任何转换代码：

| 适配器 | 说明 |
|---|---|
| `github` | 构建失败、PR / Issue 开关、Release、push |
| `grafana` | 告警触发与恢复（同一条告警合并成一件事，显示持续时长） |
| `uptimekuma` | 掉线与恢复 |

### 心跳监控

定时任务（备份、cron 脚本）跑完来报个到，过了约定的时间没来就提醒你。在 App 的监控里新建「心跳」，拿到报到地址：

```bash
curl -fsS https://nfo.im/hb/{id}                     # 跑完报到（GET / POST / HEAD 都行）
curl -fsS https://nfo.im/hb/{id}/fail -d "磁盘满了"  # 出错时报告失败，立刻提醒；说明也可以放在 ?msg= 里
```

第一次报到之前不会提醒；失联只提醒一次，任务回来报到时推「恢复」。

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

边界：通道名、推送时间和级别不加密；第三方 webhook 不会替你加密，发往适配器的内容以明文经过服务端（处理完即释放）。

## 群组

一个通道可以邀请别人一起接收。只有创建者能看到推送地址、改设置、管成员 —— 成员调管理接口一律 403，接口和推送里都拿不到地址。邀请码 8 位、7 天有效，加入前必须确认。群组通知带「我来处理」按钮：第一个认领的人会广播给所有人，各人的原通知被原地替换成「某某 正在处理」。认领管到这件事结束：同一个 `id` 推来 `status=resolved` 或被撤回之后，下次再触发要重新有人接手；同一次触发的重发（没写 `status` 或仍是 `firing`）不会把认领清掉。

## 举报、屏蔽与停用

群组成员可以在 App 里举报整个群，或其中一条消息；也可以屏蔽群主 —— 立即退群，此后这个人再发邀请也进不来。
[使用条款](https://nfo.im/terms) 对违规内容零容忍，这也是 App Store 对用户生成内容的要求。

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

可以部署自己的实例（`wrangler deploy`），但要知道：**iOS 推送必须用 App 开发者的密钥签名**，官方信鸽 App 只能收到持有它的服务器发出的推送。自建实例需要配合你自己的 Apple 开发者账号、APNs 密钥和自己编译的 App。

## 开发

```bash
npm install
npm test          # 单元测试 + 起一个本地 Worker 跑端到端的 API 测试
npm run dev       # 本地 wrangler dev
```

本地调试需要 `.dev.vars` 里的 `APNS_KEY_P8`（不入库）。

## 许可

AGPL-3.0-only。你可以自由使用、修改、自建；拿去对外提供服务时，改动也必须以同样的许可公开。
