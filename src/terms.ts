import { DOC_STYLE } from "./docstyle";
import { escapeHtml } from "./invite";
import { CONTACT, contactList, type Contact } from "./support";

/**
 * 使用条款。App Store 对「用户生成内容」的要求之一：用户必须先同意一份写明
 * **零容忍**的条款，才能接触这类内容 —— App 在加入群组前、以及建群、设为群组、第一次生成邀请前的
 * 确认页上链到这里（后三者同意后服务端在账号上记 termsAcceptedAt）。
 *
 * 写进这里的每一条处理手段都要真的做得到：停用走 npm run mod -- suspend，
 * 「情节严重」走 npm run mod -- suspend-owner，违禁词过滤见 contentfilter.ts。写了做不到的，比不写更糟。
 */
export function termsPage(host: string, contact: Contact = CONTACT): string {
  const updated = "2026-09-27";

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>使用条款 — 信鸽Push</title>
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>${DOC_STYLE}</style>
</head>
<body>
<div class="wrap">

<h1>使用条款</h1>
<p class="meta">信鸽 Pigeon · 最后更新 ${updated}</p>

<div class="callout">
  <p><strong>一句话：</strong>信鸽只负责把你自己的系统发出的消息送到手机上。用它推送违法、色情低俗、骚扰或欺诈内容，<strong>零容忍</strong> —— 确认违规的通道立即停用。</p>
</div>

<h2>适用范围</h2>
<p>使用信鸽 App 或 ${escapeHtml(host)} 上的推送服务，即表示你同意本条款。新建群组、把通道设为群组、第一次生成邀请之前，以及加入任何群组之前，App 都会再请你确认一次。</p>
<p>不满 14 周岁的，请在父母或其他监护人的同意下使用。</p>

<h2>内容由谁负责</h2>
<p>推送的内容由通道的创建者（群主）通过自己的系统发出。信鸽不创作、不编辑，也不预先审查这些内容。群主对自己通道推送的一切负责；成员只接收，不能往群里推送。</p>
<p>群组的明文推送在送出之前会过一遍违禁词表，命中的直接拒收。这只是最低限度的过滤，不代表我们审查过、或者认可了其余的内容。</p>

<h2>禁止的内容</h2>
<ul>
  <li>违反法律法规的内容</li>
  <li>色情、低俗或带有性暗示的内容</li>
  <li>暴力、恐怖、仇恨或歧视性的内容</li>
  <li>骚扰、辱骂、威胁他人</li>
  <li>诈骗、垃圾广告、传销</li>
  <li>未经同意公开他人的隐私信息</li>
  <li>恶意链接、恶意软件、钓鱼页面</li>
</ul>
<p>也不得把人拉进群组后骚扰对方，或冒充他人。</p>

<h2>群主能做什么</h2>
<p>群主可以移除成员，移除时可以同时作废邀请链接、禁止此人再用邀请加入；也可以随时作废全部邀请。邀请页上会显示群主的显示名，让受邀的人知道邀请是谁发的。</p>

<h2>举报与处理</h2>
<p>群组成员可以在 App 里举报整个群组（群的设置 → 举报这个群组），也可以举报某一条消息（消息详情 → 举报这条消息）。我们会在 <strong>24 小时内</strong>处理：确认违规的通道立即停用，推送、邀请、认领全部失效；情节严重的，停用该群主名下的全部通道。</p>
<p>端到端加密的消息，服务端看不到内容。处理这类举报时，依据的是举报人自己选择附上的那条消息。</p>
<p>为了不让举报被人刷爆，每个账号每小时最多举报 5 次。</p>

<h2>屏蔽</h2>
<p>成员可以随时屏蔽群主：屏蔽后立即退出该群，并且此人之后发来的邀请一律进不来。屏蔽名单在「设置 → 隐私与安全 → 已屏蔽」里，可以随时解除。</p>

<h2>使用限制</h2>
<p>为了防止滥用，推送、注册、打开邀请、认领和举报都有频率上限，超出时会被暂时拒绝，过一会儿再试即可。一台设备最多登记 3 个账号。</p>

<h2>服务本身</h2>
<p>推送最终经由 Apple 投递，我们会尽力保证送达，但无法承诺永不延迟或丢失。不要把信鸽当作唯一的告警渠道去处理人身安全或重大财产相关的事。</p>

<h2>条款变更</h2>
<p>本页若有实质性修改，会更新顶部的日期，并在 App 内提示。</p>

<h2>联系</h2>
<p>对条款或处理结果有疑问：</p>
${contactList(contact)}
<p>你的数据如何处理，见<a href="/privacy">隐私政策</a>；常见问题见<a href="/support">帮助与支持</a>。</p>

<footer>信鸽Push · ${escapeHtml(host)} · <a href="/support">帮助与支持</a> · <a href="/privacy">隐私政策</a></footer>

</div>
</body>
</html>`;
}
