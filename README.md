# 信鸽 Pigeon · 服务端

[![test-and-deploy](https://github.com/nibedge/pigeon-server/actions/workflows/deploy.yml/badge.svg)](https://github.com/nibedge/pigeon-server/actions/workflows/deploy.yml)

把任何服务的 webhook 变成一条看得懂的 iOS 通知。运行在 Cloudflare Workers 上，存储用 KV。

线上实例：<https://nfo.im> · 隐私政策：<https://nfo.im/privacy>

## 为什么开源

推送服务经手你的通知。与其让你「相信我们」，不如让你能核对：

- **服务端存了什么**：KV 里只有这几类记录 —— `acct:` 账号、`chan:` 通道、`ch:` 推送地址指针、`inv:` 邀请码（7 天过期）、`ack:` 认领记录（24 小时过期）、`dedupe:` 去重哈希（最长 1 小时过期）。**推送内容不落盘。**
- **线上跑的是哪一版**：`GET /info` 返回当前运行的 `commit`。线上只从本仓库的 `main` 分支经 GitHub Actions 自动部署，构建日志公开。
- **看不到内容的办法**：端到端加密（见下）。开源是「你可以检查我们」，加密是「你不需要相信我们」。

## 推送

每个通道一个推送地址 `https://nfo.im/{key}`，在 App 的通道设置里复制。

```bash
curl https://nfo.im/{key}/服务器挂了                       # 只有正文
curl https://nfo.im/{key}/标题/正文
curl -X POST https://nfo.im/{key} -H 'content-type: application/json' \
     -d '{"title":"磁盘满了","body":"剩余 3%","level":"timeSensitive","tags":"warning,prod"}'
```

| 参数 | 说明 |
|---|---|
| `title` `subtitle` `body` | 标题、副标题、正文（正文支持 Markdown） |
| `level` | `passive` 静默 · `active` 普通 · `timeSensitive` 时效性 · `critical`（未获 Apple 授权前按时效性送） |
| `sound` | 铃声；不给就用系统默认，`none` 静音 |
| `badge` | 角标数字 |
| `url` | 点通知打开的链接 |
| `group` | 通知中心里的分组；不给就按通道分组 |
| `id` | 同一件事的标识。同 id 的新消息会原地替换旧的（通知中心和 App 历史都是） |
| `status` | `firing` / `resolved`。同一个 `id` 从进行中变成已恢复，App 会算出持续了多久 |
| `tags` | 逗号分隔。认得的表情短码（`warning` `rotating_light` `white_check_mark`…）显示成表情，其余显示成可筛选的标签 |
| `icon` | 通知图标 URL（https，2 MB 以内） |
| `isArchive` | `0` 不存进 App 历史 |
| `delete` | `1` 静默删除同 `id` 的历史消息 |
| `ciphertext` `iv` | 端到端加密的内容，见下 |

### 直接接第三方 webhook

`POST https://nfo.im/hook/{key}/{适配器}`，不用写任何转换代码：

| 适配器 | 说明 |
|---|---|
| `github` | 构建失败、PR / Issue 开关、Release、push |
| `grafana` | 告警触发与恢复（同一条告警合并成一件事，显示持续时长） |
| `uptimekuma` | 掉线与恢复 |

## 端到端加密

标题、正文、链接、标签在发送端就加密好，服务端和 Apple 只经手密文，由你设备上的 App 解密。

```bash
curl -sO https://nfo.im/tools/pigeon-send.mjs          # 就是本仓库的 tools/pigeon-send.mjs，逐字节一致
node pigeon-send.mjs https://nfo.im/{key} --key {通道加密密钥} --title "磁盘满了" --body "剩余 3%"
```

通道加密密钥在 App 的「通道设置 → 端到端加密」里。通道可以设成「只接受加密消息」，服务端会拒收一切明文推送。

格式（写别的语言的发送端时照这个来）：

- 算法：AES-256-GCM，12 字节随机 nonce，16 字节认证标签
- `ciphertext` = base64(密文 ‖ 标签)，`iv` = base64(nonce)
- 明文是 UTF-8 的 JSON 对象：`title` `subtitle` `body` `url` `tags`，都可选
- `level` `id` `status` `group` `sound` 不加密 —— 服务端投递时要用
- 通道密钥 = HKDF-SHA256(账号主密钥, salt `pigeon-e2e-v1`, info `channel:{通道 id}`)，32 字节。主密钥在设备上生成、从不上传；群成员从邀请链接 `#` 后面那段拿到群密钥，浏览器从不把这一段发给服务器

边界：通道名、推送时间和级别不加密；第三方 webhook 不会替你加密，发往适配器的内容以明文经过服务端（处理完即释放）。

## 群组

一个通道可以邀请别人一起接收。只有创建者能看到推送地址、改设置、管成员 —— 成员调管理接口一律 403，接口和推送里都拿不到地址。邀请码 8 位、7 天有效，加入前必须确认。群组通知带「我来处理」按钮：第一个认领的人会广播给所有人，各人的原通知被原地替换成「某某 正在处理」。

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
