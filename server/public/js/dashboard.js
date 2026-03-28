/**
 * EyeD Dashboard — client-side logic.
 */

const API_KEY = localStorage.getItem('eyed_dashboard_key') || '';
const MASTER_KEY = localStorage.getItem('eyed_master_key') || '';

function authHeaders() {
  const key = MASTER_KEY || API_KEY;
  return key ? { 'Authorization': `Bearer ${key}` } : {};
}

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...opts.headers },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res;
}

// Prompt for key if not set
if (!API_KEY && !MASTER_KEY) {
  const key = prompt('Enter your EyeD API key or master key:');
  if (key) {
    if (key.startsWith('eyed_')) {
      localStorage.setItem('eyed_dashboard_key', key);
    } else {
      localStorage.setItem('eyed_master_key', key);
    }
    location.reload();
  }
}

/* ========== TABS ========== */
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
    // Load data for tab
    switch (tab.dataset.tab) {
      case 'overview': loadOverview(); break;
      case 'sessions': loadSessions(); break;
      case 'keys': loadKeys(); break;
      case 'studies': loadStudies(); break;
      case 'webhooks': loadWebhooks(); break;
      case 'analytics': loadSessionList(); break;
    }
  });
});

/* ========== WEBSOCKET ========== */
let ws;
let eventCounter = 0;
let eventRateTimer;
const liveFeed = document.getElementById('live-feed');

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/api/ws/live`);
  const badge = document.getElementById('ws-status');

  ws.onopen = () => {
    badge.textContent = 'Live';
    badge.classList.remove('offline');
  };
  ws.onclose = () => {
    badge.textContent = 'Offline';
    badge.classList.add('offline');
    setTimeout(connectWs, 3000);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      handleLiveEvent(msg);
    } catch {}
  };
}

function handleLiveEvent(msg) {
  if (msg.type === 'connected') {
    document.getElementById('live-clients').textContent = msg.data.clients;
    return;
  }
  eventCounter++;
  const item = document.createElement('div');
  item.className = 'live-item';
  const time = new Date(msg.timestamp).toLocaleTimeString();
  const dotClass = msg.type === 'events' ? 'events' : msg.type === 'session' ? 'session' : 'screenshot';

  let detail = '';
  if (msg.type === 'events' && msg.data) {
    detail = `${msg.data.count} events (${(msg.data.types || []).join(', ')})`;
  } else if (msg.data) {
    detail = JSON.stringify(msg.data).substring(0, 100);
  }

  item.innerHTML = `<span class="time">${esc(time)}</span><span class="live-dot ${dotClass}"></span><span class="type">${esc(msg.type)}</span><span>${esc(detail)}</span>`;

  if (liveFeed.children.length === 1 && liveFeed.children[0].tagName !== 'DIV') {
    // keep
  } else if (liveFeed.children.length === 1 && liveFeed.querySelector('div[style]')) {
    liveFeed.textContent = '';
  }
  liveFeed.prepend(item);
  if (liveFeed.children.length > 200) liveFeed.lastChild.remove();
}

// Rate counter
eventRateTimer = setInterval(() => {
  document.getElementById('live-rate').textContent = eventCounter;
  eventCounter = 0;
}, 60000);

connectWs();

/* ========== OVERVIEW ========== */
async function loadOverview() {
  try {
    const res = await api('/analytics/overview');
    const data = await res.json();

    document.getElementById('overview-cards').innerHTML = `
      <div class="card"><div class="label">Total Sessions</div><div class="value">${data.sessions}</div></div>
      <div class="card"><div class="label">Total Events</div><div class="value">${fmtNum(data.events)}</div></div>
      <div class="card"><div class="label">Screenshots</div><div class="value">${fmtNum(data.screenshots)}</div></div>
      <div class="card"><div class="label">Active Now</div><div class="value green" id="active-sessions">${data.recentSessions.filter(s => !s.end_time).length}</div></div>
    `;

    // Event distribution
    if (data.eventsByType.length > 0) {
      const maxCount = data.eventsByType[0].count;
      document.getElementById('event-dist').innerHTML = data.eventsByType.map(e => `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
          <span style="min-width:120px;font-size:13px" class="type-${e.type}">${esc(e.type)}</span>
          <div style="flex:1;height:20px;background:var(--bg);border-radius:4px;overflow:hidden">
            <div style="height:100%;width:${(e.count/maxCount*100).toFixed(1)}%;background:var(--accent);border-radius:4px"></div>
          </div>
          <span style="min-width:60px;text-align:right;font-size:13px;color:var(--text-muted)">${fmtNum(e.count)}</span>
        </div>
      `).join('');
    }

    // Recent sessions
    renderSessionTable(data.recentSessions, 'recent-sessions');
  } catch (err) {
    document.getElementById('overview-cards').innerHTML = `<div class="status-msg error">${esc(err.message)}</div>`;
  }
}

/* ========== SESSIONS ========== */
async function loadSessions() {
  try {
    const res = await api('/sessions?limit=100');
    const data = await res.json();
    renderSessionTable(data.sessions, 'sessions-table');
  } catch (err) {
    document.getElementById('sessions-table').innerHTML = `<div class="status-msg error">${esc(err.message)}</div>`;
  }
}

function renderSessionTable(sessions, containerId) {
  if (!sessions || sessions.length === 0) {
    document.getElementById(containerId).innerHTML = '<p style="color:var(--text-muted);padding:20px">No sessions yet</p>';
    return;
  }
  document.getElementById(containerId).innerHTML = `
    <table>
      <tr><th>Session</th><th>Name</th><th>Started</th><th>Duration</th><th>Events</th><th>Screenshots</th><th>Status</th><th>Actions</th></tr>
      ${sessions.map(s => `
        <tr>
          <td style="font-family:monospace;font-size:12px">${esc(s.id?.substring(0, 8) || '—')}...</td>
          <td>${esc(s.session_name || '—')}</td>
          <td>${s.start_time ? new Date(s.start_time).toLocaleString() : '—'}</td>
          <td>${s.end_time ? fmtDuration(s.end_time - s.start_time) : '<span class="pill active">active</span>'}</td>
          <td>${fmtNum(s.event_count || s.actual_event_count || 0)}</td>
          <td>${s.screenshot_count || 0}</td>
          <td>${s.end_time ? '<span class="pill ended">ended</span>' : '<span class="pill active">active</span>'}</td>
          <td>
            <button class="btn" onclick="viewSession('${esc(s.id)}')" style="padding:4px 10px;font-size:12px">View</button>
            <button class="btn" onclick="exportSession('${esc(s.id)}')" style="padding:4px 10px;font-size:12px">Export</button>
          </td>
        </tr>
      `).join('')}
    </table>
  `;
}

async function viewSession(id) {
  try {
    const res = await api(`/sessions/${id}/summary`);
    const { summary } = await res.json();
    if (!summary) { alert('No data for this session'); return; }

    const el = document.getElementById('analytics-result');
    renderSummary(summary, el);

    // Switch to analytics tab
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelector('[data-tab="analytics"]').classList.add('active');
    document.getElementById('tab-analytics').classList.add('active');
  } catch (err) {
    alert(err.message);
  }
}

async function exportSession(id) {
  const fmt = document.getElementById('session-format')?.value || 'json';
  window.open(`/api/export/events/${id}?format=${fmt}`, '_blank');
}

async function exportSessions() {
  const fmt = document.getElementById('session-format')?.value || 'json';
  window.open(`/api/export/sessions?format=${fmt}`, '_blank');
}

/* ========== ANALYTICS ========== */
async function loadSessionList() {
  try {
    const res = await api('/sessions?limit=200');
    const data = await res.json();
    const sel = document.getElementById('analytics-session');
    sel.innerHTML = data.sessions.map(s =>
      `<option value="${esc(s.id)}">${esc(s.session_name || s.id.substring(0,8))} (${fmtNum(s.event_count)} events)</option>`
    ).join('');
    if (data.sessions.length > 0) loadAnalytics();
  } catch {}
}

async function loadAnalytics() {
  const sessionId = document.getElementById('analytics-session').value;
  const type = document.getElementById('analytics-type').value;
  const el = document.getElementById('analytics-result');
  if (!sessionId) { el.innerHTML = '<p style="color:var(--text-muted)">Select a session</p>'; return; }

  try {
    if (type === 'summary') {
      const res = await api(`/sessions/${sessionId}/summary`);
      const { summary } = await res.json();
      renderSummary(summary, el);
    } else if (type === 'heatmap') {
      const res = await api(`/analytics/heatmap/${sessionId}`);
      const { heatmap, gazeCount } = await res.json();
      renderHeatmap(heatmap, gazeCount, el);
    } else if (type === 'fixations') {
      const res = await api(`/analytics/fixations/${sessionId}`);
      const data = await res.json();
      el.innerHTML = `
        <div class="card-grid">
          <div class="card"><div class="label">Fixations</div><div class="value">${data.count}</div></div>
          <div class="card"><div class="label">Avg Duration</div><div class="value">${data.avgDuration}ms</div></div>
        </div>
        <div class="card" style="max-height:400px;overflow-y:auto">
          <table><tr><th>#</th><th>X</th><th>Y</th><th>Duration</th><th>Points</th></tr>
          ${data.fixations.slice(0, 100).map((f, i) => `
            <tr><td>${i+1}</td><td>${f.x.toFixed(3)}</td><td>${f.y.toFixed(3)}</td><td>${f.duration}ms</td><td>${f.pointCount}</td></tr>
          `).join('')}
          </table>
        </div>
      `;
    } else if (type === 'engagement') {
      const res = await api(`/analytics/engagement/${sessionId}`);
      const { engagement } = await res.json();
      renderEngagement(engagement, el);
    } else if (type === 'timeline') {
      const res = await api(`/analytics/timeline/${sessionId}`);
      const data = await res.json();
      renderTimeline(data, el);
    }
  } catch (err) {
    el.innerHTML = `<div class="status-msg error">${esc(err.message)}</div>`;
  }
}

function renderSummary(summary, el) {
  if (!summary) { el.innerHTML = '<p style="color:var(--text-muted)">No data</p>'; return; }
  el.innerHTML = `
    <div class="card-grid">
      <div class="card"><div class="label">Total Events</div><div class="value">${fmtNum(summary.totalEvents)}</div></div>
      <div class="card"><div class="label">Duration</div><div class="value">${fmtDuration(summary.duration)}</div></div>
      <div class="card"><div class="label">Gaze Points</div><div class="value">${fmtNum(summary.gazePoints)}</div></div>
      <div class="card"><div class="label">Fixations</div><div class="value">${summary.fixations}</div></div>
      <div class="card"><div class="label">Avg Fixation</div><div class="value">${summary.avgFixationDuration}ms</div></div>
    </div>
    <div class="card-grid">
      <div class="card" style="text-align:center">
        <div class="label">Engagement Score</div>
        ${renderEngagementRing(summary.engagement?.score || 0)}
      </div>
      <div class="card">
        <div class="label">Event Types</div>
        ${Object.entries(summary.typeCounts || {}).map(([t, c]) =>
          `<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:13px"><span class="type-${t}">${esc(t)}</span><span>${fmtNum(c)}</span></div>`
        ).join('')}
      </div>
      <div class="card">
        <div class="label">URLs Visited</div>
        ${Object.keys(summary.urls || {}).map(u =>
          `<div style="font-size:12px;padding:3px 0;word-break:break-all">${esc(u)}</div>`
        ).join('') || '<span style="color:var(--text-muted)">None</span>'}
      </div>
    </div>
  `;
}

function renderEngagementRing(score) {
  const pct = Math.max(0, Math.min(100, score));
  const circumference = 2 * Math.PI * 45;
  const offset = circumference - (pct / 100) * circumference;
  const color = pct >= 60 ? 'var(--green)' : pct >= 30 ? 'var(--orange)' : 'var(--red)';
  return `
    <div class="engagement-ring">
      <svg width="120" height="120" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r="45" fill="none" stroke="var(--border)" stroke-width="8"/>
        <circle cx="60" cy="60" r="45" fill="none" stroke="${color}" stroke-width="8"
          stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" stroke-linecap="round"/>
      </svg>
      <div class="score">${pct}</div>
    </div>
  `;
}

function renderEngagement(engagement, el) {
  el.innerHTML = `
    <div style="text-align:center;margin-bottom:24px">
      ${renderEngagementRing(engagement.score)}
    </div>
    <div class="card-grid">
      ${Object.entries(engagement.factors || {}).map(([name, val]) => `
        <div class="card">
          <div class="label">${esc(name)}</div>
          <div style="height:8px;background:var(--bg);border-radius:4px;margin-top:8px">
            <div style="height:100%;width:${(val*100).toFixed(0)}%;background:var(--accent);border-radius:4px"></div>
          </div>
          <div style="text-align:right;font-size:12px;color:var(--text-muted);margin-top:4px">${(val*100).toFixed(0)}%</div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderHeatmap(heatmap, gazeCount, el) {
  el.innerHTML = `
    <div class="card" style="margin-bottom:16px"><div class="label">Gaze Points</div><div class="value">${fmtNum(gazeCount)}</div></div>
    <div class="heatmap-container"><canvas id="heatmap-canvas" width="960" height="540"></canvas></div>
  `;
  const canvas = document.getElementById('heatmap-canvas');
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, 960, 540);

  if (!heatmap?.cells) return;
  for (const cell of heatmap.cells) {
    const alpha = Math.max(0.05, cell.intensity);
    const hue = (1 - cell.intensity) * 240; // blue to red
    ctx.fillStyle = `hsla(${hue}, 100%, 50%, ${alpha})`;
    const x = (cell.x / 1920) * 960;
    const y = (cell.y / 1080) * 540;
    const w = (cell.width / 1920) * 960;
    const h = (cell.height / 1080) * 540;
    ctx.fillRect(x, y, w, h);
  }
}

function renderTimeline(data, el) {
  if (!data.timeline || data.timeline.length === 0) {
    el.innerHTML = '<p style="color:var(--text-muted)">No timeline data</p>';
    return;
  }
  el.innerHTML = `
    <div class="card" style="margin-bottom:16px"><div class="label">Duration</div><div class="value">${fmtDuration(data.duration)}</div></div>
    <div class="heatmap-container"><canvas id="timeline-canvas" width="960" height="300"></canvas></div>
  `;
  const canvas = document.getElementById('timeline-canvas');
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, 960, 300);

  const maxTime = data.timeline[data.timeline.length - 1].time;
  ctx.strokeStyle = 'var(--accent)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < data.timeline.length; i++) {
    const p = data.timeline[i];
    const px = (p.time / maxTime) * 960;
    const py = p.y * 300;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = '#58a6ff';
  ctx.stroke();
}

/* ========== FUNNEL ========== */
async function runFunnel() {
  const urls = document.getElementById('funnel-urls').value.split('\n').map(u => u.trim()).filter(Boolean);
  if (urls.length < 2) { alert('Enter at least 2 URLs'); return; }
  try {
    const res = await api('/analytics/funnel', { method: 'POST', body: JSON.stringify({ urls }) });
    const { funnel } = await res.json();
    const maxSessions = Math.max(...funnel.map(s => s.sessions), 1);
    document.getElementById('funnel-result').innerHTML = funnel.map((step, i) => `
      <div class="funnel-step">
        <span class="funnel-label">${i+1}. ${esc(step.url)}</span>
        <div class="funnel-bar" style="width:${(step.sessions/maxSessions*100).toFixed(0)}%;background:${step.dropoffRate > 50 ? 'var(--red)' : 'var(--accent)'}">
          ${step.sessions}
        </div>
        <span class="funnel-meta">${step.dropoffRate}% drop</span>
      </div>
    `).join('');
  } catch (err) {
    document.getElementById('funnel-result').innerHTML = `<div class="status-msg error">${esc(err.message)}</div>`;
  }
}

/* ========== COMPARISON ========== */
async function runComparison() {
  const url1 = document.getElementById('compare-url1').value.trim();
  const url2 = document.getElementById('compare-url2').value.trim();
  if (!url1 || !url2) { alert('Enter both URLs'); return; }
  try {
    const res = await api('/analytics/compare', { method: 'POST', body: JSON.stringify({ url1, url2 }) });
    const { comparison } = await res.json();
    document.getElementById('compare-result').innerHTML = `
      <table>
        <tr><th>Metric</th><th>Page A</th><th>Page B</th></tr>
        ${['gazePoints','fixationCount','avgFixationDuration','engagement','clicks','scrolls','duration'].map(m => `
          <tr>
            <td>${esc(m)}</td>
            <td>${m === 'duration' ? fmtDuration(comparison.page1[m]) : fmtNum(comparison.page1[m])}</td>
            <td>${m === 'duration' ? fmtDuration(comparison.page2[m]) : fmtNum(comparison.page2[m])}</td>
          </tr>
        `).join('')}
      </table>
    `;
  } catch (err) {
    document.getElementById('compare-result').innerHTML = `<div class="status-msg error">${esc(err.message)}</div>`;
  }
}

/* ========== STUDIES ========== */
async function loadStudies() {
  try {
    const res = await api('/studies');
    const { studies } = await res.json();
    document.getElementById('studies-table').innerHTML = studies.length === 0
      ? '<p style="color:var(--text-muted);padding:20px">No studies yet</p>'
      : `<table>
        <tr><th>ID</th><th>Name</th><th>Status</th><th>Participants</th><th>URLs</th><th>Actions</th></tr>
        ${studies.map(s => `
          <tr>
            <td>${s.id}</td>
            <td>${esc(s.name)}</td>
            <td><span class="pill ${s.status === 'active' ? 'active' : 'ended'}">${esc(s.status)}</span></td>
            <td>${s.participant_count}</td>
            <td>${(s.target_urls || []).length} URLs</td>
            <td>
              <button class="btn" onclick="viewStudy(${s.id})" style="padding:4px 10px;font-size:12px">View</button>
              <button class="btn" onclick="exportStudy(${s.id})" style="padding:4px 10px;font-size:12px">Export</button>
            </td>
          </tr>
        `).join('')}
      </table>`;
  } catch (err) {
    document.getElementById('studies-table').innerHTML = `<div class="status-msg error">${esc(err.message)}</div>`;
  }
}

function showCreateStudy() {
  showModal(`
    <h2>New Study</h2>
    <div class="form-group"><label>Name</label><input id="study-name"></div>
    <div class="form-group"><label>Description</label><textarea id="study-desc" rows="3"></textarea></div>
    <div class="form-group"><label>Target URLs (one per line)</label><textarea id="study-urls" rows="3"></textarea></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" onclick="createStudy()">Create</button>
    </div>
  `);
}

async function createStudy() {
  const name = document.getElementById('study-name').value.trim();
  const description = document.getElementById('study-desc').value.trim();
  const targetUrls = document.getElementById('study-urls').value.split('\n').filter(Boolean);
  if (!name) { alert('Name required'); return; }
  try {
    await api('/studies', { method: 'POST', body: JSON.stringify({ name, description, targetUrls }) });
    closeModal();
    loadStudies();
  } catch (err) { alert(err.message); }
}

async function viewStudy(id) {
  try {
    const res = await api(`/studies/${id}`);
    const { study, participants } = await res.json();
    showModal(`
      <h2>${esc(study.name)}</h2>
      <p style="color:var(--text-muted);margin-bottom:16px">${esc(study.description)}</p>
      <div class="card-grid" style="margin-bottom:16px">
        <div class="card"><div class="label">Participants</div><div class="value">${study.participant_count}</div></div>
        <div class="card"><div class="label">Status</div><div class="value">${esc(study.status)}</div></div>
      </div>
      <h3 style="margin-bottom:8px">Participants</h3>
      ${participants.length === 0 ? '<p style="color:var(--text-muted)">No participants yet</p>' : `
        <table><tr><th>ID</th><th>Group</th><th>Consent</th></tr>
        ${participants.map(p => `<tr><td>${esc(p.participant_id)}</td><td>${esc(p.group_name)}</td><td>${p.consent_given ? 'Yes' : 'No'}</td></tr>`).join('')}
        </table>
      `}
      <div class="modal-actions"><button class="btn" onclick="closeModal()">Close</button></div>
    `);
  } catch (err) { alert(err.message); }
}

async function exportStudy(id) {
  window.open(`/api/export/study/${id}`, '_blank');
}

/* ========== API KEYS ========== */
async function loadKeys() {
  try {
    const res = await api('/keys');
    const { keys } = await res.json();
    document.getElementById('keys-table').innerHTML = keys.length === 0
      ? '<p style="color:var(--text-muted);padding:20px">No API keys yet</p>'
      : `<table>
        <tr><th>Name</th><th>Key</th><th>Project</th><th>Scopes</th><th>Events</th><th>Status</th><th>Actions</th></tr>
        ${keys.map(k => `
          <tr>
            <td>${esc(k.name)}</td>
            <td style="font-family:monospace;font-size:12px">${esc(k.key)}</td>
            <td>${esc(k.project || '—')}</td>
            <td>${esc(k.scopes)}</td>
            <td>${fmtNum(k.total_events)}</td>
            <td><span class="pill ${k.active ? 'active' : 'ended'}">${k.active ? 'active' : 'disabled'}</span></td>
            <td>
              <button class="btn ${k.active ? 'danger' : ''}" onclick="toggleKey(${k.id}, ${k.active})" style="padding:4px 10px;font-size:12px">
                ${k.active ? 'Disable' : 'Enable'}
              </button>
            </td>
          </tr>
        `).join('')}
      </table>`;
  } catch (err) {
    document.getElementById('keys-table').innerHTML = `<div class="status-msg error">${esc(err.message)}</div>`;
  }
}

function showCreateKey() {
  showModal(`
    <h2>Generate API Key</h2>
    <div class="form-group"><label>Name</label><input id="key-name" placeholder="My Project Key"></div>
    <div class="form-group"><label>Project</label><input id="key-project" placeholder="Optional project name"></div>
    <div class="form-group"><label>Scopes</label>
      <select id="key-scopes" style="background:var(--bg);color:var(--text);border:1px solid var(--border);padding:8px;border-radius:6px;width:100%">
        <option value="write">write (data upload only)</option>
        <option value="write,read">write + read (upload + dashboard)</option>
        <option value="admin">admin (full access)</option>
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" onclick="createKey()">Generate</button>
    </div>
  `);
}

async function createKey() {
  const name = document.getElementById('key-name').value.trim();
  const project = document.getElementById('key-project').value.trim();
  const scopes = document.getElementById('key-scopes').value;
  if (!name) { alert('Name required'); return; }
  try {
    const res = await api('/keys', { method: 'POST', body: JSON.stringify({ name, project, scopes }) });
    const data = await res.json();
    closeModal();
    document.getElementById('key-status').innerHTML = `
      <div class="status-msg success">
        Key created! Copy it now (it won't be shown in full again):<br>
        <code style="display:block;margin-top:8px;padding:8px;background:var(--bg);border-radius:4px;word-break:break-all;user-select:all">${esc(data.key)}</code>
      </div>
    `;
    loadKeys();
  } catch (err) { alert(err.message); }
}

async function toggleKey(id, isActive) {
  try {
    await api(`/keys/${id}/${isActive ? 'deactivate' : 'activate'}`, { method: 'POST' });
    loadKeys();
  } catch (err) { alert(err.message); }
}

/* ========== WEBHOOKS ========== */
async function loadWebhooks() {
  try {
    const res = await api('/webhooks');
    const { webhooks } = await res.json();
    document.getElementById('webhooks-table').innerHTML = webhooks.length === 0
      ? '<p style="color:var(--text-muted);padding:20px">No webhooks configured</p>'
      : `<table>
        <tr><th>URL</th><th>Events</th><th>Status</th><th>Last Triggered</th><th>Failures</th><th>Actions</th></tr>
        ${webhooks.map(w => `
          <tr>
            <td style="word-break:break-all;max-width:300px">${esc(w.url)}</td>
            <td>${(w.events || []).join(', ')}</td>
            <td><span class="pill ${w.active ? 'active' : 'ended'}">${w.active ? 'active' : 'disabled'}</span></td>
            <td>${w.last_triggered_at || '—'}</td>
            <td>${w.failure_count}</td>
            <td>
              <button class="btn" onclick="toggleWebhook(${w.id})" style="padding:4px 10px;font-size:12px">Toggle</button>
              <button class="btn danger" onclick="deleteWebhook(${w.id})" style="padding:4px 10px;font-size:12px">Delete</button>
            </td>
          </tr>
        `).join('')}
      </table>`;
  } catch (err) {
    document.getElementById('webhooks-table').innerHTML = `<div class="status-msg error">${esc(err.message)}</div>`;
  }
}

function showCreateWebhook() {
  showModal(`
    <h2>Add Webhook</h2>
    <div class="form-group"><label>URL</label><input id="webhook-url" placeholder="https://example.com/webhook"></div>
    <div class="form-group"><label>Events</label>
      <label style="display:flex;gap:6px;align-items:center;margin:4px 0"><input type="checkbox" value="session_end" checked> session_end</label>
      <label style="display:flex;gap:6px;align-items:center;margin:4px 0"><input type="checkbox" value="session_start"> session_start</label>
      <label style="display:flex;gap:6px;align-items:center;margin:4px 0"><input type="checkbox" value="batch_upload"> batch_upload</label>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" onclick="createWebhook()">Create</button>
    </div>
  `);
}

async function createWebhook() {
  const url = document.getElementById('webhook-url').value.trim();
  const events = [...document.querySelectorAll('#modal-content input[type=checkbox]:checked')].map(cb => cb.value);
  if (!url) { alert('URL required'); return; }
  try {
    const res = await api('/webhooks', { method: 'POST', body: JSON.stringify({ url, events }) });
    const data = await res.json();
    closeModal();
    alert(`Webhook created! Secret: ${data.secret}\nStore this for signature verification.`);
    loadWebhooks();
  } catch (err) { alert(err.message); }
}

async function toggleWebhook(id) {
  try {
    await api(`/webhooks/${id}/toggle`, { method: 'POST' });
    loadWebhooks();
  } catch (err) { alert(err.message); }
}

async function deleteWebhook(id) {
  if (!confirm('Delete this webhook?')) return;
  try {
    await api(`/webhooks/${id}`, { method: 'DELETE' });
    loadWebhooks();
  } catch (err) { alert(err.message); }
}

/* ========== MODAL ========== */
function showModal(html) {
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal-overlay').classList.add('open');
}
function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}
document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeModal();
});

/* ========== HELPERS ========== */
function esc(str) {
  if (str == null) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

function fmtNum(n) {
  if (n == null) return '0';
  return Number(n).toLocaleString();
}

function fmtDuration(ms) {
  if (!ms || ms <= 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

// Initial load
loadOverview();
