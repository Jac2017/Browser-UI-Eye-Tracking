/**
 * EyeD Content Script
 * Renders heatmap overlay, gaze cursor, and tracks mouse/touch input.
 * Receives gaze data from the background service worker.
 */

(function () {
  'use strict';

  // Avoid double injection
  if (window.__eyedContentLoaded) return;
  window.__eyedContentLoaded = true;

  /* ========== STATE ========== */
  const state = {
    trackingActive: false,
    showHeatmap: false,
    showCursor: true,
    gazePoints: [],          // { x, y, timestamp }
    touchPoints: [],         // { x, y, timestamp }
    mousePoints: [],         // { x, y, timestamp }
    firstViewedPoints: [],   // { x, y, timestamp, element }
    firstViewedElements: [], // DOM elements first gazed at
    isNewPage: false,
    pageLoadTime: 0,
    firstViewedWindowMs: 5000,
    heatmapDirty: true,
    browserUIGaze: false,    // Is user looking above viewport?
    smoothedGaze: { x: 0.5, y: 0.5 },
    mousePos: { x: 0, y: 0 },
  };

  /* ========== DOM SETUP ========== */
  function createOverlayElements() {
    // Heatmap canvas
    const canvas = document.createElement('canvas');
    canvas.id = 'eyed-heatmap-canvas';
    canvas.classList.add('hidden');
    document.documentElement.appendChild(canvas);

    // Gaze cursor
    const cursor = document.createElement('div');
    cursor.id = 'eyed-gaze-cursor';
    document.documentElement.appendChild(cursor);

    // Browser UI zone indicator
    const browserZone = document.createElement('div');
    browserZone.id = 'eyed-browser-zone';
    document.documentElement.appendChild(browserZone);

    // Tracking indicator dot
    const indicator = document.createElement('div');
    indicator.id = 'eyed-tracking-indicator';
    document.documentElement.appendChild(indicator);

    // Size canvas to viewport
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
  }

  function resizeCanvas() {
    const canvas = document.getElementById('eyed-heatmap-canvas');
    if (canvas) {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      state.heatmapDirty = true;
    }
  }

  /* ========== GAZE DATA HANDLING ========== */
  const SMOOTHING = 0.3; // Exponential moving average factor

  function handleGazePoint(data) {
    if (!state.trackingActive) return;

    const { x, y, timestamp, confidence } = data;

    // Smooth the gaze position
    state.smoothedGaze.x = state.smoothedGaze.x * (1 - SMOOTHING) + x * SMOOTHING;
    state.smoothedGaze.y = state.smoothedGaze.y * (1 - SMOOTHING) + y * SMOOTHING;

    const sx = state.smoothedGaze.x;
    const sy = state.smoothedGaze.y;

    // Detect if gaze is above viewport (browser UI area)
    const browserZone = document.getElementById('eyed-browser-zone');
    if (sy < 0) {
      state.browserUIGaze = true;
      if (browserZone) browserZone.classList.add('gaze-above');
      // Store as browser UI gaze point (negative y)
      const point = { x: sx, y: sy, timestamp, isBrowserUI: true };
      state.gazePoints.push(point);
    } else {
      state.browserUIGaze = false;
      if (browserZone) browserZone.classList.remove('gaze-above');

      const point = { x: sx, y: sy, timestamp, isBrowserUI: false };
      state.gazePoints.push(point);

      // Check first-viewed elements on new page
      if (state.isNewPage && (Date.now() - state.pageLoadTime) < state.firstViewedWindowMs) {
        identifyFirstViewedElement(sx, sy, timestamp);
      } else if (state.isNewPage) {
        state.isNewPage = false;
      }
    }

    // Update gaze cursor position
    updateGazeCursor(sx, sy);

    // Store in background for persistence
    chrome.runtime.sendMessage({
      type: 'STORE_GAZE_POINT',
      x: sx,
      y: sy,
      timestamp,
    });

    state.heatmapDirty = true;

    // Limit stored points to prevent memory issues
    if (state.gazePoints.length > 10000) {
      state.gazePoints = state.gazePoints.slice(-5000);
    }
  }

  function updateGazeCursor(x, y) {
    const cursor = document.getElementById('eyed-gaze-cursor');
    if (!cursor || !state.showCursor) return;

    const px = x * window.innerWidth;
    const py = y * window.innerHeight;

    cursor.style.left = px + 'px';
    cursor.style.top = py + 'px';
  }

  /* ========== FIRST-VIEWED DETECTION ========== */
  function identifyFirstViewedElement(x, y, timestamp) {
    const px = x * window.innerWidth;
    const py = y * window.innerHeight;

    // Temporarily hide our overlays to get the real element
    const canvas = document.getElementById('eyed-heatmap-canvas');
    const cursor = document.getElementById('eyed-gaze-cursor');
    if (canvas) canvas.style.display = 'none';
    if (cursor) cursor.style.display = 'none';

    const element = document.elementFromPoint(px, py);

    if (canvas) canvas.style.display = '';
    if (cursor) cursor.style.display = '';

    if (element && !element.id?.startsWith('eyed-') && !state.firstViewedElements.includes(element)) {
      state.firstViewedElements.push(element);
      state.firstViewedPoints.push({ x, y, timestamp, tagName: element.tagName, text: element.textContent?.substring(0, 50) });

      // Cap at 20 first-viewed elements
      if (state.firstViewedElements.length >= 20) {
        state.isNewPage = false;
      }
    }
  }

  /* ========== MOUSE / TOUCH TRACKING ========== */
  function initInputTracking() {
    // Mouse tracking
    document.addEventListener('mousemove', (e) => {
      state.mousePos.x = e.clientX;
      state.mousePos.y = e.clientY;

      if (state.trackingActive) {
        const x = e.clientX / window.innerWidth;
        const y = e.clientY / window.innerHeight;
        state.mousePoints.push({ x, y, timestamp: Date.now() });

        chrome.runtime.sendMessage({
          type: 'MOUSE_DATA',
          x, y,
          timestamp: Date.now(),
        });

        // Limit stored points
        if (state.mousePoints.length > 5000) {
          state.mousePoints = state.mousePoints.slice(-2500);
        }
      }
    }, { passive: true });

    // Touch tracking
    document.addEventListener('touchstart', handleTouch, { passive: true });
    document.addEventListener('touchmove', handleTouch, { passive: true });
    document.addEventListener('touchend', handleTouch, { passive: true });

    function handleTouch(e) {
      if (!state.trackingActive) return;
      for (const touch of e.changedTouches) {
        const x = touch.clientX / window.innerWidth;
        const y = touch.clientY / window.innerHeight;
        state.touchPoints.push({ x, y, timestamp: Date.now() });

        chrome.runtime.sendMessage({
          type: 'TOUCH_DATA',
          x, y,
          timestamp: Date.now(),
        });
      }

      if (state.touchPoints.length > 5000) {
        state.touchPoints = state.touchPoints.slice(-2500);
      }
    }
  }

  /* ========== HEATMAP RENDERING ========== */
  function renderHeatmap() {
    const canvas = document.getElementById('eyed-heatmap-canvas');
    if (!canvas || !state.showHeatmap) return;

    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    // Create intensity map using shadow blur technique
    // This is more performant than per-pixel computation
    ctx.globalCompositeOperation = 'source-over';

    // Draw gaze points as radial gradients
    drawHeatPoints(ctx, w, h, state.gazePoints.filter(p => !p.isBrowserUI), 20, 'gaze');
    drawHeatPoints(ctx, w, h, state.mousePoints, 10, 'mouse');
    drawHeatPoints(ctx, w, h, state.touchPoints, 15, 'touch');

    // Draw first-viewed points with different color
    drawFirstViewedPoints(ctx, w, h);

    // Draw browser UI zone if there are above-viewport gazes
    drawBrowserUIZone(ctx, w, h);
  }

  function drawHeatPoints(ctx, w, h, points, radius, type) {
    if (points.length === 0) return;

    // Create offscreen canvas for intensity map
    const offscreen = document.createElement('canvas');
    offscreen.width = w;
    offscreen.height = h;
    const offCtx = offscreen.getContext('2d');

    // Draw each point as a radial gradient on offscreen canvas
    for (const point of points) {
      const px = point.x * w;
      const py = point.y * h;

      const grad = offCtx.createRadialGradient(px, py, 0, px, py, radius);
      // Intensity based on type
      const alpha = type === 'gaze' ? 0.04 : type === 'touch' ? 0.06 : 0.02;
      grad.addColorStop(0, `rgba(0, 0, 0, ${alpha})`);
      grad.addColorStop(1, 'rgba(0, 0, 0, 0)');

      offCtx.fillStyle = grad;
      offCtx.fillRect(px - radius, py - radius, radius * 2, radius * 2);
    }

    // Colorize the intensity map
    const imageData = offCtx.getImageData(0, 0, w, h);
    const pixels = imageData.data;

    for (let i = 0; i < pixels.length; i += 4) {
      const intensity = pixels[i + 3]; // Alpha channel = intensity

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

    // Draw colorized result onto main canvas
    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(offscreen, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
  }

  function heatmapColor(t, type) {
    // Gaze: blue → green → yellow → red
    // Touch: cyan → magenta
    // Mouse: dim gray → light gray
    if (type === 'mouse') {
      const v = Math.floor(100 + t * 155);
      return { r: v, g: v, b: v };
    }

    if (type === 'touch') {
      return {
        r: Math.floor(t * 255),
        g: Math.floor((1 - t) * 200),
        b: 255,
      };
    }

    // Gaze heatmap: classic thermal
    if (t < 0.25) {
      return { r: 0, g: 0, b: Math.floor(t * 4 * 255) };
    } else if (t < 0.5) {
      const tt = (t - 0.25) * 4;
      return { r: 0, g: Math.floor(tt * 255), b: Math.floor((1 - tt) * 255) };
    } else if (t < 0.75) {
      const tt = (t - 0.5) * 4;
      return { r: Math.floor(tt * 255), g: 255, b: 0 };
    } else {
      const tt = (t - 0.75) * 4;
      return { r: 255, g: Math.floor((1 - tt) * 255), b: 0 };
    }
  }

  function drawFirstViewedPoints(ctx, w, h) {
    if (state.firstViewedPoints.length === 0) return;

    // First-viewed elements get a distinct orange/gold heatmap
    ctx.globalCompositeOperation = 'screen';

    for (const point of state.firstViewedPoints) {
      const px = point.x * w;
      const py = point.y * h;
      const radius = 30;

      const grad = ctx.createRadialGradient(px, py, 0, px, py, radius);
      grad.addColorStop(0, 'rgba(255, 165, 0, 0.5)');
      grad.addColorStop(0.5, 'rgba(255, 120, 0, 0.2)');
      grad.addColorStop(1, 'rgba(255, 80, 0, 0)');

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draw a small marker for each first-viewed point
    ctx.globalCompositeOperation = 'source-over';
    for (const point of state.firstViewedPoints) {
      const px = point.x * w;
      const py = point.y * h;

      // Orange diamond marker
      ctx.fillStyle = 'rgba(255, 165, 0, 0.8)';
      ctx.beginPath();
      ctx.moveTo(px, py - 6);
      ctx.lineTo(px + 4, py);
      ctx.lineTo(px, py + 6);
      ctx.lineTo(px - 4, py);
      ctx.closePath();
      ctx.fill();
    }
  }

  function drawBrowserUIZone(ctx, w, h) {
    const browserUIPoints = state.gazePoints.filter(p => p.isBrowserUI);
    if (browserUIPoints.length === 0) return;

    // Draw a bar at the top indicating gaze above viewport
    const intensity = Math.min(1, browserUIPoints.length / 50);
    const barHeight = 30;

    const grad = ctx.createLinearGradient(0, 0, 0, barHeight);
    grad.addColorStop(0, `rgba(88, 166, 255, ${0.3 * intensity})`);
    grad.addColorStop(1, 'rgba(88, 166, 255, 0)');

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, barHeight);

    // Show text indicating browser UI attention
    if (intensity > 0.3) {
      ctx.font = '11px -apple-system, sans-serif';
      ctx.fillStyle = `rgba(88, 166, 255, ${0.6 * intensity})`;
      ctx.textAlign = 'center';
      ctx.fillText('Browser UI gaze detected', w / 2, 14);
    }
  }

  /* ========== HEATMAP RENDER LOOP ========== */
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
    });
  }

  // Render heatmap periodically when visible
  setInterval(() => {
    if (state.showHeatmap && state.heatmapDirty) {
      queueRender();
    }
  }, 500);

  /* ========== MESSAGE HANDLING ========== */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'GAZE_POINT':
        handleGazePoint(msg);
        break;

      case 'TRACKING_STATE':
        state.trackingActive = msg.active;
        const indicator = document.getElementById('eyed-tracking-indicator');
        const cursor = document.getElementById('eyed-gaze-cursor');
        if (indicator) indicator.classList.toggle('active', msg.active);
        if (cursor) cursor.classList.toggle('active', msg.active && state.showCursor);
        break;

      case 'NEW_PAGE_LOADED':
        state.isNewPage = true;
        state.pageLoadTime = msg.timestamp;
        state.firstViewedElements = [];
        state.firstViewedPoints = [];
        break;

      case 'TOGGLE_HEATMAP':
        state.showHeatmap = !state.showHeatmap;
        const canvas = document.getElementById('eyed-heatmap-canvas');
        if (canvas) canvas.classList.toggle('hidden', !state.showHeatmap);
        if (state.showHeatmap) {
          state.heatmapDirty = true;
          queueRender();
        }
        sendResponse({ visible: state.showHeatmap });
        return true;

      case 'SHOW_HEATMAP':
        state.showHeatmap = true;
        const hcanvas = document.getElementById('eyed-heatmap-canvas');
        if (hcanvas) hcanvas.classList.remove('hidden');
        state.heatmapDirty = true;
        queueRender();
        break;

      case 'HIDE_HEATMAP':
        state.showHeatmap = false;
        const hhcanvas = document.getElementById('eyed-heatmap-canvas');
        if (hhcanvas) hhcanvas.classList.add('hidden');
        break;

      case 'TOGGLE_CURSOR':
        state.showCursor = !state.showCursor;
        const gcursor = document.getElementById('eyed-gaze-cursor');
        if (gcursor) gcursor.classList.toggle('active', state.showCursor && state.trackingActive);
        sendResponse({ visible: state.showCursor });
        return true;

      case 'GET_CONTENT_STATE':
        sendResponse({
          trackingActive: state.trackingActive,
          showHeatmap: state.showHeatmap,
          gazePointCount: state.gazePoints.length,
          mousePointCount: state.mousePoints.length,
          touchPointCount: state.touchPoints.length,
          firstViewedCount: state.firstViewedPoints.length,
        });
        return true;

      case 'CLEAR_LOCAL_DATA':
        state.gazePoints = [];
        state.touchPoints = [];
        state.mousePoints = [];
        state.firstViewedPoints = [];
        state.firstViewedElements = [];
        state.heatmapDirty = true;
        if (state.showHeatmap) queueRender();
        sendResponse({ ok: true });
        return true;
    }
  });

  /* ========== INIT ========== */
  function init() {
    createOverlayElements();
    initInputTracking();

    // Check if tracking is already active
    chrome.runtime.sendMessage({ type: 'GET_TRACKING_STATE' }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response?.active) {
        state.trackingActive = true;
        const indicator = document.getElementById('eyed-tracking-indicator');
        if (indicator) indicator.classList.add('active');
        const cursor = document.getElementById('eyed-gaze-cursor');
        if (cursor) cursor.classList.add('active');
      }
    });

    // Mark as new page for first-viewed detection
    state.isNewPage = true;
    state.pageLoadTime = Date.now();
  }

  init();
})();
