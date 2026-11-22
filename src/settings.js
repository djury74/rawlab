// Edit settings: the complete, serialisable description of a develop.
// The original file is never modified; everything is re-rendered from these.

export const HSL_BANDS = [
  { name: 'Red', hue: 0 }, { name: 'Orange', hue: 30 }, { name: 'Yellow', hue: 60 },
  { name: 'Green', hue: 120 }, { name: 'Aqua', hue: 180 }, { name: 'Blue', hue: 240 },
  { name: 'Purple', hue: 280 }, { name: 'Magenta', hue: 320 },
];

const identityCurve = () => [[0, 0], [1, 1]];
const zeros8 = () => [0, 0, 0, 0, 0, 0, 0, 0];

export function defaults() {
  return {
    version: 2,               // 2: rendering works on true linear data
    profile: 'standard',      // standard | vivid | linear
    bw: false,
    temp: null, tint: null,   // null = as shot
    exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
    texture: 0, clarity: 0, dehaze: 0, vibrance: 0, saturation: 0,
    curve: { rgb: identityCurve(), r: identityCurve(), g: identityCurve(), b: identityCurve() },
    hsl: { hue: zeros8(), sat: zeros8(), lum: zeros8() },
    grade: { shHue: 220, shSat: 0, hiHue: 40, hiSat: 0, balance: 0 },
    sharpen: 30, sharpRadius: 1.0, nrLuma: 0, nrColor: 25,
    vignette: 0, vigMid: 50, vigFeather: 50, grain: 0, grainSize: 25,
    crop: { cx: 0.5, cy: 0.5, w: 1, h: 1, angle: 0, aspect: 'original' },
    rot: 0, flipH: false, flipV: false,
    lens: { profile: 'auto', distortion: 100, vignetting: 100, ca: true },
    spots: [],                // spot removal: { x, y, sx, sy, r, f } in image coordinates
    locals: [],               // local adjustments: gradient, radial and brush masks
  };
}

export const clone = (o) => JSON.parse(JSON.stringify(o));

// Merge a (possibly partial or older) settings object over defaults.
export function normalise(partial) {
  const merge = (base, over) => {
    if (over === undefined) return base;
    if (Array.isArray(base) || base === null || typeof base !== 'object') return over;
    const out = {};
    for (const k of Object.keys(base)) out[k] = merge(base[k], over?.[k]);
    return out;
  };
  return merge(defaults(), partial || {});
}

// Per-image settings that presets and copy/paste leave alone.
const GEOMETRY_KEYS = ['crop', 'rot', 'flipH', 'flipV', 'locals', 'lens', 'spots'];

// Settings without crop/rotation: what presets and copy/paste carry.
export function lookOnly(s) {
  const out = clone(s);
  for (const k of GEOMETRY_KEYS) delete out[k];
  delete out.version;
  return out;
}

export function applyLook(target, look) {
  const merged = normalise({ ...clone(target), ...clone(look) });
  for (const k of GEOMETRY_KEYS) merged[k] = clone(target[k]);
  return merged;
}

// Allowed range of each numeric setting, for anything that computes values.
const RANGES = {
  exposure: [-5, 5], sharpen: [0, 150], sharpRadius: [0.5, 3], nrLuma: [0, 100], nrColor: [0, 100],
  vigMid: [0, 100], vigFeather: [0, 100], grain: [0, 100], grainSize: [0, 100],
  shSat: [0, 100], hiSat: [0, 100],
};
const HUES = new Set(['shHue', 'hiHue']);

// A look part-way between `from` and `to` (both complete settings). `k` is 0 for
// `from`, 1 for `to`, and may go to 2 to exaggerate. Numbers are interpolated and
// kept within their slider ranges; curve points are scaled away from the
// starting curve; choices such as profile and black-and-white switch at k > 0.
export function blendLook(from, to, k) {
  const walk = (a, b, key) => {
    if (typeof b === 'number' && typeof a === 'number') {
      if (HUES.has(key)) return k > 0 ? b : a;
      const [lo, hi] = RANGES[key] || [-100, 100];
      const v = a + (b - a) * k;
      return Math.round(Math.min(hi, Math.max(lo, v)) * 100) / 100;
    }
    if (Array.isArray(b)) {
      if (Array.isArray(a) && a.length === b.length && b.every((v) => typeof v === 'number')) return b.map((v, i) => walk(a[i], v, key));
      return b;
    }
    if (b && typeof b === 'object' && a && typeof a === 'object') {
      const out = {};
      for (const kk of Object.keys(b)) out[kk] = walk(a[kk], b[kk], kk);
      return out;
    }
    return k > 0 ? b : a;
  };
  const out = walk(from, to);
  // Tone curves: move each point of the target curve towards or beyond where
  // the starting curve puts it. Only when the starting curve is the straight line.
  for (const ch of ['rgb', 'r', 'g', 'b']) {
    const a = from.curve[ch], b = to.curve[ch];
    const straight = a.length === 2 && a[0][0] === 0 && a[0][1] === 0 && a[1][0] === 1 && a[1][1] === 1;
    if (straight) out.curve[ch] = b.map(([x, y]) => [x, Math.min(1, Math.max(0, x + (y - x) * k))]);
    else out.curve[ch] = clone(k > 0 ? b : a);
  }
  for (const key of GEOMETRY_KEYS) out[key] = clone(to[key]);
  return out;
}

const S = (pts) => pts;
export const BUILTIN_PRESETS = [
  { name: 'Punchy', look: { contrast: 25, clarity: 20, vibrance: 30, blacks: -10, whites: 8 } },
  { name: 'Soft matte', look: { contrast: -10, highlights: -30, shadows: 30, saturation: -12,
      curve: { rgb: S([[0, 0.07], [0.25, 0.24], [0.75, 0.76], [1, 0.95]]), r: identityCurve(), g: identityCurve(), b: identityCurve() } } },
  { name: 'Warm evening', look: { contrast: 10, vibrance: 15, highlights: -20,
      grade: { shHue: 230, shSat: 12, hiHue: 38, hiSat: 28, balance: 10 } } },
  { name: 'Cool fade', look: { contrast: -5, saturation: -15, blacks: 20,
      grade: { shHue: 205, shSat: 25, hiHue: 55, hiSat: 8, balance: -10 } } },
  { name: 'B&W contrast', look: { bw: true, contrast: 35, clarity: 20, blacks: -15, grain: 20 } },
  { name: 'B&W soft', look: { bw: true, contrast: -5, shadows: 25, highlights: -20 } },
  { name: 'Recover highlights and shadows', look: { highlights: -70, shadows: 60, contrast: 10, vibrance: 10 } },
];
