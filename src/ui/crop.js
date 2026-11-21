// Crop rectangle interaction, in overlay (CSS pixel) coordinates.
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

function handlePoints(r) {
  const mx = (r.x0 + r.x1) / 2, my = (r.y0 + r.y1) / 2;
  return { nw: [r.x0, r.y0], n: [mx, r.y0], ne: [r.x1, r.y0], e: [r.x1, my], se: [r.x1, r.y1], s: [mx, r.y1], sw: [r.x0, r.y1], w: [r.x0, my] };
}

export function hitTest(r, x, y, tol = 14) {
  const pts = handlePoints(r);
  for (const h of ['nw', 'ne', 'se', 'sw', 'n', 'e', 's', 'w']) {
    if (Math.abs(pts[h][0] - x) <= tol && Math.abs(pts[h][1] - y) <= tol) return h;
  }
  if (Math.abs(x - r.x0) <= tol / 2 && y > r.y0 && y < r.y1) return 'w';
  if (Math.abs(x - r.x1) <= tol / 2 && y > r.y0 && y < r.y1) return 'e';
  if (Math.abs(y - r.y0) <= tol / 2 && x > r.x0 && x < r.x1) return 'n';
  if (Math.abs(y - r.y1) <= tol / 2 && x > r.x0 && x < r.x1) return 's';
  if (x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1) return 'move';
  return null;
}

export const cursorFor = (h) => ({ nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', move: 'move' }[h] || 'default');

export function dragRect(r, handle, dx, dy, aspect, min = 24) {
  let { x0, y0, x1, y1 } = r;
  if (handle === 'move') return { x0: x0 + dx, y0: y0 + dy, x1: x1 + dx, y1: y1 + dy };
  if (handle.includes('w')) x0 = Math.min(x0 + dx, x1 - min);
  if (handle.includes('e')) x1 = Math.max(x1 + dx, x0 + min);
  if (handle.includes('n')) y0 = Math.min(y0 + dy, y1 - min);
  if (handle.includes('s')) y1 = Math.max(y1 + dy, y0 + min);
  if (aspect) {
    let w = x1 - x0, h = y1 - y0;
    if (handle.length === 2) {
      if (w / aspect > h) h = w / aspect; else w = h * aspect;
      if (handle.includes('w')) x0 = x1 - w; else x1 = x0 + w;
      if (handle.includes('n')) y0 = y1 - h; else y1 = y0 + h;
    } else if (handle === 'e' || handle === 'w') {
      h = w / aspect; const cy = (r.y0 + r.y1) / 2; y0 = cy - h / 2; y1 = cy + h / 2;
    } else {
      w = h * aspect; const cx = (r.x0 + r.x1) / 2; x0 = cx - w / 2; x1 = cx + w / 2;
    }
  }
  return { x0, y0, x1, y1 };
}

export function drawCrop(ctx, W, H, r) {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(12,12,12,0.62)';
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.rect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  ctx.fill('evenodd');
  const w = r.x1 - r.x0, h = r.y1 - r.y0;
  ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < 3; i++) {
    ctx.moveTo(Math.round(r.x0 + w * i / 3) + 0.5, r.y0); ctx.lineTo(Math.round(r.x0 + w * i / 3) + 0.5, r.y1);
    ctx.moveTo(r.x0, Math.round(r.y0 + h * i / 3) + 0.5); ctx.lineTo(r.x1, Math.round(r.y0 + h * i / 3) + 0.5);
  }
  ctx.stroke();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
  ctx.strokeRect(r.x0, r.y0, w, h);
  ctx.fillStyle = '#fff';
  const pts = handlePoints(r);
  for (const k of HANDLES) ctx.fillRect(pts[k][0] - 4, pts[k][1] - 4, 8, 8);
}
