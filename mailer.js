// Shared email sender for Staff Portal tools (Issue Tracker, Supply Requests).
// Railway blocks outbound SMTP below Pro, so both options use HTTPS APIs:
//   Gmail API (preferred): GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN (scope gmail.send), GMAIL_SENDER
//   or Resend:             RESEND_API_KEY (+ optional NOTIFY_FROM)
const crypto = require('crypto');

const useGmail = () => !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN);
const emailConfigured = () => useGmail() || !!process.env.RESEND_API_KEY;
const providerName = () => (useGmail() ? 'Gmail API' : process.env.RESEND_API_KEY ? 'Resend' : 'NOT CONFIGURED');

let gmailToken = { value: '', exp: 0 };
async function gmailAccessToken() {
  if (gmailToken.value && Date.now() < gmailToken.exp - 60000) return gmailToken.value;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GMAIL_CLIENT_ID, client_secret: process.env.GMAIL_CLIENT_SECRET, refresh_token: process.env.GMAIL_REFRESH_TOKEN, grant_type: 'refresh_token' }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error('Gmail token refresh failed: ' + (d.error_description || d.error || r.status));
  gmailToken = { value: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
  return gmailToken.value;
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const encHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + b64(s) + '?=');

function buildMime(to, subject, text, html, fromName) {
  const from = process.env.GMAIL_SENDER ? (fromName || 'Steamoji Staff Portal') + ' <' + process.env.GMAIL_SENDER + '>' : null;
  const head = [...(from ? ['From: ' + encHeader(from)] : []), 'To: ' + to.join(', '), 'Subject: ' + encHeader(subject), 'MIME-Version: 1.0'];
  if (!html) return [...head, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(text)].join('\r\n');
  const bd = 'b_' + crypto.randomBytes(8).toString('hex');
  return [...head, 'Content-Type: multipart/alternative; boundary="' + bd + '"', '',
    '--' + bd, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(text),
    '--' + bd, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(html),
    '--' + bd + '--', ''].join('\r\n');
}

// to: array of addresses. fromName: display name (e.g. "Steamoji Issues").
async function sendEmail(to, subject, text, html, fromName) {
  if (useGmail()) {
    const raw = Buffer.from(buildMime(to, subject, text, html, fromName), 'utf8').toString('base64url');
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + (await gmailAccessToken()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
    if (!r.ok) throw new Error('Gmail ' + r.status + ': ' + (await r.text()).slice(0, 300));
    return;
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.NOTIFY_FROM || (fromName || 'Steamoji Staff Portal') + ' <onboarding@resend.dev>', to, subject, text, ...(html ? { html } : {}) }),
  });
  if (!r.ok) throw new Error('Resend ' + r.status + ': ' + (await r.text()).slice(0, 300));
}

module.exports = { sendEmail, emailConfigured, useGmail, providerName, buildMime };
