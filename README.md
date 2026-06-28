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

## Scale

The list is virtualized — ~30 rows in the DOM at any time, regardless of folder size. The engine's texture cache is bounded (14 entries). Tested with 1500+ images; nothing in the rendering pipeline scales with folder size.

## Project layout

```
src/
  main.ts                       wires UI ↔ engine
  engine.ts                     PixiJS app, texture cache, transition dispatch
  ui.ts                         side panel, virtualized list, keyboard
  folder.ts                     directory picker + image filtering
  scenes/
    vintageScene.ts             paper-print scene graph
  transitions/
    shared.ts                   GLSL prelude (contain fit, blurred bg, samplers)
    types.ts                    TransitionDef union (shader | scene)
    fadeZoom.ts                 fragment shader
    kenBurns.ts                 fragment shader
    vintage.ts                  scene marker
    index.ts                    registry
```

## Stack

Vite + TypeScript + PixiJS v8 (WebGL2). No framework, no UI library. ~280 KB bundle, ~90 KB gzipped.
