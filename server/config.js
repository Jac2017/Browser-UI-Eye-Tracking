const path = require('path');

module.exports = {
  port: process.env.EYED_PORT || 3200,
  dbPath: process.env.EYED_DB || path.join(__dirname, 'data', 'eyed.db'),
  screenshotDir: path.join(__dirname, 'screenshots'),
  // Master admin key for key management (REQUIRED in production via EYED_MASTER_KEY env var)
  masterKey: (() => {
    const key = process.env.EYED_MASTER_KEY;
    if (!key && process.env.NODE_ENV === 'production') {
      console.error('FATAL: EYED_MASTER_KEY environment variable is required in production');
      process.exit(1);
    }
    return key || 'eyed-dev-master-key-change-me';
  })(),
  // Max events per batch
  maxBatchSize: 500,
  // Max screenshot size (bytes)
  maxScreenshotSize: 10 * 1024 * 1024,
  // Rate limiting
  rateLimitWindow: 60 * 1000, // 1 minute
  rateLimitMax: 120, // requests per window per key
};
