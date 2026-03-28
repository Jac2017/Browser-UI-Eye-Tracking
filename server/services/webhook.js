/**
 * Webhook notification service.
 * Fires HTTP POST to registered webhook URLs on events.
 */

const { db } = require('../models/db');
const crypto = require('crypto');

const getWebhooks = db.prepare(
  'SELECT * FROM webhooks WHERE active = 1 AND events LIKE ?'
);
const updateTriggered = db.prepare(
  'UPDATE webhooks SET last_triggered_at = datetime(\'now\'), failure_count = 0 WHERE id = ?'
);
const incrementFailure = db.prepare(
  'UPDATE webhooks SET failure_count = failure_count + 1 WHERE id = ?'
);
const deactivateWebhook = db.prepare(
  'UPDATE webhooks SET active = 0 WHERE id = ?'
);

async function fire(eventType, payload) {
  const hooks = getWebhooks.all(`%"${eventType}"%`);
  for (const hook of hooks) {
    try {
      const body = JSON.stringify({
        event: eventType,
        timestamp: Date.now(),
        data: payload,
      });

      const headers = { 'Content-Type': 'application/json' };
      if (hook.secret) {
        const sig = crypto.createHmac('sha256', hook.secret)
          .update(body).digest('hex');
        headers['X-EyeD-Signature'] = sig;
      }

      const res = await fetch(hook.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10000),
      });

      if (res.ok) {
        updateTriggered.run(hook.id);
      } else {
        incrementFailure.run(hook.id);
        if (hook.failure_count >= 10) deactivateWebhook.run(hook.id);
      }
    } catch {
      incrementFailure.run(hook.id);
      if (hook.failure_count >= 10) deactivateWebhook.run(hook.id);
    }
  }
}

module.exports = { fire };
