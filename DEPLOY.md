# Deploying the Steamoji Staff Portal to Railway

Deploying to `staffportal.steamojikirkland.com` (a subdomain) — this needs
only your Railway account and GoDaddy DNS access, with zero changes to
whatever hosts the main marketing site.

## What this is now

- `public/index.html` — the **Staff Portal landing page**. Passphrase gate,
  then a directory of internal projects (just Free-Time Idea Engine for now,
  built to have more added later).
- `public/freetime/index.html` — the **Free-Time Idea Engine**, unchanged in
  function, but now lives as one project inside the portal instead of
  standing alone.
- `public/auth.js` — the **shared passphrase gate** used by both pages (and
  any future project page). Unlock once on the portal landing page, and
  every project underneath recognizes the same login — no re-entering the
  passphrase per tool.
- `server.js` — unchanged: serves the static files above, proxies live AI
  generation through the `kirkland@steamoji.com` account, and
  backs the shared idea cache with SQLite.

v1 is intentionally simple: one shared passphrase (`OjiKirk2026`), stored as
a SHA-256 hash in `auth.js`, no individual staff accounts. The plan to
replace this with real Google-account sign-in later is a separate, bigger
step — this just gets staff into a real, usable portal today.

## 1. Generate the API key

Log into [console.anthropic.com](https://console.anthropic.com) as
`kirkland@steamoji.com` (create the account if needed). Go to
**Settings → API Keys → Create Key** and copy it.

## 2. Push this folder to a GitHub repo, then deploy on Railway

1. Push `server.js`, `package.json`, and `public/` (with its `freetime/` and
   `auth.js`) to a repo.
2. In Railway: **New Project → Deploy from GitHub repo**.
3. Under **Variables**, add `ANTHROPIC_API_KEY` (from step 1) and, once you
   attach a volume in the next step, `DATA_DIR=/data`.

## 3. Attach a persistent volume

Without this, the shared idea cache resets every time you redeploy.

1. Service → **Settings → Volumes → New Volume**.
2. Mount path: `/data`.
3. Redeploy.

## 4. Mount it at staffportal.steamojikirkland.com

This needs nothing beyond Railway + GoDaddy DNS — no changes to whatever
hosts the main marketing site. The tool's front-end already auto-detects
running at a domain root (no `/staffportal` prefix in the URL), so no code
changes are needed either.

**In Railway:**
1. Open the service → **Settings → Networking → Custom Domain**.
2. Enter `staffportal.steamojikirkland.com`.
3. Railway shows you a CNAME target, something like
   `xxxxx.up.railway.app`. Copy it.

**In GoDaddy:**
1. Go to your domain's **DNS Management** page for `steamojikirkland.com`.
2. Add a new record:
   - Type: `CNAME`
   - Name/Host: `staffportal`
   - Value/Points to: the Railway target from above (e.g.
     `xxxxx.up.railway.app`)
   - TTL: default is fine
3. Save. DNS propagation is usually minutes, occasionally up to a few hours.
4. Back in Railway, the custom domain should flip to a verified/active state
   once DNS resolves, and Railway auto-provisions the SSL certificate — no
   separate action needed for HTTPS.

## 5. Test end to end

- Visit `staffportal.steamojikirkland.com` — passphrase gate should appear
  (`OjiKirk2026`).
- After unlocking, you should see the project directory with a Free-Time
  Idea Engine card.
- Click into it, confirm it opens **without** asking for the passphrase
  again (shared login working).
- Try live generation — should work immediately, no Claude sign-in prompt.
- Generate the same combo twice — second time should show "Saved · No API
  Call."
- Click **🔒 Lock** on the portal page, refresh, confirm both the portal and
  the Free-Time tool ask for the passphrase again (shared logout working).
- Redeploy once and confirm saved ideas survive it (volume check).

## Adding a second project later

Drop a new folder under `public/` (e.g. `public/quizmaker/index.html`),
include `<script src="../auth.js"></script>` in it the same way, and add a
new card to the project grid in `public/index.html`. It'll inherit the same
login automatically.

---

# Issue Tracker (`/issues`)

Staff report problems (with photos); the director gets an email (and optionally
a text) for every new issue and moves it through Submitted → In progress →
Fixed / Not fixing.

**Who can do what**
- Any staff (portal passphrase): report issues, add photos, add details, edit
  title/location/description. Everyone's changes show in the activity log with
  their name.
- Director (`OWNER_KEY`): everything above, plus change status and post progress
  notes. Click **Director sign-in** on the Issue Tracker page and enter the key
  once per device. The server enforces this, so staff can't change status even
  by calling the API directly.

**Storage:** issues live in the same `cache.db` and photos in
`/data/issue-photos/`, both on the existing `/data` volume. Photos are resized to
1600px in the browser before upload (~300 KB each).

## Railway variables to add

| Variable | Value |
|---|---|
| `OWNER_KEY` | A long random secret only SK knows (e.g. 4–5 random words) |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_SENDER` | Send through Gmail (preferred). See "Gmail setup" below |
| `RESEND_API_KEY` | Alternative to Gmail: from resend.com → API Keys |
| `NOTIFY_EMAIL` | `sankethka@metra.io` (comma-separate to add more) |
| `NOTIFY_SMS` | Optional. Carrier email-to-text address, e.g. `4255551234@vtext.com` |
| `NOTIFY_FROM` | Optional until a domain is verified in Resend; then e.g. `Steamoji Issues <issues@steamojikirkland.com>` |
| `PUBLIC_URL` | `https://staffportal.steamojikirkland.com` (default) |

Why Resend instead of SMTP: Railway blocks outbound SMTP on non-Pro plans, so
email goes over Resend's HTTPS API (free tier: 3,000 emails/month).

Until a sending domain is verified in Resend, its test sender can only deliver
to the email address the Resend account was created with, so sign up for Resend
using `sankethka@metra.io`. Verifying `steamojikirkland.com` (adds a few DNS
records in GoDaddy) lifts that limit and is needed for the SMS gateway address.

Startup log confirms config:
`Issue tracker ready. OWNER_KEY set: true. RESEND_API_KEY set: true. NOTIFY_SMS set: false`.
The director view also shows per-issue notification status (e.g. "email sent").

## Gmail setup (one time, ~10 minutes)

Railway blocks SMTP below the Pro plan, so the server uses the Gmail API over
HTTPS instead. Do this signed in as the Gmail account that will *send* the
notifications.

1. console.cloud.google.com → create a project (e.g. "Steamoji Staff Portal").
2. APIs & Services → Library → enable **Gmail API**.
3. APIs & Services → OAuth consent screen. Choose **Internal** if the account is
   Google Workspace; otherwise **External**, add yourself as a test user, then
   click **Publish app**. (An External app left in "Testing" has its refresh
   token expire after 7 days, which silently stops notifications.)
4. Credentials → Create credentials → OAuth client ID → type **Web
   application**, authorized redirect URI
   `https://developers.google.com/oauthplayground`. Copy the client ID and secret.
5. developers.google.com/oauthplayground → gear icon → check "Use your own OAuth
   credentials", paste the ID and secret. In "Input your own scopes" enter
   `https://www.googleapis.com/auth/gmail.send`, Authorize, sign in, then
   "Exchange authorization code for tokens". Copy the **refresh token**.
6. In Railway Variables set `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`,
   `GMAIL_REFRESH_TOKEN`, and `GMAIL_SENDER` (that account's address).

The startup log will then say `Email via: Gmail API`. The `gmail.send` scope
can only send mail; it cannot read the inbox.

---

# Supply Requests (`/supplies`)

Replaces the "Kirkland Materials List" Google Sheet. The form has the sheet's
fields (Item Name, Quantity, Purpose, Facilitator Who Requested, Notes, Status,
with Date Added filled in automatically) plus an optional Amazon link and a
"Search Amazon" button.

- **Status:** staff pick In Need, Low, or Would Be Nice when submitting. Anyone
  can mark a request Completed (the name of whoever did it is recorded). Only
  the director can set Ordered, Not Purchasing, or Return, or post a note to
  staff (director key = the same `OWNER_KEY` used by the Issue Tracker).
- **Need it again:** anything Completed can be put back on the Needed list by
  anyone (with an urgency and optional note), so nobody has to re-create the
  request. It jumps back to the top of the list and SK gets a "Needed again" email.
- **Activity log:** every request, status change, edit, link change, and director
  note is logged with who did it and when. Each request shows its own history;
  "Activity log" on the main page shows everything, newest first. Staff enter
  their name once in the "You:" box at the top (remembered on that device).
- **Bought before:** while staff type the item name, the form shows matching
  past purchases (with links when we have them) and any open request for the
  same thing, so duplicates are obvious. Open requests in the list get a
  "Buy again" button when a past purchase has a link.
- **History:** on first boot the server imports the sheet once from
  `supplies-seed.json` (495 rows, exported 2026-10-06; 48 have Amazon links).
  Saving a purchase link when you mark something Ordered/Completed builds up the
  "buy again" library over time.
- **Email:** every new request emails the same recipients as the Issue Tracker
  (`NOTIFY_EMAIL`, default `sankethka@metra.io`; set `SUPPLY_NOTIFY_EMAIL` to send
  supply requests somewhere else) through the same Gmail/Resend
  setup as the Issue Tracker. The email includes past-purchase links and an
  Amazon search link.

Startup log: `Supply requests ready. Notify: sankethka@metra.io via Gmail API`.
