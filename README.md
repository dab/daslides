# Slideshow

A fullscreen photo slideshow that runs in the browser. Hardware-accelerated, handles any folder size, and never crops your photos.

## Run

```bash
npm install
npm run dev
```

Open the URL it prints. Click **Choose folder…**, pick a folder of photos, hit **F** for fullscreen.

## Transitions

**Fade with Zoom** — Eased crossfade between slides. Outgoing photo drifts forward slightly; incoming swells in. Static during dwell.

**Ken Burns** — Slow linear pan + zoom on every slide, soft crossfade between. Each slide reveals the whole photo at one keyframe (start or end, randomized). Recommended dwell: 10–14s.

**Vintage Prints** — One photo as a paper print at center, three more recent photos as larger tilted prints layered behind. Every print has very slow continuous drift. Crossfade between cycles — no flying-card animations.

Fade with Zoom and Ken Burns use **cover fit** — the image always fills the viewport with aspect ratio preserved (no stretching, no bars). For portrait photos on a landscape screen, Ken Burns automatically gets a wider pan range on the cropped axis and can sweep top→bottom of the photo over its dwell. Vintage Prints shows each photo as a paper print, so the whole photo is visible inside the print.

## Controls

| Key | |
|---|---|
| `Space` | play / pause |
| `←` `→` | previous / next |
| `F` | fullscreen |
| `P` | hide / show side panel |
| `Esc` | exit fullscreen |

The side panel has the transition picker, dwell + transition duration, a virtualized image list (click to jump), Shuffle, and Fullscreen.

## Folders

- **Chrome / Edge / Opera 86+** — native folder picker via the File System Access API. Remembers your last location.
- **Firefox / Safari** — falls back to a multi-file `webkitdirectory` input.

Subfolders are walked recursively.

Supported formats:
- **Native**: jpg, png, webp, avif, heic, gif, bmp
- **RAW + TIFF** (CR2, CR3, ARW, NEF, RAF, RW2, ORF, DNG, TIFF): the embedded JPEG preview is extracted via [exifr](https://github.com/MikeKovarik/exifr). Modern cameras embed full-size previews — quality is fine for slideshow display, and decoding is orders of magnitude faster than processing the raw pixels. If a RAW file has no embedded preview large enough to use, it's skipped with a console warning.

## Converting RAW files ahead of time (recommended for big libraries)

For a smoother experience with large RAW folders — and for cameras whose embedded previews are too small or corrupt — convert your RAWs to JPEGs once, then point the slideshow at the converted folder.

```bash
bash scripts/raw-to-jpeg.sh ~/Pictures/RawShoots
# or with explicit output folder:
bash scripts/raw-to-jpeg.sh ~/Pictures/RawShoots ~/Pictures/RawShoots-jpg
```

What it does:
- Walks the input folder recursively, finds every `cr2/cr3/nef/arw/raf/rw2/orf/dng/tif/tiff`
- Converts each to a max-quality JPEG with longest edge ≤ **2560 px** (aspect preserved)
- Primary pipeline: macOS `sips` — Apple's built-in ImageIO RAW decoder (the same one Preview and Photos use). Full debayer + ICC + Apple's default white balance.
- Optional fallback: [LibRaw](https://github.com/LibRaw/LibRaw)'s `dcraw_emu` — catches the rare files Apple's decoder rejects. Install with `brew install libraw`.
- Output preserves directory structure. Idempotent — safe to re-run; already-converted files are skipped.

Check what RAW support is installed on your Mac:

```bash
bash scripts/raw-version.sh
```

Apple ships RAW Camera Support inside macOS point releases now (there's no separate beta channel). To pick up support for newer cameras, just keep macOS up to date — Apple's [current supported-camera list is here](https://support.apple.com/en-us/122870).

## Scale

The list is virtualized — ~30 rows in the DOM at any time, regardless of folder size. The engine's texture cache is bounded (14 entries). Tested with 1500+ images; nothing in the rendering pipeline scales with folder size.

## Project layout

```
src/
  main.ts                       wires UI ↔ engine
  engine.ts                     PixiJS app, texture cache, transition dispatch
  ui.ts                         side panel, virtualized list, keyboard
  folder.ts                     directory picker + image filtering
  imageLoader.ts                RAW/TIFF preview extraction (exifr)
  wakeLock.ts                   prevents OS screensaver / display sleep
  scenes/
    vintageScene.ts             paper-print scene graph
  transitions/
    shared.ts                   GLSL prelude (cover + contain samplers, blurred bg)
    types.ts                    TransitionDef union (shader | scene)
    fadeZoom.ts                 fragment shader
    kenBurns.ts                 fragment shader
    vintage.ts                  scene marker
    index.ts                    registry
scripts/
  raw-to-jpeg.sh                batch RAW→JPEG via macOS sips + LibRaw fallback
  raw-version.sh                report installed Apple RAW Camera Support version
```

## Stack

Vite + TypeScript + PixiJS v8 (WebGL2). No framework, no UI library. ~280 KB bundle, ~90 KB gzipped.
