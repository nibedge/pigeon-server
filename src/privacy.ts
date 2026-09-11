import { DOC_STYLE } from "./docstyle";

/**
 * 隐私政策页。App Store 提审要求必须有一个公开可访问的 URL。
 *
 * 内容必须与代码的实际行为逐条对得上。写「我们不存储推送内容」之前先确认
 * KV 里落的只有这些前缀：`acct:` 账号、`chan:` 通道、`ch:` key 指针、
 * `inv:` 邀请码、`ack:` 认领记录、`dedupe:` 去重哈希、`report:` 举报记录、
 * `config:` 服务端设置（只有审核通道的 id）—— 隐私政策与实现不符
 * 既是合规问题，也是最容易在版本迭代中悄悄失真的一类文档。新增前缀必须同步这里。
 */
export function privacyPage(host: string): string {
  const updated = "2026-09-11";

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>隐私政策 — 信鸽 Pigeon</title>
<style>${DOC_STYLE}</style>
</head>
<body>
<div class="wrap">

<h1>隐私政策</h1>
<p class="meta">信鸽 Pigeon · 最后更新 ${updated}</p>

<div class="callout">
  <p><strong>一句话：</strong>信鸽不要你的账号、不要你的邮箱手机号、不收集任何行为数据，
  也不在服务器上保存你收到的通知内容。历史记录只存在你自己的设备上。</p>
</div>

<h2>我们保存什么</h2>
<p>服务端只保存下面这些记录，都是让推送能送达、群组能运作所必需的：</p>
<table>
  <thead><tr><th>数据</th><th>用途</th><th>保存在哪</th></tr></thead>
  <tbody>
    <tr>
      <td><strong>设备推送令牌</strong></td>
      <td>Apple 用它定位你的设备。由系统生成，不含任何个人身份信息，删除 App 后即失效。</td>
      <td>服务端</td>
    </tr>
    <tr>
      <td><strong>设备名称</strong></td>
      <td>让你在设备列表里认出哪台是哪台。iOS 只提供机型名（如「iPhone」），不含你给设备起的名字。</td>
      <td>服务端</td>
    </tr>
    <tr>
      <td><strong>账号标识与通道设置</strong></td>
      <td>随机生成的标识符、通道名称、图标、默认级别、免打扰时段、累计条数；以及你自己的置顶、免打扰、分组偏好（让同一账号的各台设备保持一致）。</td>
      <td>服务端</td>
    </tr>
    <tr>
      <td><strong>显示名（可选）</strong></td>
      <td>你在设置里给自己起的名字。只在群组里使用：成员名单、以及「谁在处理这条告警」。不设就用设备名称。</td>
      <td>服务端</td>
    </tr>
    <tr>
      <td><strong>群组成员名单</strong></td>
      <td>如果你创建或加入了共享通道，服务端会记下成员的账号标识。创建者能看到成员的显示名和设备名称，以便认出是谁；成员看不到通道的推送地址。</td>
      <td>服务端</td>
    </tr>
    <tr>
      <td><strong>邀请码</strong></td>
      <td>创建者生成的群组邀请码，7 天后自动删除。</td>
      <td>服务端</td>
    </tr>
    <tr>
      <td><strong>认领记录</strong></td>
      <td>在群组里点「我来处理」时，记下是谁认领了哪条消息（显示名、账号标识、消息标识），用来防止两个人重复接手。不含通知内容，24 小时后自动删除。</td>
      <td>服务端</td>
    </tr>
    <tr>
      <td><strong>包裹后的群密钥</strong></td>
      <td>如果你加入了使用端到端加密的群组，服务端会替你的各台设备保管一份群密钥 —— 已用只存在于你设备上的主密钥加密，服务端解不开。</td>
      <td>服务端（只有密文）</td>
    </tr>
    <tr>
      <td><strong>屏蔽名单（可选）</strong></td>
      <td>你屏蔽的群主的账号标识，以及屏蔽时对方的显示名。只用来拦下这个人之后发来的邀请，存在你自己的账号上，随时可以解除。</td>
      <td>服务端</td>
    </tr>
    <tr>
      <td><strong>举报记录（可选）</strong></td>
      <td>你在群组里举报时提交的理由、补充说明，以及你选择附上的那条消息的内容，连同被举报的通道和你的账号标识。只用于处理违规，90 天后自动删除。</td>
      <td>服务端</td>
    </tr>
    <tr>
      <td><strong>账号凭据</strong></td>
      <td>只保存不可逆的 SHA-256 摘要，服务端没有明文，我们也无法还原。</td>
      <td>服务端</td>
    </tr>
    <tr>
      <td><strong>通知历史</strong></td>
      <td>方便你回看和搜索。</td>
      <td><strong>只在你的设备上</strong></td>
    </tr>
  </tbody>
</table>

<h2>我们不保存什么</h2>
<ul>
  <li><strong>推送内容</strong>不落盘。它经过服务器转交给 Apple，处理完即释放。唯一的例外是你主动举报时选择附上的那一条（见上表）。</li>
  <li>没有邮箱、手机号、姓名、生日、地址、支付信息 —— 注册过程根本不问。</li>
  <li>没有位置、通讯录、相册、日历、健康数据。</li>
  <li>没有埋点、行为分析、广告标识符、第三方统计 SDK。</li>
  <li>不记录你的 IP 地址用于画像。</li>
</ul>

<div class="callout">
  <p><strong>一个需要如实说明的例外。</strong>如果你为某个通道开启了「重复消息合并」，
  服务端会为最近推送过的内容存一段<strong>截断的哈希值</strong>（SHA-256 的前 12 个十六进制字符），
  用于判断下一条是不是重复。它不可逆、不足以还原原文，并且会在你设定的时间窗口
  （最长 1 小时）后自动过期删除。不开启这个功能就完全不会产生这项记录。</p>
</div>

<h2>数据会经过谁</h2>
<ul>
  <li><strong>Apple 推送通知服务（APNs）</strong> —— 所有 iOS 推送都必须经由 Apple 投递，
      这是系统层面的唯一通路。适用 <a href="https://www.apple.com/legal/privacy/">Apple 的隐私政策</a>。</li>
  <li><strong>Cloudflare</strong> —— 服务端运行在 Cloudflare Workers 上，
      由其提供计算与存储。</li>
</ul>
<p>除此之外，我们不把任何数据交给第三方，不出售、不共享、不用于广告。</p>

<h2>你可以核对</h2>
<p>服务端源码公开在 <a href="https://github.com/nibedge/pigeon-server">github.com/nibedge/pigeon-server</a>，许可 AGPL-3.0。
线上只从该仓库的 <code>main</code> 分支经 GitHub Actions 自动部署，构建日志公开；
<a href="/info">/info</a> 返回当前正在运行的 commit，可以拿它和仓库里的源码逐行对照。
本页写的每一条，都能在源码里找到对应的实现。</p>
<p>开源解决的是「你可以检查我们」，下面这一节解决的是「你不需要相信我们」。</p>

<h2>端到端加密</h2>
<p>每个账号在你的设备上生成一把主密钥，每个通道的加密密钥由它派生，<strong>从不上传到服务端</strong>。
发送方用通道密钥加密（AES-256-GCM）后再推送，服务端和 Apple 都只经手密文，由你设备上的 App 解密。
群组的密钥附在邀请链接 <code>#</code> 之后的部分里 —— 浏览器从不把这一段发给服务器。</p>
<p>需要如实说明的边界：通道名称、推送时间和级别不加密（投递需要它们）；GitHub、Grafana 这类第三方
webhook 不会替你加密，发往它们适配器的内容会以明文经过服务端（处理完即释放，不落盘）。
你可以把通道设成「只接受加密消息」，服务端会拒收一切明文推送。</p>

<h2>删除你的数据</h2>
<ul>
  <li>在 App 的<strong>设置 → 我的设备</strong>里移除某台设备，该设备的推送令牌立即从服务端删除。</li>
  <li>删除某个通道，它的 key 和全部设置立即删除，之前配出去的地址随即失效。</li>
  <li>退出群组，你的账号标识立即从该群组的成员名单中移除，此后不再收到它的推送。</li>
  <li>在<strong>设置 → 删除账号</strong>里删除账号：账号、设备推送令牌、你创建的通道（连同成员关系）、
      你在别人群组里的名字，全部立即从服务端删除。</li>
  <li><strong>删除 App</strong> 会清掉设备上的全部历史。服务端的推送令牌会在下一次投递失败时
      自动清理（Apple 会告知该令牌已失效）。</li>
  <li>想彻底清空，请在删除 App 之前先在设置里移除设备。</li>
  <li>举报记录不随账号删除，到期（90 天）自动删除 —— 它们是处理违规的依据。账号删除后，记录里的账号标识不再对应任何人。</li>
</ul>

<h2>儿童</h2>
<p>信鸽不面向 13 岁以下儿童，也不会有意收集他们的信息。</p>

<h2>政策变更</h2>
<p>本页若有实质性修改，会更新顶部的日期。涉及数据处理方式的变化，会在 App 内提示。</p>

<h2>联系</h2>
<p>对隐私有疑问，可在<a href="https://github.com/nibedge/pigeon-server/issues">代码仓库</a>提 issue。</p>
<p>群组里能推什么、不能推什么，见<a href="/terms">使用条款</a>。</p>

<footer>信鸽 Pigeon · ${host} · <a href="/terms">使用条款</a></footer>

</div>
</body>
</html>`;
}
