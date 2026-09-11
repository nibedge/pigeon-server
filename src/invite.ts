import type { Channel, Invite } from "./types";

const ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

/** 通道名是用户起的，原样拼进 HTML 就是存储型 XSS */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** ABCD2345 → ABCD 2345。落地页上要能照着手敲，分组比一长串好认 */
function grouped(code: string): string {
  return `${code.slice(0, 4)} ${code.slice(4)}`;
}

export interface InvitePage {
  status: number;
  html: string;
}

/**
 * 群组邀请的落地页：https://nfo.im/i/{邀请码}
 *
 * 邀请多半是贴进飞书、微信里发出去的，而聊天软件不会把 pigeon:// 渲染成
 * 可点的链接 —— 所以对外分享一律用 https 地址，由这一页把人送进 App。
 *
 * 页面只露出通道名和人数。推送 key 绝不出现在这里：拿到邀请的人可以加入
 * 接收，但不能往群里推消息。
 */
export function invitePage(
  host: string,
  code: string,
  invite: Invite | null,
  channel: Channel | null,
  now = Date.now(),
): InvitePage {
  if (!invite || !channel) {
    return {
      status: 404,
      html: shell(host, "邀请已失效", `
<p class="eyebrow">群组邀请</p>
<h1>邀请已失效</h1>
<p class="lede">这个邀请码不存在或已经过期（邀请码有效期 7 天）。请让群主在信鸽里重新生成一个。</p>`),
    };
  }

  const name = escapeHtml(channel.name);
  const people = channel.memberIds.length + 1;
  const daysLeft = Math.max(1, Math.ceil((invite.expiresAt - now) / 86_400_000));
  // code 已经过 getInvite 的字母表校验，只含大写字母和数字，可以直接拼
  return {
    status: 200,
    html: shell(host, `加入「${name}」`, `
<p class="eyebrow">群组邀请</p>
<h1>${name}</h1>
<p class="meta">${people} 人在接收这个通道的通知 · 还有 ${daysLeft} 天有效</p>
<a class="open" id="open" href="pigeon://invite?c=${code}">用信鸽打开</a>
<div class="manual">
  <p>也可以在信鸽里点「消息」右上角的 ＋ →「加入群组」，输入邀请码：</p>
  <code class="code">${grouped(code)}</code>
</div>
<ul class="notes">
  <li>加入后你只接收通知，看不到推送地址，也不能往群里发消息。</li>
  <li>群主可以移除成员，你也可以随时退出。</li>
</ul>
<script>
// 群组的端到端密钥在链接 # 之后。浏览器从不把这一段发给服务器 —— 这里原样转交给 App
(function () {
  var m = /(?:^#|&)k=([A-Za-z0-9_-]{43})(?:&|$)/.exec(location.hash);
  if (m) document.getElementById("open").href += "&k=" + m[1];
})();
</script>`),
  };
}

function shell(host: string, title: string, main: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${title} — 信鸽</title>
<style>
  :root{
    --paper:#F4F6F8; --surface:#fff; --line:#D6DCE4;
    --ink:#131820; --ink-2:#3D4652; --ink-3:#6B7684; --signal:#C4632A; --on-signal:#fff;
  }
  @media (prefers-color-scheme:dark){
    :root{
      --paper:#0E1218; --surface:#161C24; --line:#2C3540;
      --ink:#E7EBF0; --ink-2:#B3BCC8; --ink-3:#7E8A96; --signal:#E08A4E; --on-signal:#10141A;
    }
  }
  *{box-sizing:border-box}
  body{
    margin:0; background:var(--paper); color:var(--ink);
    font:16px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB",
         "Microsoft YaHei",Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  .wrap{max-width:460px;margin:0 auto;padding:clamp(3rem,12vw,6rem) 1.4rem 3rem}
  .eyebrow{margin:0 0 .6rem;font-size:.75rem;letter-spacing:.14em;color:var(--signal);font-weight:700}
  h1{margin:0 0 .5rem;font-size:clamp(1.8rem,7vw,2.4rem);line-height:1.2;font-weight:800;
     letter-spacing:-.02em;text-wrap:balance;overflow-wrap:anywhere}
  .meta,.lede{margin:0 0 2rem;color:var(--ink-2)}
  .meta{font-size:.9rem;color:var(--ink-3);font-variant-numeric:tabular-nums}
  .open{display:block;text-align:center;background:var(--signal);color:var(--on-signal);
        text-decoration:none;font-weight:700;padding:.95rem 1rem;border-radius:12px}
  .open:focus-visible{outline:3px solid var(--ink);outline-offset:3px}
  .manual{margin:2rem 0 0;padding:1.1rem 1.2rem;background:var(--surface);
          border:1px solid var(--line);border-radius:12px}
  .manual p{margin:0 0 .6rem;font-size:.85rem;color:var(--ink-2)}
  .code{display:block;font:700 1.6rem/1.2 ui-monospace,Menlo,monospace;letter-spacing:.12em;
        color:var(--ink);user-select:all}
  .notes{margin:1.8rem 0 0;padding-left:1.1rem;font-size:.82rem;color:var(--ink-3)}
  .notes li{margin-bottom:.3rem}
  footer{margin-top:3rem;font-size:.78rem;color:var(--ink-3)}
</style>
</head>
<body>
<main class="wrap">
${main}
<footer>信鸽 · ${escapeHtml(host)} · <a href="/terms">使用条款</a></footer>
</main>
</body>
</html>`;
}
