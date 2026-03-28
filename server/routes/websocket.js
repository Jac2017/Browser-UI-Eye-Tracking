/**
 * WebSocket endpoint for real-time dashboard.
 */

const router = require('express').Router();
const wsService = require('../services/ws');

router.ws('/live', (ws, req) => {
  wsService.addClient(ws);
  ws.send(JSON.stringify({
    type: 'connected',
    data: { clients: wsService.getClientCount() },
    timestamp: Date.now(),
  }));
});

module.exports = router;
