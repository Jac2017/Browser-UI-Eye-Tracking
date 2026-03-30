/**
 * DevOps Monitoring Service
 *
 * Collects server metrics, tracks system health, manages alerts,
 * and exposes operational data for the monitoring dashboard.
 *
 * Metrics collected:
 * - Request throughput and latency (per route)
 * - Error rates (4xx, 5xx)
 * - Database size and query performance
 * - Memory and CPU usage
 * - Event ingestion rate
 * - Active sessions and WebSocket connections
 * - Disk usage (screenshots, DB)
 * - Uptime and process info
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const config = require('../config');

/* ========== METRIC STORAGE ========== */

const HISTORY_SIZE = 360; // 1 hour at 10s intervals
const SNAPSHOT_INTERVAL = 10000; // 10 seconds

// Time-series ring buffer
class MetricSeries {
  constructor(size) {
    this.size = size;
    this.data = [];
  }
  push(value) {
    this.data.push(value);
    if (this.data.length > this.size) this.data.shift();
  }
  latest() { return this.data[this.data.length - 1] || null; }
  all() { return [...this.data]; }
  avg(field) {
    if (this.data.length === 0) return 0;
    return this.data.reduce((s, d) => s + (d[field] || 0), 0) / this.data.length;
  }
}

// Core metric series
const metrics = {
  system: new MetricSeries(HISTORY_SIZE),
  requests: new MetricSeries(HISTORY_SIZE),
  database: new MetricSeries(HISTORY_SIZE),
  errors: new MetricSeries(HISTORY_SIZE),
};

// Request tracking (reset every snapshot interval)
const requestStats = {
  total: 0,
  byStatus: {},
  byRoute: {},
  latencies: [],
  errors: [],
};

// Alert definitions and state
const alerts = [];
const alertHistory = [];
const MAX_ALERT_HISTORY = 500;

// Server start time
const startedAt = Date.now();

/* ========== REQUEST TRACKING MIDDLEWARE ========== */

function requestTracker(req, res, next) {
  const start = process.hrtime.bigint();

  const originalEnd = res.end;
  res.end = function (...args) {
    const durationNs = Number(process.hrtime.bigint() - start);
    const durationMs = durationNs / 1e6;

    requestStats.total++;

    // Track by status code group
    const statusGroup = `${Math.floor(res.statusCode / 100)}xx`;
    requestStats.byStatus[statusGroup] = (requestStats.byStatus[statusGroup] || 0) + 1;

    // Track by route pattern
    const routeKey = `${req.method} ${req.route?.path || req.path}`;
    if (!requestStats.byRoute[routeKey]) {
      requestStats.byRoute[routeKey] = { count: 0, totalMs: 0, maxMs: 0 };
    }
    const route = requestStats.byRoute[routeKey];
    route.count++;
    route.totalMs += durationMs;
    if (durationMs > route.maxMs) route.maxMs = durationMs;

    // Track latency distribution
    requestStats.latencies.push(durationMs);

    // Track errors
    if (res.statusCode >= 400) {
      requestStats.errors.push({
        time: Date.now(),
        status: res.statusCode,
        method: req.method,
        path: req.path,
        duration: durationMs,
      });
      // Cap error log
      if (requestStats.errors.length > 100) requestStats.errors.shift();
    }

    originalEnd.apply(this, args);
  };

  next();
}

/* ========== SYSTEM METRICS ========== */

function collectSystemMetrics() {
  const memUsage = process.memoryUsage();
  const cpus = os.cpus();
  const loadAvg = os.loadavg();

  // CPU usage for this process (approximate via cpuUsage)
  const cpuUsage = process.cpuUsage();
  const cpuPercent = ((cpuUsage.user + cpuUsage.system) / 1e6 / os.cpus().length).toFixed(2);

  return {
    timestamp: Date.now(),
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    processUptime: Math.floor(process.uptime()),
    memory: {
      rss: memUsage.rss,
      heapUsed: memUsage.heapUsed,
      heapTotal: memUsage.heapTotal,
      external: memUsage.external,
      arrayBuffers: memUsage.arrayBuffers || 0,
    },
    os: {
      totalMem: os.totalmem(),
      freeMem: os.freemem(),
      loadAvg: loadAvg.map(l => Math.round(l * 100) / 100),
      cpuCount: cpus.length,
    },
    pid: process.pid,
    nodeVersion: process.version,
  };
}

/* ========== DATABASE METRICS ========== */

let dbRef = null;

function setDb(database) {
  dbRef = database;
}

function collectDatabaseMetrics() {
  if (!dbRef) return { size: 0, tables: {} };

  const tables = {};
  try {
    const counts = [
      { name: 'events', query: 'SELECT COUNT(*) as cnt FROM events' },
      { name: 'sessions', query: 'SELECT COUNT(*) as cnt FROM sessions' },
      { name: 'screenshots', query: 'SELECT COUNT(*) as cnt FROM screenshots' },
      { name: 'api_keys', query: 'SELECT COUNT(*) as cnt FROM api_keys' },
      { name: 'studies', query: 'SELECT COUNT(*) as cnt FROM studies' },
      { name: 'participants', query: 'SELECT COUNT(*) as cnt FROM participants' },
      { name: 'webhooks', query: 'SELECT COUNT(*) as cnt FROM webhooks' },
    ];

    for (const { name, query } of counts) {
      tables[name] = dbRef.prepare(query).get().cnt;
    }
  } catch { /* db not ready */ }

  // DB file size
  let dbSize = 0;
  try {
    const stat = fs.statSync(config.dbPath);
    dbSize = stat.size;
    // WAL file
    try {
      const walStat = fs.statSync(config.dbPath + '-wal');
      dbSize += walStat.size;
    } catch { /* no WAL file */ }
  } catch { /* file not found */ }

  // Screenshot directory size
  let screenshotSize = 0;
  let screenshotCount = 0;
  try {
    const files = fs.readdirSync(config.screenshotDir);
    screenshotCount = files.length;
    for (const f of files) {
      try {
        const stat = fs.statSync(path.join(config.screenshotDir, f));
        screenshotSize += stat.size;
      } catch { /* skip */ }
    }
  } catch { /* dir not found */ }

  return {
    timestamp: Date.now(),
    dbSize,
    tables,
    screenshotDisk: { size: screenshotSize, count: screenshotCount },
  };
}

/* ========== REQUEST METRICS SNAPSHOT ========== */

function collectRequestMetrics() {
  const latencies = requestStats.latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;
  const avg = latencies.length > 0
    ? latencies.reduce((s, v) => s + v, 0) / latencies.length
    : 0;

  const snapshot = {
    timestamp: Date.now(),
    total: requestStats.total,
    rps: Math.round((requestStats.total / (SNAPSHOT_INTERVAL / 1000)) * 100) / 100,
    byStatus: { ...requestStats.byStatus },
    latency: {
      avg: Math.round(avg * 100) / 100,
      p50: Math.round(p50 * 100) / 100,
      p95: Math.round(p95 * 100) / 100,
      p99: Math.round(p99 * 100) / 100,
    },
    topRoutes: Object.entries(requestStats.byRoute)
      .map(([route, stats]) => ({
        route,
        count: stats.count,
        avgMs: Math.round((stats.totalMs / stats.count) * 100) / 100,
        maxMs: Math.round(stats.maxMs * 100) / 100,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20),
    errorRate: requestStats.total > 0
      ? Math.round(((requestStats.byStatus['4xx'] || 0) + (requestStats.byStatus['5xx'] || 0)) / requestStats.total * 10000) / 100
      : 0,
    recentErrors: requestStats.errors.slice(-20),
  };

  // Reset counters
  requestStats.total = 0;
  requestStats.byStatus = {};
  requestStats.byRoute = {};
  requestStats.latencies = [];
  // Keep errors for recent errors view

  return snapshot;
}

/* ========== ALERTING ========== */

function defineAlert(name, condition, message, severity = 'warning') {
  alerts.push({ name, condition, message, severity, active: false, lastTriggered: null });
}

function evaluateAlerts() {
  const sys = metrics.system.latest();
  const req = metrics.requests.latest();
  const db = metrics.database.latest();

  if (!sys || !req) return;

  const context = { sys, req, db };

  for (const alert of alerts) {
    try {
      const triggered = alert.condition(context);
      if (triggered && !alert.active) {
        alert.active = true;
        alert.lastTriggered = Date.now();
        const entry = {
          name: alert.name,
          message: typeof alert.message === 'function' ? alert.message(context) : alert.message,
          severity: alert.severity,
          triggeredAt: Date.now(),
          resolved: false,
        };
        alertHistory.push(entry);
        if (alertHistory.length > MAX_ALERT_HISTORY) alertHistory.shift();
      } else if (!triggered && alert.active) {
        alert.active = false;
        // Mark resolved
        const last = alertHistory.findLast(h => h.name === alert.name && !h.resolved);
        if (last) {
          last.resolved = true;
          last.resolvedAt = Date.now();
        }
      }
    } catch { /* alert evaluation failed */ }
  }
}

/* ========== DEFAULT ALERTS ========== */

function setupDefaultAlerts() {
  defineAlert(
    'high_memory',
    ({ sys }) => sys.memory.heapUsed > sys.memory.heapTotal * 0.9,
    ({ sys }) => `Heap usage at ${Math.round(sys.memory.heapUsed / 1024 / 1024)}MB / ${Math.round(sys.memory.heapTotal / 1024 / 1024)}MB (>90%)`,
    'critical'
  );

  defineAlert(
    'high_error_rate',
    ({ req }) => req.errorRate > 10,
    ({ req }) => `Error rate at ${req.errorRate}% (>10%)`,
    'warning'
  );

  defineAlert(
    'high_latency',
    ({ req }) => req.latency.p95 > 5000,
    ({ req }) => `P95 latency at ${req.latency.p95}ms (>5000ms)`,
    'warning'
  );

  defineAlert(
    'disk_usage_high',
    ({ db }) => db && db.dbSize > 5 * 1024 * 1024 * 1024,
    ({ db }) => `Database size at ${Math.round(db.dbSize / 1024 / 1024)}MB (>5GB)`,
    'warning'
  );

  defineAlert(
    'low_system_memory',
    ({ sys }) => sys.os.freeMem < sys.os.totalMem * 0.1,
    ({ sys }) => `System free memory at ${Math.round(sys.os.freeMem / 1024 / 1024)}MB (<10%)`,
    'critical'
  );

  defineAlert(
    'high_load',
    ({ sys }) => sys.os.loadAvg[0] > sys.os.cpuCount * 2,
    ({ sys }) => `Load average at ${sys.os.loadAvg[0]} (>2x CPU count)`,
    'warning'
  );
}

/* ========== SNAPSHOT COLLECTOR ========== */

let snapshotTimer = null;

function start() {
  setupDefaultAlerts();

  snapshotTimer = setInterval(() => {
    metrics.system.push(collectSystemMetrics());
    metrics.requests.push(collectRequestMetrics());

    // DB metrics less frequently (every 60s)
    const dbSeries = metrics.database;
    const lastDb = dbSeries.latest();
    if (!lastDb || Date.now() - lastDb.timestamp > 55000) {
      dbSeries.push(collectDatabaseMetrics());
    }

    evaluateAlerts();
  }, SNAPSHOT_INTERVAL);

  // Initial snapshot
  metrics.system.push(collectSystemMetrics());
  metrics.requests.push(collectRequestMetrics());
  metrics.database.push(collectDatabaseMetrics());
}

function stop() {
  if (snapshotTimer) {
    clearInterval(snapshotTimer);
    snapshotTimer = null;
  }
}

/* ========== PUBLIC API ========== */

function getOverview() {
  const sys = metrics.system.latest();
  const req = metrics.requests.latest();
  const db = metrics.database.latest();

  return {
    status: getHealthStatus(),
    uptime: sys ? sys.uptime : 0,
    startedAt,
    pid: process.pid,
    nodeVersion: process.version,
    memory: sys ? sys.memory : null,
    os: sys ? sys.os : null,
    requests: req ? {
      rps: req.rps,
      latency: req.latency,
      errorRate: req.errorRate,
    } : null,
    database: db ? {
      dbSize: db.dbSize,
      tables: db.tables,
      screenshotDisk: db.screenshotDisk,
    } : null,
    activeAlerts: alerts.filter(a => a.active).map(a => ({
      name: a.name,
      severity: a.severity,
      triggeredAt: a.lastTriggered,
    })),
  };
}

function getHealthStatus() {
  const critAlerts = alerts.filter(a => a.active && a.severity === 'critical');
  if (critAlerts.length > 0) return 'critical';
  const warnAlerts = alerts.filter(a => a.active && a.severity === 'warning');
  if (warnAlerts.length > 0) return 'degraded';
  return 'healthy';
}

function getTimeSeries(metric, count) {
  const series = metrics[metric];
  if (!series) return [];
  const data = series.all();
  return count ? data.slice(-count) : data;
}

function getAlerts() {
  return {
    active: alerts.filter(a => a.active).map(a => ({
      name: a.name,
      severity: a.severity,
      message: typeof a.message === 'function' ? a.message({
        sys: metrics.system.latest(),
        req: metrics.requests.latest(),
        db: metrics.database.latest(),
      }) : a.message,
      triggeredAt: a.lastTriggered,
    })),
    history: alertHistory.slice(-100).reverse(),
    definitions: alerts.map(a => ({
      name: a.name,
      severity: a.severity,
      active: a.active,
      lastTriggered: a.lastTriggered,
    })),
  };
}

function getRecentErrors() {
  return requestStats.errors.slice(-50).reverse();
}

module.exports = {
  requestTracker,
  setDb,
  start,
  stop,
  getOverview,
  getHealthStatus,
  getTimeSeries,
  getAlerts,
  getRecentErrors,
  metrics,
};
