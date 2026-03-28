/**
 * API key management endpoints.
 * Protected by master key authentication.
 */

const router = require('express').Router();
const { db } = require('../models/db');
const { masterAuth } = require('../middleware/auth');
const crypto = require('crypto');

const createKey = db.prepare(`
  INSERT INTO api_keys (key, name, project, scopes, rate_limit) VALUES (?, ?, ?, ?, ?)
`);
const listKeys = db.prepare(
  'SELECT id, key, name, project, scopes, rate_limit, active, created_at, last_used_at, total_events FROM api_keys ORDER BY created_at DESC'
);
const getKey = db.prepare('SELECT * FROM api_keys WHERE id = ?');
const deactivateKey = db.prepare('UPDATE api_keys SET active = 0 WHERE id = ?');
const activateKey = db.prepare('UPDATE api_keys SET active = 1 WHERE id = ?');
const deleteKey = db.prepare('DELETE FROM api_keys WHERE id = ?');
const updateKey = db.prepare(
  'UPDATE api_keys SET name = ?, project = ?, scopes = ?, rate_limit = ? WHERE id = ?'
);

function generateApiKey() {
  return 'eyed_' + crypto.randomBytes(24).toString('base64url');
}

// POST /keys — create new API key
router.post('/keys', masterAuth, (req, res) => {
  const { name, project, scopes, rateLimit } = req.body;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Name is required' });
  }

  const key = generateApiKey();
  const result = createKey.run(
    key,
    name.trim().substring(0, 100),
    (project || '').substring(0, 100),
    scopes || 'write',
    rateLimit || 120,
  );

  res.json({
    ok: true,
    id: result.lastInsertRowid,
    key,
    name: name.trim(),
  });
});

// GET /keys — list all API keys
router.get('/keys', masterAuth, (req, res) => {
  const keys = listKeys.all();
  // Mask keys in listing (show first 10 chars)
  const masked = keys.map(k => ({
    ...k,
    key: k.key.substring(0, 10) + '...' + k.key.substring(k.key.length - 4),
  }));
  res.json({ keys: masked });
});

// GET /keys/:id — get single key (unmasked)
router.get('/keys/:id', masterAuth, (req, res) => {
  const key = getKey.get(req.params.id);
  if (!key) return res.status(404).json({ error: 'Key not found' });
  res.json({ key });
});

// PUT /keys/:id — update key metadata
router.put('/keys/:id', masterAuth, (req, res) => {
  const existing = getKey.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Key not found' });

  const { name, project, scopes, rateLimit } = req.body;
  updateKey.run(
    (name || existing.name).substring(0, 100),
    (project ?? existing.project).substring(0, 100),
    scopes || existing.scopes,
    rateLimit || existing.rate_limit,
    req.params.id,
  );

  res.json({ ok: true });
});

// POST /keys/:id/deactivate
router.post('/keys/:id/deactivate', masterAuth, (req, res) => {
  deactivateKey.run(req.params.id);
  res.json({ ok: true });
});

// POST /keys/:id/activate
router.post('/keys/:id/activate', masterAuth, (req, res) => {
  activateKey.run(req.params.id);
  res.json({ ok: true });
});

// DELETE /keys/:id
router.delete('/keys/:id', masterAuth, (req, res) => {
  deleteKey.run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
