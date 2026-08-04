#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultDbPath = path.join(__dirname, '..', 'server', 'data', 'eyed.db');
const dbPath = process.env.EYED_DB || defaultDbPath;

let db;
function getDb() {
  if (db) return db;
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database not found at ${dbPath}. Set EYED_DB env var or run the EyeD server first.`);
  }
  db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  db.pragma('cache_size = -32000');
  return db;
}

// ── Analytics helpers (ported from server/services/analytics.js) ─────────

const DISPERSION_THRESHOLD = 0.03;
const MIN_FIXATION_DURATION = 100;

function detectFixations(gazeEvents) {
  if (gazeEvents.length < 2) return [];
  const fixations = [];
  let windowStart = 0;
  let minX = gazeEvents[0].x, maxX = gazeEvents[0].x;
  let minY = gazeEvents[0].y, maxY = gazeEvents[0].y;

  for (let windowEnd = 1; windowEnd < gazeEvents.length; windowEnd++) {
    const pt = gazeEvents[windowEnd];
    minX = Math.min(minX, pt.x);
    maxX = Math.max(maxX, pt.x);
    minY = Math.min(minY, pt.y);
    maxY = Math.max(maxY, pt.y);
    const dispersion = (maxX - minX) + (maxY - minY);

    if (dispersion <= DISPERSION_THRESHOLD) continue;

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
          x: sumX / fixLen, y: sumY / fixLen,
          startTime: gazeEvents[windowStart].timestamp,
          endTime: gazeEvents[windowEnd - 1].timestamp,
          duration, pointCount: fixLen,
        });
      }
    }
    windowStart = windowEnd;
    minX = maxX = pt.x;
    minY = maxY = pt.y;
  }

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
        x: sumX / remLen, y: sumY / remLen,
        startTime: gazeEvents[windowStart].timestamp,
        endTime: gazeEvents[gazeEvents.length - 1].timestamp,
        duration, pointCount: remLen,
      });
    }
  }
  return fixations;
}

function computeEngagement(events, fixations) {
  if (events.length === 0) return { score: 0, factors: {} };
  const duration = events[events.length - 1].timestamp - events[0].timestamp;
  if (duration <= 0) return { score: 0, factors: {} };

  const fixationTime = fixations.reduce((s, f) => s + f.duration, 0);
  const stability = Math.min(fixationTime / duration, 1);
  const ys = fixations.map(f => f.y);
  const depth = ys.length > 0 ? Math.max(...ys) - Math.min(...ys) : 0;
  const xs = fixations.map(f => f.x);
  const breadth = xs.length > 0 ? Math.max(...xs) - Math.min(...xs) : 0;

  let revisits = 0;
  const visited = new Set();
  for (const f of fixations) {
    const cell = `${Math.floor(f.x / 0.1)},${Math.floor(f.y / 0.1)}`;
    if (visited.has(cell)) revisits++;
    visited.add(cell);
  }
  const revisitRate = fixations.length > 0 ? Math.min(revisits / fixations.length, 1) : 0;

  const interactionEvents = events.filter(e => ['click', 'hover', 'scroll', 'touch'].includes(e.type));
  const interactionRate = Math.min(interactionEvents.length / (duration / 1000), 5) / 5;

  const score = Math.round(
    stability * 30 + depth * 20 + breadth * 15 + revisitRate * 15 + interactionRate * 20
  );

  return {
    score: Math.min(score, 100),
    factors: { stability, depth, breadth, revisitRate, interactionRate },
    duration, fixationCount: fixations.length, interactionCount: interactionEvents.length,
  };
}

function aggregateHeatmap(gazeEvents, gridCols = 40, gridRows = 30) {
  const grid = new Map();
  for (const e of gazeEvents) {
    if (e.x == null || e.y == null) continue;
    const nx = Math.max(0, Math.min(1, e.x));
    const ny = Math.max(0, Math.min(1, e.y));
    const gx = Math.min(Math.floor(nx * gridCols), gridCols - 1);
    const gy = Math.min(Math.floor(ny * gridRows), gridRows - 1);
    const key = `${gx},${gy}`;
    grid.set(key, (grid.get(key) || 0) + 1);
  }

  const cells = [];
  let maxCount = 0;
  const cellW = 1 / gridCols, cellH = 1 / gridRows;
  for (const [key, count] of grid) {
    const [gx, gy] = key.split(',').map(Number);
    cells.push({ x: gx * cellW, y: gy * cellH, width: cellW, height: cellH, col: gx, row: gy, count });
    if (count > maxCount) maxCount = count;
  }
  for (const cell of cells) cell.intensity = maxCount > 0 ? cell.count / maxCount : 0;
  return { cells, maxCount, gridCols, gridRows };
}

function categorizeDevice(vw) {
  if (vw == null || vw <= 0) return 'unknown';
  if (vw <= 768) return 'mobile';
  if (vw <= 1024) return 'tablet';
  return 'desktop';
}

// ── MCP Server ───────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'eyed-mcp-server',
  version: '1.0.0',
  description: 'MCP server for EyeD browser-based eye-tracking research platform. Provides read-only access to eye-tracking sessions, gaze data, analytics (fixations, engagement, heatmaps), research studies, and data export.',
});

// ── Tool: get_overview ───────────────────────────────────────────────────

server.tool(
  'get_overview',
  'Get global overview statistics: session count, event count, screenshot count, recent sessions, and event type breakdown.',
  {},
  async () => {
    const d = getDb();
    const sessionCount = d.prepare('SELECT COUNT(*) as count FROM sessions').get();
    const eventCount = d.prepare('SELECT COUNT(*) as count FROM events').get();
    const screenshotCount = d.prepare('SELECT COUNT(*) as count FROM screenshots').get();
    const recentSessions = d.prepare(
      'SELECT id, session_name, start_time, end_time, event_count, screenshot_count, participant_id, study_id FROM sessions ORDER BY start_time DESC LIMIT 10'
    ).all();
    const eventsByType = d.prepare(
      'SELECT type, COUNT(*) as count FROM events GROUP BY type ORDER BY count DESC'
    ).all();
    const studyCount = d.prepare('SELECT COUNT(*) as count FROM studies').get();

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          sessions: sessionCount.count,
          events: eventCount.count,
          screenshots: screenshotCount.count,
          studies: studyCount.count,
          recentSessions,
          eventsByType,
        }, null, 2),
      }],
    };
  }
);

// ── Tool: list_sessions ──────────────────────────────────────────────────

server.tool(
  'list_sessions',
  'List eye-tracking sessions with optional filters. Returns session metadata including duration, event counts, participant, and study association.',
  {
    limit: z.number().min(1).max(200).default(50).describe('Max sessions to return'),
    offset: z.number().min(0).default(0).describe('Pagination offset'),
    status: z.enum(['all', 'active', 'ended']).default('all').describe('Filter by session status'),
    participantId: z.string().optional().describe('Filter by participant ID'),
    studyId: z.number().optional().describe('Filter by study ID'),
    search: z.string().optional().describe('Search session names'),
    tag: z.string().optional().describe('Filter by session tag'),
  },
  async ({ limit, offset, status, participantId, studyId, search, tag }) => {
    const d = getDb();
    const where = [];
    const params = [];

    if (status === 'active') { where.push('s.end_time IS NULL'); }
    else if (status === 'ended') { where.push('s.end_time IS NOT NULL'); }
    if (participantId) { where.push('s.participant_id = ?'); params.push(participantId); }
    if (studyId) { where.push('s.study_id = ?'); params.push(studyId); }
    if (search) { where.push('s.session_name LIKE ?'); params.push(`%${search.substring(0, 100)}%`); }
    if (tag) {
      where.push('EXISTS (SELECT 1 FROM session_tags st WHERE st.session_id = s.id AND st.tag = ?)');
      params.push(tag);
    }

    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    params.push(limit, offset);

    const sessions = d.prepare(`
      SELECT s.*, COUNT(e.id) as actual_event_count
      FROM sessions s LEFT JOIN events e ON e.session_id = s.id
      ${whereClause}
      GROUP BY s.id ORDER BY s.start_time DESC LIMIT ? OFFSET ?
    `).all(...params);

    const sessionIds = sessions.map(s => s.id);
    const tagMap = {};
    if (sessionIds.length > 0) {
      const ph = sessionIds.map(() => '?').join(',');
      const tags = d.prepare(`SELECT session_id, tag FROM session_tags WHERE session_id IN (${ph})`).all(...sessionIds);
      for (const t of tags) {
        if (!tagMap[t.session_id]) tagMap[t.session_id] = [];
        tagMap[t.session_id].push(t.tag);
      }
    }
    for (const s of sessions) s.tags = tagMap[s.id] || [];

    return { content: [{ type: 'text', text: JSON.stringify({ sessions, total: sessions.length }, null, 2) }] };
  }
);

// ── Tool: get_session ────────────────────────────────────────────────────

server.tool(
  'get_session',
  'Get detailed information about a specific eye-tracking session, including tags and annotations.',
  {
    sessionId: z.string().describe('Session ID'),
  },
  async ({ sessionId }) => {
    const d = getDb();
    const session = d.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!session) return { content: [{ type: 'text', text: 'Session not found' }], isError: true };

    const tags = d.prepare('SELECT tag FROM session_tags WHERE session_id = ?').all(sessionId).map(t => t.tag);
    const annotations = d.prepare('SELECT * FROM session_annotations WHERE session_id = ? ORDER BY COALESCE(timestamp, 0), created_at').all(sessionId);
    const screenshotCount = d.prepare('SELECT COUNT(*) as count FROM screenshots WHERE session_id = ?').get(sessionId);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ session, tags, annotations, screenshotCount: screenshotCount.count }, null, 2),
      }],
    };
  }
);

// ── Tool: get_session_summary ────────────────────────────────────────────

server.tool(
  'get_session_summary',
  'Get a comprehensive analytics summary for a session: event counts by type, gaze statistics, fixation analysis, engagement score, heatmap data, and URL breakdown.',
  {
    sessionId: z.string().describe('Session ID to analyze'),
  },
  async ({ sessionId }) => {
    const d = getDb();
    const session = d.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!session) return { content: [{ type: 'text', text: 'Session not found' }], isError: true };

    const countRow = d.prepare('SELECT COUNT(*) as cnt FROM events WHERE session_id = ?').get(sessionId);
    if (!countRow || countRow.cnt === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ sessionId, totalEvents: 0, message: 'No events found' }) }] };
    }

    const MAX_EVENTS = 200000;
    const events = d.prepare('SELECT type, timestamp, x, y, url, extra FROM events WHERE session_id = ? ORDER BY timestamp LIMIT ?').all(sessionId, MAX_EVENTS);

    const gaze = events.filter(e => e.type === 'gaze');
    const fixations = detectFixations(gaze);
    const engagement = computeEngagement(events, fixations);
    const heatmap = aggregateHeatmap(gaze);

    const urlStats = new Map();
    for (const e of events) {
      if (!e.url) continue;
      if (!urlStats.has(e.url)) urlStats.set(e.url, { count: 0, types: {} });
      const stat = urlStats.get(e.url);
      stat.count++;
      stat.types[e.type] = (stat.types[e.type] || 0) + 1;
    }

    const typeCounts = {};
    for (const e of events) typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;

    const summary = {
      sessionId,
      totalEvents: countRow.cnt,
      limited: countRow.cnt > MAX_EVENTS,
      duration: events.length > 1 ? events[events.length - 1].timestamp - events[0].timestamp : 0,
      typeCounts,
      gazePoints: gaze.length,
      fixations: fixations.length,
      avgFixationDuration: fixations.length > 0
        ? Math.round(fixations.reduce((s, f) => s + f.duration, 0) / fixations.length) : 0,
      engagement,
      heatmap: { gridCols: heatmap.gridCols, gridRows: heatmap.gridRows, maxCount: heatmap.maxCount, cellCount: heatmap.cells.length },
      urls: Object.fromEntries(urlStats),
    };

    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
  }
);

// ── Tool: query_events ───────────────────────────────────────────────────

server.tool(
  'query_events',
  'Query raw eye-tracking events with filters. Event types include: gaze, click, scroll, hover, touch, formFocus, formBlur, formSubmit, pagePerformance, webVital, rageClick, deadClick, textSelection, navigation, visibility, scrollMilestone, elementVisible.',
  {
    sessionId: z.string().describe('Session ID'),
    type: z.string().optional().describe('Filter by event type (e.g., gaze, click, scroll)'),
    url: z.string().optional().describe('Filter events by URL (partial match)'),
    limit: z.number().min(1).max(10000).default(1000).describe('Max events to return'),
    offset: z.number().min(0).default(0).describe('Pagination offset'),
  },
  async ({ sessionId, type, url, limit, offset }) => {
    const d = getDb();
    let query = 'SELECT id, type, timestamp, url, tab_id, x, y, page_x, page_y, scroll_x, scroll_y, viewport_width, viewport_height, extra FROM events WHERE session_id = ?';
    const params = [sessionId];
    if (type) { query += ' AND type = ?'; params.push(type); }
    if (url) { query += ' AND url LIKE ?'; params.push(`%${url}%`); }
    query += ' ORDER BY timestamp LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const events = d.prepare(query).all(...params);
    const total = d.prepare(
      `SELECT COUNT(*) as cnt FROM events WHERE session_id = ?${type ? ' AND type = ?' : ''}${url ? ' AND url LIKE ?' : ''}`
    ).get(...[sessionId, ...(type ? [type] : []), ...(url ? [`%${url}%`] : [])]);

    return { content: [{ type: 'text', text: JSON.stringify({ events, total: total.cnt, returned: events.length }, null, 2) }] };
  }
);

// ── Tool: get_heatmap ────────────────────────────────────────────────────

server.tool(
  'get_heatmap',
  'Get heatmap data for a session. Returns a grid of normalized cells with gaze density. Optionally filter by URL.',
  {
    sessionId: z.string().describe('Session ID'),
    url: z.string().optional().describe('Filter by URL (partial match)'),
    gridCols: z.number().min(5).max(100).default(40).describe('Heatmap grid columns'),
    gridRows: z.number().min(5).max(100).default(30).describe('Heatmap grid rows'),
  },
  async ({ sessionId, url, gridCols, gridRows }) => {
    const d = getDb();
    let query = "SELECT x, y FROM events WHERE session_id = ? AND type = 'gaze'";
    const params = [sessionId];
    if (url) { query += ' AND url LIKE ?'; params.push(`%${url}%`); }
    query += ' ORDER BY timestamp LIMIT 200000';

    const gaze = d.prepare(query).all(...params);
    const heatmap = aggregateHeatmap(gaze, gridCols, gridRows);

    return { content: [{ type: 'text', text: JSON.stringify({ heatmap, gazeCount: gaze.length }, null, 2) }] };
  }
);

// ── Tool: get_fixations ──────────────────────────────────────────────────

server.tool(
  'get_fixations',
  'Detect fixations in a session using the I-DT (dispersion threshold) algorithm. Returns fixation locations, durations, and statistics.',
  {
    sessionId: z.string().describe('Session ID'),
  },
  async ({ sessionId }) => {
    const d = getDb();
    const gaze = d.prepare(
      "SELECT x, y, timestamp FROM events WHERE session_id = ? AND type = 'gaze' ORDER BY timestamp LIMIT 200000"
    ).all(sessionId);

    const fixations = detectFixations(gaze);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          fixations,
          count: fixations.length,
          avgDuration: fixations.length > 0
            ? Math.round(fixations.reduce((s, f) => s + f.duration, 0) / fixations.length) : 0,
          totalGazePoints: gaze.length,
        }, null, 2),
      }],
    };
  }
);

// ── Tool: get_engagement ─────────────────────────────────────────────────

server.tool(
  'get_engagement',
  'Compute engagement score (0-100) for a session based on gaze stability, visual depth/breadth, revisit patterns, and interaction density.',
  {
    sessionId: z.string().describe('Session ID'),
  },
  async ({ sessionId }) => {
    const d = getDb();
    const events = d.prepare(
      'SELECT type, timestamp, x, y FROM events WHERE session_id = ? ORDER BY timestamp LIMIT 200000'
    ).all(sessionId);

    const gaze = events.filter(e => e.type === 'gaze');
    const fixations = detectFixations(gaze);
    const engagement = computeEngagement(events, fixations);

    return { content: [{ type: 'text', text: JSON.stringify({ engagement }, null, 2) }] };
  }
);

// ── Tool: get_gaze_timeline ──────────────────────────────────────────────

server.tool(
  'get_gaze_timeline',
  'Get a time-bucketed gaze timeline for a session. Useful for understanding how gaze position changed over time.',
  {
    sessionId: z.string().describe('Session ID'),
    bucketMs: z.number().min(100).max(60000).default(1000).describe('Time bucket size in milliseconds'),
  },
  async ({ sessionId, bucketMs }) => {
    const d = getDb();
    const gaze = d.prepare(
      "SELECT x, y, timestamp FROM events WHERE session_id = ? AND type = 'gaze' ORDER BY timestamp LIMIT 200000"
    ).all(sessionId);

    if (gaze.length === 0) return { content: [{ type: 'text', text: JSON.stringify({ timeline: [], duration: 0 }) }] };

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

    return { content: [{ type: 'text', text: JSON.stringify({ timeline, duration: gaze[gaze.length - 1].timestamp - startTime }, null, 2) }] };
  }
);

// ── Tool: list_studies ───────────────────────────────────────────────────

server.tool(
  'list_studies',
  'List research studies. Studies group participants and sessions for A/B testing and UX research.',
  {
    limit: z.number().min(1).max(200).default(50).describe('Max studies to return'),
    offset: z.number().min(0).default(0).describe('Pagination offset'),
  },
  async ({ limit, offset }) => {
    const d = getDb();
    const studies = d.prepare('SELECT * FROM studies ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
    for (const s of studies) {
      try { s.target_urls = JSON.parse(s.target_urls); } catch { s.target_urls = []; }
      try { s.config = JSON.parse(s.config); } catch { s.config = {}; }
    }
    return { content: [{ type: 'text', text: JSON.stringify({ studies }, null, 2) }] };
  }
);

// ── Tool: get_study ──────────────────────────────────────────────────────

server.tool(
  'get_study',
  'Get detailed information about a research study including its participants, tasks, and aggregate statistics.',
  {
    studyId: z.number().describe('Study ID'),
  },
  async ({ studyId }) => {
    const d = getDb();
    const study = d.prepare('SELECT * FROM studies WHERE id = ?').get(studyId);
    if (!study) return { content: [{ type: 'text', text: 'Study not found' }], isError: true };

    try { study.target_urls = JSON.parse(study.target_urls); } catch { study.target_urls = []; }
    try { study.config = JSON.parse(study.config); } catch { study.config = {}; }

    const participants = d.prepare('SELECT * FROM participants WHERE study_id = ? ORDER BY created_at').all(studyId);
    const tasks = d.prepare('SELECT * FROM tasks WHERE study_id = ? ORDER BY sort_order').all(studyId);
    const sessions = d.prepare('SELECT id, session_name, participant_id, start_time, end_time, event_count FROM sessions WHERE study_id = ? ORDER BY start_time DESC').all(studyId);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ study, participants, tasks, sessions, sessionCount: sessions.length }, null, 2),
      }],
    };
  }
);

// ── Tool: analyze_funnel ─────────────────────────────────────────────────

server.tool(
  'analyze_funnel',
  'Analyze attention funnel across a sequence of URLs. Shows how many sessions reached each step, average duration, and drop-off rates.',
  {
    urls: z.array(z.string()).min(2).max(50).describe('Ordered list of URLs representing funnel steps'),
    sessionIds: z.array(z.string()).optional().describe('Optional session IDs to limit analysis'),
  },
  async ({ urls, sessionIds }) => {
    const d = getDb();
    let events;

    if (sessionIds && sessionIds.length > 0) {
      const ph = sessionIds.map(() => '?').join(',');
      events = d.prepare(
        `SELECT session_id, type, timestamp, url FROM events WHERE session_id IN (${ph}) ORDER BY timestamp LIMIT 500000`
      ).all(...sessionIds);
    } else {
      events = d.prepare(
        'SELECT session_id, type, timestamp, url FROM events ORDER BY timestamp LIMIT 500000'
      ).all();
    }

    const bySession = new Map();
    for (const e of events) {
      if (!bySession.has(e.session_id)) bySession.set(e.session_id, []);
      bySession.get(e.session_id).push(e);
    }

    const steps = urls.map(url => ({ url, sessions: 0, avgDuration: 0, dropoffRate: 0 }));
    let prevCount = bySession.size;

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      let totalDuration = 0, count = 0;
      for (const [, sessionEvents] of bySession) {
        const urlEvents = sessionEvents.filter(e => e.url && e.url.includes(url));
        if (urlEvents.length > 0) {
          count++;
          totalDuration += urlEvents[urlEvents.length - 1].timestamp - urlEvents[0].timestamp;
        }
      }
      steps[i].sessions = count;
      steps[i].avgDuration = count > 0 ? Math.round(totalDuration / count) : 0;
      steps[i].dropoffRate = prevCount > 0 ? Math.round((1 - count / prevCount) * 100) : 0;
      prevCount = count;
    }

    return { content: [{ type: 'text', text: JSON.stringify({ funnel: steps, totalSessions: bySession.size }, null, 2) }] };
  }
);

// ── Tool: compare_pages ──────────────────────────────────────────────────

server.tool(
  'compare_pages',
  'Compare eye-tracking metrics between two pages/URLs: gaze points, fixation count, avg fixation duration, engagement score, clicks, scrolls, and duration.',
  {
    url1: z.string().describe('First URL or URL fragment to compare'),
    url2: z.string().describe('Second URL or URL fragment to compare'),
    sessionIds: z.array(z.string()).optional().describe('Optional session IDs to limit comparison'),
  },
  async ({ url1, url2, sessionIds }) => {
    const d = getDb();
    let query = 'SELECT type, timestamp, x, y, url FROM events';
    const params = [];

    if (sessionIds && sessionIds.length > 0) {
      const ph = sessionIds.map(() => '?').join(',');
      query += ` WHERE session_id IN (${ph})`;
      params.push(...sessionIds);
    }
    query += ' ORDER BY timestamp LIMIT 500000';

    const allEvents = d.prepare(query).all(...params);
    const url1Events = allEvents.filter(e => e.url && e.url.includes(url1));
    const url2Events = allEvents.filter(e => e.url && e.url.includes(url2));

    const analyze = (events) => {
      const gaze = events.filter(e => e.type === 'gaze');
      const fixations = detectFixations(gaze);
      const engagement = computeEngagement(events, fixations);
      return {
        gazePoints: gaze.length,
        fixationCount: fixations.length,
        avgFixationDuration: fixations.length > 0
          ? Math.round(fixations.reduce((s, f) => s + f.duration, 0) / fixations.length) : 0,
        engagement: engagement.score,
        clicks: events.filter(e => e.type === 'click').length,
        scrolls: events.filter(e => e.type === 'scroll' || e.type === 'scrollMilestone').length,
        duration: events.length > 1 ? events[events.length - 1].timestamp - events[0].timestamp : 0,
      };
    };

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ page1: { url: url1, ...analyze(url1Events) }, page2: { url: url2, ...analyze(url2Events) } }, null, 2),
      }],
    };
  }
);

// ── Tool: get_url_heatmap ────────────────────────────────────────────────

server.tool(
  'get_url_heatmap',
  'Aggregate heatmap for a specific URL across multiple sessions. Supports device category filtering.',
  {
    url: z.string().describe('URL or URL fragment to aggregate'),
    sessionIds: z.array(z.string()).optional().describe('Optional session IDs to limit aggregation'),
    deviceCategory: z.enum(['all', 'mobile', 'tablet', 'desktop']).default('all').describe('Filter by device category'),
    gridCols: z.number().min(5).max(100).default(40).describe('Grid columns'),
    gridRows: z.number().min(5).max(100).default(30).describe('Grid rows'),
  },
  async ({ url, sessionIds, deviceCategory, gridCols, gridRows }) => {
    const d = getDb();
    let query, params;
    const limit = 300000;

    if (sessionIds && sessionIds.length > 0) {
      const ph = sessionIds.map(() => '?').join(',');
      query = `SELECT x, y, viewport_width, viewport_height FROM events WHERE session_id IN (${ph}) AND type = 'gaze' AND url LIKE ? ORDER BY timestamp LIMIT ?`;
      params = [...sessionIds, `%${url}%`, limit];
    } else {
      query = `SELECT x, y, viewport_width, viewport_height FROM events WHERE type = 'gaze' AND url LIKE ? ORDER BY timestamp LIMIT ?`;
      params = [`%${url}%`, limit];
    }

    let events = d.prepare(query).all(...params);

    const deviceBreakdown = {};
    for (const e of events) {
      const cat = categorizeDevice(e.viewport_width);
      deviceBreakdown[cat] = (deviceBreakdown[cat] || 0) + 1;
    }

    if (deviceCategory !== 'all') {
      events = events.filter(e => categorizeDevice(e.viewport_width) === deviceCategory);
    }

    const heatmap = aggregateHeatmap(events, gridCols, gridRows);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ url, heatmap, totalPoints: events.length, deviceBreakdown, deviceFilter: deviceCategory }, null, 2),
      }],
    };
  }
);

// ── Tool: get_form_analytics ─────────────────────────────────────────────

server.tool(
  'get_form_analytics',
  'Analyze form interactions in a session: field-level dwell time, abandon rates, submission data, and validation errors.',
  {
    sessionId: z.string().describe('Session ID'),
  },
  async ({ sessionId }) => {
    const d = getDb();
    const formEvents = d.prepare(
      `SELECT type, timestamp, url, extra FROM events WHERE session_id = ? AND type IN ('formFocus','formBlur','formSubmit','formError') ORDER BY timestamp LIMIT 50000`
    ).all(sessionId);

    if (formEvents.length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ fields: [], submissions: [], errors: [], summary: { totalInteractions: 0 } }) }] };
    }

    const fieldStats = new Map();
    const submissions = [];
    const errors = [];

    for (const ev of formEvents) {
      let extra = {};
      try { extra = JSON.parse(ev.extra || '{}'); } catch {}

      if (ev.type === 'formBlur' && extra.fieldId) {
        const key = `${ev.url || ''}|${extra.formId || ''}|${extra.fieldId}`;
        if (!fieldStats.has(key)) {
          fieldStats.set(key, {
            url: ev.url || '', formId: extra.formId || '', fieldId: extra.fieldId,
            fieldType: extra.fieldType || '', fieldName: extra.fieldName || '',
            required: extra.required || false, interactions: 0, totalDwell: 0,
            changed: 0, abandoned: 0, dwellTimes: [],
          });
        }
        const stat = fieldStats.get(key);
        stat.interactions++;
        if (extra.dwellTime) { stat.totalDwell += extra.dwellTime; stat.dwellTimes.push(extra.dwellTime); }
        if (extra.valueChanged) stat.changed++;
        if (extra.abandoned) stat.abandoned++;
      }
      if (ev.type === 'formSubmit') {
        submissions.push({ url: ev.url || '', formId: extra.formId || '', timestamp: ev.timestamp,
          totalFields: extra.totalFields || 0, filledFields: extra.filledFields || 0, emptyRequired: extra.emptyRequired || 0 });
      }
      if (ev.type === 'formError') {
        errors.push({ url: ev.url || '', fieldId: extra.fieldId || '', fieldName: extra.fieldName || '',
          message: extra.message || '', timestamp: ev.timestamp });
      }
    }

    const fields = [...fieldStats.values()].map(f => {
      const sorted = f.dwellTimes.sort((a, b) => a - b);
      return {
        url: f.url, formId: f.formId, fieldId: f.fieldId, fieldType: f.fieldType,
        fieldName: f.fieldName, required: f.required, interactions: f.interactions,
        avgDwell: f.interactions > 0 ? Math.round(f.totalDwell / f.interactions) : 0,
        medianDwell: sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0,
        totalDwell: f.totalDwell, changedCount: f.changed, abandonedCount: f.abandoned,
        abandonRate: f.interactions > 0 ? Math.round((f.abandoned / f.interactions) * 100) : 0,
      };
    }).sort((a, b) => b.totalDwell - a.totalDwell);

    const summary = {
      totalInteractions: formEvents.length, uniqueFields: fields.length,
      totalSubmissions: submissions.length, totalErrors: errors.length,
      avgFieldsPerSubmission: submissions.length > 0
        ? Math.round(submissions.reduce((s, sub) => s + sub.filledFields, 0) / submissions.length) : 0,
    };

    return { content: [{ type: 'text', text: JSON.stringify({ fields, submissions, errors, summary }, null, 2) }] };
  }
);

// ── Tool: get_viewport_distribution ──────────────────────────────────────

server.tool(
  'get_viewport_distribution',
  'Get device and viewport size distribution for a URL or set of sessions.',
  {
    url: z.string().optional().describe('URL to analyze (partial match)'),
    sessionIds: z.array(z.string()).optional().describe('Session IDs to analyze'),
  },
  async ({ url, sessionIds }) => {
    const d = getDb();
    if (!url && (!sessionIds || sessionIds.length === 0)) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'url or sessionIds required' }) }], isError: true };
    }

    let query, params;
    if (sessionIds && sessionIds.length > 0) {
      const ph = sessionIds.map(() => '?').join(',');
      query = `SELECT DISTINCT session_id, CAST(viewport_width AS INT) as vw, CAST(viewport_height AS INT) as vh
               FROM events WHERE session_id IN (${ph}) AND type = 'gaze' AND viewport_width IS NOT NULL GROUP BY session_id`;
      params = [...sessionIds];
    } else {
      query = `SELECT DISTINCT session_id, CAST(viewport_width AS INT) as vw, CAST(viewport_height AS INT) as vh
               FROM events WHERE type = 'gaze' AND url LIKE ? AND viewport_width IS NOT NULL GROUP BY session_id`;
      params = [`%${url}%`];
    }

    const rows = d.prepare(query).all(...params);
    const devices = { mobile: 0, tablet: 0, desktop: 0, unknown: 0 };
    const viewportSizes = new Map();
    for (const r of rows) {
      devices[categorizeDevice(r.vw)]++;
      const sizeKey = `${r.vw}x${r.vh}`;
      viewportSizes.set(sizeKey, (viewportSizes.get(sizeKey) || 0) + 1);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          devices, totalSessions: rows.length,
          viewports: [...viewportSizes.entries()].map(([size, count]) => ({ size, count })).sort((a, b) => b.count - a.count).slice(0, 20),
        }, null, 2),
      }],
    };
  }
);

// ── Tool: get_time_to_first_fixation ─────────────────────────────────────

server.tool(
  'get_time_to_first_fixation',
  'Compute time-to-first-fixation (TTFF) for areas of interest (AOIs). AOIs are normalized 0-1 rectangles. Can compute for a single session or aggregate across multiple sessions.',
  {
    sessionId: z.string().optional().describe('Single session ID'),
    sessionIds: z.array(z.string()).optional().describe('Multiple session IDs for aggregate TTFF'),
    aois: z.array(z.object({
      name: z.string().describe('AOI name'),
      x: z.number().min(0).max(1).describe('AOI left edge (normalized 0-1)'),
      y: z.number().min(0).max(1).describe('AOI top edge (normalized 0-1)'),
      width: z.number().min(0).max(1).describe('AOI width (normalized 0-1)'),
      height: z.number().min(0).max(1).describe('AOI height (normalized 0-1)'),
    })).min(1).max(50).describe('Areas of interest'),
  },
  async ({ sessionId, sessionIds, aois }) => {
    const d = getDb();

    const ttffForSession = (sid) => {
      const gazeEvents = d.prepare(
        "SELECT x, y, timestamp FROM events WHERE session_id = ? AND type = 'gaze' ORDER BY timestamp LIMIT 200000"
      ).all(sid);

      if (gazeEvents.length === 0) return aois.map(a => ({ aoi: a.name, ttff: null }));
      const fixations = detectFixations(gazeEvents);
      const sessionStart = gazeEvents[0].timestamp;

      return aois.map(aoi => {
        const hit = fixations.find(f =>
          f.x >= aoi.x && f.x <= aoi.x + aoi.width &&
          f.y >= aoi.y && f.y <= aoi.y + aoi.height
        );
        return { aoi: aoi.name, ttff: hit ? hit.startTime - sessionStart : null, fixation: hit || null };
      });
    };

    if (sessionId) {
      const result = ttffForSession(sessionId);
      return { content: [{ type: 'text', text: JSON.stringify({ results: result, sessionId }, null, 2) }] };
    }

    if (sessionIds && sessionIds.length > 0) {
      const allResults = sessionIds.map(sid => ttffForSession(sid));
      const aggregated = aois.map((aoi, i) => {
        const ttffs = allResults.map(r => r[i].ttff).filter(t => t !== null);
        const sorted = [...ttffs].sort((a, b) => a - b);
        return {
          aoi: aoi.name, sessions: sessionIds.length, hits: ttffs.length,
          hitRate: Math.round((ttffs.length / sessionIds.length) * 100),
          mean: ttffs.length > 0 ? Math.round(ttffs.reduce((s, t) => s + t, 0) / ttffs.length) : null,
          median: sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : null,
          min: sorted.length > 0 ? sorted[0] : null,
          max: sorted.length > 0 ? sorted[sorted.length - 1] : null,
        };
      });
      return { content: [{ type: 'text', text: JSON.stringify({ results: aggregated, sessions: sessionIds.length }, null, 2) }] };
    }

    return { content: [{ type: 'text', text: 'sessionId or sessionIds required' }], isError: true };
  }
);

// ── Tool: export_session_events ──────────────────────────────────────────

server.tool(
  'export_session_events',
  'Export all events for a session as JSON. Use for detailed data analysis or to pipe into external tools.',
  {
    sessionId: z.string().describe('Session ID'),
    type: z.string().optional().describe('Filter by event type'),
    limit: z.number().min(1).max(100000).default(10000).describe('Max events to export'),
  },
  async ({ sessionId, type, limit }) => {
    const d = getDb();
    let query = 'SELECT * FROM events WHERE session_id = ?';
    const params = [sessionId];
    if (type) { query += ' AND type = ?'; params.push(type); }
    query += ' ORDER BY timestamp LIMIT ?';
    params.push(limit);

    const events = d.prepare(query).all(...params);
    return { content: [{ type: 'text', text: JSON.stringify({ sessionId, eventCount: events.length, events }, null, 2) }] };
  }
);

// ── Start server ─────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
