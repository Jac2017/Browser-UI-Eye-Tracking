/**
 * WebSocket endpoint for real-time dashboard.
 */

const router = require('express').Router();
const wsService = require('../services/ws');
const { db } = require('../models/db');
const config = require('../config');

router.ws('/live', (ws, req) => {
  // Authenticate WebSocket connection via query param or header
  const authKey = req.query.key || req.headers['authorization']?.replace('Bearer ', '');
  if (!authKey) {
    ws.close(1008, 'Unauthorized');
    return;
  }

  // Validate: must be master key or valid API key
  const isMaster = authKey === config.masterKey;
  if (!isMaster) {
    const keyRow = db.prepare('SELECT id FROM api_keys WHERE key = ? AND active = 1').get(authKey);
    if (!keyRow) {
      ws.close(1008, 'Invalid API key');
      return;
    }
  }

  wsService.addClient(ws);
  ws.send(JSON.stringify({
    type: 'connected',
    data: { clients: wsService.getClientCount() },
    timestamp: Date.now(),
  }));
});

module.exports = router;
