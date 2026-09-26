import { STORE_ID, storeURL } from "./appstore";
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
  /** 页面里的内联脚本原文，给 CSP 算哈希用 */
  scripts?: string[];
}

/**
 * 在应用内置的浏览器里打开的（聊天软件里点开的链接多半是这样）。
 *
 * 这类浏览器常常拦下 pigeon:// 和通用链接，「用信鸽打开」点了没反应，得先换到 Safari。
 * 不逐个认是哪家的软件：iPhone 上真正的浏览器（Safari 以及套着 WebKit 的各家浏览器）都在 UA 里
 * 带着 Safari/ 这一段，应用内的网页视图没有。认错了也只是多显示一行提示，不影响别的
 */
export function inAppBrowser(userAgent: string): boolean {
  return /\b(iPhone|iPad|iPod)\b/.test(userAgent) && /AppleWebKit\//.test(userAgent) && !/Safari\//.test(userAgent);
}

/**
 * 群组邀请的落地页：https://nfo.im/i/{邀请码}
 *
 * 邀请多半是贴进聊天软件里发出去的，而聊天软件不会把 pigeon:// 渲染成
 * 可点的链接 —— 所以对外分享一律用 https 地址，由这一页把人送进 App。
 *
 * 页面只露出通道名、群主的显示名和人数。推送 key 绝不出现在这里：拿到邀请的人可以加入
 * 接收，但不能往群里推消息。
 */
export function invitePage(
  host: string,
  code: string,
  invite: Invite | null,
  channel: Channel | null,
  ownerName?: string,
  { now = Date.now(), userAgent = "" }: { now?: number; userAgent?: string } = {},
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
  // 群主是谁：只凭群名，很难判断这个邀请是不是认识的人发来的。显示名是用户自己起的，照样要转义
  const owner = ownerName ? `由 ${escapeHtml(ownerName)} 创建 · ` : "";
  // code 已经过 getInvite 的字母表校验，只含大写字母和数字，可以直接拼
  const hint = inAppBrowser(userAgent)
    ? `<p class="hint" role="note">在这里点「用信鸽打开」可能没反应：点右上角 ···，选「在 Safari 中打开」，再点一次。</p>\n`
    : "";
  return {
    status: 200,
    html: shell(host, `加入「${name}」`, `
${hint}<p class="eyebrow">群组邀请</p>
<h1>${name}</h1>
<p class="meta">${owner}${people} 人在接收这个通道的通知 · 还有 ${daysLeft} 天有效</p>
<a class="open" id="open" href="pigeon://invite?c=${code}">用信鸽打开</a>
<div class="manual">
  <p>打不开的话，复制完整的邀请链接，在信鸽里点「群组」右上角的 ＋ →「加入群组」，粘贴进去：</p>
  <button type="button" class="copy" id="copy" hidden>复制完整邀请链接</button>
  <p class="copied" id="copied" role="status" aria-live="polite"></p>
  <p class="e2e" id="e2e" hidden>这个群的消息是端到端加密的，密钥只在完整链接里：请用复制的链接加入。只输邀请码的话，收到的消息会解不开。</p>
  <p>也可以在同一处手动输入邀请码：</p>
  <code class="code">${grouped(code)}</code>
</div>
<ul class="notes">
  <li>加入后你只接收通知，看不到推送地址，也不能往群里发消息。</li>
  <li>群主可以移除成员，你也可以随时退出。</li>
</ul>
<div class="get">
  <p>还没装信鸽？</p>
  ${downloadButton()}
</div>
<script>${INVITE_SCRIPT}</script>`),
    scripts: [INVITE_SCRIPT],
  };
}

/**
 * 邀请页上唯一的脚本。单独成一个常量：CSP 按它的哈希放行（见 respond.ts 的 scriptHash）。
 * 群组的端到端密钥在链接 # 之后，浏览器从不把这一段发给服务器 —— 这里原样转交给 App
 */
export const INVITE_SCRIPT = `
(function () {
  var m = /(?:^#|&)k=([A-Za-z0-9_-]{43})(?:&|$)/.exec(location.hash);
  if (m) {
    document.getElementById("open").href += "&k=" + m[1];
    document.getElementById("e2e").hidden = false;
  }

  // 复制给 App 用的完整链接：邀请码在路径里，群密钥在 # 之后。聊天软件的浏览器会往地址上加自己的参数，
  // 这里只留路径和密钥，App 认的就是这两样
  var link = location.origin + location.pathname + (m ? "#k=" + m[1] : "");
  var button = document.getElementById("copy");
  var status = document.getElementById("copied");
  button.hidden = false;

  function copied() {
    status.textContent = "已复制。打开信鸽 →「群组」右上角 ＋ →「加入群组」，粘贴即可。";
  }
  // 应用内的浏览器常常不给用剪贴板接口，退回老办法；再不行就把链接摆出来让人长按复制
  function fallback() {
    var box = document.createElement("textarea");
    box.value = link;
    box.setAttribute("readonly", "");
    box.style.position = "fixed";
    box.style.opacity = "0";
    document.body.appendChild(box);
    box.select();
    box.setSelectionRange(0, link.length);
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(box);
    if (ok) copied();
    else status.textContent = "没能自动复制，请长按选中这个链接手动复制：" + link;
  }
  button.addEventListener("click", function () {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(copied, fallback);
    else fallback();
  });
})();
`;

/** 同一个网络打开邀请页太频繁：多半是在挨个试邀请码 */
export function rateLimitedInvitePage(host: string): InvitePage {
  return {
    status: 429,
    html: shell(host, "请稍后再试", `
<p class="eyebrow">群组邀请</p>
<h1>请稍后再试</h1>
<p class="lede">你所在的网络打开邀请页太频繁了。请过一分钟再刷新这一页。</p>`),
  };
}

/** 下载入口：上架了给 App Store 按钮，没上架就如实说「即将上架」 */
function downloadButton(): string {
  const store = storeURL();
  return store
    ? `<a class="get-btn" href="${store}">去 App Store 下载</a>`
    : `<span class="get-soon">即将上架 App Store</span>`;
}

function shell(host: string, title: string, main: string): string {
  // 装了 App 的手机会被通用链接直接送进 App；智能横幅是给没装的人看的顶部提示
  const banner = STORE_ID ? `<meta name="apple-itunes-app" content="app-id=${STORE_ID}">` : "";
  return shellWith(host, title, main, banner);
}

function shellWith(host: string, title: string, main: string, banner: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
${banner}
<title>${title} — 信鸽Push</title>
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
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
  .copy{display:block;width:100%;font:inherit;font-weight:600;color:var(--ink);background:var(--paper);
        border:1px solid var(--line);border-radius:10px;padding:.7rem 1rem;margin:0 0 .4rem;cursor:pointer}
  .copy:focus-visible{outline:3px solid var(--ink);outline-offset:2px}
  .manual .copied{min-height:1.2em;font-size:.8rem;color:var(--ink-3);overflow-wrap:anywhere;user-select:all}
  .manual .e2e{color:var(--signal)}
  .hint{margin:0 0 1.6rem;padding:.75rem .95rem;border-left:3px solid var(--signal);background:var(--surface);
        border-radius:0 8px 8px 0;font-size:.88rem;color:var(--ink-2)}
  [hidden]{display:none !important}
  .notes{margin:1.8rem 0 0;padding-left:1.1rem;font-size:.82rem;color:var(--ink-3)}
  .notes li{margin-bottom:.3rem}
  .get{margin:1.8rem 0 0;text-align:center}
  .get p{margin:0 0 .7rem;font-size:.85rem;color:var(--ink-3)}
  .get-btn{display:inline-block;text-decoration:none;font-weight:600;color:var(--ink);
           border:1px solid var(--line);border-radius:10px;padding:.7rem 1.3rem;background:var(--surface)}
  .get-soon{display:inline-block;color:var(--ink-3);font-size:.85rem;
            border:1px dashed var(--line);border-radius:10px;padding:.6rem 1.2rem}
  footer{margin-top:3rem;font-size:.78rem;color:var(--ink-3)}
</style>
</head>
<body>
<main class="wrap">
${main}
<footer>信鸽Push · ${escapeHtml(host)} · <a href="/terms">使用条款</a></footer>
</main>
</body>
</html>`;
}
