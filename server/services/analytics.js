/**
 * Server-side analytics engine.
 * Fixation detection, engagement scoring, funnel analysis, page comparisons.
 */

const { db } = require('../models/db');

/* ========== FIXATION DETECTION (I-DT) ========== */

const DISPERSION_THRESHOLD = 0.03; // 3% of viewport
const MIN_FIXATION_DURATION = 100; // ms

function detectFixations(gazeEvents) {
  if (gazeEvents.length < 2) return [];

  const fixations = [];
  let windowStart = 0;

  // Track min/max incrementally to avoid O(n²) slicing
  let minX = gazeEvents[0].x, maxX = gazeEvents[0].x;
  let minY = gazeEvents[0].y, maxY = gazeEvents[0].y;

  for (let windowEnd = 1; windowEnd < gazeEvents.length; windowEnd++) {
    const pt = gazeEvents[windowEnd];
    minX = Math.min(minX, pt.x);
    maxX = Math.max(maxX, pt.x);
    minY = Math.min(minY, pt.y);
    maxY = Math.max(maxY, pt.y);

    const dispersion = (maxX - minX) + (maxY - minY);

    if (dispersion <= DISPERSION_THRESHOLD) {
      continue; // expand window
    }

    // Window exceeded threshold — check if valid fixation (windowStart..windowEnd-1)
    const fixLen = windowEnd - windowStart;
    if (fixLen >= 2) {
      const duration = gazeEvents[windowEnd - 1].timestamp - gazeEvents[windowStart].timestamp;
      if (duration >= MIN_FIXATION_DURATION) {
        let sumX = 0, sumY = 0;
        for (let i = windowStart; i < windowEnd; i++) {
          sumX += gazeEvents[i].x;
          sumY += gazeEvents[i].y;
        }
        fixations.push({
          x: sumX / fixLen,
          y: sumY / fixLen,
          startTime: gazeEvents[windowStart].timestamp,
          endTime: gazeEvents[windowEnd - 1].timestamp,
          duration,
          pointCount: fixLen,
        });
      }
    }

    windowStart = windowEnd;
    // Reset min/max for new window starting at windowEnd
    minX = maxX = pt.x;
    minY = maxY = pt.y;
  }

  // Handle last window
  const remLen = gazeEvents.length - windowStart;
  if (remLen >= 2) {
    const duration = gazeEvents[gazeEvents.length - 1].timestamp - gazeEvents[windowStart].timestamp;
    if (duration >= MIN_FIXATION_DURATION) {
      let sumX = 0, sumY = 0;
      for (let i = windowStart; i < gazeEvents.length; i++) {
        sumX += gazeEvents[i].x;
        sumY += gazeEvents[i].y;
      }
      fixations.push({
        x: sumX / remLen,
        y: sumY / remLen,
        startTime: gazeEvents[windowStart].timestamp,
        endTime: gazeEvents[gazeEvents.length - 1].timestamp,
        duration,
        pointCount: remLen,
      });
    }
  }

  return fixations;
}

/* ========== ENGAGEMENT SCORING ========== */

function computeEngagement(events, fixations) {
  if (events.length === 0) return { score: 0, factors: {} };

  const duration = events[events.length - 1].timestamp - events[0].timestamp;
  if (duration <= 0) return { score: 0, factors: {} };

  // Stability: ratio of time in fixations vs total
  const fixationTime = fixations.reduce((s, f) => s + f.duration, 0);
  const stability = Math.min(fixationTime / duration, 1);

  // Depth: vertical spread of fixations
  const ys = fixations.map(f => f.y);
  const depth = ys.length > 0 ? Math.max(...ys) - Math.min(...ys) : 0;

  // Breadth: horizontal spread
  const xs = fixations.map(f => f.x);
  const breadth = xs.length > 0 ? Math.max(...xs) - Math.min(...xs) : 0;

  // Revisits: fixations returning to previously viewed areas
  let revisits = 0;
  const gridSize = 0.1;
  const visited = new Set();
  for (const f of fixations) {
    const cell = `${Math.floor(f.x / gridSize)},${Math.floor(f.y / gridSize)}`;
    if (visited.has(cell)) revisits++;
    visited.add(cell);
  }
  const revisitRate = fixations.length > 0 ? Math.min(revisits / fixations.length, 1) : 0;

  // Interaction density
  const interactionEvents = events.filter(e =>
    ['click', 'hover', 'scroll', 'touch'].includes(e.type)
  );
  const interactionRate = Math.min(interactionEvents.length / (duration / 1000), 5) / 5;

  const score = Math.round(
    (stability * 30 + depth * 20 + breadth * 15 + revisitRate * 15 + interactionRate * 20)
  );

  return {
    score: Math.min(score, 100),
    factors: { stability, depth, breadth, revisitRate, interactionRate },
    duration,
    fixationCount: fixations.length,
    interactionCount: interactionEvents.length,
  };
}

/* ========== ATTENTION FUNNEL ========== */

function analyzeFunnel(sessionEvents, urls) {
  const steps = urls.map(url => ({
    url,
    sessions: 0,
    avgDuration: 0,
    avgEngagement: 0,
    dropoffRate: 0,
  }));

  // Group events by session
  const bySession = new Map();
  for (const e of sessionEvents) {
    if (!bySession.has(e.session_id)) bySession.set(e.session_id, []);
    bySession.get(e.session_id).push(e);
  }

  let prevCount = bySession.size;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    let totalDuration = 0;
    let count = 0;

    for (const [, events] of bySession) {
      const urlEvents = events.filter(e => e.url && e.url.includes(url));
      if (urlEvents.length > 0) {
        count++;
        const dur = urlEvents[urlEvents.length - 1].timestamp - urlEvents[0].timestamp;
        totalDuration += dur;
      }
    }

    steps[i].sessions = count;
    steps[i].avgDuration = count > 0 ? Math.round(totalDuration / count) : 0;
    steps[i].dropoffRate = prevCount > 0 ? Math.round((1 - count / prevCount) * 100) : 0;
    prevCount = count;
  }

  return steps;
}

/* ========== PAGE COMPARISON ========== */

function comparePages(url1Events, url2Events) {
  const analyze = (events) => {
    const gaze = events.filter(e => e.type === 'gaze');
    const fixations = detectFixations(gaze);
    const engagement = computeEngagement(events, fixations);
    const clicks = events.filter(e => e.type === 'click').length;
    const scrolls = events.filter(e => e.type === 'scroll' || e.type === 'scrollMilestone').length;
    const duration = events.length > 1
      ? events[events.length - 1].timestamp - events[0].timestamp
      : 0;

    return {
      gazePoints: gaze.length,
      fixationCount: fixations.length,
      avgFixationDuration: fixations.length > 0
        ? Math.round(fixations.reduce((s, f) => s + f.duration, 0) / fixations.length)
        : 0,
      engagement: engagement.score,
      clicks,
      scrolls,
      duration,
    };
  };

  return {
    page1: analyze(url1Events),
    page2: analyze(url2Events),
  };
}

/* ========== HEATMAP AGGREGATION ========== */

/**
 * Aggregate gaze events into a heatmap grid.
 * Works in normalized 0-1 coordinate space so different device viewports
 * are directly comparable. gridCols/gridRows define the resolution of
 * the output grid (e.g. 40x30 = 1200 cells).
 *
 * Each cell contains: normalized x/y position, count, and intensity.
 * The consumer maps cells to pixels at render time using their display resolution.
 */
function aggregateHeatmap(gazeEvents, gridCols = 40, gridRows = 30) {
  const grid = new Map();
  for (const e of gazeEvents) {
    if (e.x == null || e.y == null) continue;
    // Clamp to 0-1 range (data should already be normalized)
    const nx = Math.max(0, Math.min(1, e.x));
    const ny = Math.max(0, Math.min(1, e.y));
    const gx = Math.min(Math.floor(nx * gridCols), gridCols - 1);
    const gy = Math.min(Math.floor(ny * gridRows), gridRows - 1);
    const key = `${gx},${gy}`;
    grid.set(key, (grid.get(key) || 0) + 1);
  }

  const cells = [];
  let maxCount = 0;
  const cellW = 1 / gridCols;
  const cellH = 1 / gridRows;
  for (const [key, count] of grid) {
    const [gx, gy] = key.split(',').map(Number);
    cells.push({
      // Normalized 0-1 positions — consumer maps to pixels at render time
      x: gx * cellW,
      y: gy * cellH,
      width: cellW,
      height: cellH,
      col: gx,
      row: gy,
      count,
    });
    if (count > maxCount) maxCount = count;
  }

  for (const cell of cells) {
    cell.intensity = maxCount > 0 ? cell.count / maxCount : 0;
  }

  return { cells, maxCount, gridCols, gridRows };
}

/* ========== DEVICE CATEGORIZATION ========== */

const DEVICE_CATEGORIES = {
  mobile:  { minW: 0,    maxW: 768  },
  tablet:  { minW: 769,  maxW: 1024 },
  desktop: { minW: 1025, maxW: 99999 },
};

function categorizeDevice(viewportWidth) {
  if (viewportWidth == null || viewportWidth <= 0) return 'unknown';
  for (const [name, range] of Object.entries(DEVICE_CATEGORIES)) {
    if (viewportWidth >= range.minW && viewportWidth <= range.maxW) return name;
  }
  return 'desktop';
}

/**
 * Group events by device category based on viewport_width.
 * Returns { mobile: [...], tablet: [...], desktop: [...], unknown: [...] }.
 */
function groupByDevice(events) {
  const groups = { mobile: [], tablet: [], desktop: [], unknown: [] };
  for (const e of events) {
    const cat = categorizeDevice(e.viewport_width);
    groups[cat].push(e);
  }
  return groups;
}

/* ========== URL-LEVEL HEATMAP AGGREGATION ========== */

/**
 * Aggregate heatmap for a specific URL across multiple sessions.
 * Supports optional device category filter.
 * Returns the heatmap + device breakdown stats.
 */
function aggregateUrlHeatmap(url, opts = {}) {
  const { sessionIds, deviceCategory, gridCols, gridRows, limit } = Object.assign(
    { gridCols: 40, gridRows: 30, limit: 300000 }, opts
  );

  let query, params;
  if (sessionIds && sessionIds.length > 0) {
    const placeholders = sessionIds.map(() => '?').join(',');
    query = `SELECT x, y, viewport_width, viewport_height FROM events
             WHERE session_id IN (${placeholders}) AND type = 'gaze' AND url LIKE ?
             ORDER BY timestamp LIMIT ?`;
    params = [...sessionIds, `%${url}%`, limit];
  } else {
    query = `SELECT x, y, viewport_width, viewport_height FROM events
             WHERE type = 'gaze' AND url LIKE ?
             ORDER BY timestamp LIMIT ?`;
    params = [`%${url}%`, limit];
  }

  let events = db.prepare(query).all(...params);

  // Device breakdown before filtering
  const deviceBreakdown = {};
  for (const e of events) {
    const cat = categorizeDevice(e.viewport_width);
    deviceBreakdown[cat] = (deviceBreakdown[cat] || 0) + 1;
  }

  // Filter by device category if requested
  if (deviceCategory && deviceCategory !== 'all') {
    events = events.filter(e => categorizeDevice(e.viewport_width) === deviceCategory);
  }

  const heatmap = aggregateHeatmap(events, gridCols, gridRows);

  return {
    url,
    heatmap,
    totalPoints: events.length,
    deviceBreakdown,
    deviceFilter: deviceCategory || 'all',
  };
}

/* ========== COHORT HEATMAP DECOMPOSITION ========== */

/**
 * Decompose heatmap by cohort for a given URL within a study.
 * Cohort is determined by participant group_name or a metadata field.
 *
 * Returns per-cohort heatmaps with the same grid so they're directly comparable.
 */
function decomposeByCohort(url, studyId, opts = {}) {
  const { cohortField, deviceCategory, gridCols, gridRows, limit } = Object.assign(
    { cohortField: 'group', gridCols: 40, gridRows: 30, limit: 300000 }, opts
  );

  // Get participants and their cohort assignment
  const participants = db.prepare(
    'SELECT participant_id, group_name, metadata FROM participants WHERE study_id = ?'
  ).all(studyId);

  if (participants.length === 0) return { cohorts: {}, url, studyId };

  // Determine cohort value for each participant
  const participantCohort = new Map();
  for (const p of participants) {
    let cohortValue;
    if (cohortField === 'group') {
      cohortValue = p.group_name || 'default';
    } else {
      // Look up in participant metadata JSON
      try {
        const meta = JSON.parse(p.metadata || '{}');
        cohortValue = String(meta[cohortField] || 'unknown');
      } catch {
        cohortValue = 'unknown';
      }
    }
    participantCohort.set(p.participant_id, cohortValue);
  }

  // Get unique cohort values
  const cohortValues = [...new Set(participantCohort.values())];

  // Get sessions for this study
  const sessions = db.prepare(
    'SELECT id, participant_id FROM sessions WHERE study_id = ?'
  ).all(studyId);

  // Group session IDs by cohort
  const sessionsByCohort = {};
  for (const val of cohortValues) sessionsByCohort[val] = [];
  for (const s of sessions) {
    const cohort = participantCohort.get(s.participant_id);
    if (cohort && sessionsByCohort[cohort]) {
      sessionsByCohort[cohort].push(s.id);
    }
  }

  // Build heatmap for each cohort
  const cohorts = {};
  const perCohortLimit = Math.floor(limit / Math.max(cohortValues.length, 1));

  for (const [cohortValue, sids] of Object.entries(sessionsByCohort)) {
    if (sids.length === 0) {
      cohorts[cohortValue] = {
        heatmap: { cells: [], maxCount: 0, gridCols, gridRows },
        sessions: 0,
        totalPoints: 0,
        deviceBreakdown: {},
      };
      continue;
    }

    const placeholders = sids.map(() => '?').join(',');
    let events = db.prepare(
      `SELECT x, y, viewport_width, viewport_height FROM events
       WHERE session_id IN (${placeholders}) AND type = 'gaze' AND url LIKE ?
       ORDER BY timestamp LIMIT ?`
    ).all(...sids, `%${url}%`, perCohortLimit);

    // Device breakdown
    const deviceBreakdown = {};
    for (const e of events) {
      const cat = categorizeDevice(e.viewport_width);
      deviceBreakdown[cat] = (deviceBreakdown[cat] || 0) + 1;
    }

    if (deviceCategory && deviceCategory !== 'all') {
      events = events.filter(e => categorizeDevice(e.viewport_width) === deviceCategory);
    }

    cohorts[cohortValue] = {
      heatmap: aggregateHeatmap(events, gridCols, gridRows),
      sessions: sids.length,
      totalPoints: events.length,
      deviceBreakdown,
    };
  }

  // Also compute the combined heatmap across all cohorts for reference
  const allSessionIds = sessions.map(s => s.id);
  let allUrl;
  if (allSessionIds.length > 0) {
    const ph = allSessionIds.map(() => '?').join(',');
    let allEvents = db.prepare(
      `SELECT x, y, viewport_width FROM events
       WHERE session_id IN (${ph}) AND type = 'gaze' AND url LIKE ?
       ORDER BY timestamp LIMIT ?`
    ).all(...allSessionIds, `%${url}%`, limit);

    if (deviceCategory && deviceCategory !== 'all') {
      allEvents = allEvents.filter(e => categorizeDevice(e.viewport_width) === deviceCategory);
    }
    allUrl = {
      heatmap: aggregateHeatmap(allEvents, gridCols, gridRows),
      totalPoints: allEvents.length,
    };
  } else {
    allUrl = { heatmap: { cells: [], maxCount: 0, gridCols, gridRows }, totalPoints: 0 };
  }

  return {
    url,
    studyId,
    cohortField,
    deviceFilter: deviceCategory || 'all',
    combined: allUrl,
    cohorts,
  };
}

/**
 * Get device viewport distribution for a URL or set of sessions.
 * Returns viewport size buckets and device category counts.
 */
function viewportDistribution(url, sessionIds) {
  let query, params;
  if (sessionIds && sessionIds.length > 0) {
    const ph = sessionIds.map(() => '?').join(',');
    query = `SELECT DISTINCT session_id,
               CAST(viewport_width AS INT) as vw, CAST(viewport_height AS INT) as vh
             FROM events
             WHERE session_id IN (${ph}) AND type = 'gaze' AND viewport_width IS NOT NULL
             GROUP BY session_id`;
    params = [...sessionIds];
  } else if (url) {
    query = `SELECT DISTINCT session_id,
               CAST(viewport_width AS INT) as vw, CAST(viewport_height AS INT) as vh
             FROM events
             WHERE type = 'gaze' AND url LIKE ? AND viewport_width IS NOT NULL
             GROUP BY session_id`;
    params = [`%${url}%`];
  } else {
    return { devices: {}, viewports: [] };
  }

  const rows = db.prepare(query).all(...params);

  const devices = { mobile: 0, tablet: 0, desktop: 0, unknown: 0 };
  const viewportSizes = new Map();
  for (const r of rows) {
    const cat = categorizeDevice(r.vw);
    devices[cat]++;
    const sizeKey = `${r.vw}x${r.vh}`;
    viewportSizes.set(sizeKey, (viewportSizes.get(sizeKey) || 0) + 1);
  }

  return {
    devices,
    totalSessions: rows.length,
    viewports: [...viewportSizes.entries()]
      .map(([size, count]) => ({ size, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20),
  };
}

/* ========== SESSION SUMMARY ========== */

function sessionSummary(sessionId) {
  // Get event count first to avoid loading huge datasets entirely
  const countRow = db.prepare(
    'SELECT COUNT(*) as cnt FROM events WHERE session_id = ?'
  ).get(sessionId);
  if (!countRow || countRow.cnt === 0) return null;

  const MAX_EVENTS = 200000;
  const totalEvents = countRow.cnt;
  const limited = totalEvents > MAX_EVENTS;

  const events = db.prepare(
    'SELECT type, timestamp, x, y, url, extra FROM events WHERE session_id = ? ORDER BY timestamp LIMIT ?'
  ).all(sessionId, MAX_EVENTS);

  const gaze = events.filter(e => e.type === 'gaze');
  const fixations = detectFixations(gaze);
  const engagement = computeEngagement(events, fixations);
  const heatmap = aggregateHeatmap(gaze);

  // URL breakdown
  const urlStats = new Map();
  for (const e of events) {
    if (!e.url) continue;
    if (!urlStats.has(e.url)) urlStats.set(e.url, { count: 0, types: {} });
    const stat = urlStats.get(e.url);
    stat.count++;
    stat.types[e.type] = (stat.types[e.type] || 0) + 1;
  }

  // Event type breakdown
  const typeCounts = {};
  for (const e of events) {
    typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
  }

  return {
    sessionId,
    totalEvents,
    limited,
    duration: events[events.length - 1].timestamp - events[0].timestamp,
    typeCounts,
    gazePoints: gaze.length,
    fixations: fixations.length,
    avgFixationDuration: fixations.length > 0
      ? Math.round(fixations.reduce((s, f) => s + f.duration, 0) / fixations.length)
      : 0,
    engagement,
    heatmap,
    urls: Object.fromEntries(urlStats),
  };
}

module.exports = {
  detectFixations,
  computeEngagement,
  analyzeFunnel,
  comparePages,
  aggregateHeatmap,
  sessionSummary,
  categorizeDevice,
  groupByDevice,
  aggregateUrlHeatmap,
  decomposeByCohort,
  viewportDistribution,
};
