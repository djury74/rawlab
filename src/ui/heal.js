// Spot removal: click a blemish (sensor dust, a mark) and it is covered with a
// nearby clean patch, tone-matched to its surroundings. Spots are stored in
// image coordinates and applied when the photo is resampled, before any
// other adjustment.
import { el, slider } from './controls.js';

export const MAX_SPOTS = 40;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const r4 = (v) => Math.round(v * 1e4) / 1e4;

export function initHeal({ node, state, requestRender, commit, setTool, toast, screenToSrc, srcToScreen }) {
  let size = 0.012;            // radius as a fraction of the long edge
  let selected = -1, drag = null, cursor = null;
  const spots = () => state.settings.spots;
  const src = () => state.source;
  const longEdge = () => Math.max(src().width, src().height);
  const toPx = (uv) => [uv[0] * src().width, uv[1] * src().height];
  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  // Pick the nearby patch whose colour best matches the surroundings of the blemish.
  function findSource(x, y, r) {
    const s = src(), R = r * longEdge(), c = toPx([x, y]);
    const sample = (px, py) => s.sample(Math.round(Math.min(s.width - 1, Math.max(0, px))), Math.round(Math.min(s.height - 1, Math.max(0, py))));
    const mean = (pts) => pts.reduce((a, p) => { const v = sample(p[0], p[1]); return [a[0] + v[0] / pts.length, a[1] + v[1] / pts.length, a[2] + v[2] / pts.length]; }, [0, 0, 0]);
    const ring = (cx, cy, rad, n) => Array.from({ length: n }, (_, i) => [cx + Math.cos(i / n * 6.2832) * rad, cy + Math.sin(i / n * 6.2832) * rad]);
    const target = mean(ring(c[0], c[1], R * 1.4, 8));
    let best = null, bestScore = Infinity;
    for (const k of [2.6, 4]) {
      for (let i = 0; i < 12; i++) {
        const a = i / 12 * 6.2832, px = c[0] + Math.cos(a) * R * k, py = c[1] + Math.sin(a) * R * k;
        if (px < R || py < R || px > s.width - R || py > s.height - R) continue;
        const m = mean([[px, py], ...ring(px, py, R * 0.6, 4)]);
        const lum = target[0] + target[1] + target[2] + 1e-4;
        const score = (Math.abs(m[0] - target[0]) + Math.abs(m[1] - target[1]) + Math.abs(m[2] - target[2])) / lum + (k - 2.6) * 0.01;
        if (score < bestScore) { bestScore = score; best = [px / s.width, py / s.height]; }
      }
    }
    return best || [clamp01(x + r * 2.6), y];
  }

  function hit(p) {
    const z = state.view.shown, tol = 6 * devicePixelRatio;
    for (let i = spots().length - 1; i >= 0; i--) {
      const s = spots()[i], R = s.r * longEdge() * z + tol;
      if (dist(srcToScreen([s.x, s.y]), p) <= R) return { i, part: 'dest' };
      if (i === selected && dist(srcToScreen([s.sx, s.sy]), p) <= R) return { i, part: 'src' };
    }
    return null;
  }

  function pointerDown(p) {
    const uv = screenToSrc(p), h = hit(p);
    if (h) {
      selected = h.i;
      drag = { ...h, start: uv, orig: { ...spots()[h.i] }, moved: false };
      refresh();
      return true;
    }
    if (uv[0] < 0 || uv[0] > 1 || uv[1] < 0 || uv[1] > 1) return false;
    if (spots().length >= MAX_SPOTS) { toast(`Up to ${MAX_SPOTS} spots per photo.`, true); return true; }
    const [sx, sy] = findSource(uv[0], uv[1], size);
    spots().push({ x: r4(uv[0]), y: r4(uv[1]), sx: r4(sx), sy: r4(sy), r: r4(size), f: 0.4 });
    selected = spots().length - 1;
    drag = { i: selected, part: 'new', moved: true };
    refresh();
    return true;
  }

  function pointerMove(p) {
    cursor = p;
    if (!drag || drag.part === 'new') return;
    const uv = screenToSrc(p), s = spots()[drag.i], o = drag.orig;
    const dx = uv[0] - drag.start[0], dy = uv[1] - drag.start[1];
    drag.moved = true;
    if (drag.part === 'dest') {
      // Moving the spot carries its source along, keeping the same offset.
      Object.assign(s, { x: r4(clamp01(o.x + dx)), y: r4(clamp01(o.y + dy)), sx: r4(clamp01(o.sx + dx)), sy: r4(clamp01(o.sy + dy)) });
    } else Object.assign(s, { sx: r4(clamp01(o.sx + dx)), sy: r4(clamp01(o.sy + dy)) });
  }

  function pointerUp() {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.part === 'new') commit('Remove spot');
    else if (d.moved) commit(d.part === 'src' ? 'Move spot source' : 'Move spot');
  }

  function remove(i = selected) {
    if (i < 0 || i >= spots().length) return;
    spots().splice(i, 1); selected = -1;
    refresh(); requestRender(); commit('Delete spot');
  }

  function draw(ctx) {
    const d = devicePixelRatio, z = state.view.shown;
    ctx.save();
    const circle = (c, R, color, dash) => {
      for (const [w, col] of [[3.5, 'rgba(0,0,0,0.45)'], [1.5, color]]) {
        ctx.lineWidth = w * d; ctx.strokeStyle = col; ctx.setLineDash(dash && w < 2 ? [5 * d, 4 * d] : []);
        ctx.beginPath(); ctx.arc(c[0], c[1], Math.max(2, R), 0, 7); ctx.stroke();
      }
    };
    spots().forEach((s, i) => {
      const R = s.r * longEdge() * z, a = srcToScreen([s.x, s.y]);
      if (i !== selected) { circle(a, R, 'rgba(255,255,255,0.8)'); return; }
      const b = srcToScreen([s.sx, s.sy]);
      const len = dist(a, b) || 1, u = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
      if (len > 2 * R) {
        ctx.setLineDash([]); ctx.lineWidth = 1.5 * d; ctx.strokeStyle = '#e3a23a';
        ctx.beginPath(); ctx.moveTo(a[0] + u[0] * R, a[1] + u[1] * R); ctx.lineTo(b[0] - u[0] * R, b[1] - u[1] * R); ctx.stroke();
      }
      circle(a, R, '#e3a23a'); circle(b, R, '#fff', true);
    });
    if (cursor && !drag && !hit(cursor)) circle(cursor, size * longEdge() * z, 'rgba(255,255,255,0.7)');
    ctx.setLineDash([]);
    ctx.restore();
  }

  /* ----- tool bar ----- */

  const sizeSlider = slider({
    label: 'Size', min: 2, max: 60, def: 12,
    get: () => Math.round((selected >= 0 && spots()[selected] ? spots()[selected].r : size) * 1000),
    set: (v) => { size = (v ?? 12) / 1000; if (spots()[selected]) spots()[selected].r = r4(size); },
    onInput: requestRender, onCommit: () => { if (spots()[selected]) commit('Resize spot'); },
  });
  const removeBtn = el('button', { type: 'button', title: 'Delete the selected spot (Delete)', onclick: () => remove() }, 'Delete spot');
  const clearBtn = el('button', { type: 'button', onclick: () => {
    if (!spots().length) return;
    state.settings.spots = []; selected = -1; refresh(); requestRender(); commit('Clear all spots');
  } }, 'Clear all');
  const count = el('span', { class: 'hint', style: 'margin:0' });
  node.append(sizeSlider.node, removeBtn, clearBtn, count,
    el('button', { type: 'button', class: 'primary', onclick: () => setTool('none') }, 'Done'));

  function refresh() {
    if (selected >= spots().length) selected = -1;
    sizeSlider.refresh();
    removeBtn.disabled = selected < 0;
    clearBtn.disabled = !spots().length;
    const n = spots().length;
    count.textContent = n ? `${n} spot${n === 1 ? '' : 's'}. Drag the dashed circle to change what it copies from.` : 'Click a blemish to remove it.';
  }

  return {
    refresh, draw, pointerDown, pointerMove, pointerUp, remove,
    deselect: () => { selected = -1; refresh(); },
    resize: (k) => { sizeSlider.node.querySelector('input').value = Math.round(Math.min(60, Math.max(2, size * 1000 * k))); sizeSlider.node.querySelector('input').dispatchEvent(new Event('input')); sizeSlider.node.querySelector('input').dispatchEvent(new Event('change')); },
  };
}
