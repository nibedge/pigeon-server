import { DOC_STYLE } from "./docstyle";
import { escapeHtml } from "./invite";
import { pageMeta } from "./seo";
import { CONTACT, type Contact } from "./support";
import { contactListEn } from "./support.en";

/** English version of the published terms, with the same commitments and update date. */
export function termsPageEn(host: string, contact: Contact = CONTACT): string {
  const updated = "2026-11-10";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Terms of Use — Pigeon</title>
${pageMeta(host, "/terms", "Terms of Use — Pigeon", "Rules for using Pigeon: prohibited content, group responsibilities, reporting, suspension, and appeals.", "en")}
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>${DOC_STYLE}</style>
</head>
<body>
<div class="wrap">

<h1>Terms of Use</h1>
<p class="meta">Pigeon · Last updated ${updated}</p>

<div class="callout">
  <p>Pigeon delivers messages from your own systems or the App to your phone. We have <strong>zero tolerance</strong> for illegal, pornographic, obscene, harassing, or fraudulent content. Channels with confirmed violations are suspended immediately.</p>
</div>

<h2>Scope</h2>
<p>By using the Pigeon App or the push service at ${escapeHtml(host)}, you agree to these terms. The App also asks you to confirm them before creating a group, converting a channel into a group, generating your first invitation, or joining any group.</p>
<p>If you are under 14, use Pigeon only with the consent of a parent or other guardian.</p>

<h2>Responsibility for content</h2>
<p>The channel creator (group owner) sends content through their own systems or the App. Pigeon does not create, edit, or review this content in advance. Owners are responsible for everything their channels send. Members receive messages by default; if the owner enables “Allow Members to Send Messages”, they can also send messages in the App. Members cannot see the push URL or change channel settings.</p>
<p>Before delivery, plaintext group pushes are checked against a prohibited-word list. Matching content is rejected. This is a minimum level of filtering and does not mean we have reviewed or endorsed other content.</p>

<h2>Prohibited content</h2>
<ul>
  <li>Content that violates laws or regulations</li>
  <li>Pornographic, obscene, or sexually suggestive content</li>
  <li>Violent, terrorist, hateful, or discriminatory content</li>
  <li>Harassment, abuse, or threats against others</li>
  <li>Fraud, spam advertising, or pyramid schemes</li>
  <li>Disclosure of another person's private information without consent</li>
  <li>Malicious links, malware, or phishing pages</li>
</ul>
<p>Inviting someone into a group to harass them, or impersonating another person, is also prohibited.</p>

<h2>Owner controls</h2>
<p>Owners can remove members. When doing so, they can also revoke invitation links and ban the person from rejoining through an invitation. Owners can revoke all invitations at any time. Invitation pages display the owner's display name so invitees can identify the sender.</p>

<h2>Reporting and enforcement</h2>
<p>Group members can report an entire group in the App (group settings → Report This Group), or a specific message (message details → Report This Message). We handle reports within <strong>24 hours</strong>. A channel with a confirmed violation is suspended immediately: its pushes, invitations, and acknowledgments stop working. For serious violations, we suspend all channels belonging to that owner.</p>
<p>The server cannot read end-to-end encrypted messages. Reports involving those messages are reviewed using the message content the reporter chooses to attach.</p>
<p>To prevent abuse of reporting, each account can submit up to 5 reports per hour.</p>

<h2>Blocking</h2>
<p>Members can block an owner at any time. Blocking immediately leaves the group and rejects future invitations from that person. The blocked list is under Settings → Privacy &amp; Security → Blocked, where you can unblock someone at any time.</p>

<h2>Usage limits</h2>
<p>Pushes, registration, opening invitations, acknowledgments, and reports are rate limited to prevent abuse. Requests over the limit are temporarily rejected; try again later. A device may register with at most 3 accounts.</p>

<h2>The service</h2>
<p>Apple ultimately delivers notifications. We make reasonable efforts to ensure delivery, but cannot promise that notifications will never be delayed or lost. Do not use Pigeon as the only alerting channel for matters involving personal safety or substantial financial loss.</p>

<h2>Changes to these terms</h2>
<p>If we make material changes to this page, we will update the date at the top and notify you in the App.</p>

<h2>Contact</h2>
<p>For questions about these terms or an enforcement decision:</p>
${contactListEn(contact)}
<p>See the <a href="/privacy">Privacy Policy</a> for how your data is handled, or <a href="/support">Help &amp; Support</a> for common questions.</p>

<footer>Pigeon · ${escapeHtml(host)} · <a href="/docs">Documentation</a> · <a href="/support">Help &amp; Support</a> · <a href="/privacy">Privacy Policy</a></footer>

</div>
</body>
</html>`;
}
