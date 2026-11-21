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

async function loadRaw(file) {
  const buffer = await file.arrayBuffer();
  const raw = new LibRaw();
  try {
    await raw.open(new Uint8Array(buffer), {
      outputBps: 16, gamm: [1, 1], noAutoBright: true, useCameraWb: true,
      outputColor: 1, highlight: 0, userQual: 3, useCameraMatrix: 1,
    });
    const meta = await raw.metadata(true);
    const img = await raw.imageData();
    if (!img?.data) throw new Error('The decoder returned no image data.');
    if (img.colors !== 3) throw new Error(`Unsupported sensor layout (${img.colors} colour channels).`);
    let data = img.data;
    if (!(data instanceof Uint16Array)) {
      data = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);
    }
    const { width, height } = img;
    const color = meta.color_data || meta.color || {};
    const asShot = (color.cam_mul && color.cam_xyz && asShotFromCamera(color.cam_mul, color.cam_xyz)) || null;
    return {
      kind: 'raw', name: file.name, size: file.size, width, height, data,
      asShot: asShot || { temp: 5500, tint: 0 }, asShotKnown: !!asShot,
      info: describe(meta),
      sample(x, y, r = 2) {
        const acc = [0, 0, 0]; let n = 0;
        for (let j = Math.max(0, y - r); j <= Math.min(height - 1, y + r); j++) {
          for (let i = Math.max(0, x - r); i <= Math.min(width - 1, x + r); i++) {
            const o = (j * width + i) * 3;
            acc[0] += data[o]; acc[1] += data[o + 1]; acc[2] += data[o + 2]; n++;
          }
        }
        return acc.map((v) => v / n / 65535);
      },
    };
  } catch (err) {
    throw new Error(`Could not decode "${file.name}" as a RAW file. ${err?.message || err}`);
  } finally {
    raw.dispose();
  }
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
