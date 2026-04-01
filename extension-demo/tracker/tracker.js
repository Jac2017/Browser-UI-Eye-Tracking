/**
 * EyeD Tracker - Core eye tracking engine
 * Adapted from HUE Vision (Browser-UI-Eye-Tracking)
 * Uses MediaPipe FaceMesh + TensorFlow.js for webcam-based gaze prediction.
 */

/* ========== STATE ========== */
const state = {
  webcamReady: false,
  faceDetected: false,
  modelTrained: false,
  tracking: false,
  calibrating: false,
  validating: false,
  autoCollecting: false,
  currentPosition: null,
  currentEyeRect: null,
  samples: { train: [], val: [] },
  sampleCount: 0,
  model: null,
  bestValLoss: Infinity,
  calibrationPoints: [],
  calibrationIndex: 0,
  autoCollectInterval: null,
  autoMoveHandler: null,
  trackingInterval: null,
  predicting: false,
  // Quality tracking
  recentPredictions: [],
  qualityScore: null,
  // Onboarding
  onboardStep: 0,
};

const EYE_CANVAS_W = 55;
const EYE_CANVAS_H = 25;
const TRAIN_SPLIT = 0.8;
const FACEMESH_LOAD_TIMEOUT_MS = 30000;

/* ========== DOM REFS ========== */
const $ = (sel) => document.querySelector(sel);
const webcamEl = $('#webcam');
const overlayEl = $('#overlay');
const eyesCanvas = $('#eyes');
const overlayCtx = overlayEl.getContext('2d');
const eyesCtx = eyesCanvas.getContext('2d');

/* ========== STATUS HELPERS ========== */
function setStatus(id, cls) {
  const dot = $(`#status-${id}`);
  if (dot) { dot.className = `status-dot ${cls}`; }
}

function setStatusText(text) {
  $('#status-text').textContent = text;
}

/* ========== MEDIAPIPE FACE MESH (via sandbox iframe) ========== */
let faceMeshReady = false;
let sandboxIframe = null;

function initFaceMesh() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('FaceMesh load timed out (30s). Sandbox may have failed.'));
    }, FACEMESH_LOAD_TIMEOUT_MS);

    sandboxIframe = document.getElementById('facemesh-sandbox');
    if (!sandboxIframe) {
      clearTimeout(timeout);
      reject(new Error('Sandbox iframe not found'));
      return;
    }

    console.log('[EyeD] Waiting for sandbox FaceMesh to initialize...');

    // Listen for messages from sandbox
    window.addEventListener('message', function onMsg(event) {
      if (!event.data || !event.data.type) return;

      if (event.data.type === 'facemesh-ready') {
        clearTimeout(timeout);
        faceMeshReady = true;
        console.log('[EyeD] Sandbox FaceMesh initialized successfully');
        resolve();
      } else if (event.data.type === 'facemesh-error') {
        clearTimeout(timeout);
        console.error('[EyeD] Sandbox FaceMesh error:', event.data.error);
        reject(new Error(event.data.error));
      } else if (event.data.type === 'facemesh-results') {
        onFaceMeshResults(event.data.landmarks);
      }
    });
  });
}

// Offscreen canvas for extracting video frame pixels
let _frameCanvas = null;
let _frameCtx = null;

function sendFrameToSandbox() {
  if (!sandboxIframe || !faceMeshReady) return Promise.resolve();
  try {
    const w = webcamEl.videoWidth || 640;
    const h = webcamEl.videoHeight || 480;
    if (!_frameCanvas) {
      _frameCanvas = document.createElement('canvas');
      _frameCtx = _frameCanvas.getContext('2d');
    }
    if (_frameCanvas.width !== w || _frameCanvas.height !== h) {
      _frameCanvas.width = w;
      _frameCanvas.height = h;
    }
    _frameCtx.drawImage(webcamEl, 0, 0, w, h);
    const imageData = _frameCtx.getImageData(0, 0, w, h);
    const buffer = imageData.data.buffer;
    sandboxIframe.contentWindow.postMessage(
      { type: 'process-frame', pixels: buffer, width: w, height: h },
      '*',
      [buffer]
    );
  } catch (e) {
    console.warn('[EyeD] sendFrameToSandbox error:', e);
  }
  return Promise.resolve();
}

function onFaceMeshResults(landmarks) {
  overlayCtx.clearRect(0, 0, overlayEl.width, overlayEl.height);

  if (landmarks && landmarks.length > 0) {
    state.currentPosition = landmarks;
    state.faceDetected = true;
    setStatus('face', 'on');

    drawFaceMesh(landmarks);
    extractEyeRegion(landmarks);
  } else {
    state.faceDetected = false;
    state.currentPosition = null;
    setStatus('face', 'off');
  }
}

function drawFaceMesh(landmarks) {
  const w = overlayEl.width;
  const h = overlayEl.height;

  overlayCtx.fillStyle = 'rgba(88, 166, 255, 0.7)';
  for (let i = 468; i < Math.min(478, landmarks.length); i++) {
    const lm = landmarks[i];
    overlayCtx.beginPath();
    overlayCtx.arc(lm.x * w, lm.y * h, 2, 0, Math.PI * 2);
    overlayCtx.fill();
  }

  const leftEyeIdx = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
  const rightEyeIdx = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398];

  overlayCtx.strokeStyle = 'rgba(88, 166, 255, 0.4)';
  overlayCtx.lineWidth = 1;

  for (const eyeIdx of [leftEyeIdx, rightEyeIdx]) {
    overlayCtx.beginPath();
    for (let i = 0; i < eyeIdx.length; i++) {
      const lm = landmarks[eyeIdx[i]];
      if (i === 0) overlayCtx.moveTo(lm.x * w, lm.y * h);
      else overlayCtx.lineTo(lm.x * w, lm.y * h);
    }
    overlayCtx.closePath();
    overlayCtx.stroke();
  }
}

function extractEyeRegion(landmarks) {
  const eyeIndices = [33, 133, 362, 263, 159, 386, 145, 374];
  let minX = 1, maxX = 0, minY = 1, maxY = 0;

  for (const idx of eyeIndices) {
    const lm = landmarks[idx];
    minX = Math.min(minX, lm.x);
    maxX = Math.max(maxX, lm.x);
    minY = Math.min(minY, lm.y);
    maxY = Math.max(maxY, lm.y);
  }

  const padX = (maxX - minX) * 0.3;
  const padY = (maxY - minY) * 0.5;
  minX = Math.max(0, minX - padX);
  maxX = Math.min(1, maxX + padX);
  minY = Math.max(0, minY - padY);
  maxY = Math.min(1, maxY + padY);

  const vw = webcamEl.videoWidth || 640;
  const vh = webcamEl.videoHeight || 480;

  const sx = minX * vw;
  const sy = minY * vh;
  const sw = (maxX - minX) * vw;
  const sh = (maxY - minY) * vh;

  state.currentEyeRect = { x: sx, y: sy, w: sw, h: sh, nx: minX, ny: minY, nw: maxX - minX, nh: maxY - minY };

  try {
    eyesCtx.drawImage(webcamEl, sx, sy, sw, sh, 0, 0, EYE_CANVAS_W, EYE_CANVAS_H);
  } catch (e) { /* video not ready */ }
}

/* ========== WEBCAM ========== */
async function initWebcam() {
  try {
    setStatusText('Requesting webcam...');
    const constraints = {
      video: {
        facingMode: 'user',
        width: { ideal: 1280, min: 320 },
        height: { ideal: 720, min: 240 },
      },
      audio: false,
    };

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      // Fallback to basic constraints for older devices
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    }

    webcamEl.srcObject = stream;
    await webcamEl.play();

    webcamEl.addEventListener('loadedmetadata', () => {
      overlayEl.width = webcamEl.videoWidth;
      overlayEl.height = webcamEl.videoHeight;
    });

    state.webcamReady = true;
    setStatus('webcam', 'on');
    setStatusText('Webcam active');

    startProcessingLoop();
  } catch (err) {
    console.error('Webcam error:', err);
    setStatus('webcam', 'error');
    setStatusText('Webcam access denied — check browser permissions');
  }
}

function startProcessingLoop() {
  let processing = false;
  async function processFrame() {
    if (state.webcamReady && faceMeshReady && !processing && webcamEl.readyState >= 2) {
      processing = true;
      try {
        await sendFrameToSandbox();
      } catch (e) {
        console.warn('FaceMesh frame error:', e);
      }
      processing = false;
    }
    requestAnimationFrame(processFrame);
  }
  processFrame();
}

/* ========== DATASET ========== */
function getEyeImage() {
  const imageData = eyesCtx.getImageData(0, 0, EYE_CANVAS_W, EYE_CANVAS_H);
  const data = imageData.data;
  const grayscale = new Array(EYE_CANVAS_W * EYE_CANVAS_H);

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    const gray = Math.pow(0.2126 * r + 0.7152 * g + 0.0722 * b, 1 / 2.2);
    grayscale[i / 4] = gray;
  }

  return grayscale;
}

function getMetaInfo() {
  if (!state.currentEyeRect) return [0.5, 0.5, 0.2, 0.1];
  const r = state.currentEyeRect;
  return [r.nx + r.nw / 2, r.ny + r.nh / 2, r.nw, r.nh];
}

function captureExample(targetX, targetY) {
  if (!state.faceDetected || !state.currentEyeRect) return false;

  const image = getEyeImage();
  if (image.length !== EYE_CANVAS_W * EYE_CANVAS_H) return false;

  const meta = getMetaInfo();
  const target = [targetX, targetY];
  const sample = { image, meta, target };

  if (Math.random() < TRAIN_SPLIT) {
    state.samples.train.push(sample);
  } else {
    state.samples.val.push(sample);
  }
  state.sampleCount++;

  updateProgress();
  return true;
}

function updateProgress() {
  const pct = Math.min(100, (state.sampleCount / 30) * 100);
  $('#progress-fill').style.width = pct + '%';
  $('#progress-text').textContent = `${state.sampleCount} samples collected`;

  if (state.sampleCount >= 10) {
    $('#btn-train').disabled = false;
    $('#training-text').textContent = 'Ready to train';
  }
}

/* ========== MODEL ========== */
function createModel() {
  const imageInput = tf.input({ shape: [EYE_CANVAS_H, EYE_CANVAS_W, 1] });
  const metaInput = tf.input({ shape: [4] });

  let x = tf.layers.conv2d({ filters: 20, kernelSize: 5, activation: 'relu' }).apply(imageInput);
  x = tf.layers.maxPooling2d({ poolSize: 2 }).apply(x);
  x = tf.layers.conv2d({ filters: 40, kernelSize: 3, activation: 'relu' }).apply(x);
  x = tf.layers.maxPooling2d({ poolSize: 2 }).apply(x);
  x = tf.layers.flatten().apply(x);
  x = tf.layers.dropout({ rate: 0.2 }).apply(x);

  const combined = tf.layers.concatenate().apply([x, metaInput]);
  const dense1 = tf.layers.dense({ units: 64, activation: 'relu' }).apply(combined);
  const output = tf.layers.dense({ units: 2, activation: 'tanh' }).apply(dense1);

  const model = tf.model({ inputs: [imageInput, metaInput], outputs: output });
  model.compile({ optimizer: tf.train.adam(0.001), loss: 'meanSquaredError' });
  return model;
}

function prepareTensors(samples) {
  if (samples.length === 0) return null;

  const images = [];
  const metas = [];
  const targets = [];

  for (const s of samples) {
    // Validate sample dimensions
    if (!s.image || s.image.length !== EYE_CANVAS_W * EYE_CANVAS_H) continue;
    if (!s.meta || s.meta.length !== 4) continue;
    if (!s.target || s.target.length !== 2) continue;

    const img = [];
    for (let y = 0; y < EYE_CANVAS_H; y++) {
      const row = [];
      for (let x = 0; x < EYE_CANVAS_W; x++) {
        row.push([s.image[y * EYE_CANVAS_W + x] || 0]);
      }
      img.push(row);
    }
    images.push(img);
    metas.push(s.meta);
    targets.push([s.target[0] * 2 - 1, s.target[1] * 2 - 1]);
  }

  if (images.length === 0) return null;

  return {
    images: tf.tensor4d(images),
    metas: tf.tensor2d(metas),
    targets: tf.tensor2d(targets),
  };
}

async function trainModel() {
  if (state.samples.train.length < 5) {
    setStatusText('Need more training data');
    return;
  }

  $('#btn-train').disabled = true;
  $('#training-text').textContent = 'Training...';
  $('#loss-display').style.display = 'block';
  setStatusText('Training model...');

  // Ensure validation set has data - clone arrays to avoid mutation during training
  const trainSamples = [...state.samples.train];
  const valSamples = [...state.samples.val];

  if (valSamples.length < 2) {
    while (valSamples.length < 2 && trainSamples.length > 5) {
      valSamples.push(trainSamples.pop());
    }
  }

  const trainData = prepareTensors(trainSamples);
  const valData = prepareTensors(valSamples);

  if (!trainData) {
    setStatusText('Training data invalid');
    $('#btn-train').disabled = false;
    return;
  }

  // Dispose old model before creating new one
  if (state.model) {
    state.model.dispose();
    state.model = null;
  }
  state.model = createModel();
  state.bestValLoss = Infinity;

  const epochs = 30;

  try {
    await state.model.fit([trainData.images, trainData.metas], trainData.targets, {
      epochs,
      batchSize: Math.min(32, trainSamples.length),
      validationData: valData ? [[valData.images, valData.metas], valData.targets] : undefined,
      callbacks: {
        onEpochEnd: (epoch, logs) => {
          const loss = logs.loss.toFixed(5);
          const valLoss = logs.val_loss ? logs.val_loss.toFixed(5) : '-';
          $('#loss-value').textContent = `${loss} (val: ${valLoss})`;
          $('#training-text').textContent = `Epoch ${epoch + 1}/${epochs}`;

          if (logs.val_loss && logs.val_loss < state.bestValLoss) {
            state.bestValLoss = logs.val_loss;
          }
        }
      }
    });

    state.modelTrained = true;
    setStatus('model', 'on');
    setStatusText('Model trained');
    $('#training-text').textContent = 'Training complete!';
    $('#btn-start-tracking').disabled = false;
    $('#btn-validate').disabled = false;
    $('#btn-save-model').disabled = false;

    chrome.runtime.sendMessage({ type: 'MODEL_READY' }).catch(() => {});
  } catch (err) {
    console.error('Training error:', err);
    setStatusText('Training failed');
    $('#training-text').textContent = 'Training failed: ' + err.message;
  } finally {
    if (trainData) {
      trainData.images.dispose();
      trainData.metas.dispose();
      trainData.targets.dispose();
    }
    if (valData) {
      valData.images.dispose();
      valData.metas.dispose();
      valData.targets.dispose();
    }
    $('#btn-train').disabled = false;
  }
}

function getPrediction() {
  if (!state.model || !state.faceDetected) return null;

  return tf.tidy(() => {
    const image = getEyeImage();
    if (image.length !== EYE_CANVAS_W * EYE_CANVAS_H) return null;

    const meta = getMetaInfo();

    const imgArr = [];
    for (let y = 0; y < EYE_CANVAS_H; y++) {
      const row = [];
      for (let x = 0; x < EYE_CANVAS_W; x++) {
        row.push([image[y * EYE_CANVAS_W + x]]);
      }
      imgArr.push(row);
    }

    const imgTensor = tf.tensor4d([imgArr]);
    const metaTensor = tf.tensor2d([meta]);

    const prediction = state.model.predict([imgTensor, metaTensor]);
    const [px, py] = prediction.dataSync();

    return { x: (px + 1) / 2, y: (py + 1) / 2 };
  });
}

/* ========== CALIBRATION ========== */
const QUICK_POINTS = [
  { x: 0.5, y: 0.5 },
  { x: 0.1, y: 0.1 },
  { x: 0.9, y: 0.1 },
  { x: 0.1, y: 0.9 },
  { x: 0.9, y: 0.9 },
];

const FULL_POINTS = [
  { x: 0.5, y: 0.5 },
  { x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.9, y: 0.1 },
  { x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 },
  { x: 0.1, y: 0.9 }, { x: 0.5, y: 0.9 }, { x: 0.9, y: 0.9 },
  { x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 },
  { x: 0.3, y: 0.7 }, { x: 0.7, y: 0.7 },
];

function startCalibration(points) {
  if (!state.faceDetected) {
    setStatusText('No face detected — look at the camera first');
    return;
  }
  state.calibrating = true;
  state.calibrationPoints = points;
  state.calibrationIndex = 0;

  $('#calibration-overlay').style.display = 'flex';
  $('#btn-cancel-calibration').style.display = '';
  showCalibrationTarget();
}

function showCalibrationTarget() {
  if (state.calibrationIndex >= state.calibrationPoints.length) {
    endCalibration();
    return;
  }

  const point = state.calibrationPoints[state.calibrationIndex];
  const target = $('#calibration-target');

  target.style.left = (point.x * 100) + '%';
  target.style.top = (point.y * 100) + '%';

  $('#calibration-instruction').textContent =
    `Point ${state.calibrationIndex + 1} of ${state.calibrationPoints.length} — Look at target and tap/click`;
}

function onCalibrationClick(e) {
  if (!state.calibrating) return;

  const point = state.calibrationPoints[state.calibrationIndex];

  let captured = 0;
  for (let i = 0; i < 3; i++) {
    if (captureExample(point.x, point.y)) captured++;
  }

  if (captured > 0) {
    state.calibrationIndex++;
    showCalibrationTarget();
  } else {
    $('#calibration-instruction').textContent = 'Face not detected — look at camera, then tap target';
  }
}

function endCalibration() {
  state.calibrating = false;
  state.calibrationIndex = 0;
  state.calibrationPoints = [];
  $('#calibration-overlay').style.display = 'none';

  // Reset all calibration button states
  $('#btn-start-calibration').disabled = false;
  $('#btn-quick-calibrate').disabled = false;
  $('#btn-full-calibrate').disabled = false;

  setStatusText(`Calibration done — ${state.sampleCount} samples`);
}

/* ========== AUTO-COLLECT ========== */
function toggleAutoCollect() {
  if (state.autoCollecting) {
    stopAutoCollect();
    return;
  }

  state.autoCollecting = true;
  $('#btn-auto-collect').textContent = 'Stop Auto';
  $('#btn-auto-collect').classList.add('danger');
  setStatusText('Auto-collecting — move your gaze around the screen');

  let lastPos = { x: 0.5, y: 0.5 };

  const moveHandler = (e) => {
    const touch = e.touches ? e.touches[0] : e;
    if (!touch) return;
    lastPos.x = touch.clientX / window.innerWidth;
    lastPos.y = touch.clientY / window.innerHeight;
  };

  document.addEventListener('mousemove', moveHandler);
  document.addEventListener('touchmove', moveHandler, { passive: true });

  state.autoMoveHandler = moveHandler;
  state.autoCollectInterval = setInterval(() => {
    if (state.faceDetected) {
      captureExample(lastPos.x, lastPos.y);
    }
  }, 1500);
}

function stopAutoCollect() {
  clearInterval(state.autoCollectInterval);
  state.autoCollectInterval = null;

  // Clean up event listeners
  if (state.autoMoveHandler) {
    document.removeEventListener('mousemove', state.autoMoveHandler);
    document.removeEventListener('touchmove', state.autoMoveHandler);
    state.autoMoveHandler = null;
  }

  state.autoCollecting = false;
  $('#btn-auto-collect').textContent = 'Auto-Collect';
  $('#btn-auto-collect').classList.remove('danger');
  setStatusText('Auto-collect stopped');
}

/* ========== TRACKING ========== */
function startTracking() {
  if (!state.modelTrained) return;

  state.tracking = true;
  $('#btn-start-tracking').style.display = 'none';
  $('#btn-stop-tracking').style.display = '';
  setStatusText('Tracking active — gaze data streaming');

  state.trackingInterval = setInterval(async () => {
    if (!state.faceDetected || state.predicting) return;

    // During validation, collect predictions instead of broadcasting
    if (state.validating) {
      collectValidationPrediction();
      return;
    }

    if (!state.tracking) return;

    state.predicting = true;
    try {
      const pred = getPrediction();
      if (pred) {
        updateQualityIndicator(pred);
        chrome.runtime.sendMessage({
          type: 'GAZE_DATA',
          x: pred.x,
          y: pred.y,
          timestamp: Date.now(),
          confidence: state.qualityScore === 'good' ? 1 : state.qualityScore === 'fair' ? 0.6 : 0.3,
        }).catch(() => {});
      }
    } finally {
      state.predicting = false;
    }
  }, 50);

  chrome.runtime.sendMessage({ type: 'TRACKING_STARTED' }).catch(() => {});
}

function stopTracking() {
  state.tracking = false;
  if (state.trackingInterval) {
    clearInterval(state.trackingInterval);
    state.trackingInterval = null;
  }
  state.recentPredictions = [];
  state.qualityScore = null;
  const badge = $('#quality-badge');
  badge.classList.add('hidden');
  badge.classList.remove('good', 'fair', 'poor');
  badge.textContent = '--';

  $('#btn-start-tracking').style.display = '';
  $('#btn-stop-tracking').style.display = 'none';
  setStatusText('Tracking stopped');

  chrome.runtime.sendMessage({ type: 'TRACKING_STOPPED' }).catch(() => {});
}

/* ========== MODEL PERSISTENCE ========== */
async function saveModel() {
  if (!state.model) return;
  try {
    // Check storage quota before saving
    const usage = await chrome.storage.local.getBytesInUse(null);
    const dataStr = JSON.stringify(state.samples);
    if (usage + dataStr.length > 10 * 1024 * 1024) {
      setStatusText('Storage nearly full — export data instead');
      return;
    }

    await state.model.save('indexeddb://eyed-model-v1');
    await chrome.storage.local.set({ eyedDataset: dataStr, eyedSampleCount: state.sampleCount });
    setStatusText('Model & data saved');
  } catch (err) {
    console.error('Save error:', err);
    setStatusText('Save failed: ' + err.message);
  }
}

let modelLoadInProgress = false;

async function loadModel() {
  if (modelLoadInProgress) {
    setStatusText('Model load already in progress');
    return;
  }
  modelLoadInProgress = true;
  try {
    const loadedModel = await tf.loadLayersModel('indexeddb://eyed-model-v1');
    loadedModel.compile({ optimizer: tf.train.adam(0.001), loss: 'meanSquaredError' });

    // Validate model outputs correct shape
    const testImg = tf.zeros([1, EYE_CANVAS_H, EYE_CANVAS_W, 1]);
    const testMeta = tf.zeros([1, 4]);
    const testOut = loadedModel.predict([testImg, testMeta]);
    const shape = testOut.shape;
    testImg.dispose();
    testMeta.dispose();
    testOut.dispose();

    if (shape[1] !== 2) {
      loadedModel.dispose();
      throw new Error('Incompatible model version');
    }

    // Replace existing model atomically
    const oldModel = state.model;
    state.model = loadedModel;
    if (oldModel) oldModel.dispose();

    const result = await chrome.storage.local.get(['eyedDataset', 'eyedSampleCount']);
    if (result.eyedDataset) {
      try {
        const parsed = JSON.parse(result.eyedDataset);
        if (parsed.train && Array.isArray(parsed.train)) {
          state.samples = parsed;
          state.sampleCount = result.eyedSampleCount || 0;
          updateProgress();
        }
      } catch (e) { /* corrupted dataset, skip */ }
    }

    state.modelTrained = true;
    setStatus('model', 'on');
    setStatusText('Model loaded');
    $('#training-text').textContent = 'Model loaded from storage';
    $('#btn-start-tracking').disabled = false;
    $('#btn-validate').disabled = false;
    $('#btn-save-model').disabled = false;
    chrome.runtime.sendMessage({ type: 'MODEL_READY' }).catch(() => {});
  } catch (err) {
    // Cleanup on partial load failure
    if (state.model && !state.modelTrained) {
      state.model.dispose();
      state.model = null;
    }
    console.error('Load error:', err);
    setStatusText('No saved model found');
  } finally {
    modelLoadInProgress = false;
  }
}

async function exportData() {
  const data = {
    version: 1,
    samples: state.samples,
    sampleCount: state.sampleCount,
    exportDate: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `eyed-data-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importData() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);

        // Validate schema
        if (!data.samples || !Array.isArray(data.samples.train) || !Array.isArray(data.samples.val)) {
          setStatusText('Import failed — invalid file format');
          return;
        }

        // Validate individual samples (including NaN/Infinity checks to prevent tensor corruption)
        function isValidSample(s) {
          if (!Array.isArray(s.image) || s.image.length !== EYE_CANVAS_W * EYE_CANVAS_H) return false;
          if (!Array.isArray(s.meta) || s.meta.length !== 4) return false;
          if (!Array.isArray(s.target) || s.target.length !== 2) return false;
          // Reject NaN/Infinity values that would corrupt training
          for (const v of s.image) { if (typeof v !== 'number' || !isFinite(v)) return false; }
          for (const v of s.meta) { if (typeof v !== 'number' || !isFinite(v)) return false; }
          for (const v of s.target) { if (typeof v !== 'number' || !isFinite(v) || v < 0 || v > 1) return false; }
          return true;
        }
        const validTrain = data.samples.train.filter(isValidSample);
        const validVal = data.samples.val.filter(isValidSample);

        state.samples = { train: validTrain, val: validVal };
        state.sampleCount = validTrain.length + validVal.length;
        updateProgress();
        setStatusText(`Imported ${state.sampleCount} valid samples`);
      } catch (err) {
        setStatusText('Import failed — corrupted file');
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

function resetAll() {
  if (!confirm('Reset all data and model? This cannot be undone.')) return;

  // Stop tracking first
  if (state.tracking) stopTracking();
  if (state.autoCollecting) stopAutoCollect();

  if (state.model) state.model.dispose();
  state.model = null;
  state.modelTrained = false;
  state.samples = { train: [], val: [] };
  state.sampleCount = 0;
  state.bestValLoss = Infinity;

  setStatus('model', 'off');
  updateProgress();
  $('#btn-train').disabled = true;
  $('#btn-start-tracking').disabled = true;
  $('#btn-save-model').disabled = true;
  $('#training-text').textContent = 'Collect calibration data first';
  $('#loss-display').style.display = 'none';
  setStatusText('Reset complete');

  chrome.storage.local.remove(['eyedDataset', 'eyedSampleCount']);
  tf.io.removeModel('indexeddb://eyed-model-v1').catch(() => {});
}

/* ========== CONSENT FLOW ========== */
function initConsent() {
  const consentOverlay = $('#consent-overlay');
  const checkbox = $('#consent-checkbox');
  const btnConsent = $('#btn-consent');
  const btnDecline = $('#btn-decline');

  checkbox.addEventListener('change', () => {
    btnConsent.disabled = !checkbox.checked;
  });

  btnConsent.addEventListener('click', () => {
    // Store consent in chrome.storage.local (tamper-resistant vs localStorage)
    chrome.storage.local.set({
      _eyedConsent: true,
      _eyedConsentDate: new Date().toISOString(),
    });
    consentOverlay.style.display = 'none';
    proceedAfterConsent();
  });

  btnDecline.addEventListener('click', () => {
    chrome.storage.local.set({ _eyedConsent: false });
    consentOverlay.style.display = 'none';
    setStatusText('Webcam access declined — reload to try again');
    $('#app').style.opacity = '0.5';
    $('#app').style.pointerEvents = 'none';
  });
}

/* ========== ONBOARDING ========== */
function initOnboarding() {
  const overlay = $('#onboarding-overlay');
  const steps = overlay.querySelectorAll('.onboard-step');
  const dots = overlay.querySelectorAll('.dot');
  const btnNext = $('#btn-onboard-next');
  const btnSkip = $('#btn-onboard-skip');

  function showStep(idx) {
    state.onboardStep = idx;
    steps.forEach((s, i) => s.classList.toggle('active', i === idx));
    dots.forEach((d, i) => d.classList.toggle('active', i === idx));
    btnNext.textContent = idx === steps.length - 1 ? 'Get Started' : 'Next';
  }

  btnNext.addEventListener('click', () => {
    if (state.onboardStep >= steps.length - 1) {
      finishOnboarding();
    } else {
      showStep(state.onboardStep + 1);
    }
  });

  btnSkip.addEventListener('click', finishOnboarding);

  dots.forEach((dot) => {
    dot.addEventListener('click', () => {
      showStep(parseInt(dot.dataset.dot, 10));
    });
  });

  function finishOnboarding() {
    chrome.storage.local.set({ _eyedOnboarded: true });
    overlay.style.display = 'none';
  }
}

/* ========== ACCURACY VALIDATION ========== */
const VALIDATION_POINTS = [
  { x: 0.5, y: 0.5 },
  { x: 0.2, y: 0.2 },
  { x: 0.8, y: 0.2 },
  { x: 0.2, y: 0.8 },
  { x: 0.8, y: 0.8 },
];

let validationIndex = 0;
let validationResults = [];
let validationTimer = null;
let validationPredictions = [];

function startValidation() {
  if (!state.modelTrained || !state.faceDetected) {
    setStatusText('Need trained model and face detected to validate');
    return;
  }

  state.validating = true;
  validationIndex = 0;
  validationResults = [];
  validationPredictions = [];

  $('#validation-overlay').style.display = 'flex';
  $('#val-total').textContent = VALIDATION_POINTS.length;
  showValidationTarget();
}

function showValidationTarget() {
  if (validationIndex >= VALIDATION_POINTS.length) {
    endValidation();
    return;
  }

  const point = VALIDATION_POINTS[validationIndex];
  const target = $('#validation-target');
  target.style.left = (point.x * 100) + '%';
  target.style.top = (point.y * 100) + '%';
  $('#val-current').textContent = validationIndex + 1;
  $('#validation-instruction').textContent = `Look at the blue target (point ${validationIndex + 1} of ${VALIDATION_POINTS.length})`;

  validationPredictions = [];

  // Collect predictions for 2 seconds, then move to next
  validationTimer = setTimeout(() => {
    // Average the collected predictions
    if (validationPredictions.length > 0) {
      const avgX = validationPredictions.reduce((s, p) => s + p.x, 0) / validationPredictions.length;
      const avgY = validationPredictions.reduce((s, p) => s + p.y, 0) / validationPredictions.length;
      validationResults.push({
        target: point,
        predicted: { x: avgX, y: avgY },
        samples: validationPredictions.length,
      });
    }
    validationIndex++;
    showValidationTarget();
  }, 2000);
}

function collectValidationPrediction() {
  if (!state.validating || !state.faceDetected) return;
  const pred = getPrediction();
  if (pred) {
    validationPredictions.push(pred);
  }
}

function endValidation() {
  state.validating = false;
  if (validationTimer) { clearTimeout(validationTimer); validationTimer = null; }
  $('#validation-overlay').style.display = 'none';

  if (validationResults.length === 0) {
    setStatusText('Validation failed — no predictions collected');
    return;
  }

  // Compute average pixel error
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let totalError = 0;

  for (const r of validationResults) {
    const dx = (r.predicted.x - r.target.x) * vw;
    const dy = (r.predicted.y - r.target.y) * vh;
    totalError += Math.sqrt(dx * dx + dy * dy);
  }

  const avgError = totalError / validationResults.length;
  const accuracyDisplay = $('#accuracy-result');
  const accuracyValue = $('#accuracy-value');
  const accuracyDetail = $('#accuracy-detail');

  accuracyDisplay.style.display = 'block';

  if (avgError < 60) {
    accuracyValue.textContent = 'Good';
    accuracyValue.className = 'accuracy-value';
    accuracyDetail.textContent = `~${Math.round(avgError)}px avg error`;
  } else if (avgError < 120) {
    accuracyValue.textContent = 'Fair';
    accuracyValue.className = 'accuracy-value fair';
    accuracyDetail.textContent = `~${Math.round(avgError)}px avg error — recalibrate for better results`;
  } else {
    accuracyValue.textContent = 'Poor';
    accuracyValue.className = 'accuracy-value poor';
    accuracyDetail.textContent = `~${Math.round(avgError)}px avg error — recalibrate recommended`;
  }

  setStatusText(`Validation: ${Math.round(avgError)}px average error`);
}

function cancelValidation() {
  state.validating = false;
  if (validationTimer) { clearTimeout(validationTimer); validationTimer = null; }
  $('#validation-overlay').style.display = 'none';
  setStatusText('Validation cancelled');
}

/* ========== TRACKING QUALITY INDICATOR ========== */
const QUALITY_WINDOW = 20; // rolling window of predictions

function updateQualityIndicator(pred) {
  state.recentPredictions.push(pred);
  if (state.recentPredictions.length > QUALITY_WINDOW) {
    state.recentPredictions.shift();
  }

  if (state.recentPredictions.length < 5) return;

  // Compute variance of recent predictions (stability measure)
  const preds = state.recentPredictions;
  const avgX = preds.reduce((s, p) => s + p.x, 0) / preds.length;
  const avgY = preds.reduce((s, p) => s + p.y, 0) / preds.length;
  let variance = 0;
  for (const p of preds) {
    variance += (p.x - avgX) ** 2 + (p.y - avgY) ** 2;
  }
  variance /= preds.length;

  const badge = $('#quality-badge');
  badge.classList.remove('hidden', 'good', 'fair', 'poor');

  // Lower variance = better quality
  if (variance < 0.002) {
    badge.textContent = 'Good';
    badge.classList.add('good');
    state.qualityScore = 'good';
  } else if (variance < 0.008) {
    badge.textContent = 'Fair';
    badge.classList.add('fair');
    state.qualityScore = 'fair';
  } else {
    badge.textContent = 'Poor';
    badge.classList.add('poor');
    state.qualityScore = 'poor';
  }
}

/* ========== EVENT HANDLERS ========== */
function bindEvents() {
  $('#btn-start-calibration').addEventListener('click', () => startCalibration(FULL_POINTS));
  $('#btn-quick-calibrate').addEventListener('click', () => startCalibration(QUICK_POINTS));
  $('#btn-full-calibrate').addEventListener('click', () => startCalibration(FULL_POINTS));
  $('#btn-auto-collect').addEventListener('click', toggleAutoCollect);
  $('#btn-cancel-calibration').addEventListener('click', endCalibration);

  $('#calibration-target').addEventListener('click', onCalibrationClick);
  $('#calibration-target').addEventListener('touchend', (e) => {
    e.preventDefault();
    onCalibrationClick(e);
  });

  $('#btn-train').addEventListener('click', trainModel);
  $('#btn-validate').addEventListener('click', startValidation);
  $('#btn-start-tracking').addEventListener('click', startTracking);
  $('#btn-stop-tracking').addEventListener('click', stopTracking);
  $('#btn-cancel-validation').addEventListener('click', cancelValidation);

  $('#btn-save-model').addEventListener('click', saveModel);
  $('#btn-load-model').addEventListener('click', loadModel);
  $('#btn-save-data').addEventListener('click', exportData);
  $('#btn-load-data').addEventListener('click', importData);
  $('#btn-reset').addEventListener('click', resetAll);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    try {
      switch (msg.type) {
        case 'GET_STATUS':
          sendResponse({
            webcamReady: state.webcamReady,
            faceDetected: state.faceDetected,
            modelTrained: state.modelTrained,
            tracking: state.tracking,
            sampleCount: state.sampleCount,
            qualityScore: state.qualityScore,
          });
          return true;

        case 'START_TRACKING':
          if (state.modelTrained && !state.tracking) startTracking();
          sendResponse({ ok: true });
          return true;

        case 'STOP_TRACKING':
          if (state.tracking) stopTracking();
          sendResponse({ ok: true });
          return true;

        case 'REQUEST_CALIBRATION':
          startCalibration(msg.full ? FULL_POINTS : QUICK_POINTS);
          sendResponse({ ok: true });
          return true;
      }
    } catch (e) {
      console.error('Message handler error:', e);
      sendResponse({ error: e.message });
      return true;
    }
  });
}

/* ========== INIT ========== */
async function proceedAfterConsent() {
  // Show onboarding if first run (check chrome.storage.local)
  try {
    const result = await chrome.storage.local.get(['_eyedOnboarded']);
    if (!result._eyedOnboarded) {
      $('#onboarding-overlay').style.display = 'flex';
      initOnboarding();
    }
  } catch (e) {
    // First run — show onboarding
    $('#onboarding-overlay').style.display = 'flex';
    initOnboarding();
  }

  await startApp();
}

async function startApp() {
  setStatusText('Loading face mesh model...');

  try {
    await initFaceMesh();
    setStatusText('Face mesh loaded');
  } catch (err) {
    console.error('FaceMesh init failed:', err);
    setStatus('face', 'error');
    setStatusText('Face mesh failed to load — ' + err.message);
  }

  bindEvents();

  try {
    await loadModel();
  } catch (e) {
    // No saved model — expected on first run
  }

  await initWebcam();
}

async function init() {
  initConsent();

  // Check if already consented (using tamper-resistant chrome.storage.local)
  const stored = await chrome.storage.local.get(['_eyedConsent']);
  if (stored._eyedConsent) {
    $('#consent-overlay').style.display = 'none';
    await proceedAfterConsent();
  }
  // Otherwise, consent overlay is visible — waiting for user action
}

init();
