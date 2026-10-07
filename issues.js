// Steamoji Staff Portal: Issue Tracker API
//
// Tables (in the same SQLite file as the idea cache, on the /data volume):
//   issues        one row per ticket
//   issue_events  timeline: created, staff details, edits, owner progress notes, status changes
//   issue_photos  photo files stored under DATA_DIR/issue-photos
//
// Access:
//   Staff  -> header x-staff-key = the portal passphrase hash (same deterrent level as the portal gate)
//   Owner  -> header x-owner-key = OWNER_KEY env var (a real server-side secret). Required for status changes.
//
// Notifications (new issue only). Railway blocks outbound SMTP below Pro, so both options use HTTPS APIs:
//   Gmail API (preferred): GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN (scope gmail.send), GMAIL_SENDER (the account's address)
//   or Resend:             RESEND_API_KEY
//   NOTIFY_EMAIL     comma-separated, full email with details     (default sankethka@metra.io)
//   NOTIFY_SMS       comma-separated carrier SMS gateway addresses, short text-only message (optional)
//   NOTIFY_FROM      sender, e.g. "Steamoji Issues <issues@steamojikirkland.com>" (default onboarding@resend.dev)
//   PUBLIC_URL       link base used in messages (default https://staffportal.steamojikirkland.com)

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const mailer = require('./mailer');

const STATUSES = ['submitted', 'in_progress', 'fixed', 'not_fixing'];
const STATUS_LABEL = { submitted: 'Submitted', in_progress: 'In progress', fixed: 'Fixed', not_fixing: 'Not fixing' };
const DEFAULT_STAFF_HASH = '660189a4d1892274af66d02c3e17626f126d0f114fecd3b10da89fb2170a8a53';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const clean = (s, max) => String(s == null ? '' : s).trim().slice(0, max);

module.exports = function mountIssues(app, db, DATA_DIR) {
  const PHOTO_DIR = path.join(DATA_DIR, 'issue-photos');
  fs.mkdirSync(PHOTO_DIR, { recursive: true });

  db.exec(`
    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'submitted',
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      notify_status TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS issue_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL REFERENCES issues(id),
      kind TEXT NOT NULL,              -- created | detail | edit | progress | status
      author TEXT NOT NULL,
      is_owner INTEGER NOT NULL DEFAULT 0,
      body TEXT NOT NULL DEFAULT '',
      from_status TEXT,
      to_status TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS issue_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL REFERENCES issues(id),
      event_id INTEGER REFERENCES issue_events(id),
      file TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_issue ON issue_events(issue_id);
    CREATE INDEX IF NOT EXISTS idx_photos_issue ON issue_photos(issue_id);
  `);

  // --- auth helpers ---
  const staffHash = process.env.STAFF_KEY_HASH || DEFAULT_STAFF_HASH;
  const isOwner = (req) => !!process.env.OWNER_KEY && !!req.get('x-owner-key') && safeEq(req.get('x-owner-key'), process.env.OWNER_KEY);
  function requireStaff(req, res, next) {
    const k = req.get('x-staff-key') || '';
    if (isOwner(req) || (k && safeEq(k, staffHash))) return next();
    res.status(401).json({ error: 'Not signed in to the staff portal.' });
  }

  // --- photo upload handling ---
  const upload = multer({
    storage: multer.diskStorage({
      destination: PHOTO_DIR,
      filename: (req, file, cb) => {
        const ext = ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/heic': '.heic', 'image/heif': '.heif' })[file.mimetype] || '.img';
        cb(null, crypto.randomBytes(16).toString('hex') + ext);
      },
    }),
    limits: { fileSize: 15 * 1024 * 1024, files: 8 },
    fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
  });
  const withPhotos = (req, res, next) => upload.array('photos', 8)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'A photo was larger than 15 MB.' : err.code === 'LIMIT_FILE_COUNT' ? 'Max 8 photos at a time.' : String(err.message || err) });
    next();
  });
  const savePhotos = (files, issueId, eventId, now) => {
    const ins = db.prepare('INSERT INTO issue_photos (issue_id, event_id, file, created_at) VALUES (?, ?, ?, ?)');
    (files || []).forEach((f) => ins.run(issueId, eventId, f.filename, now));
  };

  // Photos: filenames are 128-bit random, so <img> tags can load them without headers.
  app.get('/api/issues/photo/:file', (req, res) => {
    if (!/^[a-f0-9]{32}\.[a-z]{3,4}$/.test(req.params.file)) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.sendFile(path.join(PHOTO_DIR, req.params.file), (err) => { if (err && !res.headersSent) res.status(404).end(); });
  });

  app.get('/api/issues/owner-check', (req, res) => {
    if (!process.env.OWNER_KEY) return res.status(503).json({ ok: false, error: 'OWNER_KEY is not set on the server yet.' });
    res.status(isOwner(req) ? 200 : 401).json({ ok: isOwner(req) });
  });

  // --- list ---
  app.get('/api/issues', requireStaff, (req, res) => {
    const rows = db.prepare(`
      SELECT i.*,
        (SELECT COUNT(*) FROM issue_photos p WHERE p.issue_id = i.id) AS photo_count,
        (SELECT COUNT(*) FROM issue_events e WHERE e.issue_id = i.id AND e.kind != 'created') AS update_count,
        (SELECT file FROM issue_photos p WHERE p.issue_id = i.id ORDER BY p.id LIMIT 1) AS thumb
      FROM issues i ORDER BY i.updated_at DESC`).all();
    res.json({ issues: rows, owner: isOwner(req) });
  });

  // --- detail ---
  app.get('/api/issues/:id', requireStaff, (req, res) => {
    const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(req.params.id);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });
    const events = db.prepare('SELECT * FROM issue_events WHERE issue_id = ? ORDER BY created_at, id').all(issue.id);
    const photos = db.prepare('SELECT id, event_id, file, created_at FROM issue_photos WHERE issue_id = ? ORDER BY id').all(issue.id);
    res.json({ issue, events, photos, owner: isOwner(req) });
  });

  // --- create (multipart: title, description, location, author, photos[]) ---
  app.post('/api/issues', requireStaff, withPhotos, (req, res) => {
    const b = req.body || {};
    const title = clean(b.title, 140), author = clean(b.author, 60);
    if (!title || !author) return res.status(400).json({ error: 'Title and your name are required.' });
    const now = Date.now();
    const tx = db.transaction(() => {
      const info = db.prepare('INSERT INTO issues (title, description, location, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(title, clean(b.description, 5000), clean(b.location, 80), 'submitted', author, now, now);
      const id = info.lastInsertRowid;
      const ev = db.prepare('INSERT INTO issue_events (issue_id, kind, author, is_owner, body, to_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, 'created', author, isOwner(req) ? 1 : 0, '', 'submitted', now);
      savePhotos(req.files, id, ev.lastInsertRowid, now);
      return id;
    });
    const id = tx();
    const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
    res.json({ ok: true, id });
    notifyNewIssue(issue, (req.files || []).length).catch((e) => console.error('[issues] notify error', e));
  });

  // --- edit title / description / location (any staff) ---
  app.patch('/api/issues/:id', requireStaff, (req, res) => {
    const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(req.params.id);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });
    const b = req.body || {};
    const author = clean(b.author, 60);
    if (!author) return res.status(400).json({ error: 'Your name is required.' });
    const next = {
      title: b.title !== undefined ? clean(b.title, 140) : issue.title,
      description: b.description !== undefined ? clean(b.description, 5000) : issue.description,
      location: b.location !== undefined ? clean(b.location, 80) : issue.location,
    };
    if (!next.title) return res.status(400).json({ error: 'Title cannot be empty.' });
    const changed = Object.keys(next).filter((k) => next[k] !== issue[k]);
    if (!changed.length) return res.json({ ok: true, unchanged: true });
    const now = Date.now();
    db.transaction(() => {
      db.prepare('UPDATE issues SET title = ?, description = ?, location = ?, updated_at = ? WHERE id = ?')
        .run(next.title, next.description, next.location, now, issue.id);
      db.prepare('INSERT INTO issue_events (issue_id, kind, author, is_owner, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(issue.id, 'edit', author, isOwner(req) ? 1 : 0, 'Edited ' + changed.join(', '), now);
    })();
    res.json({ ok: true });
  });

  // --- add an update (multipart: author, body, status?, photos[]) ---
  // Staff: adds details/photos. Owner: same, plus status change; owner notes are shown as progress notes.
  app.post('/api/issues/:id/updates', requireStaff, withPhotos, (req, res) => {
    const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(req.params.id);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });
    const b = req.body || {};
    const owner = isOwner(req);
    const author = clean(b.author, 60), body = clean(b.body, 5000);
    const status = clean(b.status, 20);
    const files = req.files || [];
    if (!author) return res.status(400).json({ error: 'Your name is required.' });
    if (status && !STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status.' });
    if (status && status !== issue.status && !owner) return res.status(403).json({ error: 'Only the director can change status.' });
    const statusChange = status && status !== issue.status;
    if (!body && !files.length && !statusChange) return res.status(400).json({ error: 'Add a note, a photo, or a status change.' });
    const now = Date.now();
    db.transaction(() => {
      let eventId;
      if (statusChange) {
        const ev = db.prepare('INSERT INTO issue_events (issue_id, kind, author, is_owner, body, from_status, to_status, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)')
          .run(issue.id, 'status', author, body, issue.status, status, now);
        eventId = ev.lastInsertRowid;
        db.prepare('UPDATE issues SET status = ?, updated_at = ? WHERE id = ?').run(status, now, issue.id);
      } else {
        const ev = db.prepare('INSERT INTO issue_events (issue_id, kind, author, is_owner, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(issue.id, owner ? 'progress' : 'detail', author, owner ? 1 : 0, body, now);
        eventId = ev.lastInsertRowid;
        db.prepare('UPDATE issues SET updated_at = ? WHERE id = ?').run(now, issue.id);
      }
      savePhotos(files, issue.id, eventId, now);
    })();
    res.json({ ok: true });
  });

  // --- notifications ---
  const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
  const sendEmail = (to, subject, text, html) => mailer.sendEmail(to, subject, text, html, 'Steamoji Issues');
  const { emailConfigured, useGmail } = mailer;
  async function notifyNewIssue(issue, photoCount) {
    const setNotify = (s) => db.prepare('UPDATE issues SET notify_status = ? WHERE id = ?').run(s, issue.id);
    if (!emailConfigured()) { setNotify('not sent: email not configured'); console.warn('[issues] no GMAIL_* or RESEND_API_KEY set; skipping notification'); return; }
    const base = (process.env.PUBLIC_URL || 'https://staffportal.steamojikirkland.com').replace(/\/$/, '');
    const link = base + '/issues/#' + issue.id;
    const emails = list(process.env.NOTIFY_EMAIL || 'sankethka@metra.io');
    const sms = list(process.env.NOTIFY_SMS);
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const results = [];
    if (emails.length) {
      const text = `New issue #${issue.id}: ${issue.title}\nReported by: ${issue.created_by}${issue.location ? '\nWhere: ' + issue.location : ''}\nPhotos: ${photoCount}\n\n${issue.description || '(no description)'}\n\nOpen: ${link}`;
      const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5"><p style="margin:0 0 4px;color:#666;font-size:12px">STEAMOJI KIRKLAND · NEW ISSUE #${issue.id}</p><h2 style="margin:0 0 10px">${esc(issue.title)}</h2><p style="margin:0 0 10px;color:#444">Reported by <b>${esc(issue.created_by)}</b>${issue.location ? ' · ' + esc(issue.location) : ''} · ${photoCount} photo${photoCount === 1 ? '' : 's'}</p><p style="white-space:pre-wrap;margin:0 0 16px">${esc(issue.description || '(no description)')}</p><a href="${link}" style="background:#F5A93F;color:#0B2338;padding:10px 16px;text-decoration:none;font-weight:700;border-radius:3px">Open issue</a></div>`;
      try { await sendEmail(emails, `[Steamoji] New issue #${issue.id}: ${issue.title}`, text, html); results.push('email sent'); }
      catch (e) { results.push('email failed'); console.error('[issues] email failed', e.message); }
    }
    if (sms.length) {
      // Carrier gateways truncate long messages; keep it short and plain text.
      const text = `Steamoji issue #${issue.id} from ${issue.created_by}: ${issue.title}`.slice(0, 140) + `\n${link}`;
      try { await sendEmail(sms, `Issue #${issue.id}`, text); results.push('text sent'); }
      catch (e) { results.push('text failed'); console.error('[issues] sms gateway failed', e.message); }
    }
    setNotify(results.join(', ') || 'no recipients configured');
  }

  console.log(`Issue tracker ready. OWNER_KEY set: ${!!process.env.OWNER_KEY}. Email via: ${useGmail() ? 'Gmail API' : process.env.RESEND_API_KEY ? 'Resend' : 'NOT CONFIGURED'}. NOTIFY_SMS set: ${!!process.env.NOTIFY_SMS}`);
};
