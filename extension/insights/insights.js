/**
 * EyeD Insights Dashboard
 * Analytics, visualizations, and export for eye tracking session data.
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let currentData = null; // { gazePoints, mousePoints, touchPoints, firstViewedPoints }
let fixations = [];
let scanpath = null;
let aoiResults = [];
let engagement = null;

/* ========== TAB SWITCHING ========== */
$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    $$('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $(`#tab-${tab.dataset.tab}`).classList.add('active');
  });
});

/* ========== DATA LOADING ========== */
async function loadTabList() {
  const selector = $('#tab-selector');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_ALL_TAB_DATA' });
    if (result?.tabs) {
      selector.innerHTML = '<option value="">Select a tab...</option>';
      for (const tab of result.tabs) {
        const opt = document.createElement('option');
        opt.value = tab.tabId;
        const title = tab.url ? new URL(tab.url).hostname : `Tab ${tab.tabId}`;
        opt.textContent = `${title} (${tab.gazeCount} pts)`;
        selector.appendChild(opt);
      }
    }
  } catch (e) {
    // Try session data instead
    const result = await chrome.runtime.sendMessage({ type: 'EXPORT_SESSION' });
    if (result?.data) {
      selector.innerHTML = '<option value="">Select a page...</option>';
      const hd = result.data.heatmapData || {};
      for (const [tabId, data] of Object.entries(hd)) {
        if (data.gazePoints?.length > 0) {
          const opt = document.createElement('option');
          opt.value = tabId;
          const title = data.url ? new URL(data.url).hostname : `Tab ${tabId}`;
          opt.textContent = `${title} (${data.gazePoints.length} pts)`;
          opt.dataset.json = JSON.stringify(data);
          selector.appendChild(opt);
        }
      }
    }
  }
}

$('#tab-selector').addEventListener('change', async (e) => {
  const tabId = e.target.value;
  if (!tabId) return;

  // Show loading state
  $('#score-value').textContent = '...';
  $('#m-fixations').textContent = '...';

  // Try to get data from the selected option's embedded JSON
  const selectedOpt = e.target.selectedOptions[0];
  if (selectedOpt.dataset.json) {
    currentData = JSON.parse(selectedOpt.dataset.json);
  } else {
    const result = await chrome.runtime.sendMessage({ type: 'GET_HEATMAP_DATA', tabId: parseInt(tabId) });
    currentData = result;
  }

  if (currentData) {
    // Defer heavy analysis to next frame to avoid blocking UI
    requestAnimationFrame(() => {
      analyzeData();
      renderAll();
    });
  }
});

$('#btn-refresh').addEventListener('click', loadTabList);

/* ========== ANALYTICS ========== */
function analyzeData() {
  if (!currentData) return;

  const viewW = window.screen.width;
  const viewH = window.screen.height;
  const gazePoints = currentData.gazePoints || [];

  // Detect fixations
  fixations = detectFixationsSimple(gazePoints, viewW, viewH);

  // Build scanpath
  scanpath = buildScanpathSimple(fixations);

  // Compute engagement (simplified - no AOI from insights page since we don't have DOM access)
  const sessionDuration = gazePoints.length > 1
    ? gazePoints[gazePoints.length - 1].timestamp - gazePoints[0].timestamp
    : 0;

  engagement = computeEngagementSimple(gazePoints, fixations, sessionDuration);
}

// Simplified fixation detection (runs in insights page context without DOM)
function detectFixationsSimple(points, viewW, viewH) {
  if (points.length < 3) return [];

  const DISPERSION = 50;
  const MIN_DURATION = 150;
  const fixations = [];
  let start = 0;

  while (start < points.length) {
    let end = start + 1;

    while (end < points.length) {
      const slice = points.slice(start, end + 1);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of slice) {
        const px = p.x * viewW;
        const py = p.y * viewH;
        minX = Math.min(minX, px);
        maxX = Math.max(maxX, px);
        minY = Math.min(minY, py);
        maxY = Math.max(maxY, py);
      }

      if ((maxX - minX) + (maxY - minY) <= DISPERSION) {
        end++;
      } else {
        break;
      }
    }

    const duration = points[Math.min(end, points.length - 1)].timestamp - points[start].timestamp;

    if (end - start >= 2 && duration >= MIN_DURATION) {
      const fixPts = points.slice(start, end);
      const cx = fixPts.reduce((s, p) => s + p.x, 0) / fixPts.length;
      const cy = fixPts.reduce((s, p) => s + p.y, 0) / fixPts.length;

      fixations.push({
        index: fixations.length + 1,
        cx, cy,
        startTime: fixPts[0].timestamp,
        endTime: fixPts[fixPts.length - 1].timestamp,
        duration,
        pointCount: fixPts.length,
      });
      start = end;
    } else {
      start++;
    }
  }

  return fixations;
}

function buildScanpathSimple(fixations) {
  const saccades = [];
  for (let i = 1; i < fixations.length; i++) {
    const prev = fixations[i - 1];
    const curr = fixations[i];
    saccades.push({
      fromX: prev.cx, fromY: prev.cy,
      toX: curr.cx, toY: curr.cy,
      duration: curr.startTime - prev.endTime,
    });
  }
  return { fixations, saccades };
}

function computeEngagementSimple(gazePoints, fixations, sessionDuration) {
  if (gazePoints.length === 0 || sessionDuration === 0) {
    return { score: 0, breakdown: { stability: 0, depth: 0, breadth: 0, revisits: 0, pattern: 0 } };
  }

  const totalFixTime = fixations.reduce((s, f) => s + f.duration, 0);
  const fixRatio = totalFixTime / sessionDuration;
  const avgDur = fixations.length > 0 ? totalFixTime / fixations.length : 0;

  // Scan pattern
  const xs = fixations.map(f => f.cx);
  const ys = fixations.map(f => f.cy);
  let monotonic = 0;
  for (let i = 1; i < ys.length; i++) {
    if (ys[i] >= ys[i - 1] - 0.05) monotonic++;
  }
  const isLinear = ys.length > 1 && monotonic / (ys.length - 1) > 0.7;

  // F-pattern check
  let topHorizontal = 0, leftVertical = 0;
  for (let i = 0; i < Math.min(fixations.length, 10); i++) {
    if (ys[i] < 0.3) topHorizontal++;
    if (xs[i] < 0.4) leftVertical++;
  }
  const isFPattern = topHorizontal >= 3 && leftVertical >= 3;
  const pattern = fixations.length < 5 ? 'insufficient' : isFPattern ? 'F-pattern' : isLinear ? 'linear' : 'exploratory';

  const stability = Math.min(1, fixRatio * 1.5);
  const depth = Math.min(1, avgDur / 500);

  // Estimate breadth from spatial diversity of fixations (without AOI/DOM access)
  const gridSize = 4;
  const visitedCells = new Set();
  for (const fix of fixations) {
    const gx = Math.min(gridSize - 1, Math.floor(fix.cx * gridSize));
    const gy = Math.min(gridSize - 1, Math.floor(fix.cy * gridSize));
    visitedCells.add(`${gx},${gy}`);
  }
  const breadth = visitedCells.size / (gridSize * gridSize);

  // Estimate revisits: count how often fixation returns to a previously visited grid cell
  let revisitCount = 0;
  const cellHistory = [];
  for (const fix of fixations) {
    const gx = Math.min(gridSize - 1, Math.floor(fix.cx * gridSize));
    const gy = Math.min(gridSize - 1, Math.floor(fix.cy * gridSize));
    const cell = `${gx},${gy}`;
    if (cellHistory.length > 0 && cellHistory[cellHistory.length - 1] !== cell && cellHistory.includes(cell)) {
      revisitCount++;
    }
    cellHistory.push(cell);
  }
  const revisitRatio = fixations.length > 0 ? revisitCount / fixations.length : 0;

  const score = Math.round(
    stability * 30 +
    depth * 25 +
    breadth * 20 +
    Math.min(1, revisitRatio * 5) * 15 +
    (pattern !== 'exploratory' && pattern !== 'insufficient' ? 10 : 0)
  );

  return {
    score: Math.min(100, score),
    fixationCount: fixations.length,
    totalFixationTime: totalFixTime,
    avgFixationDuration: Math.round(avgDur),
    fixationRatio: Math.round(fixRatio * 100),
    scanPattern: pattern,
    sessionDuration,
    breakdown: {
      stability: Math.round(stability * 30),
      depth: Math.round(depth * 25),
      breadth: Math.round(breadth * 20),
      revisits: Math.round(Math.min(1, revisitRatio * 5) * 15),
      pattern: (pattern !== 'exploratory' && pattern !== 'insufficient') ? 10 : 0,
    }
  };
}

/* ========== RENDERING ========== */
function renderAll() {
  renderEngagement();
  renderOverview();
  renderScanpath();
  renderTimeline();
  checkVideoData();
}

function renderEngagement() {
  if (!engagement) return;

  const ring = $('#score-ring');
  const offset = 264 - (264 * engagement.score / 100);
  ring.style.strokeDashoffset = offset;

  // Color based on score
  if (engagement.score >= 70) ring.style.stroke = '#3fb950';
  else if (engagement.score >= 40) ring.style.stroke = '#d29922';
  else ring.style.stroke = '#f85149';

  $('#score-value').textContent = engagement.score;

  const bd = engagement.breakdown;
  const maxVals = { stability: 30, depth: 25, breadth: 20, revisits: 15, pattern: 10 };

  for (const [key, max] of Object.entries(maxVals)) {
    const pct = (bd[key] / max * 100);
    $(`#bar-${key}`).style.width = pct + '%';
    $(`#val-${key}`).textContent = bd[key];
  }
}

function renderOverview() {
  if (!currentData || !engagement) return;

  const gaze = currentData.gazePoints || [];
  const mouse = currentData.mousePoints || [];
  const touch = currentData.touchPoints || [];
  const firstViewed = currentData.firstViewedPoints || [];

  $('#m-fixations').textContent = fixations.length;
  $('#m-avg-duration').textContent = engagement.avgFixationDuration + 'ms';
  $('#m-scan-pattern').textContent = engagement.scanPattern;
  $('#m-gaze-points').textContent = gaze.length;
  $('#m-mouse-points').textContent = mouse.length;
  $('#m-touch-points').textContent = touch.length;
  $('#m-first-viewed').textContent = firstViewed.length;

  // Above fold
  const aboveFold = fixations.filter(f => f.cy <= 1).length;
  const pct = fixations.length > 0 ? Math.round(aboveFold / fixations.length * 100) : 0;
  $('#m-above-fold').textContent = pct + '%';

  // First viewed list
  const listEl = $('#first-viewed-list');
  if (firstViewed.length > 0) {
    listEl.innerHTML = firstViewed.map((p, i) => `
      <div class="item-row">
        <span class="item-rank orange">${i + 1}</span>
        <div class="item-info">
          <div class="item-name">${p.tagName || 'Element'}</div>
          <div class="item-detail">${p.text || `(${(p.x * 100).toFixed(0)}%, ${(p.y * 100).toFixed(0)}%)`}</div>
        </div>
      </div>
    `).join('');
  } else {
    listEl.innerHTML = '<p class="empty-state">No first-viewed data</p>';
  }

  // Duration distribution chart
  renderDurationChart();
}

function renderDurationChart() {
  const canvas = $('#duration-chart');
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.clientWidth * 2;
  canvas.height = 300;
  ctx.scale(2, 2);

  const w = canvas.clientWidth;
  const h = 150;

  ctx.clearRect(0, 0, w, h);

  if (fixations.length === 0) {
    ctx.fillStyle = '#484f58';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No fixation data', w / 2, h / 2);
    return;
  }

  // Bucket fixations by duration
  const buckets = [0, 150, 300, 500, 750, 1000, 1500, 2000, 3000];
  const counts = new Array(buckets.length).fill(0);

  for (const fix of fixations) {
    for (let i = buckets.length - 1; i >= 0; i--) {
      if (fix.duration >= buckets[i]) { counts[i]++; break; }
    }
  }

  const maxCount = Math.max(...counts, 1);
  const barW = (w - 40) / buckets.length;
  const chartH = h - 30;

  // Bars
  for (let i = 0; i < buckets.length; i++) {
    const barH = (counts[i] / maxCount) * chartH;
    const x = 30 + i * barW;
    const y = chartH - barH;

    ctx.fillStyle = counts[i] > 0 ? '#58a6ff' : '#21262d';
    ctx.fillRect(x + 2, y, barW - 4, barH);

    // Label
    ctx.fillStyle = '#8b949e';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    const label = buckets[i] >= 1000 ? `${buckets[i] / 1000}s` : `${buckets[i]}ms`;
    ctx.fillText(label, x + barW / 2, chartH + 12);

    if (counts[i] > 0) {
      ctx.fillStyle = '#e6edf3';
      ctx.fillText(counts[i], x + barW / 2, y - 4);
    }
  }
}

function renderScanpath() {
  const canvas = $('#scanpath-canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.clientWidth * 2;
  canvas.height = 800;
  ctx.scale(2, 2);

  const w = canvas.clientWidth;
  const h = 400;
  ctx.clearRect(0, 0, w, h);

  if (!scanpath || fixations.length === 0) {
    ctx.fillStyle = '#484f58';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No scanpath data', w / 2, h / 2);
    return;
  }

  // Draw saccade lines
  ctx.strokeStyle = 'rgba(88, 166, 255, 0.3)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);

  for (const s of scanpath.saccades) {
    ctx.beginPath();
    ctx.moveTo(s.fromX * w, s.fromY * h);
    ctx.lineTo(s.toX * w, s.toY * h);
    ctx.stroke();

    // Arrow
    const angle = Math.atan2(s.toY * h - s.fromY * h, s.toX * w - s.fromX * w);
    ctx.fillStyle = 'rgba(88, 166, 255, 0.4)';
    ctx.beginPath();
    ctx.moveTo(s.toX * w, s.toY * h);
    ctx.lineTo(s.toX * w - 6 * Math.cos(angle - 0.4), s.toY * h - 6 * Math.sin(angle - 0.4));
    ctx.lineTo(s.toX * w - 6 * Math.cos(angle + 0.4), s.toY * h - 6 * Math.sin(angle + 0.4));
    ctx.closePath();
    ctx.fill();
  }
  ctx.setLineDash([]);

  // Draw fixation circles
  for (const fix of fixations) {
    const px = fix.cx * w;
    const py = fix.cy * h;
    const r = Math.max(8, Math.min(25, fix.duration / 25));

    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(88, 166, 255, 0.2)';
    ctx.fill();
    ctx.strokeStyle = '#58a6ff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Number
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(fix.index, px, py);
  }
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';

  // Fixation table
  const tbody = $('#fixation-table tbody');
  tbody.innerHTML = fixations.map(fix => {
    const elapsed = fixations[0] ? ((fix.startTime - fixations[0].startTime) / 1000).toFixed(1) : '0';
    return `<tr>
      <td>${fix.index}</td>
      <td>${fix.duration}ms</td>
      <td>(${(fix.cx * 100).toFixed(0)}%, ${(fix.cy * 100).toFixed(0)}%)</td>
      <td>${elapsed}s</td>
    </tr>`;
  }).join('');
}

function renderTimeline() {
  const canvas = $('#timeline-canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.clientWidth * 2;
  canvas.height = 600;
  ctx.scale(2, 2);

  const w = canvas.clientWidth;
  const h = 300;
  ctx.clearRect(0, 0, w, h);

  const gaze = currentData?.gazePoints || [];
  if (gaze.length < 2) {
    ctx.fillStyle = '#484f58';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Not enough gaze data', w / 2, h / 2);
    return;
  }

  const t0 = gaze[0].timestamp;
  const tEnd = gaze[gaze.length - 1].timestamp;
  const duration = tEnd - t0;
  if (duration === 0) return;

  const margin = { left: 40, right: 10, top: 20, bottom: 30 };
  const plotW = w - margin.left - margin.right;
  const plotH = h - margin.top - margin.bottom;

  // Axes
  ctx.strokeStyle = '#30363d';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(margin.left, margin.top);
  ctx.lineTo(margin.left, margin.top + plotH);
  ctx.lineTo(margin.left + plotW, margin.top + plotH);
  ctx.stroke();

  // Labels
  ctx.fillStyle = '#8b949e';
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Time (s)', margin.left + plotW / 2, h - 4);

  ctx.save();
  ctx.translate(10, margin.top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('Y Position', 0, 0);
  ctx.restore();

  // Time axis ticks
  const timeTicks = 5;
  for (let i = 0; i <= timeTicks; i++) {
    const x = margin.left + (i / timeTicks) * plotW;
    const t = (duration * i / timeTicks / 1000).toFixed(1);
    ctx.fillStyle = '#484f58';
    ctx.fillText(`${t}s`, x, margin.top + plotH + 14);
  }

  // Plot gaze Y over time (subsample for performance)
  const step = Math.max(1, Math.floor(gaze.length / 500));
  ctx.strokeStyle = 'rgba(88, 166, 255, 0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();

  for (let i = 0; i < gaze.length; i += step) {
    const p = gaze[i];
    const x = margin.left + ((p.timestamp - t0) / duration) * plotW;
    const y = margin.top + Math.min(1, Math.max(0, p.y)) * plotH;

    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Overlay fixations as blocks
  for (const fix of fixations) {
    const x = margin.left + ((fix.startTime - t0) / duration) * plotW;
    const fixW = Math.max(2, ((fix.endTime - fix.startTime) / duration) * plotW);
    const y = margin.top + fix.cy * plotH;

    ctx.fillStyle = 'rgba(88, 166, 255, 0.3)';
    ctx.fillRect(x, y - 4, fixW, 8);
    ctx.strokeStyle = '#58a6ff';
    ctx.strokeRect(x, y - 4, fixW, 8);
  }
}

function checkVideoData() {
  const gaze = currentData?.gazePoints || [];
  const hasVideo = gaze.some(p => p.videoTime != null);

  if (hasVideo) {
    $('#video-timeline-card').style.display = 'block';
    renderVideoTimeline();
  }
}

function renderVideoTimeline() {
  const canvas = $('#video-timeline-canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.clientWidth * 2;
  canvas.height = 400;
  ctx.scale(2, 2);

  const w = canvas.clientWidth;
  const h = 200;
  ctx.clearRect(0, 0, w, h);

  const gaze = (currentData?.gazePoints || []).filter(p => p.videoTime != null);
  if (gaze.length < 2) return;

  const maxTime = Math.max(...gaze.map(p => p.videoTime));
  const bucketSize = Math.max(1, maxTime / 50);

  const margin = { left: 40, right: 10, top: 20, bottom: 30 };
  const plotW = w - margin.left - margin.right;
  const plotH = h - margin.top - margin.bottom;

  // Count gaze points per time bucket
  const buckets = [];
  for (let t = 0; t < maxTime; t += bucketSize) {
    const count = gaze.filter(p => p.videoTime >= t && p.videoTime < t + bucketSize).length;
    buckets.push({ t, count });
  }

  const maxCount = Math.max(...buckets.map(b => b.count), 1);

  // Draw bars
  const barW = plotW / buckets.length;
  for (let i = 0; i < buckets.length; i++) {
    const barH = (buckets[i].count / maxCount) * plotH;
    const x = margin.left + i * barW;
    const y = margin.top + plotH - barH;

    const intensity = buckets[i].count / maxCount;
    ctx.fillStyle = `rgba(88, 166, 255, ${0.3 + intensity * 0.7})`;
    ctx.fillRect(x, y, barW - 1, barH);
  }

  // Time labels
  ctx.fillStyle = '#8b949e';
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'center';
  for (let i = 0; i <= 5; i++) {
    const x = margin.left + (i / 5) * plotW;
    const t = (maxTime * i / 5).toFixed(0);
    ctx.fillText(`${t}s`, x, margin.top + plotH + 14);
  }

  // Update range controls
  $('#video-time-start').max = Math.floor(maxTime);
  $('#video-time-end').max = Math.floor(maxTime);
  $('#video-time-end').value = Math.floor(maxTime);
  $('#video-time-label').textContent = `0s - ${Math.floor(maxTime)}s`;
}

/* ========== EXPORTS ========== */
$('#btn-export-json').addEventListener('click', () => {
  if (!currentData) return;
  const report = {
    exportDate: new Date().toISOString(),
    url: currentData.url || '',
    summary: engagement,
    fixations: fixations.map(f => ({ ...f, points: undefined })),
    scanpath: scanpath ? { ...scanpath } : null,
    rawData: {
      gazePointCount: (currentData.gazePoints || []).length,
      mousePointCount: (currentData.mousePoints || []).length,
      touchPointCount: (currentData.touchPoints || []).length,
      firstViewedCount: (currentData.firstViewedPoints || []).length,
    },
    gazePoints: currentData.gazePoints || [],
    firstViewedPoints: currentData.firstViewedPoints || [],
  };

  downloadJSON(report, `eyed-report-${Date.now()}.json`);
});

$('#btn-export-csv').addEventListener('click', () => {
  if (!fixations.length) return;
  const header = 'Index,CenterX,CenterY,Duration_ms,StartTime,EndTime,PointCount\n';
  const rows = fixations.map(f =>
    `${f.index},${f.cx.toFixed(4)},${f.cy.toFixed(4)},${f.duration},${f.startTime},${f.endTime},${f.pointCount}`
  ).join('\n');

  const blob = new Blob([header + rows], { type: 'text/csv' });
  downloadBlob(blob, `eyed-fixations-${Date.now()}.csv`);
});

$('#btn-export-scanpath').addEventListener('click', () => {
  const canvas = $('#scanpath-canvas');
  const dataUrl = canvas.toDataURL('image/png');
  downloadDataUrl(dataUrl, `eyed-scanpath-${Date.now()}.png`);
});

$('#btn-export-heatmap').addEventListener('click', async () => {
  // Request heatmap screenshot from the active tab's content script
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: false });
    const tab = tabs.find(t => t.url && !t.url.startsWith('chrome'));
    if (tab) {
      const result = await chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_HEATMAP_SCREENSHOT' });
      if (result?.dataUrl) {
        downloadDataUrl(result.dataUrl, `eyed-heatmap-${Date.now()}.png`);
      }
    }
  } catch (e) {
    // Fallback: export the timeline canvas
    const canvas = $('#timeline-canvas');
    const dataUrl = canvas.toDataURL('image/png');
    downloadDataUrl(dataUrl, `eyed-timeline-${Date.now()}.png`);
  }
});

function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  downloadBlob(blob, filename);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadDataUrl(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  a.click();
}

/* ========== INIT ========== */
loadTabList();
