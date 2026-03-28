/**
 * Screenshot ingestion and retrieval.
 */

const router = require('express').Router();
const { db } = require('../models/db');
const { decrypt } = require('../services/crypto');
const { authenticate } = require('../middleware/auth');
const config = require('../config');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

fs.mkdirSync(config.screenshotDir, { recursive: true });

const insertScreenshot = db.prepare(`
  INSERT INTO screenshots (session_id, timestamp, url, tab_id, trigger_type, width, height, file_path, file_size)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateSessionScreenshots = db.prepare(
  'UPDATE sessions SET screenshot_count = screenshot_count + 1 WHERE id = ?'
);

const getScreenshot = db.prepare('SELECT * FROM screenshots WHERE id = ?');

const listScreenshots = db.prepare(
  'SELECT id, session_id, timestamp, url, trigger_type, width, height, file_size FROM screenshots WHERE session_id = ? ORDER BY timestamp LIMIT ? OFFSET ?'
);

const ensureSession = db.prepare(
  'INSERT OR IGNORE INTO sessions (id, api_key_id, start_time) VALUES (?, ?, ?)'
);

const ALLOWED_TRIGGERS = new Set([
  'pageLoad', 'periodic', 'scrollMilestone_25', 'scrollMilestone_50',
  'scrollMilestone_75', 'scrollMilestone_100', 'manual', 'unknown',
]);

router.post('/screenshots', authenticate, (req, res) => {
  try {
    const { encrypted, data } = req.body;
    if (!encrypted) {
      return res.status(400).json({ error: 'Encrypted payloads required' });
    }

    let payload;
    try {
      payload = decrypt(data, req.apiKey.key);
    } catch (err) {
      return res.status(400).json({ error: 'Decryption failed' });
    }

    const { sessionId, timestamp, url, tabId, trigger, dataUrl, width, height } = payload;
    if (!sessionId || !dataUrl) {
      return res.status(400).json({ error: 'Missing sessionId or dataUrl' });
    }

    // Validate data URL
    if (!dataUrl.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Invalid image data' });
    }

    // Extract base64 image data
    const commaIdx = dataUrl.indexOf(',');
    if (commaIdx === -1) return res.status(400).json({ error: 'Malformed data URL' });
    const base64Data = dataUrl.slice(commaIdx + 1);
    const imgBuffer = Buffer.from(base64Data, 'base64');

    if (imgBuffer.length > config.maxScreenshotSize) {
      return res.status(400).json({ error: 'Screenshot too large' });
    }

    // Determine file extension
    const mimeMatch = dataUrl.match(/^data:image\/(jpeg|png|webp)/);
    const ext = mimeMatch ? mimeMatch[1] : 'jpeg';

    // Save to disk with random filename
    const filename = `${sessionId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
    const filePath = path.join(config.screenshotDir, filename);
    fs.writeFileSync(filePath, imgBuffer);

    // Ensure session exists
    ensureSession.run(sessionId, req.apiKey.id, Date.now());

    const triggerType = ALLOWED_TRIGGERS.has(trigger) ? trigger : 'unknown';
    insertScreenshot.run(
      sessionId, timestamp || Date.now(), url || '', tabId || null,
      triggerType, width || 0, height || 0, filename, imgBuffer.length,
    );
    updateSessionScreenshots.run(sessionId);

    res.json({ ok: true, size: imgBuffer.length });
  } catch (err) {
    console.error('Screenshot ingestion error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /screenshots/:id — serve screenshot image
router.get('/screenshots/:id', authenticate, (req, res) => {
  const row = getScreenshot.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Screenshot not found' });

  const filePath = path.join(config.screenshotDir, row.file_path);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Screenshot file missing' });
  }

  const ext = path.extname(row.file_path).slice(1);
  const mime = { jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  res.set('Content-Type', mime[ext] || 'image/jpeg');
  res.sendFile(filePath);
});

// GET /screenshots/session/:sessionId — list screenshots for session
router.get('/screenshots/session/:sessionId', authenticate, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const rows = listScreenshots.all(req.params.sessionId, limit, offset);
  res.json({ screenshots: rows });
});

module.exports = router;
