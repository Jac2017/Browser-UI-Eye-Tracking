/**
 * Data export endpoints — CSV, JSON.
 */

const router = require('express').Router();
const { db } = require('../models/db');
const { authenticate } = require('../middleware/auth');

// GET /export/events/:sessionId — export events as JSON or CSV
router.get('/export/events/:sessionId', authenticate, (req, res) => {
  const format = req.query.format || 'json';
  const type = req.query.type || null;
  const limit = Math.min(parseInt(req.query.limit) || 100000, 500000);

  let query = 'SELECT * FROM events WHERE session_id = ?';
  const params = [req.params.sessionId];
  if (type) {
    query += ' AND type = ?';
    params.push(type);
  }
  query += ' ORDER BY timestamp LIMIT ?';
  params.push(limit);

  const events = db.prepare(query).all(...params);

  if (format === 'csv') {
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', `attachment; filename="events_${req.params.sessionId}.csv"`);

    const headers = ['id', 'session_id', 'type', 'timestamp', 'url', 'tab_id', 'x', 'y', 'page_x', 'page_y', 'scroll_x', 'scroll_y', 'viewport_width', 'viewport_height', 'extra'];
    res.write(headers.join(',') + '\n');
    for (const row of events) {
      const values = headers.map(h => {
        const val = row[h];
        if (val == null) return '';
        if (typeof val === 'string' && (val.includes(',') || val.includes('"') || val.includes('\n'))) {
          return '"' + val.replace(/"/g, '""') + '"';
        }
        return String(val);
      });
      res.write(values.join(',') + '\n');
    }
    return res.end();
  }

  // JSON format
  res.set('Content-Disposition', `attachment; filename="events_${req.params.sessionId}.json"`);
  res.json({ sessionId: req.params.sessionId, events });
});

// GET /export/sessions — export session list
router.get('/export/sessions', authenticate, (req, res) => {
  const format = req.query.format || 'json';
  const keyFilter = req.apiKey.scopes.includes('admin') ? null : req.apiKey.id;

  const sessions = db.prepare(
    keyFilter
      ? 'SELECT * FROM sessions WHERE api_key_id = ? ORDER BY start_time DESC'
      : 'SELECT * FROM sessions ORDER BY start_time DESC'
  ).all(keyFilter || undefined);

  if (format === 'csv') {
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', 'attachment; filename="sessions.csv"');

    const headers = ['id', 'session_name', 'start_time', 'end_time', 'event_count', 'screenshot_count', 'participant_id', 'study_id'];
    res.write(headers.join(',') + '\n');
    for (const row of sessions) {
      const values = headers.map(h => {
        const val = row[h];
        if (val == null) return '';
        if (typeof val === 'string' && val.includes(',')) return `"${val}"`;
        return String(val);
      });
      res.write(values.join(',') + '\n');
    }
    return res.end();
  }

  res.json({ sessions });
});

// GET /export/study/:studyId — export full study data
router.get('/export/study/:studyId', authenticate, (req, res) => {
  const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(req.params.studyId);
  if (!study) return res.status(404).json({ error: 'Study not found' });

  const participants = db.prepare('SELECT * FROM participants WHERE study_id = ?').all(study.id);
  const sessions = db.prepare('SELECT * FROM sessions WHERE study_id = ?').all(study.id);

  const sessionIds = sessions.map(s => s.id);
  let events = [];
  if (sessionIds.length > 0) {
    const placeholders = sessionIds.map(() => '?').join(',');
    events = db.prepare(
      `SELECT * FROM events WHERE session_id IN (${placeholders}) ORDER BY timestamp`
    ).all(...sessionIds);
  }

  res.set('Content-Disposition', `attachment; filename="study_${study.id}_${study.name}.json"`);
  res.json({
    study: { ...study, target_urls: JSON.parse(study.target_urls), config: JSON.parse(study.config) },
    participants,
    sessions,
    events,
    exportDate: new Date().toISOString(),
  });
});

module.exports = router;
