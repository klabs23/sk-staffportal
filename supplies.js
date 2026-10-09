// Steamoji Staff Portal: Supply Requests API
//
// Replaces the "Kirkland Materials List" Google Sheet. Same fields as the sheet:
//   Status | Date Added | Item Name | Quantity | Purpose | Facilitator Who Requested | Notes
// plus an optional product link (usually Amazon).
//
// Table supply_requests lives in the same SQLite file (cache.db on the /data volume).
// On first boot the sheet's history (supplies-seed.json, exported 2026-10-06) is imported once as
// ARCHIVED rows: hidden from every list, but still used for "bought before" suggestions.
// A one-time clean start (2026-10-06) archived every request that existed then and cleared the
// activity log, so the lists start empty while "bought before" keeps the full history.
//
// Access: staff = x-staff-key (portal passphrase hash); director = x-owner-key (OWNER_KEY env).
// Anyone (staff or director) can create requests, edit the descriptive fields, change urgency, and
// mark a request Received (stored as 'completed'). Only the director sets Ordered / Not Purchasing / Return or posts a director note.
//
// Notifications: every new request emails SUPPLY_NOTIFY_EMAIL, else NOTIFY_EMAIL (same as the Issue Tracker), default sankethka@metra.io,
// using the shared mailer (Gmail API or Resend, same config as the Issue Tracker).

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const mailer = require('./mailer');

const STATUS = {
  in_need: 'In Need',
  low: 'Low',
  would_be_nice: 'Would Be Nice',
  ordered: 'Ordered',
  completed: 'Received',   // stored as 'completed'; shown to staff as Received
  not_purchasing: 'Not Purchasing',
  return: 'Return',
};
const STAFF_STATUSES = ['in_need', 'low', 'would_be_nice'];          // selectable when submitting
const STAFF_SETTABLE = ['in_need', 'low', 'would_be_nice', 'completed']; // any staff can move a request to these
const OPEN_STATUSES = ['in_need', 'low', 'would_be_nice'];
const BOUGHT_STATUSES = ['completed', 'ordered', 'return'];
const DEFAULT_STAFF_HASH = '7a44363b0feda50d6ea2e38a8803ae2473d55a8ef74b79cb87303abee0b5987e';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const clean = (s, max) => String(s == null ? '' : s).trim().slice(0, max);
const today = () => {
  // Studio is in Kirkland, WA; date the request in Pacific time.
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return p; // YYYY-MM-DD
};

// Normalize product links: strip Amazon tracking junk down to /dp/ASIN.
function normalizeLink(raw) {
  const s = clean(raw, 2000);
  if (!s) return '';
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return null;
  const m = u.href.match(/amazon\.[a-z.]+\/(?:[^/?#]+\/)?(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i);
  if (m) return 'https://www.amazon.com/dp/' + m[1].toUpperCase();
  return u.href.slice(0, 1000);
}

// ---- "bought before" matching ----
const STOP = new Set(('a an the and or of for to in on with without from by at as is are be it its this that these those ' +
  'some any more need needed needs new our we us i my please like if possible etc ones one small large big see notes ' +
  'pack packs set sets box boxes bag bags roll rolls x pcs piece pieces count ct size sized kind type general').split(' '));
function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && /(ches|shes|sses|xes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}
function tokens(s) {
  return String(s || '').toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((w) => w && w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w))
    .map(stem);
}
function similarity(qt, item) {
  if (!qt.length) return 0;
  const it = new Set(tokens(item));
  if (!it.size) return 0;
  let hit = 0;
  qt.forEach((w) => {
    if (it.has(w)) hit += 1;
    else if (w.length >= 4 && [...it].some((x) => x.length >= 4 && (x.startsWith(w) || w.startsWith(x)))) hit += 0.7;
  });
  const cover = hit / qt.length;            // how much of the query the item covers
  const prec = hit / Math.max(it.size, 1);  // penalize long unrelated names a little
  return cover * 0.8 + Math.min(prec, 1) * 0.2;
}

module.exports = function mountSupplies(app, db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS supply_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL DEFAULT 'in_need',
      date_added TEXT NOT NULL DEFAULT '',      -- YYYY-MM-DD (sheet "Date Added")
      item_name TEXT NOT NULL,
      quantity TEXT NOT NULL DEFAULT '',
      purpose TEXT NOT NULL DEFAULT '',
      requested_by TEXT NOT NULL DEFAULT '',    -- sheet "Facilitator Who Requested"
      notes TEXT NOT NULL DEFAULT '',
      link TEXT NOT NULL DEFAULT '',            -- product link (usually Amazon)
      director_note TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'portal',    -- portal | sheet
      sheet_row INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      status_changed_at INTEGER,
      status_by TEXT NOT NULL DEFAULT '',     -- who last changed status (e.g. who marked it completed)
      notify_status TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_supply_status ON supply_requests(status);
  `);
  try { db.exec("ALTER TABLE supply_requests ADD COLUMN status_by TEXT NOT NULL DEFAULT ''"); } catch (e) { /* already there */ }
  // archived = 1: kept only as purchase history (powers "bought before"), never shown in lists.
  try { db.exec('ALTER TABLE supply_requests ADD COLUMN archived INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* already there */ }
  db.exec('CREATE TABLE IF NOT EXISTS supply_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  // Activity log: every create / status change / edit, with who did it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS supply_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL,
      kind TEXT NOT NULL,                -- created | status | edit | link | note
      author TEXT NOT NULL DEFAULT '',
      is_owner INTEGER NOT NULL DEFAULT 0,
      from_status TEXT,
      to_status TEXT,
      body TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_supply_events_req ON supply_events(request_id);
  `);
  const logEvent = (e) => db.prepare('INSERT INTO supply_events (request_id, kind, author, is_owner, from_status, to_status, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(e.request_id, e.kind, e.author || '', e.is_owner ? 1 : 0, e.from_status || null, e.to_status || null, e.body || '', e.created_at || Date.now());

  // ---- one-time import of the Google Sheet history ----
  const imported = db.prepare("SELECT COUNT(*) AS n FROM supply_requests WHERE source = 'sheet'").get().n;
  const seedFile = path.join(__dirname, 'supplies-seed.json');
  if (!imported && fs.existsSync(seedFile)) {
    const rows = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
    const ins = db.prepare(`INSERT INTO supply_requests
      (status, date_added, item_name, quantity, purpose, requested_by, notes, link, source, sheet_row, created_at, updated_at, archived)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sheet', ?, ?, ?, 1)`);
    db.transaction(() => {
      rows.forEach((r) => {
        const ts = r.date ? Date.parse(r.date + 'T12:00:00-07:00') : Date.now();
        ins.run(STATUS[r.status] ? r.status : 'completed', r.date || '', r.item_name, r.quantity || '', r.purpose || '',
          r.requested_by || '', r.notes || '', normalizeLink(r.link) || '', r.row || null, ts, ts);
      });
    })();
    console.log(`[supplies] imported ${rows.length} rows from the materials sheet (as purchase history)`);
  }

  // ---- one-time clean start: archive everything so far, clear the activity log ----
  const RESET_KEY = 'clean-start-2026-10-06';
  if (!db.prepare('SELECT value FROM supply_meta WHERE key = ?').get(RESET_KEY)) {
    db.transaction(() => {
      const n = db.prepare('UPDATE supply_requests SET archived = 1 WHERE archived = 0').run().changes;
      db.prepare('DELETE FROM supply_events').run();
      db.prepare('INSERT INTO supply_meta (key, value) VALUES (?, ?)').run(RESET_KEY, String(Date.now()));
      console.log(`[supplies] clean start: archived ${n} existing requests and cleared the activity log`);
    })();
  }

  const staffHash = process.env.STAFF_KEY_HASH || DEFAULT_STAFF_HASH;
  const isOwner = (req) => !!process.env.OWNER_KEY && !!req.get('x-owner-key') && safeEq(req.get('x-owner-key'), process.env.OWNER_KEY);
  function requireStaff(req, res, next) {
    const k = req.get('x-staff-key') || '';
    if (isOwner(req) || (k && safeEq(k, staffHash))) return next();
    res.status(401).json({ error: 'Not signed in to the staff portal.' });
  }

  // Past requests matching a name. Returns { bought: [...], open: [...] }.
  //   bought: previously ordered/completed, best match first; links first so they're one click to re-buy
  //   open:   currently open requests for the same thing (duplicate warning)
  function findSimilar(q, excludeId) {
    const qt = [...new Set(tokens(q))];
    if (!qt.length) return { bought: [], open: [] };
    const all = db.prepare('SELECT id, status, date_added, item_name, quantity, requested_by, link, notes, archived FROM supply_requests WHERE id != ?').all(excludeId || 0);
    const threshold = qt.length === 1 ? 0.75 : 0.65;
    const scored = all.map((r) => ({ r, s: similarity(qt, r.item_name) })).filter((x) => x.s >= threshold);
    const byScore = (a, b) => (b.s - a.s) || ((b.r.link ? 1 : 0) - (a.r.link ? 1 : 0)) || (b.r.date_added || '').localeCompare(a.r.date_added || '');
    const bought = scored.filter((x) => BOUGHT_STATUSES.includes(x.r.status)).sort(byScore);
    // Collapse repeat purchases of the same item name into one entry with a count.
    const groups = new Map();
    bought.forEach(({ r, s }) => {
      const key = tokens(r.item_name).sort().join(' ') || r.item_name.toLowerCase();
      const g = groups.get(key);
      if (!g) groups.set(key, { ...r, score: Math.round(s * 100) / 100, times: 1, last_date: r.date_added, links: r.link ? [r.link] : [] });
      else {
        g.times += 1;
        if (r.date_added > g.last_date) g.last_date = r.date_added;
        if (r.link && !g.links.includes(r.link)) g.links.push(r.link);
        if (!g.link && r.link) g.link = r.link;
      }
    });
    // Duplicate warning: open requests, plus anything marked Ordered in the last 45 days (older "Ordered" rows are stale sheet history).
    const recent = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
    const open = scored.filter((x) => !x.r.archived && (OPEN_STATUSES.includes(x.r.status) || (x.r.status === 'ordered' && x.r.date_added >= recent)))
      .sort(byScore).slice(0, 3).map(({ r }) => ({ id: r.id, status: r.status, date_added: r.date_added, item_name: r.item_name, requested_by: r.requested_by }));
    const out = [...groups.values()].sort((a, b) => (b.score - a.score) || ((b.link ? 1 : 0) - (a.link ? 1 : 0)) || b.last_date.localeCompare(a.last_date))
      .slice(0, 5).map((g) => ({ id: g.id, item_name: g.item_name, status: g.status, last_date: g.last_date, times: g.times, link: g.link, links: g.links.slice(0, 3), quantity: g.quantity }));
    return { bought: out, open };
  }

  const amazonSearch = (q) => 'https://www.amazon.com/s?k=' + encodeURIComponent(q);

  // ---- routes ----
  app.get('/api/supplies', requireStaff, (req, res) => {
    const rows = db.prepare(`SELECT id, status, date_added, item_name, quantity, purpose, requested_by, notes, link, director_note, source, created_at, updated_at
      FROM supply_requests WHERE archived = 0 ORDER BY date_added DESC, id DESC`).all();
    // For open requests without their own link, attach the best "bought before" link so it's one click to buy.
    rows.forEach((r) => {
      if (OPEN_STATUSES.includes(r.status) && !r.link) {
        const s = findSimilar(r.item_name, r.id).bought.find((b) => b.link);
        if (s) r.prev_link = s.link, r.prev_date = s.last_date, r.prev_name = s.item_name;
      }
    });
    res.json({ requests: rows, owner: isOwner(req), statuses: STATUS });
  });

  app.get('/api/supplies/similar', requireStaff, (req, res) => {
    res.json({ ...findSimilar(clean(req.query.q, 300), Number(req.query.exclude) || 0), amazon_search: amazonSearch(clean(req.query.q, 300)) });
  });

  // Recent activity across all requests (newest first).
  app.get('/api/supplies/activity', requireStaff, (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const events = db.prepare('SELECT * FROM supply_events ORDER BY id DESC LIMIT ?').all(limit);
    const nameOf = db.prepare('SELECT item_name FROM supply_requests WHERE id = ?');
    events.forEach((e) => { const r = nameOf.get(e.request_id); e.item_name = r ? r.item_name : '(deleted)'; });
    res.json({ events, owner: isOwner(req), statuses: STATUS });
  });

  app.get('/api/supplies/:id', requireStaff, (req, res) => {
    const r = db.prepare('SELECT * FROM supply_requests WHERE id = ?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'Request not found' });
    const events = db.prepare('SELECT * FROM supply_events WHERE request_id = ? ORDER BY created_at, id').all(r.id);
    res.json({ request: r, events, similar: findSimilar(r.item_name, r.id), amazon_search: amazonSearch(r.item_name), owner: isOwner(req), statuses: STATUS });
  });

  app.post('/api/supplies', requireStaff, (req, res) => {
    const b = req.body || {};
    const item = clean(b.item_name, 300), by = clean(b.requested_by, 60);
    if (!item) return res.status(400).json({ error: 'Item name is required.' });
    if (!by) return res.status(400).json({ error: 'Your name is required.' });
    const status = STAFF_STATUSES.includes(b.status) ? b.status : 'in_need';
    const link = normalizeLink(b.link);
    if (link === null) return res.status(400).json({ error: "That link doesn't look like a web address." });
    const now = Date.now();
    const info = db.prepare(`INSERT INTO supply_requests (status, date_added, item_name, quantity, purpose, requested_by, notes, link, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'portal', ?, ?)`)
      .run(status, today(), item, clean(b.quantity, 80), clean(b.purpose, 200), by, clean(b.notes, 5000), link, now, now);
    const id = info.lastInsertRowid;
    logEvent({ request_id: id, kind: 'created', author: by, is_owner: isOwner(req), to_status: status, created_at: now });
    res.json({ ok: true, id });
    const r = db.prepare('SELECT * FROM supply_requests WHERE id = ?').get(id);
    notifyNew(r).catch((e) => console.error('[supplies] notify error', e));
  });

  // Anyone: edit descriptive fields, change urgency, mark Received, or put a Received item back to Needed.
  // Director only: Ordered / Not Purchasing / Return and the director note. Every change is logged with who made it.
  app.patch('/api/supplies/:id', requireStaff, (req, res) => {
    const r = db.prepare('SELECT * FROM supply_requests WHERE id = ?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'Request not found' });
    const owner = isOwner(req), b = req.body || {};
    const author = clean(b.author, 60) || (owner ? 'Director' : '');
    if (!author) return res.status(400).json({ error: 'Add your name first so the log shows who made the change.' });
    const next = { ...r };
    const set = (k, max) => { if (b[k] !== undefined) next[k] = clean(b[k], max); };
    set('item_name', 300); set('quantity', 80); set('purpose', 200); set('requested_by', 60); set('notes', 5000);
    if (b.link !== undefined) {
      const l = normalizeLink(b.link);
      if (l === null) return res.status(400).json({ error: "That link doesn't look like a web address." });
      next.link = l;
    }
    if (b.status !== undefined && b.status !== r.status) {
      if (!STATUS[b.status]) return res.status(400).json({ error: 'Unknown status.' });
      if (!owner && !STAFF_SETTABLE.includes(b.status))
        return res.status(403).json({ error: 'Only the director can mark items ordered, not purchasing, or return.' });
      next.status = b.status;
      next.status_changed_at = Date.now();
      next.status_by = author;
    }
    if (b.director_note !== undefined) {
      if (!owner) return res.status(403).json({ error: 'Only the director can add a director note.' });
      next.director_note = clean(b.director_note, 2000);
    }
    if (!next.item_name) return res.status(400).json({ error: 'Item name cannot be empty.' });
    const now = Date.now();
    next.updated_at = now;
    const statusChanged = next.status !== r.status;
    const reopened = statusChanged && OPEN_STATUSES.includes(next.status) && !OPEN_STATUSES.includes(r.status);
    if (reopened) next.date_added = today(); // needed again: it goes back to the top of the Needed list
    const LABELS = { item_name: 'item name', quantity: 'quantity', purpose: 'purpose', requested_by: 'requested by', notes: 'notes' };
    const edited = Object.keys(LABELS).filter((k) => next[k] !== r[k]);
    if (!statusChanged && !edited.length && next.link === r.link && next.director_note === r.director_note) return res.json({ ok: true, unchanged: true });
    db.transaction(() => {
      db.prepare(`UPDATE supply_requests SET status=?, item_name=?, quantity=?, purpose=?, requested_by=?, notes=?, link=?, director_note=?, updated_at=?, status_changed_at=?, status_by=?, date_added=? WHERE id=?`)
        .run(next.status, next.item_name, next.quantity, next.purpose, next.requested_by, next.notes, next.link, next.director_note, next.updated_at, next.status_changed_at, next.status_by || '', next.date_added, r.id);
      if (reopened && r.archived) db.prepare('UPDATE supply_requests SET archived = 0 WHERE id = ?').run(r.id);
      const ev = { request_id: r.id, author, is_owner: owner, created_at: now };
      if (statusChanged) logEvent({ ...ev, kind: 'status', from_status: r.status, to_status: next.status, body: clean(b.reason, 500) });
      if (edited.length) logEvent({ ...ev, kind: 'edit', body: 'Edited ' + edited.map((k) => LABELS[k]).join(', ') });
      if (next.link !== r.link) logEvent({ ...ev, kind: 'link', body: next.link ? next.link : 'Removed the link' });
      if (next.director_note !== r.director_note) logEvent({ ...ev, kind: 'note', body: next.director_note || '(cleared the note)' });
    })();
    res.json({ ok: true });
    if (reopened) notifyNew(db.prepare('SELECT * FROM supply_requests WHERE id = ?').get(r.id), { reopenedBy: author, reason: clean(b.reason, 500) })
      .catch((e) => console.error('[supplies] notify error', e));
  });

  // ---- email on new request ----
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const fmtDate = (d) => { if (!d) return ''; const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };
  async function notifyNew(r, reopen) {
    const setNotify = (s) => db.prepare('UPDATE supply_requests SET notify_status = ? WHERE id = ?').run(s, r.id);
    if (!mailer.emailConfigured()) { setNotify('not sent: email not configured'); console.warn('[supplies] email not configured; skipping'); return; }
    const to = String(process.env.SUPPLY_NOTIFY_EMAIL || process.env.NOTIFY_EMAIL || 'sankethka@metra.io').split(',').map((x) => x.trim()).filter(Boolean);
    const base = (process.env.PUBLIC_URL || 'https://staffportal.steamojikirkland.com').replace(/\/$/, '');
    const open = base + '/supplies/#' + r.id;
    const sim = findSimilar(r.item_name, r.id);
    const prev = sim.bought.slice(0, 3);
    const label = STATUS[r.status];
    const buyUrl = r.link || (prev.find((p) => p.link) || {}).link || '';
    const searchUrl = amazonSearch(r.item_name);

    const fields = [['Status', label], ['Item', r.item_name], ['Quantity', r.quantity], ['Purpose', r.purpose], ['Requested by', r.requested_by], ['Notes', r.notes], ['Link', r.link]];
    const headline = reopen ? `Needed again #${r.id}: ${r.item_name} (${label}), marked by ${reopen.reopenedBy}` : `New supply request #${r.id}: ${r.item_name} (${label})`;
    const text = [headline, ...(reopen && reopen.reason ? ['Why: ' + reopen.reason] : []), '',
      ...fields.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`), '',
      prev.length ? 'Bought before:\n' + prev.map((p) => `- ${p.item_name} (last ${fmtDate(p.last_date)}${p.times > 1 ? ', ' + p.times + ' times' : ''})${p.link ? ' ' + p.link : ''}`).join('\n') : 'Not found in past purchases.',
      '', `Search Amazon: ${searchUrl}`, `Open in portal: ${open}`].join('\n');

    const urgColor = { in_need: '#D9452B', low: '#C97A12', would_be_nice: '#2B8A9C' }[r.status] || '#555';
    const row = (k, v) => v ? `<tr><td style="padding:4px 14px 4px 0;color:#666;vertical-align:top;white-space:nowrap">${k}</td><td style="padding:4px 0;white-space:pre-wrap">${esc(v)}</td></tr>` : '';
    const btn = (href, txt, primary) => `<a href="${esc(href)}" style="display:inline-block;margin:0 8px 8px 0;background:${primary ? '#F5A93F' : '#fff'};color:#0B2338;border:1px solid ${primary ? '#F5A93F' : '#ccd'};padding:9px 14px;text-decoration:none;font-weight:700;border-radius:3px">${txt}</a>`;
    const prevHtml = prev.length
      ? `<p style="margin:18px 0 6px;font-weight:700">Bought before</p><ul style="margin:0;padding-left:18px">` + prev.map((p) =>
        `<li style="margin-bottom:4px">${esc(p.item_name)} <span style="color:#666">· last ${esc(fmtDate(p.last_date))}${p.times > 1 ? ' · ' + p.times + '×' : ''}</span>${p.link ? ` · <a href="${esc(p.link)}">buy again</a>` : ''}</li>`).join('') + '</ul>'
      : `<p style="margin:18px 0 0;color:#666">Not found in past purchases.</p>`;
    const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#111">
      <p style="margin:0 0 4px;color:#666;font-size:12px">STEAMOJI KIRKLAND · ${reopen ? 'NEEDED AGAIN' : 'SUPPLY REQUEST'} #${r.id}</p>
      <h2 style="margin:0 0 6px">${esc(r.item_name)}</h2>
      <p style="margin:0 0 12px"><span style="color:${urgColor};font-weight:700">● ${esc(label)}</span> · ${reopen ? `marked needed again by <b>${esc(reopen.reopenedBy)}</b> (originally requested by ${esc(r.requested_by || 'unknown')})` : `requested by <b>${esc(r.requested_by)}</b>`}</p>${reopen && reopen.reason ? `<p style="margin:0 0 12px">Why: ${esc(reopen.reason)}</p>` : ''}
      <table style="border-collapse:collapse;font-size:14px;margin-bottom:14px">${row('Quantity', r.quantity)}${row('Purpose', r.purpose)}${row('Notes', r.notes)}${r.link ? `<tr><td style="padding:4px 14px 4px 0;color:#666">Link</td><td><a href="${esc(r.link)}">${esc(r.link)}</a></td></tr>` : ''}</table>
      ${buyUrl ? btn(buyUrl, r.link ? 'Open product link' : 'Buy again (past link)', true) : ''}${btn(searchUrl, 'Search Amazon', !buyUrl)}${btn(open, 'Open in portal', false)}
      ${prevHtml}</div>`;
    try {
      await mailer.sendEmail(to, `[Steamoji] ${reopen ? 'Needed again' : 'Supply request'}: ${r.item_name.slice(0, 80)} (${label})`, text, html, 'Steamoji Supplies');
      setNotify('email sent');
    } catch (e) { setNotify('email failed'); console.error('[supplies] email failed', e.message); }
  }

  console.log(`Supply requests ready. Notify: ${process.env.SUPPLY_NOTIFY_EMAIL || process.env.NOTIFY_EMAIL || 'sankethka@metra.io'} via ${mailer.providerName()}`);
};

module.exports._test = { tokens, similarity, normalizeLink };
