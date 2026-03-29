/**
 * Task management endpoints — define research tasks/scenarios within studies,
 * track task instances per participant, and query task completion data.
 */

const router = require('express').Router();
const { db } = require('../models/db');
const { authenticate, masterAuth } = require('../middleware/auth');

/* ========== TASK DEFINITIONS ========== */

// POST /tasks — create a task within a study
router.post('/tasks', masterAuth, (req, res) => {
  const { studyId, name, description, instructions, targetUrl, successCriteria, sortOrder } = req.body;
  if (!studyId || !name) return res.status(400).json({ error: 'studyId and name required' });
  if (typeof name !== 'string' || name.length > 200) return res.status(400).json({ error: 'Invalid name' });

  const study = db.prepare('SELECT id FROM studies WHERE id = ?').get(studyId);
  if (!study) return res.status(404).json({ error: 'Study not found' });

  const result = db.prepare(
    `INSERT INTO tasks (study_id, name, description, instructions, target_url, success_criteria, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    studyId,
    name.substring(0, 200),
    (description || '').substring(0, 2000),
    (instructions || '').substring(0, 5000),
    (targetUrl || '').substring(0, 2000),
    (successCriteria || '').substring(0, 2000),
    sortOrder || 0
  );

  res.json({ ok: true, taskId: result.lastInsertRowid });
});

// GET /tasks/study/:studyId — list tasks for a study
router.get('/tasks/study/:studyId', authenticate, (req, res) => {
  const tasks = db.prepare(
    'SELECT * FROM tasks WHERE study_id = ? ORDER BY sort_order, id'
  ).all(req.params.studyId);
  res.json({ tasks });
});

// PUT /tasks/:id — update a task
router.put('/tasks/:id', masterAuth, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const { name, description, instructions, targetUrl, successCriteria, sortOrder } = req.body;
  db.prepare(
    `UPDATE tasks SET name = ?, description = ?, instructions = ?, target_url = ?,
     success_criteria = ?, sort_order = ? WHERE id = ?`
  ).run(
    (name || task.name).substring(0, 200),
    (description ?? task.description).substring(0, 2000),
    (instructions ?? task.instructions).substring(0, 5000),
    (targetUrl ?? task.target_url).substring(0, 2000),
    (successCriteria ?? task.success_criteria).substring(0, 2000),
    sortOrder ?? task.sort_order,
    req.params.id
  );
  res.json({ ok: true });
});

// DELETE /tasks/:id
router.delete('/tasks/:id', masterAuth, (req, res) => {
  db.prepare('DELETE FROM task_instances WHERE task_id = ?').run(req.params.id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* ========== TASK INSTANCES ========== */

// POST /tasks/:id/start — start a task instance for a session
router.post('/tasks/:id/start', authenticate, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const { sessionId, participantId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  const result = db.prepare(
    `INSERT INTO task_instances (task_id, session_id, participant_id, status, start_time)
     VALUES (?, ?, ?, 'in_progress', ?)`
  ).run(req.params.id, sessionId, participantId || '', Date.now());

  res.json({ ok: true, instanceId: result.lastInsertRowid });
});

// POST /tasks/instances/:id/complete — complete a task instance
router.post('/tasks/instances/:id/complete', authenticate, (req, res) => {
  const instance = db.prepare('SELECT * FROM task_instances WHERE id = ?').get(req.params.id);
  if (!instance) return res.status(404).json({ error: 'Task instance not found' });

  const { success, notes } = req.body;
  const endTime = Date.now();
  const duration = instance.start_time ? endTime - instance.start_time : 0;

  db.prepare(
    `UPDATE task_instances SET status = 'completed', end_time = ?, duration = ?,
     success = ?, notes = ? WHERE id = ?`
  ).run(endTime, duration, success ? 1 : 0, (notes || '').substring(0, 2000), req.params.id);

  res.json({ ok: true, duration });
});

// POST /tasks/instances/:id/abandon — mark task as abandoned
router.post('/tasks/instances/:id/abandon', authenticate, (req, res) => {
  const instance = db.prepare('SELECT * FROM task_instances WHERE id = ?').get(req.params.id);
  if (!instance) return res.status(404).json({ error: 'Task instance not found' });

  const { notes } = req.body;
  const endTime = Date.now();
  const duration = instance.start_time ? endTime - instance.start_time : 0;

  db.prepare(
    `UPDATE task_instances SET status = 'abandoned', end_time = ?, duration = ?,
     success = 0, notes = ? WHERE id = ?`
  ).run(endTime, duration, (notes || '').substring(0, 2000), req.params.id);

  res.json({ ok: true });
});

// GET /tasks/:id/instances — list all instances of a task
router.get('/tasks/:id/instances', authenticate, (req, res) => {
  const instances = db.prepare(
    `SELECT ti.*, t.name as task_name, t.study_id
     FROM task_instances ti JOIN tasks t ON t.id = ti.task_id
     WHERE ti.task_id = ? ORDER BY ti.start_time DESC`
  ).all(req.params.id);
  res.json({ instances });
});

// GET /tasks/session/:sessionId — list task instances for a session
router.get('/tasks/session/:sessionId', authenticate, (req, res) => {
  const instances = db.prepare(
    `SELECT ti.*, t.name as task_name, t.description, t.instructions
     FROM task_instances ti JOIN tasks t ON t.id = ti.task_id
     WHERE ti.session_id = ? ORDER BY ti.start_time`
  ).all(req.params.sessionId);
  res.json({ instances });
});

// GET /tasks/study/:studyId/summary — task completion summary for a study
router.get('/tasks/study/:studyId/summary', authenticate, (req, res) => {
  const tasks = db.prepare(
    'SELECT * FROM tasks WHERE study_id = ? ORDER BY sort_order, id'
  ).all(req.params.studyId);

  const summary = tasks.map(task => {
    const instances = db.prepare(
      'SELECT * FROM task_instances WHERE task_id = ?'
    ).all(task.id);

    const completed = instances.filter(i => i.status === 'completed');
    const successful = completed.filter(i => i.success);
    const abandoned = instances.filter(i => i.status === 'abandoned');
    const durations = completed.filter(i => i.duration > 0).map(i => i.duration);

    return {
      taskId: task.id,
      taskName: task.name,
      totalAttempts: instances.length,
      completed: completed.length,
      successful: successful.length,
      abandoned: abandoned.length,
      successRate: completed.length > 0
        ? Math.round((successful.length / completed.length) * 100)
        : 0,
      avgDuration: durations.length > 0
        ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length)
        : 0,
      medianDuration: durations.length > 0
        ? durations.sort((a, b) => a - b)[Math.floor(durations.length / 2)]
        : 0,
      minDuration: durations.length > 0 ? Math.min(...durations) : 0,
      maxDuration: durations.length > 0 ? Math.max(...durations) : 0,
    };
  });

  res.json({ summary });
});

module.exports = router;
