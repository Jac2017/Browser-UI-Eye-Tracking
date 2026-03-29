/**
 * EyeD Popup Script
 * Controls for the extension popup UI.
 */

const $ = (sel) => document.querySelector(sel);

// Track overlay toggle states
const overlayStates = { heatmap: false, scanpath: false, cursor: false };

/* ========== STATUS UPDATE ========== */
async function updateStatus() {
  try {
    const bgState = await chrome.runtime.sendMessage({ type: 'GET_TRACKING_STATE' });

    if (bgState?.trackerTabId) {
      $('#tracker-status').textContent = 'Running';
      $('#tracker-status').className = 'stat-val on';
    } else {
      $('#tracker-status').textContent = 'Off';
      $('#tracker-status').className = 'stat-val off';
    }

    if (bgState?.active) {
      $('#tracking-status').textContent = 'Active';
      $('#tracking-status').className = 'stat-val on';
      $('#btn-start').disabled = true;
      $('#btn-stop').disabled = false;
    } else if (bgState?.modelReady) {
      $('#tracking-status').textContent = 'Ready';
      $('#tracking-status').className = 'stat-val active';
      $('#btn-start').disabled = false;
      $('#btn-stop').disabled = true;
    } else {
      $('#tracking-status').textContent = 'Idle';
      $('#tracking-status').className = 'stat-val off';
      $('#btn-start').disabled = true;
      $('#btn-stop').disabled = true;
    }
  } catch (e) {}

  // Update recording state
  try {
    const recState = await chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATE' });
    const dot = $('#rec-dot');
    const label = $('#rec-label');
    const recStatus = $('#recording-status');
    const btn = $('#btn-toggle-recording');

    if (recState?.recording) {
      dot.className = 'rec-dot on';
      label.textContent = 'Stop Recording';
      btn.classList.add('recording-active');
      recStatus.textContent = 'On';
      recStatus.className = 'stat-val on';
    } else {
      dot.className = 'rec-dot off';
      label.textContent = 'Start Recording';
      btn.classList.remove('recording-active');
      recStatus.textContent = 'Off';
      recStatus.className = 'stat-val off';
    }
  } catch (e) {}

  // Update network status
  try {
    const netState = await chrome.runtime.sendMessage({ type: 'GET_NETWORK_STATUS' });
    const netDot = $('#network-dot');
    const queueEl = $('#queue-status');
    if (netState) {
      if (netState.network === 'connected') {
        netDot.className = 'net-dot on';
        netDot.title = 'Server connected';
      } else if (netState.network === 'error' || netState.network === 'auth-error') {
        netDot.className = 'net-dot error';
        netDot.title = netState.network === 'auth-error' ? 'Auth failed' : 'Server error';
      } else {
        netDot.className = 'net-dot off';
        netDot.title = 'Server disconnected';
      }
      const total = netState.queueSize + (netState.screenshotQueue || 0);
      queueEl.textContent = String(total);
      queueEl.className = total > 0 ? 'stat-val active' : 'stat-val';
    }
  } catch (e) {}

  // Page stats
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      const contentState = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CONTENT_STATE' });
      if (contentState) {
        const parts = [];
        if (contentState.gazePointCount > 0) parts.push(`${contentState.gazePointCount} gaze`);
        if (contentState.mousePointCount > 0) parts.push(`${contentState.mousePointCount} mouse`);
        if (contentState.touchPointCount > 0) parts.push(`${contentState.touchPointCount} touch`);
        if (contentState.fixationCount > 0) parts.push(`${contentState.fixationCount} fixations`);

        const total = contentState.gazePointCount + contentState.mousePointCount + contentState.touchPointCount;
        const el = $('#page-stats');
        el.textContent = total > 0 ? parts.join(' | ') : 'No page data';
        el.className = total > 0 ? 'page-stats-text has-data' : 'page-stats-text';
      }
    }
  } catch (e) {
    $('#page-stats').textContent = 'N/A (system page)';
    $('#page-stats').className = 'page-stats-text';
  }
}

/* ========== BUTTON DEBOUNCE ========== */
const busyButtons = new Set();
function debounceClick(selector, handler) {
  $(selector).addEventListener('click', async (e) => {
    if (busyButtons.has(selector)) return;
    busyButtons.add(selector);
    try { await handler(e); } finally {
      setTimeout(() => busyButtons.delete(selector), 400);
    }
  });
}

/* ========== RECORDING TOGGLE ========== */
debounceClick('#btn-toggle-recording', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'TOGGLE_RECORDING' });
    updateStatus();
  } catch (e) {}
});

/* ========== BUTTON HANDLERS ========== */
$('#btn-open-tracker').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'OPEN_TRACKER' });
  window.close();
});

$('#btn-open-insights').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'OPEN_INSIGHTS' });
  window.close();
});

/* ========== OVERLAY TOGGLES WITH ACTIVE STATE ========== */
async function toggleOverlay(name, messageType) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, { type: messageType });
      overlayStates[name] = !overlayStates[name];
      $(`#btn-toggle-${name}`).dataset.active = String(overlayStates[name]);
    }
  } catch (e) {}
}

$('#btn-toggle-heatmap').addEventListener('click', () => toggleOverlay('heatmap', 'TOGGLE_HEATMAP'));
$('#btn-toggle-scanpath').addEventListener('click', () => toggleOverlay('scanpath', 'TOGGLE_SCANPATH'));
$('#btn-toggle-cursor').addEventListener('click', () => toggleOverlay('cursor', 'TOGGLE_CURSOR'));

debounceClick('#btn-start', async () => {
  try {
    const bgState = await chrome.runtime.sendMessage({ type: 'GET_TRACKING_STATE' });
    if (bgState?.trackerTabId) {
      await chrome.tabs.sendMessage(bgState.trackerTabId, { type: 'START_TRACKING' });
      setTimeout(updateStatus, 500);
    }
  } catch (e) {}
});

debounceClick('#btn-stop', async () => {
  try {
    const bgState = await chrome.runtime.sendMessage({ type: 'GET_TRACKING_STATE' });
    if (bgState?.trackerTabId) {
      await chrome.tabs.sendMessage(bgState.trackerTabId, { type: 'STOP_TRACKING' });
      setTimeout(updateStatus, 500);
    }
  } catch (e) {}
});

debounceClick('#btn-screenshot-viewport', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'CAPTURE_VIEWPORT_SCREENSHOT',
        download: true,
        includeHeatmap: true,
        includeScanpath: true,
        includeFirstViewed: true,
      });
    }
  } catch (e) {}
});

debounceClick('#btn-screenshot-fullpage', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'CAPTURE_FULLPAGE_SCREENSHOT',
        download: true,
        includeHeatmap: true,
        includeScanpath: true,
        includeFirstViewed: true,
      });
      window.close();
    }
  } catch (e) {}
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
  if (!confirm('Clear all tracking data for this page?')) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_LOCAL_DATA' });
      await chrome.runtime.sendMessage({ type: 'CLEAR_HEATMAP', tabId: tab.id });
      updateStatus();
    }
  } catch (e) {}
});

/* ========== REPLAY ========== */
$('#btn-replay').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_REPLAY' });
  } catch (e) {}
});

/* ========== SESSION MANAGEMENT ========== */
$('#btn-name-session').addEventListener('click', async () => {
  const name = $('#session-name').value.trim();
  if (name) {
    await chrome.runtime.sendMessage({ type: 'NAME_SESSION', name });
    $('#session-name').value = '';
    loadSessionInfo();
  }
});

$('#btn-save-session').addEventListener('click', async () => {
  const name = $('#session-name').value.trim() || undefined;
  await chrome.runtime.sendMessage({ type: 'SAVE_SESSION', name });
  loadSessionInfo();
});

$('#btn-new-session').addEventListener('click', async () => {
  const name = $('#session-name').value.trim() || undefined;
  await chrome.runtime.sendMessage({ type: 'NEW_SESSION', name });
  $('#session-name').value = '';
  loadSessionInfo();
  updateStatus();
});

async function loadSessionInfo() {
  try {
    const info = await chrome.runtime.sendMessage({ type: 'GET_SESSION_INFO' });
    if (!info) return;

    if (info.name) {
      $('#session-name').placeholder = info.name;
    }

    const container = $('#saved-sessions');
    if (info.savedSessions && info.savedSessions.length > 0) {
      container.textContent = '';
      for (const s of info.savedSessions) {
        const item = document.createElement('div');
        item.className = 'saved-session-item';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'session-name';
        nameSpan.textContent = s.name;
        const metaSpan = document.createElement('span');
        metaSpan.className = 'session-meta';
        metaSpan.textContent = `${s.totalGaze} pts`;
        item.appendChild(nameSpan);
        item.appendChild(metaSpan);
        container.appendChild(item);
      }
    } else {
      container.textContent = '';
    }
  } catch (e) {}
}

/* ========== SETTINGS ========== */
$('#btn-settings').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'OPEN_SETTINGS' });
  window.close();
});

/* ========== INIT ========== */
updateStatus();
loadSessionInfo();
setInterval(updateStatus, 2000);
