/**
 * EyeD Popup Script
 * Controls for the extension popup UI.
 */

const $ = (sel) => document.querySelector(sel);

/* ========== STATUS UPDATE ========== */
async function updateStatus() {
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
      recStatus.textContent = 'Active';
      recStatus.className = 'status-value on';
    } else {
      dot.className = 'rec-dot off';
      label.textContent = 'Start Recording';
      btn.classList.remove('recording-active');
      recStatus.textContent = 'Off';
      recStatus.className = 'status-value off';
    }
  } catch (e) {}

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      const contentState = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CONTENT_STATE' });
      if (contentState) {
        const parts = [];
        if (contentState.gazePointCount > 0) parts.push(`${contentState.gazePointCount} gaze`);
        if (contentState.mousePointCount > 0) parts.push(`${contentState.mousePointCount} mouse`);
        if (contentState.touchPointCount > 0) parts.push(`${contentState.touchPointCount} touch`);
        if (contentState.firstViewedCount > 0) parts.push(`${contentState.firstViewedCount} first-viewed`);
        if (contentState.fixationCount > 0) parts.push(`${contentState.fixationCount} fixations`);

        const total = contentState.gazePointCount + contentState.mousePointCount + contentState.touchPointCount;
        $('#page-stats').textContent = total > 0 ? parts.join(', ') : 'No data';
        $('#page-stats').className = total > 0 ? 'status-value active' : 'status-value off';
      }
    }
  } catch (e) {
    $('#page-stats').textContent = 'N/A (system page)';
    $('#page-stats').className = 'status-value off';
  }
}

/* ========== RECORDING TOGGLE ========== */
$('#btn-toggle-recording').addEventListener('click', async () => {
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

$('#btn-toggle-heatmap').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_HEATMAP' });
  } catch (e) {}
});

$('#btn-toggle-scanpath').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SCANPATH' });
  } catch (e) {}
});

$('#btn-toggle-cursor').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_CURSOR' });
  } catch (e) {}
});

$('#btn-start').addEventListener('click', async () => {
  try {
    const bgState = await chrome.runtime.sendMessage({ type: 'GET_TRACKING_STATE' });
    if (bgState?.trackerTabId) {
      await chrome.tabs.sendMessage(bgState.trackerTabId, { type: 'START_TRACKING' });
      setTimeout(updateStatus, 500);
    }
  } catch (e) {}
});

$('#btn-stop').addEventListener('click', async () => {
  try {
    const bgState = await chrome.runtime.sendMessage({ type: 'GET_TRACKING_STATE' });
    if (bgState?.trackerTabId) {
      await chrome.tabs.sendMessage(bgState.trackerTabId, { type: 'STOP_TRACKING' });
      setTimeout(updateStatus, 500);
    }
  } catch (e) {}
});

$('#btn-screenshot-viewport').addEventListener('click', async () => {
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

$('#btn-screenshot-fullpage').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      // Send message first, then close popup after confirmed delivery
      await chrome.tabs.sendMessage(tab.id, {
        type: 'CAPTURE_FULLPAGE_SCREENSHOT',
        download: true,
        includeHeatmap: true,
        includeScanpath: true,
        includeFirstViewed: true,
      });
      // Close popup after message is delivered (won't appear in subsequent captures)
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
      container.innerHTML = info.savedSessions.map(s =>
        `<div class="saved-session-item">
          <span class="session-name">${s.name}</span>
          <span class="session-meta">${s.totalGaze} pts</span>
        </div>`
      ).join('');
    } else {
      container.innerHTML = '';
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
