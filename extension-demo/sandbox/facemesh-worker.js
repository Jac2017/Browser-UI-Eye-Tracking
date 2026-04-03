let faceMesh = null;
let ready = false;
let processing = false;
const canvas = document.getElementById('frame-canvas');
const ctx = canvas.getContext('2d');
let frameCount = 0;
let faceCount = 0;

// MessagePort for communicating with parent (received via first message)
let parentPort = null;

function sendToParent(msg) {
  if (parentPort) {
    parentPort.postMessage(msg);
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

// Listen for the MessagePort from parent (sent via postMessage transfer).
// Always accept the latest port to stay in sync with the parent.
window.addEventListener('message', (event) => {
  if (event.ports && event.ports.length > 0) {
    parentPort = event.ports[0];
    console.log('[Sandbox] Received MessagePort from parent');

    // Set up message handler on the port
    parentPort.onmessage = async (portEvent) => {
      const data = portEvent.data;
      if (!data || !data.type) return;

      if (data.type === 'process-frame' && ready && faceMesh && !processing) {
        processing = true;
        try {
          if (canvas.width !== data.width || canvas.height !== data.height) {
            canvas.width = data.width;
            canvas.height = data.height;
          }
          const imageData = new ImageData(new Uint8ClampedArray(data.pixels), data.width, data.height);
          ctx.putImageData(imageData, 0, 0);
          frameCount++;
          await faceMesh.send({ image: canvas });
        } catch (e) {
          console.warn('[Sandbox] Frame error:', e);
          sendToParent({ type: 'facemesh-results', landmarks: null });
        }
        processing = false;
      }
    };

    // If already ready when port arrives, notify parent immediately
    if (ready) {
      sendToParent({ type: 'facemesh-ready' });
    }
  }
});

init();
