import { DOC_STYLE } from "./docstyle";
import { escapeHtml } from "./invite";
import { pageMeta } from "./seo";

/** 源码仓库。隐私政策、帮助页都指向它：开源是「你可以核对」的前提 */
export const SOURCE_URL = "https://github.com/nibedge/pigeon-server";
/** 公开的问题反馈。谁都看得到，所以各页都提醒别在这里贴凭据 */
export const ISSUES_URL = `${SOURCE_URL}/issues`;

/** 谁在运营、怎么私下联系 */
export interface Contact {
  /** 个人信息处理者的名称或姓名（个人信息保护法第十七条要求写明） */
  operator: string;
  /** 私下联系的邮箱：停用申诉、要自己的数据副本这类事，不该只能公开发帖 */
  email: string;
}

/**
 * TODO(运营者)：运营者名称和私下联系的邮箱都还没定。定下来之后只改这里 ——
 * 帮助页、隐私政策、使用条款的「联系」一节随之出现私下联系的方式，隐私政策也会写明处理者是谁。
 * 在那之前三页如实只给两条路：App 里的举报（私密）和 GitHub issue（公开），不编一个出来。
 */
export const CONTACT: Contact = { operator: "", email: "" };

/**
 * 各页「联系」一节共用的几条。有私下联系的邮箱就排在最前面；
 * GitHub issue 是公开的，要提醒别把推送地址这类凭据贴上去
 */
export function contactList(contact: Contact = CONTACT): string {
  const items: string[] = [];
  if (contact.email) {
    const email = escapeHtml(contact.email);
    items.push(
      `<li><strong>私下联系：</strong><a href="mailto:${email}">${email}</a>。群被停用想申诉、要自己数据的副本、问和你个人有关的事，都走这里。</li>`,
    );
  }
  items.push(
    `<li><strong>举报违规内容：</strong>在 App 里举报（见<a href="/support#report">怎么举报</a>），只有我们看得到。</li>`,
    `<li><strong>公开提问：</strong>在<a href="${ISSUES_URL}">代码仓库</a>提 issue。issue 所有人都看得到，别贴推送地址、加密密钥、配对码或邀请链接。</li>`,
  );
  return `<ul>\n  ${items.join("\n  ")}\n</ul>`;
}

/**
 * 帮助与支持：https://nfo.im/support
 *
 * App Store 要求 Support URL 上有「方便联系到你」的方式，App 里「设置 → 隐私与安全 → 联系我们」也指向这里。
 * 大多数事 App 里就能办（举报、屏蔽、删号），这一页先把路指清楚，再给联系方式。
 *
 * 写进这里的每条路径都要在 App 里真的找得到 —— 审核员会照着点。没有脚本，CSP 按 script-src 'none' 出
 */
export function supportPage(host: string, contact: Contact = CONTACT): string {
  const updated = "2026-09-27";
  const site = escapeHtml(host);

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>帮助与支持 — 信鸽Push</title>
${pageMeta(host, "/support", "帮助与支持 — 信鸽Push", "收不到通知、推送地址泄露、换手机、举报、删除账号：常见问题和联系方式。")}
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>${DOC_STYLE}</style>
</head>
<body>
<div class="wrap">

<h1>帮助与支持</h1>
<p class="meta">信鸽Push · 最后更新 ${updated}</p>

<div class="callout">
  <p><strong>大多数事在 App 里就能办：</strong>举报在消息详情和群的设置里，屏蔽和联系方式在「设置 → 隐私与安全」里，删除账号在「设置」最下面。下面是常见问题；没找到答案，看最后的<a href="#contact">联系我们</a>。</p>
</div>

<h2>常见问题</h2>

<h3>收不到通知</h3>
<ul>
  <li>先在 App 里打开这个通道的设置，给它推一条测试消息，看这台手机能不能收到。</li>
  <li>系统「设置 → 通知 → 信鸽」里要允许通知；专注模式也可能把它挡住。</li>
  <li>你给这个通道开了免打扰，或者正处在群主设的免打扰时段：消息照样送到，只是不响、不亮屏，在通知中心和历史里看得到。</li>
  <li>发送方可以看推送的响应：<code>delivered</code> 是送到了几台设备，<code>muted</code> 是其中静默送达的。</li>
</ul>

<h3>用 curl 推送，报错或内容不对</h3>
<p>内容里有空格或 <code>&amp;</code> <code>#</code> <code>+</code> <code>%</code> 这些字符时，别拼进地址，用 <code>--data-urlencode</code>（或者发 JSON）：</p>
<p><code>curl https://${site}/{key} --data-urlencode "title=备份完成" --data-urlencode "body=今晚的备份成功"</code></p>

<h3>推送地址泄露了</h3>
<p>打开通道设置，点「更换推送地址」：旧地址立即失效。已经配到别处的服务，要改成新地址。</p>

<h3>换了手机，或者要多台设备一起收</h3>
<p>同一个 Apple ID 的新设备：开着 iCloud 钥匙串，装好信鸽点「继续使用」，账号和加密主密钥会自动带过去。别的 Apple ID 的设备：在「设置 → 我的设备」里点「在另一台设备上使用」，用新设备扫码。</p>

<h3>加密消息打不开，显示「🔒」</h3>
<p>这台设备还没有这个通道的密钥。自己的通道：确认这台设备和建通道的那台用的是同一个 iCloud 钥匙串，或者扫码配对。加密的群：要用群主发来的完整邀请链接加入 —— 群密钥只在链接里，只输邀请码拿不到。</p>

<h3>群里的成员能发消息吗</h3>
<p>不能。成员只接收，看不到推送地址；群里的消息都由群主（建群的人）发出，内容由群主负责。</p>

<h3>重复提醒怎么停</h3>
<p>点通知上的「知道了」或「我来处理」；或者用同一个 id 再推一条 <code>status=resolved</code>，例如<code>curl https://${site}/{key} -d id=db-01 -d status=resolved --data-urlencode "body=已恢复"</code>。最长提醒一小时。</p>

<h3>推送有频率上限吗</h3>
<p>有，防止失控的脚本刷屏：每个通道每分钟最多约 60 条，超出的回 <code>429</code>，过一分钟再推即可。</p>

<h3>能自己部署服务端吗</h3>
<p>服务端<a href="${SOURCE_URL}">开源</a>，可以部署来研究、审计。但 iOS 推送必须用 App 开发者的密钥签名，官方信鸽 App 只接收 ${site} 发出的推送，别人部署的服务端推不到它。想让服务端看不到内容，用端到端加密。</p>

<h2 id="report">举报违规内容</h2>
<ul>
  <li>举报一条消息：打开消息详情，点「举报这条消息」。</li>
  <li>举报整个群组：打开群的设置，点「举报这个群组」。</li>
  <li>可以选择附上那条消息的内容。端到端加密的消息服务端看不到，附上的内容就是我们判断的依据。</li>
  <li>举报只有我们看得到，群主和其他成员不会知道是谁举报的。我们会在 <strong>24 小时内</strong>处理，确认违规的通道立即停用。</li>
  <li>不想再收到这个人的消息和邀请：在群的设置里点「屏蔽群主」，会立即退群。想解除，在「设置 → 隐私与安全 → 已屏蔽」里。</li>
</ul>

<h2 id="delete">删除账号和数据</h2>
<ul>
  <li><strong>删除整个账号：</strong>「设置 → 删除账号」。服务端上的账号、设备推送令牌、你建的通道（连同成员关系和邀请）、你在别人群组里的名字立即删除，这台设备上的历史也一起清空。不可恢复。</li>
  <li><strong>只移除一台设备：</strong>「设置 → 我的设备」里左滑那台设备。</li>
  <li><strong>要删 App 的话</strong>，先在设置里删除账号或移除这台设备。直接删 App，服务端上的推送令牌要等下一次推送失败才会清掉。</li>
  <li><strong>手机丢了、进不去账号：</strong>用同一个 Apple ID 的其他设备打开信鸽，在「设置 → 我的设备」里移除那台，或者直接删除账号。都做不到的，<a href="#contact">联系我们</a>。</li>
  <li>举报记录不随账号删除，90 天后自动删除。其他会自动过期的记录，见<a href="/privacy">隐私政策</a>。</li>
</ul>

<h2 id="contact">联系我们</h2>
${contactList(contact)}

<footer>信鸽Push · ${site} · <a href="/docs">文档</a> · <a href="/privacy">隐私政策</a> · <a href="/terms">使用条款</a></footer>

</div>
</body>
</html>`;
}
