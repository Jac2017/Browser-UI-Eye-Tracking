/**
 * Feedback & bug-report endpoints — submit, list, classify, and action reports
 * from extension users and researchers.
 */

const router = require('express').Router();
const { db } = require('../models/db');
const { authenticate, masterAuth } = require('../middleware/auth');

const VALID_TYPES = ['bug', 'feature', 'usability', 'performance', 'other'];
const VALID_PRIORITIES = ['critical', 'high', 'medium', 'low'];
const VALID_STATUSES = ['new', 'triaged', 'in_progress', 'resolved', 'closed', 'wont_fix', 'duplicate'];
const VALID_CATEGORIES = [
  'uncategorized', 'tracking', 'calibration', 'overlay', 'export',
  'dashboard', 'auth', 'performance', 'data_loss', 'ui', 'api', 'other',
];

/* ========== SUBMIT (public — requires API key or extension) ========== */

// POST /feedback — submit a feedback / bug report
router.post('/feedback', authenticate, (req, res) => {
  const {
    type, title, description, stepsToReproduce, expectedBehavior,
    actualBehavior, url, browserInfo, sessionId, participantId,
    screenshotData, source,
  } = req.body;

  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    return res.status(400).json({ error: 'title is required' });
  }
  if (title.length > 500) {
    return res.status(400).json({ error: 'title must be under 500 characters' });
  }
  const feedbackType = VALID_TYPES.includes(type) ? type : 'bug';
  const feedbackSource = ['extension', 'dashboard', 'api'].includes(source) ? source : 'extension';

  const result = db.prepare(`
    INSERT INTO feedback (source, type, title, description, steps_to_reproduce,
      expected_behavior, actual_behavior, url, browser_info, session_id,
      participant_id, screenshot_data, api_key_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    feedbackSource,
    feedbackType,
    title.substring(0, 500),
    (description || '').substring(0, 5000),
    (stepsToReproduce || '').substring(0, 5000),
    (expectedBehavior || '').substring(0, 2000),
    (actualBehavior || '').substring(0, 2000),
    (url || '').substring(0, 2000),
    JSON.stringify(browserInfo || {}).substring(0, 2000),
    (sessionId || '').substring(0, 200),
    (participantId || '').substring(0, 200),
    (screenshotData || '').substring(0, 500000), // ~375KB base64
    req.apiKeyId || null
  );

  res.status(201).json({ id: result.lastInsertRowid });
});

/* ========== LIST & FILTER (master key) ========== */

// GET /feedback — list all feedback with optional filters
router.get('/feedback', masterAuth, (req, res) => {
  const { type, category, priority, status, source, search, limit, offset, sort } = req.query;

  let where = [];
  let params = [];

  if (type && VALID_TYPES.includes(type)) { where.push('type = ?'); params.push(type); }
  if (category && VALID_CATEGORIES.includes(category)) { where.push('category = ?'); params.push(category); }
  if (priority && VALID_PRIORITIES.includes(priority)) { where.push('priority = ?'); params.push(priority); }
  if (status && VALID_STATUSES.includes(status)) { where.push('status = ?'); params.push(status); }
  if (source) { where.push('source = ?'); params.push(source); }
  if (search) {
    where.push('(title LIKE ? OR description LIKE ?)');
    const term = `%${search.substring(0, 200)}%`;
    params.push(term, term);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sortColumn = ['created_at', 'updated_at', 'priority', 'status', 'type'].includes(sort) ? sort : 'created_at';
  const orderDir = sort === 'priority' ? 'ASC' : 'DESC';
  const lim = Math.min(parseInt(limit) || 50, 200);
  const off = parseInt(offset) || 0;

  const rows = db.prepare(`
    SELECT f.*, ak.name as api_key_name
    FROM feedback f
    LEFT JOIN api_keys ak ON f.api_key_id = ak.id
    ${whereClause}
    ORDER BY ${sortColumn} ${orderDir}
    LIMIT ? OFFSET ?
  `).all(...params, lim, off);

  const total = db.prepare(`SELECT COUNT(*) as count FROM feedback ${whereClause}`).get(...params);

  // Summary counts
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as new_count,
      SUM(CASE WHEN status = 'triaged' THEN 1 ELSE 0 END) as triaged_count,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress_count,
      SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved_count,
      SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed_count,
      SUM(CASE WHEN priority = 'critical' THEN 1 ELSE 0 END) as critical_count,
      SUM(CASE WHEN priority = 'high' THEN 1 ELSE 0 END) as high_count,
      SUM(CASE WHEN type = 'bug' THEN 1 ELSE 0 END) as bug_count,
      SUM(CASE WHEN type = 'feature' THEN 1 ELSE 0 END) as feature_count
  `).get();

  res.json({
    feedback: rows.map(r => ({ ...r, screenshot_data: r.screenshot_data ? '[attached]' : '' })),
    total: total.count,
    stats,
  });
});

// GET /feedback/stats/summary — aggregated stats for dashboard cards
router.get('/feedback/stats/summary', masterAuth, (req, res) => {
  const byType = db.prepare('SELECT type, COUNT(*) as count FROM feedback GROUP BY type').all();
  const byCategory = db.prepare('SELECT category, COUNT(*) as count FROM feedback GROUP BY category ORDER BY count DESC').all();
  const byPriority = db.prepare('SELECT priority, COUNT(*) as count FROM feedback GROUP BY priority').all();
  const byStatus = db.prepare('SELECT status, COUNT(*) as count FROM feedback GROUP BY status').all();
  const bySource = db.prepare('SELECT source, COUNT(*) as count FROM feedback GROUP BY source').all();
  const recent = db.prepare('SELECT COUNT(*) as count FROM feedback WHERE created_at >= datetime("now", "-7 days")').get();
  const unresolved = db.prepare('SELECT COUNT(*) as count FROM feedback WHERE status NOT IN ("resolved", "closed", "wont_fix", "duplicate")').get();

  res.json({ byType, byCategory, byPriority, byStatus, bySource, recentWeek: recent.count, unresolved: unresolved.count });
});

// GET /feedback/:id — get single feedback with full details
router.get('/feedback/:id', masterAuth, (req, res) => {
  const row = db.prepare(`
    SELECT f.*, ak.name as api_key_name
    FROM feedback f
    LEFT JOIN api_keys ak ON f.api_key_id = ak.id
    WHERE f.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

/* ========== CLASSIFY & UPDATE (master key) ========== */

// PATCH /feedback/:id — update classification, status, assignment, resolution
router.patch('/feedback/:id', masterAuth, (req, res) => {
  const row = db.prepare('SELECT id FROM feedback WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const { category, priority, status, assignedTo, resolutionNotes } = req.body;

  const updates = [];
  const params = [];

  if (category && VALID_CATEGORIES.includes(category)) { updates.push('category = ?'); params.push(category); }
  if (priority && VALID_PRIORITIES.includes(priority)) { updates.push('priority = ?'); params.push(priority); }
  if (status && VALID_STATUSES.includes(status)) { updates.push('status = ?'); params.push(status); }
  if (assignedTo !== undefined) { updates.push('assigned_to = ?'); params.push((assignedTo || '').substring(0, 200)); }
  if (resolutionNotes !== undefined) { updates.push('resolution_notes = ?'); params.push((resolutionNotes || '').substring(0, 5000)); }

  if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);

  db.prepare(`UPDATE feedback SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const updated = db.prepare('SELECT * FROM feedback WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// POST /feedback/:id/classify — batch classify (category + priority + status)
router.post('/feedback/:id/classify', masterAuth, (req, res) => {
  const row = db.prepare('SELECT id FROM feedback WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const { category, priority, status } = req.body;
  if (!category && !priority && !status) {
    return res.status(400).json({ error: 'Provide at least one of: category, priority, status' });
  }

  const cat = VALID_CATEGORIES.includes(category) ? category : undefined;
  const pri = VALID_PRIORITIES.includes(priority) ? priority : undefined;
  const sta = VALID_STATUSES.includes(status) ? status : undefined;

  const updates = [];
  const params = [];
  if (cat) { updates.push('category = ?'); params.push(cat); }
  if (pri) { updates.push('priority = ?'); params.push(pri); }
  if (sta) { updates.push('status = ?'); params.push(sta); }
  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);

  db.prepare(`UPDATE feedback SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  res.json({ success: true });
});

// POST /feedback/batch-classify — classify multiple items at once
router.post('/feedback/batch-classify', masterAuth, (req, res) => {
  const { ids, category, priority, status } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array required' });
  }
  if (ids.length > 100) {
    return res.status(400).json({ error: 'Max 100 items per batch' });
  }

  const updates = [];
  const params = [];
  if (category && VALID_CATEGORIES.includes(category)) { updates.push('category = ?'); params.push(category); }
  if (priority && VALID_PRIORITIES.includes(priority)) { updates.push('priority = ?'); params.push(priority); }
  if (status && VALID_STATUSES.includes(status)) { updates.push('status = ?'); params.push(status); }
  if (updates.length === 0) return res.status(400).json({ error: 'Provide category, priority, or status' });

  updates.push("updated_at = datetime('now')");

  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE feedback SET ${updates.join(', ')} WHERE id IN (${placeholders})`).run(...params, ...ids);

  res.json({ success: true, updated: ids.length });
});

// DELETE /feedback/:id
router.delete('/feedback/:id', masterAuth, (req, res) => {
  const result = db.prepare('DELETE FROM feedback WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

module.exports = router;
