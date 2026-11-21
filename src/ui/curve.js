import { el } from './controls.js';
import { curveSampler } from '../color.js';

const CHANNELS = [
  { key: 'rgb', label: 'RGB', color: '#e6e6e6' }, { key: 'r', label: 'R', color: '#ff6b5e' },
  { key: 'g', label: 'G', color: '#5fd068' }, { key: 'b', label: 'B', color: '#5aa2ff' },
];
const SIZE = 248, PAD = 8;

// Point curve editor: click to add a point, drag to move, double-click to remove.
export function curveEditor({ get, onInput, onCommit }) {
  let channel = 'rgb', drag = -1;
  const canvas = el('canvas', { class: 'curve', width: SIZE * 2, height: SIZE * 2, tabindex: 0, 'aria-label': 'Tone curve' });
  const ctx = canvas.getContext('2d');
  const tabs = CHANNELS.map((c) => el('button', {
    class: 'tab', type: 'button', onclick: () => { channel = c.key; refresh(); },
  }, c.label));
  const reset = el('button', { class: 'link', type: 'button', onclick: () => {
    get()[channel] = [[0, 0], [1, 1]]; refresh(); onInput(); onCommit('Reset curve');
  } }, 'Reset channel');

  const pts = () => get()[channel];
  const toXY = (p) => [PAD + p[0] * (SIZE - 2 * PAD), SIZE - PAD - p[1] * (SIZE - 2 * PAD)];
  const fromEvent = (e) => {
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * SIZE, y = (e.clientY - r.top) / r.height * SIZE;
    const c = (v) => Math.min(1, Math.max(0, v));
    return [c((x - PAD) / (SIZE - 2 * PAD)), c((SIZE - PAD - y) / (SIZE - 2 * PAD))];
  };
  const nearest = (m) => {
    let best = -1, bd = 0.06;
    pts().forEach((p, i) => { const d = Math.hypot(p[0] - m[0], p[1] - m[1]); if (d < bd) { bd = d; best = i; } });
    return best;
  };

  function refresh() {
    tabs.forEach((t, i) => t.classList.toggle('on', CHANNELS[i].key === channel));
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = '#161616'; ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.strokeStyle = '#303030'; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const t = PAD + i * (SIZE - 2 * PAD) / 4 + 0.5;
      ctx.beginPath(); ctx.moveTo(t, PAD); ctx.lineTo(t, SIZE - PAD); ctx.moveTo(PAD, t); ctx.lineTo(SIZE - PAD, t); ctx.stroke();
    }
    ctx.strokeStyle = '#3d3d3d';
    ctx.beginPath(); ctx.moveTo(...toXY([0, 0])); ctx.lineTo(...toXY([1, 1])); ctx.stroke();
    for (const c of CHANNELS) {
      if (c.key === channel) continue;
      const p = get()[c.key];
      if (p.length === 2 && p[0][0] === 0 && p[0][1] === 0 && p[1][0] === 1 && p[1][1] === 1) continue;
      plot(p, c.color, 0.35, 1);
    }
    const cur = CHANNELS.find((c) => c.key === channel);
    plot(pts(), cur.color, 1, 1.75);
    ctx.fillStyle = cur.color;
    for (const p of pts()) { const [x, y] = toXY(p); ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill(); }
  }
  function plot(p, color, alpha, width) {
    const f = curveSampler(p);
    ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.beginPath();
    for (let i = 0; i <= 120; i++) { const [x, y] = toXY([i / 120, f(i / 120)]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.stroke(); ctx.globalAlpha = 1;
  }

  canvas.addEventListener('pointerdown', (e) => {
    const m = fromEvent(e);
    drag = nearest(m);
    if (drag < 0) {
      const p = pts();
      p.push(m); p.sort((a, b) => a[0] - b[0]);
      drag = p.indexOf(m);
      onInput();
    }
    canvas.setPointerCapture(e.pointerId);
    refresh();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (drag < 0) return;
    const p = pts(), m = fromEvent(e);
    const lo = drag > 0 ? p[drag - 1][0] + 0.01 : 0, hi = drag < p.length - 1 ? p[drag + 1][0] - 0.01 : 1;
    // End points may move along x too, which sets black and white points.
    p[drag] = [Math.min(hi, Math.max(lo, m[0])), m[1]];
    refresh(); onInput();
  });
  const end = () => { if (drag >= 0) { drag = -1; onCommit('Tone curve'); } };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('dblclick', (e) => {
    const i = nearest(fromEvent(e)), p = pts();
    if (i > 0 && i < p.length - 1) { p.splice(i, 1); refresh(); onInput(); onCommit('Remove curve point'); }
  });

  const node = el('div', { class: 'curve-editor' }, el('div', { class: 'tabs' }, tabs, reset), canvas,
    el('p', { class: 'hint' }, 'Click to add a point, drag to shape, double-click a point to remove it.'));
  refresh();
  return { node, refresh };
}
