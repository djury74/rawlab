import { Renderer } from './gl/renderer.js';
import { loadImage, rawPreview } from './decode.js';
import { defaults, clone, normalise, lookOnly, applyLook, blendLook, HSL_BANDS, BUILTIN_PRESETS } from './settings.js';
import { wbGains, neutraliseToTempTint } from './color.js';
import { geometry, exportAffine, viewAffine, applyAffine, invertAffine, cropFits, fitCropScale } from './geometry.js';
import { el, slider, section } from './ui/controls.js';
import { curveEditor } from './ui/curve.js';
import { drawHistogram } from './ui/histogram.js';
import { hitTest, cursorFor, dragRect, drawCrop } from './ui/crop.js';
import { initLocals } from './ui/locals.js';
import { LENS_PROFILES, detectProfile, activeProfile, lensParams } from './lens.js';
import { withExif, tiff16, tiff16Size } from './export.js';
import { initBrowser } from './ui/browser.js';
import { initHeal } from './ui/heal.js';

const $ = (id) => document.getElementById(id);
const DEF = defaults();
const BG = [0.086, 0.086, 0.086];

const state = {
  source: null,
  settings: defaults(),
  view: { fit: true, zoom: 1, pan: [0, 0] },
  tool: 'none',          // none | crop | wb | local
  selLocal: null,        // id of the selected local adjustment
  showBefore: false,
  compare: false,        // before and after, side by side
  clip: false,
  history: [], hIndex: -1,
  af: null, g: null,     // last view mapping, in device pixels
};

const stage = $('stage'), canvas = $('gl'), overlay = $('overlay');
const octx = overlay.getContext('2d');
let renderer;
try {
  renderer = new Renderer(canvas);
} catch (err) {
  $('empty').replaceChildren(el('h1', {}, "This browser cannot run Duncan's Photo Lab"), el('p', {}, err.message));
  throw err;
}
window.rawlab = { state, renderer }; // handy for debugging from the console

/* ---------- messages ---------- */

let toastTimer;
function toast(text, error = false) {
  const t = $('toast');
  t.textContent = text; t.className = error ? 'error' : ''; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, error ? 9000 : 3000);
}
function busy(text) { $('busy').hidden = !text; if (text) $('busyText').textContent = text; }

/* ---------- loading ---------- */

const editKey = (src) => `rawlab:edit:${src.name}:${src.size}`;
const touchedKey = (src) => `rawlab:touched:${src.name}:${src.size}`;

// The saved edits for a photo, or null if it has none worth restoring.
// Early versions saved a photo's settings the moment it was opened, which froze
// the brightness it happened to open with. Those records (nothing changed,
// exposure at zero, no "touched" mark) are not edits and are ignored.
function savedEdits(src) {
  try {
    const saved = JSON.parse(localStorage.getItem(editKey(src)) || 'null');
    if (!saved || !(saved.version >= 2)) return null;
    if (localStorage.getItem(touchedKey(src))) return saved;
    const untouched = saved.exposure === 0 && JSON.stringify(normalise(saved)) === JSON.stringify(defaults());
    return untouched ? null : saved;
  } catch { return null; }
}

// Star rating (0 to 5) for a photo, kept in this browser.
const ratingKey = (f) => `rawlab:rating:${f.name}:${f.size}`;
const getRating = (f) => { try { return +localStorage.getItem(ratingKey(f)) || 0; } catch { return 0; } };
function setRating(n) {
  if (!state.source) return;
  const r = getRating(state.source) === n ? 0 : n;      // choosing the same rating again clears it
  try { r ? localStorage.setItem(ratingKey(state.source), r) : localStorage.removeItem(ratingKey(state.source)); } catch { /* not essential */ }
  refreshStars(); browser.refreshRatings();
}
function refreshStars() {
  const r = state.source ? getRating(state.source) : 0;
  $('stars').hidden = !state.source;
  [...$('stars').children].forEach((b, i) => { b.classList.toggle('lit', i < r); b.setAttribute('aria-pressed', i < r); });
}
$('stars').append(...[1, 2, 3, 4, 5].map((n) => el('button', { type: 'button', title: `${n} star${n > 1 ? 's' : ''} (press ${n}; 0 clears)`, 'aria-label': `${n} star${n > 1 ? 's' : ''}`, onclick: () => setRating(n) }, '★')));

// The look of the last photo edited before this one, for the Previous button.
function previousLook() {
  if (!state.source) return null;
  try {
    const key = editKey(state.source);
    for (const slot of ['rawlab:last', 'rawlab:prev']) {
      const v = JSON.parse(localStorage.getItem(slot) || 'null');
      if (v && v.key !== key) return v;
    }
  } catch { /* nothing stored */ }
  return null;
}

// Starting point for a photo: defaults, plus automatic exposure for RAW files.
// Rendered images (JPEG, PNG) already carry a tone curve, so they start flat.
function freshSettings() {
  const s = defaults(), src = state.source;
  if (src?.kind === 'raw') s.exposure = src.tone?.exposure || 0;
  if (src?.kind === 'bitmap') s.profile = 'linear';
  return s;
}

// Show the camera's embedded preview at once while a RAW file is developed.
const previewCanvas = $('preview'), pctx = previewCanvas.getContext('2d');
function drawPreview(image, flip) {
  const dpr = devicePixelRatio, w = Math.round(stage.clientWidth * dpr), h = Math.round(stage.clientHeight * dpr);
  previewCanvas.width = w; previewCanvas.height = h;
  const turned = flip === 5 || flip === 6;
  const iw = turned ? image.height : image.width, ih = turned ? image.width : image.height;
  const m = 24 * dpr, k = Math.min((w - 2 * m) / iw, (h - 2 * m) / ih);
  pctx.fillStyle = '#161616'; pctx.fillRect(0, 0, w, h);
  pctx.save();
  pctx.translate(w / 2, h / 2);
  pctx.rotate({ 3: Math.PI, 5: -Math.PI / 2, 6: Math.PI / 2 }[flip] || 0);
  pctx.imageSmoothingQuality = 'high';
  pctx.drawImage(image, -image.width * k / 2, -image.height * k / 2, image.width * k, image.height * k);
  pctx.restore();
  previewCanvas.hidden = false;
  $('empty').hidden = true;
  $('busy').classList.add('over');
}
function hidePreview() { previewCanvas.hidden = true; $('busy').classList.remove('over'); }

let openToken = 0;
async function openFile(file) {
  if (!file) return;
  const token = ++openToken;                 // a newer open supersedes this one
  busy(`Developing ${file.name}…`);
  hidePreview();
  const small = browser.thumbFor(file);      // the strip's thumbnail, if there is one: blurry but immediate
  if (small) drawPreview(small, 0);
  rawPreview(file).then((p) => {
    if (p && token === openToken && $('busy').hidden === false) drawPreview(p.bitmap, p.flip);
    p?.bitmap.close();
  });
  try {
    const source = await loadImage(file);
    if (token !== openToken) return;
    renderer.setSource(source);
    state.source = source;
    let restored = false;
    try {
      const saved = savedEdits(source);
      restored = !!saved;
      state.settings = restored ? normalise(saved) : freshSettings();
    } catch { state.settings = freshSettings(); }
    state.history = []; state.hIndex = -1; state.restored = restored;
    state.view = { fit: true, zoom: 1, pan: [0, 0] };
    state.selLocal = null;
    setTool('none');
    commit(restored ? 'Open (previous edits restored)' : 'Open');
    $('empty').hidden = true;
    browser.setCurrent(source);
    refreshStars();
    $('fileName').textContent = `${source.name}  ·  ${source.width} × ${source.height}`;
    const i = source.info;
    $('exif').replaceChildren(el('b', {}, i.camera || 'Unknown camera'), [i.lens, i.exposure, i.date].filter(Boolean).join('  ·  '));
    refreshAll();
    render();                                // draw the developed photo before the preview is removed
    if (restored) toast('Previous edits for this file were restored. Use Reset to start again.');
    else if (state.settings.exposure > 0) toast(`Exposure set automatically to +${state.settings.exposure.toFixed(2)}. Choose As shot to see it unadjusted.`);
  } catch (err) {
    if (token !== openToken) return;
    console.error(err);
    toast(err.message || String(err), true);
    if (!state.source) $('empty').hidden = false;
  } finally {
    if (token === openToken) { busy(null); hidePreview(); updateButtons(); }
  }
}

$('fileInput').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
for (const id of ['btnOpen', 'btnOpen2']) $(id).addEventListener('click', () => $('fileInput').click());

/* ---------- photo browser ---------- */

const browser = initBrowser({
  node: $('strip'), openFile, toast,
  hasEdits: (file) => !!savedEdits(file),
  rating: getRating,
});
// The top bar button goes straight back to the remembered folder when there is one.
$('btnFolder').addEventListener('click', () => browser.reopen());
$('btnFolder2').addEventListener('click', () => browser.pickFolder());
$('btnReopen').addEventListener('click', () => browser.reopen());
for (const id of ['btnFolder', 'btnFolder2']) $(id).hidden = !browser.supported;
window.rawlab.browser = browser;
browser.rememberedName().then((name) => {
  if (!name || !browser.supported) return;
  $('btnReopen').textContent = `Open "${name}"`;
  $('btnReopen').hidden = false;
});

// When installed as an app, photos opened from File Explorer arrive here.
window.launchQueue?.setConsumer(async (params) => {
  if (!params.files?.length) return;
  if (params.files.length > 1) await browser.show(params.files, 'Opened photos');
  openFile(await params.files[0].getFile());
});
window.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('dragover'); });
window.addEventListener('dragleave', () => stage.classList.remove('dragover'));
window.addEventListener('drop', (e) => {
  e.preventDefault(); stage.classList.remove('dragover');
  openFile(e.dataTransfer.files[0]);
});

/* ---------- rendering ---------- */

function whiteBalance(s) {
  const a = state.source.asShot;
  if (s.temp == null && s.tint == null) return [1, 1, 1];
  return wbGains(a, s.temp ?? a.temp, s.tint ?? a.tint);
}

const lensNow = () => lensParams(state.settings.lens, state.source?.shot);

function beforeSettings() {
  const s = freshSettings(), c = state.settings;
  s.crop = clone(c.crop); s.rot = c.rot; s.flipH = c.flipH; s.flipV = c.flipV; s.lens = clone(c.lens);
  return s;
}

function fitZoom(g, w, h) {
  const m = 24 * devicePixelRatio;
  return Math.min((w - 2 * m) / g.cw, (h - 2 * m) / g.ch);
}

function currentAffine(g, w, h) {
  if (state.tool === 'crop') {
    const a = Math.abs(Math.cos(g.theta)), b = Math.abs(Math.sin(g.theta));
    const m = 56 * devicePixelRatio;
    const z = Math.min((w - 2 * m) / (g.Wf * a + g.Hf * b), (h - 2 * m - 60 * devicePixelRatio) / (g.Wf * b + g.Hf * a));
    state.view.shown = z;
    return viewAffine(g, [g.Wf / 2, g.Hf / 2 + 30 * devicePixelRatio / z], z, w, h);
  }
  const v = state.view, fit = fitZoom(g, w, h);
  const z = v.fit ? fit : v.zoom;
  if (v.fit) v.pan = [0, 0];
  const lim = (size, win) => Math.max(0, size / 2 - (win / 2 - 24 * devicePixelRatio) / z);
  const lx = lim(g.cw, w), ly = lim(g.ch, h);
  v.pan = [Math.max(-lx, Math.min(lx, v.pan[0])), Math.max(-ly, Math.min(ly, v.pan[1]))];
  v.shown = z;
  return viewAffine(g, g.cropToFrame(v.pan), z, w, h);
}

let frame = 0;
function requestRender() {
  if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); });
}

function render() {
  const src = state.source;
  const dpr = devicePixelRatio;
  const w = Math.max(1, Math.round(stage.clientWidth * dpr)), h = Math.max(1, Math.round(stage.clientHeight * dpr));
  for (const c of [canvas, overlay]) if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  if (!src) return;
  const s = state.showBefore ? beforeSettings() : state.settings;
  const g = geometry(state.settings, src.width, src.height);
  locals.syncMasks();
  if (state.compare) {
    // Two half-width views of the same area: original on the left, edit on the right.
    const hw = Math.floor(w / 2), b = beforeSettings();
    const af = currentAffine(g, hw, h);
    state.g = g; state.af = af;
    renderer.render({ settings: b, wb: whiteBalance(b), g, af, w: hw, h, maskCrop: true, bg: BG, lens: lensNow() });
    renderer.render({ settings: state.settings, wb: whiteBalance(state.settings), g, af, w: hw, h, x: w - hw, clip: state.clip, maskCrop: true, bg: BG, lens: lensNow() });
    drawOverlay();
    $('zoomLabel').textContent = Math.round(state.view.shown * 100) + '%';
    scheduleHistogram();
    return;
  }
  const af = currentAffine(g, w, h);
  state.g = g; state.af = af;
  renderer.render({ settings: s, wb: whiteBalance(s), g, af, w, h, clip: state.clip && !state.showBefore, maskCrop: state.tool !== 'crop', bg: BG, showMask: state.showBefore ? null : locals.shownMask(), lens: lensNow(), showSpots: state.tool === 'heal' && heal.showSpots() && !state.showBefore });
  drawOverlay();
  $('zoomLabel').textContent = Math.round(state.view.shown * 100) + '%';
  scheduleHistogram();
}

let histTimer = 0;
function scheduleHistogram() {
  if (histTimer) return;
  histTimer = setTimeout(() => {
    histTimer = 0;
    const src = state.source;
    if (!src) return;
    const s = state.showBefore ? beforeSettings() : state.settings;
    const g = geometry(state.settings, src.width, src.height);
    const k = 256 / Math.max(g.cw, g.ch);
    const w = Math.max(2, Math.round(g.cw * k)), h = Math.max(2, Math.round(g.ch * k));
    renderer.render({ settings: s, wb: whiteBalance(s), g, af: exportAffine(g, w, h), w, h, dest: 'buffer', slot: 'hist', lens: lensNow() });
    drawHistogram($('hist'), renderer.readPixels(w, h));
  }, 60);
}

new ResizeObserver(() => { render(); }).observe(stage);

/* ---------- history ---------- */

function commit(label) {
  // The preset strength slider only stays live until the next edit of any other kind.
  if (state.preset) { state.preset = null; $('presetAmount').hidden = true; }
  const snap = JSON.stringify(state.settings);
  if (state.history[state.hIndex]?.snap === snap) return;
  state.history.length = state.hIndex + 1;
  state.history.push({ label, snap });
  if (state.history.length > 200) state.history.shift();
  state.hIndex = state.history.length - 1;
  persist();
  refreshHistory();
  updateButtons();
}

function restore(index) {
  if (index < 0 || index >= state.history.length) return;
  state.hIndex = index;
  state.preset = null; $('presetAmount').hidden = true;
  state.settings = normalise(JSON.parse(state.history[index].snap));
  persist();
  refreshAll();
}

function persist() {
  if (!state.source) return;
  try {
    const key = editKey(state.source);
    // Opening a photo is not an edit: save only once something has been changed.
    if (state.hIndex > 0 || state.restored) {
      localStorage.setItem(key, JSON.stringify(state.settings));
      localStorage.setItem(touchedKey(state.source), '1');
      const last = JSON.parse(localStorage.getItem('rawlab:last') || 'null');
      if (last && last.key !== key) localStorage.setItem('rawlab:prev', JSON.stringify(last));
      localStorage.setItem('rawlab:last', JSON.stringify({ key, name: state.source.name, look: lookOnly(state.settings) }));
    } else {
      // Back at the opening state (everything undone): nothing to keep.
      localStorage.removeItem(key); localStorage.removeItem(touchedKey(state.source));
    }
  } catch { /* storage full or blocked */ }
  browser.refreshEdited();
}

function refreshHistory() {
  const list = $('history');
  list.replaceChildren(...state.history.map((hst, i) => el('li', { class: i === state.hIndex ? 'current' : i > state.hIndex ? 'future' : '' },
    el('button', { type: 'button', onclick: () => restore(i) }, hst.label))).reverse());
}

function updateButtons() {
  const has = !!state.source;
  $('btnUndo').disabled = state.hIndex <= 0;
  $('btnRedo').disabled = state.hIndex >= state.history.length - 1;
  for (const id of ['btnReset', 'btnCrop', 'btnHeal', 'btnBefore', 'btnClip', 'btnFit', 'btn100', 'btnExport', 'btnCopy', 'btnSaveJson', 'btnLoadJson', 'btnSavePreset']) $(id).disabled = !has;
  $('btnPaste').disabled = !has || !localStorage.getItem('rawlab:clipboard');
  $('btnCrop').classList.toggle('on', state.tool === 'crop');
  $('btnHeal').classList.toggle('on', state.tool === 'heal');
  $('btnBefore').classList.toggle('on', state.showBefore);
  $('btnCompare').classList.toggle('on', state.compare);
  $('btnCompare').disabled = !has;
  $('btnPanels').classList.toggle('on', $('app').classList.contains('solo'));
  const prev = previousLook();
  $('btnPrevious').disabled = !has || !prev;
  $('btnPrevious').title = prev ? `Apply the look last used on ${prev.name}` : 'Edit another photo first';
  $('btnClip').classList.toggle('on', state.clip);
  $('btnFit').classList.toggle('on', state.view.fit);
  $('beforeTag').hidden = !state.showBefore;
}

/* ---------- develop panels ---------- */

const controls = [];
const track = (c) => { controls.push(c); return c.node; };
const S = (label, key, opts = {}) => track(slider({
  label, min: -100, max: 100, def: DEF[key],
  get: () => state.settings[key], set: (v) => { state.settings[key] = v ?? DEF[key]; },
  onInput: requestRender, onCommit: commit, ...opts,
}));

const T_MIN = 2000, T_MAX = 25000;
const WB_PRESETS = { daylight: [5500, 10], cloudy: [6500, 10], shade: [7500, 10], tungsten: [2850, 0], fluorescent: [3800, 21], flash: [5500, 0] };
const wbSelect = el('select', { 'aria-label': 'White balance preset', onchange: () => {
  const v = wbSelect.value, s = state.settings;
  if (v === 'asShot') { s.temp = null; s.tint = null; } else if (WB_PRESETS[v]) { [s.temp, s.tint] = WB_PRESETS[v]; }
  else if (v === 'auto') {
    const wb = autoWhiteBalance();
    if (wb) { s.temp = wb.temp; s.tint = wb.tint; } else toast('Could not judge the white balance of this photo. Try the Pick tool on something grey.', true);
  }
  refreshAll(); commit('White balance: ' + wbSelect.selectedOptions[0].textContent);
} }, [['asShot', 'As shot'], ['daylight', 'Daylight'], ['cloudy', 'Cloudy'], ['shade', 'Shade'], ['tungsten', 'Tungsten'], ['fluorescent', 'Fluorescent'], ['flash', 'Flash'], ['auto', 'Auto'], ['custom', 'Custom']]
  .map(([v, t]) => el('option', { value: v }, t)));
const wbPick = el('button', { type: 'button', title: 'Click something in the photo that should be neutral grey (W)', onclick: () => setTool(state.tool === 'wb' ? 'none' : 'wb') }, 'Pick');
const profileSelect = el('select', { 'aria-label': 'Profile', onchange: () => { state.settings.profile = profileSelect.value; requestRender(); commit('Profile: ' + profileSelect.value); } },
  [['standard', 'Standard'], ['vivid', 'Vivid'], ['linear', 'Linear (flat)']].map(([v, t]) => el('option', { value: v }, t)));
const bwCheck = el('input', { type: 'checkbox', onchange: () => { state.settings.bw = bwCheck.checked; requestRender(); commit(bwCheck.checked ? 'Black and white' : 'Colour'); } });

// White balance estimated from the photo itself. Applied at 80% strength:
// a full correction tends to strip out warmth that belongs in the scene.
function autoWhiteBalance() {
  const src = state.source;
  if (!src) return null;
  if (src.autoWB === undefined) {
    const n = src.neutral();
    if (!n) src.autoWB = null;
    else {
      const full = neutraliseToTempTint(src.asShot, n), a = src.asShot, k = 0.8;
      const mired = 1e6 / a.temp + k * (1e6 / full.temp - 1e6 / a.temp);
      src.autoWB = {
        temp: Math.min(T_MAX, Math.max(T_MIN, Math.round(1e5 / mired) * 10)),
        tint: Math.min(150, Math.max(-150, Math.round(a.tint + k * (full.tint - a.tint)))),
      };
    }
  }
  return src.autoWB;
}

// Auto tone: exposure from the brightest part of the photo, then black and
// white points so the photo spans the range. Each value lands on its slider.
function autoTone() {
  const t = state.source?.tone;
  if (!t) return;
  const s = state.settings, gain = 2 ** t.exposure;
  const low = t.low * gain, high = t.high * gain;
  const e = Math.sqrt(Math.min(1, low));
  const clampTo = (v, lo, hi) => Math.round(Math.min(hi, Math.max(lo, v)));
  const keys = ['exposure', 'highlights', 'shadows', 'whites', 'blacks'];
  const before = keys.map((k) => s[k]).join();
  s.exposure = t.exposure;
  s.blacks = clampTo(-(low - 0.004) / (0.05 * (1 - e) ** 3) * 100, -40, 0);
  s.whites = high > 0 ? clampTo(Math.log2(0.8 / high) / (0.8 * Math.min(1, high)) * 100, -30, 40) : 0;
  // A wide gap between the bright and dark parts (a lamp, a window, a bright
  // sky): hold the bright part back and open up the darker part.
  s.highlights = -clampTo(Math.log2(t.p90 * gain / 0.5) * 25, 0, 50);
  s.shadows = clampTo(Math.log2(0.10 / (t.p75 > 0 ? Math.min(t.p50, t.p75) * gain : 1)) * 30 + (s.highlights < 0 ? 10 : 0), 0, 40);
  if (s.highlights === 0) s.shadows = Math.min(s.shadows, 15);
  refreshAll(); commit('Auto tone');
  // Say what happened: on a well-exposed photo the change can be too small to notice.
  const sign = (v, d = 0) => (v > 0 ? '+' : '') + v.toFixed(d);
  const result = `Exposure ${sign(s.exposure, 2)}, Highlights ${sign(s.highlights)}, Shadows ${sign(s.shadows)}, Whites ${sign(s.whites)}, Blacks ${sign(s.blacks)}`;
  toast(keys.map((k) => s[k]).join() === before ? `Auto tone: already set (${result}).`
    : keys.every((k) => s[k] === 0) ? 'Auto tone: this photo already spans the full range, so nothing needed changing.'
      : `Auto tone set ${result}.`);
}

// Starting brightness: as the camera exposed it, or lifted automatically.
const setStart = (auto) => {
  if (!state.source) return;
  const ev = state.source.tone?.exposure || 0, was = state.settings.exposure;
  state.settings.exposure = auto ? ev : 0;
  refreshAll(); commit(auto ? 'Auto exposure' : 'Exposure as shot');
  if (auto && ev === 0) toast('Auto: this photo is already bright enough, so exposure stays as shot. Auto only ever brightens.');
  else if (auto && was === ev) toast(`Auto is already applied (Exposure +${ev.toFixed(2)}).`);
};
const startButtons = [
  el('button', { type: 'button', title: 'Exposure exactly as the camera recorded it', onclick: () => setStart(false) }, 'As shot'),
  el('button', { type: 'button', title: 'Brighten so the photo uses the available range', onclick: () => setStart(true) }, 'Auto'),
];

const autoToneBtn = el('button', { class: 'link', type: 'button', title: 'Set exposure, whites and blacks automatically so the photo uses the full range', onclick: autoTone }, 'Auto tone');

const basic = [
  el('div', { class: 'row' }, el('span', {}, 'Profile'), profileSelect, el('label', { class: 'check' }, bwCheck, 'B&W')),
  el('div', { class: 'sub' }, 'White balance'),
  el('div', { class: 'row' }, el('span', {}, 'Preset'), wbSelect, wbPick),
  track(slider({
    label: 'Temp', min: T_MIN, max: T_MAX, step: 50, def: () => state.source?.asShot.temp ?? 5500,
    get: () => state.settings.temp, set: (v) => { state.settings.temp = v; },
    toPos: (v) => Math.log(v / T_MIN) / Math.log(T_MAX / T_MIN), fromPos: (p) => T_MIN * (T_MAX / T_MIN) ** p,
    format: (v) => String(Math.round(v / 10) * 10), onInput: () => { syncSelects(); requestRender(); }, onCommit: commit,
  })),
  track(slider({
    label: 'Tint', min: -150, max: 150, def: () => state.source?.asShot.tint ?? 0,
    get: () => state.settings.tint, set: (v) => { state.settings.tint = v; },
    onInput: () => { syncSelects(); requestRender(); }, onCommit: commit,
  })),
  el('div', { class: 'tabs', style: 'margin:10px 0 2px' }, el('div', { class: 'sub', style: 'margin:0' }, 'Tone'), autoToneBtn),
  el('div', { class: 'row' }, el('span', {}, 'Brightness'), startButtons),
  S('Exposure', 'exposure', { min: -5, max: 5, step: 0.01, format: (v) => (v > 0 ? '+' : '') + v.toFixed(2), onInput: () => { syncStart(); requestRender(); } }),
  S('Contrast', 'contrast'), S('Highlights', 'highlights'), S('Shadows', 'shadows'), S('Whites', 'whites'), S('Blacks', 'blacks'),
  el('div', { class: 'sub' }, 'Presence'),
  S('Texture', 'texture'), S('Clarity', 'clarity'), S('Dehaze', 'dehaze'), S('Vibrance', 'vibrance'), S('Saturation', 'saturation'),
];

const curve = curveEditor({ get: () => state.settings.curve, onInput: requestRender, onCommit: commit });
controls.push(curve);

let hslMode = 'hue';
const hslTabs = [['hue', 'Hue'], ['sat', 'Saturation'], ['lum', 'Luminance']].map(([k, t]) =>
  el('button', { class: 'tab', type: 'button', onclick: () => { hslMode = k; refreshAll(); } }, t));
const hslRows = HSL_BANDS.map((band, i) => track(slider({
  label: band.name, min: -100, max: 100, def: 0, swatch: `hsl(${band.hue} 75% 55%)`,
  get: () => state.settings.hsl[hslMode][i], set: (v) => { state.settings.hsl[hslMode][i] = v ?? 0; },
  onInput: requestRender, onCommit: (l) => commit(`${l} ${hslMode}`),
})));
controls.push({ refresh: () => hslTabs.forEach((t, i) => t.classList.toggle('on', ['hue', 'sat', 'lum'][i] === hslMode)) });

const G = (label, key, opts = {}) => track(slider({
  label, min: 0, max: 100, def: DEF.grade[key],
  get: () => state.settings.grade[key], set: (v) => { state.settings.grade[key] = v ?? DEF.grade[key]; },
  onInput: requestRender, onCommit: commit, ...opts,
}));

$('panels').append(
  section('Basic', basic),
  section('Tone curve', curve.node, false),
  section('Colour mixer', [el('div', { class: 'tabs' }, hslTabs), hslRows,
    el('p', { class: 'hint' }, 'In B&W, Luminance sets how bright each colour renders.')], false),
  section('Colour grading', [
    el('div', { class: 'sub' }, 'Shadows'), G('Hue', 'shHue', { max: 360 }), G('Saturation', 'shSat'),
    el('div', { class: 'sub' }, 'Highlights'), G('Hue', 'hiHue', { max: 360 }), G('Saturation', 'hiSat'),
    G('Balance', 'balance', { min: -100 }),
  ], false),
  section('Detail', [
    el('div', { class: 'sub' }, 'Sharpening'), S('Amount', 'sharpen', { min: 0, max: 150 }),
    S('Radius', 'sharpRadius', { min: 0.5, max: 3, step: 0.1, format: (v) => v.toFixed(1) }),
    el('div', { class: 'sub' }, 'Noise reduction'), S('Luminance', 'nrLuma', { min: 0 }), S('Colour', 'nrColor', { min: 0 }),
    el('p', { class: 'hint' }, 'Judge sharpening and noise at 100% zoom.'),
  ], false),
  section('Effects', [
    el('div', { class: 'sub' }, 'Vignette'), S('Amount', 'vignette'), S('Midpoint', 'vigMid', { min: 0 }), S('Feather', 'vigFeather', { min: 0 }),
    el('div', { class: 'sub' }, 'Grain'), S('Amount', 'grain', { min: 0 }), S('Size', 'grainSize', { min: 0 }),
  ], false),
);

const screenToSrc = (p) => state.g.frameToSrc(applyAffine(state.af, p[0], p[1]));
const srcToScreen = (uv) => invertAffine(state.af, state.g.srcToFrame(uv));
const locals = initLocals({ state, renderer, requestRender, commit, setTool, toast, screenToSrc, srcToScreen });
$('panels').children[0].after(locals.node);
const heal = initHeal({ node: $('healbar'), state, requestRender, commit, setTool, toast, screenToSrc, srcToScreen });
locals.refresh(); heal.refresh();      // start with the empty-state panels, before any photo is open

/* ---------- lens corrections ---------- */

const lensSelect = el('select', { 'aria-label': 'Lens profile', onchange: () => {
  state.settings.lens.profile = lensSelect.value; refreshAll(); commit('Lens profile: ' + lensSelect.selectedOptions[0].textContent);
} }, el('option', { value: 'auto' }, 'Automatic'), el('option', { value: 'off' }, 'Off'),
  LENS_PROFILES.map((p) => el('option', { value: p.id }, p.name)));
const lensStatus = el('p', { class: 'hint' });
const caCheck = el('input', { type: 'checkbox', onchange: () => { state.settings.lens.ca = caCheck.checked; requestRender(); commit('Chromatic aberration ' + (caCheck.checked ? 'on' : 'off')); } });
const L = (label, key) => track(slider({
  label, min: 0, max: 200, def: 100,
  get: () => state.settings.lens[key], set: (v) => { state.settings.lens[key] = v ?? 100; },
  onInput: requestRender, onCommit: (l) => commit('Lens ' + l.toLowerCase()),
}));
$('panels').append(section('Lens corrections', [
  el('div', { class: 'row' }, el('span', {}, 'Profile'), lensSelect), lensStatus,
  L('Distortion', 'distortion'), L('Vignetting', 'vignetting'),
  el('label', { class: 'check', style: 'margin-top:6px' }, caCheck, 'Remove chromatic aberration'),
], false));

function syncLens() {
  const lens = state.settings.lens, shot = state.source?.shot;
  lensSelect.value = lens.profile;
  caCheck.checked = lens.ca;
  const active = state.source ? activeProfile(lens, shot) : null;
  if (!state.source) lensStatus.textContent = '';
  else if (lens.profile === 'off') lensStatus.textContent = 'No lens correction applied.';
  else if (lens.profile === 'auto') {
    lensStatus.textContent = detectProfile(shot)
      ? `Detected and applied: ${active.name}${shot.aperture ? ` at f/${+shot.aperture.toFixed(1)}` : ''}.`
      : 'No profile matched this lens. Choose one above if you know which lens was used.';
  } else lensStatus.textContent = `Applied: ${active?.name}${shot?.aperture ? ` at f/${+shot.aperture.toFixed(1)}` : ' (aperture unknown, using wide open)'}.`;
}

function syncStart() {
  const e = state.settings.exposure, auto = state.source?.tone?.exposure || 0;
  startButtons[0].classList.toggle('on', !!state.source && e === 0);
  // When Auto would change nothing, only As shot is marked: the two are the same thing.
  startButtons[1].classList.toggle('on', !!state.source && auto > 0 && Math.abs(e - auto) < 0.005);
  startButtons[1].disabled = !state.source?.tone;
  autoToneBtn.disabled = !state.source?.tone;
  startButtons[1].textContent = !state.source?.tone ? 'Auto' : auto > 0 ? `Auto (+${auto.toFixed(2)})` : 'Auto (no change)';
}

function syncSelects() {
  syncStart();
  syncLens();
  const s = state.settings;
  profileSelect.value = s.profile;
  bwCheck.checked = s.bw;
  let wb = 'custom';
  const auto = state.source?.autoWB;
  if (s.temp == null && s.tint == null) wb = 'asShot';
  else if (auto && s.temp === auto.temp && s.tint === auto.tint) wb = 'auto';
  else for (const [k, [t, ti]] of Object.entries(WB_PRESETS)) if (s.temp === t && s.tint === ti) { wb = k; break; }
  wbSelect.value = wb;
}

function refreshAll() {
  syncSelects();
  for (const c of controls) c.refresh();
  for (const c of cropControls) c.refresh();
  locals.refresh();
  heal.refresh();
  refreshHistory();
  updateButtons();
  requestRender();
}

/* ---------- presets, copy/paste, sidecar ---------- */

const userPresets = () => { try { return JSON.parse(localStorage.getItem('rawlab:presets') || '[]'); } catch { return []; } };

function refreshPresets() {
  const mine = userPresets();
  const item = (p, i) => el('li', {},
    el('button', { type: 'button', onclick: () => applyPreset(p) }, p.name),
    i != null ? el('button', { type: 'button', class: 'del', title: 'Delete preset', 'aria-label': `Delete preset ${p.name}`, onclick: () => {
      mine.splice(i, 1); localStorage.setItem('rawlab:presets', JSON.stringify(mine)); refreshPresets();
    } }, '×') : null);
  $('presets').replaceChildren(...BUILTIN_PRESETS.map((p) => item(p)), ...mine.map((p, i) => item(p, i)));
}

function applyPreset(p) {
  if (!state.source) return;
  // Built-in presets start from a clean look but keep white balance; saved ones replace the whole look.
  const base = p.builtin === false ? state.settings : { ...beforeSettings(), temp: state.settings.temp, tint: state.settings.tint };
  const from = applyLook(base, {}), to = applyLook(base, p.look);
  state.settings = clone(to);
  refreshAll(); commit('Preset: ' + p.name);
  state.preset = { name: p.name, from, to, amount: 100 };   // set after commit, which clears it for other edits
  refreshPresetAmount();
}

// Strength of the preset just applied: 0% is the photo without it, 100% the
// preset as designed, up to 200% to exaggerate it.
const presetAmount = slider({
  label: 'Strength', min: 0, max: 200, step: 5, def: 100, format: (v) => Math.round(v) + '%',
  get: () => state.preset?.amount ?? 100,
  set: (v) => {
    const p = state.preset; if (!p) return;
    p.amount = v ?? 100;
    state.settings = blendLook(p.from, p.to, p.amount / 100);
  },
  onInput: () => { const keep = state.preset; refreshAll(); state.preset = keep; refreshPresetAmount(); },
  onCommit: () => { const keep = state.preset; commit(`Preset: ${keep.name} at ${keep.amount}%`); state.preset = keep; refreshPresetAmount(); },
});
$('presetAmount').append(presetAmount.node, el('p', { class: 'hint', id: 'presetNote' }));
function refreshPresetAmount() {
  $('presetAmount').hidden = !state.preset;
  if (state.preset) { presetAmount.refresh(); $('presetNote').textContent = `Applies to "${state.preset.name}" until you change something else.`; }
}

$('btnSavePreset').addEventListener('click', () => {
  const name = prompt('Preset name');
  if (!name?.trim()) return;
  const look = lookOnly(state.settings);
  delete look.temp; delete look.tint;
  const mine = userPresets();
  mine.push({ name: name.trim(), look, builtin: false });
  localStorage.setItem('rawlab:presets', JSON.stringify(mine));
  refreshPresets();
});

$('btnCopy').addEventListener('click', () => {
  localStorage.setItem('rawlab:clipboard', JSON.stringify(lookOnly(state.settings)));
  updateButtons(); toast('Look copied. Open another photo and choose Paste look.');
});
$('btnPaste').addEventListener('click', () => {
  try {
    state.settings = applyLook(state.settings, JSON.parse(localStorage.getItem('rawlab:clipboard')));
    refreshAll(); commit('Paste look');
  } catch { toast('Nothing to paste.', true); }
});

// Save a file where the user chooses. Browsers with a save dialog (Chrome, Edge)
// let them pick the folder and name; others fall back to the Downloads folder.
// `getBlob` runs after the dialog so slow renders do not delay it. Returns the
// saved blob, or null if the user cancelled.
async function saveFile(getBlob, name, type, description) {
  if (window.showSaveFilePicker) {
    let handle;
    try {
      handle = await window.showSaveFilePicker({ id: 'photolab-export', suggestedName: name, types: [{ description, accept: { [type]: [name.slice(name.lastIndexOf('.'))] } }] });
    } catch (err) {
      if (err.name === 'AbortError') return null;
      handle = null;                      // picker unavailable here (for example inside a frame)
    }
    if (handle) {
      const blob = await getBlob();
      const out = await handle.createWritable();
      await out.write(blob); await out.close();
      return blob;
    }
  }
  const blob = await getBlob();
  download(blob, name);
  return blob;
}

function download(blob, name) {
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
const baseName = () => state.source.name.replace(/\.[^.]+$/, '');

$('btnSaveJson').addEventListener('click', () => {
  download(new Blob([JSON.stringify({ app: "Duncan's Photo Lab", file: state.source.name, settings: state.settings }, null, 2)], { type: 'application/json' }), baseName() + '.photolab.json');
});
$('btnLoadJson').addEventListener('click', () => $('jsonInput').click());
$('jsonInput').addEventListener('change', async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    state.settings = normalise(data.settings || data);
    if (!cropFits(state.settings.crop, state.g.Wf, state.g.Hf, 2)) state.settings.crop = clone(DEF.crop);
    refreshAll(); commit('Load sidecar');
  } catch { toast("That file is not a Duncan's Photo Lab settings file.", true); }
});

/* ---------- crop tool ---------- */

const cropControls = [];
let angleBase = null;

function frameSize() {
  const src = state.source, odd = state.settings.rot % 2;
  return odd ? [src.height, src.width] : [src.width, src.height];
}

function aspectRatio() {
  const a = state.settings.crop.aspect, [Wf, Hf] = frameSize();
  if (a === 'free') return null;
  if (a === 'original') return Wf / Hf;
  const [x, y] = a.split(':').map(Number);
  return x / y;
}

function setAngle(v) {
  const [Wf, Hf] = frameSize();
  if (!angleBase) {
    angleBase = clone(state.settings.crop);
    // If the crop already touched the frame, let it grow back as the angle shrinks.
    angleBase.maximal = !cropFits({ ...angleBase, w: angleBase.w * 1.01, h: angleBase.h * 1.01 }, Wf, Hf);
  }
  const c = { ...angleBase, angle: v ?? 0 };
  delete c.maximal;
  const k = fitCropScale(c, Wf, Hf, angleBase.maximal ? 1 / Math.max(c.w, c.h) * 1.5 : 1);
  c.w *= k; c.h *= k;
  state.settings.crop = c;
}

function setAspect(value) {
  const c = state.settings.crop, [Wf, Hf] = frameSize();
  c.aspect = value;
  const r = aspectRatio();
  if (r) {
    // Keep the area roughly constant, then shrink to fit.
    const wpx = c.w * Wf, hpx = c.h * Hf, area = wpx * hpx;
    const nh = Math.sqrt(area / r), nw = nh * r;
    c.w = nw / Wf; c.h = nh / Hf;
    const k = fitCropScale(c, Wf, Hf, 1);
    c.w *= k; c.h *= k;
  }
  refreshAll(); commit('Crop aspect ' + value);
}

function rotate90(dir) {
  const s = state.settings, c = s.crop;
  const eff = s.flipH !== s.flipV ? -dir : dir;
  s.rot = (s.rot + eff + 4) % 4;
  [c.cx, c.cy] = dir > 0 ? [1 - c.cy, c.cx] : [c.cy, 1 - c.cx];
  [c.w, c.h] = [c.h, c.w];
  if (c.aspect.includes(':')) c.aspect = c.aspect.split(':').reverse().join(':');
  state.view.fit = true;
  refreshAll(); commit(dir > 0 ? 'Rotate right' : 'Rotate left');
}

function flip(axis) {
  const s = state.settings, c = s.crop;
  if (axis === 'h') { s.flipH = !s.flipH; c.cx = 1 - c.cx; } else { s.flipV = !s.flipV; c.cy = 1 - c.cy; }
  c.angle = -c.angle;
  refreshAll(); commit(axis === 'h' ? 'Flip horizontal' : 'Flip vertical');
}

const ASPECTS = [['original', 'Original'], ['free', 'Free'], ['1:1', '1 : 1'], ['3:2', '3 : 2'], ['2:3', '2 : 3'], ['4:3', '4 : 3'], ['3:4', '3 : 4'], ['5:4', '5 : 4'], ['4:5', '4 : 5'], ['16:9', '16 : 9'], ['9:16', '9 : 16']];
const aspectSelect = el('select', { 'aria-label': 'Aspect ratio', onchange: () => setAspect(aspectSelect.value) }, ASPECTS.map(([v, t]) => el('option', { value: v }, t)));
const angleSlider = slider({
  label: 'Angle', min: -45, max: 45, step: 0.1, def: 0, format: (v) => v.toFixed(1) + '°',
  get: () => state.settings.crop.angle, set: setAngle,
  onInput: requestRender, onCommit: () => { angleBase = null; commit('Straighten'); },
});
cropControls.push(angleSlider, { refresh: () => { aspectSelect.value = state.settings.crop.aspect; } });
// Straighten by drawing a line along something that should be level or upright.
let levelMode = false;
const levelBtn = el('button', { type: 'button', title: 'Drag a line along the horizon or a vertical edge (or hold Ctrl and drag)', onclick: () => {
  levelMode = !levelMode; levelBtn.classList.toggle('on', levelMode); overlay.style.cursor = levelMode ? 'crosshair' : 'default';
} }, 'Level');
function applyLevel(a, b) {
  if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 24 * devicePixelRatio) return;
  // The view is already rotated by the current angle, so the line's tilt is what is left to correct.
  const tilt = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
  const delta = tilt - 90 * Math.round(tilt / 90);      // to the nearer of horizontal and vertical
  const angle = Math.max(-45, Math.min(45, Math.round((state.settings.crop.angle + delta) * 10) / 10));
  angleBase = null; setAngle(angle); angleBase = null;
  levelMode = false;
  refreshAll(); commit('Straighten');
}

$('cropbar').append(
  aspectSelect, angleSlider.node, levelBtn,
  el('button', { type: 'button', title: 'Rotate left', onclick: () => rotate90(-1) }, '⟲ 90°'),
  el('button', { type: 'button', title: 'Rotate right', onclick: () => rotate90(1) }, '⟳ 90°'),
  el('button', { type: 'button', onclick: () => flip('h') }, 'Flip H'),
  el('button', { type: 'button', onclick: () => flip('v') }, 'Flip V'),
  el('button', { type: 'button', onclick: () => {
    Object.assign(state.settings, { crop: clone(DEF.crop), rot: 0, flipH: false, flipV: false });
    refreshAll(); commit('Reset crop');
  } }, 'Reset'),
  el('button', { type: 'button', class: 'primary', onclick: () => setTool('none') }, 'Done'),
);

function setTool(tool) {
  if (tool !== 'none' && !state.source) return;
  state.tool = tool;
  if (tool === 'crop') state.showBefore = false;
  if (tool !== 'none') state.compare = false;
  if (tool !== 'crop') levelMode = false;
  levelBtn.classList.toggle('on', levelMode);
  $('cropbar').hidden = tool !== 'crop';
  $('healbar').hidden = tool !== 'heal';
  if (tool !== 'heal') heal.deselect();
  wbPick.classList.toggle('on', tool === 'wb');
  if (tool !== 'local') locals.cancelCreate();
  locals.refresh();
  overlay.style.cursor = idleCursor();
  updateButtons();
  requestRender();
}

const idleCursor = () => (state.tool === 'wb' || state.tool === 'heal' ? 'crosshair' : state.tool === 'local' ? locals.cursorStyle() : 'default');

// Crop rectangle in overlay device pixels, derived from the current view mapping.
function cropRectOnScreen() {
  const { g, af } = state;
  const c = invertAffine(af, g.C), z = state.view.shown;
  return { x0: c[0] - g.cw * z / 2, y0: c[1] - g.ch * z / 2, x1: c[0] + g.cw * z / 2, y1: c[1] + g.ch * z / 2 };
}

function rectToCrop(r) {
  const { g, af } = state, z = state.view.shown;
  const C = applyAffine(af, (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2);
  return { ...state.settings.crop, cx: C[0] / g.Wf, cy: C[1] / g.Hf, w: (r.x1 - r.x0) / z / g.Wf, h: (r.y1 - r.y0) / z / g.Hf };
}

function drawOverlay() {
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (state.tool === 'crop' && state.af) {
    const d = devicePixelRatio, r = cropRectOnScreen();
    octx.setTransform(d, 0, 0, d, 0, 0);
    drawCrop(octx, overlay.width / d, overlay.height / d, { x0: r.x0 / d, y0: r.y0 / d, x1: r.x1 / d, y1: r.y1 / d });
  }
  if (drag?.type === 'level') {
    octx.setTransform(1, 0, 0, 1, 0, 0);
    for (const [w, col] of [[4, 'rgba(0,0,0,0.5)'], [1.5, '#e3a23a']]) {
      octx.lineWidth = w * devicePixelRatio; octx.strokeStyle = col;
      octx.beginPath(); octx.moveTo(...drag.start); octx.lineTo(...drag.end); octx.stroke();
    }
  }
  if (state.compare) {
    const d = devicePixelRatio, mid = Math.floor(overlay.width / 2);
    octx.fillStyle = '#000'; octx.fillRect(mid - d, 0, 2 * d, overlay.height);
    octx.font = `600 ${12 * d}px system-ui, sans-serif`; octx.textBaseline = 'top';
    for (const [text, x] of [['Before', 12 * d], ['After', mid + 12 * d]]) {
      const tw = octx.measureText(text).width;
      octx.fillStyle = 'rgba(0,0,0,0.7)'; octx.fillRect(x - 6 * d, 8 * d, tw + 12 * d, 22 * d);
      octx.fillStyle = '#e6e6e6'; octx.fillText(text, x, 13 * d);
    }
  }
  if (state.tool === 'heal' && state.af && !state.showBefore) heal.draw(octx);
  if (state.tool === 'local' && state.af && !state.showBefore) {
    locals.draw(octx);
    if (!drag) overlay.style.cursor = spaceHeld ? 'grab' : idleCursor();
  }
}

/* ---------- pointer interaction on the image ---------- */

const devicePoint = (e) => {
  const r = overlay.getBoundingClientRect();
  const p = [(e.clientX - r.left) * devicePixelRatio, (e.clientY - r.top) * devicePixelRatio];
  const half = canvas.width - Math.floor(canvas.width / 2);
  if (state.compare && p[0] >= half) p[0] -= half;     // both halves show the same area
  return p;
};
const viewWidth = () => (state.compare ? Math.floor(canvas.width / 2) : canvas.width);
let drag = null, spaceHeld = false;

overlay.addEventListener('pointerdown', (e) => {
  if (!state.source || e.button !== 0) return;
  const p = devicePoint(e);
  if (state.tool === 'wb') { pickWhiteBalance(p); return; }
  if (state.tool === 'heal' && !spaceHeld && heal.pointerDown(p)) {
    drag = { type: 'heal' };
    overlay.setPointerCapture(e.pointerId);
    requestRender();
    return;
  }
  if (state.tool === 'local' && !spaceHeld && locals.pointerDown(p)) {
    drag = { type: 'local' };
    overlay.setPointerCapture(e.pointerId);
    requestRender();
    return;
  }
  if (state.tool === 'crop' && (levelMode || e.ctrlKey)) {
    drag = { type: 'level', start: p, end: p };
    overlay.setPointerCapture(e.pointerId);
    return;
  }
  if (state.tool === 'crop') {
    const rect = cropRectOnScreen();
    const handle = hitTest(rect, p[0], p[1], 14 * devicePixelRatio);
    if (!handle) return;
    drag = { type: 'crop', handle, start: p, rect, valid: rect, af: state.af };
  } else {
    drag = { type: 'pan', start: p, pan: [...state.view.pan] };
    overlay.style.cursor = 'grabbing';
  }
  overlay.setPointerCapture(e.pointerId);
});

overlay.addEventListener('pointermove', (e) => {
  const p = devicePoint(e);
  if (drag?.type === 'level') { drag.end = p; drawOverlay(); return; }
  if (state.tool === 'heal') {
    heal.pointerMove(p);
    if (drag?.type === 'heal') { requestRender(); return; }
    if (!drag) drawOverlay();
  }
  if (state.tool === 'local') {
    locals.pointerMove(p);
    if (drag?.type === 'local') { requestRender(); return; }
    if (!drag) drawOverlay();
  }
  if (!drag) {
    if (state.tool === 'crop' && state.af) overlay.style.cursor = cursorFor(hitTest(cropRectOnScreen(), p[0], p[1], 14 * devicePixelRatio));
    return;
  }
  if (drag.type === 'pan') {
    if (state.view.fit) return;
    const z = state.view.shown;
    state.view.pan = [drag.pan[0] - (p[0] - drag.start[0]) / z, drag.pan[1] - (p[1] - drag.start[1]) / z];
    requestRender();
    return;
  }
  // Crop: move towards the requested rectangle as far as the image allows.
  const { g } = state;
  const want = dragRect(drag.rect, drag.handle, p[0] - drag.start[0], p[1] - drag.start[1], aspectRatio(), 32 * devicePixelRatio);
  const fits = (r) => cropFits(rectToCrop(r), g.Wf, g.Hf);
  const lerp = (a, b, t) => ({ x0: a.x0 + (b.x0 - a.x0) * t, y0: a.y0 + (b.y0 - a.y0) * t, x1: a.x1 + (b.x1 - a.x1) * t, y1: a.y1 + (b.y1 - a.y1) * t });
  let next = want;
  if (!fits(want)) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 14; i++) { const m = (lo + hi) / 2; if (fits(lerp(drag.valid, want, m))) lo = m; else hi = m; }
    next = lerp(drag.valid, want, lo);
  }
  drag.valid = next;
  state.settings.crop = rectToCrop(next);
  requestRender();
});

const endDrag = () => {
  if (!drag) return;
  if (drag.type === 'level') { const d = drag; drag = null; applyLevel(d.start, d.end); overlay.style.cursor = 'default'; requestRender(); return; }
  if (drag.type === 'crop') commit('Crop');
  const wasLocal = drag.type === 'local', wasHeal = drag.type === 'heal';
  drag = null;
  if (wasHeal) { heal.pointerUp(); requestRender(); }
  if (wasLocal) { locals.pointerUp(); requestRender(); }
  overlay.style.cursor = idleCursor();
};
overlay.addEventListener('pointerup', endDrag);
overlay.addEventListener('pointercancel', endDrag);

overlay.addEventListener('wheel', (e) => {
  if (!state.source || state.tool === 'crop') return;
  e.preventDefault();
  zoomAt(state.view.shown * Math.exp(-e.deltaY * 0.0015), devicePoint(e));
}, { passive: false });

overlay.addEventListener('dblclick', (e) => {
  if (!state.source || state.tool !== 'none') return;
  if (state.view.fit) zoomAt(1, devicePoint(e)); else { state.view.fit = true; updateButtons(); requestRender(); }
});

function zoomAt(z, point) {
  const v = state.view, g = state.g;
  const fit = fitZoom(g, viewWidth(), canvas.height);
  z = Math.min(8, z);
  if (z <= fit * 1.001 && fit <= 8) { v.fit = true; updateButtons(); requestRender(); return; }
  const c = [viewWidth() / 2, canvas.height / 2];
  const pt = point || c, old = v.shown;
  v.pan = [v.pan[0] + (pt[0] - c[0]) * (1 / old - 1 / z), v.pan[1] + (pt[1] - c[1]) * (1 / old - 1 / z)];
  v.zoom = z; v.fit = false;
  updateButtons(); requestRender();
}

function pickWhiteBalance(p) {
  const { g, af, source } = state;
  const uv = g.frameToSrc(applyAffine(af, p[0], p[1]));
  if (uv[0] < 0 || uv[0] > 1 || uv[1] < 0 || uv[1] > 1) return;
  const rgb = source.sample(Math.round(uv[0] * (source.width - 1)), Math.round(uv[1] * (source.height - 1)));
  if (Math.max(...rgb) > 0.98 || Math.max(...rgb) < 0.002) { toast('That spot is clipped or black. Pick a mid-grey area instead.', true); return; }
  const r = neutraliseToTempTint(source.asShot, rgb);
  state.settings.temp = Math.min(T_MAX, Math.max(T_MIN, Math.round(r.temp / 10) * 10));
  state.settings.tint = Math.min(150, Math.max(-150, Math.round(r.tint)));
  setTool('none'); refreshAll(); commit('White balance picker');
}

/* ---------- export ---------- */

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/tiff': '.tif' };
const SIZE_PRESETS = [['full', 'Full size'], ['50%', '50%'], ['25%', '25%'], ['3840', 'Long edge 3840 px (4K)'], ['2048', 'Long edge 2048 px'], ['1600', 'Long edge 1600 px'], ['1080', 'Long edge 1080 px'], ['custom', 'Custom']];
$('exSize').append(...SIZE_PRESETS.map(([v, t]) => el('option', { value: v }, t)));
const ex = { canvas: null, key: '', blob: null, shown: null, token: 0, timer: 0, centre: [0.5, 0.5], full: [1, 1] };

// Render the developed photo at ow x oh. `deep` gives 16-bit RGB data instead of a canvas.
async function renderFull(ow, oh, onProgress, deep = false) {
  const s = state.settings, wb = whiteBalance(s), lens = lensNow();
  const g = geometry(s, state.source.width, state.source.height);
  const out = deep ? null : new OffscreenCanvas(ow, oh), ctx = out?.getContext('2d');
  const data = deep ? new Uint16Array(ow * oh * 3) : null;
  const TILE = 1024, PAD = 16;
  const total = Math.ceil(ow / TILE) * Math.ceil(oh / TILE);
  let done = 0;
  for (let ty = 0; ty < oh; ty += TILE) {
    for (let tx = 0; tx < ow; tx += TILE) {
      const x0 = Math.max(0, tx - PAD), y0 = Math.max(0, ty - PAD);
      const x1 = Math.min(ow, tx + TILE + PAD), y1 = Math.min(oh, ty + TILE + PAD);
      const w = x1 - x0, h = y1 - y0, cw = Math.min(TILE, ow - tx), ch = Math.min(TILE, oh - ty);
      renderer.render({ settings: s, wb, g, af: exportAffine(g, ow, oh, x0, y0), w, h, dest: deep ? 'float' : 'buffer', slot: 'export', lens });
      if (deep) renderer.readFloatInto(data, ow, w, h, tx, ty, tx - x0, ty - y0, cw, ch);
      else ctx.putImageData(new ImageData(renderer.readPixels(w, h), w, h), x0, y0, tx - x0, ty - y0, cw, ch);
      onProgress?.(++done / total);
      await new Promise((r) => setTimeout(r));
    }
  }
  renderer.release('export');
  return deep ? data : out;
}

function exportSize() {
  const [fw, fh] = ex.full;
  const w = Math.min(fw, Math.max(16, parseInt($('exW').value, 10) || fw));
  return { ow: w, oh: Math.max(1, Math.round(w * fh / fw)) };
}

// Fill width and height from the chosen size preset.
function applySizePreset() {
  const [fw, fh] = ex.full, v = $('exSize').value, long = Math.max(fw, fh);
  let k = 1;
  if (v.endsWith('%')) k = parseInt(v, 10) / 100;
  else if (v !== 'full' && v !== 'custom') k = Math.min(1, parseInt(v, 10) / long);
  if (v !== 'custom') { $('exW').value = Math.round(fw * k); $('exH').value = Math.round(fh * k); }
}

const fileSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(n >= 10485760 ? 1 : 2) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

// Re-render and re-encode as needed, then show the real result and its size.
async function refreshExport() {
  const token = ++ex.token;
  const type = $('exFormat').value, lossy = type === 'image/jpeg' || type === 'image/webp';
  const { ow, oh } = exportSize();
  $('exQualityRow').hidden = !lossy;
  $('exQualityOut').textContent = $('exQuality').value;
  $('exMetaRow').hidden = type !== 'image/jpeg' || !state.source.shot;
  $('exGo').disabled = true;
  try {
    if (ex.key !== `${ow}x${oh}`) {
      $('exInfo').textContent = 'Rendering…';
      const canvas = await renderFull(ow, oh, (f) => { if (token === ex.token) $('exInfo').textContent = `Rendering ${Math.round(f * 100)}%`; });
      if (token !== ex.token) return;
      ex.canvas = canvas; ex.key = `${ow}x${oh}`;
    }
    ex.blob = null; ex.shown = ex.canvas;
    let bytes;
    if (type === 'image/tiff') bytes = tiff16Size(ow, oh);
    else {
      $('exInfo').textContent = 'Encoding…';
      let blob = await ex.canvas.convertToBlob({ type, quality: $('exQuality').value / 100 });
      if (token !== ex.token) return;
      if (lossy) ex.shown = await createImageBitmap(blob);   // preview shows the compression itself
      if (type === 'image/jpeg' && $('exMeta').checked) blob = await withExif(blob, state.source.shot, ow, oh);
      if (token !== ex.token) return;
      ex.blob = blob; bytes = blob.size;
    }
    $('exInfo').textContent = `${ow} × ${oh} px  ·  ${(ow * oh / 1e6).toFixed(1)} MP  ·  ${fileSize(bytes)}${type === 'image/tiff' ? '  ·  16-bit, uncompressed' : ''}`;
    $('exGo').disabled = false;
    drawExportPreview();
  } catch (err) {
    console.error(err);
    if (token === ex.token) $('exInfo').textContent = 'Could not render: ' + (err.message || err);
  }
}

function drawExportPreview() {
  const c = $('exPreview'), ctx = c.getContext('2d'), img = ex.shown;
  ctx.fillStyle = '#161616'; ctx.fillRect(0, 0, c.width, c.height);
  if (!img) return;
  // 100% view around the chosen centre, or the whole image if it is smaller than the pane.
  const sx = Math.round(Math.max(0, Math.min(img.width - c.width, ex.centre[0] * img.width - c.width / 2)));
  const sy = Math.round(Math.max(0, Math.min(img.height - c.height, ex.centre[1] * img.height - c.height / 2)));
  const w = Math.min(c.width, img.width), h = Math.min(c.height, img.height);
  ctx.drawImage(img, sx, sy, w, h, Math.round((c.width - w) / 2), Math.round((c.height - h) / 2), w, h);
}

const queueExport = () => { clearTimeout(ex.timer); $('exGo').disabled = true; ex.timer = setTimeout(refreshExport, 250); };
$('exSize').addEventListener('change', () => { applySizePreset(); queueExport(); });
$('exW').addEventListener('input', () => { const [fw, fh] = ex.full; $('exSize').value = 'custom'; $('exH').value = Math.round((parseInt($('exW').value, 10) || 0) * fh / fw) || ''; queueExport(); });
$('exH').addEventListener('input', () => { const [fw, fh] = ex.full; $('exSize').value = 'custom'; $('exW').value = Math.round((parseInt($('exH').value, 10) || 0) * fw / fh) || ''; queueExport(); });
for (const id of ['exFormat', 'exQuality', 'exMeta']) $(id).addEventListener('input', queueExport);

{ // drag the preview to look around at 100%
  const c = $('exPreview'); let from = null;
  c.addEventListener('pointerdown', (e) => { from = [e.clientX, e.clientY, ...ex.centre]; c.setPointerCapture(e.pointerId); });
  c.addEventListener('pointermove', (e) => {
    if (!from || !ex.shown) return;
    const k = c.width / c.getBoundingClientRect().width;
    ex.centre = [Math.min(1, Math.max(0, from[2] - (e.clientX - from[0]) * k / ex.shown.width)), Math.min(1, Math.max(0, from[3] - (e.clientY - from[1]) * k / ex.shown.height))];
    drawExportPreview();
  });
  c.addEventListener('pointerup', () => { from = null; });
}

$('btnExport').addEventListener('click', () => {
  if (!state.source) return;
  const g = geometry(state.settings, state.source.width, state.source.height);
  ex.full = [Math.round(g.cw), Math.round(g.ch)]; ex.key = ''; ex.canvas = null; ex.shown = null; ex.centre = [0.5, 0.5];
  try {
    const last = JSON.parse(localStorage.getItem('rawlab:export') || '{}');
    if (last.format) $('exFormat').value = last.format;
    if (last.quality) $('exQuality').value = last.quality;
    if (last.size && last.size !== 'custom') $('exSize').value = last.size;
    if (typeof last.meta === 'boolean') $('exMeta').checked = last.meta;
  } catch { /* use the defaults */ }
  if ($('exSize').value === 'custom') $('exSize').value = 'full';
  $('exName').value = baseName();
  applySizePreset();
  $('exportDlg').showModal();
  refreshExport();
});

$('exGo').addEventListener('click', async () => {
  const type = $('exFormat').value, btn = $('exGo'), { ow, oh } = exportSize();
  btn.disabled = true;
  try {
    const name = ($('exName').value.trim() || baseName()).replace(/[\\/:*?"<>|]+/g, '_');
    const ready = ex.blob;
    const blob = await saveFile(async () => {
      if (type !== 'image/tiff') return ready;
      const data = await renderFull(ow, oh, (f) => { btn.textContent = `Rendering ${Math.round(f * 100)}%`; }, true);
      return tiff16(data, ow, oh);
    }, name + EXT[type], type, $('exFormat').selectedOptions[0].textContent);
    if (!blob) return;                    // cancelled in the save dialog: keep the export window open
    try { localStorage.setItem('rawlab:export', JSON.stringify({ format: type, quality: $('exQuality').value, size: $('exSize').value, meta: $('exMeta').checked })); } catch { /* not essential */ }
    $('exportDlg').close();
    toast(`Exported ${ow} × ${oh} px, ${fileSize(blob.size)}.`);
  } catch (err) {
    console.error(err);
    toast('Export failed: ' + (err.message || err), true);
  } finally {
    btn.disabled = false; btn.textContent = 'Save';
  }
});
$('exportDlg').addEventListener('close', () => { ex.token++; ex.canvas = null; ex.shown = null; ex.blob = null; ex.key = ''; requestRender(); });
window.rawlab.renderFull = renderFull;

/* ---------- toolbar and keyboard ---------- */

$('btnUndo').addEventListener('click', () => restore(state.hIndex - 1));
$('btnRedo').addEventListener('click', () => restore(state.hIndex + 1));
// Reset means everything at zero: the photo exactly as the camera recorded it.
$('btnReset').addEventListener('click', () => { state.settings = freshSettings(); state.settings.exposure = 0; state.view.fit = true; refreshAll(); commit('Reset all'); });
$('btnCrop').addEventListener('click', () => setTool(state.tool === 'crop' ? 'none' : 'crop'));
$('btnHeal').addEventListener('click', () => setTool(state.tool === 'heal' ? 'none' : 'heal'));
$('btnBefore').addEventListener('click', () => { state.showBefore = !state.showBefore; state.compare = false; updateButtons(); requestRender(); });
$('btnCompare').addEventListener('click', () => {
  if (!state.source) return;
  if (!state.compare) setTool('none');
  state.compare = !state.compare; state.showBefore = false;
  updateButtons(); requestRender();
});
$('btnPanels').addEventListener('click', () => { $('app').classList.toggle('solo'); updateButtons(); });
$('btnPrevious').addEventListener('click', () => {
  const prev = previousLook();
  if (!prev) return;
  state.settings = applyLook(state.settings, prev.look);
  refreshAll(); commit(`Previous look (${prev.name})`);
});
$('btnClip').addEventListener('click', () => { state.clip = !state.clip; updateButtons(); requestRender(); });
$('btnFit').addEventListener('click', () => { state.view.fit = true; updateButtons(); requestRender(); });
$('btn100').addEventListener('click', () => zoomAt(1));

window.addEventListener('keydown', (e) => {
  if (e.target.matches('input[type=text], input[type=number], select, textarea') || $('exportDlg').open) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  const run = (fn) => { e.preventDefault(); fn(); };
  if (mod && k === 'z') return run(() => restore(state.hIndex + (e.shiftKey ? 1 : -1)));
  if (mod && k === 'y') return run(() => restore(state.hIndex + 1));
  if (mod && k === 'o') return run(() => $('fileInput').click());
  if (mod && k === 'e') return run(() => $('btnExport').click());
  if (e.key === 'Tab' && !mod && !e.altKey && !e.shiftKey) return run(() => $('btnPanels').click());
  if (mod || e.altKey || !state.source) return;
  if (e.key === ' ' && !e.target.matches('button, summary, input')) { e.preventDefault(); spaceHeld = true; return; }
  if (state.tool === 'heal') {
    if (k === '[') return run(() => heal.resize(1 / 1.2));
    if (k === ']') return run(() => heal.resize(1.2));
    if (k === 'delete' || k === 'backspace') return run(() => heal.remove());
    if (k === 's') return run(() => heal.toggleSpots());
  }
  if (state.tool === 'local') {
    if (k === '[') return run(() => locals.resizeBrush(1 / 1.15));
    if (k === ']') return run(() => locals.resizeBrush(1.15));
    if (k === 'x') return run(() => locals.toggleErase());
  }
  if ((k === 'arrowleft' || k === 'arrowright') && !e.target.matches('input')) return run(() => browser.step(k === 'arrowright' ? 1 : -1));
  if (k === '\\') run(() => $('btnBefore').click());
  else if (k === 'r') run(() => $('btnCrop').click());
  else if (k === 'h') run(() => $('btnHeal').click());
  else if (k === 'j') run(() => $('btnClip').click());
  else if (k === 'f') run(() => $('btnFit').click());
  else if (k === 'z') run(() => (state.view.fit ? zoomAt(1) : $('btnFit').click()));
  else if (k === 'y') run(() => $('btnCompare').click());
  else if (k >= '0' && k <= '5' && k.length === 1) run(() => setRating(+k));
  else if (k === 'w') run(() => setTool(state.tool === 'wb' ? 'none' : 'wb'));
  else if ((k === 'enter' || k === 'escape') && state.tool !== 'none') run(() => setTool('none'));
});

window.addEventListener('keyup', (e) => { if (e.key === ' ') spaceHeld = false; });

refreshPresets();
updateButtons();
drawHistogram($('hist'), null);
render();
