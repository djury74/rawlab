// Nikon's own lens distortion correction, stored in each NEF from its
// mirrorless (Z) cameras. Lightroom, Capture One and Nikon's software all use
// this data; reading it means every Z lens is corrected the way the camera
// corrects its own JPEGs, with no separate lens profile.
//
// The data sits in the RAW image's sub-directory under tag 0xc7d5
// ("NikonNEFInfo"): the text "Nikon\0", four version bytes, then a small TIFF
// structure. Its entry 5 holds the distortion correction:
//   bytes 0-3   "0100"
//   byte  4     mode: 1 = on (optional), 3 = on (required), 0 = none
//   bytes 16-19 number of terms (4)
//   bytes 20, 28, 36   three coefficients k1, k2, k3 (signed fractions)
//   bytes 64-71 the zoom q the camera applies so the result fills the frame
// and entry 8 holds the optical centre's offset from the image centre in pixels.
//
// From a corrected position at distance r from the optical centre, the photo is
// read at   r * (1 + k3*p^2 + k2*p^4 + k1*p^6) / (1 + q),   p = r / (half diagonal).
// The coefficients are scaled to the recorded image area, so its corners map
// to themselves: 1 + k1 + k2 + k3 equals 1 + q. That identity is used below as a
// check that a file follows this layout.
//
// The layout was documented by the LightCraft project (docs/nikon-lens-corrections.md)
// for full-frame bodies, with tag names from ExifTool. It was verified here on
// Z50II files by measuring the result against the camera's own corrected JPEG.

const SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];

function directory(view, base, little, offset) {
  const count = view.getUint16(base + offset, little), entries = [];
  for (let i = 0; i < count; i++) {
    const e = base + offset + 2 + i * 12;
    const tag = view.getUint16(e, little), type = view.getUint16(e + 2, little), n = view.getUint32(e + 4, little);
    const bytes = (SIZE[type] || 1) * n;
    entries.push({ tag, count: n, bytes, at: bytes <= 4 ? e + 8 - base : view.getUint32(e + 8, little) });
  }
  return entries;
}

// Find and decode the distortion correction in a NEF. Returns
// { k1, k2, k3, zoom, centre: [x, y] } or null if the file has none this app trusts.
export function nikonDistortion(buffer) {
  try {
    const view = new DataView(buffer);
    const mark = view.getUint16(0);
    if (mark !== 0x4949 && mark !== 0x4d4d) return null;
    const little = mark === 0x4949;
    let info = null;
    // The RAW image is one of the sub-directories listed by tag 0x014a in the first directory.
    for (const e of directory(view, 0, little, view.getUint32(4, little))) {
      if (e.tag !== 0x014a) continue;
      for (let i = 0; i < e.count && !info; i++) {
        const sub = e.bytes <= 4 ? view.getUint32(e.at, little) : view.getUint32(e.at + i * 4, little);
        info = directory(view, 0, little, sub).find((x) => x.tag === 0xc7d5) || null;
      }
    }
    if (!info || info.bytes < 40) return null;
    const text = (at, n) => String.fromCharCode(...new Uint8Array(buffer, at, n));
    if (text(info.at, 6) !== 'Nikon\0') return null;
    const base = info.at + 10, tm = view.getUint16(base);
    if (tm !== 0x4949 && tm !== 0x4d4d) return null;
    const tl = tm === 0x4949;
    const entries = directory(view, base, tl, view.getUint32(base + 4, tl));
    const entry = (tag) => { const e = entries.find((x) => x.tag === tag); return e ? { at: base + e.at, bytes: e.bytes } : null; };
    const fraction = (at) => view.getInt32(at, tl) / view.getInt32(at + 4, tl);

    const d = entry(5);
    if (!d || d.bytes < 72 || text(d.at, 4) !== '0100') return null;
    const mode = view.getUint8(d.at + 4);
    if ((mode !== 1 && mode !== 3) || view.getUint32(d.at + 16, tl) !== 4) return null;
    const k1 = fraction(d.at + 20), k2 = fraction(d.at + 28), k3 = fraction(d.at + 36), zoom = fraction(d.at + 64);
    const ok = [k1, k2, k3, zoom].every(Number.isFinite) && Math.abs(k1) < 1 && Math.abs(k2) < 1 && Math.abs(k3) < 1 && Math.abs(zoom) < 0.5;
    // The corners must map to themselves; if not, this file uses a layout this code does not know.
    if (!ok || Math.abs(k1 + k2 + k3 - zoom) > 0.003) return null;

    let centre = [0, 0];
    const c = entry(8);
    if (c && c.bytes >= 20 && text(c.at, 4) === '0100') {
      const x = fraction(c.at + 4), y = fraction(c.at + 12);
      if (Number.isFinite(x) && Number.isFinite(y)) centre = [x, y];
    }
    return { k1, k2, k3, zoom, centre };
  } catch {
    return null;                // truncated or unusual file
  }
}
