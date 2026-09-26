import { listAdapters } from "./adapters";
import { storeURL } from "./appstore";
import { escapeHtml } from "./invite";
import { VERSION } from "./routes/misc";
import { SOURCE_URL } from "./support";

/**
 * nfo.im 的首页。跟推送服务同一个 Worker 提供，不额外花钱、不额外运维。
 * 现在的定位是「说明这是什么 + 让人五分钟内跑通」，等 App 上架再换成正式的
 * 产品页（需要截图、下载按钮）。
 *
 * 审核员会从 App Store 的营销网址点进来：这里写的每一句都得是现在就成立的。
 * 示例命令照抄就要能用 —— test/web.test.mjs 用真的 curl 把每一条跑一遍。
 */
export function landingPage(host: string): string {
  const adapters = listAdapters();
  // 主机名取自请求，路由只放行自己的域名；照样转义，和其他页面一个写法
  const site = escapeHtml(host);
  // 上架了给商店链接；没上架就如实说「即将上架」，不放会 404 的链接
  const store = storeURL();
  const get = store
    ? `<a href="${store}">去 App Store 下载 iOS App</a>`
    : "iOS App 即将上架 App Store。";

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>信鸽Push — webhook 收件箱</title>
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="description" content="把任何服务的 webhook 指过来，收到一条看得懂、管得住的 iOS 通知。">
<style>
  :root {
    --paper:#F4F6F8; --surface:#fff; --line:#D6DCE4; --line-soft:#E4E9EF;
    --ink:#131820; --ink-2:#3D4652; --ink-3:#6B7684;
    --signal:#C4632A; --wire:#2E7A91;
  }
  @media (prefers-color-scheme:dark){
    :root{
      --paper:#0E1218; --surface:#161C24; --line:#2C3540; --line-soft:#232B35;
      --ink:#E7EBF0; --ink-2:#B3BCC8; --ink-3:#7E8A96;
      --signal:#E08A4E; --wire:#5FB3CB;
    }
  }
  *{box-sizing:border-box}
  body{
    margin:0; background:var(--paper); color:var(--ink);
    font:16px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB",
         "Microsoft YaHei",Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  .wrap{max-width:760px;margin:0 auto;padding:0 clamp(1.1rem,5vw,2rem)}
  header{padding:clamp(3rem,10vw,5.5rem) 0 clamp(1.6rem,4vw,2.4rem)}
  .mark{display:flex;align-items:center;gap:.6rem;margin-bottom:1.6rem}
  .mark span:first-child{font-size:1.5rem;line-height:1}
  .mark span:last-child{
    font-weight:700;letter-spacing:.02em;font-size:.94rem;
  }
  h1{
    font-size:clamp(1.9rem,5.5vw,2.9rem);font-weight:800;letter-spacing:-.03em;
    line-height:1.12;margin:0 0 1rem;text-wrap:balance;
  }
  .lede{font-size:clamp(1rem,2.4vw,1.13rem);color:var(--ink-2);margin:0;max-width:34em;text-wrap:pretty}
  .note{margin:1.4rem 0 0;font-size:.9rem;color:var(--ink-3)}
  section{padding:clamp(2rem,5vw,2.8rem) 0;border-top:1px solid var(--line-soft)}
  h2{font-size:.72rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;
     color:var(--ink-3);margin:0 0 1.1rem}
  pre{
    margin:0;background:var(--surface);border:1px solid var(--line);border-radius:9px;
    padding:.9rem 1.05rem;overflow-x:auto;
    font:13px/1.65 ui-monospace,"SF Mono",Menlo,Consolas,monospace;color:var(--ink-2);
  }
  pre + pre{margin-top:.7rem}
  pre b{color:var(--signal);font-weight:500}
  pre i{color:var(--ink-3);font-style:normal}
  p{margin:0 0 1rem}
  p:last-child{margin-bottom:0}
  .grid{display:grid;gap:.6rem;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
  .card{
    background:var(--surface);border:1px solid var(--line);border-radius:9px;
    padding:.75rem .9rem;
  }
  .card b{display:block;font-size:.9rem;margin-bottom:.12rem}
  .card code{font:12px/1.5 ui-monospace,Menlo,monospace;color:var(--wire);overflow-wrap:anywhere}
  footer{
    padding:2rem 0 3rem;border-top:1px solid var(--line);color:var(--ink-3);font-size:.82rem;
    display:flex;flex-wrap:wrap;gap:.4rem 1.2rem;justify-content:space-between;
  }
  a{color:var(--wire)}
  code:not(pre code):not(.card code){
    font:13px/1.4 ui-monospace,Menlo,monospace;background:var(--surface);
    border:1px solid var(--line-soft);padding:.1em .35em;border-radius:4px;
  }
</style>
</head>
<body>
<div class="wrap">

<header>
  <div class="mark"><span>🕊️</span><span>信鸽Push · PigeonPUSH</span></div>
  <h1>把 webhook 变成一条看得懂的通知</h1>
  <p class="lede">
    别的推送工具是哑管道 —— 你 POST 什么，它推什么，通知栏里塞满原始 JSON。信鸽在服务端就把它渲染成人话。
  </p>
  <p class="note">${get}</p>
</header>

<section>
  <h2>推一条试试</h2>
  <pre>curl <b>https://${site}/{key}/服务器挂了</b>
<i># 带标题。内容里有空格或 &amp; # + % 时，用 --data-urlencode，别拼进地址</i>
curl <b>https://${site}/{key}</b> --data-urlencode "title=生产告警" --data-urlencode "body=CPU 95%"
<i># 要紧的事：每 5 分钟再提醒一次，直到有人处理（最长一小时）</i>
curl <b>https://${site}/{key}</b> -d id=db-01 -d repeat=5 -d level=timeSensitive --data-urlencode "title=主库连不上" --data-urlencode "body=db-01 无响应"
<i># 恢复了：同一个 id 推一条 resolved，提醒随之停下</i>
curl <b>https://${site}/{key}</b> -d id=db-01 -d status=resolved --data-urlencode "body=db-01 已恢复"</pre>
  <p style="margin-top:1rem;font-size:.9rem;color:var(--ink-2)">
    <code>{key}</code> 在信鸽 App 的通道设置里：推送地址里 <code>${site}/</code> 后面的那一段。支持 GET 和 POST，参数 <code>title</code> <code>body</code> <code>level</code> <code>sound</code> <code>icon</code>
    <code>url</code> <code>copy</code> <code>tags</code> 等可以放在 query、表单或 JSON 里。
  </p>
</section>

<section>
  <h2>webhook 直接指过来，零代码</h2>
  <pre>POST https://${site}/hook/<b>{key}</b>/<b>github</b></pre>
  <p style="margin:1rem 0 .9rem;font-size:.9rem;color:var(--ink-2)">
    把上面这个 URL 填进对应服务的 webhook 设置，剩下的服务端处理。已支持：
  </p>
  <div class="grid">
    ${adapters
      .map((a) => `<div class="card"><b>${a.label}</b><code>/hook/{key}/${a.name}</code></div>`)
      .join("\n    ")}
  </div>
</section>

<section>
  <h2>开源，可以核对</h2>
  <p style="font-size:.9rem;color:var(--ink-2)">
    服务端<a href="${SOURCE_URL}">源码公开</a>（AGPL-3.0）。<a href="/info">/info</a> 给出线上正在跑的 commit，可以拿它和仓库里的源码逐行对照。
  </p>
  <p style="font-size:.9rem;color:var(--ink-2)">
    iOS 推送必须用 App 开发者的密钥签名，所以官方信鸽 App 只接收 ${site} 发出的推送：你可以自己部署一份服务端来研究、审计，但官方 App 收不到它的推送。不想让服务端看到内容，就在自己的机器上用 <a href="/tools/pigeon-send.mjs">pigeon-send.mjs</a>
    端到端加密后再推，服务端和 Apple 都只经手密文。
  </p>
</section>

<footer>
  <span>信鸽Push · PigeonPUSH · v${VERSION}</span>
  <span><a href="/support">帮助与支持</a> · <a href="/privacy">隐私政策</a> · <a href="/terms">使用条款</a></span>
</footer>

</div>
</body>
</html>`;
}
