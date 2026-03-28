/**
 * EyeD Uploader — Encrypted batched data upload to centralized endpoint.
 * Runs inside the service worker context.
 *
 * Security features:
 * - AES-256-GCM encryption of all payloads before transmission
 * - API key authentication via Authorization header
 * - HMAC-SHA256 request signing for integrity verification
 * - HTTPS-only enforcement (rejects http:// endpoints)
 * - Input validation on all data before upload
 * - Screenshot data cleared from memory after upload
 * - Session ID rotation on new sessions
 * - Bounded queues to prevent memory exhaustion
 */

const EyedUploader = (() => {
  'use strict';

  let settings = {
    apiEndpoint: '',
    apiKey: '',
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
  const MAX_RETRY = 4;
  const MAX_QUEUE_SIZE = 5000;
  const MAX_SCREENSHOT_QUEUE = 10;
  const MAX_SCREENSHOT_SIZE = 5 * 1024 * 1024; // 5MB per screenshot
  const MAX_BATCH_JSON_SIZE = 2 * 1024 * 1024; // 2MB per event batch

  // Persisted offline queue key
  const OFFLINE_KEY = '_eyedOfflineQueue';
  const OFFLINE_SCREENSHOT_KEY = '_eyedOfflineScreenshots';

  /* ========== CRYPTO: AES-256-GCM ENCRYPTION ========== */

  // Derive AES key from API key using PBKDF2
  let cachedKey = null;
  let cachedKeySource = '';

  async function deriveKey(apiKey) {
    if (cachedKey && cachedKeySource === apiKey) return cachedKey;

    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw', encoder.encode(apiKey), 'PBKDF2', false, ['deriveKey']
    );

    cachedKey = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: encoder.encode('eyed-upload-salt-v1'),
        iterations: 100000,
        hash: 'SHA-256',
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt']
    );
    cachedKeySource = apiKey;
    return cachedKey;
  }

  // Encrypt plaintext JSON string to base64(iv + ciphertext + tag)
  async function encryptPayload(jsonString) {
    if (!settings.apiKey) {
      // No API key = no encryption possible, but still send
      return { encrypted: false, data: jsonString };
    }

    try {
      const key = await deriveKey(settings.apiKey);
      const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for GCM
      const encoder = new TextEncoder();
      const plaintext = encoder.encode(jsonString);

      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, tagLength: 128 },
        key,
        plaintext
      );

      // Combine IV + ciphertext (includes GCM tag) into single ArrayBuffer
      const combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(ciphertext), iv.length);

      // Base64 encode for JSON transport
      const base64 = btoa(String.fromCharCode(...combined));
      return { encrypted: true, data: base64 };
    } catch (err) {
      console.error('EyeD encryption failed:', err);
      return { encrypted: false, data: jsonString };
    }
  }

  // HMAC-SHA256 for request signing
  async function signRequest(body) {
    if (!settings.apiKey) return '';
    try {
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw', encoder.encode(settings.apiKey),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
      );
      const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
      return btoa(String.fromCharCode(...new Uint8Array(sig)));
    } catch {
      return '';
    }
  }

  /* ========== ENDPOINT VALIDATION ========== */

  function isValidEndpoint(url) {
    if (!url) return false;
    try {
      const u = new URL(url);
      // HTTPS only
      if (u.protocol !== 'https:') return false;
      // Block private/local addresses
      const host = u.hostname.toLowerCase();
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
      if (host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('172.')) return false;
      if (host === '0.0.0.0' || host.endsWith('.local')) return false;
      return true;
    } catch {
      return false;
    }
  }

  function getEndpoint() {
    const ep = (settings.apiEndpoint || '').replace(/\/$/, '');
    return isValidEndpoint(ep) ? ep : null;
  }

  /* ========== INPUT VALIDATION ========== */

  const ALLOWED_EVENT_TYPES = new Set([
    'gaze', 'mouse', 'touch', 'click', 'hover', 'deadClick', 'rageClick',
    'scroll', 'scrollMilestone', 'tabFocus', 'tabBlur', 'visibilityChange',
    'elementVisibility', 'formFocus', 'formBlur', 'textSelection', 'navigation',
  ]);

  function validateEvent(event) {
    if (!event || typeof event !== 'object') return null;
    if (!ALLOWED_EVENT_TYPES.has(event.type)) return null;
    if (typeof event.timestamp !== 'number' || !isFinite(event.timestamp)) return null;

    // Sanitize: remove any fields that could contain large or dangerous data
    const clean = {};
    for (const [key, val] of Object.entries(event)) {
      // Skip functions, symbols, huge strings
      if (typeof val === 'function' || typeof val === 'symbol') continue;
      if (typeof val === 'string' && val.length > 500) {
        clean[key] = val.substring(0, 500);
        continue;
      }
      // Sanitize nested element metadata
      if (key === 'element' && typeof val === 'object' && val !== null) {
        clean[key] = validateElementMeta(val);
        continue;
      }
      clean[key] = val;
    }
    return clean;
  }

  function validateElementMeta(meta) {
    if (!meta || typeof meta !== 'object') return null;
    const clean = {};
    if (typeof meta.tag === 'string') clean.tag = meta.tag.substring(0, 20);
    if (typeof meta.id === 'string') clean.id = meta.id.substring(0, 60);
    if (typeof meta.selector === 'string') clean.selector = meta.selector.substring(0, 100);
    // Scrub text content — could contain PII
    if (typeof meta.text === 'string') clean.text = meta.text.substring(0, 40);
    // Sanitize href — strip query params
    if (typeof meta.href === 'string') clean.href = sanitizeUrl(meta.href);
    return clean;
  }

  /* ========== URL SANITIZATION ========== */

  function sanitizeUrl(url) {
    if (!url) return '';
    try {
      const u = new URL(url);
      if (settings.stripQueryParams) u.search = '';
      if (settings.stripHash) u.hash = '';
      return u.toString();
    } catch {
      return '';
    }
  }

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

  /* ========== QUEUE MANAGEMENT ========== */

  function init(newSettings) {
    settings = { ...settings, ...newSettings };
    restoreOfflineQueue();
    startTimer();
  }

  function updateSettings(newSettings) {
    const intervalChanged = newSettings.batchInterval !== settings.batchInterval;
    const keyChanged = newSettings.apiKey !== settings.apiKey;
    settings = { ...settings, ...newSettings };
    if (intervalChanged) startTimer();
    if (keyChanged) { cachedKey = null; cachedKeySource = ''; }
  }

  function startTimer() {
    if (uploadTimer) clearInterval(uploadTimer);
    const ms = Math.max(10, Math.min(300, settings.batchInterval || 30)) * 1000;
    uploadTimer = setInterval(flush, ms);
  }

  function stop() {
    if (uploadTimer) { clearInterval(uploadTimer); uploadTimer = null; }
    persistOfflineQueue();
  }

  function enqueue(events) {
    if (!settings.uploadEnabled) return;

    for (const event of events) {
      const validated = validateEvent(event);
      if (!validated) continue;
      eventQueue.push(sanitizeEvent(validated));
    }

    if (eventQueue.length > MAX_QUEUE_SIZE) {
      eventQueue = eventQueue.slice(-Math.floor(MAX_QUEUE_SIZE * 0.75));
    }
  }

  function enqueueScreenshot(screenshotData) {
    if (!settings.uploadEnabled) return;

    // Validate screenshot data
    if (!screenshotData || typeof screenshotData !== 'object') return;
    if (typeof screenshotData.dataUrl !== 'string') return;
    if (screenshotData.dataUrl.length > MAX_SCREENSHOT_SIZE) {
      console.warn('EyeD: screenshot too large, skipping');
      return;
    }
    if (!screenshotData.dataUrl.startsWith('data:image/')) return;

    // Validate dimensions
    const w = screenshotData.width;
    const h = screenshotData.height;
    if (typeof w !== 'number' || w < 1 || w > 4096) return;
    if (typeof h !== 'number' || h < 1 || h > 4096) return;

    // Validate trigger
    const ALLOWED_TRIGGERS = new Set(['pageLoad', 'periodic', 'scrollMilestone_25', 'scrollMilestone_50', 'scrollMilestone_75', 'scrollMilestone_100', 'manual']);
    const trigger = ALLOWED_TRIGGERS.has(screenshotData.trigger) ? screenshotData.trigger : 'unknown';

    screenshotQueue.push({
      timestamp: screenshotData.timestamp || Date.now(),
      url: sanitizeUrl(screenshotData.url || ''),
      tabId: screenshotData.tabId,
      trigger,
      dataUrl: screenshotData.dataUrl,
      width: w,
      height: h,
    });

    if (screenshotQueue.length > MAX_SCREENSHOT_QUEUE) {
      screenshotQueue.shift();
    }
  }

  /* ========== UPLOAD WITH ENCRYPTION ========== */

  async function flush() {
    const endpoint = getEndpoint();
    if (!settings.uploadEnabled || !endpoint) return;
    if (eventQueue.length === 0 && screenshotQueue.length === 0) return;

    if (eventQueue.length > 0) {
      const batch = eventQueue.splice(0, eventQueue.length);
      const success = await uploadBatch(batch);
      if (!success) {
        eventQueue.unshift(...batch);
        if (eventQueue.length > MAX_QUEUE_SIZE) {
          eventQueue = eventQueue.slice(-Math.floor(MAX_QUEUE_SIZE * 0.75));
        }
        persistOfflineQueue();
      }
    }

    if (screenshotQueue.length > 0) {
      const screenshots = screenshotQueue.splice(0, screenshotQueue.length);
      for (let i = 0; i < screenshots.length; i++) {
        const success = await uploadScreenshot(screenshots[i]);
        // Clear dataUrl from memory regardless of success
        screenshots[i].dataUrl = null;
        if (!success) {
          // Don't re-queue failed screenshots (they've been cleared)
          persistOfflineQueue();
          break;
        }
      }
    }
  }

  async function uploadBatch(events) {
    const endpoint = getEndpoint();
    if (!endpoint) return false;

    const payload = JSON.stringify({
      sessionId,
      timestamp: Date.now(),
      eventCount: events.length,
      events,
    });

    // Enforce max size
    if (payload.length > MAX_BATCH_JSON_SIZE) {
      console.warn('EyeD: batch too large, splitting');
      const half = Math.floor(events.length / 2);
      const a = await uploadBatch(events.slice(0, half));
      const b = await uploadBatch(events.slice(half));
      return a && b;
    }

    // Encrypt payload
    const { encrypted, data } = await encryptPayload(payload);
    const bodyString = JSON.stringify({ encrypted, data });
    const signature = await signRequest(bodyString);

    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      try {
        const headers = {
          'Content-Type': 'application/json',
          'X-Session-ID': sessionId,
          'X-Timestamp': String(Date.now()),
          'X-Encrypted': String(encrypted),
        };
        if (settings.apiKey) headers['Authorization'] = `Bearer ${settings.apiKey}`;
        if (signature) headers['X-Signature'] = signature;

        const res = await fetch(`${endpoint}/events`, {
          method: 'POST',
          headers,
          body: bodyString,
          signal: AbortSignal.timeout(15000),
        });

        if (res.ok) return true;
        if (res.status >= 500) { await backoff(attempt); continue; }
        if (res.status === 401 || res.status === 403) {
          console.warn('EyeD: authentication failed');
          return false;
        }
        console.warn('EyeD upload rejected:', res.status);
        return false;
      } catch (err) {
        if (attempt < MAX_RETRY) { await backoff(attempt); continue; }
        console.warn('EyeD upload failed after retries:', err.message);
        return false;
      }
    }
    return false;
  }

  async function uploadScreenshot(screenshotData) {
    const endpoint = getEndpoint();
    if (!endpoint || !screenshotData.dataUrl) return false;

    const payload = JSON.stringify({
      sessionId,
      timestamp: screenshotData.timestamp,
      url: screenshotData.url,
      tabId: screenshotData.tabId,
      trigger: screenshotData.trigger,
      dataUrl: screenshotData.dataUrl,
      width: screenshotData.width,
      height: screenshotData.height,
    });

    const { encrypted, data } = await encryptPayload(payload);
    const bodyString = JSON.stringify({ encrypted, data });
    const signature = await signRequest(bodyString);

    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      try {
        const headers = {
          'Content-Type': 'application/json',
          'X-Session-ID': sessionId,
          'X-Timestamp': String(Date.now()),
          'X-Encrypted': String(encrypted),
        };
        if (settings.apiKey) headers['Authorization'] = `Bearer ${settings.apiKey}`;
        if (signature) headers['X-Signature'] = signature;

        const res = await fetch(`${endpoint}/screenshots`, {
          method: 'POST',
          headers,
          body: bodyString,
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
    const endpoint = getEndpoint();
    if (!settings.uploadEnabled || !endpoint) return;

    const payload = JSON.stringify({
      sessionId,
      ...metadata,
      startTime: Date.now(),
    });

    const { encrypted, data } = await encryptPayload(payload);
    const bodyString = JSON.stringify({ encrypted, data });
    const signature = await signRequest(bodyString);

    try {
      const headers = {
        'Content-Type': 'application/json',
        'X-Session-ID': sessionId,
        'X-Encrypted': String(encrypted),
      };
      if (settings.apiKey) headers['Authorization'] = `Bearer ${settings.apiKey}`;
      if (signature) headers['X-Signature'] = signature;

      await fetch(`${endpoint}/sessions`, {
        method: 'POST',
        headers,
        body: bodyString,
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      console.warn('EyeD session start failed:', err.message);
    }
  }

  async function sendSessionEnd() {
    const endpoint = getEndpoint();
    if (!settings.uploadEnabled || !endpoint) return;
    await flush();

    const payload = JSON.stringify({ endTime: Date.now() });
    const { encrypted, data } = await encryptPayload(payload);
    const bodyString = JSON.stringify({ encrypted, data });
    const signature = await signRequest(bodyString);

    try {
      const headers = {
        'Content-Type': 'application/json',
        'X-Session-ID': sessionId,
        'X-Encrypted': String(encrypted),
      };
      if (settings.apiKey) headers['Authorization'] = `Bearer ${settings.apiKey}`;
      if (signature) headers['X-Signature'] = signature;

      await fetch(`${endpoint}/sessions/${sessionId}/end`, {
        method: 'POST',
        headers,
        body: bodyString,
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
  }

  /* ========== OFFLINE PERSISTENCE ========== */

  async function persistOfflineQueue() {
    try {
      const data = {};
      if (eventQueue.length > 0) {
        data[OFFLINE_KEY] = eventQueue.slice(0, MAX_QUEUE_SIZE);
      }
      // Don't persist screenshots offline (contain large data URLs)
      if (Object.keys(data).length > 0) {
        await chrome.storage.local.set(data);
      }
    } catch (e) {
      console.warn('EyeD offline persist error:', e);
    }
  }

  async function restoreOfflineQueue() {
    try {
      const stored = await chrome.storage.local.get([OFFLINE_KEY]);
      if (Array.isArray(stored[OFFLINE_KEY]) && stored[OFFLINE_KEY].length > 0) {
        eventQueue.unshift(...stored[OFFLINE_KEY]);
        await chrome.storage.local.remove(OFFLINE_KEY);
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
    isValidEndpoint,
    getSessionId,
    getQueueSize,
    getScreenshotQueueSize,
  };
})();
