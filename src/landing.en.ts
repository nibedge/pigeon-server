import { listAdapters } from "./adapters";
import { storeURL } from "./appstore";
import { escapeHtml } from "./invite";
import { LANDING_STYLE } from "./landing";
import { VERSION } from "./routes/misc";
import { pageMeta } from "./seo";
import { SOURCE_URL } from "./support";

/** English counterpart of the public homepage; capabilities and examples match the Chinese page. */
export function landingPageEn(host: string): string {
  const site = escapeHtml(host);
  const store = storeURL();
  const get = store
    ? `<a href="${store}">Download the iOS app on the App Store</a>`
    : "The iOS app is coming soon to the App Store.";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pigeon — Your webhook inbox</title>
${pageMeta(host, "/", "Pigeon — Your webhook inbox", "Turn service events, monitoring alerts, and script results into clear iPhone notifications. With webhook adapters, repeating alerts, and end-to-end encryption.", "en")}
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>${LANDING_STYLE}</style>
</head>
<body>
<div class="wrap">

<header>
  <h1>Turn webhooks into clear notifications</h1>
  <p class="lede">
    Bring service events, monitoring alerts, and script results to your iPhone. Built-in adapters format webhook payloads into readable notifications. Keep important alerts repeating until they are resolved.
  </p>
  <p class="note">${get}</p>
</header>

<section>
  <h2>Send your first notification</h2>
  <pre>curl <b>https://${site}/{key}/Server%20unavailable</b>
<i># Add a title. Use --data-urlencode for spaces and characters such as &amp; # + %.</i>
curl <b>https://${site}/{key}</b> --data-urlencode "title=Production alert" --data-urlencode "body=CPU 95%"
<i># Repeat every 5 minutes until resolved, for up to one hour.</i>
curl <b>https://${site}/{key}</b> -d id=db-01 -d repeat=5 -d level=timeSensitive --data-urlencode "title=Database unreachable" --data-urlencode "body=db-01 is not responding"
<i># Send a resolved event with the same id to stop the reminders.</i>
curl <b>https://${site}/{key}</b> -d id=db-01 -d status=resolved --data-urlencode "body=db-01 is back online"</pre>
  <p style="margin-top:1rem;font-size:.9rem;color:var(--ink-2)">
    Find <code>{key}</code> in your channel settings in Pigeon: it is the part of your push URL after <code>${site}/</code>. Both GET and POST are supported. Send parameters such as <code>title</code>, <code>body</code>, <code>level</code>, <code>sound</code>, <code>icon</code>,
    <code>url</code>, <code>copy</code>, and <code>tags</code> in a query string, form, or JSON body. See the <a href="/docs#params">documentation</a> for all parameters and response codes.
  </p>
</section>

<section>
  <h2>Connect a webhook without writing code</h2>
  <pre>POST https://${site}/hook/<b>{key}</b>/<b>github</b></pre>
  <p style="margin:1rem 0 .9rem;font-size:.9rem;color:var(--ink-2)">
    Add the matching URL to your service's webhook settings. Pigeon handles the formatting. Available adapters:
  </p>
  <div class="grid">
    ${listAdapters()
      .map((adapter) => `<div class="card"><b>${adapter.name === "json" ? "Custom JSON" : adapter.label}</b><code>/hook/{key}/${adapter.name}</code></div>`)
      .join("\n    ")}
  </div>
</section>

<section>
  <h2>Works with the tools you use</h2>
  <div class="grid tools">
    <div class="card"><b>Chatbot webhooks</b>For supported chatbot formats, replace the webhook host with ${site} and keep the request body. <a href="/docs#compat">See supported formats</a></div>
    <div class="card"><b>Existing push scripts</b>Parameters such as <code>text</code> + <code>desp</code>, <code>title</code> + <code>content</code>, and <code>template=html</code> are supported. <a href="/docs#compat">Compatibility guide</a></div>
    <div class="card"><b>AI assistants</b>Connect an MCP-compatible assistant so it can notify you when a task finishes or fails. <a href="/docs#mcp">Set up MCP</a></div>
    <div class="card"><b>Command line</b><code>pigeon run -- make release</code> sends the result, elapsed time, and last lines of output when the command ends. <a href="/docs#cli">Install the CLI</a></div>
  </div>
</section>

<section>
  <h2>Open source, open to inspection</h2>
  <p style="font-size:.9rem;color:var(--ink-2)">
    The server <a href="${SOURCE_URL}">source code is public</a> under AGPL-3.0. The <a href="/info">/info</a> endpoint identifies the commit currently deployed, so you can compare it with the repository.
  </p>
  <p style="font-size:.9rem;color:var(--ink-2)">
    iOS push delivery requires the app developer's signing credentials. The official Pigeon app only receives pushes from ${site}. You can run the server for research and auditing, but the official app cannot receive pushes from your own deployment. To keep notification content private from the server, use <a href="/tools/pigeon-send.mjs">pigeon-send.mjs</a> on your own machine to encrypt it before sending. With end-to-end encryption enabled, the server and Apple receive only ciphertext for that content.
  </p>
</section>

<footer>
  <span>Pigeon · v${VERSION}</span>
  <span><a href="/docs">Documentation</a> · <a href="/support">Help &amp; support</a> · <a href="/privacy">Privacy policy</a> · <a href="/terms">Terms of use</a></span>
</footer>

</div>
</body>
</html>`;
}
