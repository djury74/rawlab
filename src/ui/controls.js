// Small DOM helpers and the slider control used throughout the panels.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

/**
 * A labelled slider with an editable value.
 *   get/set     read and write the bound setting
 *   onInput     live change;  onCommit  change finished (one undo step)
 *   toPos/fromPos  optional non-linear mapping between value and track position (0..1)
 * Double-click the label to reset.
 */
export function slider({ label, min, max, step = 1, def = 0, get, set, onInput, onCommit, toPos, fromPos, format, swatch }) {
  const linear = !toPos;
  const range = el('input', {
    type: 'range', min: linear ? min : 0, max: linear ? max : 1000, step: linear ? step : 1, 'aria-label': label,
  });
  const num = el('input', { type: 'text', class: 'num', inputmode: 'decimal', 'aria-label': label + ' value' });
  const fmt = format || ((v) => (step < 1 ? v.toFixed(2) : String(Math.round(v))));
  const value = () => { const v = get(); return v == null ? (typeof def === 'function' ? def() : def) : v; };
  const refresh = () => {
    const v = value();
    range.value = linear ? v : Math.round(toPos(v) * 1000);
    if (document.activeElement !== num) num.value = fmt(v);
    row.classList.toggle('changed', get() != null && Math.abs(v - (typeof def === 'function' ? def() : def)) > 1e-9);
  };
  const clamp = (v) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  let dirty = false;
  range.addEventListener('input', () => {
    set(clamp(linear ? +range.value : fromPos(+range.value / 1000)));
    dirty = true; refresh(); onInput();
  });
  const commit = () => { if (dirty) { dirty = false; onCommit(label); } };
  range.addEventListener('change', commit);
  num.addEventListener('change', () => {
    const v = parseFloat(num.value);
    if (Number.isFinite(v)) { set(clamp(v)); onInput(); onCommit(label); }
    num.blur(); refresh();
  });
  num.addEventListener('keydown', (e) => { if (e.key === 'Enter') num.blur(); e.stopPropagation(); });
  const name = el('span', { class: 'name', title: 'Double-click to reset' }, swatch ? el('i', { class: 'swatch', style: `background:${swatch}` }) : null, label);
  name.addEventListener('dblclick', () => { set(null); refresh(); onInput(); onCommit('Reset ' + label); });
  const row = el('label', { class: 'slider' }, name, range, num);
  row.addEventListener('click', (e) => { if (e.target === name || e.target.parentNode === name) e.preventDefault(); });
  refresh();
  return { node: row, refresh };
}

export function section(title, body, open = true) {
  const d = el('details', { class: 'section' }, el('summary', {}, title), el('div', { class: 'body' }, body));
  d.open = open;
  return d;
}
