/**
 * EyeD Background Service Worker
 * Coordinates gaze data from tracker tab to content scripts on all tabs.
 * Manages session state, heatmap data, first-viewed element tracking,
 * screenshot capture, and analytics data routing.
 */

/* ========== STATE ========== */
let trackerTabId = null;
let trackingActive = false;
let modelReady = false;

const heatmapData = new Map();
const sessionData = new Map();
const FIRST_VIEWED_WINDOW_MS = 5000;
const pageLoadTimes = new Map();

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
  const text = trackingActive ? 'ON' : '';
  const color = trackingActive ? '#238636' : '#484f58';
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
}

setInterval(updateBadge, 2000);

console.log('EyeD service worker v1.1 initialized');
