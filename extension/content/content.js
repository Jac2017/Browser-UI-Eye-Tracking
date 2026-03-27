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
    for (const id of ['eyed-heatmap-canvas', 'eyed-scanpath-canvas']) {
      const c = document.getElementById(id);
      if (c) { c.width = window.innerWidth; c.height = window.innerHeight; }
    }
    state.heatmapDirty = true;
  }

  /* ========== ENRICHED POINT CREATION ========== */
  function createPoint(x, y, extras = {}) {
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const point = {
      x, y,
      pageX: x * viewW + window.scrollX,
      pageY: y * viewH + window.scrollY,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      timestamp: Date.now(),
      ...extras,
    };

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

    const { x, y, timestamp, confidence } = data;

    state.smoothedGaze.x = state.smoothedGaze.x * (1 - SMOOTHING) + x * SMOOTHING;
    state.smoothedGaze.y = state.smoothedGaze.y * (1 - SMOOTHING) + y * SMOOTHING;

    const sx = state.smoothedGaze.x;
    const sy = state.smoothedGaze.y;

    const browserZone = document.getElementById('eyed-browser-zone');

    if (sy < 0) {
      state.browserUIGaze = true;
      if (browserZone) browserZone.classList.add('gaze-above');
      state.gazePoints.push(createPoint(sx, sy, { isBrowserUI: true }));
    } else {
      state.browserUIGaze = false;
      if (browserZone) browserZone.classList.remove('gaze-above');

      const point = createPoint(sx, sy, { isBrowserUI: false });
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
      timestamp,
      videoTime: lastPoint.videoTime,
      onVideo: lastPoint.onVideo,
    }).catch(() => {});

    state.heatmapDirty = true;
    state.analyticsDirty = true;

    if (state.gazePoints.length > 10000) {
      state.gazePoints = state.gazePoints.slice(-5000);
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

      if (state.trackingActive && Date.now() - mouseThrottle > 50) {
        mouseThrottle = Date.now();
        const x = e.clientX / window.innerWidth;
        const y = e.clientY / window.innerHeight;
        state.mousePoints.push(createPoint(x, y));

        chrome.runtime.sendMessage({
          type: 'MOUSE_DATA', x, y,
          pageX: e.clientX + window.scrollX,
          pageY: e.clientY + window.scrollY,
          timestamp: Date.now(),
        }).catch(() => {});

        if (state.mousePoints.length > 5000) state.mousePoints = state.mousePoints.slice(-2500);
      }
    }, { passive: true });

    document.addEventListener('touchstart', handleTouch, { passive: true });
    document.addEventListener('touchmove', handleTouch, { passive: true });
    document.addEventListener('touchend', handleTouch, { passive: true });

    function handleTouch(e) {
      if (!state.trackingActive) return;
      for (const touch of e.changedTouches) {
        const x = touch.clientX / window.innerWidth;
        const y = touch.clientY / window.innerHeight;
        state.touchPoints.push(createPoint(x, y));

        chrome.runtime.sendMessage({
          type: 'TOUCH_DATA', x, y,
          pageX: touch.clientX + window.scrollX,
          pageY: touch.clientY + window.scrollY,
          timestamp: Date.now(),
        }).catch(() => {});
      }
      if (state.touchPoints.length > 5000) state.touchPoints = state.touchPoints.slice(-2500);
    }

    // Track scroll events for scroll-position correlation
    let scrollThrottle = 0;
    document.addEventListener('scroll', () => {
      if (!state.trackingActive || Date.now() - scrollThrottle < 100) return;
      scrollThrottle = Date.now();
      chrome.runtime.sendMessage({
        type: 'SCROLL_EVENT',
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        pageHeight: document.documentElement.scrollHeight,
        viewHeight: window.innerHeight,
        timestamp: Date.now(),
      }).catch(() => {});
    }, { passive: true });
  }

  /* ========== HEATMAP RENDERING ========== */
  function renderHeatmap() {
    const canvas = document.getElementById('eyed-heatmap-canvas');
    if (!canvas || !state.showHeatmap) return;

    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    ctx.globalCompositeOperation = 'source-over';

    drawHeatPoints(ctx, w, h, state.gazePoints.filter(p => !p.isBrowserUI), 20, 'gaze');
    drawHeatPoints(ctx, w, h, state.mousePoints, 10, 'mouse');
    drawHeatPoints(ctx, w, h, state.touchPoints, 15, 'touch');
    drawFirstViewedPoints(ctx, w, h);
    drawBrowserUIZone(ctx, w, h);
  }

  function drawHeatPoints(ctx, w, h, points, radius, type) {
    if (points.length === 0) return;

    const offscreen = document.createElement('canvas');
    offscreen.width = w;
    offscreen.height = h;
    const offCtx = offscreen.getContext('2d');

    for (const point of points) {
      const px = point.x * w;
      const py = point.y * h;

      const grad = offCtx.createRadialGradient(px, py, 0, px, py, radius);
      const alpha = type === 'gaze' ? 0.04 : type === 'touch' ? 0.06 : 0.02;
      grad.addColorStop(0, `rgba(0, 0, 0, ${alpha})`);
      grad.addColorStop(1, 'rgba(0, 0, 0, 0)');

      offCtx.fillStyle = grad;
      offCtx.fillRect(px - radius, py - radius, radius * 2, radius * 2);
    }

    const imageData = offCtx.getImageData(0, 0, w, h);
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
    ctx.drawImage(offscreen, 0, 0);
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

  function drawFirstViewedPoints(ctx, w, h) {
    if (state.firstViewedPoints.length === 0) return;

    ctx.globalCompositeOperation = 'screen';
    for (const point of state.firstViewedPoints) {
      const px = point.x * w;
      const py = point.y * h;
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
      const px = p.x * w;
      const py = p.y * h;

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
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Run fixation detection
    if (state.analyticsDirty && typeof EyedAnalytics !== 'undefined') {
      state.fixations = EyedAnalytics.detectFixations(state.gazePoints.filter(p => !p.isBrowserUI), w, h);
      state.scanpath = EyedAnalytics.buildScanpath(state.fixations);
      state.analyticsDirty = false;
    }

    if (!state.scanpath || state.scanpath.fixations.length === 0) return;

    const { fixations, saccades } = state.scanpath;

    // Saccade lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);

    for (const s of saccades) {
      ctx.beginPath();
      ctx.moveTo(s.fromX * w, s.fromY * h);
      ctx.lineTo(s.toX * w, s.toY * h);
      ctx.stroke();

      // Arrowhead
      const angle = Math.atan2(s.toY * h - s.fromY * h, s.toX * w - s.fromX * w);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.beginPath();
      ctx.moveTo(s.toX * w, s.toY * h);
      ctx.lineTo(s.toX * w - 7 * Math.cos(angle - 0.4), s.toY * h - 7 * Math.sin(angle - 0.4));
      ctx.lineTo(s.toX * w - 7 * Math.cos(angle + 0.4), s.toY * h - 7 * Math.sin(angle + 0.4));
      ctx.closePath();
      ctx.fill();
    }
    ctx.setLineDash([]);

    // Fixation circles (size proportional to duration)
    for (const fix of fixations) {
      const px = fix.cx * w;
      const py = fix.cy * h;
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
            chrome.runtime.sendMessage({ type: 'SCREENSHOT_PROGRESS', progress: pct });
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
        handleScreenshotRequest({ ...msg, fullPage: false }, sendResponse);
        return true;

      case 'CAPTURE_FULLPAGE_SCREENSHOT':
        handleScreenshotRequest({ ...msg, fullPage: true }, sendResponse);
        return true;

      case 'CAPTURE_HEATMAP_SCREENSHOT':
        handleScreenshotRequest({ fullPage: false, download: false }, sendResponse);
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

      case 'CLEAR_LOCAL_DATA':
        state.gazePoints = [];
        state.touchPoints = [];
        state.mousePoints = [];
        state.firstViewedPoints = [];
        state.firstViewedElements = [];
        state.fixations = [];
        state.scanpath = null;
        state.heatmapDirty = true;
        state.analyticsDirty = true;
        if (state.showHeatmap) queueRender();
        sendResponse({ ok: true });
        return true;
    }
  });

  /* ========== INIT ========== */
  function init() {
    createOverlayElements();
    initInputTracking();

    // Init video tracker
    if (typeof EyedVideoTracker !== 'undefined') {
      EyedVideoTracker.init();
    }

    chrome.runtime.sendMessage({ type: 'GET_TRACKING_STATE' }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response?.active) {
        state.trackingActive = true;
        document.getElementById('eyed-tracking-indicator')?.classList.add('active');
        document.getElementById('eyed-gaze-cursor')?.classList.add('active');
      }
    });

    state.isNewPage = true;
    state.pageLoadTime = Date.now();
  }

  init();
})();
