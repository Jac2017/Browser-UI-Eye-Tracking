/**
 * EyeD Uploader — Batched data upload to centralized endpoint.
 * Runs inside the service worker context.
 *
 * Usage: importScripts('uploader.js') from service-worker.js
 * Then call EyedUploader.init(settings), EyedUploader.enqueue(events), etc.
 */

const EyedUploader = (() => {
  'use strict';

  let settings = {
    apiEndpoint: '',
    uploadEnabled: true,
    batchInterval: 30,
    stripQueryParams: true,
    stripHash: false,
    liteMode: false,
  };

  let sessionId = crypto.randomUUID();
  let eventQueue = [];
  let screenshotQueue = [];
  let uploadTimer = null;
  let retryCount = 0;
  const MAX_RETRY = 4;
  const MAX_QUEUE_SIZE = 10000;
  const MAX_SCREENSHOT_QUEUE = 20;

  // Persisted offline queue key
  const OFFLINE_KEY = '_eyedOfflineQueue';
  const OFFLINE_SCREENSHOT_KEY = '_eyedOfflineScreenshots';

  function init(newSettings) {
    settings = { ...settings, ...newSettings };
    restoreOfflineQueue();
    startTimer();
  }

  function updateSettings(newSettings) {
    const intervalChanged = newSettings.batchInterval !== settings.batchInterval;
    settings = { ...settings, ...newSettings };
    if (intervalChanged) {
      startTimer();
    }
  }

  function startTimer() {
    if (uploadTimer) clearInterval(uploadTimer);
    const ms = (settings.batchInterval || 30) * 1000;
    uploadTimer = setInterval(flush, ms);
  }

  function stop() {
    if (uploadTimer) { clearInterval(uploadTimer); uploadTimer = null; }
    persistOfflineQueue();
  }

  // Sanitize URL per privacy settings
  function sanitizeUrl(url) {
    if (!url) return '';
    try {
      const u = new URL(url);
      if (settings.stripQueryParams) u.search = '';
      if (settings.stripHash) u.hash = '';
      return u.toString();
    } catch {
      return url;
    }
  }

  // Strip DOM metadata in lite mode
  function sanitizeEvent(event) {
    if (!settings.liteMode) return event;
    const lite = {
      type: event.type,
      x: event.x,
      y: event.y,
      timestamp: event.timestamp,
    };
    if (event.pageX != null) lite.pageX = event.pageX;
    if (event.pageY != null) lite.pageY = event.pageY;
    if (event.scrollX != null) lite.scrollX = event.scrollX;
    if (event.scrollY != null) lite.scrollY = event.scrollY;
    return lite;
  }

  function enqueue(events) {
    if (!settings.uploadEnabled || !settings.apiEndpoint) return;

    for (const event of events) {
      eventQueue.push(sanitizeEvent(event));
    }

    // Trim if too large
    if (eventQueue.length > MAX_QUEUE_SIZE) {
      eventQueue = eventQueue.slice(-Math.floor(MAX_QUEUE_SIZE * 0.75));
    }
  }

  function enqueueScreenshot(screenshotData) {
    if (!settings.uploadEnabled || !settings.apiEndpoint) return;
    screenshotQueue.push(screenshotData);
    if (screenshotQueue.length > MAX_SCREENSHOT_QUEUE) {
      screenshotQueue.shift();
    }
  }

  async function flush() {
    if (!settings.uploadEnabled || !settings.apiEndpoint) return;
    if (eventQueue.length === 0 && screenshotQueue.length === 0) return;

    // Upload events
    if (eventQueue.length > 0) {
      const batch = eventQueue.splice(0, eventQueue.length);
      const success = await uploadBatch(batch);
      if (!success) {
        // Put back and persist for offline retry
        eventQueue.unshift(...batch);
        persistOfflineQueue();
      }
    }

    // Upload screenshots
    if (screenshotQueue.length > 0) {
      const screenshots = screenshotQueue.splice(0, screenshotQueue.length);
      for (const ss of screenshots) {
        const success = await uploadScreenshot(ss);
        if (!success) {
          screenshotQueue.unshift(ss);
          persistOfflineQueue();
          break; // Stop trying if one fails
        }
      }
    }
  }

  async function uploadBatch(events) {
    const endpoint = settings.apiEndpoint.replace(/\/$/, '');
    const payload = {
      sessionId,
      timestamp: Date.now(),
      eventCount: events.length,
      events,
    };

    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      try {
        const res = await fetch(`${endpoint}/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15000),
        });

        if (res.ok) {
          retryCount = 0;
          return true;
        }

        // Server error — retry
        if (res.status >= 500) {
          await backoff(attempt);
          continue;
        }

        // Client error — don't retry
        console.warn('EyeD upload rejected:', res.status);
        return false;
      } catch (err) {
        if (attempt < MAX_RETRY) {
          await backoff(attempt);
          continue;
        }
        console.warn('EyeD upload failed after retries:', err.message);
        return false;
      }
    }
    return false;
  }

  async function uploadScreenshot(screenshotData) {
    const endpoint = settings.apiEndpoint.replace(/\/$/, '');

    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      try {
        const res = await fetch(`${endpoint}/screenshots`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            timestamp: screenshotData.timestamp,
            url: sanitizeUrl(screenshotData.url),
            tabId: screenshotData.tabId,
            trigger: screenshotData.trigger,
            dataUrl: screenshotData.dataUrl,
            width: screenshotData.width,
            height: screenshotData.height,
          }),
          signal: AbortSignal.timeout(30000),
        });

        if (res.ok) return true;
        if (res.status >= 500) { await backoff(attempt); continue; }
        return false;
      } catch (err) {
        if (attempt < MAX_RETRY) { await backoff(attempt); continue; }
        return false;
      }
    }
    return false;
  }

  function backoff(attempt) {
    const delay = Math.min(2000 * Math.pow(2, attempt), 16000);
    return new Promise(r => setTimeout(r, delay));
  }

  async function sendSessionStart(metadata) {
    if (!settings.uploadEnabled || !settings.apiEndpoint) return;
    const endpoint = settings.apiEndpoint.replace(/\/$/, '');

    try {
      await fetch(`${endpoint}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          ...metadata,
          startTime: Date.now(),
        }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      console.warn('EyeD session start failed:', err.message);
    }
  }

  async function sendSessionEnd() {
    if (!settings.uploadEnabled || !settings.apiEndpoint) return;
    await flush(); // Flush remaining data first
    const endpoint = settings.apiEndpoint.replace(/\/$/, '');

    try {
      await fetch(`${endpoint}/sessions/${sessionId}/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endTime: Date.now() }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      console.warn('EyeD session end failed:', err.message);
    }
  }

  function newSession() {
    sessionId = crypto.randomUUID();
    eventQueue = [];
    screenshotQueue = [];
    retryCount = 0;
  }

  async function persistOfflineQueue() {
    try {
      const data = {};
      if (eventQueue.length > 0) {
        data[OFFLINE_KEY] = eventQueue.slice(0, MAX_QUEUE_SIZE);
      }
      if (screenshotQueue.length > 0) {
        data[OFFLINE_SCREENSHOT_KEY] = screenshotQueue.slice(0, 5); // Keep only 5 offline screenshots
      }
      if (Object.keys(data).length > 0) {
        await chrome.storage.local.set(data);
      }
    } catch (e) {
      console.warn('EyeD offline persist error:', e);
    }
  }

  async function restoreOfflineQueue() {
    try {
      const stored = await chrome.storage.local.get([OFFLINE_KEY, OFFLINE_SCREENSHOT_KEY]);
      if (Array.isArray(stored[OFFLINE_KEY]) && stored[OFFLINE_KEY].length > 0) {
        eventQueue.unshift(...stored[OFFLINE_KEY]);
        await chrome.storage.local.remove(OFFLINE_KEY);
      }
      if (Array.isArray(stored[OFFLINE_SCREENSHOT_KEY]) && stored[OFFLINE_SCREENSHOT_KEY].length > 0) {
        screenshotQueue.unshift(...stored[OFFLINE_SCREENSHOT_KEY]);
        await chrome.storage.local.remove(OFFLINE_SCREENSHOT_KEY);
      }
    } catch (e) {
      console.warn('EyeD offline restore error:', e);
    }
  }

  function getSessionId() { return sessionId; }
  function getQueueSize() { return eventQueue.length; }
  function getScreenshotQueueSize() { return screenshotQueue.length; }

  return {
    init,
    updateSettings,
    stop,
    enqueue,
    enqueueScreenshot,
    flush,
    sendSessionStart,
    sendSessionEnd,
    newSession,
    sanitizeUrl,
    getSessionId,
    getQueueSize,
    getScreenshotQueueSize,
  };
})();
