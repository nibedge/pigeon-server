import { listAdapters } from "./adapters";
import { VERSION } from "./routes/misc";

/**
 * nfo.im 的首页。跟推送服务同一个 Worker 提供，不额外花钱、不额外运维。
 * 现在的定位是「说明这是什么 + 让人五分钟内跑通」，等 App 上架再换成正式的
 * 产品页（需要商店链接、截图、下载按钮，现在都还没有）。
 */
export function landingPage(host: string): string {
  const adapters = listAdapters();

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>信鸽Push — webhook 收件箱</title>
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
  .note{
    margin-top:1.8rem;padding:.85rem 1rem;border-left:3px solid var(--signal);
    background:var(--surface);border-radius:0 8px 8px 0;font-size:.9rem;color:var(--ink-2);
  }
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
    别的推送工具是哑管道 —— 你 POST 什么，它推什么，
    通知栏里塞满原始 JSON。信鸽在服务端就把它渲染成人话。
  </p>
  <div class="note">
    <strong>早期预览。</strong>推送服务端已上线并跑通到 APNs 的完整链路，
    iOS App 正在开发中 —— 拿到 key 需要它，所以下面的接口现在还没法真正收到通知。
    接口本身已经稳定，可以先照着接。
  </div>
</header>

<section>
  <h2>推一条试试</h2>
  <pre>curl <b>https://${host}/{key}/服务器挂了</b>
curl <b>https://${host}/{key}/生产告警/CPU 95%</b>
<i># 标题 / 副标题 / 内容</i>
curl <b>https://${host}/{key}/生产告警/api-01/CPU 95%</b></pre>
  <p style="margin-top:1rem;font-size:.9rem;color:var(--ink-2)">
    <code>{key}</code> 在客户端注册后拿到。支持 GET 和 POST，
    参数 <code>title</code> <code>body</code> <code>group</code> <code>level</code>
    <code>sound</code> <code>icon</code> <code>url</code> <code>copy</code> 等可放 query 或 JSON 体里。
  </p>
</section>

<section>
  <h2>webhook 直接指过来，零代码</h2>
  <pre>POST https://${host}/hook/<b>{key}</b>/<b>github</b></pre>
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
  <h2>自建</h2>
  <p style="font-size:.9rem;color:var(--ink-2)">
    服务端<a href="https://github.com/nibedge/pigeon-server">源码公开</a>，一条命令部署到 Cloudflare Workers，个人用量下免费。
    数据只在你的手机、你的服务器和 Apple 之间流动。
  </p>
</section>

<footer>
  <span>信鸽Push · PigeonPUSH · v${VERSION}</span>
  <span><a href="/privacy">隐私政策</a> · <a href="/terms">使用条款</a></span>
</footer>

</div>
</body>
</html>`;
}
