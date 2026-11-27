// Lens correction profiles: distortion, lateral chromatic aberration and vignetting.
//
// Calibration values come from the lensfun database (https://lensfun.github.io),
// which is licensed CC BY-SA 3.0. Camera makers do not publish these numbers.
//
// Models (lensfun conventions):
//   distortion 'ptlens': Rd = Ru * (a*Ru^3 + b*Ru^2 + c*Ru + 1 - a - b - c),
//                        R = 1 at half the shorter image side
//   tca 'linear':        red and blue are magnified by kr and kb relative to green
//   vignetting 'pa':     measured = true * (1 + k1*R^2 + k2*R^4 + k3*R^6),
//                        R = 1 at the image corner

// Each profile lists measurements by focal length (one entry for a prime):
//   distortion  [{ focal, a, b, c }]
//   tca         [{ focal, kr, kb }]            or null if not measured
//   vignetting  [{ focal, byAperture: [{ f, k: [k1, k2, k3] }] }]   or null
// Values between measured focal lengths and apertures are interpolated.

const nikon = (shot) => /nikon/i.test(shot.make || '');
const near = (a, b, tol) => a > 0 && Math.abs(a - b) <= tol;

export const LENS_PROFILES = [
  {
    id: 'nikon-afs-dx-35-1.8g',
    name: 'Nikon AF-S DX Nikkor 35mm f/1.8G',
    cropFactor: 1.528,                      // measured on an APS-C (DX) body
    distortion: [{ focal: 35, a: 0.003, b: -0.017, c: 0.005 }],
    tca: [{ focal: 35, kr: 1.0003, kb: 1.0003 }],
    vignetting: [{ focal: 35, byAperture: [
      { f: 1.8, k: [-0.3298, -0.0595, 0.0938] },
      { f: 2.8, k: [-0.1367, 0.0656, -0.0502] },
      { f: 4, k: [-0.1170, 0.0027, 0.0072] },
      { f: 5, k: [-0.1203, 0.0086, 0.0030] },
      { f: 22, k: [-0.1143, -0.0162, 0.0186] },
    ] }],
    // Does this profile fit the shot? `shot` is the metadata gathered at decode time.
    matches(shot) {
      if (!nikon(shot)) return false;
      const name = shot.lensName || '';
      if (/\bZ\b/.test(name)) return false;                     // a Z-mount lens, not this F-mount one
      if (/35(\.0)?\s*mm/i.test(name) && /1[.:]8\s*G/i.test(name)) return !/\bED\b/.test(name);
      // Many Nikon SLR bodies record only numbers: a 35mm prime with f/1.8 maximum aperture.
      return near(shot.minFocal, 35, 0.6) && near(shot.maxFocal, 35, 0.6) && near(shot.maxAperture, 1.8, 0.11);
    },
  },
  {
    id: 'nikkor-z-dx-16-50-3.5-6.3-vr',
    name: 'Nikkor Z DX 16-50mm f/3.5-6.3 VR',
    cropFactor: 1.531,                      // measured on a Nikon Z 50
    distortion: [
      { focal: 16, a: 0.019, b: -0.062, c: 0.003 },
      { focal: 21, a: 0.012, b: -0.030, c: 0.012 },
      { focal: 24.5, a: 0.015, b: -0.034, c: 0.032 },
      { focal: 29, a: 0.011, b: -0.018, c: 0.024 },
      { focal: 35, a: 0.011, b: -0.018, c: 0.029 },
      { focal: 43, a: 0.003, b: 0.004, c: 0.006 },
      { focal: 50, a: 0.003, b: -0.004, c: 0.020 },
    ],
    tca: [
      { focal: 16, kr: 1.0002381, kb: 1.0000353 },
      { focal: 21, kr: 1.0001206, kb: 1.0001320 },
      { focal: 24.5, kr: 1.0000187, kb: 1.0002538 },
      { focal: 29, kr: 0.9999672, kb: 1.0002769 },
      { focal: 35, kr: 0.9999343, kb: 1.0002551 },
      { focal: 43, kr: 0.9999548, kb: 1.0001581 },
      { focal: 50, kr: 1.0000005, kb: 1.0000475 },
    ],
    vignetting: null,                       // not measured in lensfun
    matches(shot) {
      if (!nikon(shot)) return false;
      const name = shot.lensName || '';
      if (name) return /\bZ\b/.test(name) && /DX/i.test(name) && /16\s*-\s*50\s*mm/i.test(name) && /3[.:]5\s*-\s*6[.:]3/.test(name);
      return false;
    },
  },
  {
    id: 'nikkor-z-dx-24-1.7',
    name: 'Nikkor Z DX 24mm f/1.7',
    cropFactor: 1.531,                      // measured on a Nikon Z fc
    distortion: [{ focal: 24, a: 0.0192276, b: -0.035347, c: 0.0140277 }],
    tca: null,                              // not measured in lensfun
    vignetting: [{ focal: 24, byAperture: [
      { f: 1.7, k: [-1.8266, 1.5945, -0.5954] },
      { f: 2.5, k: [-0.7737, -0.6928, 0.6977] },
      { f: 3.5, k: [-0.4812, -0.8654, 0.5952] },
      { f: 5, k: [-0.6345, -0.1051, 0.0116] },
      { f: 11, k: [-0.8086, 0.4435, -0.2672] },
    ] }],
    matches(shot) {
      if (!nikon(shot)) return false;
      const name = shot.lensName || '';
      return /\bZ\b/.test(name) && /DX/i.test(name) && /\b24\s*mm/i.test(name) && /1[.:]7/.test(name);
    },
  },
];

export function detectProfile(shot) {
  return (shot && LENS_PROFILES.find((p) => p.matches(shot))) || null;
}

export function activeProfile(lens, shot) {
  if (lens.profile === 'off') return null;
  if (lens.profile === 'auto') return detectProfile(shot);
  return LENS_PROFILES.find((p) => p.id === lens.profile) || null;
}

// What a profile corrects, for the panel: e.g. "distortion and colour fringing".
export function profileCovers(p) {
  const parts = ['distortion', p.tca && 'colour fringing', p.vignetting && 'vignetting'].filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] : parts[0];
}

// The two measurements either side of a focal length, and how far between them.
function bracket(entries, focal) {
  if (!(focal > 0) || focal <= entries[0].focal) return [entries[0], entries[0], 0];
  const last = entries[entries.length - 1];
  if (focal >= last.focal) return [last, last, 0];
  let i = 0;
  while (focal > entries[i + 1].focal) i++;
  return [entries[i], entries[i + 1], (focal - entries[i].focal) / (entries[i + 1].focal - entries[i].focal)];
}
const mix = (a, b, t) => a + (b - a) * t;

// Vignetting coefficients for an aperture, interpolated in stops between measurements.
function vignettingAt(table, aperture) {
  if (!(aperture > 0)) return table[0].k;
  if (aperture <= table[0].f) return table[0].k;
  const last = table[table.length - 1];
  if (aperture >= last.f) return last.k;
  let i = 0;
  while (aperture > table[i + 1].f) i++;
  const t = Math.log(aperture / table[i].f) / Math.log(table[i + 1].f / table[i].f);
  return table[i].k.map((v, j) => v + (table[i + 1].k[j] - v) * t);
}

// Shader parameters for the current settings, or null when no correction applies.
// `camera` is the distortion correction the camera stored in the file, if any
// (see nikon.js). In Automatic mode it takes precedence over a profile's
// distortion: it is the maker's own correction and exists for every lens.
// A profile still supplies vignetting and colour fringing where it has them.
export function lensParams(lens, shot, camera = null) {
  const p = activeProfile(lens, shot);
  const own = lens.profile === 'auto' ? camera : null;
  if (!p && !own) return null;
  const focal = shot?.focal, d = lens.distortion / 100, v = lens.vignetting / 100;
  let dist = [0, 0, 0], tca = [1, 1], vig = [0, 0, 0];
  if (p) {
    const [d0, d1, dt] = bracket(p.distortion, focal);
    if (!own) dist = [mix(d0.a, d1.a, dt) * d, mix(d0.b, d1.b, dt) * d, mix(d0.c, d1.c, dt) * d];
    if (p.tca && lens.ca) { const [t0, t1, tt] = bracket(p.tca, focal); tca = [mix(t0.kr, t1.kr, tt), mix(t0.kb, t1.kb, tt)]; }
    if (p.vignetting) {
      const [v0, v1, vt] = bracket(p.vignetting, focal);
      const a = vignettingAt(v0.byAperture, shot?.aperture), b = vignettingAt(v1.byAperture, shot?.aperture);
      vig = a.map((k, i) => mix(k, b[i], vt) * v);
    }
  }
  const out = { dist, tca, vig };
  if (own) out.camera = { poly: [own.k3, own.k2, own.k1], zoom: 1 + own.zoom, amount: d, centre: own.centre };
  return out;
}
