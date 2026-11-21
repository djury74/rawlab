// White balance maths and tone-curve interpolation.

// Planckian locus in CIE 1960 uv (Krystek 1985), valid roughly 1000K to 15000K
// and well behaved beyond that.
function planckUV(T) {
  const u = (0.860117757 + 1.54118254e-4 * T + 1.28641212e-7 * T * T) /
            (1 + 8.42420235e-4 * T + 7.08145163e-7 * T * T);
  const v = (0.317398726 + 4.22806245e-5 * T + 4.20481691e-8 * T * T) /
            (1 - 2.89741816e-5 * T + 1.61456053e-7 * T * T);
  return [u, v];
}

// Unit normal to the locus at T, pointing towards green (positive Duv).
function locusNormal(T) {
  const d = T * 0.001;
  const [u0, v0] = planckUV(T - d), [u1, v1] = planckUV(T + d);
  let tx = u1 - u0, ty = v1 - v0;
  const len = Math.hypot(tx, ty) || 1;
  tx /= len; ty /= len;
  let nx = -ty, ny = tx;
  if (ny < 0) { nx = -nx; ny = -ny; }
  return [nx, ny];
}

const TINT_SCALE = 3000; // tint units per unit Duv; positive tint = more magenta image

export function tempTintToXYZ(temp, tint) {
  let [u, v] = planckUV(temp);
  const [nx, ny] = locusNormal(temp);
  const duv = tint / TINT_SCALE;
  u += nx * duv; v += ny * duv;
  const den = 2 * u - 8 * v + 4;
  const x = 3 * u / den, y = 2 * v / den;
  return [x / y, 1, (1 - x - y) / y];
}

export function xyzToTempTint([X, Y, Z]) {
  const s = X + Y + Z;
  const x = X / s, y = Y / s;
  const den = -2 * x + 12 * y + 3;
  const u = 4 * x / den, v = 6 * y / den;
  // Search in mired space for the nearest point on the locus.
  let best = 5500, bestD = Infinity;
  for (let m = 40; m <= 600; m += 2) {
    const T = 1e6 / m, [pu, pv] = planckUV(T);
    const d = (pu - u) ** 2 + (pv - v) ** 2;
    if (d < bestD) { bestD = d; best = T; }
  }
  let lo = 1e6 / (1e6 / best + 2), hi = 1e6 / Math.max(1e6 / best - 2, 1);
  for (let i = 0; i < 40; i++) {
    const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3;
    const da = Math.hypot(planckUV(a)[0] - u, planckUV(a)[1] - v);
    const db = Math.hypot(planckUV(b)[0] - u, planckUV(b)[1] - v);
    if (da < db) hi = b; else lo = a;
  }
  const T = (lo + hi) / 2;
  const [pu, pv] = planckUV(T), [nx, ny] = locusNormal(T);
  const duv = (u - pu) * nx + (v - pv) * ny;
  return { temp: T, tint: duv * TINT_SCALE };
}

const XYZ_TO_SRGB = [
  [3.2404542, -1.5371385, -0.4985314],
  [-0.9692660, 1.8760108, 0.0415560],
  [0.0556434, -0.2040259, 1.0572252],
];
const SRGB_TO_XYZ = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.0721750],
  [0.0193339, 0.1191920, 0.9503041],
];
const mul3 = (m, v) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);

function inv3(m) {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!det) return null;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

// Estimate the as-shot temperature/tint from the camera's WB multipliers and
// its colour matrix. Approximate: the matrix is a single D65 calibration.
export function asShotFromCamera(camMul, camXyz) {
  try {
    const inv = inv3(camXyz.slice(0, 3).map((r) => r.slice(0, 3)));
    const g = camMul[1] || 1;
    const neutral = [g / camMul[0], 1, g / camMul[2]];
    const xyz = mul3(inv, neutral);
    if (xyz.some((n) => !(n > 0))) throw 0;
    const r = xyzToTempTint(xyz);
    if (!(r.temp > 1500 && r.temp < 30000) || Math.abs(r.tint) > 150) throw 0;
    return r;
  } catch {
    return null;
  }
}

// RGB gains (applied to linear data already balanced for `asShot`) that
// re-balance the image for a light source of `temp`/`tint`.
export function wbGains(asShot, temp, tint) {
  const a = mul3(XYZ_TO_SRGB, tempTintToXYZ(asShot.temp, asShot.tint));
  const t = mul3(XYZ_TO_SRGB, tempTintToXYZ(temp, tint));
  const g = a.map((v, i) => Math.max(v, 1e-4) / Math.max(t[i], 1e-4));
  return g.map((v) => v / g[1]);
}

// Temperature/tint that would make the linear colour `rgb` neutral.
export function neutraliseToTempTint(asShot, rgb) {
  const a = mul3(XYZ_TO_SRGB, tempTintToXYZ(asShot.temp, asShot.tint));
  const target = a.map((v, i) => v * Math.max(rgb[i], 1e-5));
  return xyzToTempTint(mul3(SRGB_TO_XYZ, target));
}

// Monotone cubic interpolation (Fritsch-Carlson) through curve points.
export function curveSampler(points) {
  const p = [...points].sort((a, b) => a[0] - b[0]);
  const n = p.length;
  if (n < 2) return (x) => x;
  const dx = [], m = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(Math.max(p[i + 1][0] - p[i][0], 1e-6));
    m.push((p[i + 1][1] - p[i][1]) / dx[i]);
  }
  const t = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
  t.push(m[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  return (x) => {
    if (x <= p[0][0]) return p[0][1];
    if (x >= p[n - 1][0]) return p[n - 1][1];
    let i = 0;
    while (i < n - 2 && x > p[i + 1][0]) i++;
    const h = dx[i], s = (x - p[i][0]) / h, s2 = s * s, s3 = s2 * s;
    const y = (2 * s3 - 3 * s2 + 1) * p[i][1] + (s3 - 2 * s2 + s) * h * t[i] +
              (-2 * s3 + 3 * s2) * p[i + 1][1] + (s3 - s2) * h * t[i + 1];
    return Math.min(1, Math.max(0, y));
  };
}

// 1024-entry RGBA lookup: each channel is channelCurve(masterCurve(x)).
export function buildCurveLUT(curve, size = 1024) {
  const master = curveSampler(curve.rgb);
  const ch = [curveSampler(curve.r), curveSampler(curve.g), curveSampler(curve.b)];
  const out = new Float32Array(size * 4);
  for (let i = 0; i < size; i++) {
    const m = master(i / (size - 1));
    out[i * 4] = ch[0](m); out[i * 4 + 1] = ch[1](m); out[i * 4 + 2] = ch[2](m); out[i * 4 + 3] = 1;
  }
  return out;
}

export function hsvToRgb(h, s, v) {
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)];
}
