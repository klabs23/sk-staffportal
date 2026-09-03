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
