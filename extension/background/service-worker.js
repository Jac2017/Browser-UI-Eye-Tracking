/**
 * EyeD Background Service Worker
 * Coordinates gaze data from tracker tab to content scripts on all tabs.
 * Manages session state, heatmap data, and first-viewed element tracking.
 */

/* ========== STATE ========== */
let trackerTabId = null;
let trackingActive = false;
let modelReady = false;

// Heatmap data stored per tab/URL
// Key: tabId, Value: { url, gazePoints[], touchPoints[], mousePoints[], firstViewed[] }
const heatmapData = new Map();

// Session-level aggregate data keyed by URL
const sessionData = new Map();

// Track which tabs are newly loaded (for first-viewed detection)
const newPageTabs = new Set();

// First-viewed tracking: after page load, first N gaze points are tagged
const FIRST_VIEWED_WINDOW_MS = 5000; // 5 seconds after page load
const pageLoadTimes = new Map(); // tabId -> timestamp

/* ========== HELPERS ========== */
function getTabData(tabId) {
  if (!heatmapData.has(tabId)) {
    heatmapData.set(tabId, {
      url: '',
      gazePoints: [],
      touchPoints: [],
      mousePoints: [],
      firstViewedPoints: [],
    });
  }
  return heatmapData.get(tabId);
}

function isFirstViewedWindow(tabId) {
  const loadTime = pageLoadTimes.get(tabId);
  if (!loadTime) return false;
  return (Date.now() - loadTime) < FIRST_VIEWED_WINDOW_MS;
}

/* ========== MESSAGE HANDLING ========== */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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

    case 'GET_ALL_SESSION_DATA':
      sendResponse({ data: Object.fromEntries(sessionData) });
      return true;

    case 'EXPORT_SESSION':
      sendResponse({ data: exportAllData() });
      return true;
  }
});

/* ========== GAZE DATA DISTRIBUTION ========== */
function handleGazeData(msg) {
  if (!trackingActive) return;

  // Forward gaze data to all content scripts (except tracker tab)
  broadcastToContentScripts({
    type: 'GAZE_POINT',
    x: msg.x,
    y: msg.y,
    timestamp: msg.timestamp,
    confidence: msg.confidence,
  });
}

function handleInputData(msg, tabId) {
  if (!tabId) return;

  const data = getTabData(tabId);
  const point = { x: msg.x, y: msg.y, timestamp: msg.timestamp };

  if (msg.type === 'TOUCH_DATA') {
    data.touchPoints.push(point);
  } else {
    data.mousePoints.push(point);
  }
}

function broadcastToContentScripts(message) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      // Skip the tracker tab
      if (tab.id === trackerTabId) continue;
      // Skip chrome:// and extension pages
      if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) continue;

      chrome.tabs.sendMessage(tab.id, message).catch(() => {
        // Tab might not have content script loaded
      });
    }
  });
}

/* ========== HEATMAP DATA ========== */
function getHeatmapDataForTab(tabId) {
  const data = heatmapData.get(tabId);
  if (!data) return { gazePoints: [], touchPoints: [], mousePoints: [], firstViewedPoints: [] };
  return {
    gazePoints: data.gazePoints,
    touchPoints: data.touchPoints,
    mousePoints: data.mousePoints,
    firstViewedPoints: data.firstViewedPoints,
  };
}

function clearHeatmapData(tabId) {
  if (tabId) {
    heatmapData.delete(tabId);
  }
}

function exportAllData() {
  const allData = {};
  for (const [tabId, data] of heatmapData) {
    allData[tabId] = { ...data };
  }
  return {
    heatmapData: allData,
    sessionData: Object.fromEntries(sessionData),
    exportDate: new Date().toISOString(),
  };
}

/* ========== TAB LIFECYCLE ========== */
// Track new page loads for first-viewed detection
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    // Mark tab as newly loaded
    pageLoadTimes.set(tabId, Date.now());
    newPageTabs.add(tabId);

    // Initialize fresh heatmap data for this tab
    const data = getTabData(tabId);
    data.url = tab.url;
    data.gazePoints = [];
    data.touchPoints = [];
    data.mousePoints = [];
    data.firstViewedPoints = [];

    // Notify content script about new page
    chrome.tabs.sendMessage(tabId, {
      type: 'NEW_PAGE_LOADED',
      timestamp: Date.now(),
    }).catch(() => {});

    // Clear first-viewed window after timeout
    setTimeout(() => {
      newPageTabs.delete(tabId);
      pageLoadTimes.delete(tabId);
    }, FIRST_VIEWED_WINDOW_MS);
  }
});

// Clean up when tabs close
chrome.tabs.onRemoved.addListener((tabId) => {
  // Save data to session before removing
  const data = heatmapData.get(tabId);
  if (data && data.url && data.gazePoints.length > 0) {
    const existing = sessionData.get(data.url) || { gazePoints: [], touchPoints: [], mousePoints: [], firstViewedPoints: [] };
    existing.gazePoints.push(...data.gazePoints);
    existing.touchPoints.push(...data.touchPoints);
    existing.mousePoints.push(...data.mousePoints);
    existing.firstViewedPoints.push(...data.firstViewedPoints);
    sessionData.set(data.url, existing);
  }

  heatmapData.delete(tabId);
  newPageTabs.delete(tabId);
  pageLoadTimes.delete(tabId);
});

/* ========== TRACKER TAB ========== */
function openTrackerTab() {
  const trackerUrl = chrome.runtime.getURL('tracker/tracker.html');

  // Check if tracker tab already exists
  chrome.tabs.query({ url: trackerUrl }, (tabs) => {
    if (tabs.length > 0) {
      chrome.tabs.update(tabs[0].id, { active: true });
    } else {
      chrome.tabs.create({ url: trackerUrl, pinned: true }, (tab) => {
        trackerTabId = tab.id;
      });
    }
  });
}

/* ========== EXTENSION ICON BADGE ========== */
function updateBadge() {
  const text = trackingActive ? 'ON' : '';
  const color = trackingActive ? '#238636' : '#484f58';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// Periodically update badge
setInterval(updateBadge, 2000);

/* ========== STORE GAZE POINTS PER TAB ========== */
// Listen for content scripts reporting their stored gaze data
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'STORE_GAZE_POINT' && sender.tab) {
    const tabId = sender.tab.id;
    const data = getTabData(tabId);

    const point = { x: msg.x, y: msg.y, timestamp: msg.timestamp };
    data.gazePoints.push(point);

    // Check if this is in the first-viewed window
    if (isFirstViewedWindow(tabId)) {
      data.firstViewedPoints.push(point);
    }

    // Also store in URL-keyed session data
    const url = sender.tab.url;
    if (url) {
      data.url = url;
    }
  }
});

console.log('EyeD service worker initialized');
