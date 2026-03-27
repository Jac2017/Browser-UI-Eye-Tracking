/**
 * EyeD Popup Script
 * Controls for the extension popup UI.
 */

const $ = (sel) => document.querySelector(sel);

/* ========== STATUS UPDATE ========== */
async function updateStatus() {
  // Get tracking state from background
  try {
    const bgState = await chrome.runtime.sendMessage({ type: 'GET_TRACKING_STATE' });

    if (bgState?.trackerTabId) {
      $('#tracker-status').textContent = 'Running';
      $('#tracker-status').className = 'status-value on';
    } else {
      $('#tracker-status').textContent = 'Not running';
      $('#tracker-status').className = 'status-value off';
    }

    if (bgState?.active) {
      $('#tracking-status').textContent = 'Active';
      $('#tracking-status').className = 'status-value on';
      $('#btn-start').disabled = true;
      $('#btn-stop').disabled = false;
    } else if (bgState?.modelReady) {
      $('#tracking-status').textContent = 'Ready';
      $('#tracking-status').className = 'status-value active';
      $('#btn-start').disabled = false;
      $('#btn-stop').disabled = true;
    } else {
      $('#tracking-status').textContent = 'No model';
      $('#tracking-status').className = 'status-value off';
      $('#btn-start').disabled = true;
      $('#btn-stop').disabled = true;
    }
  } catch (e) {
    // Background not available
  }

  // Get content script state from active tab
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      const contentState = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CONTENT_STATE' });
      if (contentState) {
        const total = contentState.gazePointCount + contentState.mousePointCount + contentState.touchPointCount;
        const parts = [];
        if (contentState.gazePointCount > 0) parts.push(`${contentState.gazePointCount} gaze`);
        if (contentState.mousePointCount > 0) parts.push(`${contentState.mousePointCount} mouse`);
        if (contentState.touchPointCount > 0) parts.push(`${contentState.touchPointCount} touch`);
        if (contentState.firstViewedCount > 0) parts.push(`${contentState.firstViewedCount} first-viewed`);

        $('#page-stats').textContent = total > 0 ? parts.join(', ') : 'No data';
        $('#page-stats').className = total > 0 ? 'status-value active' : 'status-value off';
      }
    }
  } catch (e) {
    // Content script not available on this page
    $('#page-stats').textContent = 'N/A (system page)';
    $('#page-stats').className = 'status-value off';
  }
}

/* ========== BUTTON HANDLERS ========== */
$('#btn-open-tracker').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'OPEN_TRACKER' });
  window.close();
});

$('#btn-toggle-heatmap').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_HEATMAP' });
    }
  } catch (e) {
    // Content script not available
  }
});

$('#btn-toggle-cursor').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_CURSOR' });
    }
  } catch (e) {
    // Content script not available
  }
});

$('#btn-start').addEventListener('click', async () => {
  try {
    const bgState = await chrome.runtime.sendMessage({ type: 'GET_TRACKING_STATE' });
    if (bgState?.trackerTabId) {
      await chrome.tabs.sendMessage(bgState.trackerTabId, { type: 'START_TRACKING' });
      setTimeout(updateStatus, 500);
    }
  } catch (e) {
    // Tracker tab not available
  }
});

$('#btn-stop').addEventListener('click', async () => {
  try {
    const bgState = await chrome.runtime.sendMessage({ type: 'GET_TRACKING_STATE' });
    if (bgState?.trackerTabId) {
      await chrome.tabs.sendMessage(bgState.trackerTabId, { type: 'STOP_TRACKING' });
      setTimeout(updateStatus, 500);
    }
  } catch (e) {
    // Tracker tab not available
  }
});

$('#btn-export').addEventListener('click', async () => {
  const result = await chrome.runtime.sendMessage({ type: 'EXPORT_SESSION' });
  if (result?.data) {
    const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `eyed-session-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
});

$('#btn-clear').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_LOCAL_DATA' });
      await chrome.runtime.sendMessage({ type: 'CLEAR_HEATMAP', tabId: tab.id });
      updateStatus();
    }
  } catch (e) {
    // Content script not available
  }
});

/* ========== INIT ========== */
updateStatus();
// Refresh status periodically while popup is open
setInterval(updateStatus, 2000);
