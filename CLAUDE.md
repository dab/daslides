# CLAUDE.md

Notes for AI agents extending this code. Concise; complements README.md.

## Architecture

The app has two render modes — **shader mode** for `fadeZoom` and `kenBurns`, **scene mode** for `vintage`. The engine dispatches on `currentTransition.kind`.

### Shader mode

One fullscreen `Mesh` (from `MeshGeometry` — a unit quad scaled to viewport pixels) with a custom `Shader`. The fragment shader is swapped per-transition. Uniforms (`UniformGroup`) carry two textures + per-slide pan/zoom params + `uProgress` (transition) + `uDwellA/B` (per-slide motion). Both photo and its blurred background are computed in the same pass — see `transitions/shared.ts` for `sampleSlide()`.

### Scene mode

A `Pixi.Container` graph (`scenes/vintageScene.ts`). Currently only the Vintage Prints scene. Each cycle creates new `PrintCard` containers (Graphics shadow + Graphics paper + Sprite photo), fades them in, fades the old ones out — no position animations, only opacity + continuous slow sine drift.

## Engine lifecycle

1. `init(host)` — creates `Application` with `preferWebGLVersion: 2`, builds the mesh, attaches the ticker.
2. `setItems(files)` — replaces the items array, clears the cache, fresh-starts at index 0.
3. `setTransition(id)` — switches between mesh-visible and scene-visible. In scene mode the engine immediately seeds the scene with the current slide.
4. Per-frame `tick()`:
   - **shader**: updates `uProgress`/`uDwell*`, promotes B→A when `uProgress` hits 1.
   - **scene**: calls `scene.tick()`, advances when `dwellSec` elapses.

## Texture lifecycle (critical)

Slide textures are owned by Pixi's `Assets` system. Three rules:

1. **Never** `texture.destroy()` — use `Assets.unload(url)` then `URL.revokeObjectURL(url)`. Direct destroy desyncs Assets' refcount.
2. **Never** evict a slide whose source is currently bound to a shader sampler **or** held by a scene card. `preloadWindow()` adds shader-bound + `vintageScene.heldEntries()` to the keep set before evicting.
3. **Before** any destructive cache operation (e.g. `setItems`), rebind shader samplers to `Texture.WHITE` first.

Symptom of breaking these: `Uncaught TypeError: can't access property "alphaMode", textureSource is null` from the batcher.

## Cache

- Keyed by `ImageEntry` identity (not index) so shuffle/reorder doesn't trash preloads.
- Bound to `maxCache = 14`.
- Preload window: `[cursor-1 … cursor+3]` in shader mode, `[cursor-3 … cursor+3]` in scene mode (vintage bg pile needs the previous 3).

## Adding a new transition

**Shader transition:**
1. Add the ID to `TransitionId` union in `transitions/types.ts`.
2. Write a `TransitionDef` with `kind: 'shader'`, the GLSL fragment (use `FRAG_PRELUDE` + `sampleSlide()`), and `kenBurns: true | false`.
3. Register it in `transitions/index.ts`.
4. Add the `<option>` to `index.html`.

**Scene transition:**
1. Build a new file in `src/scenes/<name>Scene.ts` that exposes `root: Container`, `tick()`, `reset()`, `heldEntries(): Set<ImageEntry>`, `resize(w, h)`, plus your scene's input API (analogue of `addPhoto`).
2. Add `TransitionDef` with `kind: 'scene'`.
3. Extend `engine.ts` — `setTransition`, `startSlide`, `beginTransition`, `tick` — to dispatch to the new scene. Today's code only special-cases `vintageScene`; you may want to generalize via an interface if you add more.

## Shaders

- GLSL ES 3.00 / WebGL2 with `#version 300 es` directive in every shader source.
- Use `in vec2 aUV; in vec2 aPosition` in vertex (matches MeshGeometry's attributes; declaring both suppresses Pixi's warning).
- Use `out vec4 fragColor` (not `gl_FragColor`).
- Pixi auto-prepends nothing when `#version` is present.
- For multi-tap blur in shader: rotating golden-angle kernel works well, avoids banding, ~16–18 taps is the practical sweet spot.

## UI

`src/ui.ts` contains a small `VirtualList` — Map<index, row> of currently-rendered rows, absolute-positioned by `index × rowHeight`. Recycle on scroll, debounced via `requestAnimationFrame`. `setActive` is O(1). No external virtualization library.

## Fit / vertical photos

**Shader transitions (Fade with Zoom, Ken Burns)**: COVER fit. Image always fills the viewport — long axis cropped, aspect ratio preserved, NO empty space ever. Ken Burns animates zoom 1.0 ↔ 1.10 — at zoom 1.0 the image is at exact cover (minimum crop, fills full screen width for portrait or full screen height for landscape), at zoom 1.10 it's 10 % tighter.

**Aspect-aware pan**: relative pan in JS, the shader computes per-axis safe-pan range from `0.5 × (1 − scale/zoom)`. For portrait photos on landscape screens, vertical safe-pan is large even at zoom 1.0 — Ken Burns can sweep top → bottom of the photo without exposing an edge. For aspect-matched photos, safe-pan is 0 at zoom 1.0 and opens up with zoom.

**Scene transition (Vintage Prints)**: each print card uses contain WITHIN its paper area, so the whole photo is visible inside the print.

## File access

`folder.ts` exports `pickDirectory()` (File System Access API) and `entriesFromFileList()` (fallback for Firefox/Safari). Both return `ImageEntry[]` with `getFile()` thunks — files are read lazily, never eagerly. Memory cost of "load a folder" is O(N) lightweight entry objects (~100 bytes each), not file contents.

## RAW / TIFF support

`imageLoader.ts` resolves a `File` to a Blob the browser can render. For RAW (CR2/CR3, ARW, NEF, RAF, RW2, ORF, DNG) and TIFF, it dynamically imports `exifr` and pulls the embedded JPEG preview from `PreviewImage`, `JpgFromRaw`, `OtherImage`, or `ThumbnailImage` tags (modern cameras store full-size previews there). A heuristic — `byteLength > 16 KB` — distinguishes a real preview from a 160×120 EXIF thumbnail. Fall-throughs: tiny thumbnail → raw File handoff (Safari decodes baseline TIFF natively). Files that fail entirely are logged and skipped — `engine.loadSlide` catches rejection and `startSlide`/`beginTransition` short-circuit cleanly.

To support pixel-accurate RAW decoding (color profiles, white balance, demosaicing), drop in a WASM LibRaw build and add it as a fallback when no preview is found — the existing `imageLoader.ts` shape supports this without engine changes.

## Don'ts

- Don't switch shader transitions away from COVER fit. User wants the image to always fill the viewport (full width OR full height accordingly), no empty space, no bars, no stretching. They've asked for this multiple times.
- Don't go below zoom 1.0 in shader transitions. That would expose the screen background (black bars) — which contradicts the cover-fit requirement.
- Don't reintroduce a blurred backdrop pass. With cover fit there's no exposed area to fill; the extra fillrate is wasted.
- Don't animate Vintage Prints card positions between cycles. User dislikes "moving afterwards" behavior. Crossfade only; slow sine drift is the only motion.
- Don't add a sepia/grain/vignette filter to Vintage Prints. The macOS screensaver shows photos UNTOUCHED on paper prints.
- Don't render 1500 DOM rows. Always virtualize.
- Don't call `texture.destroy()` on Assets-managed textures — use `Assets.unload(url)`.
