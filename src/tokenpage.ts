import { escapeHtml } from "./invite";
import type { TokenLevel } from "./tokens";

/**
 * 发送令牌的网页：https://nfo.im/s/{令牌}
 *
 * 和 /send#{key} 是一回事，只是给的是一个发送令牌：通道创建者新建一个「家人网页」令牌、把链接发出去，
 * 拿到的人在浏览器里填标题、内容、级别就能发。和 /send 的两处不同：
 * - 令牌在路径里，服务器看得到，于是页面上能先写明「发给：{通道名}」—— 发之前知道自己发给了谁
 * - 令牌可以被单独停用、限级别，停用之后这一页直接说「已停用」，不必等点了发送才知道
 *
 * 页面只能发通知：看不到这个通道收到的其他消息，也改不了它的任何设置。不加载任何外部脚本（理由同 send.ts）
 */

export type TokenPageState =
  | { kind: "ready"; channelName: string; tokenName: string; maxLevel?: TokenLevel }
  | { kind: "disabled" | "retired" | "missing" | "suspended" | "limited" };

const STATUS: Record<TokenPageState["kind"], number> = {
  ready: 200,
  disabled: 403,
  suspended: 403,
  retired: 410,
  missing: 404,
  limited: 429,
};

export function tokenPageStatus(state: TokenPageState): number {
  return STATUS[state.kind];
}

/** 不能发的几种情况：一句标题、一段说明 */
const CLOSED: Record<Exclude<TokenPageState["kind"], "ready">, [string, string]> = {
  disabled: ["这个发送链接已停用", "通道的创建者停用了它。要恢复，请找他在信鸽 App 里重新启用。"],
  retired: ["这个发送链接已失效", "通道的创建者删除了它。要继续发通知，请向他要一个新的链接。"],
  missing: ["找不到这个发送链接", "链接可能不完整（复制时少了一截），或者这个通道已经删除了。请向通道的创建者要一次。"],
  suspended: ["这个通道已被停用", "它因违反《使用条款》被停用，暂时发不了通知。"],
  limited: ["请稍后再试", "你所在的网络查询发送链接太频繁了，请过一分钟再刷新这一页。"],
};

function levelField(maxLevel?: TokenLevel): string {
  if (maxLevel === "passive") {
    return `<p class="hint" data-level="passive">这个链接发的是静默通知：不响铃、不亮屏，直接进通知中心和历史。</p>`;
  }
  if (maxLevel === "active") {
    return `<p class="hint" data-level="active">这个链接发的是普通通知。</p>`;
  }
  return `<fieldset>
    <legend>级别</legend>
    <div class="seg">
      <input type="radio" name="level" id="lv-active" value="active" checked>
      <label for="lv-active">普通<small>正常提醒</small></label>
      <input type="radio" name="level" id="lv-urgent" value="timeSensitive">
      <label for="lv-urgent">重要<small>时效性通知</small></label>
    </div>
  </fieldset>`;
}

export function tokenSendPage(host: string, state: TokenPageState): string {
  const main =
    state.kind === "ready"
      ? `<p class="to">发给：<strong>${escapeHtml(state.channelName)}</strong></p>
<p class="lede">收到的人会看到「来自：${escapeHtml(state.tokenName)}」。填好内容点「发送」，他们会立刻收到。</p>
<form id="form" novalidate>
  <label for="title">标题 <span class="opt">（可选）</span></label>
  <input id="title" type="text" maxlength="100" autocomplete="off" enterkeyhint="next">
  <label for="body">内容</label>
  <textarea id="body" maxlength="1000" required></textarea>
  ${levelField(state.maxLevel)}
  <button id="send" type="submit">发送</button>
  <p id="status" class="status" role="status" aria-live="polite"></p>
</form>
<ul class="notes">
  <li>这个链接只能发通知：看不到这个通道收到的其他消息，也改不了它的设置。链接泄露了，请通道的创建者在 App 里停用它。</li>
  <li>从网页发出的内容不做端到端加密：它以明文经过服务器转交给 Apple，处理完即释放，不会保存。</li>
</ul>`
      : `<div class="closed">
  <h2>${CLOSED[state.kind][0]}</h2>
  <p>${CLOSED[state.kind][1]}</p>
</div>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>发一条通知 — 信鸽Push</title>
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>
  :root{
    --paper:#F4F6F8; --surface:#fff; --line:#D6DCE4;
    --ink:#131820; --ink-2:#3D4652; --ink-3:#6B7684; --signal:#C4632A; --on-signal:#fff;
    --ok:#2E7D4F; --bad:#B3261E;
  }
  @media (prefers-color-scheme:dark){
    :root{
      --paper:#0E1218; --surface:#161C24; --line:#2C3540;
      --ink:#E7EBF0; --ink-2:#B3BCC8; --ink-3:#7E8A96; --signal:#E08A4E; --on-signal:#10141A;
      --ok:#6CC894; --bad:#F2867D;
    }
  }
  *{box-sizing:border-box}
  body{
    margin:0; background:var(--paper); color:var(--ink);
    font:16px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB",
         "Microsoft YaHei",Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  .wrap{max-width:460px;margin:0 auto;padding:clamp(2.5rem,10vw,5rem) 1.25rem 3rem}
  .eyebrow{margin:0 0 .6rem;font-size:.75rem;letter-spacing:.14em;color:var(--signal);font-weight:700}
  h1{margin:0 0 .5rem;font-size:clamp(1.8rem,7vw,2.4rem);line-height:1.2;font-weight:800;
     letter-spacing:-.02em;text-wrap:balance}
  .to{margin:0 0 .3rem;font-size:1.05rem;overflow-wrap:anywhere}
  .lede{margin:0 0 1.8rem;color:var(--ink-2)}
  label{display:block;font-size:.85rem;font-weight:600;margin:0 0 .4rem;color:var(--ink-2)}
  label .opt{font-weight:400;color:var(--ink-3)}
  input[type=text],textarea{
    display:block;width:100%;font:inherit;color:var(--ink);background:var(--surface);
    border:1px solid var(--line);border-radius:12px;padding:.75rem .9rem;margin:0 0 1.2rem;
    -webkit-appearance:none;appearance:none;
  }
  textarea{min-height:8.5rem;resize:vertical}
  input[type=text]:focus,textarea:focus{outline:2px solid var(--signal);outline-offset:1px;border-color:transparent}
  fieldset{border:0;margin:0 0 1.6rem;padding:0}
  legend{font-size:.85rem;font-weight:600;margin:0 0 .4rem;padding:0;color:var(--ink-2)}
  .seg{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:4px;background:var(--surface);
       border:1px solid var(--line);border-radius:12px}
  .seg input{position:absolute;opacity:0;pointer-events:none}
  .seg label{margin:0;text-align:center;padding:.55rem .5rem;border-radius:9px;cursor:pointer;
             font-weight:600;color:var(--ink-2)}
  .seg label small{display:block;font-weight:400;font-size:.75rem;color:var(--ink-3);line-height:1.4}
  .seg input:checked + label{background:var(--signal);color:var(--on-signal)}
  .seg input:checked + label small{color:var(--on-signal);opacity:.85}
  .seg input:focus-visible + label{outline:2px solid var(--ink);outline-offset:2px}
  .hint{margin:0 0 1.6rem;font-size:.88rem;color:var(--ink-2)}
  button{
    display:block;width:100%;font:inherit;font-weight:700;border:0;cursor:pointer;
    background:var(--signal);color:var(--on-signal);padding:.95rem 1rem;border-radius:12px;
  }
  button:disabled{opacity:.55;cursor:default}
  button:focus-visible{outline:3px solid var(--ink);outline-offset:3px}
  .status{min-height:1.7em;margin:.9rem 0 0;font-size:.9rem;overflow-wrap:anywhere}
  .status.ok{color:var(--ok)}
  .status.bad{color:var(--bad)}
  .closed{padding:1.1rem 1.2rem;background:var(--surface);border:1px solid var(--line);border-radius:12px}
  .closed h2{margin:0 0 .4rem;font-size:1.05rem}
  .closed p{margin:0;color:var(--ink-2);font-size:.92rem}
  .notes{margin:2rem 0 0;padding-left:1.1rem;font-size:.82rem;color:var(--ink-3)}
  .notes li{margin-bottom:.35rem}
  footer{margin-top:2.6rem;font-size:.78rem;color:var(--ink-3)}
  footer a{color:inherit}
</style>
</head>
<body>
<main class="wrap">
<p class="eyebrow">网页发送</p>
<h1>发一条通知</h1>
${main}
<footer>信鸽Push · ${escapeHtml(host)} · <a href="/support">帮助</a> · <a href="/privacy">隐私政策</a> · <a href="/terms">使用条款</a></footer>
</main>
${state.kind === "ready" ? `<script>${TOKEN_SEND_SCRIPT}</script>` : ""}
</body>
</html>`;
}

/**
 * 页面上唯一的脚本。单独成一个常量：CSP 按它的哈希放行（见 respond.ts 的 scriptHash）。
 * 令牌从地址里读，不拼进脚本 —— 脚本得是一成不变的常量，哈希才对得上
 */
export const TOKEN_SEND_SCRIPT = `
(function () {
  // 和服务端的令牌格式一致，不合格的一概不用：它要拼进请求路径
  var match = /^\\/s\\/(st_[A-Za-z0-9_-]{43})\\/?$/.exec(location.pathname);
  var form = document.getElementById("form");
  if (!match || !form) return;
  var token = match[1];

  var title = document.getElementById("title");
  var body = document.getElementById("body");
  var button = document.getElementById("send");
  var status = document.getElementById("status");
  var fixed = form.querySelector("[data-level]");

  function show(text, kind) {
    status.textContent = text;
    status.className = "status" + (kind ? " " + kind : "");
  }

  function level() {
    if (fixed) return fixed.getAttribute("data-level");
    var picked = form.querySelector("input[name=level]:checked");
    return picked ? picked.value : "active";
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (button.disabled) return;
    var text = body.value.trim();
    if (!text) {
      show("内容不能为空", "bad");
      body.focus();
      return;
    }
    button.disabled = true;
    show("正在发送…");
    fetch("/" + token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: title.value.trim(), body: text, level: level() }),
    })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (json) {
          return { ok: res.ok, json: json };
        });
      })
      .then(function (r) {
        var data = (r.json && r.json.data) || {};
        if (!r.ok) {
          // 服务端的报错本来就是写给人看的中文，原样给出；内容留着，改一改还能再发
          show((r.json && r.json.message) || "发送失败，请稍后再试", "bad");
          return;
        }
        if (data.suppressed) {
          show("和刚发过的一条一模一样，按这个通道的设置合并掉了，没有重复提醒。", "ok");
        } else {
          show("已发送，送达 " + (data.delivered || 0) + " 台设备。", "ok");
        }
        body.value = "";
      })
      .catch(function () {
        show("网络不通，没发出去。内容还在，稍后再试。", "bad");
      })
      .then(function () {
        button.disabled = false;
      });
  });

  // 在内容框里按 ⌘/Ctrl + 回车直接发送
  body.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) button.click();
  });
})();
`;
