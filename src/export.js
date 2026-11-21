// File-format helpers for export: EXIF for JPEG, and a 16-bit TIFF writer.

const TYPE_SIZE = { 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 }; // ASCII, SHORT, LONG, RATIONAL, UNDEFINED

// Serialise one TIFF directory. Values that do not fit in four bytes are placed
// straight after the directory; `base` is where the directory sits in the file.
function buildIFD(entries, base) {
  entries = [...entries].sort((a, b) => a.tag - b.tag);
  const dirSize = 2 + entries.length * 12 + 4;
  const payloads = entries.map((e) => {
    let bytes;
    if (e.type === 2) bytes = new TextEncoder().encode(e.value + '\0');
    else if (e.type === 7) bytes = Uint8Array.from(e.value);
    else {
      const vals = [].concat(e.value);
      bytes = new Uint8Array(vals.length * (e.type === 5 ? 4 : TYPE_SIZE[e.type]));
      const dv = new DataView(bytes.buffer);
      vals.forEach((v, i) => (e.type === 3 ? dv.setUint16(i * 2, v, true) : dv.setUint32(i * 4, v, true)));
    }
    return { e, bytes, count: e.type === 5 ? bytes.length / 8 : bytes.length / TYPE_SIZE[e.type] };
  });
  const extra = payloads.reduce((n, p) => n + (p.bytes.length > 4 ? p.bytes.length + (p.bytes.length & 1) : 0), 0);
  const out = new Uint8Array(dirSize + extra), dv = new DataView(out.buffer);
  dv.setUint16(0, entries.length, true);
  let dataAt = dirSize;
  payloads.forEach((p, i) => {
    const o = 2 + i * 12;
    dv.setUint16(o, p.e.tag, true); dv.setUint16(o + 2, p.e.type, true); dv.setUint32(o + 4, p.count, true);
    if (p.bytes.length <= 4) out.set(p.bytes, o + 8);
    else { dv.setUint32(o + 8, base + dataAt, true); out.set(p.bytes, dataAt); dataAt += p.bytes.length + (p.bytes.length & 1); }
  });
  return out;
}

const rational = (v, den) => [Math.round(v * den), den];

// EXIF block describing how the photo was taken, as a JPEG APP1 segment.
function exifSegment(shot, width, height) {
  const pad = (n) => String(n).padStart(2, '0');
  const d = shot.date instanceof Date && shot.date.getTime() > 0 ? shot.date : null;
  const stamp = d && `${d.getUTCFullYear()}:${pad(d.getUTCMonth() + 1)}:${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  const exif = [
    { tag: 0x9000, type: 7, value: [48, 50, 51, 50] },          // ExifVersion 0232
    { tag: 0xA001, type: 3, value: 1 },                          // ColorSpace: sRGB
    { tag: 0xA002, type: 4, value: width }, { tag: 0xA003, type: 4, value: height },
  ];
  if (shot.shutter > 0) exif.push({ tag: 0x829A, type: 5, value: shot.shutter < 0.3 ? [1, Math.round(1 / shot.shutter)] : rational(shot.shutter, 10) });
  if (shot.aperture > 0) exif.push({ tag: 0x829D, type: 5, value: rational(shot.aperture, 10) });
  if (shot.iso > 0) exif.push({ tag: 0x8827, type: 3, value: Math.min(65535, Math.round(shot.iso)) });
  if (shot.focal > 0) exif.push({ tag: 0x920A, type: 5, value: rational(shot.focal, 10) });
  if (stamp) exif.push({ tag: 0x9003, type: 2, value: stamp });
  if (shot.lensName) exif.push({ tag: 0xA434, type: 2, value: shot.lensName });
  const ifd0 = (exifOffset) => {
    const e = [{ tag: 0x0131, type: 2, value: 'RawLab' }, { tag: 0x8769, type: 4, value: exifOffset }];
    if (shot.make) e.push({ tag: 0x010F, type: 2, value: shot.make });
    if (shot.model) e.push({ tag: 0x0110, type: 2, value: shot.model });
    if (stamp) e.push({ tag: 0x0132, type: 2, value: stamp });
    return buildIFD(e, 8);
  };
  const exifAt = 8 + ifd0(0).length;
  const a = ifd0(exifAt), b = buildIFD(exif, exifAt);
  const tiff = new Uint8Array(8 + a.length + b.length);
  tiff.set([0x49, 0x49, 42, 0, 8, 0, 0, 0]); tiff.set(a, 8); tiff.set(b, exifAt);
  const seg = new Uint8Array(4 + 6 + tiff.length);
  seg.set([0xFF, 0xE1, (tiff.length + 8) >> 8, (tiff.length + 8) & 255, 0x45, 0x78, 0x69, 0x66, 0, 0]);
  seg.set(tiff, 10);
  return seg;
}

// Return a copy of a JPEG with the photo's camera details embedded.
export async function withExif(jpegBlob, shot, width, height) {
  const head = new Uint8Array(await jpegBlob.slice(0, 2).arrayBuffer());
  if (!shot || head[0] !== 0xFF || head[1] !== 0xD8) return jpegBlob;
  return new Blob([head, exifSegment(shot, width, height), jpegBlob.slice(2)], { type: 'image/jpeg' });
}

// Uncompressed 16-bit RGB TIFF. `rgb` is a Uint16Array of width * height * 3.
export function tiff16(rgb, width, height) {
  const header = new Uint8Array(8);
  header.set([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
  const entries = (dataAt) => [
    { tag: 256, type: 4, value: width }, { tag: 257, type: 4, value: height },
    { tag: 258, type: 3, value: [16, 16, 16] }, { tag: 259, type: 3, value: 1 }, { tag: 262, type: 3, value: 2 },
    { tag: 273, type: 4, value: dataAt }, { tag: 277, type: 3, value: 3 }, { tag: 278, type: 4, value: height },
    { tag: 279, type: 4, value: rgb.byteLength }, { tag: 284, type: 3, value: 1 }, { tag: 305, type: 2, value: 'RawLab' },
  ];
  const size = buildIFD(entries(0), 8).length;
  const ifd = buildIFD(entries(8 + size), 8);
  return new Blob([header, ifd, rgb], { type: 'image/tiff' });
}

export const tiff16Size = (width, height) => width * height * 6 + 200;
