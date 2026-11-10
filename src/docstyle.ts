/** 隐私政策、使用条款、帮助与支持这类文档页共用的样式。几页必须长得一样 —— 它们是同一份承诺的几面 */
export const DOC_STYLE = `
  :root {
    color-scheme:light dark;
    --paper:#F4F7F5; --surface:#fff; --line:#D5E1DB;
    --ink:#172A23; --ink-2:#40564B; --ink-3:#61756A; --signal:#105A46;
  }
  @media (prefers-color-scheme:dark){
    :root{
      --paper:#101A16; --surface:#19271F; --line:#30453A;
      --ink:#EDF5F0; --ink-2:#BECEC4; --ink-3:#96AD9F; --signal:#63C9A4;
    }
  }
  *{box-sizing:border-box}
  body{
    margin:0; background:var(--paper); color:var(--ink);
    font:16px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB",
         "Microsoft YaHei",Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  .wrap{max-width:680px;margin:0 auto;padding:clamp(2.5rem,8vw,4.5rem) clamp(1.1rem,5vw,2rem) 4rem}
  h1{font-size:clamp(1.7rem,4.5vw,2.2rem);font-weight:800;letter-spacing:-.02em;margin:0 0 .4rem}
  .meta{color:var(--ink-3);font-size:.85rem;margin:0 0 2.5rem}
  h2{font-size:1.05rem;font-weight:700;margin:2.4rem 0 .8rem;letter-spacing:-.01em}
  h3{font-size:.95rem;font-weight:600;margin:1.6rem 0 .45rem}
  p{margin:0 0 1rem;color:var(--ink-2)}
  ul{margin:0 0 1rem;padding-left:1.3rem;color:var(--ink-2)}
  li{margin-bottom:.45rem}
  strong{color:var(--ink);font-weight:600}
  code{
    font:13px/1.5 ui-monospace,Menlo,monospace;background:var(--surface);
    border:1px solid var(--line);padding:.1em .4em;border-radius:4px;overflow-wrap:anywhere;
  }
  .callout{
    background:var(--surface);border-left:3px solid var(--signal);
    border-radius:0 8px 8px 0;padding:1rem 1.15rem;margin:1.5rem 0;
  }
  .callout p:last-child{margin-bottom:0}
  table{border-collapse:collapse;width:100%;font-size:.9rem;margin:0 0 1rem}
  th,td{text-align:left;padding:.6rem .7rem;border-bottom:1px solid var(--line);vertical-align:top}
  th{font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3);font-weight:700}
  td{color:var(--ink-2)}
  td:first-child{min-width:5.5em}
  a{color:var(--signal)}
  a:focus-visible{outline:2px solid var(--signal);outline-offset:4px;border-radius:3px}
  @media(max-width:480px){th,td{padding:.55rem .35rem}td:first-child{min-width:0}table{font-size:.83rem}}
  footer{margin-top:3.5rem;padding-top:1.5rem;border-top:1px solid var(--line);
         color:var(--ink-3);font-size:.82rem}
`;
