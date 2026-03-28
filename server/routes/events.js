/**
 * Event ingestion endpoint.
 * Receives encrypted event batches from the extension, decrypts, validates, and stores.
 */

const router = require('express').Router();
const { db } = require('../models/db');
const { decrypt, verifySignature } = require('../services/crypto');
const { authenticate } = require('../middleware/auth');
const config = require('../config');
const wsService = require('../services/ws');

const insertEvent = db.prepare(`
  INSERT INTO events (session_id, type, timestamp, url, tab_id, x, y, page_x, page_y, scroll_x, scroll_y, viewport_width, viewport_height, extra)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateSessionCount = db.prepare(
  'UPDATE sessions SET event_count = event_count + ? WHERE id = ?'
);

const updateKeyCount = db.prepare(
  'UPDATE api_keys SET total_events = total_events + ? WHERE id = ?'
);

const ensureSession = db.prepare(`
  INSERT OR IGNORE INTO sessions (id, api_key_id, start_time) VALUES (?, ?, ?)
`);

const ALLOWED_TYPES = new Set([
  'gaze', 'mouse', 'touch', 'click', 'hover', 'deadClick', 'rageClick',
  'scroll', 'scrollMilestone', 'tabFocus', 'tabBlur', 'visibilityChange',
  'elementVisibility', 'formFocus', 'formBlur', 'textSelection', 'navigation',
]);

const insertBatch = db.transaction((events, sessionId, apiKeyId) => {
  ensureSession.run(sessionId, apiKeyId, Date.now());
  let inserted = 0;
  for (const e of events) {
    if (!ALLOWED_TYPES.has(e.type)) continue;
    if (typeof e.timestamp !== 'number') continue;

    const extra = {};
    for (const key of Object.keys(e)) {
      if (!['type', 'timestamp', 'url', 'tabId', 'x', 'y', 'pageX', 'pageY', 'scrollX', 'scrollY', 'viewportWidth', 'viewportHeight'].includes(key)) {
        extra[key] = e[key];
      }
    }

    insertEvent.run(
      sessionId,
      e.type,
      e.timestamp,
      e.url || '',
      e.tabId || null,
      e.x ?? null,
      e.y ?? null,
      e.pageX ?? null,
      e.pageY ?? null,
      e.scrollX ?? null,
      e.scrollY ?? null,
      e.viewportWidth ?? null,
      e.viewportHeight ?? null,
      JSON.stringify(extra),
    );
    inserted++;
  }
  if (inserted > 0) {
    updateSessionCount.run(inserted, sessionId);
    updateKeyCount.run(inserted, apiKeyId);
  }
  return inserted;
});

router.post('/events', authenticate, (req, res) => {
  try {
    const { encrypted, data } = req.body;
    if (!data) return res.status(400).json({ error: 'Missing payload data' });

    // Verify signature if present
    const signature = req.headers['x-signature'];
    if (signature) {
      const bodyStr = JSON.stringify(req.body);
      if (!verifySignature(bodyStr, signature, req.apiKey.key)) {
        return res.status(400).json({ error: 'Invalid signature' });
      }
    }

    // Decrypt if encrypted
    let payload;
    if (encrypted) {
      try {
        payload = decrypt(data, req.apiKey.key);
      } catch (err) {
        return res.status(400).json({ error: 'Decryption failed: ' + err.message });
      }
    } else {
      // Reject unencrypted payloads
      return res.status(400).json({ error: 'Encrypted payloads required' });
    }

    // Validate batch
    const { sessionId, events } = payload;
    if (!sessionId || !Array.isArray(events)) {
      return res.status(400).json({ error: 'Invalid batch format' });
    }
    if (events.length > config.maxBatchSize) {
      return res.status(400).json({ error: `Batch too large (max ${config.maxBatchSize})` });
    }

    const inserted = insertBatch(events, sessionId, req.apiKey.id);

    // Broadcast to WebSocket dashboard clients
    wsService.broadcast('events', {
      sessionId,
      count: inserted,
      types: [...new Set(events.map(e => e.type))],
    });

    res.json({ ok: true, inserted });
  } catch (err) {
    console.error('Event ingestion error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
