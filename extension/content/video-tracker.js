/**
 * EyeD Video Tracker
 * Detects video/media elements and correlates gaze data with video playback time.
 * Enables temporal heatmaps: "where was the user looking at 20s into the video?"
 */

const EyedVideoTracker = (() => {
  'use strict';

  const state = {
    videos: [],         // Tracked video elements
    activeVideo: null,  // Currently playing video
    pollInterval: null,
    listeners: [],
  };

  /**
   * Detect and start monitoring all video elements on the page.
   */
  function init() {
    scanForVideos();

    // Re-scan periodically for dynamically inserted videos (YouTube, SPA)
    const observer = new MutationObserver(() => {
      scanForVideos();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Poll active video state
    state.pollInterval = setInterval(pollActiveVideo, 200);
  }

  function scanForVideos() {
    // Direct video elements
    const videoEls = document.querySelectorAll('video');
    for (const video of videoEls) {
      if (!state.videos.includes(video)) {
        state.videos.push(video);
        attachVideoListeners(video);
      }
    }

    // YouTube embeds (iframe-based) - detect via URL
    const iframes = document.querySelectorAll('iframe[src*="youtube"], iframe[src*="vimeo"], iframe[src*="player"]');
    for (const iframe of iframes) {
      if (!iframe.__eyedTracked) {
        iframe.__eyedTracked = true;
        // We can't access iframe video.currentTime due to cross-origin,
        // but we can track that the user is gazing at the iframe area
        state.videos.push(iframe);
      }
    }
  }

  function attachVideoListeners(video) {
    video.addEventListener('play', () => {
      state.activeVideo = video;
      notifyListeners('video_play', getVideoInfo(video));
    });

    video.addEventListener('pause', () => {
      notifyListeners('video_pause', getVideoInfo(video));
    });

    video.addEventListener('seeking', () => {
      notifyListeners('video_seek', getVideoInfo(video));
    });

    video.addEventListener('ended', () => {
      state.activeVideo = null;
      notifyListeners('video_ended', getVideoInfo(video));
    });
  }

  function getVideoInfo(video) {
    const rect = video.getBoundingClientRect();
    return {
      currentTime: video.currentTime || 0,
      duration: video.duration || 0,
      paused: video.paused,
      src: video.currentSrc || video.src || '',
      rect: {
        x: rect.x, y: rect.y,
        width: rect.width, height: rect.height,
        pageX: rect.x + window.scrollX,
        pageY: rect.y + window.scrollY,
      },
    };
  }

  function pollActiveVideo() {
    // Find any playing video
    for (const v of state.videos) {
      if (v.tagName === 'VIDEO' && !v.paused && !v.ended) {
        state.activeVideo = v;
        return;
      }
    }
    state.activeVideo = null;
  }

  /**
   * Get the current video playback timestamp (if any video is playing).
   * Returns null if no video is active.
   */
  function getCurrentVideoTime() {
    if (!state.activeVideo) return null;
    if (state.activeVideo.tagName === 'VIDEO') {
      return {
        currentTime: state.activeVideo.currentTime,
        duration: state.activeVideo.duration,
        videoRect: state.activeVideo.getBoundingClientRect(),
      };
    }
    return null;
  }

  /**
   * Check if a gaze point falls within any video element's bounds.
   */
  function isGazeOnVideo(viewX, viewY) {
    for (const v of state.videos) {
      const rect = v.getBoundingClientRect();
      if (viewX >= rect.x && viewX <= rect.x + rect.width &&
          viewY >= rect.y && viewY <= rect.y + rect.height) {
        return {
          video: v,
          currentTime: v.tagName === 'VIDEO' ? v.currentTime : null,
          duration: v.tagName === 'VIDEO' ? v.duration : null,
        };
      }
    }
    return null;
  }

  /**
   * Filter gaze points by video time range.
   * @param {Array} points - gaze points with videoTime property
   * @param {number} startTime - start of time range (seconds)
   * @param {number} endTime - end of time range (seconds)
   */
  function filterByVideoTime(points, startTime, endTime) {
    return points.filter(p =>
      p.videoTime != null && p.videoTime >= startTime && p.videoTime <= endTime
    );
  }

  /**
   * Group gaze points into time buckets for temporal heatmap.
   * @param {Array} points - gaze points with videoTime
   * @param {number} bucketSize - seconds per bucket
   */
  function bucketByVideoTime(points, bucketSize = 5) {
    const buckets = {};
    for (const p of points) {
      if (p.videoTime == null) continue;
      const bucket = Math.floor(p.videoTime / bucketSize) * bucketSize;
      const key = `${bucket}-${bucket + bucketSize}`;
      if (!buckets[key]) buckets[key] = { start: bucket, end: bucket + bucketSize, points: [] };
      buckets[key].points.push(p);
    }
    return Object.values(buckets).sort((a, b) => a.start - b.start);
  }

  /**
   * Generate a temporal attention summary for a video.
   * Shows attention intensity over the video timeline.
   */
  function generateVideoAttentionTimeline(points, duration, bucketSize = 2) {
    if (!duration || duration === 0) return [];

    const timeline = [];
    for (let t = 0; t < duration; t += bucketSize) {
      const bucketPts = points.filter(p =>
        p.videoTime != null && p.videoTime >= t && p.videoTime < t + bucketSize
      );

      // Compute attention metrics for this time bucket
      const onVideo = bucketPts.filter(p => p.onVideo);
      const offVideo = bucketPts.length - onVideo.length;

      timeline.push({
        startTime: t,
        endTime: Math.min(t + bucketSize, duration),
        totalGazePoints: bucketPts.length,
        onVideoPoints: onVideo.length,
        offVideoPoints: offVideo,
        attentionRatio: bucketPts.length > 0 ? onVideo.length / bucketPts.length : 0,
        // Average gaze position within video bounds (normalized 0-1 within video rect)
        avgGazeX: onVideo.length > 0 ? onVideo.reduce((s, p) => s + (p.videoRelX || 0), 0) / onVideo.length : null,
        avgGazeY: onVideo.length > 0 ? onVideo.reduce((s, p) => s + (p.videoRelY || 0), 0) / onVideo.length : null,
      });
    }

    return timeline;
  }

  function onUpdate(callback) {
    state.listeners.push(callback);
  }

  function notifyListeners(event, data) {
    for (const cb of state.listeners) {
      try { cb(event, data); } catch (e) { /* ignore */ }
    }
  }

  function getTrackedVideos() {
    return state.videos.map(v => {
      const rect = v.getBoundingClientRect();
      return {
        tagName: v.tagName,
        src: v.currentSrc || v.src || '',
        currentTime: v.currentTime || 0,
        duration: v.duration || 0,
        paused: v.paused !== false,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
    });
  }

  return {
    init,
    getCurrentVideoTime,
    isGazeOnVideo,
    filterByVideoTime,
    bucketByVideoTime,
    generateVideoAttentionTimeline,
    getTrackedVideos,
    onUpdate,
  };
})();

if (typeof window !== 'undefined') {
  window.EyedVideoTracker = EyedVideoTracker;
}
