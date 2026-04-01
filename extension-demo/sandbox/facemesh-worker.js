let faceMesh = null;
let ready = false;
let processing = false;
const canvas = document.getElementById('frame-canvas');
const ctx = canvas.getContext('2d');
let frameCount = 0;
let faceCount = 0;

// Store reference to parent window - must come from event.source
// (manifest-sandboxed pages cannot use window.parent.postMessage)
let parentSource = null;
let parentOrigin = '*';

function sendToParent(msg) {
  if (parentSource) {
    parentSource.postMessage(msg, parentOrigin);
  }
}

function init() {
  try {
    faceMesh = new FaceMesh({
      locateFile: (file) => '../lib/' + file
    });

    faceMesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

    faceMesh.onResults((results) => {
      const landmarks = (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0)
        ? results.multiFaceLandmarks[0]
        : null;
      if (landmarks) faceCount++;
      sendToParent({ type: 'facemesh-results', landmarks: landmarks });
    });

    faceMesh.initialize().then(() => {
      ready = true;
      console.log('[Sandbox] FaceMesh initialized OK');
      // If parent already connected, notify immediately
      sendToParent({ type: 'facemesh-ready' });
    }).catch((err) => {
      console.error('[Sandbox] FaceMesh init error:', err);
      sendToParent({ type: 'facemesh-error', error: err.message });
    });
  } catch (err) {
    console.error('[Sandbox] FaceMesh constructor error:', err);
    sendToParent({ type: 'facemesh-error', error: err.message });
  }
}

window.addEventListener('message', async (event) => {
  if (!event.data || !event.data.type) return;

  // Capture parent reference from first message
  if (!parentSource && event.source) {
    parentSource = event.source;
    parentOrigin = event.origin || '*';
    console.log('[Sandbox] Parent connected, origin:', parentOrigin);
  }

  if (event.data.type === 'init' || event.data.type === 'ping') {
    // Parent is asking for status — reply with current state
    sendToParent({
      type: ready ? 'facemesh-ready' : 'facemesh-loading',
      ready: ready,
      frames: frameCount,
      faces: faceCount
    });
    return;
  }

  if (event.data.type === 'process-frame' && ready && faceMesh && !processing) {
    processing = true;
    try {
      const d = event.data;
      if (canvas.width !== d.width || canvas.height !== d.height) {
        canvas.width = d.width;
        canvas.height = d.height;
      }
      const imageData = new ImageData(new Uint8ClampedArray(d.pixels), d.width, d.height);
      ctx.putImageData(imageData, 0, 0);
      frameCount++;
      await faceMesh.send({ image: canvas });
    } catch (e) {
      console.warn('[Sandbox] Frame error:', e);
      sendToParent({ type: 'facemesh-results', landmarks: null });
    }
    processing = false;
  }
});

init();
