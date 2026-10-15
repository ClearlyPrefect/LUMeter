// app.js
// Audio-Setup (getUserMedia + AudioWorklet), Fenster- und Gating-Logik nach
// EBU R128 / ITU-R BS.1770-4, UI-Steuerung, Einstellungen, Offline-Betrieb.
//
// Das Worklet liefert alle 100 ms einen K-gewichteten mean square je Kanal
// sowie Sample- und True-Peak. Hier entstehen daraus die gleitenden Fenster
// (M = 400 ms, S = 3 s) und die gegateten Groessen (I, LRA).
//
// Alle Lautheitswerte werden intern in LUFS gehalten. Erst beim Anzeigen wird
// auf LU relativ zur gewaehlten Referenz umgerechnet – ein Wechsel der
// Referenz wirkt so sofort auf alle Werte inkl. der Max-Werte.

const R128_LUFS = -23;           // EBU R128: 0 LU
const LOUDNESS_OFFSET = -0.691;  // BS.1770-Konstante
const ABS_GATE_LUFS = -70;       // absolutes Gate

const M_BLOCKS = 4;   // 400 ms in 100-ms-Bloecken
const S_BLOCKS = 30;  // 3 s

const zToLufs = (z) => LOUDNESS_OFFSET + 10 * Math.log10(z);
const Z_ABS_GATE = Math.pow(10, (ABS_GATE_LUFS - LOUDNESS_OFFSET) / 10);
const ampToDb = (a) => (a > 0 ? 20 * Math.log10(a) : -Infinity);

// --- Einstellungen (localStorage, defensiv) --------------------------------
const STORE_KEY = 'lumeter.settings.v1';
const DEFAULTS = { deviceId: '', refLu: 0 };

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { ...DEFAULTS };
    const s = JSON.parse(raw);
    return {
      deviceId: typeof s.deviceId === 'string' ? s.deviceId : DEFAULTS.deviceId,
      refLu: Number.isFinite(s.refLu) ? s.refLu : DEFAULTS.refLu,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* egal */ }
}

const settings = loadSettings();
// Referenz in LUFS, die als "0 LU" angezeigt wird.
const refLufs = () => R128_LUFS + settings.refLu;

// --- Zustand ---------------------------------------------------------------
let audioCtx = null;
let workletNode = null;
let mediaStream = null;
let sourceNode = null;
let running = false;
let paused = false;
let wakeLock = null;

const blocks = [];        // {msL, msR} je 100-ms-Block, fuer M/S-Fenster
const integBlocks = [];   // z der 400-ms-Bloecke (I-Gating)
const lraBlocks = [];     // z der 3-s-Bloecke (LRA-Gating)

let mLufs = -Infinity;
let sLufs = -Infinity;
let iLufs = -Infinity;
let lra = 0;
let mMaxLufs = -Infinity;
let sMaxLufs = -Infinity;
let samplePeakDb = -Infinity;
let truePeakDb = -Infinity;

// --- DOM -------------------------------------------------------------------
const el = (id) => document.getElementById(id);
const deviceSelect = el('device');
const startBtn = el('start');
const pauseBtn = el('pause');
const resetBtn = el('reset');
const refInput = el('ref');
const refLufsEl = el('ref-lufs');
const statusEl = el('status');
const barFill = el('bar-fill');
const barTarget = el('bar-target');

function setStatus(msg, kind = '') {
  statusEl.textContent = msg;
  statusEl.dataset.kind = kind;
}

// --- Geraeteliste ----------------------------------------------------------
async function refreshDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    const wanted = deviceSelect.value || settings.deviceId;
    deviceSelect.innerHTML = '';
    inputs.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      // Labels sind erst nach erteilter Freigabe befuellt (v. a. Android).
      opt.textContent = d.label || `Eingang ${i + 1}`;
      deviceSelect.appendChild(opt);
    });
    if (wanted && inputs.some((d) => d.deviceId === wanted)) deviceSelect.value = wanted;
    if (inputs.length === 0) setStatus('Kein Audioeingang gefunden. Interface angeschlossen?', 'error');
  } catch (err) {
    setStatus(`Geraeteliste nicht lesbar: ${err.message}`, 'error');
  }
}

// --- Start / Stop ----------------------------------------------------------
async function start() {
  const deviceId = deviceSelect.value || settings.deviceId;
  const audio = {
    channelCount: { ideal: 2 },
    // Zwingend fuer eine Messung: jede Signalverarbeitung aus.
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  if (deviceId) audio.deviceId = { exact: deviceId };

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
  } catch (err) {
    // Gespeichertes Geraet nicht mehr vorhanden -> einmal ohne deviceId versuchen.
    if (deviceId && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
      delete audio.deviceId;
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      } catch (err2) {
        return failStart(err2);
      }
    } else {
      return failStart(err);
    }
  }

  // Tatsaechlich geoeffnetes Geraet merken.
  const track = mediaStream.getAudioTracks()[0];
  const trackSettings = track.getSettings ? track.getSettings() : {};
  if (trackSettings.deviceId) {
    settings.deviceId = trackSettings.deviceId;
    saveSettings();
  }
  await refreshDevices();
  if (trackSettings.deviceId) deviceSelect.value = trackSettings.deviceId;

  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    await audioCtx.audioWorklet.addModule('r128-processor.js');
  } catch (err) {
    await teardown();
    return failStart(err, 'Audio-Engine konnte nicht starten');
  }

  sourceNode = audioCtx.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioCtx, 'r128-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    // Native Kanalzahl durchreichen: Stereo-Interfaces liefern 2 Kanaele,
    // Mono-Quellen 1 (im Worklet auf R gespiegelt). 'explicit'/2 wuerde
    // Mono mit Stille auffuellen und ~3 dB zu leise messen.
    channelCountMode: 'max',
    channelInterpretation: 'discrete',
  });
  workletNode.port.onmessage = onBlock;
  sourceNode.connect(workletNode);

  running = true;
  paused = false;
  updateControls();
  const ch = trackSettings.channelCount ? `, ${trackSettings.channelCount} Kanal/Kanaele` : '';
  setStatus(`Misst — ${audioCtx.sampleRate} Hz${ch}`, 'ok');
  requestWakeLock();
  requestAnimationFrame(render);
}

function failStart(err, prefix = 'Zugriff auf den Eingang fehlgeschlagen') {
  const hint = err && err.name === 'NotAllowedError'
    ? ' — Mikrofon-Freigabe fuer diese Seite erlauben.'
    : '';
  setStatus(`${prefix}: ${err && err.message ? err.message : err}${hint}`, 'error');
  updateControls();
}

async function teardown() {
  if (workletNode) { workletNode.port.postMessage('stop'); workletNode.disconnect(); workletNode = null; }
  if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
  if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
  if (audioCtx) { try { await audioCtx.close(); } catch { /* egal */ } audioCtx = null; }
}

async function stop() {
  running = false;
  paused = false;
  await teardown();
  releaseWakeLock();
  updateControls();
  setStatus('Gestoppt. Werte bleiben bis zum Zuruecksetzen stehen.');
}

function togglePause() {
  if (!running) return;
  paused = !paused;
  // Nach der Pause M/S neu aufbauen, damit kein Fenster ueber die Luecke reicht.
  // I und LRA laufen mit den bisherigen Bloecken weiter.
  if (!paused) blocks.length = 0;
  updateControls();
  setStatus(paused ? 'Pausiert — I und LRA werden nicht weitergerechnet.' : `Misst — ${audioCtx.sampleRate} Hz`, paused ? 'warn' : 'ok');
}

function updateControls() {
  startBtn.textContent = running ? 'Stopp' : 'Start';
  startBtn.dataset.state = running ? 'running' : '';
  pauseBtn.disabled = !running;
  pauseBtn.textContent = paused ? 'Fortsetzen' : 'Pause';
  pauseBtn.dataset.state = paused ? 'paused' : '';
  deviceSelect.disabled = running;
  document.body.dataset.paused = paused ? 'true' : 'false';
}

// --- Bildschirm wach halten (Android) --------------------------------------
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* nicht kritisch */ }
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && running && !wakeLock) requestWakeLock();
});

// --- Messwertberechnung ----------------------------------------------------
function windowZ(count) {
  if (blocks.length < count) return null;
  let sumL = 0, sumR = 0;
  for (let i = blocks.length - count; i < blocks.length; i++) {
    sumL += blocks[i].msL;
    sumR += blocks[i].msR;
  }
  // Kanalgewichte L = R = 1.0
  return sumL / count + sumR / count;
}

function onBlock(e) {
  if (paused) return;
  const b = e.data;
  blocks.push({ msL: b.msL, msR: b.msR });

  const sp = ampToDb(b.peak);
  if (sp > samplePeakDb) samplePeakDb = sp;
  const tp = ampToDb(b.truePeak);
  if (tp > truePeakDb) truePeakDb = tp;

  const zM = windowZ(M_BLOCKS);
  if (zM !== null) {
    mLufs = zM > 0 ? zToLufs(zM) : -Infinity;
    if (mLufs > mMaxLufs) mMaxLufs = mLufs;
    // 400-ms-Block alle 100 ms = 75 % Overlap, wie BS.1770 fordert.
    integBlocks.push(zM);
    recomputeIntegrated();
  }

  const zS = windowZ(S_BLOCKS);
  if (zS !== null) {
    sLufs = zS > 0 ? zToLufs(zS) : -Infinity;
    if (sLufs > sMaxLufs) sMaxLufs = sLufs;
    lraBlocks.push(zS);
    recomputeLra();
  }

  if (blocks.length > S_BLOCKS) blocks.splice(0, blocks.length - S_BLOCKS);
}

function recomputeIntegrated() {
  let sum = 0, n = 0;
  for (const z of integBlocks) if (z >= Z_ABS_GATE) { sum += z; n++; }
  if (n === 0) { iLufs = -Infinity; return; }
  const zRel = (sum / n) * 0.1; // relatives Gate: -10 LU
  let sum2 = 0, n2 = 0;
  for (const z of integBlocks) if (z >= Z_ABS_GATE && z >= zRel) { sum2 += z; n2++; }
  iLufs = n2 > 0 ? zToLufs(sum2 / n2) : -Infinity;
}

function recomputeLra() {
  let sum = 0, n = 0;
  for (const z of lraBlocks) if (z >= Z_ABS_GATE) { sum += z; n++; }
  if (n < 2) { lra = 0; return; }
  const zRel = (sum / n) * 0.01; // relatives Gate: -20 LU
  const kept = [];
  for (const z of lraBlocks) if (z >= Z_ABS_GATE && z >= zRel) kept.push(zToLufs(z));
  if (kept.length < 2) { lra = 0; return; }
  kept.sort((a, b) => a - b);
  lra = percentile(kept, 95) - percentile(kept, 10);
}

function percentile(sorted, p) {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function reset() {
  blocks.length = 0;
  integBlocks.length = 0;
  lraBlocks.length = 0;
  mLufs = sLufs = iLufs = -Infinity;
  mMaxLufs = sMaxLufs = -Infinity;
  samplePeakDb = truePeakDb = -Infinity;
  lra = 0;
  if (workletNode) workletNode.port.postMessage('reset');
  render(true);
}

// --- Referenz --------------------------------------------------------------
function applyRef(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return;
  settings.refLu = Math.max(-20, Math.min(30, Math.round(v * 2) / 2));
  refInput.value = String(settings.refLu);
  refLufsEl.textContent = `${fmtSigned(settings.refLu)} LU = ${refLufs().toFixed(1)} LUFS`;
  document.querySelectorAll('[data-ref]').forEach((b) => {
    b.setAttribute('aria-pressed', Number(b.dataset.ref) === settings.refLu ? 'true' : 'false');
  });
  saveSettings();
  render(true);
}

// --- Rendern ---------------------------------------------------------------
const fmt = (v, dp = 1) => (Number.isFinite(v) ? v.toFixed(dp) : '—');
const fmtSigned = (v) => (v > 0 ? `+${v}` : `${v}`);
const toRef = (lufs) => lufs - refLufs();

// Balkenskala: -18 bis +9 LU relativ zur Referenz
const SCALE_MIN = -18, SCALE_MAX = 9;
const scalePct = (lu) => {
  const c = Math.max(SCALE_MIN, Math.min(SCALE_MAX, lu));
  return ((c - SCALE_MIN) / (SCALE_MAX - SCALE_MIN)) * 100;
};

function render(once = false) {
  const m = toRef(mLufs);
  el('m-val').textContent = fmt(m);
  el('s-val').textContent = fmt(toRef(sLufs));
  el('i-val').textContent = fmt(toRef(iLufs));
  el('lra-val').textContent = fmt(lra);
  el('mmax-val').textContent = fmt(toRef(mMaxLufs));
  el('smax-val').textContent = fmt(toRef(sMaxLufs));
  el('peak-val').textContent = fmt(samplePeakDb);
  el('tp-val').textContent = fmt(truePeakDb);
  el('i-lufs').textContent = Number.isFinite(iLufs) ? `${iLufs.toFixed(1)} LUFS` : '';

  el('peak-card').dataset.over = samplePeakDb >= -0.1 ? 'true' : 'false';
  el('tp-card').dataset.over = truePeakDb > -1 ? 'true' : 'false';

  // Hoehe fuer den senkrechten Balken (Desktop), --fill fuer den waagerechten (Telefon).
  const pct = `${Number.isFinite(m) ? scalePct(m) : 0}%`;
  barFill.style.height = pct;
  barFill.style.setProperty('--fill', pct);
  let zone = 'low';
  if (m >= 6) zone = 'over';
  else if (m >= 1) zone = 'high';
  else if (m >= -3) zone = 'target';
  barFill.dataset.zone = zone;

  if (running && once !== true) requestAnimationFrame(render);
}

// --- Verdrahtung -----------------------------------------------------------
barTarget.style.bottom = `${scalePct(0)}%`;
barTarget.style.setProperty('--target-x', `${scalePct(0)}%`);

startBtn.addEventListener('click', () => (running ? stop() : start()));
pauseBtn.addEventListener('click', togglePause);
resetBtn.addEventListener('click', reset);
deviceSelect.addEventListener('change', () => { settings.deviceId = deviceSelect.value; saveSettings(); });
refInput.addEventListener('change', () => applyRef(refInput.value));
document.querySelectorAll('[data-ref]').forEach((b) => {
  b.addEventListener('click', () => applyRef(b.dataset.ref));
});

if (!window.isSecureContext) {
  setStatus('Seite muss ueber HTTPS oder localhost geoeffnet werden — sonst gibt der Browser keinen Audioeingang frei.', 'error');
  startBtn.disabled = true;
} else if (!navigator.mediaDevices || !window.AudioWorkletNode) {
  setStatus('Dieser Browser unterstuetzt kein getUserMedia/AudioWorklet. Aktuelles Chrome oder Edge verwenden.', 'error');
  startBtn.disabled = true;
} else {
  navigator.mediaDevices.addEventListener?.('devicechange', refreshDevices);
  refreshDevices();
  setStatus('Bereit. Eingang waehlen und Start druecken.');
}

applyRef(settings.refLu);
updateControls();

// Offline-Betrieb: Dateien nach dem ersten Laden zwischenspeichern.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* optional */ });
}
