import { escapeHtml } from "./invite";

/**
 * 网页发送页：https://nfo.im/send#{推送 key}
 *
 * 给不写代码的人用。通道的创建者把这个链接发出去，拿到的人在浏览器里填好内容就能发一条通知，
 * 不必知道什么是 curl、什么是 webhook。
 *
 * key 放在 # 之后：浏览器从不把这一段发给服务器，页面本身是一份不含任何 key 的静态文件，
 * 可以放心缓存；访问日志、Referer 里也不会出现它。页面上的脚本读出 key，照常 POST 到 /{key}，
 * 和其他推送走同一条路（同样的策略、同样的报错），没有为网页开任何后门。
 *
 * 不加载任何外部脚本：这一页手里握着推送凭据，多引一个第三方文件就多一个能把它带走的地方。
 */
export function sendPage(host: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>网页发送 — 信鸽Push</title>
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
  button{
    display:block;width:100%;font:inherit;font-weight:700;border:0;cursor:pointer;
    background:var(--signal);color:var(--on-signal);padding:.95rem 1rem;border-radius:12px;
  }
  button:disabled{opacity:.55;cursor:default}
  button:focus-visible{outline:3px solid var(--ink);outline-offset:3px}
  .status{min-height:1.7em;margin:.9rem 0 0;font-size:.9rem;overflow-wrap:anywhere}
  .status.ok{color:var(--ok)}
  .status.bad{color:var(--bad)}
  .empty{padding:1.1rem 1.2rem;background:var(--surface);border:1px solid var(--line);border-radius:12px}
  .empty p{margin:0 0 .6rem;color:var(--ink-2);font-size:.92rem}
  .empty p:last-child{margin-bottom:0}
  .notes{margin:2rem 0 0;padding-left:1.1rem;font-size:.82rem;color:var(--ink-3)}
  .notes li{margin-bottom:.35rem}
  footer{margin-top:2.6rem;font-size:.78rem;color:var(--ink-3)}
  footer a{color:inherit}
  [hidden]{display:none !important}
</style>
</head>
<body>
<main class="wrap">
<p class="eyebrow">网页发送</p>
<h1>发一条通知</h1>

<div id="empty" class="empty">
  <p id="empty-why">这个页面要配合一个发送链接使用，而你打开的地址里没有它。</p>
  <p>发送链接由通道的创建者提供：在信鸽 App 里打开「通道设置 → 网页发送」，复制链接发给要发通知的人。</p>
</div>

<form id="form" hidden novalidate>
  <p class="lede">填好内容点「发送」，这个通道的接收者会立刻收到。</p>
  <label for="title">标题 <span class="opt">（可选）</span></label>
  <input id="title" type="text" maxlength="100" autocomplete="off" enterkeyhint="next">
  <label for="body">内容</label>
  <textarea id="body" maxlength="1000" required></textarea>
  <fieldset>
    <legend>级别</legend>
    <div class="seg">
      <input type="radio" name="level" id="lv-active" value="active" checked>
      <label for="lv-active">普通<small>正常提醒</small></label>
      <input type="radio" name="level" id="lv-urgent" value="timeSensitive">
      <label for="lv-urgent">重要<small>时效性通知</small></label>
    </div>
  </fieldset>
  <button id="send" type="submit">发送</button>
  <p id="status" class="status" role="status" aria-live="polite"></p>
</form>

<ul class="notes">
  <li>拿到这个链接的人都能给这个通道发通知；链接泄露了，在 App 里「更换推送地址」即可作废。</li>
  <li>从网页发出的内容不做端到端加密：它以明文经过服务器转交给 Apple，处理完即释放，不会保存。</li>
</ul>

<footer>信鸽Push · ${escapeHtml(host)} · <a href="/privacy">隐私政策</a> · <a href="/terms">使用条款</a></footer>
</main>
<script>
(function () {
  // 只改了 # 后面的部分，浏览器不会重新加载页面 —— 先打开了没带 key 的 /send、再把完整链接粘进同一个
  // 标签页的人，会一直停在「没有链接」。换了就整页重来，按新的 key 走
  window.addEventListener("hashchange", function () { location.reload(); });

  // 推送 key 在 # 之后，服务器从来看不到这一段。格式与服务端的 id 规则一致，不合格的一概不用 ——
  // 它要拼进请求路径，不能让 ../ 之类的东西混进去
  var raw = location.hash.replace(/^#/, "").trim();
  var key = /^[A-Za-z0-9_-]{6,64}$/.test(raw) ? raw : "";
  var form = document.getElementById("form");
  if (!key) {
    if (raw) document.getElementById("empty-why").textContent = "这个发送链接不完整，可能是复制时少了一截。请让通道的创建者重新发一次。";
    return;
  }
  document.getElementById("empty").hidden = true;
  form.hidden = false;

  var title = document.getElementById("title");
  var body = document.getElementById("body");
  var button = document.getElementById("send");
  var status = document.getElementById("status");

  function show(text, kind) {
    status.textContent = text;
    status.className = "status" + (kind ? " " + kind : "");
  }

  function level() {
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
    fetch("/" + key, {
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
          var where = data.channel ? "已发到「" + data.channel + "」" : "已发送";
          show(where + "，送达 " + (data.delivered || 0) + " 台设备。", "ok");
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

  // 在内容框里按 ⌘/Ctrl + 回车直接发送。点按钮而不是 requestSubmit：老一些的 Safari 没有后者
  body.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) button.click();
  });
})();
</script>
</body>
</html>`;
}
