/**
 * EyeD Analytics Engine
 * Fixation detection, scanpath analysis, AOI mapping, and engagement scoring.
 * Runs inside the content script context.
 */

const EyedAnalytics = (() => {
  'use strict';

  // I-DT (Identification by Dispersion Threshold) fixation detection
  const FIXATION_DISPERSION_PX = 50;    // Max spread in pixels for a fixation cluster
  const FIXATION_MIN_DURATION_MS = 150; // Minimum dwell time to count as fixation
  const SACCADE_VELOCITY_THRESHOLD = 500; // px/sec to classify as saccade

  /**
   * Detect fixations from raw gaze points using I-DT algorithm.
   * @param {Array} points - [{x, y, timestamp, pageX, pageY, ...}]
   * @param {number} viewW - viewport width
   * @param {number} viewH - viewport height
   * @returns {Array} fixations - [{cx, cy, pageCx, pageCy, startTime, endTime, duration, pointCount, points}]
   */
  function detectFixations(points, viewW, viewH) {
    if (points.length < 3) return [];

    const fixations = [];
    let windowStart = 0;
    let windowEnd = 0;

    while (windowStart < points.length) {
      windowEnd = windowStart + 1;

      // Expand window while dispersion is within threshold
      while (windowEnd < points.length) {
        const windowPoints = points.slice(windowStart, windowEnd + 1);
        const dispersion = calcDispersion(windowPoints, viewW, viewH);

        if (dispersion <= FIXATION_DISPERSION_PX) {
          windowEnd++;
        } else {
          break;
        }
      }

      const duration = points[Math.min(windowEnd, points.length - 1)].timestamp - points[windowStart].timestamp;

      if (windowEnd - windowStart >= 2 && duration >= FIXATION_MIN_DURATION_MS) {
        const fixPts = points.slice(windowStart, windowEnd);
        const cx = fixPts.reduce((s, p) => s + p.x, 0) / fixPts.length;
        const cy = fixPts.reduce((s, p) => s + p.y, 0) / fixPts.length;
        const pageCx = fixPts.reduce((s, p) => s + (p.pageX || p.x * viewW), 0) / fixPts.length;
        const pageCy = fixPts.reduce((s, p) => s + (p.pageY || p.y * viewH), 0) / fixPts.length;

        fixations.push({
          cx, cy,
          pageCx, pageCy,
          startTime: fixPts[0].timestamp,
          endTime: fixPts[fixPts.length - 1].timestamp,
          duration,
          pointCount: fixPts.length,
          points: fixPts,
        });

        windowStart = windowEnd;
      } else {
        windowStart++;
      }
    }

    return fixations;
  }

  function calcDispersion(points, viewW, viewH) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of points) {
      const px = p.x * viewW;
      const py = p.y * viewH;
      minX = Math.min(minX, px);
      maxX = Math.max(maxX, px);
      minY = Math.min(minY, py);
      maxY = Math.max(maxY, py);
    }
    return (maxX - minX) + (maxY - minY);
  }

  /**
   * Build scanpath from fixations - the ordered sequence with connecting saccades.
   * @param {Array} fixations
   * @returns {Object} { fixations: [...with index], saccades: [{from, to, distance, duration, velocity}] }
   */
  function buildScanpath(fixations) {
    const indexed = fixations.map((f, i) => ({ ...f, index: i + 1 }));
    const saccades = [];

    for (let i = 1; i < indexed.length; i++) {
      const prev = indexed[i - 1];
      const curr = indexed[i];
      const dx = (curr.cx - prev.cx) * window.innerWidth;
      const dy = (curr.cy - prev.cy) * window.innerHeight;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const duration = curr.startTime - prev.endTime;
      const velocity = duration > 0 ? distance / (duration / 1000) : 0;

      saccades.push({
        fromIndex: i,
        toIndex: i + 1,
        fromX: prev.cx, fromY: prev.cy,
        toX: curr.cx, toY: curr.cy,
        distance,
        duration,
        velocity,
      });
    }

    return { fixations: indexed, saccades };
  }

  /**
   * Auto-detect Areas of Interest from DOM structure.
   * Finds semantically meaningful elements and returns their bounding rects.
   */
  function detectAOIs() {
    const aois = [];
    const selectors = [
      { sel: 'nav, [role="navigation"]', label: 'Navigation' },
      { sel: 'header, [role="banner"]', label: 'Header' },
      { sel: 'h1, h2, h3', label: 'Heading' },
      { sel: 'img, picture, svg:not([width="0"])', label: 'Image' },
      { sel: 'video, [class*="player"], [class*="video"]', label: 'Video' },
      { sel: 'button, [role="button"], input[type="submit"], a.btn, a.button, .cta', label: 'CTA/Button' },
      { sel: 'form, [role="form"]', label: 'Form' },
      { sel: 'footer, [role="contentinfo"]', label: 'Footer' },
      { sel: '[class*="sidebar"], aside, [role="complementary"]', label: 'Sidebar' },
      { sel: '[class*="hero"], [class*="banner"], [class*="jumbotron"]', label: 'Hero' },
      { sel: '[class*="ad"], [id*="ad-"], [class*="sponsor"], ins.adsbygoogle', label: 'Ad' },
      { sel: 'p, article, [role="article"], .content, .post, .entry', label: 'Content' },
      { sel: 'input, textarea, select', label: 'Input Field' },
      { sel: '[class*="search"], [role="search"]', label: 'Search' },
      { sel: '[class*="logo"]', label: 'Logo' },
    ];

    const seen = new Set();

    for (const { sel, label } of selectors) {
      try {
        const elements = document.querySelectorAll(sel);
        for (const el of elements) {
          if (seen.has(el)) continue;
          // Skip tiny or hidden elements
          const rect = el.getBoundingClientRect();
          if (rect.width < 20 || rect.height < 20) continue;
          if (rect.width === 0 || rect.height === 0) continue;

          seen.add(el);
          aois.push({
            label: `${label}: ${getElementDescription(el)}`,
            category: label,
            rect: {
              x: rect.x, y: rect.y,
              width: rect.width, height: rect.height,
              // Absolute page coordinates
              pageX: rect.x + window.scrollX,
              pageY: rect.y + window.scrollY,
            },
            selector: generateSelector(el),
            element: el,
          });
        }
      } catch (e) { /* invalid selector on some pages */ }
    }

    return aois;
  }

  function getElementDescription(el) {
    if (el.alt) return el.alt.substring(0, 30);
    if (el.title) return el.title.substring(0, 30);
    if (el.textContent) {
      const text = el.textContent.trim().substring(0, 30);
      if (text) return text;
    }
    if (el.src) return el.src.split('/').pop().substring(0, 30);
    return el.tagName.toLowerCase();
  }

  function generateSelector(el) {
    if (el.id) return `#${el.id}`;
    const parts = [];
    let current = el;
    while (current && current !== document.body && parts.length < 4) {
      let selector = current.tagName.toLowerCase();
      if (current.className && typeof current.className === 'string') {
        const cls = current.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (cls) selector += '.' + cls;
      }
      parts.unshift(selector);
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  /**
   * Analyze fixations against AOIs - compute per-AOI metrics.
   */
  function analyzeAOIs(fixations, aois, viewW, viewH) {
    const results = aois.map(aoi => ({
      ...aoi,
      element: undefined, // Don't serialize DOM elements
      fixationCount: 0,
      totalDwellTime: 0,
      firstFixationTime: null,
      averageFixationDuration: 0,
      revisits: 0,
      fixationIndices: [],
    }));

    let lastAOIIndex = -1;

    for (const fix of fixations) {
      const fx = fix.cx * viewW;
      const fy = fix.cy * viewH;

      for (let i = 0; i < results.length; i++) {
        const aoi = results[i];
        const r = aoi.rect;

        if (fx >= r.x && fx <= r.x + r.width && fy >= r.y && fy <= r.y + r.height) {
          aoi.fixationCount++;
          aoi.totalDwellTime += fix.duration;
          aoi.fixationIndices.push(fix.index || 0);

          if (aoi.firstFixationTime === null) {
            aoi.firstFixationTime = fix.startTime;
          }

          // Track revisits (came back to this AOI after visiting another)
          if (lastAOIIndex !== i && lastAOIIndex !== -1 && aoi.fixationCount > 1) {
            aoi.revisits++;
          }
          lastAOIIndex = i;
          break; // One fixation maps to one AOI
        }
      }
    }

    // Compute averages
    for (const aoi of results) {
      if (aoi.fixationCount > 0) {
        aoi.averageFixationDuration = aoi.totalDwellTime / aoi.fixationCount;
      }
    }

    return results.filter(a => a.fixationCount > 0)
      .sort((a, b) => b.totalDwellTime - a.totalDwellTime);
  }

  /**
   * Compute engagement metrics from gaze data.
   */
  function computeEngagement(gazePoints, fixations, aois, sessionDurationMs) {
    if (gazePoints.length === 0 || sessionDurationMs === 0) {
      return { score: 0, breakdown: {} };
    }

    const totalFixationTime = fixations.reduce((s, f) => s + f.duration, 0);
    const fixationRatio = totalFixationTime / sessionDurationMs;

    // Average fixation duration (deeper processing = longer fixations)
    const avgFixDuration = fixations.length > 0
      ? fixations.reduce((s, f) => s + f.duration, 0) / fixations.length
      : 0;

    // Scan pattern diversity: how many unique AOIs were visited
    const aoiCategories = new Set(aois.filter(a => a.fixationCount > 0).map(a => a.category));
    const diversity = aoiCategories.size / Math.max(1, aois.length);

    // Revisit ratio: higher = more engaged (re-examining content)
    const totalRevisits = aois.reduce((s, a) => s + (a.revisits || 0), 0);
    const revisitRatio = fixations.length > 0 ? totalRevisits / fixations.length : 0;

    // Attention stability: ratio of time in fixations vs saccades
    const stability = Math.min(1, fixationRatio * 1.5);

    // F-pattern or Z-pattern detection
    const scanPattern = detectScanPattern(fixations);

    // Composite engagement score (0-100)
    const score = Math.round(
      stability * 30 +
      Math.min(1, avgFixDuration / 500) * 25 +
      diversity * 20 +
      Math.min(1, revisitRatio * 5) * 15 +
      (scanPattern !== 'random' ? 10 : 0)
    );

    return {
      score: Math.min(100, score),
      fixationCount: fixations.length,
      totalFixationTime,
      fixationRatio: Math.round(fixationRatio * 100),
      avgFixationDuration: Math.round(avgFixDuration),
      scanPattern,
      aoiCoverage: aoiCategories.size,
      revisitCount: totalRevisits,
      stability: Math.round(stability * 100),
      sessionDuration: sessionDurationMs,
      breakdown: {
        stability: Math.round(stability * 30),
        depth: Math.round(Math.min(1, avgFixDuration / 500) * 25),
        breadth: Math.round(diversity * 20),
        revisits: Math.round(Math.min(1, revisitRatio * 5) * 15),
        pattern: scanPattern !== 'random' ? 10 : 0,
      }
    };
  }

  /**
   * Detect dominant scan pattern (F-pattern, Z-pattern, linear, or random).
   */
  function detectScanPattern(fixations) {
    if (fixations.length < 5) return 'insufficient';

    const xs = fixations.map(f => f.cx);
    const ys = fixations.map(f => f.cy);

    // Check for F-pattern: top horizontal, then progressively shorter horizontal scans downward
    let topHorizontal = 0;
    let leftVertical = 0;
    for (let i = 0; i < Math.min(fixations.length, 10); i++) {
      if (ys[i] < 0.3) topHorizontal++;
      if (xs[i] < 0.4) leftVertical++;
    }

    if (topHorizontal >= 3 && leftVertical >= 3) return 'F-pattern';

    // Check for Z-pattern: top-left → top-right → bottom-left → bottom-right
    if (fixations.length >= 4) {
      const first = fixations[0];
      const mid = fixations[Math.floor(fixations.length / 2)];
      const last = fixations[fixations.length - 1];

      if (first.cy < 0.4 && last.cy > 0.6) {
        if (first.cx < 0.5 && last.cx > 0.5) return 'Z-pattern';
      }
    }

    // Check for linear (top-to-bottom reading)
    let monotonic = 0;
    for (let i = 1; i < ys.length; i++) {
      if (ys[i] >= ys[i - 1] - 0.05) monotonic++;
    }
    if (monotonic / (ys.length - 1) > 0.7) return 'linear';

    return 'exploratory';
  }

  /**
   * Detect attention to fold line - above vs below fold.
   */
  function analyzeFoldAttention(fixations, viewH) {
    let aboveFold = 0, belowFold = 0;
    let aboveDwell = 0, belowDwell = 0;

    for (const fix of fixations) {
      const py = fix.cy * viewH;
      if (py <= viewH) {
        aboveFold++;
        aboveDwell += fix.duration;
      } else {
        belowFold++;
        belowDwell += fix.duration;
      }
    }

    return {
      aboveFoldFixations: aboveFold,
      belowFoldFixations: belowFold,
      aboveFoldDwell: aboveDwell,
      belowFoldDwell: belowDwell,
      aboveFoldPercent: fixations.length > 0 ? Math.round(aboveFold / fixations.length * 100) : 0,
    };
  }

  return {
    detectFixations,
    buildScanpath,
    detectAOIs,
    analyzeAOIs,
    computeEngagement,
    analyzeFoldAttention,
    detectScanPattern,
    FIXATION_DISPERSION_PX,
    FIXATION_MIN_DURATION_MS,
  };
})();

// Export for content script context
if (typeof window !== 'undefined') {
  window.EyedAnalytics = EyedAnalytics;
}
