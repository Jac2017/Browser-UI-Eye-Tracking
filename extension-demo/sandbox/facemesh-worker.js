let faceMesh = null;
let ready = false;
let processing = false;
const canvas = document.getElementById('frame-canvas');
const ctx = canvas.getContext('2d');
let frameCount = 0;
let faceCount = 0;

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
      window.parent.postMessage({ type: 'facemesh-results', landmarks: landmarks }, '*');
    });

    faceMesh.initialize().then(() => {
      ready = true;
      window.parent.postMessage({ type: 'facemesh-ready' }, '*');
      console.log('[Sandbox] FaceMesh initialized OK');
    }).catch((err) => {
      window.parent.postMessage({ type: 'facemesh-error', error: err.message }, '*');
      console.error('[Sandbox] FaceMesh init error:', err);
    });
  } catch (err) {
    window.parent.postMessage({ type: 'facemesh-error', error: err.message }, '*');
    console.error('[Sandbox] FaceMesh constructor error:', err);
  }
}

window.addEventListener('message', async (event) => {
  if (!event.data || !event.data.type) return;

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
      window.parent.postMessage({ type: 'facemesh-results', landmarks: null }, '*');
    }
    processing = false;
  }

  if (event.data.type === 'ping') {
    window.parent.postMessage({
      type: 'pong',
      ready: ready,
      frames: frameCount,
      faces: faceCount
    }, '*');
  }
});

init();
