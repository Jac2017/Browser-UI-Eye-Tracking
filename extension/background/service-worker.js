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
const newPageTabs = new Set();
const FIRST_VIEWED_WINDOW_MS = 5000;
const pageLoadTimes = new Map();

/* ========== HELPERS ========== */
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

    case 'SCROLL_EVENT':
      if (sender.tab) {
        const data = getTabData(sender.tab.id);
        data.scrollEvents.push({
          scrollX: msg.scrollX,
          scrollY: msg.scrollY,
          pageHeight: msg.pageHeight,
          viewHeight: msg.viewHeight,
          timestamp: msg.timestamp,
        });
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

    case 'EXPORT_SESSION':
      sendResponse({ data: exportAllData() });
      return true;

    case 'CAPTURE_SCREENSHOT':
      captureScreenshot(sender.tab?.id, sendResponse);
      return true;

    case 'SCREENSHOT_PROGRESS':
      // Could forward to popup/insights for progress display
      break;
  }
});

/* ========== GAZE DATA DISTRIBUTION ========== */
function handleGazeData(msg) {
  if (!trackingActive) return;

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
  const point = {
    x: msg.x, y: msg.y,
    pageX: msg.pageX, pageY: msg.pageY,
    timestamp: msg.timestamp,
  };

  if (msg.type === 'TOUCH_DATA') {
    data.touchPoints.push(point);
  } else {
    data.mousePoints.push(point);
  }
}

function broadcastToContentScripts(message) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id === trackerTabId) continue;
      if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) continue;

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
    gazePoints: data.gazePoints,
    touchPoints: data.touchPoints,
    mousePoints: data.mousePoints,
    firstViewedPoints: data.firstViewedPoints,
    scrollEvents: data.scrollEvents,
  };
}

function clearHeatmapData(tabId) {
  if (tabId) heatmapData.delete(tabId);
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

/* ========== SCREENSHOT CAPTURE ========== */
function captureScreenshot(tabId, sendResponse) {
  // Find the window containing the requesting tab
  if (tabId) {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        sendResponse({ error: 'Tab not found' });
        return;
      }

      chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }, (dataUrl) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
          return;
        }
        sendResponse({ dataUrl });
      });
    });
  } else {
    chrome.tabs.captureVisibleTab(null, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
        return;
      }
      sendResponse({ dataUrl });
    });
  }
}

/* ========== TAB LIFECYCLE ========== */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    pageLoadTimes.set(tabId, Date.now());
    newPageTabs.add(tabId);

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
      newPageTabs.delete(tabId);
      pageLoadTimes.delete(tabId);
    }, FIRST_VIEWED_WINDOW_MS);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const data = heatmapData.get(tabId);
  if (data && data.url && data.gazePoints.length > 0) {
    const existing = sessionData.get(data.url) || {
      gazePoints: [], touchPoints: [], mousePoints: [], firstViewedPoints: [], scrollEvents: []
    };
    existing.gazePoints.push(...data.gazePoints);
    existing.touchPoints.push(...data.touchPoints);
    existing.mousePoints.push(...data.mousePoints);
    existing.firstViewedPoints.push(...data.firstViewedPoints);
    if (data.scrollEvents) existing.scrollEvents.push(...data.scrollEvents);
    sessionData.set(data.url, existing);
  }

  heatmapData.delete(tabId);
  newPageTabs.delete(tabId);
  pageLoadTimes.delete(tabId);
});

/* ========== TRACKER / INSIGHTS TABS ========== */
function openTrackerTab() {
  const trackerUrl = chrome.runtime.getURL('tracker/tracker.html');
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

function openInsightsTab() {
  const insightsUrl = chrome.runtime.getURL('insights/insights.html');
  chrome.tabs.query({ url: insightsUrl }, (tabs) => {
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
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

setInterval(updateBadge, 2000);

/* ========== STORE GAZE POINTS PER TAB ========== */
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'STORE_GAZE_POINT' && sender.tab) {
    const tabId = sender.tab.id;
    const data = getTabData(tabId);

    const point = {
      x: msg.x, y: msg.y,
      pageX: msg.pageX, pageY: msg.pageY,
      scrollX: msg.scrollX, scrollY: msg.scrollY,
      timestamp: msg.timestamp,
      videoTime: msg.videoTime,
      onVideo: msg.onVideo,
    };

    data.gazePoints.push(point);

    if (isFirstViewedWindow(tabId)) {
      data.firstViewedPoints.push(point);
    }

    const url = sender.tab.url;
    if (url) data.url = url;
  }
});

console.log('EyeD service worker v1.1 initialized');
