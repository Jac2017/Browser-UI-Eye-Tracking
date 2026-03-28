/**
 * EyeD Server — Centralized eye-tracking data collection and analytics.
 *
 * Features:
 * - AES-256-GCM decryption of incoming payloads
 * - API key authentication and management
 * - SQLite storage for events, sessions, studies
 * - Screenshot blob storage
 * - Real-time WebSocket dashboard
 * - CSV/JSON export
 * - Webhook notifications
 * - Multi-user study support
 * - Server-side analytics (fixation detection, funnels, comparisons)
 */

const express = require('express');
const expressWs = require('express-ws');
const helmet = require('helmet');
const path = require('path');
const db = require('./models/db');
const config = require('./config');

const app = express();
expressWs(app);

// Security headers (relaxed CSP for dashboard)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", "ws:", "wss:"],
      imgSrc: ["'self'", "data:", "blob:"],
    },
  },
}));

// Body parsing — large limit for encrypted screenshot payloads
app.use(express.json({ limit: '10mb' }));

// Static files for dashboard
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/api', require('./routes/health'));
app.use('/api', require('./routes/events'));
app.use('/api', require('./routes/sessions'));
app.use('/api', require('./routes/screenshots'));
app.use('/api', require('./routes/keys'));
app.use('/api', require('./routes/studies'));
app.use('/api', require('./routes/analytics'));
app.use('/api', require('./routes/export'));
app.use('/api', require('./routes/webhooks'));
app.use('/api/ws', require('./routes/websocket'));

// Dashboard views
app.use('/', require('./routes/dashboard'));

const PORT = config.port;
app.listen(PORT, () => {
  console.log(`EyeD server running on http://localhost:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/dashboard`);
});

module.exports = app;
