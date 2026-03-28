/**
 * EyeD Background Service Worker
 * Coordinates gaze data from tracker tab to content scripts on all tabs.
 * Manages session state, heatmap data, first-viewed element tracking,
 * screenshot capture, analytics data routing, and centralized upload.
 */

importScripts('uploader.js');

/* ========== STATE ========== */
let trackerTabId = null;
let trackingActive = false;
let modelReady = false;
let recordingActive = false; // Icon-toggle recording state

const heatmapData = new Map();
const sessionData = new Map();
const FIRST_VIEWED_WINDOW_MS = 5000;
const pageLoadTimes = new Map();

// Session naming and management
let currentSessionName = '';
let currentSessionStartTime = Date.now();
const savedSessions = new Map(); // name -> { startTime, endTime, data }

// Persistence: save critical state to chrome.storage.local so it survives SW restart
let persistTimer = null;
const PERSIST_INTERVAL_MS = 10000; // Save every 10s if dirty
let persistDirty = false;

const PERSIST_QUOTA_LIMIT = 8 * 1024 * 1024; // 8MB safety limit

async function persistState() {
  if (!persistDirty) return;
  try {
    const serializable = {};
    for (const [tabId, data] of heatmapData) {
      serializable[tabId] = data;
    }
    const payload = {
      _eyedHeatmapData: serializable,
      _eyedSessionData: Object.fromEntries(sessionData),
      _eyedTrackingActive: trackingActive,
      _eyedTrackerTabId: trackerTabId,
      _eyedModelReady: modelReady,
    };
    // Estimate size and guard against quota overflow
    const estimate = JSON.stringify(payload).length;
    if (estimate > PERSIST_QUOTA_LIMIT) {
      console.warn('EyeD persist skipped: payload too large (' + Math.round(estimate / 1024) + 'KB)');
      // Trim oldest tab data to fit
      const tabIds = [...heatmapData.keys()];
      while (tabIds.length > 1) {
        const oldest = tabIds.shift();
        heatmapData.delete(oldest);
        delete serializable[oldest];
        payload._eyedHeatmapData = serializable;
        if (JSON.stringify(payload).length <= PERSIST_QUOTA_LIMIT) break;
      }
    }
    await chrome.storage.local.set(payload);
    persistDirty = false;
  } catch (e) {
    console.warn('EyeD persist error:', e);
  }
}

async function restoreState() {
  try {
    const stored = await chrome.storage.local.get([
      '_eyedHeatmapData', '_eyedSessionData',
      '_eyedTrackingActive', '_eyedTrackerTabId', '_eyedModelReady',
    ]);
    if (stored._eyedHeatmapData && typeof stored._eyedHeatmapData === 'object') {
      for (const [tabIdStr, data] of Object.entries(stored._eyedHeatmapData)) {
        const tabId = parseInt(tabIdStr, 10);
        if (Number.isInteger(tabId) && tabId > 0 && data && typeof data === 'object') {
          heatmapData.set(tabId, data);
        }
      }
    }
    if (stored._eyedSessionData && typeof stored._eyedSessionData === 'object') {
      for (const [url, data] of Object.entries(stored._eyedSessionData)) {
        if (typeof url === 'string' && url.length > 0 && data && typeof data === 'object') {
          sessionData.set(url, data);
        }
      }
    }
    if (stored._eyedTrackingActive === true) trackingActive = true;
    if (typeof stored._eyedTrackerTabId === 'number') trackerTabId = stored._eyedTrackerTabId;
    if (stored._eyedModelReady === true) modelReady = true;
  } catch (e) {
    console.warn('EyeD restore error:', e);
  }
}

// Restore on startup
restoreState();

// Periodic persist
persistTimer = setInterval(persistState, PERSIST_INTERVAL_MS);

/* ========== SETTINGS ========== */
let eyedSettings = null;

async function loadSettings() {
  try {
    const result = await chrome.storage.sync.get({ eyedSettings: null });
    eyedSettings = result.eyedSettings;
    if (eyedSettings) {
      EyedUploader.init({
        apiEndpoint: eyedSettings.apiEndpoint || '',
        apiKey: eyedSettings.apiKey || '',
        uploadEnabled: eyedSettings.uploadEnabled !== false,
        batchInterval: eyedSettings.batchInterval || 30,
        stripQueryParams: eyedSettings.stripQueryParams !== false,
        stripHash: eyedSettings.stripHash || false,
        liteMode: eyedSettings.liteMode || false,
      });
    }
  } catch (e) {
    console.warn('EyeD settings load error:', e);
  }
}

function isChannelEnabled(channel) {
  if (!eyedSettings || !eyedSettings.channels) return true; // Default on
  return eyedSettings.channels[channel] !== false;
}

function isDomainAllowed(url) {
  if (!eyedSettings || eyedSettings.scopeMode === 'all' || !eyedSettings.domainList) return true;
  try {
    const hostname = new URL(url).hostname;
    const domains = eyedSettings.domainList.split('\n').map(d => d.trim()).filter(Boolean);
    if (domains.length === 0) return true;
    const match = domains.some(d => hostname === d || hostname.endsWith('.' + d));
    return eyedSettings.scopeMode === 'whitelist' ? match : !match;
  } catch {
    return true;
  }
}

loadSettings();

/* ========== ICON CLICK TOGGLE ========== */
// MV3: action.onClicked only fires when there is NO default_popup.
// We use contextMenu or programmatic popup control instead.
// Toggle recording via the popup button or message.

function toggleRecording() {
  recordingActive = !recordingActive;
  if (recordingActive) {
    // Send session start to uploader
    EyedUploader.sendSessionStart({
      sessionName: currentSessionName || 'Untitled',
      userAgent: '', // populated by first content script report
    });
    broadcastToContentScripts({ type: 'RECORDING_STATE', active: true });
  } else {
    broadcastToContentScripts({ type: 'RECORDING_STATE', active: false });
    EyedUploader.flush();
  }
  updateBadge();
  persistDirty = true;
}

// Rate limiting for broadcasts
let lastBroadcastTime = 0;
const BROADCAST_MIN_INTERVAL_MS = 40; // ~25 Hz max broadcast rate
let pendingBroadcast = null;

// Data size limits
const MAX_GAZE_POINTS_PER_TAB = 50000;
const MAX_INPUT_POINTS_PER_TAB = 20000;

/* ========== HELPERS ========== */
/** Validate that a value is a finite number (rejects NaN, Infinity, non-numbers) */
function isNum(v) { return typeof v === 'number' && isFinite(v); }

function getTabData(tabId) {
  if (!heatmapData.has(tabId)) {
    heatmapData.set(tabId, {
      url: '',
      gazePoints: [],
      touchPoints: [],
      mousePoints: [],
      firstViewedPoints: [],
      scrollEvents: [],
    });
  }
  return heatmapData.get(tabId);
}

function isFirstViewedWindow(tabId) {
  const loadTime = pageLoadTimes.get(tabId);
  if (!loadTime) return false;
  return (Date.now() - loadTime) < FIRST_VIEWED_WINDOW_MS;
}

function trimArray(arr, maxLen) {
  if (arr.length > maxLen) {
    arr.splice(0, arr.length - Math.floor(maxLen * 0.75));
  }
}

/* ========== SINGLE MESSAGE HANDLER ========== */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    switch (msg.type) {
      case 'GAZE_DATA':
        handleGazeData(msg);
        break;

      case 'TRACKING_STARTED':
        trackingActive = true;
        trackerTabId = sender.tab?.id || null;
        broadcastToContentScripts({ type: 'TRACKING_STATE', active: true });
        break;

      case 'TRACKING_STOPPED':
        trackingActive = false;
        broadcastToContentScripts({ type: 'TRACKING_STATE', active: false });
        break;

      case 'MODEL_READY':
        modelReady = true;
        trackerTabId = sender.tab?.id || null;
        break;

      case 'TOUCH_DATA':
      case 'MOUSE_DATA':
        handleInputData(msg, sender.tab?.id);
        break;

      case 'STORE_GAZE_POINT':
        handleStoreGazePoint(msg, sender);
        break;

      case 'SCROLL_EVENT':
        if (sender.tab) {
          const scrollData = getTabData(sender.tab.id);
          scrollData.scrollEvents.push({
            scrollX: msg.scrollX,
            scrollY: msg.scrollY,
            pageHeight: msg.pageHeight,
            viewHeight: msg.viewHeight,
            timestamp: msg.timestamp,
          });
          trimArray(scrollData.scrollEvents, 5000);
        }
        break;

      case 'GET_HEATMAP_DATA':
        sendResponse(getHeatmapDataForTab(msg.tabId || sender.tab?.id));
        return true;

      case 'CLEAR_HEATMAP':
        clearHeatmapData(msg.tabId || sender.tab?.id);
        sendResponse({ ok: true });
        return true;

      case 'GET_TRACKING_STATE':
        sendResponse({ active: trackingActive, modelReady, trackerTabId });
        return true;

      case 'OPEN_TRACKER':
        openTrackerTab();
        sendResponse({ ok: true });
        return true;

      case 'OPEN_INSIGHTS':
        openInsightsTab();
        sendResponse({ ok: true });
        return true;

      case 'GET_ALL_SESSION_DATA':
        sendResponse({ data: Object.fromEntries(sessionData) });
        return true;

      case 'GET_ALL_TAB_DATA': {
        const tabs = [];
        for (const [tabId, data] of heatmapData) {
          tabs.push({
            tabId,
            url: data.url,
            gazeCount: data.gazePoints.length,
            mouseCount: data.mousePoints.length,
            touchCount: data.touchPoints.length,
            firstViewedCount: data.firstViewedPoints.length,
          });
        }
        sendResponse({ tabs });
        return true;
      }

      case 'EXPORT_SESSION': {
        const exported = exportAllData();
        // Check approximate size to avoid crash
        const sizeEstimate = JSON.stringify(exported).length;
        if (sizeEstimate > 50 * 1024 * 1024) {
          sendResponse({ error: 'Session data too large to export in one batch', sizeMB: Math.round(sizeEstimate / 1024 / 1024) });
        } else {
          sendResponse({ data: exported });
        }
        return true;
      }

      case 'NAME_SESSION':
        if (typeof msg.name === 'string' && msg.name.trim().length > 0) {
          currentSessionName = msg.name.trim().substring(0, 100);
        }
        sendResponse({ ok: true, name: currentSessionName });
        return true;

      case 'GET_SESSION_INFO':
        sendResponse({
          name: currentSessionName,
          startTime: currentSessionStartTime,
          tabCount: heatmapData.size,
          totalGaze: [...heatmapData.values()].reduce((s, d) => s + d.gazePoints.length, 0),
          savedSessions: [...savedSessions.entries()].map(([name, s]) => ({
            name,
            startTime: s.startTime,
            endTime: s.endTime,
            tabCount: s.tabCount || 0,
            totalGaze: s.totalGaze || 0,
          })),
        });
        return true;

      case 'SAVE_SESSION': {
        const sessName = (typeof msg.name === 'string' && msg.name.trim()) || currentSessionName || `Session ${new Date().toLocaleString()}`;
        const sessExport = exportAllData();
        savedSessions.set(sessName, {
          startTime: currentSessionStartTime,
          endTime: Date.now(),
          tabCount: heatmapData.size,
          totalGaze: [...heatmapData.values()].reduce((s, d) => s + d.gazePoints.length, 0),
          data: sessExport,
        });
        // Persist saved sessions
        try {
          const sessObj = {};
          for (const [n, s] of savedSessions) {
            sessObj[n] = { startTime: s.startTime, endTime: s.endTime, tabCount: s.tabCount, totalGaze: s.totalGaze };
          }
          chrome.storage.local.set({ _eyedSavedSessionsMeta: sessObj });
        } catch (e) {}
        sendResponse({ ok: true, name: sessName });
        return true;
      }

      case 'LOAD_SESSION': {
        const sess = savedSessions.get(msg.name);
        if (sess?.data) {
          sendResponse({ data: sess.data });
        } else {
          sendResponse({ error: 'Session not found' });
        }
        return true;
      }

      case 'DELETE_SESSION':
        savedSessions.delete(msg.name);
        try {
          const sessObj = {};
          for (const [n, s] of savedSessions) {
            sessObj[n] = { startTime: s.startTime, endTime: s.endTime, tabCount: s.tabCount, totalGaze: s.totalGaze };
          }
          chrome.storage.local.set({ _eyedSavedSessionsMeta: sessObj });
        } catch (e) {}
        sendResponse({ ok: true });
        return true;

      case 'NEW_SESSION':
        // Save current if named, then reset
        if (currentSessionName) {
          savedSessions.set(currentSessionName, {
            startTime: currentSessionStartTime,
            endTime: Date.now(),
            tabCount: heatmapData.size,
            totalGaze: [...heatmapData.values()].reduce((s, d) => s + d.gazePoints.length, 0),
            data: exportAllData(),
          });
        }
        heatmapData.clear();
        sessionData.clear();
        currentSessionName = (typeof msg.name === 'string') ? msg.name.trim().substring(0, 100) : '';
        currentSessionStartTime = Date.now();
        persistDirty = true;
        sendResponse({ ok: true });
        return true;

      case 'TOGGLE_RECORDING':
        toggleRecording();
        sendResponse({ recording: recordingActive });
        return true;

      case 'GET_RECORDING_STATE':
        sendResponse({ recording: recordingActive });
        return true;

      case 'SETTINGS_UPDATED':
        eyedSettings = msg.settings;
        if (eyedSettings) {
          EyedUploader.updateSettings({
            apiEndpoint: eyedSettings.apiEndpoint || '',
            apiKey: eyedSettings.apiKey || '',
            uploadEnabled: eyedSettings.uploadEnabled !== false,
            batchInterval: eyedSettings.batchInterval || 30,
            stripQueryParams: eyedSettings.stripQueryParams !== false,
            stripHash: eyedSettings.stripHash || false,
            liteMode: eyedSettings.liteMode || false,
          });
        }
        // Forward settings to content scripts
        broadcastToContentScripts({ type: 'SETTINGS_UPDATED', settings: eyedSettings });
        sendResponse({ ok: true });
        return true;

      case 'GET_SETTINGS':
        sendResponse({ settings: eyedSettings });
        return true;

      case 'OPEN_SETTINGS':
        chrome.runtime.openOptionsPage();
        sendResponse({ ok: true });
        return true;

      case 'CONTENT_EVENTS': {
        // Batch events from content scripts for upload
        if (!recordingActive) break;
        // Validate sender is a real tab (not injected)
        if (!sender.tab?.id || !sender.tab?.url) break;
        if (sender.tab.url.startsWith('chrome://') || sender.tab.url.startsWith('chrome-extension://')) break;
        if (!isDomainAllowed(sender.tab.url)) break;

        const events = msg.events;
        if (!Array.isArray(events)) break;
        // Cap batch size to prevent memory exhaustion
        const MAX_EVENTS_PER_MSG = 200;
        const bounded = events.slice(0, MAX_EVENTS_PER_MSG);
        if (bounded.length > 0) {
          const sanitizedUrl = EyedUploader.sanitizeUrl(sender.tab.url);
          const enriched = bounded.map(e => ({
            ...(typeof e === 'object' && e !== null ? e : {}),
            url: sanitizedUrl,
            tabId: sender.tab.id,
          }));
          EyedUploader.enqueue(enriched); // Uploader does per-event validation
        }
        break;
      }

      case 'AUTO_SCREENSHOT': {
        // Auto-screenshot from content script for upload
        if (!recordingActive || !isChannelEnabled('autoScreenshots')) break;
        if (!sender.tab?.id || !sender.tab?.url) break;
        if (!isDomainAllowed(sender.tab.url)) break;

        // Validate screenshot payload
        if (typeof msg.dataUrl !== 'string' || !msg.dataUrl.startsWith('data:image/')) break;
        if (msg.dataUrl.length > 5 * 1024 * 1024) break; // 5MB max
        if (!isNum(msg.width) || msg.width < 1 || msg.width > 4096) break;
        if (!isNum(msg.height) || msg.height < 1 || msg.height > 4096) break;

        EyedUploader.enqueueScreenshot({
          timestamp: isNum(msg.timestamp) ? msg.timestamp : Date.now(),
          url: sender.tab.url,
          tabId: sender.tab.id,
          trigger: msg.trigger || 'periodic',
          dataUrl: msg.dataUrl,
          width: msg.width,
          height: msg.height,
        });
        break;
      }

      case 'CAPTURE_SCREENSHOT':
        captureScreenshot(sender.tab?.id, sendResponse);
        return true;

      case 'SCREENSHOT_PROGRESS':
        // Forward to popup if open — non-critical, fire and forget
        break;
    }
  } catch (err) {
    console.error('Service worker message error:', err, msg.type);
    if (sendResponse) {
      try { sendResponse({ error: err.message }); } catch (e) { /* port closed */ }
    }
  }
});

/* ========== GAZE DATA DISTRIBUTION ========== */
function handleGazeData(msg) {
  if (!trackingActive) return;
  // Validate numeric inputs
  if (!isNum(msg.x) || !isNum(msg.y) || !isNum(msg.timestamp)) return;

  // Route to uploader for centralized collection
  routeToUploader('gaze', { x: msg.x, y: msg.y, timestamp: msg.timestamp, confidence: msg.confidence }, '');

  const now = Date.now();
  const gazeMsg = {
    type: 'GAZE_POINT',
    x: msg.x,
    y: msg.y,
    timestamp: msg.timestamp,
    confidence: isNum(msg.confidence) ? msg.confidence : 0,
  };

  // Rate-limit broadcasts to prevent spamming tabs
  if (now - lastBroadcastTime >= BROADCAST_MIN_INTERVAL_MS) {
    lastBroadcastTime = now;
    broadcastToContentScripts(gazeMsg);
    pendingBroadcast = null;
  } else {
    // Queue the latest point; it will be sent on next broadcast window
    if (!pendingBroadcast) {
      pendingBroadcast = setTimeout(() => {
        if (pendingBroadcast) {
          broadcastToContentScripts(gazeMsg);
          pendingBroadcast = null;
          lastBroadcastTime = Date.now();
        }
      }, BROADCAST_MIN_INTERVAL_MS);
    }
  }
}

function handleInputData(msg, tabId) {
  if (!tabId) return;

  // Route to uploader
  const channel = msg.type === 'TOUCH_DATA' ? 'touch' : 'mouse';
  routeToUploader(channel, { x: msg.x, y: msg.y, pageX: msg.pageX, pageY: msg.pageY, timestamp: msg.timestamp }, '');

  const data = getTabData(tabId);
  const point = {
    x: msg.x, y: msg.y,
    pageX: msg.pageX, pageY: msg.pageY,
    timestamp: msg.timestamp,
  };

  if (msg.type === 'TOUCH_DATA') {
    data.touchPoints.push(point);
    trimArray(data.touchPoints, MAX_INPUT_POINTS_PER_TAB);
  } else {
    data.mousePoints.push(point);
    trimArray(data.mousePoints, MAX_INPUT_POINTS_PER_TAB);
  }
  persistDirty = true;
}

function handleStoreGazePoint(msg, sender) {
  if (!sender.tab) return;
  // Validate required numeric fields
  if (!isNum(msg.x) || !isNum(msg.y) || !isNum(msg.timestamp)) return;

  // Route to uploader with full data
  routeToUploader('gaze', {
    x: msg.x, y: msg.y,
    pageX: msg.pageX, pageY: msg.pageY,
    scrollX: msg.scrollX, scrollY: msg.scrollY,
    viewportWidth: msg.viewportWidth, viewportHeight: msg.viewportHeight,
    timestamp: msg.timestamp,
    videoTime: msg.videoTime, onVideo: msg.onVideo,
  }, sender.tab?.url || '');

  const tabId = sender.tab.id;
  const data = getTabData(tabId);

  const point = {
    x: msg.x, y: msg.y,
    pageX: isNum(msg.pageX) ? msg.pageX : null,
    pageY: isNum(msg.pageY) ? msg.pageY : null,
    scrollX: isNum(msg.scrollX) ? msg.scrollX : 0,
    scrollY: isNum(msg.scrollY) ? msg.scrollY : 0,
    timestamp: msg.timestamp,
    videoTime: isNum(msg.videoTime) ? msg.videoTime : null,
    onVideo: msg.onVideo === true,
  };

  data.gazePoints.push(point);
  trimArray(data.gazePoints, MAX_GAZE_POINTS_PER_TAB);

  if (isFirstViewedWindow(tabId)) {
    data.firstViewedPoints.push(point);
  }

  if (sender.tab.url) data.url = sender.tab.url;
  // Store viewport dimensions for correct analytics in insights page
  if (isNum(msg.viewportWidth) && isNum(msg.viewportHeight)) {
    data.viewportWidth = msg.viewportWidth;
    data.viewportHeight = msg.viewportHeight;
  }
  persistDirty = true;
}

function broadcastToContentScripts(message) {
  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError) return;

    for (const tab of tabs) {
      if (tab.id === trackerTabId) continue;
      if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) continue;

      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  });
}

/* ========== HEATMAP DATA ========== */
function getHeatmapDataForTab(tabId) {
  const data = heatmapData.get(tabId);
  if (!data) return { gazePoints: [], touchPoints: [], mousePoints: [], firstViewedPoints: [], scrollEvents: [] };
  return {
    url: data.url,
    viewportWidth: data.viewportWidth || null,
    viewportHeight: data.viewportHeight || null,
    gazePoints: data.gazePoints,
    touchPoints: data.touchPoints,
    mousePoints: data.mousePoints,
    firstViewedPoints: data.firstViewedPoints,
    scrollEvents: data.scrollEvents,
  };
}

function clearHeatmapData(tabId) {
  if (tabId) heatmapData.delete(tabId);
  persistDirty = true;
}

function exportAllData() {
  const allData = {};
  for (const [tabId, data] of heatmapData) {
    allData[tabId] = {
      url: data.url,
      viewportWidth: data.viewportWidth || null,
      viewportHeight: data.viewportHeight || null,
      gazePoints: data.gazePoints,
      touchPoints: data.touchPoints,
      mousePoints: data.mousePoints,
      firstViewedPoints: data.firstViewedPoints,
    };
  }
  return {
    heatmapData: allData,
    sessionData: Object.fromEntries(sessionData),
    exportDate: new Date().toISOString(),
  };
}

/* ========== SCREENSHOT CAPTURE ========== */
function captureScreenshot(tabId, sendResponse) {
  const doCap = (windowId) => {
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
        return;
      }
      sendResponse({ dataUrl });
    });
  };

  if (tabId) {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        sendResponse({ error: 'Tab not found' });
        return;
      }
      doCap(tab.windowId);
    });
  } else {
    doCap(null);
  }
}

/* ========== TAB LIFECYCLE ========== */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    // Don't track extension pages
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) return;

    pageLoadTimes.set(tabId, Date.now());

    const data = getTabData(tabId);
    data.url = tab.url;
    data.gazePoints = [];
    data.touchPoints = [];
    data.mousePoints = [];
    data.firstViewedPoints = [];
    data.scrollEvents = [];

    chrome.tabs.sendMessage(tabId, {
      type: 'NEW_PAGE_LOADED',
      timestamp: Date.now(),
    }).catch(() => {});

    setTimeout(() => {
      pageLoadTimes.delete(tabId);
    }, FIRST_VIEWED_WINDOW_MS);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const data = heatmapData.get(tabId);
  if (data && data.url && data.gazePoints.length > 0) {
    const existing = sessionData.get(data.url) || {
      gazePoints: [], touchPoints: [], mousePoints: [], firstViewedPoints: []
    };
    // Limit session data growth
    const maxSessionPts = 100000;
    if (existing.gazePoints.length < maxSessionPts) {
      existing.gazePoints.push(...data.gazePoints);
      existing.touchPoints.push(...data.touchPoints);
      existing.mousePoints.push(...data.mousePoints);
      existing.firstViewedPoints.push(...data.firstViewedPoints);
      trimArray(existing.gazePoints, maxSessionPts);
      trimArray(existing.touchPoints, maxSessionPts);
      trimArray(existing.mousePoints, maxSessionPts);
    }
    sessionData.set(data.url, existing);
    persistDirty = true;
  }

  heatmapData.delete(tabId);
  pageLoadTimes.delete(tabId);
  persistDirty = true;
});

/* ========== TRACKER / INSIGHTS TABS ========== */
function openTrackerTab() {
  const trackerUrl = chrome.runtime.getURL('tracker/tracker.html');
  chrome.tabs.query({ url: trackerUrl }, (tabs) => {
    if (chrome.runtime.lastError) return;
    if (tabs.length > 0) {
      chrome.tabs.update(tabs[0].id, { active: true });
    } else {
      chrome.tabs.create({ url: trackerUrl, pinned: true }, (tab) => {
        if (tab) trackerTabId = tab.id;
      });
    }
  });
}

function openInsightsTab() {
  const insightsUrl = chrome.runtime.getURL('insights/insights.html');
  chrome.tabs.query({ url: insightsUrl }, (tabs) => {
    if (chrome.runtime.lastError) return;
    if (tabs.length > 0) {
      chrome.tabs.update(tabs[0].id, { active: true });
    } else {
      chrome.tabs.create({ url: insightsUrl });
    }
  });
}

/* ========== BADGE ========== */
function updateBadge() {
  if (recordingActive) {
    // Green when recording
    chrome.action.setBadgeText({ text: 'REC' }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: '#238636' }).catch(() => {});
  } else if (trackingActive) {
    chrome.action.setBadgeText({ text: 'ON' }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: '#1f6feb' }).catch(() => {});
  } else {
    // Red dot when idle
    chrome.action.setBadgeText({ text: 'OFF' }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: '#da3633' }).catch(() => {});
  }
}

setInterval(updateBadge, 2000);

// Also route gaze/input data to uploader when recording
function routeToUploader(eventType, data, tabUrl) {
  if (!recordingActive) return;
  if (!isDomainAllowed(tabUrl)) return;
  if (!isChannelEnabled(eventType)) return;

  EyedUploader.enqueue([{
    type: eventType,
    ...data,
    url: EyedUploader.sanitizeUrl(tabUrl),
  }]);
}

/* ========== KEYBOARD SHORTCUTS ========== */
chrome.commands.onCommand.addListener((command) => {
  switch (command) {
    case 'toggle-recording':
      toggleRecording();
      break;
    case 'toggle-heatmap':
      broadcastToContentScripts({ type: 'TOGGLE_HEATMAP' });
      break;
    case 'take-screenshot':
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'CAPTURE_VIEWPORT_SCREENSHOT' }).catch(() => {});
        }
      });
      break;
  }
});

/* ========== NETWORK STATUS ========== */
let networkStatus = 'unknown'; // 'connected', 'disconnected', 'error', 'no-key'

async function checkEndpointStatus() {
  if (!eyedSettings?.apiEndpoint || !eyedSettings?.apiKey) {
    networkStatus = eyedSettings?.apiEndpoint ? 'no-key' : 'disconnected';
    return;
  }
  try {
    const res = await fetch(`${eyedSettings.apiEndpoint}/health`, {
      signal: AbortSignal.timeout(5000),
      headers: eyedSettings.apiKey ? { 'Authorization': `Bearer ${eyedSettings.apiKey}` } : {},
    });
    networkStatus = res.ok ? 'connected' : (res.status === 401 ? 'auth-error' : 'error');
  } catch {
    networkStatus = 'disconnected';
  }
}

// Check every 60 seconds
setInterval(checkEndpointStatus, 60000);
// Check on startup after settings load
setTimeout(checkEndpointStatus, 3000);

/* ========== AUTO SESSION NAMING ========== */
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (!recordingActive || currentSessionName) return;
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab?.url) return;
    try {
      const hostname = new URL(tab.url).hostname;
      if (hostname && !hostname.startsWith('chrome')) {
        currentSessionName = `${hostname} — ${new Date().toLocaleDateString()}`;
      }
    } catch {}
  });
});

/* ========== EXTENDED STATUS ========== */
// Add network status to GET_RECORDING_STATE responses
const _originalRecordingHandler = true; // Flag: extended handler below

// Override the GET_RECORDING_STATE and GET_TRACKING_STATE to include network/queue info
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_NETWORK_STATUS') {
    sendResponse({
      network: networkStatus,
      queueSize: EyedUploader.getQueueSize(),
      screenshotQueue: EyedUploader.getScreenshotQueueSize(),
      endpoint: eyedSettings?.apiEndpoint ? true : false,
      hasKey: eyedSettings?.apiKey ? true : false,
    });
    return true;
  }
});

console.log('EyeD service worker v1.3 initialized');
