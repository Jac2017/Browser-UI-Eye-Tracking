/**
 * DevOps Monitoring API routes.
 * All endpoints require master/admin auth.
 */

const router = require('express').Router();
const { masterAuth } = require('../middleware/auth');
const monitor = require('../services/monitor');

// GET /monitor/overview — current health snapshot
router.get('/monitor/overview', masterAuth, (req, res) => {
  res.json(monitor.getOverview());
});

// GET /monitor/health — lightweight health check with status code
router.get('/monitor/health', (req, res) => {
  const status = monitor.getHealthStatus();
  const code = status === 'healthy' ? 200 : status === 'degraded' ? 200 : 503;
  res.status(code).json({ status, timestamp: Date.now() });
});

// GET /monitor/metrics/system — system metrics time series
router.get('/monitor/metrics/system', masterAuth, (req, res) => {
  const count = Math.min(parseInt(req.query.count) || 60, 360);
  res.json({ series: monitor.getTimeSeries('system', count) });
});

// GET /monitor/metrics/requests — request metrics time series
router.get('/monitor/metrics/requests', masterAuth, (req, res) => {
  const count = Math.min(parseInt(req.query.count) || 60, 360);
  res.json({ series: monitor.getTimeSeries('requests', count) });
});

// GET /monitor/metrics/database — database metrics time series
router.get('/monitor/metrics/database', masterAuth, (req, res) => {
  const count = Math.min(parseInt(req.query.count) || 60, 360);
  res.json({ series: monitor.getTimeSeries('database', count) });
});

// GET /monitor/alerts — active alerts and history
router.get('/monitor/alerts', masterAuth, (req, res) => {
  res.json(monitor.getAlerts());
});

// GET /monitor/errors — recent request errors
router.get('/monitor/errors', masterAuth, (req, res) => {
  res.json({ errors: monitor.getRecentErrors() });
});

module.exports = router;
