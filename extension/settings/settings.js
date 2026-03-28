/**
 * EyeD Settings Page
 * Manages configuration for data collection, upload endpoint, and privacy.
 */

const $ = (sel) => document.querySelector(sel);

const DEFAULTS = {
  apiEndpoint: '',
  uploadEnabled: true,
  batchInterval: 30,
  channels: {
    gaze: true,
    mouse: true,
    touch: true,
    scroll: true,
    clicks: true,
    hovers: true,
    deadClicks: true,
    rageClicks: true,
    formFocus: true,
    textSelection: true,
    navigation: true,
    scrollDepth: true,
    visibility: true,
    elementVisibility: true,
    autoScreenshots: true,
    screenshotOnLoad: true,
    screenshotOnScroll: true,
  },
  screenshotInterval: 30,
  screenshotQuality: 70,
  screenshotMaxWidth: 1280,
  stripQueryParams: true,
  stripHash: false,
  liteMode: false,
  scopeMode: 'all',
  domainList: '',
};

async function loadSettings() {
  const result = await chrome.storage.sync.get({ eyedSettings: DEFAULTS });
  const settings = { ...DEFAULTS, ...result.eyedSettings, channels: { ...DEFAULTS.channels, ...result.eyedSettings?.channels } };
  applyToUI(settings);
}

function applyToUI(s) {
  $('#api-endpoint').value = s.apiEndpoint || '';
  $('#upload-enabled').checked = s.uploadEnabled;
  $('#batch-interval').value = s.batchInterval;

  for (const [key, val] of Object.entries(s.channels)) {
    const cb = document.querySelector(`[data-channel="${key}"]`);
    if (cb) cb.checked = val;
  }

  $('#screenshot-interval').value = s.screenshotInterval;
  $('#screenshot-quality').value = s.screenshotQuality;
  $('#screenshot-max-width').value = s.screenshotMaxWidth;
  $('#strip-query-params').checked = s.stripQueryParams;
  $('#strip-hash').checked = s.stripHash;
  $('#lite-mode').checked = s.liteMode;

  const radio = document.querySelector(`input[name="scope-mode"][value="${s.scopeMode}"]`);
  if (radio) radio.checked = true;

  $('#domain-list').value = s.domainList || '';
}

function readFromUI() {
  const channels = {};
  document.querySelectorAll('[data-channel]').forEach(cb => {
    channels[cb.dataset.channel] = cb.checked;
  });

  const scopeRadio = document.querySelector('input[name="scope-mode"]:checked');

  return {
    apiEndpoint: $('#api-endpoint').value.trim(),
    uploadEnabled: $('#upload-enabled').checked,
    batchInterval: Math.max(10, Math.min(300, parseInt($('#batch-interval').value, 10) || 30)),
    channels,
    screenshotInterval: Math.max(10, Math.min(120, parseInt($('#screenshot-interval').value, 10) || 30)),
    screenshotQuality: Math.max(10, Math.min(100, parseInt($('#screenshot-quality').value, 10) || 70)),
    screenshotMaxWidth: Math.max(320, Math.min(3840, parseInt($('#screenshot-max-width').value, 10) || 1280)),
    stripQueryParams: $('#strip-query-params').checked,
    stripHash: $('#strip-hash').checked,
    liteMode: $('#lite-mode').checked,
    scopeMode: scopeRadio ? scopeRadio.value : 'all',
    domainList: $('#domain-list').value.trim(),
  };
}

async function saveSettings() {
  const settings = readFromUI();
  await chrome.storage.sync.set({ eyedSettings: settings });

  // Notify background to reload settings
  chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED', settings }).catch(() => {});

  const status = $('#save-status');
  status.textContent = 'Settings saved';
  status.className = 'status-msg success';
  setTimeout(() => { status.textContent = ''; status.className = 'status-msg'; }, 3000);
}

async function testEndpoint() {
  const url = $('#api-endpoint').value.trim();
  const status = $('#endpoint-status');

  if (!url) {
    status.textContent = 'Enter an endpoint URL first';
    status.className = 'status-msg error';
    return;
  }

  status.textContent = 'Testing...';
  status.className = 'status-msg info';

  try {
    const res = await fetch(url.replace(/\/$/, '') + '/health', {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      status.textContent = 'Connection successful';
      status.className = 'status-msg success';
    } else {
      status.textContent = `Server responded with ${res.status}`;
      status.className = 'status-msg error';
    }
  } catch (err) {
    status.textContent = `Connection failed: ${err.message}`;
    status.className = 'status-msg error';
  }
}

$('#btn-save').addEventListener('click', saveSettings);
$('#btn-test-endpoint').addEventListener('click', testEndpoint);

$('#btn-reset-defaults').addEventListener('click', async () => {
  if (!confirm('Reset all settings to defaults?')) return;
  await chrome.storage.sync.set({ eyedSettings: DEFAULTS });
  applyToUI(DEFAULTS);
  chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED', settings: DEFAULTS }).catch(() => {});
  const status = $('#save-status');
  status.textContent = 'Settings reset to defaults';
  status.className = 'status-msg info';
});

loadSettings();
