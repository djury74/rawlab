# Duncan's Photo Lab: notes for future sessions

A browser-based, non-destructive RAW photo developer in the style of Lightroom.
Vanilla JavaScript with Vite; no framework. README.md describes the features
and file layout. This file records what is not obvious from the code.

## Owner and how to work with them

- The owner is a photographer, not a programmer. Explain changes in plain
  language, say what was tested and what was not, and use UK English.
- Cameras: a Nikon Z50II with the Z DX 16-50mm f/3.5-6.3 VR, Z DX 24mm f/1.7 and
  Z DX MC 35mm f/1.7 (from late November 2026), and before that a Nikon D5100 with
  the AF-S DX Nikkor 35mm f/1.8G. Uses Chrome on Windows.
- They test on the live site and report back with screenshots. Comparing a
  screenshot of the app with one of another viewer, region by region, has been
  the most reliable way to tune rendering.
- Commit and push each finished piece of work to `main`. Pushing publishes it.

## Deployment

- `.github/workflows/pages.yml` builds and publishes to GitHub Pages on every
  push to `main`: https://djury74.github.io/rawlab/
- The repository and URL keep the old name `rawlab`. Storage keys in the
  browser also start with `rawlab:`. Do not rename them: that would orphan the
  owner's saved edits, ratings and presets.
- Installable as an app (`public/manifest.webmanifest`). Deliberately no
  service worker: the owner chose online-only so updates are immediate.

## Things that were learnt the hard way

- **The decoder ignores its linear-output option.** `libraw-wasm-nothread`
  always returns BT.709-encoded data whatever `gamm` is set to. The curve is
  undone in `FRAG_IMPORT_U16` (shader) and via the `LINEAR` table in
  `src/decode.js`. This was verified against raw sensor values. Any new code
  that reads `source.data` on the CPU must go through `LINEAR` and `scale`.
- **Highlight headroom.** RAW files are decoded with `highlight: 2`, which
  scales output down by max/min of the white balance multipliers. `source.scale`
  restores it, so 1.0 is nominal white and values above it are real detail.
- **Default brightness.** The owner's reference viewer auto-brightens. The app
  sets exposure automatically on first open (`toneStats` in `src/decode.js`,
  target tuned against a D5100 photo). The Standard base curve in
  `src/color.js` is a generic camera-like curve; do not refit it to one photo.
- **Automatic exposure has two parts** (`statsFromHistogram` in `src/decode.js`):
  lift the 99th percentile to half of white, then, if the median is still
  below 0.10, lift up to one stop further. The second part exists because a
  lamp or window in the frame makes the first part do nothing. The first part
  was matched to the owner's viewer on a D5100 photo; keep that photo's result
  (+1.95) unchanged when retuning.
- **Auto tone is deliberately bolder than Auto.** At the owner's request, after
  comparing with LightCraft, it also sets Contrast +18 and Vibrance +15 (less
  on JPEGs) and moves Highlights and Shadows on high-contrast scenes. Auto
  itself only sets exposure and stays natural.
- **Embedded previews may carry their own rotation mark.** Nikon marks the
  JPEG preview inside a portrait NEF as rotated, and the browser turns it when
  decoding. `embeddedPreview` reads the mark and applies LibRaw's `flip` only
  when the preview is unmarked; rotating in both places left thumbnails
  sideways. The `imageOrientation: 'none'` option does not switch this off.
- **Cameras newer than the decoder.** The bundled LibRaw (0.22.1) reads Z50II
  files but has no colour calibration for the model, so it returns camera
  colour uncorrected (all-zero `cam_xyz`). `src/cameras.js` supplies the
  matrix and the import shader applies it (`uCam`); CPU readers go through the
  same conversion. Add new bodies there until the decoder is updated.
- **Nikon Z lenses are corrected from data in the file.** `src/nikon.js` reads
  the distortion correction Nikon stores in each mirrorless NEF (tag 0xc7d5)
  and the resampling shader applies it (lens model 1). It was checked on
  Z50II files in three image shapes against the camera's own JPEG (median
  error 0.1 to 0.4 px at full size, against about 29 px uncorrected); the
  scripts for that measurement are described in the file's header. A lensfun
  profile still supplies vignetting and colour fringing where it has them.
  Nikon's vignetting and colour fringing entries (6 and 7) are not decoded.
  The Z DX MC 35mm f/1.7 has no lensfun entry, so it gets distortion only.
- **Nikon High Efficiency NEFs cannot be decoded** (`nikon.NEFCompression` 13
  or 14): LibRaw returns noise without an error. `loadRaw` detects this and
  opens the embedded full-size JPEG instead, with a notice.
- **Sample files for Nikon Z bodies** are on raw.pixls.us (allowed in the
  `rawlab` environment; CC0). The Z50II set includes lossless, HE and HE*.
- **Shadows and Highlights are edge-aware.** They use a guided filter built at
  low resolution in `#updateBlur` (`src/gl/renderer.js`) and evaluated per
  pixel in the develop shader. A plain blur left halos at hard edges. To check
  for halos, render a hard bright/dark edge with Highlights -100 and Shadows
  +100 and look at the brightness profile across it.
- **Opening a photo is not an edit.** Settings are saved only once something
  has been changed (`persist` in `src/main.js`), with a separate "touched"
  mark. Early versions saved on open, which froze each photo's opening
  brightness and marked every opened photo as edited; `savedEdits` ignores
  those leftover records.
- **Settings version.** `version: 2` in `src/settings.js` marks edits made on
  true linear data. Older saved edits are discarded on open. Bump it only if
  rendering changes enough to invalidate existing edits.
- **GLSL reserved words.** `patch` (and others such as `sample`, `filter`,
  `input`, `output`) cannot be used as identifiers in shaders.
- **Per-image versus look.** `GEOMETRY_KEYS` in `src/settings.js` lists what
  presets, copy/paste and "Previous" must not carry between photos.
- **Coordinate spaces** are documented at the top of `src/geometry.js`. Masks
  and heal spots are stored in source-image uv so they follow crop and rotation.
- Lens data is from lensfun (CC BY-SA 3.0); keep the attribution in
  `src/lens.js` and the README.

## Testing

- There is no test suite. Changes have been verified by driving the dev server
  (`npm run dev`) with Playwright in headless Chromium, using
  `--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`
  so WebGL2 works without a GPU.
- `window.rawlab` exposes `state`, `renderer`, `renderFull` and `browser` for tests.
- System dialogs (file save, folder picker) cannot be shown headlessly; stub
  `showSaveFilePicker` / `showDirectoryPicker`. The browser's private file
  system (`navigator.storage.getDirectory()`) gives real directory handles.
- Sample RAW files that download through the proxy:
  `https://raw.githubusercontent.com/letmaik/rawpy/main/test/iss030e122639.NEF`
  (Nikon D3S) and
  `https://raw.githubusercontent.com/ybouane/LibRaw-Wasm/main/example-sony.ARW`.
  No D5100 sample is available; the owner's own files are the real test.
- Export is rendered in tiles. After changing the pipeline, compare a tiled
  export against a direct render across a tile boundary.

## User guide

`public/Duncans-Photo-Lab-Guide.pdf` is a guide for new users, published with
the site. Its source is `docs/guide/guide.html` with screenshots alongside;
regenerate the PDF with `node docs/guide/make-pdf.cjs` (uses Playwright).
Retake the screenshots with `node docs/guide/take-screenshots.cjs` against a
running dev server (its header comment lists the arguments), convert the PNGs
to JPEG, then check every page of the PDF: each section is meant to fit one page.
The screenshots still use third-party sample photos, not the owner's own.
Update the guide and retake screenshots when features or the layout change.

## Not yet verified on the owner's machine

Installing as an app and opening NEF files from File Explorer, the folder
picker with the real card reader (works, per the owner's screenshots), thumbnail
speed from the card, the portrait thumbnail fix, and spot removal on real sensor dust.

## Ideas discussed but not built

Perspective correction, blur as a local adjustment, snapshots, a colour
readout under the cursor. Declined as too large for now: AI subject and sky
masks, and Photoshop-style effect filters.
