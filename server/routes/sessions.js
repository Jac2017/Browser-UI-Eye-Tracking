/**
 * Session management endpoints.
 */

const router = require('express').Router();
const { db } = require('../models/db');
const { decrypt } = require('../services/crypto');
const { authenticate } = require('../middleware/auth');
const webhookService = require('../services/webhook');
const analytics = require('../services/analytics');

const upsertSession = db.prepare(`
  INSERT INTO sessions (id, api_key_id, session_name, user_agent, participant_id, study_id, start_time, metadata)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    session_name = COALESCE(excluded.session_name, sessions.session_name),
    user_agent = COALESCE(excluded.user_agent, sessions.user_agent),
    participant_id = COALESCE(excluded.participant_id, sessions.participant_id),
    study_id = COALESCE(excluded.study_id, sessions.study_id),
    metadata = COALESCE(excluded.metadata, sessions.metadata)
`);

const endSession = db.prepare(
  'UPDATE sessions SET end_time = ? WHERE id = ?'
);

const getSession = db.prepare('SELECT * FROM sessions WHERE id = ?');

const listSessions = db.prepare(`
  SELECT s.*, COUNT(e.id) as actual_event_count
  FROM sessions s
  LEFT JOIN events e ON e.session_id = s.id
  WHERE s.api_key_id = ? OR ? = 0
  GROUP BY s.id
  ORDER BY s.start_time DESC
  LIMIT ? OFFSET ?
`);

// POST /sessions — create or update session
router.post('/sessions', authenticate, (req, res) => {
  try {
    const { encrypted, data } = req.body;
    let payload;

    if (encrypted) {
      try {
        payload = decrypt(data, req.apiKey.key);
      } catch (err) {
        return res.status(400).json({ error: 'Decryption failed' });
      }
    } else {
      return res.status(400).json({ error: 'Encrypted payloads required' });
    }

    const {
      sessionId, sessionName, userAgent, participantId, studyId, startTime, metadata,
    } = payload;

    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

    upsertSession.run(
      sessionId,
      req.apiKey.id,
      sessionName || '',
      userAgent || '',
      participantId || '',
      studyId || null,
      startTime || Date.now(),
      JSON.stringify(metadata || {}),
    );

    res.json({ ok: true, sessionId });
  } catch (err) {
    console.error('Session create error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /sessions/:id/end — end a session
router.post('/sessions/:id/end', authenticate, (req, res) => {
  try {
    const { encrypted, data } = req.body;
    let payload;

    if (encrypted) {
      try {
        payload = decrypt(data, req.apiKey.key);
      } catch {
        return res.status(400).json({ error: 'Decryption failed' });
      }
    } else {
      return res.status(400).json({ error: 'Encrypted payloads required' });
    }

    endSession.run(payload.endTime || Date.now(), req.params.id);

    // Fire webhook
    const session = getSession.get(req.params.id);
    if (session) {
      const summary = analytics.sessionSummary(req.params.id);
      webhookService.fire('session_end', {
        sessionId: req.params.id,
        sessionName: session.session_name,
        duration: session.end_time - session.start_time,
        eventCount: session.event_count,
        summary,
      });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Session end error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /sessions — list sessions with filtering
router.get('/sessions', authenticate, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const isAdmin = req.apiKey.scopes.includes('admin');

  let where = [];
  const params = [];

  // Permission filter
  if (!isAdmin) {
    where.push('s.api_key_id = ?');
    params.push(req.apiKey.id);
  }

  // Date range
  if (req.query.startAfter) {
    where.push('s.start_time >= ?');
    params.push(parseInt(req.query.startAfter));
  }
  if (req.query.startBefore) {
    where.push('s.start_time <= ?');
    params.push(parseInt(req.query.startBefore));
  }

  // Duration filter (requires end_time)
  if (req.query.minDuration) {
    where.push('s.end_time IS NOT NULL AND (s.end_time - s.start_time) >= ?');
    params.push(parseInt(req.query.minDuration));
  }
  if (req.query.maxDuration) {
    where.push('s.end_time IS NOT NULL AND (s.end_time - s.start_time) <= ?');
    params.push(parseInt(req.query.maxDuration));
  }

  // Completion status
  if (req.query.status === 'active') {
    where.push('s.end_time IS NULL');
  } else if (req.query.status === 'ended') {
    where.push('s.end_time IS NOT NULL');
  }

  // Participant
  if (req.query.participantId) {
    where.push('s.participant_id = ?');
    params.push(req.query.participantId);
  }

  // Study
  if (req.query.studyId) {
    where.push('s.study_id = ?');
    params.push(parseInt(req.query.studyId));
  }

  // Tag filter
  if (req.query.tag) {
    where.push('EXISTS (SELECT 1 FROM session_tags st WHERE st.session_id = s.id AND st.tag = ?)');
    params.push(req.query.tag);
  }

  // Search by name
  if (req.query.search) {
    where.push('s.session_name LIKE ?');
    params.push(`%${req.query.search.substring(0, 100)}%`);
  }

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
  params.push(limit, offset);

  const sessions = db.prepare(`
    SELECT s.*, COUNT(e.id) as actual_event_count
    FROM sessions s
    LEFT JOIN events e ON e.session_id = s.id
    ${whereClause}
    GROUP BY s.id
    ORDER BY s.start_time DESC
    LIMIT ? OFFSET ?
  `).all(...params);

  // Get tags for returned sessions
  const sessionIds = sessions.map(s => s.id);
  const tagMap = {};
  if (sessionIds.length > 0) {
    const ph = sessionIds.map(() => '?').join(',');
    const tags = db.prepare(`SELECT session_id, tag FROM session_tags WHERE session_id IN (${ph})`).all(...sessionIds);
    for (const t of tags) {
      if (!tagMap[t.session_id]) tagMap[t.session_id] = [];
      tagMap[t.session_id].push(t.tag);
    }
  }

  for (const s of sessions) {
    s.tags = tagMap[s.id] || [];
  }

  res.json({ sessions });
});

// GET /sessions/:id — get session detail
router.get('/sessions/:id', authenticate, (req, res) => {
  const session = getSession.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  // Permission check
  if (!req.apiKey.scopes.includes('admin') && session.api_key_id !== req.apiKey.id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  res.json({ session });
});

// GET /sessions/:id/summary — get analytics summary
router.get('/sessions/:id/summary', authenticate, (req, res) => {
  const session = getSession.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  if (!req.apiKey.scopes.includes('admin') && session.api_key_id !== req.apiKey.id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const summary = analytics.sessionSummary(req.params.id);
  res.json({ summary });
});

/* ========== SESSION TAGS ========== */

// POST /sessions/:id/tags — add tag to session
router.post('/sessions/:id/tags', authenticate, (req, res) => {
  const { tag } = req.body;
  if (!tag || typeof tag !== 'string' || tag.length > 50) {
    return res.status(400).json({ error: 'Tag required (max 50 chars)' });
  }
  try {
    db.prepare('INSERT OR IGNORE INTO session_tags (session_id, tag) VALUES (?, ?)').run(req.params.id, tag.trim());
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add tag' });
  }
});

// DELETE /sessions/:id/tags/:tag — remove tag
router.delete('/sessions/:id/tags/:tag', authenticate, (req, res) => {
  db.prepare('DELETE FROM session_tags WHERE session_id = ? AND tag = ?').run(req.params.id, req.params.tag);
  res.json({ ok: true });
});

// GET /sessions/:id/tags — get all tags
router.get('/sessions/:id/tags', authenticate, (req, res) => {
  const tags = db.prepare('SELECT tag FROM session_tags WHERE session_id = ?').all(req.params.id);
  res.json({ tags: tags.map(t => t.tag) });
});

// GET /sessions/tags/all — list all unique tags
router.get('/tags/all', authenticate, (req, res) => {
  const tags = db.prepare('SELECT tag, COUNT(*) as count FROM session_tags GROUP BY tag ORDER BY count DESC').all();
  res.json({ tags });
});

/* ========== SESSION ANNOTATIONS ========== */

// POST /sessions/:id/annotations — add annotation
router.post('/sessions/:id/annotations', authenticate, (req, res) => {
  const { text, timestamp, author } = req.body;
  if (!text || typeof text !== 'string' || text.length > 5000) {
    return res.status(400).json({ error: 'Annotation text required (max 5000 chars)' });
  }
  const result = db.prepare(
    'INSERT INTO session_annotations (session_id, timestamp, text, author) VALUES (?, ?, ?, ?)'
  ).run(req.params.id, timestamp || null, text.trim(), (author || '').substring(0, 100));
  res.json({ ok: true, annotationId: result.lastInsertRowid });
});

// GET /sessions/:id/annotations — get annotations
router.get('/sessions/:id/annotations', authenticate, (req, res) => {
  const annotations = db.prepare(
    'SELECT * FROM session_annotations WHERE session_id = ? ORDER BY COALESCE(timestamp, 0), created_at'
  ).all(req.params.id);
  res.json({ annotations });
});

// DELETE /sessions/annotations/:id — delete annotation
router.delete('/sessions/annotations/:annotationId', authenticate, (req, res) => {
  db.prepare('DELETE FROM session_annotations WHERE id = ?').run(req.params.annotationId);
  res.json({ ok: true });
});

/* ========== SCREENSHOTS LIST ========== */

// GET /sessions/:id/screenshots — list screenshots for a session
router.get('/sessions/:id/screenshots', authenticate, (req, res) => {
  const screenshots = db.prepare(
    'SELECT id, timestamp, url, trigger_type, width, height, file_size FROM screenshots WHERE session_id = ? ORDER BY timestamp'
  ).all(req.params.id);
  res.json({ screenshots });
});

module.exports = router;
