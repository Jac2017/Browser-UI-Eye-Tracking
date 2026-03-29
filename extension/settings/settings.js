/**
 * EyeD Settings Page
 * Manages configuration for data collection, upload endpoint, and privacy.
 */

const $ = (sel) => document.querySelector(sel);

const DEFAULTS = {
  apiEndpoint: '',
  apiKey: '',
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
  $('#api-key').value = s.apiKey || '';
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

function validateEndpoint(url) {
  if (!url) return ''; // Empty = disabled
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null; // Must be HTTPS
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return null;
    if (host.startsWith('10.') || host.startsWith('192.168.')) return null;
    // 172.16.0.0 – 172.31.255.255 (private range)
    const m172 = host.match(/^172\.(\d+)\./);
    if (m172 && parseInt(m172[1], 10) >= 16 && parseInt(m172[1], 10) <= 31) return null;
    if (host.endsWith('.local')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function readFromUI() {
  const channels = {};
  document.querySelectorAll('[data-channel]').forEach(cb => {
    channels[cb.dataset.channel] = cb.checked;
  });

  const scopeRadio = document.querySelector('input[name="scope-mode"]:checked');
  const rawEndpoint = $('#api-endpoint').value.trim();
  const validatedEndpoint = validateEndpoint(rawEndpoint);

  if (rawEndpoint && validatedEndpoint === null) {
    throw new Error('API endpoint must use HTTPS and cannot be a local/private address');
  }

  return {
    apiEndpoint: validatedEndpoint || '',
    apiKey: $('#api-key').value.trim(),
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
  const status = $('#save-status');
  let settings;
  try {
    settings = readFromUI();
  } catch (err) {
    status.textContent = err.message;
    status.className = 'status-msg error';
    return;
  }

  await chrome.storage.sync.set({ eyedSettings: settings });

  // Notify background to reload settings
  chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED', settings }).catch(() => {});

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

  const validated = validateEndpoint(url);
  if (validated === null) {
    status.textContent = 'Must be HTTPS. Local/private addresses not allowed.';
    status.className = 'status-msg error';
    return;
  }

  status.textContent = 'Testing...';
  status.className = 'status-msg info';

  try {
    const headers = {};
    const apiKey = $('#api-key').value.trim();
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetch(validated.replace(/\/$/, '') + '/health', {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      status.textContent = 'Connection successful (HTTPS verified)';
      status.className = 'status-msg success';
    } else if (res.status === 401 || res.status === 403) {
      status.textContent = `Auth failed (${res.status}) — check API key`;
      status.className = 'status-msg error';
    } else {
      status.textContent = `Server responded with ${res.status}`;
      status.className = 'status-msg error';
    }
  } catch (err) {
    status.textContent = `Connection failed: ${err.message}`;
    status.className = 'status-msg error';
  }
}

// API key visibility toggle
$('#btn-toggle-key').addEventListener('click', () => {
  const keyField = $('#api-key');
  const btn = $('#btn-toggle-key');
  if (keyField.type === 'password') {
    keyField.type = 'text';
    btn.textContent = 'Hide';
  } else {
    keyField.type = 'password';
    btn.textContent = 'Show';
  }
});

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
