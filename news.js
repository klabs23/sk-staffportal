// Steamoji Staff Portal: News Feed API
//
// The director posts updates; every staff member reads them on the portal home page.
// Posts never expire. Only the director (x-owner-key = OWNER_KEY) can create, edit or delete.
//
// Tables (same SQLite file as everything else, on the /data volume):
//   news_posts  one row per update (title, details)
//   news_media  images / videos attached to a post, files under DATA_DIR/news-media
//
// Access:
//   Staff    -> header x-staff-key = the portal passphrase hash (read only)
//   Director -> header x-owner-key = OWNER_KEY env var (create / edit / delete)

const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const DEFAULT_STAFF_HASH = '7a44363b0feda50d6ea2e38a8803ae2473d55a8ef74b79cb87303abee0b5987e';
const MAX_FILE_MB = 200;   // videos from a phone can be large
const MAX_FILES = 6;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const clean = (s, max) => String(s == null ? '' : s).trim().slice(0, max);

const EXT = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'image/heic': '.heic', 'image/heif': '.heif',
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'video/x-m4v': '.m4v',
};

// Some phones/browsers send a blank or generic type; fall back to the file extension.
const BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/x-m4v',
};
function mimeFor(file) {
  if (/^(image|video)\//.test(file.mimetype)) return file.mimetype;
  const ext = String(file.originalname || '').split('.').pop().toLowerCase();
  return BY_EXT[ext] || null;
}

module.exports = function mountNews(app, db, DATA_DIR) {
  const MEDIA_DIR = path.join(DATA_DIR, 'news-media');
  fs.mkdirSync(MEDIA_DIR, { recursive: true });

  db.exec(`
    CREATE TABLE IF NOT EXISTS news_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS news_media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL REFERENCES news_posts(id),
      file TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,             -- image | video
      mime TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_news_media_post ON news_media(post_id);
  `);

  // --- auth helpers (same model as the Issue Tracker) ---
  const staffHash = process.env.STAFF_KEY_HASH || DEFAULT_STAFF_HASH;
  const isDirector = (req) => !!process.env.OWNER_KEY && !!req.get('x-owner-key') && safeEq(req.get('x-owner-key'), process.env.OWNER_KEY);
  function requireStaff(req, res, next) {
    const k = req.get('x-staff-key') || '';
    if (isDirector(req) || (k && safeEq(k, staffHash))) return next();
    res.status(401).json({ error: 'Not signed in to the staff portal.' });
  }
  function requireDirector(req, res, next) {
    if (!process.env.OWNER_KEY) return res.status(503).json({ error: 'OWNER_KEY is not set on the server yet.' });
    if (isDirector(req)) return next();
    res.status(403).json({ error: 'Only the director can post to the news feed.' });
  }

  // --- media upload handling ---
  const upload = multer({
    storage: multer.diskStorage({
      destination: MEDIA_DIR,
      filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + (EXT[file.mimetype] || (/^video\//.test(file.mimetype) ? '.vid' : '.img'))),
    }),
    limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: MAX_FILES },
    fileFilter: (req, file, cb) => {
      const m = mimeFor(file);
      if (!m) return cb(new Error(`"${file.originalname}" is not a supported image or video.`));
      file.mimetype = m;
      cb(null, true);
    },
  });
  const withMedia = (req, res, next) => upload.array('media', MAX_FILES)(req, res, (err) => {
    if (err) {
      (req.files || []).forEach((f) => fs.unlink(f.path, () => {}));
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `A file was larger than ${MAX_FILE_MB} MB.` : err.code === 'LIMIT_FILE_COUNT' ? `Max ${MAX_FILES} files per post.` : String(err.message || err) });
    }
    next();
  });
  const saveMedia = (files, postId, now) => {
    const ins = db.prepare('INSERT INTO news_media (post_id, file, kind, mime, created_at) VALUES (?, ?, ?, ?, ?)');
    (files || []).forEach((f) => ins.run(postId, f.filename, /^video\//.test(f.mimetype) ? 'video' : 'image', f.mimetype, now));
  };
  const removeFiles = (rows) => rows.forEach((m) => fs.unlink(path.join(MEDIA_DIR, m.file), () => {}));

  const withMediaList = (posts) => {
    if (!posts.length) return posts;
    const media = db.prepare(`SELECT id, post_id, file, kind, mime FROM news_media WHERE post_id IN (${posts.map(() => '?').join(',')}) ORDER BY id`).all(...posts.map((p) => p.id));
    const by = {};
    media.forEach((m) => { (by[m.post_id] = by[m.post_id] || []).push(m); });
    return posts.map((p) => Object.assign(p, { media: by[p.id] || [] }));
  };

  // Media files have 128-bit random names, so <img>/<video> can load them without headers.
  // sendFile handles Range requests, which video seeking needs.
  app.get('/api/news/media/:file', (req, res) => {
    if (!/^[a-f0-9]{32}\.[a-z0-9]{3,4}$/.test(req.params.file)) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.sendFile(path.join(MEDIA_DIR, req.params.file), (err) => { if (err && !res.headersSent) res.status(404).end(); });
  });

  // --- list: newest first, no expiry ---
  app.get('/api/news', requireStaff, (req, res) => {
    const posts = db.prepare('SELECT * FROM news_posts ORDER BY created_at DESC, id DESC').all();
    res.json({ posts: withMediaList(posts), director: isDirector(req) });
  });

  // --- create (multipart: title, body, author, media[]) ---
  app.post('/api/news', requireDirector, withMedia, (req, res) => {
    const b = req.body || {};
    const title = clean(b.title, 160);
    if (!title) {
      removeFiles((req.files || []).map((f) => ({ file: f.filename })));
      return res.status(400).json({ error: 'A title is required.' });
    }
    const now = Date.now();
    const id = db.transaction(() => {
      const info = db.prepare('INSERT INTO news_posts (title, body, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(title, clean(b.body, 10000), clean(b.author, 60) || 'Director', now, now);
      saveMedia(req.files, info.lastInsertRowid, now);
      return info.lastInsertRowid;
    })();
    res.json({ ok: true, id });
  });

  // --- edit (multipart: title, body, media[] to add, removeMedia = comma-separated media ids) ---
  app.patch('/api/news/:id', requireDirector, withMedia, (req, res) => {
    const post = db.prepare('SELECT * FROM news_posts WHERE id = ?').get(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found.' });
    const b = req.body || {};
    const title = b.title !== undefined ? clean(b.title, 160) : post.title;
    if (!title) return res.status(400).json({ error: 'Title cannot be empty.' });
    const body = b.body !== undefined ? clean(b.body, 10000) : post.body;
    const removeIds = String(b.removeMedia || '').split(',').map((x) => parseInt(x, 10)).filter(Boolean);
    const now = Date.now();
    let removed = [];
    db.transaction(() => {
      db.prepare('UPDATE news_posts SET title = ?, body = ?, updated_at = ? WHERE id = ?').run(title, body, now, post.id);
      if (removeIds.length) {
        const q = `SELECT * FROM news_media WHERE post_id = ? AND id IN (${removeIds.map(() => '?').join(',')})`;
        removed = db.prepare(q).all(post.id, ...removeIds);
        removed.forEach((m) => db.prepare('DELETE FROM news_media WHERE id = ?').run(m.id));
      }
      saveMedia(req.files, post.id, now);
    })();
    removeFiles(removed);
    res.json({ ok: true });
  });

  // --- delete ---
  app.delete('/api/news/:id', requireDirector, (req, res) => {
    const post = db.prepare('SELECT * FROM news_posts WHERE id = ?').get(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found.' });
    const media = db.prepare('SELECT file FROM news_media WHERE post_id = ?').all(post.id);
    db.transaction(() => {
      db.prepare('DELETE FROM news_media WHERE post_id = ?').run(post.id);
      db.prepare('DELETE FROM news_posts WHERE id = ?').run(post.id);
    })();
    removeFiles(media);
    res.json({ ok: true });
  });

  console.log(`News feed ready. Director posting ${process.env.OWNER_KEY ? 'enabled' : 'DISABLED (OWNER_KEY not set)'}.`);
};
