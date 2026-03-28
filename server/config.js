const path = require('path');

module.exports = {
  port: process.env.EYED_PORT || 3200,
  dbPath: process.env.EYED_DB || path.join(__dirname, 'data', 'eyed.db'),
  screenshotDir: path.join(__dirname, 'screenshots'),
  // Master admin key for key management (set via env in production)
  masterKey: process.env.EYED_MASTER_KEY || 'eyed-dev-master-key-change-me',
  // Max events per batch
  maxBatchSize: 500,
  // Max screenshot size (bytes)
  maxScreenshotSize: 10 * 1024 * 1024,
  // Rate limiting
  rateLimitWindow: 60 * 1000, // 1 minute
  rateLimitMax: 120, // requests per window per key
};
