/**
 * EyeD Demo Uploader — No-op stub.
 * All upload/encryption/network functionality is disabled.
 * Data stays local in the browser only.
 */

const EyedUploader = (() => {
  'use strict';

  let queueSize = 0;
  let screenshotQueueSize = 0;

  return {
    init(opts) { /* no-op */ },
    updateSettings(opts) { /* no-op */ },
    enqueue(events) {
      if (Array.isArray(events)) queueSize += events.length;
    },
    enqueueScreenshot(data) {
      screenshotQueueSize++;
    },
    flush() { /* no-op — nothing to send */ },
    sendSessionStart(info) { /* no-op */ },
    getQueueSize() { return queueSize; },
    getScreenshotQueueSize() { return screenshotQueueSize; },
    sanitizeUrl(url) {
      try {
        const u = new URL(url);
        u.search = '';
        u.hash = '';
        return u.toString();
      } catch { return url; }
    },
  };
})();
