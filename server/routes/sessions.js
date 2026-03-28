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

// GET /sessions — list sessions
router.get('/sessions', authenticate, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const keyFilter = req.apiKey.scopes.includes('admin') ? 0 : req.apiKey.id;

  const sessions = listSessions.all(keyFilter, keyFilter, limit, offset);
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

module.exports = router;
