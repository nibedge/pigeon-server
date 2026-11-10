import { listAdapters } from "./adapters";
import { storeURL } from "./appstore";
import { escapeHtml } from "./invite";
import { VERSION } from "./routes/misc";
import { pageMeta } from "./seo";
import { SOURCE_URL } from "./support";

/** 中英文首页共享布局；强调色与 iOS 的 AccentColor、BadgeFill 保持一致。 */
export const LANDING_STYLE = `
  :root {
    color-scheme:light dark;
    --paper:#F5F8F6; --surface:#fff; --line:#D4E0D9; --line-soft:#E1EAE5;
    --ink:#142C23; --ink-2:#40564C; --ink-3:#5D7167;
    --signal:#105A46; --wire:#105A46; --focus:#105A46;
  }
  @media (prefers-color-scheme:dark){
    :root{
      --paper:#0D1713; --surface:#14241C; --line:#30463A; --line-soft:#23382C;
      --ink:#EDF5F0; --ink-2:#BCCEC2; --ink-3:#96AE9F;
      --signal:#63C9A4; --wire:#63C9A4; --focus:#8AE2BD;
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
  header{padding:clamp(1.5rem,5vw,2.5rem) 0 clamp(1.8rem,4vw,2.6rem)}
  h1{
    font-size:clamp(2rem,5.5vw,3.1rem);font-weight:750;letter-spacing:-.035em;
    line-height:1.18;margin:0 0 1.2rem;text-wrap:balance;
  }
  .lede{font-size:clamp(1rem,2.4vw,1.13rem);color:var(--ink-2);margin:0;max-width:34em;text-wrap:pretty}
  .note{margin:1.4rem 0 0;font-size:.9rem;color:var(--ink-3)}
  section{padding:clamp(2rem,5vw,2.8rem) 0;border-top:1px solid var(--line-soft)}
  h2{font-size:.88rem;font-weight:700;letter-spacing:.025em;
     color:var(--signal);margin:0 0 1.1rem}
  pre{
    margin:0;background:var(--surface);border:1px solid var(--line);border-radius:14px;
    padding:1.05rem 1.15rem;overflow-x:auto;
    font:13px/1.65 ui-monospace,"SF Mono",Menlo,Consolas,monospace;color:var(--ink-2);
  }
  pre + pre{margin-top:.7rem}
  pre b{color:var(--signal);font-weight:500}
  pre i{color:var(--ink-3);font-style:normal}
  p{margin:0 0 1rem}
  p:last-child{margin-bottom:0}
  .grid{display:grid;gap:.75rem;grid-template-columns:repeat(auto-fit,minmax(min(100%,155px),1fr))}
  .card{
    background:var(--surface);border:1px solid var(--line);border-radius:14px;
    padding:1rem;
  }
  .card b{display:block;font-size:.9rem;margin-bottom:.12rem;color:var(--ink)}
  .card{font-size:.84rem;line-height:1.6;color:var(--ink-2)}
  .card a{white-space:normal}
  .grid.tools{grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr))}
  .card code{font:12px/1.5 ui-monospace,Menlo,monospace;color:var(--wire);overflow-wrap:anywhere}
  footer{
    padding:2rem 0 3rem;border-top:1px solid var(--line);color:var(--ink-3);font-size:.82rem;
    display:flex;flex-wrap:wrap;gap:.4rem 1.2rem;justify-content:space-between;
  }
  a{color:var(--wire);text-underline-offset:.18em}
  a:hover{text-decoration-thickness:2px}
  a:focus-visible{outline:2px solid var(--focus);outline-offset:4px;border-radius:3px}
  code:not(pre code):not(.card code){
    font:13px/1.4 ui-monospace,Menlo,monospace;background:var(--surface);
    border:1px solid var(--line-soft);padding:.1em .35em;border-radius:4px;
  }
`;

/**
 * nfo.im 的首页。与推送服务使用同一个 Worker，介绍功能和可执行的接入示例。
 * 审核员会从 App Store 的营销网址点进来；页面只描述当前已有功能。
 */
export function landingPage(host: string): string {
  const adapters = listAdapters();
  const site = escapeHtml(host);
  // 上架了给商店链接；没上架就如实说「即将上架」，不放会 404 的链接。
  const store = storeURL();
  const get = store
    ? `<a href="${store}">去 App Store 下载 iOS App</a>`
    : "iOS App 即将上架 App Store。";

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pigeon — webhook 收件箱</title>
${pageMeta(host, "/", "Pigeon — webhook 收件箱", "将服务事件、监控告警和脚本结果汇集成清晰的 iPhone 通知。支持 Webhook、重复提醒与端到端加密。")}
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>${LANDING_STYLE}</style>
</head>
<body>
<div class="wrap">

<header>
  <h1>把 webhook 变成一条看得懂的通知</h1>
  <p class="lede">
    将服务事件、监控告警和脚本结果汇集到 iPhone。内置适配器把 webhook 内容整理成清晰的通知，重要事件可以持续提醒，直到处理完成。
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
    <code>{key}</code> 在 Pigeon App 的通道设置里：推送地址里 <code>${site}/</code> 后面的那一段。支持 GET 和 POST，参数 <code>title</code> <code>body</code> <code>level</code> <code>sound</code> <code>icon</code>
    <code>url</code> <code>copy</code> <code>tags</code> 等可以放在 query、表单或 JSON 里，全部参数和返回码见<a href="/docs#params">文档</a>。
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
  <h2>接入你正在使用的工具</h2>
  <div class="grid">
    <div class="card"><b>群机器人地址</b>只会往群机器人发消息的工具，把地址的域名换成 ${site} 就行，请求体不用改。<a href="/docs#compat">怎么换</a></div>
    <div class="card"><b>别家推送服务的写法</b><code>text</code>+<code>desp</code>、<code>title</code>+<code>content</code>、<code>template=html</code> 这些参数照样认。<a href="/docs#compat">对照表</a></div>
    <div class="card"><b>AI 助手</b>支持 MCP 的助手加一行配置，就能在任务做完、出错时推给你。<a href="/docs#mcp">配置</a></div>
    <div class="card"><b>命令行</b><code>pigeon run -- make release</code> 跑完推成败、用时和最后几行输出。<a href="/docs#cli">安装</a></div>
  </div>
</section>

<section>
  <h2>开源，可以核对</h2>
  <p style="font-size:.9rem;color:var(--ink-2)">
    服务端<a href="${SOURCE_URL}">源码公开</a>（AGPL-3.0）。<a href="/info">/info</a> 给出线上正在跑的 commit，可以拿它和仓库里的源码逐行对照。
  </p>
  <p style="font-size:.9rem;color:var(--ink-2)">
    iOS 推送必须用 App 开发者的密钥签名，所以官方 Pigeon App 只接收 ${site} 发出的推送：你可以自己部署一份服务端来研究、审计，但官方 App 收不到它的推送。不想让服务端看到内容，就在自己的机器上用 <a href="/tools/pigeon-send.mjs">pigeon-send.mjs</a>
    端到端加密后再推，服务端和 Apple 都只经手密文。
  </p>
</section>

<footer>
  <span>Pigeon · v${VERSION}</span>
  <span><a href="/docs">文档</a> · <a href="/support">帮助与支持</a> · <a href="/privacy">隐私政策</a> · <a href="/terms">使用条款</a></span>
</footer>

</div>
</body>
</html>`;
}
