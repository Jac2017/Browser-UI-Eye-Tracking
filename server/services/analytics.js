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

function aggregateHeatmap(gazeEvents, gridSize = 50) {
  const grid = new Map();
  for (const e of gazeEvents) {
    if (e.x == null || e.y == null) continue;
    // Convert normalized coords to grid cells
    const gx = Math.floor((e.x * 1920) / gridSize);
    const gy = Math.floor((e.y * 1080) / gridSize);
    const key = `${gx},${gy}`;
    grid.set(key, (grid.get(key) || 0) + 1);
  }

  const cells = [];
  let maxCount = 0;
  for (const [key, count] of grid) {
    const [gx, gy] = key.split(',').map(Number);
    cells.push({
      x: gx * gridSize,
      y: gy * gridSize,
      width: gridSize,
      height: gridSize,
      count,
    });
    if (count > maxCount) maxCount = count;
  }

  // Normalize intensities
  for (const cell of cells) {
    cell.intensity = maxCount > 0 ? cell.count / maxCount : 0;
  }

  return { cells, maxCount, gridSize };
}

/* ========== SESSION SUMMARY ========== */

function sessionSummary(sessionId) {
  const events = db.prepare(
    'SELECT type, timestamp, x, y, url, extra FROM events WHERE session_id = ? ORDER BY timestamp'
  ).all(sessionId);

  if (events.length === 0) return null;

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
    totalEvents: events.length,
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
};
