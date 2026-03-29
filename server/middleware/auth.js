/**
 * API key authentication and rate limiting middleware.
 */

const { db } = require('../models/db');
const config = require('../config');

// In-memory rate limit tracking
const rateBuckets = new Map();

// Clean stale buckets every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now - bucket.windowStart > config.rateLimitWindow * 2) {
      rateBuckets.delete(key);
    }
  }
}, 60 * 1000);

const getKeyStmt = db.prepare('SELECT * FROM api_keys WHERE key = ? AND active = 1');
const updateLastUsed = db.prepare('UPDATE api_keys SET last_used_at = datetime(\'now\') WHERE id = ?');

function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const apiKey = authHeader.slice(7);
  if (!apiKey || apiKey.length < 8) {
    return res.status(401).json({ error: 'Invalid API key format' });
  }

  const keyRow = getKeyStmt.get(apiKey);
  if (!keyRow) {
    return res.status(403).json({ error: 'Invalid or deactivated API key' });
  }

  // Rate limiting
  const limit = keyRow.rate_limit || config.rateLimitMax;
  const now = Date.now();
  let bucket = rateBuckets.get(keyRow.id);
  if (!bucket || now - bucket.windowStart > config.rateLimitWindow) {
    bucket = { windowStart: now, count: 0 };
    rateBuckets.set(keyRow.id, bucket);
  }
  bucket.count++;
  if (bucket.count > limit) {
    res.set('Retry-After', String(Math.ceil((config.rateLimitWindow - (now - bucket.windowStart)) / 1000)));
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  // Attach key info to request
  req.apiKey = keyRow;
  updateLastUsed.run(keyRow.id);

  next();
}

function masterAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  const key = authHeader.slice(7);
  if (key !== config.masterKey) {
    // Also allow valid API keys with admin scope
    const keyRow = getKeyStmt.get(key);
    if (!keyRow || !keyRow.scopes.includes('admin')) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    req.apiKey = keyRow;
  } else {
    req.apiKey = { id: 0, name: 'master', scopes: 'admin' };
  }

  next();
}

module.exports = { authenticate, masterAuth };
