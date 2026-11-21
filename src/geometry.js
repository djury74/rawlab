// Coordinate spaces:
//   src uv    : decoded image, 0..1, origin top-left
//   frame px  : image after 90-degree rotation and flips, in pixels
//   crop      : rectangle centred at C in the frame, rotated by the straighten angle
// Every mapping here is affine, so the renderer only needs three points.

const rot = (v, a) => [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a)];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];

export function geometry(settings, srcW, srcH) {
  const k = ((settings.rot % 4) + 4) % 4;
  const Wf = k % 2 ? srcH : srcW, Hf = k % 2 ? srcW : srcH;
  const c = settings.crop;
  const theta = c.angle * Math.PI / 180;
  const C = [c.cx * Wf, c.cy * Hf];
  const cw = c.w * Wf, ch = c.h * Hf;

  const frameToSrc = (p) => {
    let fx = p[0] / Wf, fy = p[1] / Hf;
    if (settings.flipH) fx = 1 - fx;
    if (settings.flipV) fy = 1 - fy;
    if (k === 1) return [fy, 1 - fx];
    if (k === 2) return [1 - fx, 1 - fy];
    if (k === 3) return [1 - fy, fx];
    return [fx, fy];
  };
  const srcToFrame = (uv) => {
    let fx, fy;
    if (k === 1) { fx = 1 - uv[1]; fy = uv[0]; }
    else if (k === 2) { fx = 1 - uv[0]; fy = 1 - uv[1]; }
    else if (k === 3) { fx = uv[1]; fy = 1 - uv[0]; }
    else { fx = uv[0]; fy = uv[1]; }
    if (settings.flipH) fx = 1 - fx;
    if (settings.flipV) fy = 1 - fy;
    return [fx * Wf, fy * Hf];
  };
  const frameToCropUV = (p) => {
    const q = rot(sub(p, C), -theta);
    return [q[0] / cw + 0.5, q[1] / ch + 0.5];
  };
  const cropToFrame = (q) => add(C, rot(q, theta));
  return { Wf, Hf, C, cw, ch, theta, frameToSrc, srcToFrame, frameToCropUV, cropToFrame };
}

// Affine map target px -> frame px for rendering the crop at ow x oh,
// offset by (x0, y0) so the output can be rendered in tiles.
export function exportAffine(g, ow, oh, x0 = 0, y0 = 0) {
  const sx = g.cw / ow, sy = g.ch / oh;
  return {
    A: g.cropToFrame([x0 * sx - g.cw / 2, y0 * sy - g.ch / 2]),
    U: rot([sx, 0], g.theta),
    V: rot([0, sy], g.theta),
  };
}

// Affine map for the on-screen view: `origin` (frame px) sits at the centre of
// a w x h target, at `zoom` target px per image px, rotated with the crop.
export function viewAffine(g, origin, zoom, w, h) {
  const U = rot([1 / zoom, 0], g.theta), V = rot([0, 1 / zoom], g.theta);
  const A = sub(origin, add(U.map((v) => v * w / 2), V.map((v) => v * h / 2)));
  return { A, U, V };
}

export const applyAffine = (af, x, y) => [af.A[0] + af.U[0] * x + af.V[0] * y, af.A[1] + af.U[1] * x + af.V[1] * y];

export function invertAffine(af, p) {
  const d = sub(p, af.A);
  const det = af.U[0] * af.V[1] - af.V[0] * af.U[1];
  return [(d[0] * af.V[1] - af.V[0] * d[1]) / det, (af.U[0] * d[1] - d[0] * af.U[1]) / det];
}

// Is a crop (normalised cx, cy, w, h + angle) entirely inside the frame?
export function cropFits(crop, Wf, Hf, eps = 0.75) {
  const a = crop.angle * Math.PI / 180;
  const C = [crop.cx * Wf, crop.cy * Hf], hw = crop.w * Wf / 2, hh = crop.h * Hf / 2;
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const p = add(C, rot([sx * hw, sy * hh], a));
    if (p[0] < -eps || p[1] < -eps || p[0] > Wf + eps || p[1] > Hf + eps) return false;
  }
  return true;
}

// Largest scale (<= maxScale) of the crop about its centre that still fits.
export function fitCropScale(crop, Wf, Hf, maxScale = 1) {
  const at = (s) => cropFits({ ...crop, w: crop.w * s, h: crop.h * s }, Wf, Hf);
  if (at(maxScale)) return maxScale;
  let lo = 0, hi = maxScale;
  for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (at(m)) lo = m; else hi = m; }
  return lo;
}

export { rot, add, sub };
