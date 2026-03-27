/**
 * EyeD Screenshot System
 * Captures viewport and full-page scroll screenshots with heatmap overlay.
 * Composites gaze data, scanpath, first-viewed elements, and video timestamps.
 */

const EyedScreenshot = (() => {
  'use strict';

  /**
   * Capture the current viewport as a screenshot with heatmap overlay.
   * Requests the background to capture the visible tab, then composites heatmap on top.
   */
  async function captureViewport(options = {}) {
    const {
      includeHeatmap = true,
      includeScanpath = true,
      includeFirstViewed = true,
      includeAOI = false,
      gazePoints = [],
      mousePoints = [],
      touchPoints = [],
      firstViewedPoints = [],
      fixations = [],
      scanpath = null,
      aois = [],
    } = options;

    // Request screenshot from background (uses chrome.tabs.captureVisibleTab)
    const screenshotDataUrl = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' }, (response) => {
        resolve(response?.dataUrl || null);
      });
    });

    if (!screenshotDataUrl) return null;

    // Load the screenshot image
    const img = await loadImage(screenshotDataUrl);
    const w = img.width;
    const h = img.height;

    // Create compositing canvas
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');

    // Draw base screenshot
    ctx.drawImage(img, 0, 0);

    // Overlay layers
    if (includeHeatmap) {
      drawHeatmapOverlay(ctx, w, h, gazePoints.filter(p => !p.isBrowserUI), 'gaze');
      drawHeatmapOverlay(ctx, w, h, mousePoints, 'mouse');
      drawHeatmapOverlay(ctx, w, h, touchPoints, 'touch');
    }

    if (includeFirstViewed) {
      drawFirstViewedOverlay(ctx, w, h, firstViewedPoints);
    }

    if (includeScanpath && scanpath) {
      drawScanpathOverlay(ctx, w, h, scanpath);
    }

    if (includeAOI && aois.length > 0) {
      drawAOIOverlay(ctx, w, h, aois);
    }

    // Add metadata watermark
    drawWatermark(ctx, w, h, gazePoints.length, fixations.length);

    return canvas.toDataURL('image/png');
  }

  /**
   * Capture full-page scroll screenshot with heatmap.
   * Scrolls through the entire page, captures each viewport, and stitches together.
   */
  async function captureFullPage(options = {}) {
    const {
      gazePoints = [],
      mousePoints = [],
      touchPoints = [],
      firstViewedPoints = [],
      fixations = [],
      scanpath = null,
      aois = [],
      includeHeatmap = true,
      includeScanpath = true,
      includeFirstViewed = true,
      includeAOI = false,
      onProgress = () => {},
    } = options;

    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const pageW = Math.max(document.documentElement.scrollWidth, viewW);
    const pageH = Math.max(document.documentElement.scrollHeight, viewH);

    // Save current scroll position
    const savedScrollX = window.scrollX;
    const savedScrollY = window.scrollY;

    // Calculate number of viewport captures needed
    const stepsY = Math.ceil(pageH / viewH);
    const captures = [];

    // Hide EyeD overlays during capture
    const overlayIds = ['eyed-heatmap-canvas', 'eyed-gaze-cursor', 'eyed-browser-zone', 'eyed-tracking-indicator', 'eyed-scanpath-canvas', 'eyed-timeline-bar'];
    const hiddenEls = [];
    for (const id of overlayIds) {
      const el = document.getElementById(id);
      if (el) {
        hiddenEls.push({ el, display: el.style.display });
        el.style.display = 'none';
      }
    }

    try {
      for (let step = 0; step < stepsY; step++) {
        const scrollY = Math.min(step * viewH, pageH - viewH);
        window.scrollTo(0, scrollY);

        // Wait for scroll and paint
        await new Promise(r => setTimeout(r, 300));
        onProgress(Math.round((step + 1) / stepsY * 50));

        // Capture this viewport
        const dataUrl = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' }, (response) => {
            resolve(response?.dataUrl || null);
          });
        });

        if (dataUrl) {
          captures.push({ dataUrl, scrollY, viewH });
        }
      }
    } finally {
      // Restore overlays
      for (const { el, display } of hiddenEls) {
        el.style.display = display;
      }
      // Restore scroll position
      window.scrollTo(savedScrollX, savedScrollY);
    }

    if (captures.length === 0) return null;

    onProgress(55);

    // Stitch captures into full-page image
    const fullCanvas = document.createElement('canvas');
    fullCanvas.width = viewW * window.devicePixelRatio;
    fullCanvas.height = pageH * window.devicePixelRatio;
    const fullCtx = fullCanvas.getContext('2d');
    const dpr = window.devicePixelRatio;

    for (const cap of captures) {
      const img = await loadImage(cap.dataUrl);
      const destY = cap.scrollY * dpr;
      fullCtx.drawImage(img, 0, destY, img.width, img.height);
    }

    onProgress(70);

    // Now overlay heatmap using absolute page coordinates
    const scaleX = fullCanvas.width / pageW;
    const scaleY = fullCanvas.height / pageH;

    if (includeHeatmap) {
      drawFullPageHeatmap(fullCtx, fullCanvas.width, fullCanvas.height, gazePoints, scaleX, scaleY, 'gaze');
      drawFullPageHeatmap(fullCtx, fullCanvas.width, fullCanvas.height, mousePoints, scaleX, scaleY, 'mouse');
      drawFullPageHeatmap(fullCtx, fullCanvas.width, fullCanvas.height, touchPoints, scaleX, scaleY, 'touch');
    }

    onProgress(80);

    if (includeFirstViewed) {
      drawFullPageFirstViewed(fullCtx, fullCanvas.width, fullCanvas.height, firstViewedPoints, scaleX, scaleY);
    }

    if (includeScanpath && scanpath) {
      drawFullPageScanpath(fullCtx, fullCanvas.width, fullCanvas.height, scanpath, scaleX, scaleY);
    }

    if (includeAOI && aois.length > 0) {
      drawFullPageAOI(fullCtx, fullCanvas.width, fullCanvas.height, aois, scaleX, scaleY);
    }

    onProgress(90);

    drawWatermark(fullCtx, fullCanvas.width, fullCanvas.height, gazePoints.length, fixations.length);

    onProgress(100);

    return fullCanvas.toDataURL('image/png');
  }

  /* ========== HEATMAP DRAWING ========== */

  function drawHeatmapOverlay(ctx, w, h, points, type) {
    if (points.length === 0) return;

    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.globalCompositeOperation = 'screen';

    const radius = type === 'gaze' ? 25 : type === 'touch' ? 18 : 12;

    for (const point of points) {
      const px = point.x * w;
      const py = point.y * h;

      const grad = ctx.createRadialGradient(px, py, 0, px, py, radius);
      const alpha = type === 'gaze' ? 0.06 : type === 'touch' ? 0.08 : 0.03;
      const color = type === 'gaze' ? '255,80,0' : type === 'touch' ? '0,200,255' : '180,180,180';
      grad.addColorStop(0, `rgba(${color}, ${alpha})`);
      grad.addColorStop(1, `rgba(${color}, 0)`);

      ctx.fillStyle = grad;
      ctx.fillRect(px - radius, py - radius, radius * 2, radius * 2);
    }

    ctx.restore();
  }

  function drawFullPageHeatmap(ctx, w, h, points, scaleX, scaleY, type) {
    if (points.length === 0) return;

    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.globalCompositeOperation = 'screen';

    const baseRadius = type === 'gaze' ? 30 : type === 'touch' ? 22 : 14;
    const radius = baseRadius * Math.max(scaleX, scaleY);

    for (const point of points) {
      const px = (point.pageX || point.x * w) * scaleX;
      const py = (point.pageY || point.y * h) * scaleY;

      const grad = ctx.createRadialGradient(px, py, 0, px, py, radius);
      const alpha = type === 'gaze' ? 0.05 : type === 'touch' ? 0.07 : 0.025;
      const color = type === 'gaze' ? '255,80,0' : type === 'touch' ? '0,200,255' : '180,180,180';
      grad.addColorStop(0, `rgba(${color}, ${alpha})`);
      grad.addColorStop(1, `rgba(${color}, 0)`);

      ctx.fillStyle = grad;
      ctx.fillRect(px - radius, py - radius, radius * 2, radius * 2);
    }

    ctx.restore();
  }

  /* ========== FIRST VIEWED ========== */

  function drawFirstViewedOverlay(ctx, w, h, points) {
    if (points.length === 0) return;

    ctx.save();
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const px = p.x * w;
      const py = p.y * h;

      // Orange glow
      const grad = ctx.createRadialGradient(px, py, 0, px, py, 35);
      grad.addColorStop(0, 'rgba(255, 165, 0, 0.4)');
      grad.addColorStop(1, 'rgba(255, 165, 0, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(px, py, 35, 0, Math.PI * 2);
      ctx.fill();

      // Numbered badge
      drawNumberBadge(ctx, px, py - 20, i + 1, '#ff8c00');
    }
    ctx.restore();
  }

  function drawFullPageFirstViewed(ctx, w, h, points, scaleX, scaleY) {
    if (points.length === 0) return;
    ctx.save();
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const px = (p.pageX || p.x * w) * scaleX;
      const py = (p.pageY || p.y * h) * scaleY;

      const grad = ctx.createRadialGradient(px, py, 0, px, py, 40);
      grad.addColorStop(0, 'rgba(255, 165, 0, 0.4)');
      grad.addColorStop(1, 'rgba(255, 165, 0, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(px, py, 40, 0, Math.PI * 2);
      ctx.fill();

      drawNumberBadge(ctx, px, py - 24, i + 1, '#ff8c00');
    }
    ctx.restore();
  }

  /* ========== SCANPATH ========== */

  function drawScanpathOverlay(ctx, w, h, scanpath) {
    const { fixations, saccades } = scanpath;
    if (fixations.length === 0) return;

    ctx.save();
    ctx.globalAlpha = 0.8;

    // Draw saccade lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);

    for (const s of saccades) {
      ctx.beginPath();
      ctx.moveTo(s.fromX * w, s.fromY * h);
      ctx.lineTo(s.toX * w, s.toY * h);
      ctx.stroke();

      // Arrowhead
      drawArrowhead(ctx, s.fromX * w, s.fromY * h, s.toX * w, s.toY * h);
    }
    ctx.setLineDash([]);

    // Draw fixation circles (size = duration)
    for (const fix of fixations) {
      const px = fix.cx * w;
      const py = fix.cy * h;
      const radius = Math.max(8, Math.min(30, fix.duration / 20));

      // Outer circle
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(88, 166, 255, 0.3)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(88, 166, 255, 0.8)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Number label
      drawNumberBadge(ctx, px, py, fix.index, '#1f6feb');
    }

    ctx.restore();
  }

  function drawFullPageScanpath(ctx, w, h, scanpath, scaleX, scaleY) {
    const { fixations, saccades } = scanpath;
    if (fixations.length === 0) return;

    ctx.save();
    ctx.globalAlpha = 0.8;

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);

    for (const s of saccades) {
      const fx = s.fromX * w * scaleX / (scaleX || 1);
      const fy = s.fromY * h * scaleY / (scaleY || 1);
      const tx = s.toX * w * scaleX / (scaleX || 1);
      const ty = s.toY * h * scaleY / (scaleY || 1);
      // Use page coordinates if available
      const fromX = (s.fromPageX || fx) * scaleX;
      const fromY = (s.fromPageY || fy) * scaleY;
      const toX = (s.toPageX || tx) * scaleX;
      const toY = (s.toPageY || ty) * scaleY;

      ctx.beginPath();
      ctx.moveTo(fromX, fromY);
      ctx.lineTo(toX, toY);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    for (const fix of fixations) {
      const px = (fix.pageCx || fix.cx * w) * scaleX;
      const py = (fix.pageCy || fix.cy * h) * scaleY;
      const radius = Math.max(10, Math.min(35, fix.duration / 18));

      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(88, 166, 255, 0.3)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(88, 166, 255, 0.8)';
      ctx.lineWidth = 2;
      ctx.stroke();

      drawNumberBadge(ctx, px, py, fix.index, '#1f6feb');
    }

    ctx.restore();
  }

  /* ========== AOI OVERLAY ========== */

  function drawAOIOverlay(ctx, w, h, aois) {
    ctx.save();
    ctx.globalAlpha = 0.6;

    const colors = {
      'Navigation': '#58a6ff',
      'Header': '#3fb950',
      'Heading': '#d29922',
      'Image': '#f0883e',
      'Video': '#f85149',
      'CTA/Button': '#bc8cff',
      'Form': '#79c0ff',
      'Footer': '#8b949e',
      'Content': '#56d364',
      'Ad': '#f85149',
      'Search': '#58a6ff',
      'Logo': '#d29922',
      'default': '#8b949e',
    };

    for (const aoi of aois) {
      if (aoi.fixationCount === 0) continue;
      const r = aoi.rect;
      const color = colors[aoi.category] || colors.default;

      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x, r.y, r.width, r.height);

      // Label
      ctx.font = 'bold 11px -apple-system, sans-serif';
      const labelW = ctx.measureText(aoi.label).width + 12;
      ctx.fillStyle = color;
      ctx.fillRect(r.x, r.y - 18, labelW, 18);
      ctx.fillStyle = '#fff';
      ctx.fillText(aoi.label, r.x + 6, r.y - 5);

      // Dwell time badge
      const dwellText = `${Math.round(aoi.totalDwellTime / 1000 * 10) / 10}s`;
      ctx.font = '10px monospace';
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      const badgeW = ctx.measureText(dwellText).width + 8;
      ctx.fillRect(r.x + r.width - badgeW, r.y, badgeW, 16);
      ctx.fillStyle = '#fff';
      ctx.fillText(dwellText, r.x + r.width - badgeW + 4, r.y + 12);
    }

    ctx.restore();
  }

  function drawFullPageAOI(ctx, w, h, aois, scaleX, scaleY) {
    ctx.save();
    ctx.globalAlpha = 0.6;

    for (const aoi of aois) {
      if (aoi.fixationCount === 0) continue;
      const r = aoi.rect;
      const x = (r.pageX || r.x) * scaleX;
      const y = (r.pageY || r.y) * scaleY;
      const rw = r.width * scaleX;
      const rh = r.height * scaleY;

      ctx.strokeStyle = '#58a6ff';
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, rw, rh);

      ctx.font = 'bold 12px -apple-system, sans-serif';
      ctx.fillStyle = 'rgba(88,166,255,0.8)';
      ctx.fillText(aoi.label, x + 4, y - 4);
    }

    ctx.restore();
  }

  /* ========== DRAWING HELPERS ========== */

  function drawNumberBadge(ctx, x, y, number, color) {
    const size = 14;
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.font = 'bold 10px -apple-system, sans-serif';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(number), x, y);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  function drawArrowhead(ctx, fromX, fromY, toX, toY) {
    const angle = Math.atan2(toY - fromY, toX - fromX);
    const headLen = 8;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.beginPath();
    ctx.moveTo(toX, toY);
    ctx.lineTo(toX - headLen * Math.cos(angle - 0.4), toY - headLen * Math.sin(angle - 0.4));
    ctx.lineTo(toX - headLen * Math.cos(angle + 0.4), toY - headLen * Math.sin(angle + 0.4));
    ctx.closePath();
    ctx.fill();
  }

  function drawWatermark(ctx, w, h, gazeCount, fixationCount) {
    ctx.save();
    ctx.globalAlpha = 0.7;

    const padding = 12;
    const barH = 28;

    ctx.fillStyle = 'rgba(13, 17, 23, 0.85)';
    ctx.fillRect(0, h - barH, w, barH);

    ctx.font = '11px -apple-system, sans-serif';
    ctx.fillStyle = '#8b949e';

    const now = new Date();
    const dateStr = now.toLocaleString();
    const url = window.location?.href || '';
    const truncUrl = url.length > 60 ? url.substring(0, 57) + '...' : url;

    ctx.fillText(`EyeD | ${dateStr} | ${gazeCount} gaze points | ${fixationCount} fixations | ${truncUrl}`, padding, h - 9);

    ctx.restore();
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  /**
   * Download a data URL as a file.
   */
  function downloadDataUrl(dataUrl, filename) {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    a.click();
  }

  return {
    captureViewport,
    captureFullPage,
    downloadDataUrl,
  };
})();

if (typeof window !== 'undefined') {
  window.EyedScreenshot = EyedScreenshot;
}
