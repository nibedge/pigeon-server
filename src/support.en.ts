import { DOC_STYLE } from "./docstyle";
import { escapeHtml } from "./invite";
import { pageMeta } from "./seo";
import { CONTACT, ISSUES_URL, SOURCE_URL, type Contact } from "./support";

/** Keep contact details shared with the Chinese pages; never infer an operator's identity. */
export function contactListEn(contact: Contact = CONTACT): string {
  const items: string[] = [];
  if (contact.email) {
    const email = escapeHtml(contact.email);
    items.push(
      `<li><strong>Private support:</strong> <a href="mailto:${email}">${email}</a>. Use email to appeal a group suspension, request a copy of your data, or ask about your personal circumstances.</li>`,
    );
  }
  items.push(
    `<li><strong>Report prohibited content:</strong> report it in the App (see <a href="/support#report">how to report</a>). Only we can see the report.</li>`,
    `<li><strong>Public questions:</strong> open an issue in the <a href="${ISSUES_URL}">source repository</a>. Issues are public: do not post push URLs, encryption keys, pairing codes, or invitation links.</li>`,
  );
  return `<ul>\n  ${items.join("\n  ")}\n</ul>`;
}

/** English version of support.ts, with the same update date and UI labels. */
export function supportPageEn(host: string, contact: Contact = CONTACT): string {
  const updated = "2026-11-10";
  const site = escapeHtml(host);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Help &amp; Support — Pigeon</title>
${pageMeta(host, "/support", "Help & Support — Pigeon", "Help with notifications, exposed push URLs, device changes, content reports, and account deletion. Contact Pigeon support.", "en")}
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>${DOC_STYLE}</style>
</head>
<body>
<div class="wrap">

<h1>Help &amp; Support</h1>
<p class="meta">Pigeon · Last updated ${updated}</p>

<div class="callout">
  <p><strong>Most tasks are available in the App:</strong> report content from message details or group settings; find blocking controls and contact details under Settings → Privacy &amp; Security; delete your account under Settings → Account. Browse the questions below, or <a href="#contact">contact us</a> if you need help.</p>
</div>

<h2>Frequently asked questions</h2>

<h3>I am not receiving notifications</h3>
<ul>
  <li>Open the channel's settings in the App and send a test message to check whether this phone receives it.</li>
  <li>Allow notifications in iOS Settings → Notifications → Pigeon. A Focus mode may also silence them.</li>
  <li>If you have muted the channel, or the group owner's quiet hours are active, messages still arrive silently without waking the screen. They remain visible in Notification Center and your history.</li>
  <li>Senders can check the push response: <code>delivered</code> is the number of devices delivered to, and <code>muted</code> is the number of those deliveries that were silent.</li>
</ul>

<h3>My curl request fails or the content looks wrong</h3>
<p>If your content contains spaces or characters such as <code>&amp;</code>, <code>#</code>, <code>+</code>, or <code>%</code>, use <code>--data-urlencode</code> or send JSON instead of putting the text directly in the URL:</p>
<p><code>curl https://${site}/{key} --data-urlencode "title=Backup complete" --data-urlencode "body=Tonight's backup succeeded"</code></p>

<h3>My push URL has been exposed</h3>
<p>Open the channel settings and choose “Change Push URL”. The old URL stops working immediately. Update any services that use it with the new URL.</p>

<h3>I have a new phone, or want notifications on several devices</h3>
<p>For a new device using the same Apple ID, enable iCloud Keychain, install Pigeon, and tap “Continue”. Your account and encryption master key transfer automatically. For a device using another Apple ID, open Settings → My Devices → Use on Another Device, then scan the code with the new device.</p>

<h3>An encrypted message shows “🔒” instead of opening</h3>
<p>This device does not yet have the channel key. For your own channel, use the same iCloud Keychain as the device that created the channel, or pair the devices by scanning the code. For an encrypted group, join using the owner's complete invitation link. The group key is in the link; entering only the invitation code does not provide it.</p>

<h3>Can group members send messages?</h3>
<p>Members receive messages by default. If the owner enables “Allow Members to Send Messages”, members can also send messages in the App. They still cannot see the push URL or change channel settings. The owner remains responsible for the channel's content.</p>

<h3>How do I stop repeated reminders?</h3>
<p>Tap “Got it, stop reminding” or “I'm on it” on the notification. Alternatively, send <code>status=resolved</code> with the same id, for example: <code>curl https://${site}/{key} -d id=db-01 -d status=resolved --data-urlencode "body=Recovered"</code>. Reminders stop after at most one hour.</p>

<h3>Are pushes rate limited?</h3>
<p>Yes. To keep runaway scripts from flooding your notifications, each channel accepts approximately 60 messages per minute. Excess requests receive <code>429</code>; try again after a minute.</p>

<h3>Can I host my own server?</h3>
<p>The server is <a href="${SOURCE_URL}">open source</a> and can be deployed for research or auditing. However, iOS pushes must be signed with the App developer's key. The official Pigeon App only receives pushes from ${site}; a server deployed by someone else cannot push to it. Use end-to-end encryption if you do not want the server to see your content.</p>

<h2 id="report">Report prohibited content</h2>
<ul>
  <li>To report a message, open its details and tap “Report This Message”.</li>
  <li>To report an entire group, open its settings and tap “Report This Group”.</li>
  <li>You can choose to include that message's content. The server cannot read end-to-end encrypted messages, so any content you attach is the evidence we can review.</li>
  <li>Only we can see reports. The owner and other members do not learn who reported them. We handle reports within <strong>24 hours</strong> and immediately suspend channels with confirmed violations.</li>
  <li>To stop someone's messages and invitations, tap “Block Owner” in the group's settings; you leave the group immediately. Unblock them under Settings → Privacy &amp; Security → Blocked.</li>
</ul>

<h2 id="delete">Delete your account and data</h2>
<ul>
  <li><strong>Delete your entire account:</strong> open Settings → Account → Delete Account. Your server-side account, device push tokens, channels you created (including memberships and invitations), and your name in other people's groups are deleted immediately. History on this device is also cleared. This cannot be undone.</li>
  <li><strong>Remove just one device:</strong> swipe left on that device under Settings → My Devices.</li>
  <li><strong>Before uninstalling the App,</strong> delete your account or remove this device in Settings. Uninstalling alone does not immediately remove the server-side push token; the server must first learn that delivery has failed. See the <a href="/privacy">Privacy Policy</a> for the full removal process.</li>
  <li><strong>Lost your phone or cannot access your account?</strong> Open Pigeon on another device with the same Apple ID, then remove the lost device under Settings → My Devices, or delete the account. If neither is possible, <a href="#contact">contact us</a>.</li>
  <li>Reports are retained after account deletion and expire automatically after 90 days. See the <a href="/privacy">Privacy Policy</a> for other records that expire automatically.</li>
</ul>

<h2 id="contact">Contact us</h2>
${contactListEn(contact)}

<footer>Pigeon · ${site} · <a href="/docs">Documentation</a> · <a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms of Use</a></footer>

</div>
</body>
</html>`;
}
