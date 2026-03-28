/**
 * Webhook management endpoints.
 */

const router = require('express').Router();
const { db } = require('../models/db');
const { authenticate, masterAuth } = require('../middleware/auth');
const crypto = require('crypto');

const createWebhook = db.prepare(`
  INSERT INTO webhooks (url, events, secret, api_key_id) VALUES (?, ?, ?, ?)
`);
const listWebhooks = db.prepare(
  'SELECT id, url, events, active, created_at, last_triggered_at, failure_count FROM webhooks WHERE api_key_id = ? OR ? = 0 ORDER BY created_at DESC'
);
const getWebhook = db.prepare('SELECT * FROM webhooks WHERE id = ?');
const deleteWebhook = db.prepare('DELETE FROM webhooks WHERE id = ?');
const toggleWebhook = db.prepare('UPDATE webhooks SET active = ? WHERE id = ?');

// POST /webhooks — create webhook
router.post('/webhooks', authenticate, (req, res) => {
  const { url, events } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required' });
  }

  // Validate URL
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      return res.status(400).json({ error: 'Invalid URL scheme' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const secret = crypto.randomBytes(16).toString('hex');
  const eventList = Array.isArray(events) ? events : ['session_end'];
  const allowedEvents = ['session_end', 'session_start', 'batch_upload'];
  const validEvents = eventList.filter(e => allowedEvents.includes(e));

  const result = createWebhook.run(
    url,
    JSON.stringify(validEvents),
    secret,
    req.apiKey.id,
  );

  res.json({ ok: true, id: result.lastInsertRowid, secret });
});

// GET /webhooks
router.get('/webhooks', authenticate, (req, res) => {
  const keyFilter = req.apiKey.scopes?.includes('admin') ? 0 : req.apiKey.id;
  const hooks = listWebhooks.all(keyFilter, keyFilter);
  res.json({
    webhooks: hooks.map(h => ({ ...h, events: JSON.parse(h.events) })),
  });
});

// DELETE /webhooks/:id
router.delete('/webhooks/:id', authenticate, (req, res) => {
  const hook = getWebhook.get(req.params.id);
  if (!hook) return res.status(404).json({ error: 'Webhook not found' });
  if (!req.apiKey.scopes?.includes('admin') && hook.api_key_id !== req.apiKey.id) {
    return res.status(403).json({ error: 'Access denied' });
  }
  deleteWebhook.run(req.params.id);
  res.json({ ok: true });
});

// POST /webhooks/:id/toggle
router.post('/webhooks/:id/toggle', authenticate, (req, res) => {
  const hook = getWebhook.get(req.params.id);
  if (!hook) return res.status(404).json({ error: 'Webhook not found' });
  toggleWebhook.run(hook.active ? 0 : 1, req.params.id);
  res.json({ ok: true, active: !hook.active });
});

module.exports = router;
