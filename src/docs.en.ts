import { DOCS_UPDATED, renderMarkdown, type DocSection } from "./docs";
import { DOC_STYLE } from "./docstyle";
import { escapeHtml } from "./invite";
import { pageMeta } from "./seo";

/** English counterpart of DOC_SECTIONS; keep API names, limits and anchors aligned. */
export const DOC_SECTIONS_EN: DocSection[] = [
  {
    id: "start",
    title: "Quick start",
    md: `
Pigeon turns an HTTP request into an iOS notification. Each channel has a push URL, \`https://{site}/{key}\`, which you can copy from its settings in the Pigeon app. \`{key}\` is the last part of that URL. Anyone with it can send to the channel, so keep it private.

~~~
curl https://{site}/{key}/Server-down
curl https://{site}/{key} --data-urlencode "title=Disk alert" --data-urlencode "body=3% remaining"
curl https://{site}/{key} -H 'content-type: application/json' -d '{"title":"Deployment complete","body":"v2.3 is live","tags":"white_check_mark"}'
~~~

Choose a starting point:

- A webhook service such as GitHub, Grafana, Uptime Kuma or Alertmanager: use an [adapter](#adapters), with no conversion code.
- A tool that sends to a chat bot or another push service: [replace its destination](#compat).
- Several sources sending to one channel: give each a [sender token](#tokens). Identify and disable individual sources without sharing the channel key.
- A scheduled job: use a [heartbeat](#heartbeat) to check that it finishes on time. See [monitor management](#watches) for pausing, maintenance windows and uptime.
- A long-running command: use the [command wrapper](#cli) to report success or failure.
- An AI or coding assistant: let it send through [MCP](#mcp).
- An urgent incident: use [repeat reminders](#repeat) until someone acknowledges it. Keep an ongoing event on the Lock Screen and Dynamic Island with [Live Activities](#live).
- Actions such as rolling back a deployment, copying a tracking number or replying from a notification: see [notification buttons](#actions) and [receipts and callbacks](#receipts).
- A family or on-call team receiving together: use [groups](#groups).
- Content the server should not be able to read: use [end-to-end encryption](#e2e).
`,
  },
  {
    id: "params",
    title: "Parameters",
    md: `
Parameters can come from the path, query string, headers or request body (JSON or form data). Body values override headers, which override the query string; path values have the highest priority. Channel defaults configured in the app are the fallback. Parameter names are case-insensitive.

| Parameter | Meaning |
|---|---|
| \`title\` | Title |
| \`subtitle\` | Subtitle. Aliases: \`summary\`, \`short\` |
| \`body\` | Body, displayed with Markdown formatting in the app (bold and links). Aliases: \`text\`, \`message\`, \`content\`, \`msg\`, \`desp\`, \`description\` |
| \`markdown\` | Used as the body if \`body\` is not supplied |
| \`level\` | \`passive\`: silent; \`active\`: normal (default); \`timeSensitive\`: time-sensitive, including alerts during Focus when permitted; \`critical\`: delivered as time-sensitive until Apple grants Critical Alerts authorization. Critical requests override channel muting only for the owner and group members who have allowed it; others receive time-sensitive notifications. See [groups](#groups). |
| \`sound\` | Notification sound. Omit for the system default; \`none\` is silent. A recipient's channel-specific sound choice takes priority. |
| \`url\` | Link opened when the notification is tapped |
| \`group\` | Notification Center grouping; defaults to the channel |
| \`tags\` | Up to 5 tags, separated by commas or vertical bars. Recognized shortcodes such as \`warning\`, \`rotating_light\` and \`white_check_mark\` become emoji. |
| \`image\` | Large image URL (HTTPS, up to 10 MB) |
| \`icon\` | Thumbnail URL (HTTPS, up to 2 MB) |
| \`copy\` | Text for one-tap copying. If omitted, the app can identify verification codes itself. |
| \`autoCopy\` | \`1\`: automatically copy \`copy\` when expanding the notification or opening the app |
| \`isArchive\` | \`0\`: do not save to app history |
| \`id\` | Event identifier, up to 64 bytes. A new message with the same ID replaces the previous one. Also used for retraction, repeat reminders, Live Activities and receipts. |
| \`status\` | \`firing\` / \`resolved\`: mark the same \`id\` as active or recovered; the app calculates its duration |
| \`repeat\` | Repeat every 5–60 minutes until acknowledged, for at most one hour. See [repeat reminders](#repeat). |
| \`live\` | \`1\`: a \`status=firing\` event with an \`id\` starts a [Live Activity](#live); \`0\` disables it for this message, overriding channel defaults |
| \`actions\` | Up to 3 [buttons](#actions): open a link, copy text, send a server-side request or reply |
| \`callback\` | HTTPS URL receiving a signed POST when someone acknowledges, performs an action or the final reminder expires without acknowledgement. Not included in the push payload. See [callbacks](#receipts). |
| \`delete\` | \`1\`: retract the message with the same \`id\`; \`id\` is required |
| \`ciphertext\` \`iv\` | [End-to-end encrypted content](#e2e) |

\`badge\`, \`call\`, \`volume\`, \`ttl\`, \`action\` and \`markdown\` supplied alongside \`body\` are recognized but have no effect in this version. They appear in \`data.ignored\`.

### Request formats

- Paths: \`/{key}/{body}\`, \`/{key}/{title}/{body}\` or \`/{key}/{title}/{subtitle}/{body}\`. Use these only for short text without spaces or special characters.
- For spaces or \`&\`, \`#\`, \`+\`, \`%\`, \`/\` or \`?\`, use \`--data-urlencode\` or JSON instead of inserting text directly into the URL.
- A plain-text body also works: \`curl -d "Disk full"\` uses the entire text as the body.
- JSON with a title but no recognized body field uses the remaining fields as key/value lines. With a body but no title, \`subject\` becomes the title. Unrecognized JSON falls back to [generic JSON](#adapters).
- Recognized headers: \`Title\`, \`Priority\` (\`1\`–\`5\` or \`min\`, \`low\`, \`default\`, \`high\`, \`max\`, \`urgent\`), \`Tags\`, \`Click\` and \`Id\`. Titles may include Chinese characters.
- Boolean parameters (\`isArchive\`, \`autoCopy\`, \`delete\`, \`live\`) accept \`true\` / \`false\` / \`yes\` / \`no\` as equivalents of \`1\` / \`0\`.
- To keep the key out of URL logs, send \`Authorization: Bearer {key}\` to \`https://{site}/\`. A [sender token](#tokens) can replace the key wherever a push key is accepted.
- Batch sending: \`POST https://{site}/push\` with \`device_keys\` in JSON (up to 20 keys), plus the same parameters. Per-key results, including \`id\`, \`warnings\`, \`truncated\` and \`live\`, appear in \`data.results\`.

~~~
curl https://{site}/{key} -H "Title: Disk alert" -H "Priority: 4" -d "3% remaining"
curl https://{site}/ -H "Authorization: Bearer {key}" --data-urlencode "body=The key is not in the URL"
~~~
`,
  },
  {
    id: "responses",
    title: "Responses and status codes",
    md: `
Responses are JSON: \`{"code": status_code, "message": "description", "data": {…}, "timestamp": seconds}\`. \`data.id\` is the message ID, generated if omitted. \`data.delivered\` / \`data.devices\` give the number delivered and total devices. \`data.warnings\` contains Chinese diagnostics about truncation or sender-token restrictions. \`data.ignored\` lists parameters with no effect. For Live Activities, \`data.live.started\` counts starts, and \`data.live.ended\` counts activities ended by recovery or retraction.

| Status | Meaning |
|---|---|
| 200 | Accepted. \`data.suppressed: "duplicate"\` means a recent duplicate was merged; do not resend. \`quieted\` indicates channel quiet hours. \`muted\` counts devices receiving silently because the recipient muted the channel or set a higher minimum alert level. |
| 400 | Invalid request: no content, plaintext to an encryption-only channel, retraction without \`id\`, or invalid button/callback URL. See \`message\`. |
| 403 | The channel is suspended, or its owner disabled this sender token. |
| 404 | Unknown key; check the push URL. |
| 410 | Retired address: the channel key was rotated or the sender token deleted (reported this way for 30 days). It can also mean no device can receive for the channel; reopen the app to register again. \`message\` identifies the cause. |
| 413 | Request body exceeds 64 KB (1 MB for \`/hook\` and compatibility endpoints), or the payload still does not fit after text truncation. |
| 429 | Rate limit: up to 60 messages per channel per minute, with an optional lower limit per token. Includes \`Retry-After\`. |
| 502 | A server or Apple delivery problem, rather than an invalid request. Try later. |

Chat-bot requests use the original service's response format; see [compatibility](#compat). MCP uses JSON-RPC; see [MCP](#mcp).
`,
  },
  {
    id: "tokens",
    title: "Sender tokens: one address per source",
    md: `
A channel can issue up to 10 sender tokens: one for a NAS, one for Grafana, and one for a family member's web form. Each has a name shown as the notification source (\`from\` in the payload, including repeat reminders). Disable a token independently, cap its alert level or sending rate, and see which source sends most often. Tokens can send only: they cannot read other messages or change settings. Create one under Send Tokens in channel settings.

A token is \`st_\` followed by 43 characters. Use it anywhere a push key is accepted: paths, \`Authorization: Bearer\`, \`/push\`, \`/hook/{token}/…\`, chat-bot URLs, \`/mcp/{token}\`, receipt queries and the [encryption tool](#e2e).

~~~
curl https://{site}/st_xxxx/Backup-complete
curl https://{site}/ -H "Authorization: Bearer st_xxxx" -d "Disk full"
curl https://{site}/hook/st_xxxx/grafana -H 'content-type: application/json' -d @alert.json
~~~

- **Maximum level:** \`passive\`, \`active\` or \`timeSensitive\`. Higher requests are capped, with an explanation in \`warnings\`. Tokens capped at \`active\` or below cannot request repeat reminders.
- **Messages per minute:** 1–60. Excess requests return 429 without consuming the channel's allowance, so other sources can continue. Each separate Alertmanager notification counts.
- **Disable:** requests return 403 while disabled; re-enabling restores access.
- **Message IDs:** token messages automatically get a prefix (\`~\` + 8 characters + \`~\`); the response returns the prefixed ID. If that exceeds 64 bytes, a digest is used. The same token can later use either its original or returned ID for replacement, retraction, \`status=resolved\` or receipts. Different sources remain separate: a token cannot modify the owner's or another token's messages or query their receipts. Main-key queries of token messages need the prefixed ID.
- **Buttons:** tokens may include open-link, copy and address-free [buttons](#actions). Server-side request buttons (\`http\` and \`reply\` with a URL) return 400 because they carry the channel callback signature. Only the owner may choose those destinations and contents: send with the main key, or configure channel default buttons.
- **The plaintext token is shown only at creation.** The server stores its SHA-256 hash. Delete and recreate a lost token.
- **Web form:** \`https://{site}/s/{token}\` names the channel and accepts a title, body and alert level. Disabled/deleted tokens display their status. Encryption-only channels cannot use this plaintext form.

**After using Change Push URL** ( \`POST /account/{id}/channels/{cid}/key\`), the old address immediately stops working. For 30 days it returns 410 rather than “unknown key.” The owner receives at most one silent reminder daily that an old address is still used, identifying the entry point and calling program, such as a path request from curl/8.4.0. Deleted tokens behave the same way.

Only owners may manage tokens; members receive 403. Authenticate with \`Authorization: Bearer {account_secret}\`:

| Endpoint | Meaning |
|---|---|
| \`GET /account/{id}/channels/{cid}/tokens\` | List without plaintext: \`{"tokens": [{id, name, hint, max_level?, per_minute?, disabled, created_at, count, last_used_at?}], "limit": 10}\` |
| \`POST /account/{id}/channels/{cid}/tokens\` | Create: \`{"name", "max_level"?, "per_minute"?}\`. Name: up to 20 characters, unique in the channel. Returns \`{"token", "value": "st_…", "push_url", "page_url"}\`. |
| \`PATCH /account/{id}/channels/{cid}/tokens/{tid}\` | Update \`name\`, \`max_level\`, \`per_minute\` (use \`null\` to remove a limit) or \`disabled\` |
| \`DELETE /account/{id}/channels/{cid}/tokens/{tid}\` | Delete; requests return 410 for 30 days |
`,
  },
  {
    id: "adapters",
    title: "Adapters: third-party webhooks",
    md: `
Use \`POST https://{site}/hook/{key}/{adapter}\` as the service's webhook destination. No conversion code is needed.

| Adapter | Events and setup |
|---|---|
| \`github\` | Failed builds, approvals, PRs, issues, releases and pushes. Select \`application/json\` and Workflow runs, Issues, Pull requests and Releases events. |
| \`grafana\` | Firing and recovered alerts; grouped alerts become one incident with a duration. Attach the contact point to Notification policies. |
| \`uptimekuma\` | Downtime, recovery and expiring certificates. Enable this notification for each monitor. |
| \`alertmanager\` | One message per fingerprint, with separate duration/recovery. Severity sets the level; tapping opens its runbook or source. |
| \`json\` | Common fields such as title, name, event and status form the title; up to 6 fields become key/value lines. |

A [sender token](#tokens) can replace the key to identify and limit the source.

### Alertmanager

~~~
receivers:
  - name: pigeon
    webhook_configs:
      - url: https://{site}/hook/{key}/alertmanager
        send_resolved: true
~~~

- Each alert's \`id\` is \`am-{fingerprint}\`. Identically named alerts on different machines remain separate; recovery resolves only the matching one.
- \`severity=critical\` is time-sensitive, \`warning\` normal and \`info\` silent. Recovery is always silent.
- A grouped subtitle gives the firing count; Notification Center groups them. When alerts join or recover, only new/recovered alerts notify again; existing firing alerts are named in the new message. The server tracks delivered fingerprints and firing times per group. Undelivered alerts are not recorded and can be retried.
- An unchanged group resent at \`repeat_interval\` is delivered again: Alertmanager is reminding you that it remains unresolved.
- If channel limits or Apple rejection leave firing alerts undelivered, the response is 503 with \`Retry-After\`. A later group retry delivers missing alerts without ringing again for those already delivered.
- At most 10 notifications per request. Overflow is combined into the last message with the remaining count; that message does not repeat. Channel limits count each notification.
- Tapping opens \`runbook_url\`, falling back to \`generatorURL\`.

### Arbitrary JSON

~~~
curl https://{site}/hook/{key}/json -H 'content-type: application/json' -d '{"event":"Backup","status":"Failed","host":"nas","disk":"/data"}'
~~~

The title becomes “Backup · Failed,” with \`host: nas\` and \`disk: /data\` in the body. Credential-like fields (token, secret, password, sign…) are excluded. \`severity\`, \`level\` or \`priority\` sets alert strength: \`critical\` and \`high\` are time-sensitive; \`info\` and \`low\` are silent. Body fields \`id\` and \`repeat\` are not treated as push parameters. JSON sent to \`/{key}\` uses the same fallback when it has no recognized body field.
`,
  },
  {
    id: "compat",
    title: "Compatibility with other services",
    md: `
### Chat-bot webhook URLs

For dashboards, monitors, CI and scripts that only send to chat bots, replace the hostname with \`{site}\` and the key with a Pigeon key or [sender token](#tokens). Keep the body unchanged. Channel settings include Migrate from Another Tool with copyable URLs; paste an existing URL to identify its replacement.

| Original pattern | Replacement |
|---|---|
| \`https://…/cgi-bin/webhook/send?key=…\` | \`https://{site}/cgi-bin/webhook/send?key={key}\` |
| \`https://…/robot/send?access_token=…\` | \`https://{site}/robot/send?access_token={key}\` |
| \`https://…/open-apis/bot/v2/hook/…\` | \`https://{site}/open-apis/bot/v2/hook/{key}\` |
| \`https://…/api/webhooks/{number}/…\` | \`https://{site}/api/webhooks/0/{key}\` |
| \`https://…/services/…/…/…\` | \`https://{site}/services/x/{key}\` |

~~~
curl 'https://{site}/cgi-bin/webhook/send?key={key}' -H 'content-type: application/json' -d '{"msgtype":"text","text":{"content":"Deployment complete\\nv2.3 is live"}}'
~~~

- Recognized JSON families: \`{msgtype, text | markdown | link | actionCard | feedCard | news | template_card}\`; \`{msg_type, content: {text | post}, card}\`; \`{content, embeds: [{title, description, url, fields, image}]}\`; and \`{text, blocks, attachments}\`. These also work directly at \`https://{site}/{key}\`.
- Card/article titles become the title. In multiline text, the first line is the title and the rest the body. Button/title links become the tap URL, falling back to fields named as a URL, link or address. Images become large images; fields become name/value lines. Markdown headings/quotes lose their markers, lists use “•”, tables become “a · b”, and tags such as \`<font>\` are removed; bold and links remain. With multiple cards/articles, the first expands and remaining titles are listed.
- Everyone mentions (\`isAtAll\`, \`@all\`, \`<!channel>\`, \`@everyone\`…) request time-sensitive delivery.
- Incoming \`timestamp\` and \`sign\` are ignored. The Pigeon key in the URL is the credential.
- Responses match the original service: \`{"errcode":0,"errmsg":"ok"}\`, \`{"code":0,"msg":"success"}\`, \`204\` (or a message with \`id\` when \`?wait=true\` is present), or plain \`ok\`. Failures retain real HTTP statuses, including 403 for disabled tokens and 410 for rotated keys/deleted tokens. Error descriptions are Chinese.
- Append Pigeon parameters such as \`&level=passive\`, \`&repeat=5\` or \`&actions=…\` to override extracted values.
- Unsupported image, file or audio types produce a placeholder, such as an image placeholder.

### Other push-service parameter formats

Built-in formats in scripts, dashboards and RSS tools can keep working after replacing the hostname and key:

| Format | Interpretation |
|---|---|
| \`/{key}.send?title=…&desp=…\` | Ignore \`.send\`. \`desp\` is Markdown body: remove heading/quote markers, use “•” for lists and “a · b” for table rows. |
| \`text\` + \`desp\` | Title and body; with only \`text\`, it is the body |
| \`title\` + \`content\` | Title and body |
| \`content\` + \`summary\` | Body and subtitle |
| \`template\`, \`contentType\`, \`type\` | \`html\` (or \`contentType=2\`) becomes text; \`json\` becomes key/value lines; \`markdown\` (or \`contentType=3\`) follows \`desp\` processing; \`txt\` remains unchanged. For \`type=image\` the body is an image URL. |
| \`tags=a\\|b\` | Tags separated by a vertical bar |
| \`channel\` \`topic\` \`token\` \`openid\` \`callbackUrl\` \`uids\` … | Unused service-specific fields, listed in \`data.ignored\`; their values are not sent in the notification |

~~~
curl https://{site}/{key}.send --data-urlencode "title=Check-in complete" --data-urlencode "desp=12 consecutive days"
curl https://{site}/{key} --data-urlencode "text=Build complete" --data-urlencode "desp=**main** branch · 3 minutes"
~~~
`,
  },
  {
    id: "heartbeat",
    title: "Heartbeats: scheduled jobs",
    md: `
Create a Heartbeat in the app's monitors to get a check-in URL. Call it when a job finishes; a missed check-in alerts you.

~~~
curl -fsS https://{site}/hb/{id}
curl -fsS https://{site}/hb/{id}/fail -d "Disk full"
curl -fsS https://{site}/hb/{id}/start
curl -fsS https://{site}/hb/{id}/$?
~~~

- Check-ins accept GET, POST and HEAD. Explicit failures require POST (\`-d\` or \`-X POST\`) and alert immediately. Descriptions can also go in \`?msg=\`.
- Exit codes: \`/hb/{id}/0\` is success; \`1\`–\`255\` report failure with the exit code. The default GET from \`curl …/$?\` is accepted.
- \`/start\` records a run's start. The next check-in/failure/exit-code response includes \`duration_ms\` and alerts show its duration. A missing check-in then distinguishes a job that never started from one that is stuck. Starting is not a check-in; starts less than 4 minutes apart are ignored.
- No missing-check-in alert before the first check-in. A missed run alerts only once; the next check-in sends recovery.
- Link previews and browser prefetches neither check in nor report failure.
- With the [wrapper](#cli), \`pigeon run -- ./backup.sh && curl -fsS https://{site}/hb/{id}\` gives detailed failures and checks in after success.

A full job can report both start and exit:

~~~
curl -fsS https://{site}/hb/{id}/start
./backup.sh
curl -fsS https://{site}/hb/{id}/$?
~~~

Website monitors are also created in the app. Checks run from Cloudflare locations outside mainland China, time out after 5 seconds and require two consecutive failures before reporting downtime. See [monitor management](#watches) for pauses, weekly maintenance windows, immediate checks, history and uptime.
`,
  },
  {
    id: "watches",
    title: "Monitor management",
    md: `
These controls appear in the app's monitor details. The API uses account \`Authorization: Bearer {secret}\`. Only owners can access their monitors; others receive 404.

| Endpoint | Meaning |
|---|---|
| \`GET /account/{id}/watches\` | List owned monitors |
| \`POST /account/{id}/watches\` | Create with \`kind\` (\`up\` / \`keyword\` / \`heartbeat\`), \`channelId\`, \`url\`, \`keyword\`, \`present\`, \`intervalMinutes\`, \`graceMinutes\`, \`name\`, \`level\`, \`repeat\` and \`maintenance\` |
| \`PATCH /account/{id}/watches/{wid}\` | Edit supplied fields with creation-equivalent validation |
| \`POST /account/{id}/watches/{wid}/check\` | Check a website monitor now |
| \`GET /account/{id}/watches/{wid}/history?tz=Asia/Shanghai\` | History and uptime |
| \`DELETE /account/{id}/watches/{wid}\` | Delete and stop queued repeat reminders |

### Pauses and maintenance

- \`paused_until\`: a millisecond timestamp pauses until then (at most one year); \`0\` pauses indefinitely; \`null\` resumes. While paused, websites are not fetched and heartbeats are not marked missing. Resuming gives heartbeats a full interval plus grace period.
- \`maintenance\`: a weekly window, such as \`{"days": [7], "start": "03:00", "end": "04:00", "tz": "Asia/Shanghai"}\`; \`null\` removes it. \`days\` names the start days, 1 = Monday through 7 = Sunday. An \`end\` no later than \`start\` crosses midnight; equal times mean 24 hours. Checks/history continue but alerts are suppressed.
- If a suppressed failure remains unresolved when the pause/window ends, a notification explains when it began. If already recovered, nothing is sent. Recovery for a previously announced incident still arrives during these periods, silently.

### Editing rules

- \`up\` and \`keyword\` checks can convert to one another; website and heartbeat monitors cannot. Editing a heartbeat preserves its check-in URL.
- A new destination channel must also be owned by you, active and not encryption-only. Use \`null\` for \`level\` or \`0\` for \`repeat\` to remove these settings.
- Automatically generated names follow URL changes. A default heartbeat grace period is recalculated for a changed interval.
- Changing the type, keyword or presence condition resets it as newly created; the first check does not alert. Pausing, changing channels or changing the check stops the old incident's repeat reminders.

### Immediate checks and history

- Check-now returns \`{"result": {"status", "ok", "detail", "response_ms", "checked_at"}, "alerted", "watch"}\`. Real downtime still alerts once per incident. Limit: once per monitor per minute, including scheduled checks; excess returns 429. Heartbeats return 400 because they have no URL to check.
- History includes \`changes\` (20 state changes), \`checks\` (24 hours of checks/check-ins, heartbeat runtime in \`ms\`), \`daily\` (30 days grouped by \`tz\`), \`uptime_24h\`, \`uptime_7d\` and \`uptime_30d\`. Uptime is duration-based, excludes pauses and failures during maintenance, and is \`null\` without data.
- Alerts carry \`watch_id\` matching the monitor view's \`ref\`. Heartbeat \`ref\` values derive one-way from the check-in URL, so members do not receive check-in credentials.
`,
  },
  {
    id: "repeat",
    title: "Repeat reminders and acknowledgement",
    md: `
Keep reminding until someone handles an important incident:

~~~
curl https://{site}/{key} -d id=db-01 -d repeat=5 -d level=timeSensitive --data-urlencode "title=Primary database unavailable" --data-urlencode "body=db-01 is not responding"
curl https://{site}/{key} -d id=db-01 -d status=resolved --data-urlencode "body=db-01 has recovered"
curl https://{site}/{key} -d id=db-01 -d delete=1
~~~

- \`repeat\` is 5–60 minutes; \`1\` or \`true\` means 5. Reminders last at most one hour from the first notification. \`passive\` messages do not repeat.
- Stop by choosing Got it, stop reminding on a personal notification, choosing I’m on it in a group, sending \`status=resolved\` with the same \`id\`, or retracting with \`delete=1\`.
- The first group claim is broadcast to everyone, replacing the original notification with who is handling it. After resolution, the next incident using that ID needs a fresh claim.
- At most 10 messages per channel and 30 across one owner's channels can repeat simultaneously. Additional messages still deliver, with \`repeat_skipped\` in the response.
- If a \`callback\` exists and the final reminder remains unclaimed, an \`expired\` event is sent; see [callbacks](#receipts).
- Retraction replaces the Lock Screen/Notification Center message with a retraction notice and removes app history. It cannot undo what someone already saw.
`,
  },
  {
    id: "actions",
    title: "Notification buttons",
    md: `
\`actions\` adds up to 3 buttons. Long-press or expand a notification to act without opening the app. Buttons also appear on history cards and message details.

~~~
curl https://{site}/{key} -d id=deploy-42 --data-urlencode "title=Production deployment pending" --data-urlencode "actions=View=https://ci.example.com/run/42; !Rollback=POST https://ci.example.com/rollback/42"
curl https://{site}/{key} -H 'content-type: application/json' -d '{"title":"Verification code 482910","body":"A sign-in was requested","actions":[{"type":"copy","label":"Copy","value":"482910"},{"type":"reply","label":"Reply","url":"https://bot.example.com/reply"}]}'
~~~

Shorthand: \`label=target\`, separated by semicolons/newlines. Prefix the label with \`!\` for a destructive action, shown red and requiring phone unlock:

| Shorthand | Action |
|---|---|
| \`View=https://…\` | Open link |
| \`Rollback=POST https://…\` | Server-side request; \`GET\`, \`PUT\`, \`PATCH\`, \`DELETE\` also work |
| \`Tracking=copy:SF1234\` | Copy |
| \`Reply=reply\` or \`Reply=reply https://…\` | Enter a reply; a supplied URL receives it |
| \`Received\` | A label alone records the action in receipts/callbacks |

JSON fields: \`type\` (\`open\`, \`http\`, \`copy\`, \`reply\`), \`label\` (required, up to 20 characters), \`url\`, \`method\`, \`headers\` (up to 8), \`body\`, \`value\` (copy text), \`destructive\` and \`auth\`. Server-controlled headers such as \`Host\` and \`X-Pigeon-*\` cannot be overridden. Definitions and headers go to every recipient's phone. \`Authorization\` and \`Cookie\` are rejected; never put credentials in other headers either. Destinations should verify Pigeon's [signature](#receipts).

- \`open\`/\`copy\` run on the phone. \`http\`/\`reply\` are forwarded by the server. The app returns signed definitions unchanged to \`POST /account/{id}/channels/{cid}/actions\` as \`{message_id, index, actions, act_sig, reply_text}\`, receiving \`{status, ok, error}\`. The server verifies the exact definitions using \`act_sig\` before requesting the destination.
- Only public HTTPS domain names are accepted, excluding IPs, internal hosts, credential-bearing URLs and Pigeon itself. Timeout: 5 seconds. Redirects: up to 3, HTTPS on the same host and port only.
- Definitions count toward the 4 KB payload and can use at most about 1.5 KB. Encryption-only channels reject buttons because their labels/URLs cannot be encrypted for this feature. Supplied or new default buttons return 400; older defaults stop being sent when encryption-only is enabled. Invalid definitions return 400.
- Forwarded requests carry \`X-Pigeon-Timestamp\`, \`X-Pigeon-Signature\` and \`X-Pigeon-Event: action\` or \`reply\`, signed using the channel callback secret and binding method, URL and event. Without an explicit \`body\`, \`POST\`/\`PUT\`/\`PATCH\` send \`{"event","channel_id","id","by","at","action","index"}\`. See [verification](#receipts).
- Results replace the notification, such as “Rollback · 200” or a failure reason; tap again to retry. In groups, results are broadcast in place with the person's name.
- Where slots remain, default buttons offer a 30-minute reminder and one-hour channel mute. Recipients can disable them in Settings → Notifications & Sounds.
`,
  },
  {
    id: "receipts",
    title: "Receipts and callbacks",
    md: `
Use callbacks for immediate event delivery, or receipts for queries and long polling, to learn who handled an incident and when.

### Callbacks

Supply \`callback=https://…\` with a push, or as a channel default. The server POSTs signed JSON for these events; \`X-Pigeon-Event\` names the event:

| Event | Trigger | Extra fields |
|---|---|---|
| \`ack\` | First acknowledgement or claim | \`by\` |
| \`action\` | An \`http\` button is used | \`by\`, \`action\` (label) |
| \`reply\` | A \`reply\` button submits text | \`by\`, \`action\`, \`reply\` (submitted text) |
| \`expired\` | Final reminder expires without acknowledgement | \`reminders\` (count including original) |

~~~
{"event":"reply","channel_id":"…","id":"deploy-42","by":"Alex","at":1700000000000,"action":"Reply","reply":"One moment, checking"}
~~~

Callbacks contain event metadata, not the original message body. The callback URL is not in the push payload. Delivery is best-effort: 5-second timeout, no retries; use receipts as fallback. Owners can set \`defaults.callback\` under channel settings → Notification Buttons & Callbacks. A request's \`callback\` overrides it. Default \`callback\` and \`actions\` are validated on save; invalid values return 400.

### Receipts

\`GET https://{site}/{key}/receipt/{message_id}?wait=0..60&since=milliseconds\` authenticates with the push key or sender token. Tokens can query only messages they sent.

~~~
curl "https://{site}/{key}/receipt/deploy-42?wait=30"
~~~

Returns \`{acked_by, acked_at, actions: [{by, at, label, type, status, ok, reply}]}\`. Positive \`wait\` long-polls until an acknowledgement/action or timeout, then returns the current state. For subsequent events, pass the latest \`at\` as \`since\`. Distributed caches mean events elsewhere may take about a minute to appear. Polls check every 2–3 seconds initially, then every 10 seconds; use callbacks for immediate delivery. Limit: 60 receipt queries per channel per minute. Receipts last 7 days.

### Signatures

Callbacks and forwarded buttons use the channel callback secret, visible/resettable only by the owner under notification buttons and callbacks:

~~~
X-Pigeon-Timestamp: <Unix timestamp in seconds>
X-Pigeon-Signature: sha256=<hex(HMAC-SHA256(callback_secret, timestamp + "\\n" + method + "\\n" + full_url + "\\n" + event + "\\n" + body))>
X-Pigeon-Event: ack | action | reply | expired
User-Agent: Pigeon-Callback/1
~~~

The signature binds method, full destination URL and event. The URL is exactly what Pigeon requests: \`https://\` plus lowercase hostname, path and query, without the default port or fragment. A signature from another destination or with an altered event cannot verify. Use raw body bytes (empty when absent) and your public URL, not an internal reverse-proxy address. Reject timestamps over 5 minutes away:

~~~
import hashlib, hmac, time
def from_pigeon(secret, headers, method, url, raw_body):
    ts = headers["X-Pigeon-Timestamp"]
    signed = f"{ts}\\n{method}\\n{url}\\n{headers['X-Pigeon-Event']}\\n".encode() + raw_body
    expected = "sha256=" + hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, headers["X-Pigeon-Signature"]) and abs(time.time() - int(ts)) < 300
~~~

Owners can read or rotate the secret with \`GET\` / \`POST /account/{id}/channels/{cid}/callback-secret\` and \`Authorization: Bearer {account_secret}\`. POST invalidates the old secret immediately.
`,
  },
  {
    id: "live",
    title: "Live Activities and Dynamic Island",
    md: `
An incident can stay on the Lock Screen and Dynamic Island from failure to recovery, with a running duration. A group claim shows who is handling it. Recovery freezes the final duration and dismisses the activity after 15 minutes.

~~~
curl https://{site}/{key} -d id=db-01 -d status=firing -d live=1 -d level=timeSensitive --data-urlencode "title=Primary database unavailable"
curl https://{site}/{key} -d id=db-01 -d status=resolved --data-urlencode "body=Recovered"
~~~

- A sender-supplied \`id\` is required for recovery, acknowledgement and retraction. Another \`firing\` update with the same active ID does not create a second activity. Recovery/retraction need no \`live\` parameter; \`delete=1\` dismisses immediately.
- Recipients need iOS 17.2 or later, event Live Activities enabled in the app (on by default), and Live Activities allowed for Pigeon in system settings.
- Muting, higher minimum alert levels, channel quiet hours and \`passive\` delivery produce ordinary notifications without starting activities. A member's unauthorized \`critical\` request is downgraded to time-sensitive and can still start an activity.
- Owners can enable the channel's default \`live\` setting instead of adding \`live=1\` each time. All \`firing\` events with an \`id\` then qualify, including adapters/monitors. Use \`live=0\` to opt out for one message.
- The initial title is delivered to the phone, not retained on the server. Encrypted messages are decrypted on the phone before the real title is displayed.

The app registers activity tokens; senders do not need them. These endpoints document server storage. They require \`Authorization: Bearer {account_secret}\` and share a limit of 20 requests per account per minute:

| Request | Meaning |
|---|---|
| \`PUT /account/{id}/devices/{push_token}/activity-start-token\` | \`{"token"}\` registers the device's push-to-start token. Its account device view gains \`activity_start_token_prefix\`. |
| \`DELETE /account/{id}/devices/{push_token}/activity-start-token\` | The device disabled event Live Activities. |
| \`PUT /account/{id}/activities/{channel_id}/{message_id}\` | \`{"token", "device", "started_at"}\` registers this activity's update token. An already-ended event returns \`{"registered": false, "ended": true, …}\` and the app dismisses it. |
`,
  },
  {
    id: "groups",
    title: "Groups and recipient controls",
    md: `
Invite others to receive a channel's notifications. Only its owner sees the push address or manages settings/members. Member calls to management endpoints return 403; API responses and notifications never reveal the address. Invite codes have 8 characters, last 7 days and require confirmation before joining. Group notifications offer a claim button; see [repeat reminders](#repeat).

### Member messages

The owner can turn on Allow Members to Send Messages using \`PATCH /account/{id}/channels/{cid}\` with \`"member_send": true\`. It is off by default. Members can then send from the app; the owner can always send:

~~~
POST /account/{id}/channels/{cid}/messages
{"title"?: "…", "body": "…", "level"?: "passive" | "active" | "timeSensitive"}
~~~

- Only title (up to 100 characters), body (up to 1,000) and level (at most time-sensitive) are accepted. Encryption-only groups use \`ciphertext\` and \`iv\` instead. Channel defaults are not applied; links, images and repeat reminders are unavailable here.
- Content filtering, encryption-only mode, suspension and the channel's 60-per-minute limit still apply. Each person may send up to 20 per minute.
- The payload's \`sender\` is the person's display name, also used as title when omitted. The sender's own devices receive silently for history.

### Recipients remain in control

Owners define the message; recipients choose alert behavior in their channel settings. These preferences are merged per entry using \`prefs_patch\` in \`PATCH /account/{id}\`:

- **Allow critical** (\`critical\`: \`{channel_id: true}\`) lets this group's critical requests override personal channel muting and quiet hours. An absent entry means not allowed: critical requests become time-sensitive and remain subject to those controls. Channels the recipient owns do not need this permission.
- **Minimum alert level** (\`minLevel\`: \`{channel_id: "passive" | "active" | "timeSensitive" | "critical"}\`) makes lower levels silent, keeping them in Notification Center/history. \`timeSensitive\` lets only important alerts sound; \`critical\` lets only critical requests sound. This is separate from muting: a critical request without override permission still receives time-sensitive delivery where applicable.

\`muted\` in the response includes deliveries silenced by recipient controls. [Live Activities](#live) follow the same suppression.
`,
  },
  {
    id: "e2e",
    title: "End-to-end encryption",
    md: `
Encrypt the title, body, links and tags before sending. Pigeon's server and Apple handle ciphertext; the receiving app decrypts it.

~~~
curl -sO https://{site}/tools/pigeon-send.mjs
node pigeon-send.mjs https://{site}/{key} --key {channel_encryption_key} --title "Disk full" --body "3% remaining"
~~~

- The tool is byte-for-byte identical to \`tools/pigeon-send.mjs\` in the repository and uses only built-in Node modules. Copy the channel encryption key from its encryption settings, or use \`PIGEON_KEY\` in the environment. The URL key can be a [sender token](#tokens).
- Format: AES-256-GCM with a random 12-byte nonce. \`ciphertext\` = base64(ciphertext ‖ 16-byte authentication tag); \`iv\` = base64(nonce). Plaintext is JSON: \`{title, subtitle, body, url, tags}\`.
- \`level\`, \`id\`, \`status\`, \`group\`, \`sound\`, \`repeat\`, \`isArchive\`, \`delete\` and \`live\` remain unencrypted for delivery. Button definitions and callback URLs cannot be encrypted because the server uses them to make requests.
- Encryption-only channels return 400 for missing ciphertext, plaintext content outside the ciphertext, or buttons. Third-party webhooks, chat-bot formats, MCP and web forms send plaintext and cannot use such channels.
`,
  },
  {
    id: "web",
    title: "Send from a browser",
    md: `
Share \`https://{site}/send#{key}\` to let someone fill a browser form without coding. The key follows \`#\`, so it is not included when the browser fetches the page. Messages sent by the form are not end-to-end encrypted.

Prefer a [sender-token](#tokens) form, \`https://{site}/s/{token}\`, for separate permissions. It names the receiving channel and accepts only title, body and alert level. Disable it independently or cap its level without sharing the main push address.
`,
  },
  {
    id: "mcp",
    title: "AI assistants (MCP)",
    md: `
An MCP-capable AI or coding assistant can notify you when a task finishes, fails or needs input. Add a remote MCP server with Streamable HTTP transport, sometimes labeled \`http\`:

~~~
{
  "mcpServers": {
    "pigeon": { "type": "http", "url": "https://{site}/mcp/{key}" }
  }
}
~~~

The app's AI assistant integration provides a configuration with the channel URL filled in. To keep the key out of the URL, use \`https://{site}/mcp\` plus \`Authorization: Bearer {key}\`.

The \`notify\` tool accepts \`title\`, \`body\`, \`level\` (\`passive\` / \`active\` / \`timeSensitive\`), \`url\`, \`id\`, \`status\` (\`firing\` / \`resolved\`) and \`repeat\` in minutes. It follows the same deduplication, quiet hours, reminder, rate-limit and group rules as ordinary push.

~~~
curl https://{site}/mcp/{key} -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"notify","arguments":{"title":"Test","body":"Sent through MCP"}}}'
~~~

- Stateless: no session IDs or SSE streams; one JSON response per request. Supported versions: \`2026-07-28\` (version and \`MCP-Protocol-Version\`/\`Mcp-Method\` headers supplied on each request), plus \`2025-11-25\`, \`2025-06-18\` and \`2025-03-26\` (initial \`initialize\` handshake).
- MCP content passes through Pigeon's server as **plaintext**. Do not include passwords or secrets. Use [pigeon-send.mjs](#e2e) for encryption. Encryption-only channels do not support MCP.
- Give each assistant a [sender token](#tokens) at \`https://{site}/mcp/{token}\` to identify the source and limit level/rate. Deleting that token revokes access, returning 410.
`,
  },
  {
    id: "cli",
    title: "Command-line wrapper",
    md: `
A POSIX shell script requiring only \`sh\` and \`curl\`. The app's command-line integration has an installation command with the channel address filled in:

~~~
mkdir -p ~/.local/bin ~/.config/pigeon
curl -fsSL https://{site}/tools/pigeon.sh -o ~/.local/bin/pigeon
chmod +x ~/.local/bin/pigeon
echo '{key}' > ~/.config/pigeon/key && chmod 600 ~/.config/pigeon/key
~~~

macOS does not include \`~/.local/bin\` in the default \`PATH\`. Add \`export PATH="$HOME/.local/bin:$PATH"\` to \`~/.zshrc\`, or invoke \`~/.local/bin/pigeon\` directly.

~~~
pigeon send "Backup complete" "Finished in 3 minutes"
df -h | pigeon send "Disk usage" -
pigeon run -- make release
pigeon run --id nightly -- ./backup.sh
~~~

- \`pigeon run\` displays command output normally, then reports success/failure with exit code, duration, hostname and the last 5 lines. Failures are time-sensitive. It returns the original exit code, preserving script/cron behavior.
- With \`--id\`, failure sends \`status=firing\` and success \`status=resolved\`, stopping [reminders](#repeat) from a previous failure. \`--quiet\` makes success silent while failure still alerts.
- Other options: \`--level\`, \`--url\`, \`--group\`, \`--repeat\`, \`--status\`, \`--title\`.
- The key comes from \`PIGEON_KEY\`, then \`~/.config/pigeon/key\`. Either can hold a key, [sender token](#tokens) or full push URL. It is passed to curl on standard input, not in command-line arguments.
- The downloaded file is byte-for-byte identical to repository \`tools/pigeon.sh\`. [Read it](/tools/pigeon.sh) before downloading.
`,
  },
  {
    id: "selftest",
    title: "Notification diagnostics and drills",
    md: `
The app's notification diagnostics investigate delivery when settings appear correct: unregistered devices, wrong APNs environment, invalid tokens or Apple rejection. It checks local settings, then requests a real push to measure server-to-device delivery time.

Endpoint: \`POST /account/{id}/selftest\` with \`Authorization: Bearer {account_secret}\`, up to 20 requests per account per minute. All body fields are optional:

| Field | Meaning |
|---|---|
| \`token_prefix\` | First 12 characters of the current device's push token, or the full token. Only it gets the test notification; others get background probes. |
| \`environment\` | Actual \`sandbox\` / \`production\` environment, checked against registration |
| \`drill\` | \`true\` starts an alert drill |
| \`channel_id\` | Drill channel; otherwise the first personal, non-encryption-only channel |
| \`drill_resolve\` | Drill message ID to resolve |

- **Delivery timing:** silent, not archived and expires after 10 minutes. The payload's \`selftest\` is a random identifier. Response: raw APNs results per device (\`devices\`), local registration (\`this_device\`), channels delivered silently (\`silenced\`: personal muting, quiet hours or higher minimum level), and \`problems\`: \`not_registered\`, \`environment_mismatch\`, \`device_invalid\`, \`push_failed\`, \`no_devices\`.
- **Drill:** sends a time-sensitive personal-channel test with acknowledgement. A following sweep repeats around one minute later (\`drill.remind_at\`). Acknowledgement follows the normal flow; \`drill_resolve\` sends recovery. Real controls still apply, with \`problems\` including \`quiet_hours\`, \`muted\`, \`min_level\` and \`repeat_skipped\`. Channel-default [Live Activities](#live) start and end with the drill. Group and encryption-only channels cannot be used.
- Diagnostic records contain only a random identifier, timestamp and channel ID, expiring after 10 minutes.
`,
  },
  {
    id: "readthrough",
    title: "Read status across devices",
    md: `
After a message is read on one device, others mark it read and remove the corresponding Notification Center entries on refresh. Account \`readThrough\` maps channel IDs to millisecond timestamps. Messages with \`sent_at\` no later than the channel's timestamp are read. Update via \`prefs_patch\` in \`PATCH /account/{id}\`.

- Values only move forward; older values are ignored in both per-entry and full updates. Older app versions omitting this field preserve it. Set an entry to \`null\` to remove it.
- Values more than 10 minutes ahead of server time are capped at that boundary, preventing a fast device clock from marking all future messages read.
- Only a timestamp is stored, not a list of read messages. Deleting a channel or leaving a group removes its entry.
`,
  },
  {
    id: "backup",
    title: "Backup and restore for operators",
    md: `
KV is the service's only storage. There is no server export endpoint. Backups read KV using the local Wrangler login: only someone able to deploy this Worker can back up or restore it.

~~~
npm run backup
npm run backup -- --verify ~/pigeon-backups/pigeon-kv-20260927-031500.json.gz
npm run backup -- --restore <backup_file>
npm run backup -- --restore <backup_file> --apply
~~~

- **Export:** gzipped JSON under \`~/pigeon-backups/\` by default, mode 600, with a SHA-256 checksum. As sensitive as production data; the script refuses repository destinations. \`--prefix\` exports selected prefixes.
- **Verify:** \`--verify\` checks version, count, checksum and record shapes; a one-byte change is detected.
- **Restore:** \`--restore\` defaults to a dry run showing creates, overwrites and expired skips. Only \`--apply\` writes; restore never deletes existing records.
- All operations accept \`--local\` for \`wrangler dev\` KV or \`--persist-to <directory>\` for another local store, allowing rehearsals without production access.
`,
  },
  {
    id: "faq",
    title: "Frequently asked questions",
    md: `
### Notifications are not arriving

- Run the app's [notification diagnostics](#selftest) to locate the failure.
- Allow Pigeon in iOS Settings → Notifications. Focus can suppress alerts; \`level=timeSensitive\` is for important messages, subject to system permissions.
- Check \`delivered\` (devices reached), \`muted\` (silent due to recipient muting/minimum level) and \`quieted\` (channel quiet hours).

### My push address was exposed

Use Change Push URL in channel settings. The old address immediately stops working and returns 410 for 30 days. Update connected services. Assign [sender tokens](#tokens) per source so a later leak needs only one revocation.

### How long can a notification be?

Apple's push limit is 4 KB, roughly 1,100 Chinese characters across title/body. The server truncates excess text, adds a marker and delivers with \`"truncated": true\` in the response.

### Can I use plain HTTP?

No. HTTP push requests return 400 because the address and content could be exposed in transit.

### What does the server store?

Bodies are not normally persisted. Exceptions: temporary storage during repeat reminders, content voluntarily attached to reports, and button labels/replies in 7-day action receipts. See the [privacy policy](/privacy) for the full inventory. The server is [open source](https://github.com/nibedge/pigeon-server), and \`/info\` identifies its deployed commit.

### Can I host the server myself?

You can deploy it for study and auditing. iOS pushes require the app developer's signing credentials, so the official Pigeon app receives pushes from {site}. Use [end-to-end encryption](#e2e) to keep content unreadable to the server.

More questions: [help and support](/support).
`,
  },
];

const EXTRA_STYLE = `
  :root{color-scheme:light dark}
  pre{
    margin:0 0 1rem;background:var(--surface);border:1px solid var(--line);border-radius:8px;
    padding:.8rem 1rem;overflow-x:auto;font:13px/1.65 ui-monospace,"SF Mono",Menlo,Consolas,monospace;color:var(--ink-2);
  }
  .table{overflow-x:auto;margin:0 0 1rem}
  .table table{margin:0}
  td code{overflow-wrap:anywhere}
  .toc{columns:2 12rem;column-gap:1.5rem;margin:0 0 1rem;padding-left:1.3rem;color:var(--ink-2)}
  .toc li{margin-bottom:.3rem;break-inside:avoid}
  section{scroll-margin-top:1rem}
  h2 a.self{color:inherit;text-decoration:none}
  h2 a.self:hover::after{content:" #";color:var(--ink-3)}
`;

export function docsPageEn(host: string): string {
  const site = escapeHtml(host);
  const toc = DOC_SECTIONS_EN.map(
    (section) => `<li><a href="#${escapeHtml(section.id)}">${escapeHtml(section.title)}</a></li>`,
  ).join("\n");
  const body = DOC_SECTIONS_EN.map(
    (section) =>
      `<section id="${escapeHtml(section.id)}">\n<h2><a class="self" href="#${escapeHtml(section.id)}">${escapeHtml(section.title)}</a></h2>\n${renderMarkdown(section.md.replaceAll("{site}", host))}\n</section>`,
  ).join("\n\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Documentation — Pigeon</title>
${pageMeta(host, "/docs", "Pigeon Documentation", "Push parameters, sender tokens, webhook adapters, monitoring, notification actions, receipts, Live Activities, groups, end-to-end encryption, MCP and command-line tools.", "en")}
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>${DOC_STYLE}${EXTRA_STYLE}</style>
</head>
<body>
<div class="wrap">
<h1>Documentation</h1>
<p class="meta">Pigeon · Feature reference updated ${DOCS_UPDATED} · English edition November 10, 2026</p>
<ul class="toc">
${toc}
</ul>
${body}
<footer>Pigeon · ${site} · <a href="/">Home</a> · <a href="/support">Help &amp; support</a> · <a href="/privacy">Privacy policy</a> · <a href="/terms">Terms of use</a></footer>
</div>
</body>
</html>`;
}
