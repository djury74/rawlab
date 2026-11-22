# Duncan's Photo Lab: notes for future sessions

A browser-based, non-destructive RAW photo developer in the style of Lightroom.
Vanilla JavaScript with Vite; no framework. README.md describes the features
and file layout. This file records what is not obvious from the code.

## Owner and how to work with them

- The owner is a photographer, not a programmer. Explain changes in plain
  language, say what was tested and what was not, and use UK English.
- Camera: Nikon D5100 with the AF-S DX Nikkor 35mm f/1.8G. Uses Chrome on Windows.
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
- **Shadows and Highlights are edge-aware.** They use a guided filter built at
  low resolution in `#updateBlur` (`src/gl/renderer.js`) and evaluated per
  pixel in the develop shader. A plain blur left halos at hard edges. To check
  for halos, render a hard bright/dark edge with Highlights -100 and Shadows
  +100 and look at the brightness profile across it.
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
Update the guide and retake screenshots when features or the layout change.

## Not yet verified on the owner's machine

Installing as an app and opening NEF files from File Explorer, the folder
picker with the real card reader, thumbnail speed from the card, portrait
thumbnails, and spot removal on real sensor dust.

## Ideas discussed but not built

Perspective correction, blur as a local adjustment, snapshots, a colour
readout under the cursor. Declined as too large for now: AI subject and sky
masks, and Photoshop-style effect filters.
