# daslides

A private, fullscreen photo slideshow that runs entirely in your browser — point it at a folder and play. **Your photos never leave your device** — they are read locally and never uploaded. Hardware-accelerated, handles any folder size, never crops your photos, and reads RAW + TIFF.

**Live:** https://dab.github.io/daslides/

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
| `S` | hide / show side panel |
| `?` | keyboard shortcuts |
| `Esc` | close panel / exit fullscreen |

The bottom bar has play/pause, previous/next, shuffle, settings, shortcuts and
fullscreen. The settings panel has the transition picker, dwell and fade
duration, and a virtualized image list — click a row to jump, or focus the list
and use the arrow keys.

## Folders

Folders are picked with a native `<input webkitdirectory>`, which works the same
in every desktop browser. There is no File System Access API involved, so
nothing is remembered between visits — pick the folder again after a reload.
Phones and tablets can't use a folder input at all, so they get a multi-select
photo picker instead.

Subfolders are walked recursively.

Supported formats:
- **Native**: jpg, png, webp, avif, gif, bmp. Also heic, but only in Safari —
  no Chromium or Firefox build decodes it.
- **RAW + TIFF** (CR2, CR3, ARW, NEF, RAF, RW2, ORF, DNG, TIFF): the embedded
  JPEG preview is extracted in a worker. Cameras store a ready-made JPEG inside
  the RAW — it's what the body shows on its own screen — so using it is far
  faster than demosaicing the sensor data, and good enough for a slideshow.
  Files with no preview of usable size are skipped.

  Note the embedded preview is a *preview*: on Canon bodies it is typically
  1536x1024, and on Sony around 1620x1080. That is plenty on a laptop and a
  little soft on a 4K display, which is why converting ahead of time (below) is
  still worth it for a large library you plan to show on a big screen.

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
  folder.ts                     file enumeration + image filtering
  imageLoader.ts                decode + downscale; dispatches RAW to the worker
  rawPreview.worker.ts          embedded JPEG preview extraction (off-thread)
  perf.ts                       ?perf=1 overlay
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

## Measuring performance

Open the app with `?perf=1` for an overlay showing frame time, the worst frame
*inside* the last transition, per-slide decode and upload times, and texture
memory. The settings drawer then gets a toggle to show or hide it, and clicking
the overlay resets its worst-frame figures so you can compare a change without
reloading.

## Privacy

Photos are read with a local file input and decoded in the browser. Nothing is
uploaded, and there is no analytics, no telemetry and no backend.

One third-party request remains: the two webfonts come from Google Fonts, so
loading the page tells Google your IP and user agent. The font stack falls back
to system fonts if that request is blocked, and the app itself works offline
once installed.

## Stack

Vite + TypeScript + PixiJS v8 (WebGL2). No framework, no UI library, no runtime dependencies. Initial payload 394 KB raw, 116 KB gzipped.
