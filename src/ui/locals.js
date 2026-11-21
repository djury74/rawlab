// Local adjustments: linear gradient, radial and brush masks, each with its own
// set of adjustments. Masks are stored in source-image coordinates (0..1), so
// they stay attached to the photo through crop, rotation and flips.
import { el, slider, section } from './controls.js';
import { MAX_LOCALS } from '../gl/renderer.js';

const ADJ = [
  ['Exposure', 'exposure', { min: -4, max: 4, step: 0.01, format: (v) => (v > 0 ? '+' : '') + v.toFixed(2) }],
  ['Contrast', 'contrast'], ['Highlights', 'highlights'], ['Shadows', 'shadows'],
  ['Warmth', 'temp'], ['Tint', 'tint'], ['Saturation', 'saturation'], ['Clarity', 'clarity'],
];
const TYPE_NAMES = { linear: 'Gradient', radial: 'Radial', brush: 'Brush' };
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function initLocals({ state, renderer, requestRender, commit, setTool, toast, screenToSrc, srcToScreen }) {
  let creating = null;       // 'linear' | 'radial' while waiting for the first drag
  let drag = null;
  let erase = false, alwaysShow = false;
  let cursor = null;         // last pointer position, device px
  const brush = { size: 0.05, feather: 0.6, flow: 0.6 };
  const cache = new Map();   // brush id -> { canvas, ctx, sig, version }

  const list = () => state.settings.locals;
  const sel = () => list().find((l) => l.id === state.selLocal) || null;
  const src = () => state.source;
  const longEdge = () => Math.max(src().width, src().height);
  // Source uv <-> isotropic source pixels.
  const toPx = (uv) => [uv[0] * src().width, uv[1] * src().height];
  const toUv = (px) => [r4(px[0] / src().width), r4(px[1] / src().height)];

  function add(type, extra) {
    if (list().length >= MAX_LOCALS) { toast(`Up to ${MAX_LOCALS} local adjustments per photo.`, true); return null; }
    const n = list().filter((l) => l.type === type).length + 1;
    const local = {
      id: Math.random().toString(36).slice(2, 10), type, enabled: true, name: `${TYPE_NAMES[type]} ${n}`,
      exposure: 0, contrast: 0, highlights: 0, shadows: 0, temp: 0, tint: 0, saturation: 0, clarity: 0, ...extra,
    };
    list().push(local);
    state.selLocal = local.id;
    return local;
  }

  /* ----- brush rasterisation ----- */

  const signature = (l) => {
    const last = l.strokes[l.strokes.length - 1];
    return `${l.strokes.length}:${l.strokes.reduce((n, s) => n + s.pts.length, 0)}:${last ? last.pts[last.pts.length - 1].join() : ''}`;
  };

  function entryFor(l) {
    const { w, h } = renderer.maskSize;
    let e = cache.get(l.id);
    if (!e || e.canvas.width !== w || e.canvas.height !== h) {
      const canvas = new OffscreenCanvas(w, h);
      e = { canvas, ctx: canvas.getContext('2d'), sig: null, version: 0 };
      cache.set(l.id, e);
    }
    return e;
  }

  function dabs(e, stroke, from) {
    const { ctx, canvas } = e;
    const R = Math.max(1, stroke.size * Math.max(canvas.width, canvas.height));
    const step = Math.max(0.75, R * 0.2);
    ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
    const dab = (x, y) => {
      const g = ctx.createRadialGradient(x, y, R * (1 - stroke.feather) * 0.98, x, y, R);
      g.addColorStop(0, `rgba(255,255,255,${stroke.flow * 0.4})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - R, y - R, 2 * R, 2 * R);
    };
    const P = (p) => [p[0] * canvas.width, p[1] * canvas.height];
    if (from === 0) dab(...P(stroke.pts[0]));
    for (let i = Math.max(1, from); i < stroke.pts.length; i++) {
      const a = P(stroke.pts[i - 1]), b = P(stroke.pts[i]);
      const n = Math.max(1, Math.round(dist(a, b) / step));
      for (let k = 1; k <= n; k++) dab(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n);
    }
    e.version++;
  }

  // Bring every brush mask texture up to date with the settings. Called before each render.
  function syncMasks() {
    list().slice(0, MAX_LOCALS).forEach((l, layer) => {
      if (l.type !== 'brush') return;
      const e = entryFor(l), sig = signature(l);
      if (e.sig !== sig) {
        e.ctx.globalCompositeOperation = 'source-over';
        e.ctx.clearRect(0, 0, e.canvas.width, e.canvas.height);
        for (const s of l.strokes) dabs(e, s, 0);
        e.sig = sig; e.version++;
      }
      renderer.uploadMask(layer, e.canvas, `${l.id}:${e.version}`);
    });
    for (const id of cache.keys()) if (!list().some((l) => l.id === id)) cache.delete(id);
  }

  /* ----- handles ----- */

  function radialAxes(l) {
    const c = toPx(l.c), L = longEdge(), ca = Math.cos(l.angle), sa = Math.sin(l.angle);
    const ax = [ca * l.rx * L, sa * l.rx * L], ay = [-sa * l.ry * L, ca * l.ry * L];
    return { c, ax, ay };
  }

  function handles(l) {
    const S = (px) => srcToScreen([px[0] / src().width, px[1] / src().height]);
    if (l.type === 'linear') {
      const a = srcToScreen(l.p0), b = srcToScreen(l.p1);
      return { p0: a, p1: b, move: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
    }
    if (l.type === 'radial') {
      const { c, ax, ay } = radialAxes(l);
      return {
        move: S(c), xp: S([c[0] + ax[0], c[1] + ax[1]]), xn: S([c[0] - ax[0], c[1] - ax[1]]),
        yp: S([c[0] + ay[0], c[1] + ay[1]]), yn: S([c[0] - ay[0], c[1] - ay[1]]),
      };
    }
    return {};
  }

  function anchor(l) {
    if (l.type === 'linear') return handles(l).move;
    if (l.type === 'radial') return srcToScreen(l.c);
    return l.strokes[0] ? srcToScreen(l.strokes[0].pts[0]) : null;
  }

  /* ----- pointer ----- */

  function pointerDown(p) {
    const uv = screenToSrc(p), tol = 12 * devicePixelRatio;
    if (creating) {
      const type = creating; creating = null;
      const l = type === 'linear'
        ? add('linear', { p0: uv.map(r4), p1: uv.map(r4) })
        : add('radial', { c: uv.map(r4), rx: 0.001, ry: 0.001, angle: 0, feather: 0.5, invert: false });
      if (!l) return false;
      drag = { kind: 'create', l, start: p };
      refresh();
      return true;
    }
    const cur = sel();
    if (cur && cur.type !== 'brush') {
      for (const [name, pt] of Object.entries(handles(cur))) {
        if (dist(pt, p) <= tol) { drag = { kind: 'handle', name, l: cur, startUv: uv, orig: JSON.parse(JSON.stringify(cur)) }; return true; }
      }
    }
    for (const l of list()) {
      const a = anchor(l);
      if (l !== cur && a && dist(a, p) <= tol) { state.selLocal = l.id; refresh(); requestRender(); return true; }
    }
    if (cur?.type === 'brush') {
      const stroke = { size: r4(brush.size), feather: brush.feather, flow: brush.flow, erase, pts: [uv.map(r4)] };
      cur.strokes.push(stroke);
      const e = entryFor(cur);
      if (e.sig !== null || cur.strokes.length === 1) { dabs(e, stroke, 0); e.sig = signature(cur); }
      drag = { kind: 'paint', l: cur, stroke };
      return true;
    }
    return false;
  }

  function pointerMove(p) {
    cursor = p;
    if (!drag) return;
    const uv = screenToSrc(p), l = drag.l;
    if (drag.kind === 'paint') {
      const s = drag.stroke, last = toPx(s.pts[s.pts.length - 1]), now = toPx(uv);
      if (dist(last, now) < s.size * longEdge() * 0.15) return;
      s.pts.push(uv.map(r4));
      const e = entryFor(l);
      dabs(e, s, s.pts.length - 1); e.sig = signature(l);
    } else if (drag.kind === 'create' || drag.kind === 'handle') {
      const name = drag.kind === 'create' ? (l.type === 'linear' ? 'p1' : 'corner') : drag.name;
      if (l.type === 'linear') {
        if (name === 'move') {
          const d = [uv[0] - drag.startUv[0], uv[1] - drag.startUv[1]];
          l.p0 = [r4(drag.orig.p0[0] + d[0]), r4(drag.orig.p0[1] + d[1])];
          l.p1 = [r4(drag.orig.p1[0] + d[0]), r4(drag.orig.p1[1] + d[1])];
        } else l[name] = uv.map(r4);
      } else {
        const c = toPx(l.c), q = toPx(uv), d = [q[0] - c[0], q[1] - c[1]], L = longEdge();
        if (name === 'move') {
          l.c = [r4(drag.orig.c[0] + uv[0] - drag.startUv[0]), r4(drag.orig.c[1] + uv[1] - drag.startUv[1])];
        } else if (name === 'corner') {
          l.rx = Math.max(0.004, r4(Math.abs(d[0]) / L)); l.ry = Math.max(0.004, r4(Math.abs(d[1]) / L));
        } else if (name[0] === 'x') {
          l.rx = Math.max(0.004, r4(Math.hypot(...d) / L));
          l.angle = r4(Math.atan2(d[1], d[0]) + (name === 'xn' ? Math.PI : 0));
        } else {
          l.ry = Math.max(0.004, r4(Math.hypot(...d) / L));
          l.angle = r4(Math.atan2(d[1], d[0]) - Math.PI / 2 + (name === 'yn' ? Math.PI : 0));
        }
      }
    }
  }

  function pointerUp() {
    if (!drag) return;
    const { kind, l, stroke } = drag;
    drag = null;
    if (kind === 'create') {
      // A plain click gets a sensible default size instead of a degenerate mask.
      if (l.type === 'linear' && dist(toPx(l.p0), toPx(l.p1)) < longEdge() * 0.01) l.p1 = [l.p0[0], r4(Math.min(1, l.p0[1] + 0.25))];
      if (l.type === 'radial' && Math.max(l.rx, l.ry) < 0.01) { l.rx = 0.15; l.ry = 0.15; }
      commit('Add ' + l.name);
    } else if (kind === 'paint') commit(stroke.erase ? 'Erase' : 'Brush stroke');
    else commit('Move ' + l.name);
    refresh();
  }

  /* ----- overlay ----- */

  function draw(ctx) {
    const d = devicePixelRatio, cur = sel();
    ctx.save();
    ctx.lineWidth = 1.5 * d;
    const dot = (p, r, fill) => {
      ctx.beginPath(); ctx.arc(p[0], p[1], r * d, 0, 7);
      ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.stroke();
    };
    const line = (pts, close) => {
      for (const [w, c] of [[3.5, 'rgba(0,0,0,0.45)'], [1.5, '#fff']]) {
        ctx.lineWidth = w * d; ctx.strokeStyle = c; ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
        if (close) ctx.closePath();
        ctx.stroke();
      }
    };
    for (const l of list()) {
      const a = anchor(l);
      if (a && l !== cur) dot(a, 5, l.enabled ? '#cfcfcf' : '#666');
    }
    if (cur?.type === 'linear') {
      const h = handles(cur), dir = [h.p1[0] - h.p0[0], h.p1[1] - h.p0[1]];
      const len = Math.hypot(...dir) || 1, n = [-dir[1] / len, dir[0] / len], far = ctx.canvas.width + ctx.canvas.height;
      for (const p of [h.p0, h.p1]) line([[p[0] - n[0] * far, p[1] - n[1] * far], [p[0] + n[0] * far, p[1] + n[1] * far]]);
      line([h.p0, h.p1]);
      dot(h.p0, 6, '#e3a23a'); dot(h.p1, 6, '#fff'); dot(h.move, 5, '#e3a23a');
    } else if (cur?.type === 'radial') {
      const { c, ax, ay } = radialAxes(cur), pts = [];
      for (let i = 0; i < 72; i++) {
        const t = i / 72 * Math.PI * 2, px = [c[0] + ax[0] * Math.cos(t) + ay[0] * Math.sin(t), c[1] + ax[1] * Math.cos(t) + ay[1] * Math.sin(t)];
        pts.push(srcToScreen([px[0] / src().width, px[1] / src().height]));
      }
      line(pts, true);
      const h = handles(cur);
      for (const k of ['xp', 'xn', 'yp', 'yn']) dot(h[k], 5, '#fff');
      dot(h.move, 6, '#e3a23a');
    } else if (cur?.type === 'brush' && cursor && !creating) {
      const R = brush.size * longEdge() * state.view.shown;
      for (const [r, c] of [[R, '#fff'], [R * (1 - brush.feather), 'rgba(255,255,255,0.5)']]) {
        ctx.lineWidth = 1.25 * d; ctx.strokeStyle = c; ctx.beginPath(); ctx.arc(cursor[0], cursor[1], Math.max(1, r), 0, 7); ctx.stroke();
      }
      const a = anchor(cur);
      if (a) dot(a, 5, '#e3a23a');
    }
    ctx.restore();
  }

  /* ----- panel ----- */

  const controls = [];
  const onInput = () => requestRender();
  const adjSliders = ADJ.map(([label, key, opts]) => {
    const c = slider({
      label, min: -100, max: 100, def: 0, ...opts,
      get: () => sel()?.[key] ?? 0, set: (v) => { const l = sel(); if (l) l[key] = v ?? 0; },
      onInput, onCommit: (lbl) => commit(`${sel()?.name}: ${lbl}`),
    });
    controls.push(c); return c.node;
  });
  const pct = (label, obj, key, min, max, def, scale = 100) => {
    const c = slider({
      label, min, max, def,
      get: () => Math.round((obj()?.[key] ?? 0) * scale), set: (v) => { const o = obj(); if (o) o[key] = (v ?? def) / scale; },
      onInput, onCommit: (lbl) => { if (obj() !== brush) commit(`${sel()?.name}: ${lbl}`); },
    });
    controls.push(c); return c.node;
  };
  const featherRow = pct('Feather', sel, 'feather', 0, 100, 50);
  const invertBox = el('input', { type: 'checkbox', onchange: () => { const l = sel(); if (l) { l.invert = invertBox.checked; requestRender(); commit(`${l.name}: invert`); } } });
  const radialOpts = el('div', {}, featherRow, el('label', { class: 'check' }, invertBox, 'Invert (affect outside)'));
  const eraseBtn = el('button', { type: 'button', title: 'Toggle erase (X)', onclick: () => { erase = !erase; refresh(); } }, 'Erase');
  const brushOpts = el('div', {},
    pct('Size', () => brush, 'size', 1, 30, 5), pct('Feather', () => brush, 'feather', 0, 100, 60), pct('Flow', () => brush, 'flow', 5, 100, 60),
    el('div', { class: 'row' }, eraseBtn, el('span', { class: 'hint', style: 'width:auto;margin:0' }, 'Paint on the photo. Hold Space to pan.')));
  const showBox = el('input', { type: 'checkbox', onchange: () => { alwaysShow = showBox.checked; requestRender(); } });
  const listNode = el('ul', { class: 'list' });
  const editor = el('div', {}, radialOpts, brushOpts,
    el('label', { class: 'check', style: 'margin:6px 0' }, showBox, 'Show mask overlay'),
    el('div', { class: 'sub' }, 'Adjustments'), adjSliders,
    el('button', { type: 'button', class: 'wide', onclick: () => {
      const l = sel(); if (!l) return;
      for (const [, key] of ADJ) l[key] = 0;
      refresh(); requestRender(); commit(`${l.name}: reset`);
    } }, 'Reset adjustments'));
  const startCreate = (type) => {
    if (!src()) return;
    if (list().length >= MAX_LOCALS) { toast(`Up to ${MAX_LOCALS} local adjustments per photo.`, true); return; }
    setTool('local');
    if (type === 'brush') {
      creating = null;
      add('brush', { strokes: [] });
      commit('Add brush');
    } else {
      creating = type; state.selLocal = null;
      toast(type === 'linear' ? 'Drag on the photo: the effect is full where you start and fades to where you release.' : 'Drag on the photo to draw the radial area.');
    }
    refresh(); requestRender();
  };
  const addBtns = [['linear', '+ Gradient'], ['radial', '+ Radial'], ['brush', '+ Brush']].map(([t, label]) =>
    el('button', { type: 'button', onclick: () => startCreate(t) }, label));
  const empty = el('p', { class: 'hint' }, 'Adjust part of the photo: darken a sky with a gradient, lift a face with a radial, or paint with the brush.');
  const node = section('Local adjustments', [el('div', { class: 'row' }, addBtns), listNode, empty, editor], true);

  function refresh() {
    const cur = sel(), has = !!src();
    addBtns.forEach((b, i) => { b.disabled = !has; b.classList.toggle('on', creating === ['linear', 'radial'][i]); });
    listNode.replaceChildren(...list().map((l) => {
      const on = el('input', { type: 'checkbox', title: 'Enable', 'aria-label': `Enable ${l.name}`, onchange: () => { l.enabled = on.checked; requestRender(); commit(`${l.name} ${l.enabled ? 'on' : 'off'}`); } });
      on.checked = l.enabled;
      return el('li', { class: l === cur && state.tool === 'local' ? 'current' : '' }, on,
        el('button', { type: 'button', onclick: () => { state.selLocal = l.id; creating = null; setTool('local'); refresh(); } }, l.name),
        el('button', { type: 'button', class: 'del', title: 'Delete', 'aria-label': `Delete ${l.name}`, onclick: () => {
          list().splice(list().indexOf(l), 1);
          if (state.selLocal === l.id) state.selLocal = null;
          refresh(); requestRender(); commit('Delete ' + l.name);
        } }, '×'));
    }));
    empty.hidden = list().length > 0;
    editor.hidden = !cur;
    radialOpts.hidden = cur?.type !== 'radial';
    brushOpts.hidden = cur?.type !== 'brush';
    invertBox.checked = !!cur?.invert;
    showBox.checked = alwaysShow;
    eraseBtn.classList.toggle('on', erase);
    for (const c of controls) c.refresh();
  }

  return {
    node, refresh, draw, syncMasks, pointerDown, pointerMove, pointerUp,
    // Which mask to tint on screen: always while shaping or painting, otherwise on request.
    shownMask: () => (state.tool === 'local' && (drag || alwaysShow) ? state.selLocal : null),
    cursorStyle: () => (creating ? 'crosshair' : sel()?.type === 'brush' ? 'none' : 'default'),
    cancelCreate: () => { creating = null; },
    toggleErase: () => { erase = !erase; refresh(); },
    resizeBrush: (k) => { brush.size = Math.min(0.3, Math.max(0.01, brush.size * k)); refresh(); requestRender(); },
    wantsPointer: () => !!creating || !!sel(),
  };
}
