/**
 * Analytics endpoints — fixations, heatmaps, funnels, page comparisons.
 */

const router = require('express').Router();
const { db } = require('../models/db');
const { authenticate } = require('../middleware/auth');
const analytics = require('../services/analytics');

// GET /analytics/heatmap/:sessionId — get heatmap data for a session
router.get('/analytics/heatmap/:sessionId', authenticate, (req, res) => {
  const gridCols = Math.max(5, Math.min(parseInt(req.query.gridCols) || 40, 100));
  const gridRows = Math.max(5, Math.min(parseInt(req.query.gridRows) || 30, 100));
  const url = req.query.url || null;

  const limit = Math.min(parseInt(req.query.limit) || 200000, 500000);
  let query = 'SELECT x, y, viewport_width, viewport_height FROM events WHERE session_id = ? AND type = \'gaze\'';
  const params = [req.params.sessionId];
  if (url) {
    query += ' AND url LIKE ?';
    params.push(`%${url}%`);
  }
  query += ' ORDER BY timestamp LIMIT ?';
  params.push(limit);

  const gaze = db.prepare(query).all(...params);
  const heatmap = analytics.aggregateHeatmap(gaze, gridCols, gridRows);
  res.json({ heatmap, gazeCount: gaze.length });
});

// GET /analytics/fixations/:sessionId
router.get('/analytics/fixations/:sessionId', authenticate, (req, res) => {
  const gaze = db.prepare(
    'SELECT x, y, timestamp FROM events WHERE session_id = ? AND type = \'gaze\' ORDER BY timestamp LIMIT 200000'
  ).all(req.params.sessionId);

  const fixations = analytics.detectFixations(gaze);
  res.json({
    fixations,
    count: fixations.length,
    avgDuration: fixations.length > 0
      ? Math.round(fixations.reduce((s, f) => s + f.duration, 0) / fixations.length)
      : 0,
  });
});

// GET /analytics/engagement/:sessionId
router.get('/analytics/engagement/:sessionId', authenticate, (req, res) => {
  const events = db.prepare(
    'SELECT type, timestamp, x, y FROM events WHERE session_id = ? ORDER BY timestamp LIMIT 200000'
  ).all(req.params.sessionId);

  const gaze = events.filter(e => e.type === 'gaze');
  const fixations = analytics.detectFixations(gaze);
  const engagement = analytics.computeEngagement(events, fixations);
  res.json({ engagement });
});

// POST /analytics/funnel — analyze attention funnel across URLs
router.post('/analytics/funnel', authenticate, (req, res) => {
  const { urls, sessionIds } = req.body;
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls array required' });
  }
  if (urls.length > 50) return res.status(400).json({ error: 'Too many URLs (max 50)' });
  for (const u of urls) {
    if (typeof u !== 'string' || u.length > 2000) {
      return res.status(400).json({ error: 'Invalid URL in list' });
    }
  }

  let events;
  if (sessionIds && Array.isArray(sessionIds) && sessionIds.length > 0) {
    if (sessionIds.length > 100) return res.status(400).json({ error: 'Too many session IDs' });
    for (const s of sessionIds) {
      if (typeof s !== 'string' || s.length > 100) {
        return res.status(400).json({ error: 'Invalid session ID' });
      }
    }
    const placeholders = sessionIds.map(() => '?').join(',');
    events = db.prepare(
      `SELECT session_id, type, timestamp, url FROM events WHERE session_id IN (${placeholders}) ORDER BY timestamp LIMIT 500000`
    ).all(...sessionIds);
  } else {
    // Use all sessions for this API key
    const sessions = db.prepare(
      'SELECT id FROM sessions WHERE api_key_id = ?'
    ).all(req.apiKey.id);
    const sids = sessions.map(s => s.id);
    if (sids.length === 0) return res.json({ funnel: [] });
    const placeholders = sids.map(() => '?').join(',');
    events = db.prepare(
      `SELECT session_id, type, timestamp, url FROM events WHERE session_id IN (${placeholders}) ORDER BY timestamp LIMIT 500000`
    ).all(...sids);
  }

  const funnel = analytics.analyzeFunnel(events, urls);
  res.json({ funnel });
});

// POST /analytics/compare — compare two pages
router.post('/analytics/compare', authenticate, (req, res) => {
  const { url1, url2, sessionIds } = req.body;
  if (!url1 || !url2) return res.status(400).json({ error: 'url1 and url2 required' });
  if (typeof url1 !== 'string' || url1.length > 2000 || typeof url2 !== 'string' || url2.length > 2000) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  let baseQuery = 'SELECT type, timestamp, x, y, url FROM events';
  let whereClause = '';
  const params1 = [];
  const params2 = [];

  if (sessionIds && Array.isArray(sessionIds) && sessionIds.length > 0) {
    const placeholders = sessionIds.map(() => '?').join(',');
    whereClause = ` WHERE session_id IN (${placeholders})`;
    params1.push(...sessionIds);
    params2.push(...sessionIds);
  }

  const allEvents = db.prepare(
    baseQuery + (whereClause || ' WHERE 1=1') + ' ORDER BY timestamp LIMIT 500000'
  ).all(...params1);

  const url1Events = allEvents.filter(e => e.url && e.url.includes(url1));
  const url2Events = allEvents.filter(e => e.url && e.url.includes(url2));

  const comparison = analytics.comparePages(url1Events, url2Events);
  res.json({ comparison });
});

// GET /analytics/timeline/:sessionId — gaze timeline
router.get('/analytics/timeline/:sessionId', authenticate, (req, res) => {
  const bucketMs = Math.max(100, Math.min(parseInt(req.query.bucket) || 1000, 60000));

  const gaze = db.prepare(
    'SELECT x, y, timestamp FROM events WHERE session_id = ? AND type = \'gaze\' ORDER BY timestamp LIMIT 200000'
  ).all(req.params.sessionId);

  if (gaze.length === 0) return res.json({ timeline: [] });

  const startTime = gaze[0].timestamp;
  const timeline = [];
  let bucketStart = startTime;
  let bucket = [];

  for (const point of gaze) {
    if (point.timestamp - bucketStart >= bucketMs) {
      if (bucket.length > 0) {
        const avgX = bucket.reduce((s, p) => s + p.x, 0) / bucket.length;
        const avgY = bucket.reduce((s, p) => s + p.y, 0) / bucket.length;
        timeline.push({
          time: bucketStart - startTime,
          x: Math.round(avgX * 1000) / 1000,
          y: Math.round(avgY * 1000) / 1000,
          count: bucket.length,
        });
      }
      bucketStart = point.timestamp;
      bucket = [];
    }
    bucket.push(point);
  }
  if (bucket.length > 0) {
    const avgX = bucket.reduce((s, p) => s + p.x, 0) / bucket.length;
    const avgY = bucket.reduce((s, p) => s + p.y, 0) / bucket.length;
    timeline.push({
      time: bucketStart - startTime,
      x: Math.round(avgX * 1000) / 1000,
      y: Math.round(avgY * 1000) / 1000,
      count: bucket.length,
    });
  }

  res.json({ timeline, duration: gaze[gaze.length - 1].timestamp - startTime });
});

// GET /analytics/overview — global overview stats
router.get('/analytics/overview', authenticate, (req, res) => {
  const keyFilter = req.apiKey.scopes.includes('admin') ? null : req.apiKey.id;

  const sessionCount = db.prepare(
    keyFilter
      ? 'SELECT COUNT(*) as count FROM sessions WHERE api_key_id = ?'
      : 'SELECT COUNT(*) as count FROM sessions'
  ).get(keyFilter || undefined);

  const eventCount = db.prepare(
    'SELECT COUNT(*) as count FROM events'
  ).get();

  const screenshotCount = db.prepare(
    'SELECT COUNT(*) as count FROM screenshots'
  ).get();

  const recentSessions = db.prepare(
    keyFilter
      ? 'SELECT id, session_name, start_time, end_time, event_count, screenshot_count FROM sessions WHERE api_key_id = ? ORDER BY start_time DESC LIMIT 10'
      : 'SELECT id, session_name, start_time, end_time, event_count, screenshot_count FROM sessions ORDER BY start_time DESC LIMIT 10'
  ).all(keyFilter || undefined);

  const eventsByType = db.prepare(
    'SELECT type, COUNT(*) as count FROM events GROUP BY type ORDER BY count DESC'
  ).all();

  res.json({
    sessions: sessionCount.count,
    events: eventCount.count,
    screenshots: screenshotCount.count,
    recentSessions,
    eventsByType,
  });
});

/* ========== URL-LEVEL HEATMAP AGGREGATION ========== */

// POST /analytics/heatmap/url — aggregate heatmap for a URL across sessions
router.post('/analytics/heatmap/url', authenticate, (req, res) => {
  const { url, sessionIds, deviceCategory, gridCols, gridRows } = req.body;
  if (!url || typeof url !== 'string' || url.length > 2000) {
    return res.status(400).json({ error: 'Valid url required' });
  }
  if (sessionIds && (!Array.isArray(sessionIds) || sessionIds.length > 200)) {
    return res.status(400).json({ error: 'sessionIds must be an array (max 200)' });
  }
  if (deviceCategory && !['all', 'mobile', 'tablet', 'desktop'].includes(deviceCategory)) {
    return res.status(400).json({ error: 'deviceCategory must be all, mobile, tablet, or desktop' });
  }

  const result = analytics.aggregateUrlHeatmap(url, {
    sessionIds,
    deviceCategory,
    gridCols: Math.max(5, Math.min(gridCols || 40, 100)),
    gridRows: Math.max(5, Math.min(gridRows || 30, 100)),
  });
  res.json(result);
});

/* ========== COHORT HEATMAP DECOMPOSITION ========== */

// POST /analytics/heatmap/cohort — decompose heatmap by cohort for a study
router.post('/analytics/heatmap/cohort', authenticate, (req, res) => {
  const { url, studyId, cohortField, deviceCategory, gridCols, gridRows } = req.body;
  if (!url || typeof url !== 'string' || url.length > 2000) {
    return res.status(400).json({ error: 'Valid url required' });
  }
  if (!studyId) return res.status(400).json({ error: 'studyId required' });

  const study = db.prepare('SELECT id FROM studies WHERE id = ?').get(studyId);
  if (!study) return res.status(404).json({ error: 'Study not found' });

  if (cohortField && typeof cohortField !== 'string') {
    return res.status(400).json({ error: 'cohortField must be a string' });
  }
  if (deviceCategory && !['all', 'mobile', 'tablet', 'desktop'].includes(deviceCategory)) {
    return res.status(400).json({ error: 'deviceCategory must be all, mobile, tablet, or desktop' });
  }

  const result = analytics.decomposeByCohort(url, studyId, {
    cohortField: cohortField || 'group',
    deviceCategory,
    gridCols: Math.max(5, Math.min(gridCols || 40, 100)),
    gridRows: Math.max(5, Math.min(gridRows || 30, 100)),
  });
  res.json(result);
});

/* ========== VIEWPORT DISTRIBUTION ========== */

// POST /analytics/viewports — get device/viewport breakdown for a URL or sessions
router.post('/analytics/viewports', authenticate, (req, res) => {
  const { url, sessionIds } = req.body;
  if (!url && (!sessionIds || !Array.isArray(sessionIds) || sessionIds.length === 0)) {
    return res.status(400).json({ error: 'url or sessionIds required' });
  }
  if (sessionIds && sessionIds.length > 200) {
    return res.status(400).json({ error: 'Too many session IDs (max 200)' });
  }

  const result = analytics.viewportDistribution(url, sessionIds);
  res.json(result);
});

/* ========== TIME TO FIRST FIXATION ========== */

// POST /analytics/ttff — time-to-first-fixation for AOIs
router.post('/analytics/ttff', authenticate, (req, res) => {
  const { sessionId, sessionIds, aois } = req.body;
  if (!Array.isArray(aois) || aois.length === 0) {
    return res.status(400).json({ error: 'aois array required' });
  }
  if (aois.length > 50) return res.status(400).json({ error: 'Too many AOIs (max 50)' });

  for (const aoi of aois) {
    if (!aoi.name || aoi.x == null || aoi.y == null || aoi.width == null || aoi.height == null) {
      return res.status(400).json({ error: 'Each AOI needs name, x, y, width, height (normalized 0-1)' });
    }
  }

  // Single session TTFF
  if (sessionId) {
    const result = analytics.timeToFirstFixation(sessionId, aois);
    return res.json({ results: result, sessionId });
  }

  // Aggregate TTFF across sessions
  if (sessionIds && Array.isArray(sessionIds) && sessionIds.length > 0) {
    if (sessionIds.length > 100) return res.status(400).json({ error: 'Too many session IDs (max 100)' });
    const result = analytics.aggregateTTFF(sessionIds, aois);
    return res.json({ results: result, sessions: sessionIds.length });
  }

  return res.status(400).json({ error: 'sessionId or sessionIds required' });
});

module.exports = router;
