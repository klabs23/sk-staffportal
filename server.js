const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();
app.use(express.json());

// --- Persistent storage setup ---
// Railway: attach a Volume to this service and mount it at /data so the
// cache survives redeploys. Without a mounted volume, /data falls back to
// the container's local disk, which is wiped on every redeploy.
const DATA_DIR = process.env.DATA_DIR || '/data';
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
const db = new Database(path.join(DATA_DIR, 'cache.db'));
db.exec(`CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  savedAt INTEGER NOT NULL
)`);

// --- Static site ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Shared idea cache API (replaces window.storage from the Claude.ai version) ---
app.get('/api/cache', (req, res) => {
  const prefix = req.query.prefix || '';
  const rows = db.prepare('SELECT key FROM cache WHERE key LIKE ?').all(prefix + '%');
  res.json({ keys: rows.map(r => r.key) });
});

app.get('/api/cache/:key', (req, res) => {
  const row = db.prepare('SELECT value FROM cache WHERE key = ?').get(req.params.key);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({ key: req.params.key, value: row.value });
});

app.post('/api/cache', (req, res) => {
  const { key, value } = req.body || {};
  if (!key || value === undefined) return res.status(400).json({ error: 'key and value required' });
  db.prepare(`
    INSERT INTO cache (key, value, savedAt) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, savedAt = excluded.savedAt
  `).run(key, value, Date.now());
  res.json({ ok: true });
});

app.delete('/api/cache/:key', (req, res) => {
  db.prepare('DELETE FROM cache WHERE key = ?').run(req.params.key);
  res.json({ ok: true });
});

// --- Live idea generation proxy ---
// Holds ANTHROPIC_API_KEY server-side (set as a Railway environment variable)
// so it never appears in anything served to the browser. Generated from the
// kirkland@steamoji.com account at console.anthropic.com.
app.post('/api/generate', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set on the server.' });
  }
  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });
    const data = await anthropicRes.json();
    res.status(anthropicRes.status).json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Steamoji Free-Time Idea Engine running on port ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`ANTHROPIC_API_KEY set: ${!!process.env.ANTHROPIC_API_KEY}`);
});
