import LibRaw from 'libraw-wasm-nothread';
import { asShotFromCamera, estimateNeutral } from './color.js';

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
    let data = img.data, width, height;
    if (!(data instanceof Uint16Array)) {
      data = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);
    }
    ({ data, width, height } = trimToCameraSize(data, img.width, img.height, meta));
    const color = meta.color_data || meta.color || {};
    const mul = (color.pre_mul || []).slice(0, 3).filter((v) => v > 0);
    const scale = mul.length === 3 ? Math.max(...mul) / Math.min(...mul) : 1;
    const asShot = (color.cam_mul && color.cam_xyz && asShotFromCamera(color.cam_mul, color.cam_xyz)) || null;
    return {
      kind: 'raw', name: file.name, size: file.size, width, height, data, scale,
      asShot: asShot || { temp: 5500, tint: 0 }, asShotKnown: !!asShot,
      info: describe(meta),
      shot: shotInfo(meta),
      tone: toneStats(data, scale),
      neutral: () => estimateNeutral(sampleRaw(data, scale)),
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

// The decoder returns every usable sensor pixel, a few more than the camera
// keeps. Trim to the size the camera itself produces, so dimensions match its
// JPEGs and other software.
function trimToCameraSize(data, width, height, meta) {
  let c = meta.raw_inset_crops?.[0];
  const keep = { data, width, height };
  if (!c || !(c.cwidth > 0) || !(c.cheight > 0) || c.cwidth >= 65535) {
    // No crop recorded (common for Nikon): the full-size JPEG preview the camera
    // embeds in the file has the size the camera considers final.
    const tw = meta.thumb_width, th = meta.thumb_height;
    const long = Math.max(tw, th), short = Math.min(tw, th);
    const near = (a, b) => a <= b && a >= b * 0.98;
    if (!(near(long, Math.max(width, height)) && near(short, Math.min(width, height)))) return keep;
    c = { cwidth: tw, cheight: th, cleft: -1, ctop: -1 };
  }
  let cw = c.cwidth, ch = c.cheight;
  if ((width < height) !== (cw < ch)) [cw, ch] = [ch, cw];     // photo was rotated by the decoder
  if (cw > width || ch > height || (cw === width && ch === height)) return keep;
  let left = Math.floor((width - cw) / 2), top = Math.floor((height - ch) / 2);
  if (!meta.flip && c.cleft >= 0) {
    // Use the camera's exact offsets when they are plausible; otherwise stay centred.
    const l = c.cleft - (meta.left_margin || 0), t = c.ctop - (meta.top_margin || 0);
    if (l >= 0 && l <= width - cw && Math.abs(l - left) <= 16) left = l;
    if (t >= 0 && t <= height - ch && Math.abs(t - top) <= 16) top = t;
  }
  const out = new Uint16Array(cw * ch * 3);
  for (let y = 0; y < ch; y++) {
    const from = ((top + y) * width + left) * 3;
    out.set(data.subarray(from, from + cw * 3), y * cw * 3);
  }
  return { data: out, width: cw, height: ch };
}

// Brightness statistics for the automatic tone controls: luminance at the
// 0.5th, 99th and 99.9th percentiles (linear, 1.0 = nominal white), and the
// exposure in stops that brings the 99th percentile to half of white. The
// Standard tone curve renders that as a bright highlight; brighter targets
// washed out indoor shots. Exposure only ever brightens.
function toneStats(data, scale) {
  const hist = new Uint32Array(4096);
  let n = 0;
  for (let i = 0; i < data.length; i += 3 * 61) {
    const l = 0.2126 * LINEAR[data[i]] + 0.7152 * LINEAR[data[i + 1]] + 0.0722 * LINEAR[data[i + 2]];
    hist[Math.min(4095, Math.round(Math.sqrt(Math.min(1, l)) * 4095))]++; n++;
  }
  const above = (fraction) => {            // luminance that `fraction` of the photo is brighter than
    let acc = 0, bin = 4095;
    for (; bin > 0; bin--) { acc += hist[bin]; if (acc >= n * fraction) break; }
    return (bin / 4095) ** 2 * scale;
  };
  const p99 = above(0.01);
  const ev = p99 > 0 ? Math.round(Math.min(2.5, Math.max(0, Math.log2(0.5 / p99))) * 20) / 20 : 0;
  return { low: above(0.995), p99, high: above(0.001), exposure: ev };
}

// A few hundred thousand linear RGB samples for estimating white balance.
function sampleRaw(data, scale) {
  const step = Math.max(1, Math.floor(data.length / 3 / 200000)) * 3;
  const out = new Float32Array(Math.ceil(data.length / step) * 3);
  let o = 0;
  for (let i = 0; i + 2 < data.length; i += step) { out[o++] = LINEAR[data[i]] * scale; out[o++] = LINEAR[data[i + 1]] * scale; out[o++] = LINEAR[data[i + 2]] * scale; }
  return out.subarray(0, o);
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
    tone: null,
    neutral() {
      const c = new OffscreenCanvas(256, Math.max(1, Math.round(256 * height / width))), ctx = c.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, c.width, c.height);
      const d = ctx.getImageData(0, 0, c.width, c.height).data, out = new Float32Array(d.length / 4 * 3);
      for (let i = 0, o = 0; i < d.length; i += 4) { out[o++] = lin(d[i]); out[o++] = lin(d[i + 1]); out[o++] = lin(d[i + 2]); }
      return estimateNeutral(out);
    },
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
    shutter: meta.shutter || 0, iso: meta.iso_speed || 0, date: meta.timestamp instanceof Date ? meta.timestamp : null,
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
