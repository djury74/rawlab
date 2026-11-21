import LibRaw from 'libraw-wasm-nothread';
import { asShotFromCamera } from './color.js';

const BITMAP_TYPES = /\.(jpe?g|png|webp|avif|gif|bmp)$/i;

// Decode a file into linear RGB plus the metadata the editor needs.
// RAW files go through LibRaw (WebAssembly, in a worker); the demosaiced
// output is requested as 16-bit linear sRGB with the camera's white balance.
export async function loadImage(file) {
  if (BITMAP_TYPES.test(file.name) || /^image\/(jpeg|png|webp|avif|gif|bmp)$/.test(file.type)) {
    return loadBitmap(file);
  }
  return loadRaw(file);
}

// The decoder's output always carries the BT.709 transfer curve (its option for
// linear output has no effect in this build), so undo it here and in the import shader.
const LINEAR = new Float32Array(65536);
for (let i = 0; i < 65536; i++) {
  const v = i / 65535;
  LINEAR[i] = v < 0.081 ? v / 4.5 : ((v + 0.099) / 1.099) ** (1 / 0.45);
}

async function loadRaw(file) {
  const buffer = await file.arrayBuffer();
  const raw = new LibRaw();
  try {
    // highlight: 2 keeps data above the point where the first channel clips and
    // blends the clipped channels towards neutral. In that mode the output is
    // scaled down by the ratio of the largest to smallest white balance multiplier.
    await raw.open(new Uint8Array(buffer), {
      outputBps: 16, noAutoBright: true, useCameraWb: true,
      outputColor: 1, highlight: 2, userQual: 3, useCameraMatrix: 1,
    });
    const img = await raw.imageData();
    const meta = await raw.metadata(true);
    if (!img?.data) throw new Error('The decoder returned no image data.');
    if (img.colors !== 3) throw new Error(`Unsupported sensor layout (${img.colors} colour channels).`);
    let data = img.data;
    if (!(data instanceof Uint16Array)) {
      data = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);
    }
    const { width, height } = img;
    const color = meta.color_data || meta.color || {};
    const mul = (color.pre_mul || []).slice(0, 3).filter((v) => v > 0);
    const scale = mul.length === 3 ? Math.max(...mul) / Math.min(...mul) : 1;
    const asShot = (color.cam_mul && color.cam_xyz && asShotFromCamera(color.cam_mul, color.cam_xyz)) || null;
    return {
      kind: 'raw', name: file.name, size: file.size, width, height, data, scale,
      asShot: asShot || { temp: 5500, tint: 0 }, asShotKnown: !!asShot,
      info: describe(meta),
      shot: shotInfo(meta),
      autoExposure: autoExposure(data, scale),
      sample(x, y, r = 2) {
        const acc = [0, 0, 0]; let n = 0;
        for (let j = Math.max(0, y - r); j <= Math.min(height - 1, y + r); j++) {
          for (let i = Math.max(0, x - r); i <= Math.min(width - 1, x + r); i++) {
            const o = (j * width + i) * 3;
            acc[0] += LINEAR[data[o]]; acc[1] += LINEAR[data[o + 1]]; acc[2] += LINEAR[data[o + 2]]; n++;
          }
        }
        return acc.map((v) => v * scale / n);
      },
    };
  } catch (err) {
    throw new Error(`Could not decode "${file.name}" as a RAW file. ${err?.message || err}`);
  } finally {
    raw.dispose();
  }
}

// Exposure (in stops) that brings the brightest 1% of the photo up to half of
// white, which the Standard tone curve then renders as a bright highlight. It only ever brightens: a photo that already uses the range gets 0.
function autoExposure(data, scale) {
  const hist = new Uint32Array(4096);
  let n = 0;
  for (let i = 0; i < data.length; i += 3 * 61) {
    const l = 0.2126 * LINEAR[data[i]] + 0.7152 * LINEAR[data[i + 1]] + 0.0722 * LINEAR[data[i + 2]];
    hist[Math.min(4095, Math.round(Math.sqrt(Math.min(1, l)) * 4095))]++; n++;
  }
  let acc = 0, bin = 4095;
  for (; bin > 0; bin--) { acc += hist[bin]; if (acc >= n * 0.01) break; }
  const p99 = (bin / 4095) ** 2 * scale;
  if (!(p99 > 0)) return 0;
  // Target chosen so the result sits where typical raw viewers put it; brighter
  // targets washed out indoor shots.
  const ev = Math.log2(0.5 / p99);
  return Math.round(Math.min(2.5, Math.max(0, ev)) * 20) / 20;
}

async function loadBitmap(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image', premultiplyAlpha: 'none' });
  const { width, height } = bitmap;
  const probe = new OffscreenCanvas(5, 5).getContext('2d', { willReadFrequently: true });
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return {
    kind: 'bitmap', name: file.name, size: file.size, width, height, bitmap,
    asShot: { temp: 5500, tint: 0 }, asShotKnown: false,
    info: { camera: 'Rendered image (not RAW)', lens: '', exposure: '' },
    shot: null,
    sample(x, y) {
      probe.clearRect(0, 0, 5, 5);
      probe.drawImage(bitmap, x - 2, y - 2, 5, 5, 0, 0, 5, 5);
      const d = probe.getImageData(0, 0, 5, 5).data;
      const acc = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) { acc[0] += lin(d[i]); acc[1] += lin(d[i + 1]); acc[2] += lin(d[i + 2]); }
      return acc.map((v) => v / 25);
    },
  };
}

// Numbers the lens profiles need to recognise the lens and pick calibration data.
function shotInfo(meta) {
  const lens = meta.lens || {}, mk = lens.makernotes || {};
  const first = (...v) => v.find((n) => n > 0) || 0;
  return {
    make: meta.camera_make || '', model: meta.camera_model || '',
    lensName: (lens.Lens || mk.Lens || '').trim(),
    aperture: meta.aperture || 0, focal: meta.focal_len || 0,
    minFocal: first(lens.MinFocal, mk.MinFocal), maxFocal: first(lens.MaxFocal, mk.MaxFocal),
    maxAperture: first(lens.MaxAp4MinFocal, mk.MaxAp, lens.EXIF_MaxAp),
  };
}

function describe(meta) {
  const shutter = meta.shutter > 0
    ? (meta.shutter >= 0.4 ? `${+meta.shutter.toFixed(1)} s` : `1/${Math.round(1 / meta.shutter)} s`) : '';
  const parts = [
    shutter,
    meta.aperture > 0 ? `f/${+meta.aperture.toFixed(1)}` : '',
    meta.iso_speed > 0 ? `ISO ${Math.round(meta.iso_speed)}` : '',
    meta.focal_len > 0 ? `${Math.round(meta.focal_len)} mm` : '',
  ].filter(Boolean);
  const lens = (meta.lens?.Lens || meta.lens?.makernotes?.Lens || '').trim();
  const date = meta.timestamp instanceof Date && meta.timestamp.getTime() > 0
    ? meta.timestamp.toISOString().slice(0, 16).replace('T', ' ') : '';
  return {
    camera: [meta.camera_make, meta.camera_model].filter(Boolean).join(' ').trim(),
    lens, exposure: parts.join('  ·  '), date,
  };
}
