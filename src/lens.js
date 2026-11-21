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

export const LENS_PROFILES = [
  {
    id: 'nikon-afs-dx-35-1.8g',
    name: 'Nikon AF-S DX Nikkor 35mm f/1.8G',
    cropFactor: 1.528,                      // measured on an APS-C (DX) body
    distortion: { a: 0.003, b: -0.017, c: 0.005 },
    tca: { kr: 1.0003, kb: 1.0003 },
    vignetting: [                           // by aperture
      { f: 1.8, k: [-0.3298, -0.0595, 0.0938] },
      { f: 2.8, k: [-0.1367, 0.0656, -0.0502] },
      { f: 4, k: [-0.1170, 0.0027, 0.0072] },
      { f: 5, k: [-0.1203, 0.0086, 0.0030] },
      { f: 22, k: [-0.1143, -0.0162, 0.0186] },
    ],
    // Does this profile fit the shot? `shot` is the metadata gathered at decode time.
    matches(shot) {
      if (!/nikon/i.test(shot.make || '')) return false;
      const name = shot.lensName || '';
      if (/35(\.0)?\s*mm/i.test(name) && /1[.:]8\s*G/i.test(name)) return !/\bED\b/.test(name);
      // Many Nikon bodies record only numbers: a 35mm prime with f/1.8 maximum aperture.
      const near = (a, b, tol) => a > 0 && Math.abs(a - b) <= tol;
      return near(shot.minFocal, 35, 0.6) && near(shot.maxFocal, 35, 0.6) && near(shot.maxAperture, 1.8, 0.11);
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
export function lensParams(lens, shot) {
  const p = activeProfile(lens, shot);
  if (!p) return null;
  const d = lens.distortion / 100, v = lens.vignetting / 100;
  return {
    dist: [p.distortion.a * d, p.distortion.b * d, p.distortion.c * d],
    tca: lens.ca ? [p.tca.kr, p.tca.kb] : [1, 1],
    vig: vignettingAt(p.vignetting, shot?.aperture).map((k) => k * v),
  };
}
