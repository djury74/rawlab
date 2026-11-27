// Cameras newer than the RAW decoder built into the app.
//
// The decoder (LibRaw) carries a colour calibration for each camera it knows.
// For a model released after that build it still reads the sensor data, but
// returns it uncorrected, which looks dull and slightly off. This table
// supplies the missing calibration so the app can apply it itself.
//
// Each matrix converts CIE XYZ to the camera's colour response, in LibRaw's
// own format (the values in LibRaw's later source, divided by 10000). When the
// decoder is updated to a build that knows a camera, its entry here goes unused.
import { inv3 } from './color.js';

const EXTRA_CAMERAS = [
  // Same sensor and calibration as the original Z 50.
  { make: /nikon/i, model: /^Z ?50_2$/i, xyzToCam: [[1.1640, -0.4829, -0.1079], [-0.5107, 1.3006, 0.2325], [-0.0972, 0.1711, 0.7380]] },
];

// Friendlier names for models the camera writes in shorthand.
const DISPLAY_NAMES = [
  [/^Z ?(\d+)_2$/i, 'Z$1II'], [/^Z ?(\d+)_3$/i, 'Z$1III'],
];
export function displayModel(model = '') {
  for (const [re, to] of DISPLAY_NAMES) if (re.test(model)) return model.replace(re, to);
  return model;
}

const SRGB_TO_XYZ = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.0721750],
  [0.0193339, 0.1191920, 0.9503041],
];

// The calibration for a camera the decoder returned without one, or null.
// `toRgb` converts white-balanced camera colour to linear sRGB (the same
// construction the decoder uses: scale so that white stays white, then invert).
export function extraCamera(make, model) {
  const cam = EXTRA_CAMERAS.find((c) => c.make.test(make || '') && c.model.test(model || ''));
  if (!cam) return null;
  const camFromRgb = cam.xyzToCam.map((row) => [0, 1, 2].map((j) => row[0] * SRGB_TO_XYZ[0][j] + row[1] * SRGB_TO_XYZ[1][j] + row[2] * SRGB_TO_XYZ[2][j]));
  const normalised = camFromRgb.map((row) => { const sum = row[0] + row[1] + row[2]; return row.map((v) => v / sum); });
  return { xyzToCam: cam.xyzToCam, toRgb: inv3(normalised) };
}
