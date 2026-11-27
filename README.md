# Duncan's Photo Lab

A browser-based, non-destructive RAW photo developer. Files are decoded and
edited locally; nothing is uploaded.

## Use it

The latest version is published at https://djury74.github.io/rawlab/ and
updates automatically on every push to `main`.

## Run locally

```bash
npm install
npm run dev
```

Then open the address Vite prints (normally http://localhost:5173).
`npm run build` produces a static site in `dist/` that any web server can host.
It must be served over HTTP; opening `index.html` from disk will not work
because the decoder runs in a worker.

## How it works

- `src/decode.js` decodes RAW files with LibRaw compiled to WebAssembly, as
  16-bit RGB with the camera's white balance, keeping highlight detail above
  nominal white. The decoder's transfer curve is undone on import so the
  pipeline works on linear light. JPEG/PNG also open.
- `src/gl/` is the WebGL2 pipeline. Data stays linear half-float until the
  final pass: resample (crop/rotate) -> noise reduction -> develop (sharpen,
  white balance, exposure, local tone, curve, colour mixer, grading, effects).
- `src/settings.js` defines the edit settings. An edit is only this object;
  it is saved per file in the browser and can be exported as a sidecar `.json`.
- `src/ui/locals.js` implements local adjustments (gradient, radial, brush).
  Masks are stored in image coordinates and evaluated in the develop shader;
  each one offsets the global controls per pixel.
- `src/main.js` holds application state, history, view, crop tool and export.
  Export renders the same pipeline at full size in tiles.

## Lens corrections

`src/lens.js` holds lens profiles (distortion, lateral chromatic aberration,
vignetting by aperture) and applies them when the file's metadata matches.
Profiles are included for the Nikon AF-S DX Nikkor 35mm f/1.8G, the Nikkor Z DX
16-50mm f/3.5-6.3 VR and the Nikkor Z DX 24mm f/1.7. Their calibration
values come from the [lensfun](https://lensfun.github.io) database, licensed
CC BY-SA 3.0. To add a lens, copy its values from lensfun into `LENS_PROFILES`.

## Browsing a card and installing

- **Open card or folder** lists the photos in a folder (and its subfolders) as a
  strip of thumbnails, newest first, using the preview each RAW file embeds.
  The folder is remembered. Needs Chrome or Edge.
- The site can be installed as an app from the browser's address bar. Once
  installed, RAW files can be opened in it from the file manager.

## Shortcuts

`Ctrl+O` open, `Ctrl+E` export, `Ctrl+Z` / `Ctrl+Shift+Z` undo and redo,
`\` before/after, `Y` side by side, `Tab` hide panels, `0` to `5` rate, `R` crop, `H` heal (spot removal; `S` shows spots), `W` white balance picker, `J` clipping warning,
`F` fit, `Z` 100%, left and right arrows for the previous and next photo in the strip. With a brush selected: `[` `]` size, `X` erase, hold `Space` to pan. Double-click a slider's name to reset it.

## Not built yet

Lens profiles beyond the one above, embedded colour profiles other
than sRGB, and a multi-image library.
