/**
 * EyeD Content Script
 * Renders heatmap overlay, gaze cursor, scanpath, and tracks mouse/touch input.
 * Receives gaze data from the background service worker.
 * Integrates: scroll-aware tracking, video temporal tracking, analytics, screenshots.
 */

(function () {
  'use strict';

  if (window.__eyedContentLoaded) return;
  window.__eyedContentLoaded = true;

  /* ========== STATE ========== */
  const state = {
    trackingActive: false,
    recordingActive: false,
    showHeatmap: false,
    showScanpath: false,
    showCursor: true,
    // All point arrays now carry: { x, y, pageX, pageY, scrollX, scrollY, timestamp, videoTime?, ... }
    gazePoints: [],
    touchPoints: [],
    mousePoints: [],
    firstViewedPoints: [],
    firstViewedElements: [],
    isNewPage: false,
    pageLoadTime: 0,
    firstViewedWindowMs: 5000,
    heatmapDirty: true,
    browserUIGaze: false,
    smoothedGaze: { x: 0.5, y: 0.5 },
    mousePos: { x: 0, y: 0 },
    // Analytics cache
    fixations: [],
    scanpath: null,
    analyticsDirty: true,
    // Pre-filtered gaze cache
    _gazeNonUI: null,
    _gazeNonUIDirty: true,
    // Settings from background
    settings: null,
    // Event buffer for centralized upload
    eventBuffer: [],
    eventFlushTimer: null,
    // Scroll depth tracking
    maxScrollDepth: 0,
    scrollMilestones: { 25: false, 50: false, 75: false, 100: false },
    // Hover tracking
    hoverTarget: null,
    hoverStartTime: 0,
    // Rage/dead click tracking
    recentClicks: [],
    // Auto-screenshot
    autoScreenshotTimer: null,
    lastAutoScreenshotTime: 0,
  };

  /* ========== DOM SETUP ========== */
  function createOverlayElements() {
    const canvas = document.createElement('canvas');
    canvas.id = 'eyed-heatmap-canvas';
    canvas.classList.add('hidden');
    document.documentElement.appendChild(canvas);

    const scanCanvas = document.createElement('canvas');
    scanCanvas.id = 'eyed-scanpath-canvas';
    scanCanvas.classList.add('hidden');
    document.documentElement.appendChild(scanCanvas);

    const cursor = document.createElement('div');
    cursor.id = 'eyed-gaze-cursor';
    document.documentElement.appendChild(cursor);

    const browserZone = document.createElement('div');
    browserZone.id = 'eyed-browser-zone';
    document.documentElement.appendChild(browserZone);

    const indicator = document.createElement('div');
    indicator.id = 'eyed-tracking-indicator';
    document.documentElement.appendChild(indicator);

    // Video timeline bar (shown when video is detected)
    const timeline = document.createElement('div');
    timeline.id = 'eyed-timeline-bar';
    timeline.classList.add('hidden');
    document.documentElement.appendChild(timeline);

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
  }

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    for (const id of ['eyed-heatmap-canvas', 'eyed-scanpath-canvas']) {
      const c = document.getElementById(id);
      if (c) {
        c.width = window.innerWidth * dpr;
        c.height = window.innerHeight * dpr;
        c.style.width = window.innerWidth + 'px';
        c.style.height = window.innerHeight + 'px';
        const ctx = c.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    }
    state.heatmapDirty = true;
  }

  /* ========== ENRICHED POINT CREATION ========== */
  // Allowed extra properties for createPoint (whitelist prevents prototype pollution)
  const POINT_EXTRA_KEYS = ['isBrowserUI', 'timestamp'];

  function createPoint(x, y, extras = {}) {
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const point = {
      x, y,
      pageX: x * viewW + window.scrollX,
      pageY: y * viewH + window.scrollY,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      timestamp: extras.timestamp || Date.now(),
    };
    for (const key of POINT_EXTRA_KEYS) {
      if (key in extras) point[key] = extras[key];
    }

    // Enrich with video time if video is playing
    if (typeof EyedVideoTracker !== 'undefined') {
      const vt = EyedVideoTracker.getCurrentVideoTime();
      if (vt) {
        point.videoTime = vt.currentTime;
        point.videoDuration = vt.duration;

        // Check if gaze is on the video element
        const px = x * viewW;
        const py = y * viewH;
        const vr = vt.videoRect;
        if (vr && px >= vr.x && px <= vr.x + vr.width && py >= vr.y && py <= vr.y + vr.height) {
          point.onVideo = true;
          point.videoRelX = (px - vr.x) / vr.width;
          point.videoRelY = (py - vr.y) / vr.height;
        }
      }
    }

    return point;
  }

  /* ========== GAZE DATA HANDLING ========== */
  const SMOOTHING = 0.3;

  function handleGazePoint(data) {
    if (!state.trackingActive) return;
    if (!isChannelEnabled('gaze')) return;

    const { x, y, timestamp, confidence } = data;

    state.smoothedGaze.x = state.smoothedGaze.x * (1 - SMOOTHING) + x * SMOOTHING;
    state.smoothedGaze.y = state.smoothedGaze.y * (1 - SMOOTHING) + y * SMOOTHING;

    const sx = state.smoothedGaze.x;
    const sy = state.smoothedGaze.y;

    const browserZone = document.getElementById('eyed-browser-zone');

    if (sy < 0) {
      state.browserUIGaze = true;
      if (browserZone) browserZone.classList.add('gaze-above');
      state.gazePoints.push(createPoint(sx, sy, { isBrowserUI: true, timestamp }));
    } else {
      state.browserUIGaze = false;
      if (browserZone) browserZone.classList.remove('gaze-above');

      const point = createPoint(sx, sy, { isBrowserUI: false, timestamp });
      state.gazePoints.push(point);

      // Identify element under gaze
      identifyGazedElement(point);

      // First-viewed detection
      if (state.isNewPage && (Date.now() - state.pageLoadTime) < state.firstViewedWindowMs) {
        identifyFirstViewedElement(sx, sy, timestamp);
      } else if (state.isNewPage) {
        state.isNewPage = false;
      }
    }

    updateGazeCursor(sx, sy);

    // Store in background with enriched data from the point we just created
    const lastPoint = state.gazePoints[state.gazePoints.length - 1];
    chrome.runtime.sendMessage({
      type: 'STORE_GAZE_POINT',
      x: sx, y: sy,
      pageX: lastPoint.pageX,
      pageY: lastPoint.pageY,
      scrollX: lastPoint.scrollX,
      scrollY: lastPoint.scrollY,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      timestamp,
      videoTime: lastPoint.videoTime,
      onVideo: lastPoint.onVideo,
    }).catch(() => {});

    state.heatmapDirty = true;
    state._gazeNonUIDirty = true;
    state.analyticsDirty = true;

    if (state.gazePoints.length > 10000) {
      state.gazePoints = state.gazePoints.slice(-5000);
      state._gazeNonUIDirty = true;
    }
  }

  function identifyGazedElement(point) {
    const px = point.x * window.innerWidth;
    const py = point.y * window.innerHeight;
    if (px < 0 || py < 0) return;

    // Throttle element detection to every 10th point
    if (state.gazePoints.length % 10 !== 0) return;

    const overlays = ['eyed-heatmap-canvas', 'eyed-gaze-cursor', 'eyed-scanpath-canvas'];
    const hidden = [];
    for (const id of overlays) {
      const el = document.getElementById(id);
      if (el && el.style.display !== 'none') {
        hidden.push({ el, pe: el.style.pointerEvents });
        el.style.pointerEvents = 'none';
      }
    }

    const el = document.elementFromPoint(px, py);

    for (const { el: e, pe } of hidden) {
      e.style.pointerEvents = pe;
    }

    if (el && !el.id?.startsWith('eyed-')) {
      point.elementTag = el.tagName;
      point.elementSelector = el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`;
    }
  }

  function updateGazeCursor(x, y) {
    const cursor = document.getElementById('eyed-gaze-cursor');
    if (!cursor || !state.showCursor) return;
    cursor.style.left = (x * window.innerWidth) + 'px';
    cursor.style.top = (y * window.innerHeight) + 'px';
  }

  /* ========== FIRST-VIEWED DETECTION ========== */
  let lastFirstViewedCheck = 0;
  const FIRST_VIEWED_THROTTLE_MS = 100;
  const MAX_FIRST_VIEWED_POINTS = 50;

  function identifyFirstViewedElement(x, y, timestamp) {
    // Throttle first-viewed detection
    if (timestamp - lastFirstViewedCheck < FIRST_VIEWED_THROTTLE_MS) return;
    lastFirstViewedCheck = timestamp;

    const px = x * window.innerWidth;
    const py = y * window.innerHeight;

    const canvas = document.getElementById('eyed-heatmap-canvas');
    const cursor = document.getElementById('eyed-gaze-cursor');
    if (canvas) canvas.style.display = 'none';
    if (cursor) cursor.style.display = 'none';

    const element = document.elementFromPoint(px, py);

    if (canvas) canvas.style.display = '';
    if (cursor) cursor.style.display = '';

    if (element && !element.id?.startsWith('eyed-')) {
      // Use selector string instead of DOM reference to avoid memory leak
      const selector = element.id ? `#${element.id}` : `${element.tagName.toLowerCase()}${element.className && typeof element.className === 'string' ? '.' + element.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`;

      if (!state.firstViewedElements.includes(selector)) {
        state.firstViewedElements.push(selector);
        const rect = element.getBoundingClientRect();
        state.firstViewedPoints.push({
          x, y,
          pageX: px + window.scrollX,
          pageY: py + window.scrollY,
          timestamp,
          tagName: element.tagName,
          text: element.textContent?.substring(0, 50),
          selector,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        });

        // Cap first-viewed arrays
        if (state.firstViewedElements.length >= MAX_FIRST_VIEWED_POINTS) {
          state.isNewPage = false;
        }
      }
    }
  }

  /* ========== MOUSE / TOUCH TRACKING ========== */
  function initInputTracking() {
    let mouseThrottle = 0;
    document.addEventListener('mousemove', (e) => {
      state.mousePos.x = e.clientX;
      state.mousePos.y = e.clientY;

      if (state.trackingActive && isChannelEnabled('mouse') && Date.now() - mouseThrottle > 50) {
        mouseThrottle = Date.now();
        const x = e.clientX / window.innerWidth;
        const y = e.clientY / window.innerHeight;
        state.mousePoints.push(createPoint(x, y));

        if (state.recordingActive) {
          chrome.runtime.sendMessage({
            type: 'MOUSE_DATA', x, y,
            pageX: e.clientX + window.scrollX,
            pageY: e.clientY + window.scrollY,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            timestamp: Date.now(),
          }).catch(() => {});
        }

        if (state.mousePoints.length > 5000) state.mousePoints = state.mousePoints.slice(-2500);
      }
    }, { passive: true });

    document.addEventListener('touchstart', handleTouch, { passive: true });
    document.addEventListener('touchmove', handleTouch, { passive: true });
    document.addEventListener('touchend', handleTouch, { passive: true });

    function handleTouch(e) {
      if (!state.trackingActive || !isChannelEnabled('touch')) return;
      for (const touch of e.changedTouches) {
        const x = touch.clientX / window.innerWidth;
        const y = touch.clientY / window.innerHeight;
        state.touchPoints.push(createPoint(x, y));

        if (state.recordingActive) {
          chrome.runtime.sendMessage({
            type: 'TOUCH_DATA', x, y,
            pageX: touch.clientX + window.scrollX,
            pageY: touch.clientY + window.scrollY,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            timestamp: Date.now(),
          }).catch(() => {});
        }
      }
      if (state.touchPoints.length > 5000) state.touchPoints = state.touchPoints.slice(-2500);
    }

    // Track scroll events for scroll-position correlation
    let scrollThrottle = 0;
    document.addEventListener('scroll', () => {
      if (!state.trackingActive || !isChannelEnabled('scroll') || Date.now() - scrollThrottle < 100) return;
      scrollThrottle = Date.now();
      if (state.recordingActive) {
        chrome.runtime.sendMessage({
          type: 'SCROLL_EVENT',
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          pageHeight: document.documentElement.scrollHeight,
          viewHeight: window.innerHeight,
          timestamp: Date.now(),
        }).catch(() => {});
      }
    }, { passive: true });
  }

  /* ========== HEATMAP RENDERING ========== */

  // Reusable offscreen canvas (avoids creating new one every frame)
  let offscreenCanvas = null;
  let offscreenCtx = null;

  function getOffscreen(w, h) {
    if (!offscreenCanvas || offscreenCanvas.width !== w || offscreenCanvas.height !== h) {
      offscreenCanvas = document.createElement('canvas');
      offscreenCanvas.width = w;
      offscreenCanvas.height = h;
      offscreenCtx = offscreenCanvas.getContext('2d');
    }
    offscreenCtx.clearRect(0, 0, w, h);
    return offscreenCtx;
  }

  /** Convert a point's pageX/pageY to current viewport pixel coordinates */
  function toViewport(point) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return {
      px: point.pageX != null ? point.pageX - window.scrollX : point.x * vw,
      py: point.pageY != null ? point.pageY - window.scrollY : point.y * vh,
    };
  }

  function renderHeatmap() {
    const canvas = document.getElementById('eyed-heatmap-canvas');
    if (!canvas || !state.showHeatmap) return;

    const ctx = canvas.getContext('2d');
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    ctx.clearRect(0, 0, vw, vh);

    ctx.globalCompositeOperation = 'source-over';

    // Pre-filter once per frame (avoid re-filtering per draw call)
    if (!state._gazeNonUI || state._gazeNonUIDirty) {
      state._gazeNonUI = state.gazePoints.filter(p => !p.isBrowserUI);
      state._gazeNonUIDirty = false;
    }

    drawHeatPoints(ctx, vw, vh, state._gazeNonUI, 20, 'gaze');
    drawHeatPoints(ctx, vw, vh, state.mousePoints, 10, 'mouse');
    drawHeatPoints(ctx, vw, vh, state.touchPoints, 15, 'touch');
    drawFirstViewedPoints(ctx, vw, vh);
    drawBrowserUIZone(ctx, vw, vh);
  }

  function drawHeatPoints(ctx, vw, vh, points, radius, type) {
    if (points.length === 0) return;

    const offCtx = getOffscreen(vw, vh);

    for (const point of points) {
      // Use scroll-adjusted viewport coordinates
      const { px, py } = toViewport(point);

      // Skip points far off-screen (optimization)
      if (px < -radius || px > vw + radius || py < -radius || py > vh + radius) continue;

      const grad = offCtx.createRadialGradient(px, py, 0, px, py, radius);
      const alpha = type === 'gaze' ? 0.04 : type === 'touch' ? 0.06 : 0.02;
      grad.addColorStop(0, `rgba(0, 0, 0, ${alpha})`);
      grad.addColorStop(1, 'rgba(0, 0, 0, 0)');

      offCtx.fillStyle = grad;
      offCtx.fillRect(px - radius, py - radius, radius * 2, radius * 2);
    }

    const imageData = offCtx.getImageData(0, 0, vw, vh);
    const pixels = imageData.data;

    for (let i = 0; i < pixels.length; i += 4) {
      const intensity = pixels[i + 3];
      if (intensity > 0) {
        const normalized = Math.min(intensity / 180, 1);
        const color = heatmapColor(normalized, type);
        pixels[i] = color.r;
        pixels[i + 1] = color.g;
        pixels[i + 2] = color.b;
        pixels[i + 3] = Math.min(255, intensity * 2);
      }
    }

    offCtx.putImageData(imageData, 0, 0);
    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(offscreenCanvas, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
  }

  function heatmapColor(t, type) {
    if (type === 'mouse') {
      const v = Math.floor(100 + t * 155);
      return { r: v, g: v, b: v };
    }
    if (type === 'touch') {
      return { r: Math.floor(t * 255), g: Math.floor((1 - t) * 200), b: 255 };
    }
    if (t < 0.25) return { r: 0, g: 0, b: Math.floor(t * 4 * 255) };
    if (t < 0.5) { const tt = (t - 0.25) * 4; return { r: 0, g: Math.floor(tt * 255), b: Math.floor((1 - tt) * 255) }; }
    if (t < 0.75) { const tt = (t - 0.5) * 4; return { r: Math.floor(tt * 255), g: 255, b: 0 }; }
    const tt = (t - 0.75) * 4; return { r: 255, g: Math.floor((1 - tt) * 255), b: 0 };
  }

  function drawFirstViewedPoints(ctx, vw, vh) {
    if (state.firstViewedPoints.length === 0) return;

    ctx.globalCompositeOperation = 'screen';
    for (const point of state.firstViewedPoints) {
      const { px, py } = toViewport(point);
      const grad = ctx.createRadialGradient(px, py, 0, px, py, 30);
      grad.addColorStop(0, 'rgba(255, 165, 0, 0.5)');
      grad.addColorStop(0.5, 'rgba(255, 120, 0, 0.2)');
      grad.addColorStop(1, 'rgba(255, 80, 0, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(px, py, 30, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalCompositeOperation = 'source-over';
    for (let i = 0; i < state.firstViewedPoints.length; i++) {
      const p = state.firstViewedPoints[i];
      const { px, py } = toViewport(p);

      // Numbered orange badge
      ctx.beginPath();
      ctx.arc(px, py - 18, 10, 0, Math.PI * 2);
      ctx.fillStyle = '#ff8c00';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.font = 'bold 9px -apple-system, sans-serif';
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), px, py - 18);
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    }
  }

  function drawBrowserUIZone(ctx, w, h) {
    const browserUIPoints = state.gazePoints.filter(p => p.isBrowserUI);
    if (browserUIPoints.length === 0) return;

    const intensity = Math.min(1, browserUIPoints.length / 50);
    const barHeight = 30;

    const grad = ctx.createLinearGradient(0, 0, 0, barHeight);
    grad.addColorStop(0, `rgba(88, 166, 255, ${0.3 * intensity})`);
    grad.addColorStop(1, 'rgba(88, 166, 255, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, barHeight);

    if (intensity > 0.3) {
      ctx.font = '11px -apple-system, sans-serif';
      ctx.fillStyle = `rgba(88, 166, 255, ${0.6 * intensity})`;
      ctx.textAlign = 'center';
      ctx.fillText('Browser UI gaze detected', w / 2, 14);
      ctx.textAlign = 'start';
    }
  }

  /* ========== SCANPATH RENDERING ========== */
  function renderScanpath() {
    const canvas = document.getElementById('eyed-scanpath-canvas');
    if (!canvas || !state.showScanpath) return;

    const ctx = canvas.getContext('2d');
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    ctx.clearRect(0, 0, vw, vh);

    // Run fixation detection
    if (state.analyticsDirty && typeof EyedAnalytics !== 'undefined') {
      state.fixations = EyedAnalytics.detectFixations(state.gazePoints.filter(p => !p.isBrowserUI), vw, vh);
      state.scanpath = EyedAnalytics.buildScanpath(state.fixations);
      state.analyticsDirty = false;
    }

    if (!state.scanpath || state.scanpath.fixations.length === 0) return;

    const { fixations, saccades } = state.scanpath;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;

    // Saccade lines (use page coordinates adjusted to viewport)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);

    for (const s of saccades) {
      const fx = (s.fromPageX != null ? s.fromPageX - scrollX : s.fromX * vw);
      const fy = (s.fromPageY != null ? s.fromPageY - scrollY : s.fromY * vh);
      const tx = (s.toPageX != null ? s.toPageX - scrollX : s.toX * vw);
      const ty = (s.toPageY != null ? s.toPageY - scrollY : s.toY * vh);

      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.lineTo(tx, ty);
      ctx.stroke();

      // Arrowhead
      const angle = Math.atan2(ty - fy, tx - fx);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx - 7 * Math.cos(angle - 0.4), ty - 7 * Math.sin(angle - 0.4));
      ctx.lineTo(tx - 7 * Math.cos(angle + 0.4), ty - 7 * Math.sin(angle + 0.4));
      ctx.closePath();
      ctx.fill();
    }
    ctx.setLineDash([]);

    // Fixation circles (use page coordinates adjusted to viewport)
    for (const fix of fixations) {
      const px = (fix.pageCx != null ? fix.pageCx - scrollX : fix.cx * vw);
      const py = (fix.pageCy != null ? fix.pageCy - scrollY : fix.cy * vh);
      const r = Math.max(8, Math.min(28, fix.duration / 20));

      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(88, 166, 255, 0.25)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(88, 166, 255, 0.8)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Number badge
      ctx.beginPath();
      ctx.arc(px, py, 9, 0, Math.PI * 2);
      ctx.fillStyle = '#1f6feb';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.font = 'bold 8px -apple-system, sans-serif';
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(fix.index), px, py);
    }
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  /* ========== RENDER LOOP ========== */
  let renderQueued = false;

  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (state.showHeatmap && state.heatmapDirty) {
        renderHeatmap();
        state.heatmapDirty = false;
      }
      if (state.showScanpath) {
        renderScanpath();
      }
    });
  }

  setInterval(() => {
    if ((state.showHeatmap && state.heatmapDirty) || state.showScanpath) {
      queueRender();
    }
  }, 500);

  /* ========== SCREENSHOT HANDLING ========== */
  async function handleScreenshotRequest(msg, sendResponse) {
    if (typeof EyedScreenshot === 'undefined') {
      sendResponse({ error: 'Screenshot module not loaded' });
      return;
    }

    // Run analytics if needed
    if (state.analyticsDirty && typeof EyedAnalytics !== 'undefined') {
      const w = window.innerWidth;
      const h = window.innerHeight;
      state.fixations = EyedAnalytics.detectFixations(state.gazePoints.filter(p => !p.isBrowserUI), w, h);
      state.scanpath = EyedAnalytics.buildScanpath(state.fixations);
      const aois = EyedAnalytics.detectAOIs();
      state.aoiResults = EyedAnalytics.analyzeAOIs(state.fixations, aois, w, h);
      state.analyticsDirty = false;
    }

    const options = {
      gazePoints: state.gazePoints,
      mousePoints: state.mousePoints,
      touchPoints: state.touchPoints,
      firstViewedPoints: state.firstViewedPoints,
      fixations: state.fixations,
      scanpath: state.scanpath,
      aois: state.aoiResults || [],
      includeHeatmap: msg.includeHeatmap !== false,
      includeScanpath: msg.includeScanpath !== false,
      includeFirstViewed: msg.includeFirstViewed !== false,
      includeAOI: msg.includeAOI || false,
    };

    try {
      let dataUrl;
      if (msg.fullPage) {
        dataUrl = await EyedScreenshot.captureFullPage({
          ...options,
          onProgress: (pct) => {
            chrome.runtime.sendMessage({ type: 'SCREENSHOT_PROGRESS', progress: pct }).catch(() => {});
          },
        });
      } else {
        dataUrl = await EyedScreenshot.captureViewport(options);
      }

      if (dataUrl) {
        if (msg.download) {
          const filename = `eyed-${msg.fullPage ? 'fullpage' : 'viewport'}-${Date.now()}.png`;
          EyedScreenshot.downloadDataUrl(dataUrl, filename);
        }
        sendResponse({ dataUrl });
      } else {
        sendResponse({ error: 'Capture failed' });
      }
    } catch (err) {
      sendResponse({ error: err.message });
    }
  }

  /* ========== MESSAGE HANDLING ========== */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'GAZE_POINT':
        handleGazePoint(msg);
        break;

      case 'TRACKING_STATE':
        state.trackingActive = msg.active;
        document.getElementById('eyed-tracking-indicator')?.classList.toggle('active', msg.active);
        document.getElementById('eyed-gaze-cursor')?.classList.toggle('active', msg.active && state.showCursor);
        break;

      case 'RECORDING_STATE':
        state.recordingActive = msg.active;
        if (msg.active) {
          startEventFlushTimer();
          if (isChannelEnabled('autoScreenshots')) startAutoScreenshots();
          // Auto-screenshot on page load
          if (isChannelEnabled('screenshotOnLoad')) {
            setTimeout(() => captureAutoScreenshot('pageLoad'), 2000);
          }
        } else {
          stopEventFlushTimer();
          stopAutoScreenshots();
        }
        // Update recording indicator
        document.getElementById('eyed-tracking-indicator')?.classList.toggle('recording', msg.active);
        break;

      case 'SETTINGS_UPDATED':
        state.settings = msg.settings;
        break;

      case 'NEW_PAGE_LOADED':
        state.isNewPage = true;
        state.pageLoadTime = msg.timestamp;
        state.firstViewedElements = [];
        state.firstViewedPoints = [];
        break;

      case 'TOGGLE_HEATMAP':
        state.showHeatmap = !state.showHeatmap;
        document.getElementById('eyed-heatmap-canvas')?.classList.toggle('hidden', !state.showHeatmap);
        if (state.showHeatmap) { state.heatmapDirty = true; queueRender(); }
        sendResponse({ visible: state.showHeatmap });
        return true;

      case 'TOGGLE_SCANPATH':
        state.showScanpath = !state.showScanpath;
        document.getElementById('eyed-scanpath-canvas')?.classList.toggle('hidden', !state.showScanpath);
        if (state.showScanpath) { state.analyticsDirty = true; queueRender(); }
        sendResponse({ visible: state.showScanpath });
        return true;

      case 'SHOW_HEATMAP':
        state.showHeatmap = true;
        document.getElementById('eyed-heatmap-canvas')?.classList.remove('hidden');
        state.heatmapDirty = true;
        queueRender();
        break;

      case 'HIDE_HEATMAP':
        state.showHeatmap = false;
        document.getElementById('eyed-heatmap-canvas')?.classList.add('hidden');
        break;

      case 'TOGGLE_CURSOR':
        state.showCursor = !state.showCursor;
        document.getElementById('eyed-gaze-cursor')?.classList.toggle('active', state.showCursor && state.trackingActive);
        sendResponse({ visible: state.showCursor });
        return true;

      case 'CAPTURE_VIEWPORT_SCREENSHOT':
        handleScreenshotRequest({ ...msg, fullPage: false }, sendResponse)
          .catch(e => { try { sendResponse({ error: e.message }); } catch (_) {} });
        return true;

      case 'CAPTURE_FULLPAGE_SCREENSHOT':
        handleScreenshotRequest({ ...msg, fullPage: true }, sendResponse)
          .catch(e => { try { sendResponse({ error: e.message }); } catch (_) {} });
        return true;

      case 'CAPTURE_HEATMAP_SCREENSHOT':
        handleScreenshotRequest({ fullPage: false, download: false }, sendResponse)
          .catch(e => { try { sendResponse({ error: e.message }); } catch (_) {} });
        return true;

      case 'GET_CONTENT_STATE':
        sendResponse({
          trackingActive: state.trackingActive,
          showHeatmap: state.showHeatmap,
          showScanpath: state.showScanpath,
          gazePointCount: state.gazePoints.length,
          mousePointCount: state.mousePoints.length,
          touchPointCount: state.touchPoints.length,
          firstViewedCount: state.firstViewedPoints.length,
          fixationCount: state.fixations.length,
          hasVideoData: state.gazePoints.some(p => p.videoTime != null),
          videos: typeof EyedVideoTracker !== 'undefined' ? EyedVideoTracker.getTrackedVideos() : [],
        });
        return true;

      case 'GET_ANALYTICS':
        if (state.analyticsDirty && typeof EyedAnalytics !== 'undefined') {
          const w = window.innerWidth;
          const h = window.innerHeight;
          state.fixations = EyedAnalytics.detectFixations(state.gazePoints.filter(p => !p.isBrowserUI), w, h);
          state.scanpath = EyedAnalytics.buildScanpath(state.fixations);
          const aois = EyedAnalytics.detectAOIs();
          state.aoiResults = EyedAnalytics.analyzeAOIs(state.fixations, aois, w, h);
          const sessionDuration = state.gazePoints.length > 1
            ? state.gazePoints[state.gazePoints.length - 1].timestamp - state.gazePoints[0].timestamp
            : 0;
          state.engagement = EyedAnalytics.computeEngagement(state.gazePoints, state.fixations, state.aoiResults, sessionDuration);
          state.analyticsDirty = false;
        }

        sendResponse({
          fixations: state.fixations?.map(f => ({ ...f, points: undefined })),
          scanpath: state.scanpath,
          aois: state.aoiResults?.map(a => ({ ...a, element: undefined })),
          engagement: state.engagement,
          foldAnalysis: typeof EyedAnalytics !== 'undefined'
            ? EyedAnalytics.analyzeFoldAttention(state.fixations || [], window.innerHeight)
            : null,
        });
        return true;

      case 'GET_VIDEO_TIMELINE':
        if (typeof EyedVideoTracker !== 'undefined') {
          const videoPts = state.gazePoints.filter(p => p.videoTime != null);
          const maxDuration = videoPts.length > 0 ? Math.max(...videoPts.map(p => p.videoDuration || 0)) : 0;
          sendResponse({
            timeline: EyedVideoTracker.generateVideoAttentionTimeline(videoPts, maxDuration, msg.bucketSize || 2),
            buckets: EyedVideoTracker.bucketByVideoTime(videoPts, msg.bucketSize || 5),
            totalPoints: videoPts.length,
            videoDuration: maxDuration,
          });
        } else {
          sendResponse({ timeline: [], buckets: [], totalPoints: 0 });
        }
        return true;

      case 'FILTER_VIDEO_TIME':
        if (typeof EyedVideoTracker !== 'undefined') {
          const filtered = EyedVideoTracker.filterByVideoTime(
            state.gazePoints, msg.startTime, msg.endTime
          );
          sendResponse({ points: filtered, count: filtered.length });
        } else {
          sendResponse({ points: [], count: 0 });
        }
        return true;

      case 'TOGGLE_REPLAY':
        toggleReplay();
        sendResponse({ ok: true });
        return true;

      case 'CLEAR_LOCAL_DATA':
        state.gazePoints = [];
        state.touchPoints = [];
        state.mousePoints = [];
        state.firstViewedPoints = [];
        state.firstViewedElements = [];
        state.fixations = [];
        state.scanpath = null;
        state._gazeNonUI = null;
        state._gazeNonUIDirty = true;
        state.heatmapDirty = true;
        state.analyticsDirty = true;
        stopReplay();
        if (state.showHeatmap) queueRender();
        sendResponse({ ok: true });
        return true;
    }
  });

  /* ========== EVENT BUFFERING FOR CENTRALIZED UPLOAD ========== */
  const MAX_EVENT_BUFFER = 500;

  function bufferEvent(event) {
    if (!state.recordingActive) return;
    state.eventBuffer.push(event);

    // Enforce max buffer size
    if (state.eventBuffer.length > MAX_EVENT_BUFFER) {
      state.eventBuffer = state.eventBuffer.slice(-Math.floor(MAX_EVENT_BUFFER * 0.75));
    }

    // Flush when buffer is large enough
    if (state.eventBuffer.length >= 50) {
      flushEventBuffer();
    }
  }

  function flushEventBuffer() {
    if (state.eventBuffer.length === 0) return;
    const events = state.eventBuffer.splice(0, state.eventBuffer.length);
    chrome.runtime.sendMessage({ type: 'CONTENT_EVENTS', events }).catch(() => {
      // On failure, restore events but cap buffer to prevent unbounded growth
      state.eventBuffer.unshift(...events);
      if (state.eventBuffer.length > MAX_EVENT_BUFFER) {
        state.eventBuffer = state.eventBuffer.slice(-Math.floor(MAX_EVENT_BUFFER * 0.75));
      }
    });
  }

  function startEventFlushTimer() {
    if (state.eventFlushTimer) return;
    state.eventFlushTimer = setInterval(flushEventBuffer, 5000);
  }

  function stopEventFlushTimer() {
    if (state.eventFlushTimer) { clearInterval(state.eventFlushTimer); state.eventFlushTimer = null; }
    flushEventBuffer();
  }

  // Flush remaining events on page unload to minimize data loss
  window.addEventListener('beforeunload', () => {
    if (state.recordingActive && state.eventBuffer.length > 0) {
      flushEventBuffer();
    }
    // Clean up replay animation frame to prevent leak
    if (replay.animFrame) {
      cancelAnimationFrame(replay.animFrame);
      replay.animFrame = null;
    }
    replay.playing = false;
  });

  function isChannelEnabled(channel) {
    if (!state.settings?.channels) return true;
    return state.settings.channels[channel] !== false;
  }

  // Sensitive input types where we never capture any metadata text
  const SENSITIVE_INPUT_TYPES = new Set(['password', 'email', 'tel', 'ssn', 'credit-card']);

  function getElementMeta(el) {
    if (!el || !el.tagName) return null;
    if (state.settings?.liteMode) return null;

    const tag = el.tagName;
    const meta = {
      tag,
      id: el.id || undefined,
      selector: el.id ? `#${el.id}` : `${tag.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`,
    };

    // Never capture text content from sensitive fields
    const isSensitive = (tag === 'INPUT' && SENSITIVE_INPUT_TYPES.has(el.type)) ||
      tag === 'TEXTAREA' || tag === 'SELECT' ||
      el.closest('[type="password"], [autocomplete*="cc-"], [autocomplete*="ssn"]');

    if (!isSensitive) {
      const text = (el.textContent || '').substring(0, 40).trim();
      if (text) meta.text = text;
    }

    // Sanitize href — strip query params for privacy
    const rawHref = el.href || el.closest('a')?.href;
    if (rawHref) {
      try {
        const u = new URL(rawHref);
        u.search = '';
        u.hash = '';
        meta.href = u.toString();
      } catch { /* skip invalid URLs */ }
    }

    return meta;
  }

  /* ========== NEW DATA CHANNEL: CLICKS ========== */
  function initClickTracking() {
    document.addEventListener('click', (e) => {
      if (!state.recordingActive || !isChannelEnabled('clicks')) return;

      const now = Date.now();
      const x = e.clientX;
      const y = e.clientY;
      const el = e.target;

      const clickEvent = {
        type: 'click',
        x: x / window.innerWidth,
        y: y / window.innerHeight,
        pageX: x + window.scrollX,
        pageY: y + window.scrollY,
        timestamp: now,
        button: e.button,
        element: getElementMeta(el),
      };

      bufferEvent(clickEvent);

      // Track for rage/dead click detection
      state.recentClicks.push({ x, y, timestamp: now, target: el });
      if (state.recentClicks.length > 10) state.recentClicks.shift();

      // Rage click detection: 3+ clicks within 50px and 2s
      if (isChannelEnabled('rageClicks')) {
        const recent = state.recentClicks.filter(c => now - c.timestamp < 2000);
        const nearby = recent.filter(c => Math.abs(c.x - x) < 50 && Math.abs(c.y - y) < 50);
        if (nearby.length >= 3) {
          bufferEvent({
            type: 'rageClick',
            x: x / window.innerWidth,
            y: y / window.innerHeight,
            pageX: x + window.scrollX,
            pageY: y + window.scrollY,
            timestamp: now,
            clickCount: nearby.length,
            element: getElementMeta(el),
          });
        }
      }

      // Dead click detection: click that doesn't cause navigation or visible change
      if (isChannelEnabled('deadClicks')) {
        const isInteractive = el.tagName === 'A' || el.tagName === 'BUTTON' || el.tagName === 'INPUT' ||
          el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' ||
          el.closest('a') || el.closest('button') || el.getAttribute('role') === 'button' ||
          el.onclick || el.style.cursor === 'pointer';

        if (!isInteractive) {
          bufferEvent({
            type: 'deadClick',
            x: x / window.innerWidth,
            y: y / window.innerHeight,
            pageX: x + window.scrollX,
            pageY: y + window.scrollY,
            timestamp: now,
            element: getElementMeta(el),
          });
        }
      }
    }, true);
  }

  /* ========== NEW DATA CHANNEL: HOVER DWELL ========== */
  function initHoverTracking() {
    document.addEventListener('mouseover', (e) => {
      if (!state.recordingActive || !isChannelEnabled('hovers')) return;

      const el = e.target;
      if (el === state.hoverTarget) return;

      // End previous hover
      endCurrentHover();

      state.hoverTarget = el;
      state.hoverStartTime = Date.now();
    }, { passive: true });

    document.addEventListener('mouseout', (e) => {
      if (e.target === state.hoverTarget) {
        endCurrentHover();
      }
    }, { passive: true });
  }

  function endCurrentHover() {
    if (!state.hoverTarget || !state.hoverStartTime) return;
    const dwellTime = Date.now() - state.hoverStartTime;

    // Only record hovers > 300ms (ignore pass-throughs)
    if (dwellTime > 300 && state.recordingActive && isChannelEnabled('hovers')) {
      const rect = state.hoverTarget.getBoundingClientRect();
      bufferEvent({
        type: 'hover',
        timestamp: state.hoverStartTime,
        dwellTime,
        x: (rect.left + rect.width / 2) / window.innerWidth,
        y: (rect.top + rect.height / 2) / window.innerHeight,
        element: getElementMeta(state.hoverTarget),
      });
    }

    state.hoverTarget = null;
    state.hoverStartTime = 0;
  }

  /* ========== NEW DATA CHANNEL: SCROLL DEPTH & VELOCITY ========== */
  function initScrollDepthTracking() {
    let lastScrollY = window.scrollY;
    let lastScrollTime = Date.now();

    document.addEventListener('scroll', () => {
      if (!state.recordingActive) return;

      const now = Date.now();
      const scrollY = window.scrollY;
      const pageHeight = document.documentElement.scrollHeight;
      const viewHeight = window.innerHeight;
      const maxScroll = pageHeight - viewHeight;

      if (maxScroll <= 0) return;

      const depth = Math.min(100, ((scrollY + viewHeight) / pageHeight) * 100);

      // Track max scroll depth
      if (depth > state.maxScrollDepth) {
        state.maxScrollDepth = depth;
      }

      // Scroll depth milestones
      if (isChannelEnabled('scrollDepth')) {
        for (const milestone of [25, 50, 75, 100]) {
          if (!state.scrollMilestones[milestone] && depth >= milestone) {
            state.scrollMilestones[milestone] = true;
            bufferEvent({
              type: 'scrollMilestone',
              milestone,
              timestamp: now,
              scrollY,
              pageHeight,
              viewHeight,
            });

            // Auto-screenshot on scroll milestone
            if (isChannelEnabled('screenshotOnScroll')) {
              captureAutoScreenshot('scrollMilestone_' + milestone);
            }
          }
        }
      }

      // Scroll velocity (throttled)
      if (isChannelEnabled('scroll') && now - lastScrollTime > 200) {
        const deltaY = scrollY - lastScrollY;
        const deltaTime = (now - lastScrollTime) / 1000;
        const velocity = deltaTime > 0 ? deltaY / deltaTime : 0;

        bufferEvent({
          type: 'scroll',
          scrollY,
          scrollX: window.scrollX,
          depth: Math.round(depth),
          velocity: Math.round(velocity),
          direction: deltaY > 0 ? 'down' : deltaY < 0 ? 'up' : 'none',
          pageHeight,
          viewHeight,
          timestamp: now,
        });

        lastScrollY = scrollY;
        lastScrollTime = now;
      }
    }, { passive: true });
  }

  /* ========== NEW DATA CHANNEL: TAB FOCUS / PAGE VISIBILITY ========== */
  function initVisibilityTracking() {
    if (!isChannelEnabled('visibility')) return;

    window.addEventListener('focus', () => {
      if (!state.recordingActive) return;
      bufferEvent({ type: 'tabFocus', timestamp: Date.now(), visible: true });
    });

    window.addEventListener('blur', () => {
      if (!state.recordingActive) return;
      endCurrentHover(); // End hover on blur
      bufferEvent({ type: 'tabBlur', timestamp: Date.now(), visible: false });
    });

    document.addEventListener('visibilitychange', () => {
      if (!state.recordingActive) return;
      bufferEvent({
        type: 'visibilityChange',
        timestamp: Date.now(),
        hidden: document.hidden,
        visibilityState: document.visibilityState,
      });
    });
  }

  /* ========== NEW DATA CHANNEL: ELEMENT VISIBILITY (Intersection Observer) ========== */
  let visibilityObserver = null;

  function initElementVisibilityTracking() {
    if (!isChannelEnabled('elementVisibility')) return;

    const observedEntries = new Map(); // selector -> { visible, timestamp }

    visibilityObserver = new IntersectionObserver((entries) => {
      if (!state.recordingActive) return;

      for (const entry of entries) {
        const el = entry.target;
        const selector = el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}`;

        const wasVisible = observedEntries.get(selector)?.visible || false;
        const isVisible = entry.isIntersecting;

        if (isVisible !== wasVisible) {
          observedEntries.set(selector, { visible: isVisible, timestamp: Date.now() });
          bufferEvent({
            type: 'elementVisibility',
            timestamp: Date.now(),
            visible: isVisible,
            ratio: Math.round(entry.intersectionRatio * 100) / 100,
            element: getElementMeta(el),
          });
        }
      }
    }, { threshold: [0, 0.25, 0.5, 0.75, 1.0] });

    // Observe key semantic elements (cap at 50 to prevent performance issues)
    const selectors = 'h1, h2, h3, nav, header, footer, main, article, section, form, [role="banner"], [role="navigation"], [role="main"], img[alt], video';
    const elements = document.querySelectorAll(selectors);
    const maxObserve = Math.min(elements.length, 50);
    for (let i = 0; i < maxObserve; i++) {
      visibilityObserver.observe(elements[i]);
    }

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
      if (visibilityObserver) { visibilityObserver.disconnect(); visibilityObserver = null; }
    });
  }

  /* ========== NEW DATA CHANNEL: FORM FOCUS/BLUR ========== */
  function initFormTracking() {
    if (!isChannelEnabled('formFocus')) return;

    // Track active field for time-in-field calculation
    const formState = {
      activeField: null,
      focusTime: 0,
      initialValue: '',
      interactionCount: 0,
    };

    document.addEventListener('focusin', (e) => {
      if (!state.recordingActive) return;
      const el = e.target;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
        formState.activeField = el;
        formState.focusTime = Date.now();
        formState.initialValue = el.value || '';
        formState.interactionCount = 0;

        bufferEvent({
          type: 'formFocus',
          timestamp: formState.focusTime,
          fieldType: el.type || el.tagName.toLowerCase(),
          required: el.required || false,
          element: getElementMeta(el),
        });
      }
    }, { passive: true });

    document.addEventListener('focusout', (e) => {
      if (!state.recordingActive) return;
      const el = e.target;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
        const now = Date.now();
        const dwellTime = formState.focusTime > 0 ? now - formState.focusTime : 0;
        const valueChanged = el.value !== formState.initialValue;
        const isEmpty = !el.value || el.value.trim() === '';
        const isSensitive = SENSITIVE_INPUT_TYPES.has(el.type);

        bufferEvent({
          type: 'formBlur',
          timestamp: now,
          fieldType: el.type || el.tagName.toLowerCase(),
          dwellTime,
          valueChanged,
          abandoned: !valueChanged && isEmpty && el.required,
          interactionCount: formState.interactionCount,
          valueLength: isSensitive ? 0 : (el.value || '').length,
          required: el.required || false,
          element: getElementMeta(el),
        });

        formState.activeField = null;
        formState.focusTime = 0;
      }
    }, { passive: true });

    // Track keystrokes in form fields (count only, not content)
    document.addEventListener('input', (e) => {
      if (!state.recordingActive) return;
      if (formState.activeField === e.target) {
        formState.interactionCount++;
      }
    }, { passive: true });

    // Track form submissions
    document.addEventListener('submit', (e) => {
      if (!state.recordingActive) return;
      const form = e.target;
      if (form.tagName !== 'FORM') return;

      const inputs = form.querySelectorAll('input, textarea, select');
      let filledCount = 0;
      let emptyRequired = 0;
      for (const inp of inputs) {
        if (inp.value && inp.value.trim()) filledCount++;
        else if (inp.required) emptyRequired++;
      }

      bufferEvent({
        type: 'formSubmit',
        timestamp: Date.now(),
        totalFields: inputs.length,
        filledFields: filledCount,
        emptyRequired,
        element: getElementMeta(form),
      });
    }, { passive: true });

    // Track form validation errors (invalid event fires on constraint violation)
    document.addEventListener('invalid', (e) => {
      if (!state.recordingActive) return;
      const el = e.target;
      bufferEvent({
        type: 'formError',
        timestamp: Date.now(),
        fieldType: el.type || el.tagName.toLowerCase(),
        validationMessage: (el.validationMessage || '').substring(0, 100),
        element: getElementMeta(el),
      });
    }, true); // Must use capture phase for invalid event
  }

  /* ========== NEW DATA CHANNEL: TEXT SELECTION ========== */
  function initTextSelectionTracking() {
    if (!isChannelEnabled('textSelection')) return;

    document.addEventListener('selectionchange', (() => {
      let throttle = 0;
      return () => {
        if (!state.recordingActive) return;
        const now = Date.now();
        if (now - throttle < 500) return;
        throttle = now;

        const sel = document.getSelection();
        if (!sel || sel.isCollapsed) return;

        const text = sel.toString();
        if (text.length < 2) return;

        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();

        bufferEvent({
          type: 'textSelection',
          timestamp: now,
          length: text.length,
          x: (rect.left + rect.width / 2) / window.innerWidth,
          y: (rect.top + rect.height / 2) / window.innerHeight,
          element: getElementMeta(sel.anchorNode?.parentElement),
        });
      };
    })());
  }

  /* ========== NEW DATA CHANNEL: NAVIGATION ========== */
  function initNavigationTracking() {
    if (!isChannelEnabled('navigation')) return;

    // Link clicks
    document.addEventListener('click', (e) => {
      if (!state.recordingActive) return;
      const link = e.target.closest('a[href]');
      if (!link) return;

      // Sanitize link URL — strip query params to avoid leaking tokens/PII
      let sanitizedHref = '';
      try {
        const u = new URL(link.href);
        u.search = '';
        u.hash = '';
        sanitizedHref = u.toString();
      } catch { sanitizedHref = ''; }

      bufferEvent({
        type: 'navigation',
        timestamp: Date.now(),
        action: 'linkClick',
        href: sanitizedHref,
        text: (link.textContent || '').substring(0, 40).trim(),
        newTab: link.target === '_blank',
      });
    }, { passive: true });

    // Back/forward detection
    window.addEventListener('popstate', () => {
      if (!state.recordingActive) return;
      let sanitizedUrl = '';
      try {
        const u = new URL(window.location.href);
        u.search = '';
        u.hash = '';
        sanitizedUrl = u.toString();
      } catch { /* skip */ }
      bufferEvent({
        type: 'navigation',
        timestamp: Date.now(),
        action: 'popstate',
        url: sanitizedUrl,
      });
    });

    // SPA navigation detection — intercept pushState/replaceState
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (...args) {
      originalPushState.apply(this, args);
      if (state.recordingActive) {
        let sanitizedUrl = '';
        try {
          const u = new URL(window.location.href);
          u.search = '';
          u.hash = '';
          sanitizedUrl = u.toString();
        } catch { /* skip */ }
        bufferEvent({
          type: 'navigation',
          timestamp: Date.now(),
          action: 'pushState',
          url: sanitizedUrl,
        });
      }
    };

    history.replaceState = function (...args) {
      originalReplaceState.apply(this, args);
      if (state.recordingActive) {
        let sanitizedUrl = '';
        try {
          const u = new URL(window.location.href);
          u.search = '';
          u.hash = '';
          sanitizedUrl = u.toString();
        } catch { /* skip */ }
        bufferEvent({
          type: 'navigation',
          timestamp: Date.now(),
          action: 'replaceState',
          url: sanitizedUrl,
        });
      }
    };
  }

  /* ========== WEB VITALS ========== */
  function initWebVitals() {
    // Use PerformanceObserver API to capture Core Web Vitals
    try {
      // First Contentful Paint (FCP)
      const fcpObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name === 'first-contentful-paint') {
            bufferEvent({
              type: 'webVital',
              timestamp: Date.now(),
              metric: 'FCP',
              value: Math.round(entry.startTime),
              rating: entry.startTime <= 1800 ? 'good' : entry.startTime <= 3000 ? 'needs-improvement' : 'poor',
            });
            fcpObserver.disconnect();
          }
        }
      });
      fcpObserver.observe({ type: 'paint', buffered: true });

      // Largest Contentful Paint (LCP)
      const lcpObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1];
        if (last) {
          bufferEvent({
            type: 'webVital',
            timestamp: Date.now(),
            metric: 'LCP',
            value: Math.round(last.startTime),
            rating: last.startTime <= 2500 ? 'good' : last.startTime <= 4000 ? 'needs-improvement' : 'poor',
            element: last.element ? getElementMeta(last.element) : null,
          });
        }
      });
      lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
      // Stop observing LCP on first input or visibilitychange
      const stopLcp = () => { lcpObserver.disconnect(); };
      document.addEventListener('keydown', stopLcp, { once: true, passive: true });
      document.addEventListener('click', stopLcp, { once: true, passive: true });
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) stopLcp();
      }, { once: true });

      // Cumulative Layout Shift (CLS)
      let clsValue = 0;
      const clsObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) {
            clsValue += entry.value;
          }
        }
      });
      clsObserver.observe({ type: 'layout-shift', buffered: true });
      // Report CLS on page unload
      window.addEventListener('beforeunload', () => {
        if (clsValue > 0) {
          bufferEvent({
            type: 'webVital',
            timestamp: Date.now(),
            metric: 'CLS',
            value: Math.round(clsValue * 1000) / 1000,
            rating: clsValue <= 0.1 ? 'good' : clsValue <= 0.25 ? 'needs-improvement' : 'poor',
          });
          flushEventBuffer();
        }
        clsObserver.disconnect();
      });

      // First Input Delay (FID) / Interaction to Next Paint (INP)
      const fidObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.processingStart) {
            const delay = entry.processingStart - entry.startTime;
            bufferEvent({
              type: 'webVital',
              timestamp: Date.now(),
              metric: 'FID',
              value: Math.round(delay),
              rating: delay <= 100 ? 'good' : delay <= 300 ? 'needs-improvement' : 'poor',
            });
            fidObserver.disconnect();
            break;
          }
        }
      });
      fidObserver.observe({ type: 'first-input', buffered: true });

      // Navigation timing (page load)
      setTimeout(() => {
        const nav = performance.getEntriesByType('navigation')[0];
        if (nav) {
          bufferEvent({
            type: 'pagePerformance',
            timestamp: Date.now(),
            domReady: Math.round(nav.domContentLoadedEventEnd),
            loadComplete: Math.round(nav.loadEventEnd),
            ttfb: Math.round(nav.responseStart),
            domInteractive: Math.round(nav.domInteractive),
            transferSize: nav.transferSize || 0,
          });
        }
      }, 3000);
    } catch { /* PerformanceObserver not available */ }
  }

  /* ========== AUTO-SCREENSHOT SYSTEM ========== */
  let screenshotInProgress = false;

  function captureAutoScreenshot(trigger) {
    if (!state.recordingActive || !isChannelEnabled('autoScreenshots')) return;
    if (screenshotInProgress) return;

    const now = Date.now();
    // Debounce: min 5s between auto-screenshots
    if (now - state.lastAutoScreenshotTime < 5000) return;
    state.lastAutoScreenshotTime = now;
    screenshotInProgress = true;

    // Capture using the background screenshot mechanism
    chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' }, (response) => {
      if (chrome.runtime.lastError || !response?.dataUrl) {
        screenshotInProgress = false;
        return;
      }

      // Resize for upload
      const maxWidth = state.settings?.screenshotMaxWidth || 1280;
      const quality = (state.settings?.screenshotQuality || 70) / 100;

      const img = new Image();
      img.onload = () => {
        const scale = img.width > maxWidth ? maxWidth / img.width : 1;
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);

        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);

        const compressed = c.toDataURL('image/jpeg', quality);

        chrome.runtime.sendMessage({
          type: 'AUTO_SCREENSHOT',
          timestamp: now,
          trigger,
          dataUrl: compressed,
          width: w,
          height: h,
        }).catch(() => {}).finally(() => { screenshotInProgress = false; });
      };
      img.onerror = () => { screenshotInProgress = false; };
      img.src = response.dataUrl;
    });
  }

  function startAutoScreenshots() {
    const interval = (state.settings?.screenshotInterval || 30) * 1000;
    stopAutoScreenshots();
    state.autoScreenshotTimer = setInterval(() => {
      if (!document.hidden) {
        captureAutoScreenshot('periodic');
      }
    }, interval);
  }

  function stopAutoScreenshots() {
    if (state.autoScreenshotTimer) {
      clearInterval(state.autoScreenshotTimer);
      state.autoScreenshotTimer = null;
    }
  }

  /* ========== GAZE REPLAY / PLAYBACK ========== */
  const replay = {
    active: false,
    playing: false,
    index: 0,
    speed: 1,
    animFrame: null,
    startTime: 0,
    bar: null,
    cursor: null,
  };

  function createReplayUI() {
    if (document.getElementById('eyed-replay-bar')) return;

    const bar = document.createElement('div');
    bar.id = 'eyed-replay-bar';
    bar.innerHTML = `
      <button id="eyed-replay-play" class="eyed-replay-btn">Play</button>
      <input type="range" id="eyed-replay-scrubber" min="0" max="100" value="0" step="0.1">
      <span id="eyed-replay-time">0:00 / 0:00</span>
      <select id="eyed-replay-speed">
        <option value="0.5">0.5x</option>
        <option value="1" selected>1x</option>
        <option value="2">2x</option>
        <option value="4">4x</option>
      </select>
      <button id="eyed-replay-close" class="eyed-replay-btn">✕</button>
    `;
    document.documentElement.appendChild(bar);

    const cursor = document.createElement('div');
    cursor.id = 'eyed-replay-cursor';
    document.documentElement.appendChild(cursor);

    replay.bar = bar;
    replay.cursor = cursor;

    document.getElementById('eyed-replay-play').addEventListener('click', toggleReplayPlayback);
    document.getElementById('eyed-replay-close').addEventListener('click', stopReplay);
    document.getElementById('eyed-replay-speed').addEventListener('change', (e) => {
      replay.speed = parseFloat(e.target.value);
    });
    document.getElementById('eyed-replay-scrubber').addEventListener('input', (e) => {
      const pts = getReplayPoints();
      if (pts.length === 0) return;
      replay.index = Math.floor((parseFloat(e.target.value) / 100) * (pts.length - 1));
      updateReplayPosition();
    });
  }

  function getReplayPoints() {
    return state.gazePoints.filter(p => !p.isBrowserUI);
  }

  function toggleReplay() {
    if (replay.active) {
      stopReplay();
    } else {
      startReplay();
    }
  }

  function startReplay() {
    const pts = getReplayPoints();
    if (pts.length < 2) return;

    replay.active = true;
    replay.index = 0;
    replay.playing = false;
    createReplayUI();
    replay.bar.style.display = 'flex';
    replay.cursor.style.display = 'block';
    updateReplayPosition();
  }

  function stopReplay() {
    replay.active = false;
    replay.playing = false;
    if (replay.animFrame) { cancelAnimationFrame(replay.animFrame); replay.animFrame = null; }
    if (replay.bar) replay.bar.style.display = 'none';
    if (replay.cursor) replay.cursor.style.display = 'none';
  }

  function toggleReplayPlayback() {
    if (replay.playing) {
      replay.playing = false;
      if (replay.animFrame) { cancelAnimationFrame(replay.animFrame); replay.animFrame = null; }
      document.getElementById('eyed-replay-play').textContent = 'Play';
    } else {
      replay.playing = true;
      replay.startTime = performance.now();
      document.getElementById('eyed-replay-play').textContent = 'Pause';
      animateReplay();
    }
  }

  function animateReplay() {
    if (!replay.playing || !replay.active) return;

    const pts = getReplayPoints();
    if (replay.index >= pts.length - 1) {
      replay.playing = false;
      document.getElementById('eyed-replay-play').textContent = 'Play';
      return;
    }

    const current = pts[replay.index];
    const next = pts[replay.index + 1];
    const timeDiff = (next.timestamp - current.timestamp) / replay.speed;
    const elapsed = performance.now() - replay.startTime;

    if (elapsed >= timeDiff) {
      replay.index++;
      replay.startTime = performance.now();
      updateReplayPosition();
    }

    replay.animFrame = requestAnimationFrame(animateReplay);
  }

  function updateReplayPosition() {
    const pts = getReplayPoints();
    if (pts.length === 0 || replay.index >= pts.length) return;

    const point = pts[replay.index];
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const px = point.pageX != null ? point.pageX - window.scrollX : point.x * vw;
    const py = point.pageY != null ? point.pageY - window.scrollY : point.y * vh;

    if (replay.cursor) {
      replay.cursor.style.left = px + 'px';
      replay.cursor.style.top = py + 'px';
    }

    // Update scrubber
    const scrubber = document.getElementById('eyed-replay-scrubber');
    if (scrubber) scrubber.value = (replay.index / (pts.length - 1)) * 100;

    // Update time display
    const timeLabel = document.getElementById('eyed-replay-time');
    if (timeLabel && pts.length > 1) {
      const elapsed = (point.timestamp - pts[0].timestamp) / 1000;
      const total = (pts[pts.length - 1].timestamp - pts[0].timestamp) / 1000;
      timeLabel.textContent = `${formatTime(elapsed)} / ${formatTime(total)}`;
    }
  }

  function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  /* ========== INIT ========== */
  function init() {
    createOverlayElements();
    initInputTracking();

    // New data channels
    initClickTracking();
    initHoverTracking();
    initScrollDepthTracking();
    initVisibilityTracking();
    initFormTracking();
    initTextSelectionTracking();
    initNavigationTracking();
    initWebVitals();

    // Defer element visibility observer slightly so DOM is more populated
    setTimeout(initElementVisibilityTracking, 2000);

    // Init video tracker
    if (typeof EyedVideoTracker !== 'undefined') {
      EyedVideoTracker.init();
    }

    // Load settings first, then check tracking/recording state
    // This avoids a race where channels/screenshots start with wrong settings
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response?.settings) state.settings = response.settings;

      // Now that settings are loaded, check tracking and recording state
      chrome.runtime.sendMessage({ type: 'GET_TRACKING_STATE' }, (tResponse) => {
        if (chrome.runtime.lastError) return;
        if (tResponse?.active) {
          state.trackingActive = true;
          document.getElementById('eyed-tracking-indicator')?.classList.add('active');
          document.getElementById('eyed-gaze-cursor')?.classList.add('active');
        }
      });

      chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATE' }, (rResponse) => {
        if (chrome.runtime.lastError) return;
        if (rResponse?.recording) {
          state.recordingActive = true;
          startEventFlushTimer();
          document.getElementById('eyed-tracking-indicator')?.classList.add('recording');
          if (isChannelEnabled('autoScreenshots')) startAutoScreenshots();
          if (isChannelEnabled('screenshotOnLoad')) {
            setTimeout(() => captureAutoScreenshot('pageLoad'), 2000);
          }
        }
      });
    });

    state.isNewPage = true;
    state.pageLoadTime = Date.now();
  }

  init();
})();
