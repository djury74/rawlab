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

// The JPEG preview a camera embeds in its RAW files, for showing something at
// once while the photo is developed. Returns { bitmap, flip } or null.
// The orientation mark (EXIF tag 0x0112) inside a JPEG, or 1 if it has none.
// 1 means "as stored"; anything else means the browser turns the picture itself.
export function jpegOrientation(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (dv.getUint16(0) !== 0xFFD8) return 1;
    for (let at = 2; at + 4 < dv.byteLength;) {
      const marker = dv.getUint16(at), size = dv.getUint16(at + 2);
      if ((marker & 0xFF00) !== 0xFF00 || marker === 0xFFDA) break;
      if (marker === 0xFFE1 && dv.getUint32(at + 4) === 0x45786966) {          // "Exif"
        const t = at + 10, little = dv.getUint16(t) === 0x4949;
        const ifd = t + dv.getUint32(t + 4, little), count = dv.getUint16(ifd, little);
        for (let i = 0; i < count; i++) {
          const e = ifd + 2 + i * 12;
          if (dv.getUint16(e, little) === 0x0112) return dv.getUint16(e + 8, little) || 1;
        }
        return 1;
      }
      at += 2 + size;
    }
  } catch { /* truncated or unusual file: treat as unmarked */ }
  return 1;
}

// Read the JPEG preview embedded in a RAW file using the given decoder.
// Returns { bitmap, flip } where `flip` is the rotation still to apply
// (LibRaw's codes: 3 = 180 degrees, 5 = 90 anticlockwise, 6 = 90 clockwise).
export async function embeddedPreview(decoder, file, maxEdge) {
  await decoder.open(new Uint8Array(await file.arrayBuffer()), {});
  const meta = await decoder.metadata(false);
  const thumb = await decoder.thumbnailData();
  if (!thumb?.data || thumb.format !== 'jpeg') return null;
  const blob = new Blob([thumb.data], { type: 'image/jpeg' });
  const bitmap = await createImageBitmap(blob, thumb.width > maxEdge ? { resizeWidth: maxEdge } : undefined);
  // Some cameras (Nikon among them) mark the preview itself as rotated, and the
  // browser then turns it when decoding. Rotating again here would leave it
  // sideways, so only apply the RAW file's rotation when the preview is unmarked.
  const flip = jpegOrientation(thumb.data) === 1 ? meta?.flip || 0 : 0;
  return { bitmap, flip };
}

// The preview for the photo being opened, shown at once while it is developed.
let previewDecoder = null;
export async function rawPreview(file, maxEdge = 2400) {
  if (BITMAP_TYPES.test(file.name)) return null;
  try {
    previewDecoder ||= new LibRaw();
    return await embeddedPreview(previewDecoder, file, maxEdge);
  } catch {
    return null;
  }
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
  return statsFromHistogram(hist, n, scale, 0.5, 0.10);
}

// `hist` counts pixels by sqrt(luminance) in 4096 bins.
// Automatic exposure starts from the highlights: lift the 99th percentile to
// `target`. That alone fails when a lamp or window is in the frame, because the
// brightest part is already at white while the scene is dim. So if the middle
// of the photo (the median) would still sit below `midTarget`, lift further,
// by at most one stop, and let the bright part roll off.
function statsFromHistogram(hist, n, scale, target, midTarget = 0) {
  const above = (fraction) => {            // luminance that `fraction` of the photo is brighter than
    let acc = 0, bin = 4095;
    for (; bin > 0; bin--) { acc += hist[bin]; if (acc >= n * fraction) break; }
    return (bin / 4095) ** 2 * scale;
  };
  const p99 = above(0.01);
  const p50 = above(0.5);
  let stops = p99 > 0 ? Math.max(0, Math.log2(target / p99)) : 0;
  if (midTarget && p50 > 0) stops = Math.max(stops, Math.min(Math.log2(midTarget / p50), stops + 1));
  const ev = Math.round(Math.min(2.5, Math.max(0, stops)) * 20) / 20;
  return { low: above(0.995), p50, p75: above(0.25), p90: above(0.1), p99, high: above(0.001), exposure: ev };
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
  // A small linear copy for the automatic controls. A finished image has no
  // tone curve still to come, so automatic exposure aims higher than for RAW.
  const sc = new OffscreenCanvas(256, Math.max(1, Math.round(256 * height / width))), sctx = sc.getContext('2d');
  sctx.drawImage(bitmap, 0, 0, sc.width, sc.height);
  const px = sctx.getImageData(0, 0, sc.width, sc.height).data, small = new Float32Array(px.length / 4 * 3);
  const hist = new Uint32Array(4096);
  for (let i = 0, o = 0; i < px.length; i += 4, o += 3) {
    small[o] = lin(px[i]); small[o + 1] = lin(px[i + 1]); small[o + 2] = lin(px[i + 2]);
    hist[Math.round(Math.sqrt(0.2126 * small[o] + 0.7152 * small[o + 1] + 0.0722 * small[o + 2]) * 4095)]++;
  }
  const tone = statsFromHistogram(hist, px.length / 4, 1, 0.8);
  return {
    kind: 'bitmap', name: file.name, size: file.size, width, height, bitmap,
    asShot: { temp: 5500, tint: 0 }, asShotKnown: false,
    info: { camera: 'Rendered image (not RAW)', lens: '', exposure: '' },
    shot: null,
    tone,
    neutral: () => estimateNeutral(small),
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
