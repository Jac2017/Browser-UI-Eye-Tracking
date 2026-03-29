/**
 * EyeD Dashboard — client-side logic.
 */

const API_KEY = sessionStorage.getItem('eyed_dashboard_key') || '';
const MASTER_KEY = sessionStorage.getItem('eyed_master_key') || '';

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
      sessionStorage.setItem('eyed_dashboard_key', key);
    } else {
      sessionStorage.setItem('eyed_master_key', key);
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
      case 'analytics': loadSessionList(); loadOverlaySessionList(); loadReplaySessionList(); break;
      case 'tasks': loadTaskStudies(); break;
      case 'forms': loadFormSessionList(); break;
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
  const wsKey = encodeURIComponent(MASTER_KEY || API_KEY);
  ws = new WebSocket(`${proto}//${location.host}/api/ws/live?key=${wsKey}`);
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
      <div class="card"><div class="label">Total Sessions</div><div class="value">${esc(String(data.sessions))}</div></div>
      <div class="card"><div class="label">Total Events</div><div class="value">${fmtNum(data.events)}</div></div>
      <div class="card"><div class="label">Screenshots</div><div class="value">${fmtNum(data.screenshots)}</div></div>
      <div class="card"><div class="label">Active Now</div><div class="value green" id="active-sessions">${esc(String(data.recentSessions.filter(s => !s.end_time).length))}</div></div>
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
          <div class="card"><div class="label">Fixations</div><div class="value">${fmtNum(data.count)}</div></div>
          <div class="card"><div class="label">Avg Duration</div><div class="value">${fmtNum(data.avgDuration)}ms</div></div>
        </div>
        <div class="card" style="max-height:400px;overflow-y:auto">
          <table><tr><th>#</th><th>X</th><th>Y</th><th>Duration</th><th>Points</th></tr>
          ${data.fixations.slice(0, 100).map((f, i) => `
            <tr><td>${i+1}</td><td>${esc(f.x.toFixed(3))}</td><td>${esc(f.y.toFixed(3))}</td><td>${fmtNum(f.duration)}ms</td><td>${fmtNum(f.pointCount)}</td></tr>
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
      <div class="card"><div class="label">Fixations</div><div class="value">${esc(String(summary.fixations))}</div></div>
      <div class="card"><div class="label">Avg Fixation</div><div class="value">${esc(String(summary.avgFixationDuration))}ms</div></div>
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

function drawHeatmapCells(ctx, heatmap, canvasW, canvasH) {
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, canvasW, canvasH);
  if (!heatmap?.cells) return;
  for (const cell of heatmap.cells) {
    const alpha = Math.max(0.05, cell.intensity);
    const hue = (1 - cell.intensity) * 240; // blue to red
    ctx.fillStyle = `hsla(${hue}, 100%, 50%, ${alpha})`;
    // Cells are in normalized 0-1 space — map directly to canvas
    ctx.fillRect(
      cell.x * canvasW,
      cell.y * canvasH,
      cell.width * canvasW + 1,
      cell.height * canvasH + 1
    );
  }
}

function renderHeatmap(heatmap, gazeCount, el) {
  el.innerHTML = `
    <div class="card" style="margin-bottom:16px"><div class="label">Gaze Points</div><div class="value">${fmtNum(gazeCount)}</div></div>
    <div class="heatmap-container"><canvas id="heatmap-canvas" width="960" height="540"></canvas></div>
  `;
  const canvas = document.getElementById('heatmap-canvas');
  drawHeatmapCells(canvas.getContext('2d'), heatmap, 960, 540);
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
          ${fmtNum(step.sessions)}
        </div>
        <span class="funnel-meta">${esc(String(step.dropoffRate))}% drop</span>
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
            <td>${esc(String(s.id))}</td>
            <td>${esc(s.name)}</td>
            <td><span class="pill ${s.status === 'active' ? 'active' : 'ended'}">${esc(s.status)}</span></td>
            <td>${esc(String(s.participant_count))}</td>
            <td>${(s.target_urls || []).length} URLs</td>
            <td>
              <button class="btn" onclick="viewStudy(${Number(s.id)})" style="padding:4px 10px;font-size:12px">View</button>
              <button class="btn" onclick="exportStudy(${Number(s.id)})" style="padding:4px 10px;font-size:12px">Export</button>
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
        <div class="card"><div class="label">Participants</div><div class="value">${fmtNum(study.participant_count)}</div></div>
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
              <button class="btn ${k.active ? 'danger' : ''}" onclick="toggleKey(${Number(k.id)}, ${k.active ? 1 : 0})" style="padding:4px 10px;font-size:12px">
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
            <td>${esc((w.events || []).join(', '))}</td>
            <td><span class="pill ${w.active ? 'active' : 'ended'}">${w.active ? 'active' : 'disabled'}</span></td>
            <td>${esc(w.last_triggered_at || '—')}</td>
            <td>${fmtNum(w.failure_count)}</td>
            <td>
              <button class="btn" onclick="toggleWebhook(${Number(w.id)})" style="padding:4px 10px;font-size:12px">Toggle</button>
              <button class="btn danger" onclick="deleteWebhook(${Number(w.id)})" style="padding:4px 10px;font-size:12px">Delete</button>
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

/* ========== URL HEATMAP AGGREGATION ========== */

async function runUrlHeatmap() {
  const url = document.getElementById('url-heatmap-url').value.trim();
  if (!url) { alert('Enter a URL'); return; }
  const device = document.getElementById('url-heatmap-device').value;
  const el = document.getElementById('url-heatmap-result');
  el.innerHTML = '<div class="status-msg info">Loading...</div>';
  try {
    const res = await api('/analytics/heatmap/url', {
      method: 'POST',
      body: JSON.stringify({ url, deviceCategory: device }),
    });
    const data = await res.json();
    let html = `
      <div class="card-grid" style="margin-bottom:16px">
        <div class="card"><div class="label">Total Gaze Points</div><div class="value">${fmtNum(data.totalPoints)}</div></div>
        <div class="card"><div class="label">Device Filter</div><div class="value">${esc(data.deviceFilter)}</div></div>
      </div>
      <div class="card-grid" style="margin-bottom:16px">
        ${Object.entries(data.deviceBreakdown || {}).map(([dev, cnt]) =>
          `<div class="card"><div class="label">${esc(dev)}</div><div class="value">${fmtNum(cnt)}</div></div>`
        ).join('')}
      </div>
      <div class="heatmap-container"><canvas id="url-heatmap-canvas" width="960" height="540"></canvas></div>
    `;
    el.innerHTML = html;
    const canvas = document.getElementById('url-heatmap-canvas');
    drawHeatmapCells(canvas.getContext('2d'), data.heatmap, 960, 540);
  } catch (err) {
    el.innerHTML = `<div class="status-msg error">${esc(err.message)}</div>`;
  }
}

/* ========== COHORT HEATMAP COMPARISON ========== */

async function loadCohortStudies() {
  try {
    const res = await api('/studies');
    const { studies } = await res.json();
    const sel = document.getElementById('cohort-study');
    sel.innerHTML = '<option value="">Select study...</option>' +
      studies.map(s => `<option value="${Number(s.id)}">${esc(s.name)}</option>`).join('');
  } catch { /* ignore */ }
}

async function runCohortHeatmap() {
  const url = document.getElementById('cohort-url').value.trim();
  const studyId = parseInt(document.getElementById('cohort-study').value);
  const cohortField = document.getElementById('cohort-field').value;
  const device = document.getElementById('cohort-device').value;

  if (!url) { alert('Enter a URL'); return; }
  if (!studyId) { alert('Select a study'); return; }

  const el = document.getElementById('cohort-result');
  el.innerHTML = '<div class="status-msg info">Analyzing cohorts...</div>';

  try {
    const res = await api('/analytics/heatmap/cohort', {
      method: 'POST',
      body: JSON.stringify({ url, studyId, cohortField, deviceCategory: device }),
    });
    const data = await res.json();
    const cohortNames = Object.keys(data.cohorts);

    if (cohortNames.length === 0) {
      el.innerHTML = '<div class="status-msg error">No cohorts found for this study</div>';
      return;
    }

    // Combined overview
    let html = `
      <div class="card" style="margin-bottom:16px;padding:16px">
        <div class="label">Cohort Field: ${esc(data.cohortField)} | Device: ${esc(data.deviceFilter)} | URL: ${esc(data.url)}</div>
        <div style="margin-top:8px;font-size:13px;color:var(--text-muted)">
          Combined: ${fmtNum(data.combined.totalPoints)} gaze points |
          Cohorts: ${cohortNames.map(n => esc(n)).join(', ')}
        </div>
      </div>

      <h4 style="margin-bottom:12px">Combined Heatmap (all cohorts)</h4>
      <div class="heatmap-container" style="margin-bottom:24px">
        <canvas id="cohort-combined-canvas" width="960" height="540"></canvas>
      </div>

      <h4 style="margin-bottom:12px">Per-Cohort Heatmaps</h4>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(440px,1fr));gap:16px">
    `;

    for (const name of cohortNames) {
      const cohort = data.cohorts[name];
      const canvasId = 'cohort-canvas-' + name.replace(/[^a-zA-Z0-9]/g, '_');
      html += `
        <div class="card" style="padding:16px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <strong>${esc(name)}</strong>
            <span style="font-size:12px;color:var(--text-muted)">${fmtNum(cohort.totalPoints)} pts | ${fmtNum(cohort.sessions)} sessions</span>
          </div>
          <div style="margin-bottom:8px;font-size:11px;color:var(--text-muted)">
            ${Object.entries(cohort.deviceBreakdown || {}).map(([d, c]) => esc(d) + ': ' + fmtNum(c)).join(' | ')}
          </div>
          <div class="heatmap-container"><canvas id="${esc(canvasId)}" width="480" height="270"></canvas></div>
        </div>
      `;
    }
    html += '</div>';

    // Cohort comparison stats table
    html += `
      <h4 style="margin:24px 0 12px">Cohort Summary</h4>
      <table style="width:100%;font-size:13px;border-collapse:collapse">
        <tr><th style="text-align:left;padding:8px;border-bottom:1px solid var(--border)">Cohort</th>
        <th style="padding:8px;border-bottom:1px solid var(--border)">Sessions</th>
        <th style="padding:8px;border-bottom:1px solid var(--border)">Gaze Points</th>
        <th style="padding:8px;border-bottom:1px solid var(--border)">Max Density</th>
        <th style="padding:8px;border-bottom:1px solid var(--border)">Cells Active</th></tr>
        ${cohortNames.map(name => {
          const c = data.cohorts[name];
          return `<tr>
            <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-weight:600">${esc(name)}</td>
            <td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:center">${fmtNum(c.sessions)}</td>
            <td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:center">${fmtNum(c.totalPoints)}</td>
            <td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:center">${fmtNum(c.heatmap.maxCount)}</td>
            <td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:center">${fmtNum(c.heatmap.cells.length)}</td>
          </tr>`;
        }).join('')}
      </table>
    `;

    el.innerHTML = html;

    // Render canvases
    const combinedCanvas = document.getElementById('cohort-combined-canvas');
    drawHeatmapCells(combinedCanvas.getContext('2d'), data.combined.heatmap, 960, 540);

    for (const name of cohortNames) {
      const canvasId = 'cohort-canvas-' + name.replace(/[^a-zA-Z0-9]/g, '_');
      const canvas = document.getElementById(canvasId);
      if (canvas) drawHeatmapCells(canvas.getContext('2d'), data.cohorts[name].heatmap, 480, 270);
    }
  } catch (err) {
    el.innerHTML = `<div class="status-msg error">${esc(err.message)}</div>`;
  }
}

/* ========== VIEWPORT DISTRIBUTION ========== */

async function runViewportDist() {
  const url = document.getElementById('viewport-url').value.trim();
  if (!url) { alert('Enter a URL'); return; }
  const el = document.getElementById('viewport-result');
  el.innerHTML = '<div class="status-msg info">Analyzing...</div>';
  try {
    const res = await api('/analytics/viewports', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
    const data = await res.json();

    const maxDevice = Math.max(...Object.values(data.devices), 1);
    el.innerHTML = `
      <div class="card-grid" style="margin-bottom:16px">
        <div class="card"><div class="label">Total Sessions</div><div class="value">${fmtNum(data.totalSessions)}</div></div>
        ${Object.entries(data.devices).map(([name, count]) =>
          `<div class="card">
            <div class="label">${esc(name)}</div>
            <div class="value">${fmtNum(count)}</div>
            <div style="height:6px;background:var(--bg);border-radius:3px;margin-top:6px;overflow:hidden">
              <div style="height:100%;width:${(count/maxDevice*100).toFixed(0)}%;background:var(--accent);border-radius:3px"></div>
            </div>
          </div>`
        ).join('')}
      </div>
      <h4 style="margin-bottom:8px">Top Viewport Sizes</h4>
      <table style="width:100%;font-size:13px;border-collapse:collapse">
        <tr><th style="text-align:left;padding:6px;border-bottom:1px solid var(--border)">Viewport</th>
        <th style="padding:6px;border-bottom:1px solid var(--border)">Sessions</th></tr>
        ${data.viewports.map(v =>
          `<tr><td style="padding:4px 6px;border-bottom:1px solid var(--border);font-family:monospace">${esc(v.size)}</td>
           <td style="padding:4px 6px;border-bottom:1px solid var(--border);text-align:center">${fmtNum(v.count)}</td></tr>`
        ).join('')}
      </table>
    `;
  } catch (err) {
    el.innerHTML = `<div class="status-msg error">${esc(err.message)}</div>`;
  }
}

/* ========== SESSION FILTERING ========== */

async function loadFilteredSessions() {
  const params = new URLSearchParams();
  const status = document.getElementById('filter-status').value;
  const participant = document.getElementById('filter-participant').value.trim();
  const tag = document.getElementById('filter-tag').value.trim();
  const search = document.getElementById('filter-search').value.trim();
  const studyId = document.getElementById('filter-study').value.trim();
  const minDur = document.getElementById('filter-min-dur').value.trim();
  const maxDur = document.getElementById('filter-max-dur').value.trim();

  if (status) params.set('status', status);
  if (participant) params.set('participantId', participant);
  if (tag) params.set('tag', tag);
  if (search) params.set('search', search);
  if (studyId) params.set('studyId', studyId);
  if (minDur) params.set('minDuration', minDur);
  if (maxDur) params.set('maxDuration', maxDur);
  params.set('limit', '100');

  try {
    const res = await api(`/sessions?${params.toString()}`);
    const data = await res.json();
    renderSessionTableWithTags(data.sessions, 'sessions-table');
  } catch (err) {
    document.getElementById('sessions-table').innerHTML = `<div class="status-msg error">${esc(err.message)}</div>`;
  }
}

function renderSessionTableWithTags(sessions, containerId) {
  if (!sessions || sessions.length === 0) {
    document.getElementById(containerId).innerHTML = '<p style="color:var(--text-muted);padding:20px">No sessions match filters</p>';
    return;
  }
  document.getElementById(containerId).innerHTML = `
    <table>
      <tr><th>Session</th><th>Name</th><th>Started</th><th>Duration</th><th>Events</th><th>Tags</th><th>Status</th><th>Actions</th></tr>
      ${sessions.map(s => `
        <tr>
          <td style="font-family:monospace;font-size:12px">${esc(s.id?.substring(0, 8) || '—')}...</td>
          <td>${esc(s.session_name || '—')}</td>
          <td>${s.start_time ? new Date(s.start_time).toLocaleString() : '—'}</td>
          <td>${s.end_time ? fmtDuration(s.end_time - s.start_time) : '<span class="pill active">active</span>'}</td>
          <td>${fmtNum(s.event_count || s.actual_event_count || 0)}</td>
          <td>${(s.tags || []).map(t => `<span class="pill" style="font-size:10px;padding:2px 6px">${esc(t)}</span>`).join(' ') || '—'}</td>
          <td>${s.end_time ? '<span class="pill ended">ended</span>' : '<span class="pill active">active</span>'}</td>
          <td>
            <button class="btn" onclick="viewSession('${esc(s.id)}')" style="padding:4px 10px;font-size:12px">View</button>
            <button class="btn" onclick="showSessionDetail('${esc(s.id)}')" style="padding:4px 10px;font-size:12px">Detail</button>
          </td>
        </tr>
      `).join('')}
    </table>
  `;
}

async function showSessionDetail(id) {
  try {
    const [sessionRes, tagsRes, annotationsRes] = await Promise.all([
      api(`/sessions/${id}`),
      api(`/sessions/${id}/tags`),
      api(`/sessions/${id}/annotations`),
    ]);
    const { session } = await sessionRes.json();
    const { tags } = await tagsRes.json();
    const { annotations } = await annotationsRes.json();

    showModal(`
      <h2>Session Detail</h2>
      <div style="font-family:monospace;font-size:12px;color:var(--text-muted);margin-bottom:12px">${esc(session.id)}</div>
      <div class="card-grid" style="margin-bottom:16px">
        <div class="card"><div class="label">Name</div><div class="value" style="font-size:16px">${esc(session.session_name || '—')}</div></div>
        <div class="card"><div class="label">Duration</div><div class="value" style="font-size:16px">${session.end_time ? fmtDuration(session.end_time - session.start_time) : 'Active'}</div></div>
        <div class="card"><div class="label">Events</div><div class="value" style="font-size:16px">${fmtNum(session.event_count)}</div></div>
      </div>

      <h3 style="margin-bottom:8px">Tags</h3>
      <div id="session-tags-list" style="margin-bottom:12px">
        ${tags.map(t => `<span class="pill" style="margin:2px">${esc(t)} <span style="cursor:pointer;margin-left:4px" onclick="removeTag('${esc(id)}','${esc(t)}')">&times;</span></span>`).join('') || '<span style="color:var(--text-muted)">No tags</span>'}
      </div>
      <div style="display:flex;gap:8px;margin-bottom:16px">
        <input id="new-tag-input" placeholder="Add tag..." style="flex:1;background:var(--bg);color:var(--text);border:1px solid var(--border);padding:6px 10px;border-radius:6px">
        <button class="btn" onclick="addTag('${esc(id)}')">Add</button>
      </div>

      <h3 style="margin-bottom:8px">Annotations</h3>
      <div id="session-annotations-list" style="max-height:200px;overflow-y:auto;margin-bottom:12px">
        ${annotations.length === 0 ? '<span style="color:var(--text-muted)">No annotations</span>' :
          annotations.map(a => `
            <div class="card" style="padding:8px;margin-bottom:6px">
              <div style="display:flex;justify-content:space-between;align-items:center">
                <span style="font-size:12px;color:var(--text-muted)">${esc(a.author || 'Anonymous')} ${a.timestamp ? '@ ' + fmtDuration(a.timestamp) : ''}</span>
                <button class="btn danger" onclick="deleteAnnotation(${Number(a.id)},'${esc(id)}')" style="padding:2px 6px;font-size:10px">Delete</button>
              </div>
              <div style="margin-top:4px;font-size:13px">${esc(a.text)}</div>
            </div>
          `).join('')}
      </div>
      <div style="display:flex;gap:8px;margin-bottom:16px">
        <input id="new-annotation-text" placeholder="Add annotation..." style="flex:1;background:var(--bg);color:var(--text);border:1px solid var(--border);padding:6px 10px;border-radius:6px">
        <input id="new-annotation-author" placeholder="Author" style="width:120px;background:var(--bg);color:var(--text);border:1px solid var(--border);padding:6px 10px;border-radius:6px">
        <button class="btn" onclick="addAnnotation('${esc(id)}')">Add</button>
      </div>

      <div class="modal-actions"><button class="btn" onclick="closeModal()">Close</button></div>
    `);
  } catch (err) { alert(err.message); }
}

async function addTag(sessionId) {
  const tag = document.getElementById('new-tag-input').value.trim();
  if (!tag) return;
  try {
    await api(`/sessions/${sessionId}/tags`, { method: 'POST', body: JSON.stringify({ tag }) });
    showSessionDetail(sessionId);
  } catch (err) { alert(err.message); }
}

async function removeTag(sessionId, tag) {
  try {
    await api(`/sessions/${sessionId}/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' });
    showSessionDetail(sessionId);
  } catch (err) { alert(err.message); }
}

async function addAnnotation(sessionId) {
  const text = document.getElementById('new-annotation-text').value.trim();
  const author = document.getElementById('new-annotation-author').value.trim();
  if (!text) return;
  try {
    await api(`/sessions/${sessionId}/annotations`, { method: 'POST', body: JSON.stringify({ text, author }) });
    showSessionDetail(sessionId);
  } catch (err) { alert(err.message); }
}

async function deleteAnnotation(annotationId, sessionId) {
  try {
    await api(`/sessions/annotations/${annotationId}`, { method: 'DELETE' });
    showSessionDetail(sessionId);
  } catch (err) { alert(err.message); }
}

/* ========== SCREENSHOT-HEATMAP OVERLAY ========== */

async function loadOverlaySessionList() {
  try {
    const res = await api('/sessions?limit=200');
    const data = await res.json();
    const sel = document.getElementById('overlay-session');
    sel.innerHTML = '<option value="">Select session...</option>' +
      data.sessions.filter(s => s.screenshot_count > 0).map(s =>
        `<option value="${esc(s.id)}">${esc(s.session_name || s.id.substring(0,8))} (${s.screenshot_count} screenshots)</option>`
      ).join('');
  } catch {}
}

async function loadOverlayScreenshots() {
  const sessionId = document.getElementById('overlay-session').value;
  const sel = document.getElementById('overlay-screenshot');
  sel.innerHTML = '<option value="">Loading...</option>';
  if (!sessionId) { sel.innerHTML = '<option value="">Select session first</option>'; return; }
  try {
    const res = await api(`/sessions/${sessionId}/screenshots`);
    const { screenshots } = await res.json();
    sel.innerHTML = screenshots.length === 0
      ? '<option value="">No screenshots</option>'
      : screenshots.map(s =>
          `<option value="${Number(s.id)}" data-width="${s.width || 960}" data-height="${s.height || 540}">${esc(s.url || 'Unknown')} (${new Date(s.timestamp).toLocaleTimeString()}) ${s.width}x${s.height}</option>`
        ).join('');
  } catch { sel.innerHTML = '<option value="">Error loading</option>'; }
}

async function renderOverlay() {
  const sessionId = document.getElementById('overlay-session').value;
  const screenshotSel = document.getElementById('overlay-screenshot');
  const screenshotId = screenshotSel.value;
  const el = document.getElementById('overlay-result');

  if (!sessionId || !screenshotId) { alert('Select session and screenshot'); return; }

  const opt = screenshotSel.selectedOptions[0];
  const imgW = parseInt(opt.dataset.width) || 960;
  const imgH = parseInt(opt.dataset.height) || 540;
  const canvasW = Math.min(imgW, 960);
  const canvasH = Math.round(canvasW * (imgH / imgW));

  el.innerHTML = '<div class="status-msg info">Loading overlay...</div>';

  try {
    const [heatmapRes] = await Promise.all([
      api(`/analytics/heatmap/${sessionId}`),
    ]);
    const { heatmap } = await heatmapRes.json();

    el.innerHTML = `
      <div style="position:relative;display:inline-block">
        <img id="overlay-img" width="${canvasW}" height="${canvasH}" style="display:block;border-radius:8px" />
        <canvas id="overlay-canvas" width="${canvasW}" height="${canvasH}" style="position:absolute;top:0;left:0;opacity:0.6;border-radius:8px"></canvas>
      </div>
      <div style="margin-top:8px;font-size:12px;color:var(--text-muted)">
        Heatmap cells: ${fmtNum(heatmap.cells.length)} | Grid: ${heatmap.gridCols}x${heatmap.gridRows}
      </div>
    `;

    // Load screenshot image via authenticated fetch
    const imgRes = await fetch(`/api/screenshots/${screenshotId}`, { headers: authHeaders() });
    if (!imgRes.ok) throw new Error('Failed to load screenshot');
    const blob = await imgRes.blob();
    const imgUrl = URL.createObjectURL(blob);
    const img = document.getElementById('overlay-img');
    img.onload = () => {
      const canvas = document.getElementById('overlay-canvas');
      drawHeatmapCells(canvas.getContext('2d'), heatmap, canvasW, canvasH);
    };
    img.src = imgUrl;
  } catch (err) {
    el.innerHTML = `<div class="status-msg error">${esc(err.message)}</div>`;
  }
}

/* ========== TIME TO FIRST FIXATION ========== */

async function runTTFF() {
  const sessionsInput = document.getElementById('ttff-sessions').value.trim();
  const aoisInput = document.getElementById('ttff-aois').value.trim();
  const el = document.getElementById('ttff-result');

  if (!sessionsInput || !aoisInput) { alert('Enter session IDs and AOIs'); return; }

  let aois;
  try { aois = JSON.parse(aoisInput); } catch { alert('Invalid AOI JSON'); return; }
  if (!Array.isArray(aois)) { alert('AOIs must be a JSON array'); return; }

  const sessionIds = sessionsInput.split(',').map(s => s.trim()).filter(Boolean);
  el.innerHTML = '<div class="status-msg info">Analyzing...</div>';

  try {
    const body = sessionIds.length === 1
      ? { sessionId: sessionIds[0], aois }
      : { sessionIds, aois };
    const res = await api('/analytics/ttff', { method: 'POST', body: JSON.stringify(body) });
    const data = await res.json();

    const isAggregate = sessionIds.length > 1;
    el.innerHTML = `
      <div class="card" style="margin-bottom:8px;padding:8px"><span style="font-size:13px;color:var(--text-muted)">
        ${isAggregate ? `Aggregate across ${fmtNum(data.sessions)} sessions` : `Session: ${esc(data.sessionId)}`}
      </span></div>
      <table style="width:100%;font-size:13px">
        <tr><th style="text-align:left;padding:6px">AOI</th>
        ${isAggregate ? '<th>Hit Rate</th><th>Mean TTFF</th><th>Median</th><th>Min</th><th>Max</th>' : '<th>TTFF</th><th>Status</th>'}
        </tr>
        ${data.results.map(r => `
          <tr>
            <td style="padding:6px;font-weight:600">${esc(r.aoi)}</td>
            ${isAggregate ? `
              <td style="text-align:center;padding:6px">${r.hitRate}%</td>
              <td style="text-align:center;padding:6px">${r.mean != null ? fmtDuration(r.mean) : '—'}</td>
              <td style="text-align:center;padding:6px">${r.median != null ? fmtDuration(r.median) : '—'}</td>
              <td style="text-align:center;padding:6px">${r.min != null ? fmtDuration(r.min) : '—'}</td>
              <td style="text-align:center;padding:6px">${r.max != null ? fmtDuration(r.max) : '—'}</td>
            ` : `
              <td style="text-align:center;padding:6px">${r.ttff != null ? fmtDuration(r.ttff) : '—'}</td>
              <td style="text-align:center;padding:6px">${r.ttff != null ? '<span class="pill active">Hit</span>' : '<span class="pill ended">Miss</span>'}</td>
            `}
          </tr>
        `).join('')}
      </table>
    `;
  } catch (err) {
    el.innerHTML = `<div class="status-msg error">${esc(err.message)}</div>`;
  }
}

/* ========== TASK MANAGEMENT ========== */

async function loadTaskStudies() {
  try {
    const res = await api('/studies');
    const { studies } = await res.json();
    const sel = document.getElementById('task-study');
    sel.innerHTML = '<option value="">Select study...</option>' +
      studies.map(s => `<option value="${Number(s.id)}">${esc(s.name)}</option>`).join('');
  } catch {}
}

async function loadTasks() {
  const studyId = document.getElementById('task-study').value;
  if (!studyId) {
    document.getElementById('tasks-table').innerHTML = '<p style="color:var(--text-muted);padding:20px">Select a study</p>';
    document.getElementById('task-summary').innerHTML = '';
    return;
  }
  try {
    const [tasksRes, summaryRes] = await Promise.all([
      api(`/tasks/study/${studyId}`),
      api(`/tasks/study/${studyId}/summary`),
    ]);
    const { tasks } = await tasksRes.json();
    const { summary } = await summaryRes.json();

    document.getElementById('tasks-table').innerHTML = tasks.length === 0
      ? '<p style="color:var(--text-muted);padding:20px">No tasks defined for this study</p>'
      : `<table>
        <tr><th>ID</th><th>Name</th><th>Description</th><th>Target URL</th><th>Order</th><th>Actions</th></tr>
        ${tasks.map(t => `
          <tr>
            <td>${esc(String(t.id))}</td>
            <td>${esc(t.name)}</td>
            <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis">${esc(t.description || '—')}</td>
            <td style="font-size:12px;word-break:break-all">${esc(t.target_url || '—')}</td>
            <td>${esc(String(t.sort_order))}</td>
            <td>
              <button class="btn" onclick="viewTaskInstances(${Number(t.id)})" style="padding:4px 10px;font-size:12px">Instances</button>
              <button class="btn danger" onclick="deleteTask(${Number(t.id)})" style="padding:4px 10px;font-size:12px">Delete</button>
            </td>
          </tr>
        `).join('')}
      </table>`;

    // Render summary
    if (summary.length > 0) {
      document.getElementById('task-summary').innerHTML = `
        <h3 style="margin-bottom:12px">Task Completion Summary</h3>
        <table style="width:100%;font-size:13px">
          <tr><th style="text-align:left;padding:6px">Task</th><th>Attempts</th><th>Completed</th><th>Success Rate</th><th>Avg Duration</th><th>Median</th></tr>
          ${summary.map(s => `
            <tr>
              <td style="padding:6px;font-weight:600">${esc(s.taskName)}</td>
              <td style="text-align:center;padding:6px">${fmtNum(s.totalAttempts)}</td>
              <td style="text-align:center;padding:6px">${fmtNum(s.completed)}</td>
              <td style="text-align:center;padding:6px">
                <span class="pill ${s.successRate >= 70 ? 'active' : s.successRate >= 40 ? '' : 'ended'}">${s.successRate}%</span>
              </td>
              <td style="text-align:center;padding:6px">${fmtDuration(s.avgDuration)}</td>
              <td style="text-align:center;padding:6px">${fmtDuration(s.medianDuration)}</td>
            </tr>
          `).join('')}
        </table>
      `;
    } else {
      document.getElementById('task-summary').innerHTML = '';
    }
  } catch (err) {
    document.getElementById('tasks-table').innerHTML = `<div class="status-msg error">${esc(err.message)}</div>`;
  }
}

function showCreateTask() {
  const studyId = document.getElementById('task-study').value;
  if (!studyId) { alert('Select a study first'); return; }
  showModal(`
    <h2>New Task</h2>
    <div class="form-group"><label>Name</label><input id="task-name" placeholder="Find the contact page"></div>
    <div class="form-group"><label>Description</label><textarea id="task-desc" rows="2" placeholder="Brief description"></textarea></div>
    <div class="form-group"><label>Instructions</label><textarea id="task-instructions" rows="3" placeholder="Step-by-step instructions for the participant"></textarea></div>
    <div class="form-group"><label>Target URL</label><input id="task-url" placeholder="/contact"></div>
    <div class="form-group"><label>Success Criteria</label><input id="task-criteria" placeholder="Participant reaches the contact form"></div>
    <div class="form-group"><label>Sort Order</label><input id="task-order" type="number" value="0"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" onclick="createTask(${Number(studyId)})">Create</button>
    </div>
  `);
}

async function createTask(studyId) {
  const name = document.getElementById('task-name').value.trim();
  if (!name) { alert('Name required'); return; }
  try {
    await api('/tasks', {
      method: 'POST',
      body: JSON.stringify({
        studyId,
        name,
        description: document.getElementById('task-desc').value.trim(),
        instructions: document.getElementById('task-instructions').value.trim(),
        targetUrl: document.getElementById('task-url').value.trim(),
        successCriteria: document.getElementById('task-criteria').value.trim(),
        sortOrder: parseInt(document.getElementById('task-order').value) || 0,
      }),
    });
    closeModal();
    loadTasks();
  } catch (err) { alert(err.message); }
}

async function deleteTask(id) {
  if (!confirm('Delete this task and all its instances?')) return;
  try {
    await api(`/tasks/${id}`, { method: 'DELETE' });
    loadTasks();
  } catch (err) { alert(err.message); }
}

async function viewTaskInstances(taskId) {
  try {
    const res = await api(`/tasks/${taskId}/instances`);
    const { instances } = await res.json();
    showModal(`
      <h2>Task Instances</h2>
      ${instances.length === 0 ? '<p style="color:var(--text-muted)">No instances yet</p>' : `
        <table style="font-size:13px">
          <tr><th>Session</th><th>Participant</th><th>Status</th><th>Duration</th><th>Success</th><th>Notes</th></tr>
          ${instances.map(i => `
            <tr>
              <td style="font-family:monospace;font-size:11px">${esc(i.session_id?.substring(0, 8) || '')}...</td>
              <td>${esc(i.participant_id || '—')}</td>
              <td><span class="pill ${i.status === 'completed' ? 'active' : i.status === 'abandoned' ? 'ended' : ''}">${esc(i.status)}</span></td>
              <td>${fmtDuration(i.duration)}</td>
              <td>${i.success ? 'Yes' : 'No'}</td>
              <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis">${esc(i.notes || '—')}</td>
            </tr>
          `).join('')}
        </table>
      `}
      <div class="modal-actions"><button class="btn" onclick="closeModal()">Close</button></div>
    `);
  } catch (err) { alert(err.message); }
}

/* ========== GAZE REPLAY ========== */

let replayData = null;
let replayAnim = null;
let replayPaused = false;
let replayStartTs = 0;
let replayPausedAt = 0;
let replayTrails = [];

async function loadReplayScreenshots() {
  const sessionId = document.getElementById('replay-session').value;
  const sel = document.getElementById('replay-screenshot');
  sel.innerHTML = '<option value="">None (dark background)</option>';
  if (!sessionId) return;
  try {
    const res = await api(`/sessions/${sessionId}/screenshots`);
    const { screenshots } = await res.json();
    sel.innerHTML = '<option value="">None (dark background)</option>' +
      screenshots.map(s =>
        `<option value="${Number(s.id)}">${esc(s.url || 'Unknown')} (${new Date(s.timestamp).toLocaleTimeString()})</option>`
      ).join('');
  } catch {}
}

async function loadReplaySessionList() {
  try {
    const res = await api('/sessions?limit=200');
    const data = await res.json();
    const sel = document.getElementById('replay-session');
    sel.innerHTML = '<option value="">Select session...</option>' +
      data.sessions.map(s =>
        `<option value="${esc(s.id)}">${esc(s.session_name || s.id.substring(0,8))} (${fmtNum(s.event_count)} events)</option>`
      ).join('');
  } catch {}
}

async function startReplay() {
  stopReplay();
  const sessionId = document.getElementById('replay-session').value;
  if (!sessionId) { alert('Select a session'); return; }

  const container = document.getElementById('replay-container');
  const progress = document.getElementById('replay-progress');
  container.innerHTML = '<div class="status-msg info">Loading gaze data...</div>';

  try {
    const res = await api(`/analytics/replay/${sessionId}`);
    replayData = await res.json();
    if (replayData.points.length === 0) {
      container.innerHTML = '<div class="status-msg error">No gaze data for this session</div>';
      return;
    }

    // Check for optional screenshot background
    const screenshotId = document.getElementById('replay-screenshot').value;
    let bgHtml = '';
    if (screenshotId) {
      bgHtml = `<img id="replay-bg" width="960" height="540" style="display:block;border-radius:8px" />`;
    }

    container.innerHTML = `
      <div class="aoi-editor" id="replay-canvas-wrap" style="width:960px;height:540px;background:#1a1a2e;border-radius:8px;overflow:hidden;position:relative">
        ${bgHtml}
        <div class="scanpath-dot" id="replay-dot" style="left:-20px;top:-20px"></div>
      </div>
    `;
    progress.innerHTML = `
      <div class="replay-progress">
        <span id="replay-time">0:00</span>
        <div class="bar" style="width:400px"><div class="bar-fill" id="replay-bar" style="width:0%"></div></div>
        <span id="replay-total">${fmtDuration(replayData.duration)}</span>
        <span id="replay-count">${fmtNum(replayData.count)} points</span>
      </div>
    `;

    if (screenshotId) {
      const imgRes = await fetch(`/api/screenshots/${screenshotId}`, { headers: authHeaders() });
      if (imgRes.ok) {
        const blob = await imgRes.blob();
        document.getElementById('replay-bg').src = URL.createObjectURL(blob);
      }
    }

    document.getElementById('replay-start-btn').style.display = 'none';
    document.getElementById('replay-pause-btn').style.display = '';
    document.getElementById('replay-stop-btn').style.display = '';
    replayPaused = false;
    replayTrails = [];
    replayStartTs = performance.now();
    replayPausedAt = 0;
    animateReplay();
  } catch (err) {
    container.innerHTML = `<div class="status-msg error">${esc(err.message)}</div>`;
  }
}

function animateReplay() {
  if (!replayData) return;
  const speed = parseFloat(document.getElementById('replay-speed').value) || 1;
  const duration = replayData.duration;
  const points = replayData.points;
  const wrap = document.getElementById('replay-canvas-wrap');
  const dot = document.getElementById('replay-dot');

  function frame() {
    if (!replayData) return;
    if (replayPaused) { replayAnim = requestAnimationFrame(frame); return; }

    const elapsed = (performance.now() - replayStartTs) * speed;
    const pct = Math.min(elapsed / duration, 1);

    // Find current point
    const targetT = elapsed;
    let idx = 0;
    for (let i = 0; i < points.length; i++) {
      if (points[i].t <= targetT) idx = i;
      else break;
    }

    const pt = points[idx];
    const px = pt.x * 960;
    const py = pt.y * 540;
    dot.style.left = px + 'px';
    dot.style.top = py + 'px';

    // Add trail dot
    if (replayTrails.length < 500) {
      const trail = document.createElement('div');
      trail.className = 'scanpath-trail';
      trail.style.left = px + 'px';
      trail.style.top = py + 'px';
      wrap.appendChild(trail);
      replayTrails.push(trail);
      // Fade old trails
      if (replayTrails.length > 50) {
        const old = replayTrails.shift();
        old.remove();
      }
    }

    // Update progress
    document.getElementById('replay-bar').style.width = (pct * 100) + '%';
    document.getElementById('replay-time').textContent = fmtDuration(elapsed);

    if (pct >= 1) {
      stopReplay();
      return;
    }
    replayAnim = requestAnimationFrame(frame);
  }
  replayAnim = requestAnimationFrame(frame);
}

function toggleReplayPause() {
  replayPaused = !replayPaused;
  document.getElementById('replay-pause-btn').textContent = replayPaused ? 'Resume' : 'Pause';
  if (!replayPaused) {
    // Adjust start time for paused duration
    replayStartTs += performance.now() - replayPausedAt;
  } else {
    replayPausedAt = performance.now();
  }
}

function stopReplay() {
  if (replayAnim) cancelAnimationFrame(replayAnim);
  replayAnim = null;
  replayData = null;
  replayTrails = [];
  document.getElementById('replay-start-btn').style.display = '';
  document.getElementById('replay-pause-btn').style.display = 'none';
  document.getElementById('replay-stop-btn').style.display = 'none';
}

/* ========== VISUAL AOI EDITOR ========== */

let aoiList = [];
let aoiDrawing = false;
let aoiStart = null;

function initAoiEditor() {
  const sessionId = document.getElementById('overlay-session').value;
  const screenshotId = document.getElementById('overlay-screenshot').value;
  if (!screenshotId) { alert('Select a screenshot first to use as AOI background'); return; }

  const el = document.getElementById('overlay-result');
  el.innerHTML = `
    <div class="aoi-editor" id="aoi-canvas" style="width:960px;height:540px;background:#1a1a2e;border-radius:8px;overflow:hidden;position:relative">
      <img id="aoi-bg" width="960" height="540" style="display:block;opacity:0.7" />
    </div>
    <div style="margin-top:8px;font-size:12px;color:var(--text-muted)">Click and drag to draw AOI rectangles. Named sequentially.</div>
    <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap" id="aoi-list-display"></div>
    <div style="margin-top:12px;display:flex;gap:8px">
      <button class="btn" onclick="clearAois()">Clear All</button>
      <button class="btn primary" onclick="copyAoisToTTFF()">Copy to TTFF</button>
    </div>
  `;

  // Load screenshot
  fetch(`/api/screenshots/${screenshotId}`, { headers: authHeaders() })
    .then(r => r.blob())
    .then(blob => { document.getElementById('aoi-bg').src = URL.createObjectURL(blob); });

  const canvas = document.getElementById('aoi-canvas');
  aoiList = [];

  canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    aoiDrawing = true;
    aoiStart = { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
  });

  canvas.addEventListener('mousemove', (e) => {
    if (!aoiDrawing) return;
    const rect = canvas.getBoundingClientRect();
    const cur = { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
    // Remove preview rect
    const prev = document.getElementById('aoi-preview');
    if (prev) prev.remove();
    const div = document.createElement('div');
    div.id = 'aoi-preview';
    div.className = 'aoi-rect';
    const left = Math.min(aoiStart.x, cur.x) * 100;
    const top = Math.min(aoiStart.y, cur.y) * 100;
    const w = Math.abs(cur.x - aoiStart.x) * 100;
    const h = Math.abs(cur.y - aoiStart.y) * 100;
    div.style.left = left + '%'; div.style.top = top + '%';
    div.style.width = w + '%'; div.style.height = h + '%';
    canvas.appendChild(div);
  });

  canvas.addEventListener('mouseup', (e) => {
    if (!aoiDrawing) return;
    aoiDrawing = false;
    const rect = canvas.getBoundingClientRect();
    const end = { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
    const prev = document.getElementById('aoi-preview');
    if (prev) prev.remove();

    const x = Math.min(aoiStart.x, end.x);
    const y = Math.min(aoiStart.y, end.y);
    const w = Math.abs(end.x - aoiStart.x);
    const h = Math.abs(end.y - aoiStart.y);

    if (w < 0.01 || h < 0.01) return; // Too small

    const name = prompt('AOI Name:', `AOI ${aoiList.length + 1}`);
    if (!name) return;

    aoiList.push({ name, x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000, width: Math.round(w * 1000) / 1000, height: Math.round(h * 1000) / 1000 });

    // Draw permanent rect
    const div = document.createElement('div');
    div.className = 'aoi-rect';
    div.style.left = (x * 100) + '%'; div.style.top = (y * 100) + '%';
    div.style.width = (w * 100) + '%'; div.style.height = (h * 100) + '%';
    div.innerHTML = `<span class="aoi-label">${esc(name)}</span>`;
    canvas.appendChild(div);

    updateAoiDisplay();
  });
}

function updateAoiDisplay() {
  const el = document.getElementById('aoi-list-display');
  if (!el) return;
  el.innerHTML = aoiList.map((a, i) =>
    `<span class="pill active" style="font-size:11px">${esc(a.name)} (${a.x.toFixed(2)},${a.y.toFixed(2)} ${a.width.toFixed(2)}x${a.height.toFixed(2)})</span>`
  ).join('');
}

function clearAois() {
  aoiList = [];
  const canvas = document.getElementById('aoi-canvas');
  if (canvas) {
    canvas.querySelectorAll('.aoi-rect').forEach(r => r.remove());
  }
  updateAoiDisplay();
}

function copyAoisToTTFF() {
  if (aoiList.length === 0) { alert('No AOIs defined'); return; }
  document.getElementById('ttff-aois').value = JSON.stringify(aoiList, null, 2);
  // Also set session
  const sid = document.getElementById('overlay-session').value;
  if (sid) document.getElementById('ttff-sessions').value = sid;
  alert('AOIs copied to TTFF panel. Scroll down to run the analysis.');
}

/* ========== FORM ANALYTICS ========== */

async function loadFormSessionList() {
  try {
    const res = await api('/sessions?limit=200');
    const data = await res.json();
    const sel = document.getElementById('form-session');
    sel.innerHTML = '<option value="">Select session...</option>' +
      data.sessions.map(s =>
        `<option value="${esc(s.id)}">${esc(s.session_name || s.id.substring(0,8))} (${fmtNum(s.event_count)} events)</option>`
      ).join('');
  } catch {}
}

async function loadFormAnalytics() {
  const sessionId = document.getElementById('form-session').value;
  const el = document.getElementById('form-analytics-result');
  if (!sessionId) { el.innerHTML = '<p style="color:var(--text-muted)">Select a session</p>'; return; }

  el.innerHTML = '<div class="status-msg info">Analyzing form interactions...</div>';

  try {
    const res = await api(`/analytics/forms/${sessionId}`);
    const data = await res.json();

    if (data.summary.totalInteractions === 0) {
      el.innerHTML = '<div class="status-msg" style="background:rgba(139,148,158,0.1);border:1px solid var(--border)">No form interactions found in this session.</div>';
      return;
    }

    const maxDwell = Math.max(...data.fields.map(f => f.totalDwell), 1);

    let html = `
      <div class="card-grid">
        <div class="card"><div class="label">Total Interactions</div><div class="value">${fmtNum(data.summary.totalInteractions)}</div></div>
        <div class="card"><div class="label">Unique Fields</div><div class="value">${fmtNum(data.summary.uniqueFields)}</div></div>
        <div class="card"><div class="label">Submissions</div><div class="value">${fmtNum(data.summary.totalSubmissions)}</div></div>
        <div class="card"><div class="label">Errors</div><div class="value ${data.summary.totalErrors > 0 ? 'red' : ''}">${fmtNum(data.summary.totalErrors)}</div></div>
      </div>

      <h3 style="margin-bottom:12px">Field Dwell Time</h3>
      <div class="card" style="padding:16px;margin-bottom:16px">
        <table style="width:100%;font-size:13px">
          <tr><th style="text-align:left">Field</th><th>Type</th><th>Req</th><th>Visits</th><th>Avg Dwell</th><th>Total Dwell</th><th>Changed</th><th>Abandon Rate</th><th style="width:200px">Dwell</th></tr>
          ${data.fields.map(f => `
            <tr>
              <td style="font-weight:600">${esc(f.fieldName || f.fieldId)}</td>
              <td>${esc(f.fieldType)}</td>
              <td>${f.required ? '<span class="pill active" style="font-size:9px">req</span>' : ''}</td>
              <td style="text-align:center">${fmtNum(f.interactions)}</td>
              <td style="text-align:center">${fmtDuration(f.avgDwell)}</td>
              <td style="text-align:center">${fmtDuration(f.totalDwell)}</td>
              <td style="text-align:center">${fmtNum(f.changedCount)}</td>
              <td style="text-align:center">
                <span class="pill ${f.abandonRate > 30 ? 'ended' : f.abandonRate > 10 ? '' : 'active'}">${f.abandonRate}%</span>
              </td>
              <td>
                <div style="height:8px;background:var(--border);border-radius:4px;overflow:hidden">
                  <div class="dwell-bar" style="width:${(f.totalDwell/maxDwell*100).toFixed(0)}%"></div>
                </div>
              </td>
            </tr>
          `).join('')}
        </table>
      </div>
    `;

    if (data.submissions.length > 0) {
      html += `
        <h3 style="margin-bottom:12px">Form Submissions</h3>
        <div class="card" style="padding:16px;margin-bottom:16px">
          <table style="width:100%;font-size:13px">
            <tr><th style="text-align:left">URL</th><th>Form</th><th>Time</th><th>Total Fields</th><th>Filled</th><th>Empty Required</th></tr>
            ${data.submissions.map(s => `
              <tr>
                <td style="word-break:break-all;max-width:300px">${esc(s.url)}</td>
                <td>${esc(s.formId || '—')}</td>
                <td>${new Date(s.timestamp).toLocaleTimeString()}</td>
                <td style="text-align:center">${fmtNum(s.totalFields)}</td>
                <td style="text-align:center">${fmtNum(s.filledFields)}</td>
                <td style="text-align:center;${s.emptyRequired > 0 ? 'color:var(--red)' : ''}">${fmtNum(s.emptyRequired)}</td>
              </tr>
            `).join('')}
          </table>
        </div>
      `;
    }

    if (data.errors.length > 0) {
      html += `
        <h3 style="margin-bottom:12px">Validation Errors</h3>
        <div class="card" style="padding:16px">
          <table style="width:100%;font-size:13px">
            <tr><th style="text-align:left">Field</th><th>Message</th><th>Time</th></tr>
            ${data.errors.slice(0, 50).map(e => `
              <tr>
                <td style="font-weight:600">${esc(e.fieldName || e.fieldId)}</td>
                <td>${esc(e.message)}</td>
                <td>${new Date(e.timestamp).toLocaleTimeString()}</td>
              </tr>
            `).join('')}
          </table>
        </div>
      `;
    }

    el.innerHTML = html;
  } catch (err) {
    el.innerHTML = `<div class="status-msg error">${esc(err.message)}</div>`;
  }
}

// Initial load
loadOverview();
loadCohortStudies();
loadTaskStudies();
