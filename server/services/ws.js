/**
 * WebSocket service for real-time dashboard updates.
 */

const clients = new Set();

function addClient(ws) {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
}

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, timestamp: Date.now() });
  for (const ws of clients) {
    try {
      if (ws.readyState === 1) ws.send(msg);
    } catch {
      clients.delete(ws);
    }
  }
}

module.exports = { addClient, broadcast, getClientCount: () => clients.size };
