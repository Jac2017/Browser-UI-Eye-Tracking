/**
 * Multi-user study management endpoints.
 * Studies group multiple participants and sessions for A/B testing and research.
 */

const router = require('express').Router();
const { db } = require('../models/db');
const { authenticate, masterAuth } = require('../middleware/auth');
const analytics = require('../services/analytics');

const createStudy = db.prepare(`
  INSERT INTO studies (name, description, target_urls, config) VALUES (?, ?, ?, ?)
`);
const updateStudy = db.prepare(`
  UPDATE studies SET name = ?, description = ?, target_urls = ?, config = ?, status = ?, updated_at = datetime('now') WHERE id = ?
`);
const getStudy = db.prepare('SELECT * FROM studies WHERE id = ?');
const listStudies = db.prepare('SELECT * FROM studies ORDER BY created_at DESC LIMIT ? OFFSET ?');
const deleteStudy = db.prepare('DELETE FROM studies WHERE id = ?');

const addParticipant = db.prepare(`
  INSERT OR IGNORE INTO participants (study_id, participant_id, group_name, metadata, consent_given, consent_date)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const listParticipants = db.prepare(
  'SELECT * FROM participants WHERE study_id = ? ORDER BY created_at'
);
const getParticipant = db.prepare(
  'SELECT * FROM participants WHERE study_id = ? AND participant_id = ?'
);
const updateParticipantCount = db.prepare(
  'UPDATE studies SET participant_count = (SELECT COUNT(*) FROM participants WHERE study_id = ?) WHERE id = ?'
);

// POST /studies — create study
router.post('/studies', masterAuth, (req, res) => {
  const { name, description, targetUrls, config: studyConfig } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const result = createStudy.run(
    name.substring(0, 200),
    (description || '').substring(0, 1000),
    JSON.stringify(targetUrls || []),
    JSON.stringify(studyConfig || {}),
  );

  res.json({ ok: true, id: result.lastInsertRowid });
});

// GET /studies
router.get('/studies', authenticate, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const studies = listStudies.all(limit, offset);
  res.json({ studies: studies.map(s => ({ ...s, target_urls: JSON.parse(s.target_urls), config: JSON.parse(s.config) })) });
});

// GET /studies/:id
router.get('/studies/:id', authenticate, (req, res) => {
  const study = getStudy.get(req.params.id);
  if (!study) return res.status(404).json({ error: 'Study not found' });
  study.target_urls = JSON.parse(study.target_urls);
  study.config = JSON.parse(study.config);
  const participants = listParticipants.all(study.id);
  res.json({ study, participants });
});

// PUT /studies/:id
router.put('/studies/:id', masterAuth, (req, res) => {
  const existing = getStudy.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Study not found' });

  const { name, description, targetUrls, config: studyConfig, status } = req.body;
  updateStudy.run(
    (name || existing.name).substring(0, 200),
    (description ?? existing.description).substring(0, 1000),
    JSON.stringify(targetUrls || JSON.parse(existing.target_urls)),
    JSON.stringify(studyConfig || JSON.parse(existing.config)),
    status || existing.status,
    req.params.id,
  );

  res.json({ ok: true });
});

// DELETE /studies/:id
router.delete('/studies/:id', masterAuth, (req, res) => {
  deleteStudy.run(req.params.id);
  res.json({ ok: true });
});

// POST /studies/:id/participants — add participant
router.post('/studies/:id/participants', authenticate, (req, res) => {
  const study = getStudy.get(req.params.id);
  if (!study) return res.status(404).json({ error: 'Study not found' });

  const { participantId, group, metadata, consentGiven } = req.body;
  if (!participantId) return res.status(400).json({ error: 'participantId required' });

  addParticipant.run(
    study.id,
    participantId.substring(0, 100),
    (group || 'default').substring(0, 50),
    JSON.stringify(metadata || {}),
    consentGiven ? 1 : 0,
    consentGiven ? new Date().toISOString() : null,
  );
  updateParticipantCount.run(study.id, study.id);

  res.json({ ok: true });
});

// GET /studies/:id/participants
router.get('/studies/:id/participants', authenticate, (req, res) => {
  const participants = listParticipants.all(req.params.id);
  res.json({ participants });
});

// GET /studies/:id/aggregate — aggregate analytics across all participants
router.get('/studies/:id/aggregate', authenticate, (req, res) => {
  const study = getStudy.get(req.params.id);
  if (!study) return res.status(404).json({ error: 'Study not found' });

  // Get all sessions for this study
  const sessions = db.prepare(
    'SELECT id FROM sessions WHERE study_id = ?'
  ).all(study.id);

  if (sessions.length === 0) {
    return res.json({ aggregate: { sessions: 0, events: 0, heatmap: null } });
  }

  // Aggregate all gaze events across sessions
  const sessionIds = sessions.map(s => s.id);
  const placeholders = sessionIds.map(() => '?').join(',');
  const allGaze = db.prepare(
    `SELECT x, y, timestamp FROM events WHERE session_id IN (${placeholders}) AND type = 'gaze' ORDER BY timestamp`
  ).all(...sessionIds);

  const allEvents = db.prepare(
    `SELECT type, timestamp, x, y, url FROM events WHERE session_id IN (${placeholders}) ORDER BY timestamp`
  ).all(...sessionIds);

  const heatmap = analytics.aggregateHeatmap(allGaze);
  const fixations = analytics.detectFixations(allGaze);
  const engagement = analytics.computeEngagement(allEvents, fixations);

  // Per-group breakdown
  const participants = listParticipants.all(study.id);
  const groups = {};
  for (const p of participants) {
    if (!groups[p.group_name]) groups[p.group_name] = [];
    groups[p.group_name].push(p.participant_id);
  }

  const groupStats = {};
  for (const [groupName, pIds] of Object.entries(groups)) {
    const groupSessions = db.prepare(
      `SELECT id FROM sessions WHERE study_id = ? AND participant_id IN (${pIds.map(() => '?').join(',')})`
    ).all(study.id, ...pIds);

    groupStats[groupName] = {
      participants: pIds.length,
      sessions: groupSessions.length,
    };
  }

  res.json({
    aggregate: {
      sessions: sessions.length,
      totalEvents: allEvents.length,
      gazePoints: allGaze.length,
      fixations: fixations.length,
      engagement,
      heatmap,
      groups: groupStats,
    },
  });
});

module.exports = router;
