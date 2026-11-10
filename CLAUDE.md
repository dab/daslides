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
   Until its first slide is on screen (`starting`, cleared in `reveal()`),
   `beginTransition` is a no-op: `slideStart` still belongs to the previous set,
   so `tick()` would advance at once and cancel the pending `startSlide`, leaving
   the canvas hidden. `clear()` (the Home button) is `setItems([])` plus
   un-revealing the canvas so the next set fades up from black.
3. `setTransition(id)` — switches between mesh-visible and scene-visible. In scene mode the engine immediately seeds the scene with the current slide.
4. Per-frame `tick()`:
   - **shader**: updates `uProgress`/`uDwell*`, promotes B→A when `uProgress` hits 1.
   - **scene**: calls `scene.tick(now)`, advances when `dwellSec` elapses.

## Clock + render-on-demand (critical)

All animation timestamps (`slideStart`, `transStart`, and the vintage scene's
card birth/fade times passed into `tick(now)`/`addPhoto(..., now)`) live in
**clock time**, not raw `performance.now()`. The clock (`clock()`,
`freezeClock()`, `unfreezeClock()`) advances only while not paused — so pausing
is "stop the clock," not "patch every timestamp." Don't reintroduce timestamp
shifting.

`sync()` is the single place that reconciles renderer + clock + dwell-timer with
state. The ticker is **stopped** whenever no continuous animation is needed:

- transition in flight, or playing with continuous motion (Ken Burns / Vintage)
  → ticker runs every frame.
- playing but the frame is static (Fade with Zoom mid-dwell) → ticker **stopped**;
  a `setTimeout` (`scheduleDwell`) wakes us to start the next transition.
- paused → ticker stopped, clock frozen, last frame held.

### Per-slide motion is normalized over `spanMs`, not `dwellSec`

A slide's visible life runs from `slideStart` — which is *definitionally* its
incoming transition's `transStart` — through its dwell and its outgoing
transition: `spanMs = (dwellSec + 2 × tDurSec) × 1000`. `uDwellA` / `uDwellB` are
elapsed-over-`spanMs`, so motion runs at ONE constant rate from keyframe to
keyframe, reaching exactly 1.0 as the outgoing transition ends. No clamp engages
during normal playback.

Two things this replaced, both of which are regressions if reintroduced:
normalizing over `dwellSec` left motion **pinned at its end keyframe for the last
`tDurSec` of every slide** (a visible freeze right before each fade), and the
asymmetric `1.0` / `1.25` clamps then extrapolated past the keyframe. At the
A←B promotion, assign `slideStart = transStart` directly — do not back-date it
from `now`, which reintroduces frame-overshoot drift.

`setTiming()` re-anchors `slideStart` when dwell/fade change, because `spanMs` is
the denominator — otherwise changing dwell 10 → 30 collapses `uDwellA` and jumps
the zoom backwards.

So a stopped ticker during a Fade dwell is **correct, not a bug** — it's ~0 GPU.
Any state change while the ticker is stopped must `renderOnce()` (or call
`sync()`, which does). When switching *into* a shader transition, re-bind the
current slide (samplers may have been evicted to white in scene mode).

## Texture lifecycle (critical)

Slide textures are **engine-owned**. `Assets` is not used at all — `loadSlide`
decodes the Blob itself via `decodeToBitmap()` and builds the `ImageSource`.
(This replaced `Assets.load` + blob URLs, which gave no control over resolution
or mipmaps and round-tripped a blob URL back through `fetch` in a worker.)

Four rules:

1. `releaseSlide` must `texture.destroy(true)` **and** `bitmap.close()`.
   Pixi's `TextureSource.destroy()` nulls `resource` but never closes the
   `ImageBitmap`, so skipping the close leaks the decoded image.
2. **Never** evict a slide whose source is currently bound to a shader sampler
   **or** held by a scene card. `preloadWindow()` adds shader-bound +
   `vintageScene.heldEntries()` to the keep set before evicting.
3. **Before** any destructive cache operation (e.g. `setItems`), rebind shader
   samplers to `Texture.WHITE` first. `releaseSlide` does this per-slide, and
   the order matters — rebind, then destroy.
4. `autoGarbageCollect` must be set to `false` **after** constructing the
   `ImageSource`. Its constructor assigns `true` unconditionally after
   `super()`, so passing it in the options object is silently ignored. Without
   it Pixi's idle GC unloads prewarmed textures behind our back.

Symptom of breaking 1–3: `Uncaught TypeError: can't access property "alphaMode",
textureSource is null` from the batcher.

### Resolution, mipmaps, upload

- Textures are capped **per axis** at the device pixel size
  (`screen × resolution`), clamped to `gl.MAX_TEXTURE_SIZE`, and never upscaled
  (`textureCaps()`). The per-axis cap is required by cover fit — capping the long
  edge alone under-resolves panoramas. The `MAX_TEXTURE_SIZE` clamp is not an
  optimisation: Pixi does not validate it, and exceeding it renders a **black
  slide** with no error on 4096-limited devices.
- `autoGenerateMipmaps: true` is **sufficient on its own** — `GlTextureSystem`
  derives `mipLevelCount` itself, and the default `scaleMode: 'linear'` already
  yields `LINEAR_MIPMAP_LINEAR`. Don't also pass `mipLevelCount` (overwritten) or
  `mipmapFilter` (redundant). Anisotropic filtering buys nothing here: cover fit
  preserves aspect, so the texel footprint is isotropic.
- Mipmaps are **load-bearing for the shaders**, not just quality — `blurredBg`
  samples an explicit LOD. See "Shaders".
- Uploads are explicit: `queueUpload()` → one `initSource()` per animation
  frame, never while `inTransition`. Pixi otherwise uploads lazily on first
  bind, which lands a multi-megabyte `texImage2D` on the crossfade's first
  frame. Don't go back to lazy upload, and don't drain the queue from `tick()`
  (it must stay out of the render pass).

## Cache

- Keyed by `ImageEntry` identity (not index) so shuffle/reorder doesn't trash preloads.
- Bound by **both** `maxCache = 14` **and** `maxTextureBytes` (~384 MB). The count
  alone is not a memory bound: on a high-DPI display the resolution cap barely
  bites, so 14 resident slides could still reach ~1.3 GB. The preload window is
  exempt from the byte budget — the working set is needed — so on a big screen the
  budget bounds the cache to the window rather than to 14.
- `evict()` settles `residentBytes` synchronously; `releaseSlide` runs a
  microtask later, so doing the accounting there would make the eviction loop
  over-evict in one pass.
- Preload window: `[cursor-1 … cursor+3]` in shader mode, `[cursor-3 … cursor+3]` in scene mode (vintage bg pile needs the previous 3).

## Adding a new transition

**Shader transition:**
1. Add the ID to `TransitionId` union in `transitions/types.ts`.
2. Write a `TransitionDef` with `kind: 'shader'`, the GLSL fragment (use `FRAG_PRELUDE` + `sampleSlide()`), and `kenBurns: true | false`.
3. Register it in `transitions/index.ts`.
4. Add the `<option>` to `index.html`.

**Scene transition:**
1. Build a new file in `src/scenes/<name>Scene.ts` that exposes `root: Container`, `tick(now)`, `reset()`, `heldEntries(): Set<ImageEntry>`, `resize(w, h)`, plus your scene's input API (analogue of `addPhoto(..., now)`). `now` is engine **clock** time — store it for tween math; never call `performance.now()` inside the scene (it would ignore pause). Cache static card containers with `cacheAsTexture(true)` so per-frame filters (e.g. drop-shadow blur) bake once.
2. Add `TransitionDef` with `kind: 'scene'`.
3. Extend `engine.ts` — `setTransition`, `startSlide`, `beginTransition`, `tick` — to dispatch to the new scene. Today's code only special-cases `vintageScene`; you may want to generalize via an interface if you add more.

## Shaders

- GLSL ES 3.00 / WebGL2 with `#version 300 es` directive in every shader source.
- Use `in vec2 aUV; in vec2 aPosition` in vertex (matches MeshGeometry's attributes; declaring both suppresses Pixi's warning).
- Use `out vec4 fragColor` (not `gl_FragColor`).
- Pixi auto-prepends nothing when `#version` is present.
- For multi-tap blur in shader: rotating golden-angle kernel works well and
  avoids banding. Sample it from a **small mip with an explicit LOD**
  (`textureLod`), not at full resolution — `blurredBg` picks the mip whose long
  edge is ~64 px and needs only 8 taps, because each mip texel is already an
  average. Full-resolution multi-tap blur was 18 taps of scattered fetches
  across a multi-megabyte surface, which is maximally texture-cache-hostile.
- **`blurredBg` must keep using `textureLod`.** It is called from inside
  non-uniform control flow (the `photoAlpha` test in `sampleSlideContain`), where
  implicit-derivative fetches are undefined. That was harmless only while
  textures had no mip chain; now that they do, switching back to `texture()`
  there is undefined behaviour.
- Take derivatives from the **unclamped** coordinate (`textureGrad(tex,
  clamp(c,0,1), dFdx(c), dFdy(c))`). Clamping first flattens them to zero
  outside the photo rect, collapsing the LOD and leaving a soft seam at the edge.
- Branch on uniforms where you can. `if (uProgress > 0.0)` around the B sample is
  uniform across the whole draw call — no divergence — and skips a full
  (potentially blur-hitting) sample on every dwell frame.

## Perf overlay

`src/perf.ts` is an overlay that is inert unless the URL carries `?perf=1`
(every entry point returns early; nothing mounts, no timers run). No keybinding
— `space`, arrows, `f`, `s` and `?` are already taken by `ui.ts`.

With the flag on, a **Performance overlay** toggle appears in the settings
drawer; without it the row stays `hidden` rather than offering a dead control.
Hiding the overlay only stops it drawing — measurement keeps running, so
switching it back on shows live numbers rather than starting from scratch.
Clicking the overlay zeroes the high-water marks (`worst`, `IN-TRANS`), which is
what makes a before/after comparison possible without a reload — otherwise one
hitch during the initial decode sticks there all session.

The number to watch is **IN-TRANS**: the worst frame *inside* the last
transition. A stall at a transition boundary is exactly what "it hangs before
switching" looks like, and an average frame time hides it completely. Frame cost
is the interval between engine ticks, not a timed render call, so a dropped frame
registers whatever caused it (GPU upload, layout flush, main-thread decode).
`perfTransition(true)` resets the interval baseline because the ticker may have
been stopped for an entire static dwell, and that gap is not a dropped frame.

Expect `upload` to be well under a millisecond and to appear during dwells, never
at a transition. If it starts showing up on transition frames, the staged upload
queue has been broken.

## UI

Drawer settings (transition, dwell, fade, shuffle on load, auto-hide) persist in
`localStorage` under `daslides:prefs`. `persistPrefs()` restores them into the
controls at the very top of the `UI` constructor — before `commitNumber` and
before `main.ts` syncs the engine from the DOM — so nothing else needs to know.

`src/ui.ts` contains a small `VirtualList` — Map<index, row> of currently-rendered rows, absolute-positioned by `index × rowHeight`. Recycle on scroll, debounced via `requestAnimationFrame`. `setActive` is O(1). No external virtualization library.

## Fit / vertical photos

**Fade with Zoom**: pure COVER (`sampleSlide`, one tap). Image always fills the
viewport — long axis cropped, aspect ratio preserved, NO empty space ever. Zoom
stays ≥ 1.0 (1.0 ↔ 1.0 + `fadeMag`, `fadeMag` ∈ 0.08–0.14).

**Ken Burns**: COVER for landscape photos (`randPanZoom` emits zoom 1.0 ↔
1.15–1.30, `sampleSlideContain` behaves exactly like cover there). **Portrait
photos on a landscape screen are the documented exception**: they are shown whole
at `heightFactor × scale.y` with the side bars filled by a blurred copy of the
same photo (the Plex / Apple-TV pattern) — so the "no bars ever" rule below is
specifically about *landscape* photos and about never dropping below cover by
accident. If you change this, it is a product decision, not a cleanup.

**Aspect-aware pan**: relative pan in JS, the shader computes per-axis safe-pan range from `0.5 × (1 − scale/zoom)`. For portrait photos on landscape screens, vertical safe-pan is large even at zoom 1.0 — Ken Burns can sweep top → bottom of the photo without exposing an edge. For aspect-matched photos, safe-pan is 0 at zoom 1.0 and opens up with zoom.

**Scene transition (Vintage Prints)**: each print card uses contain WITHIN its paper area, so the whole photo is visible inside the print.

## File access

`folder.ts` exports `entriesFromFileList()` and `isTouchPrimary()`/`isIOS()`.
**There is no `pickDirectory()` and no File System Access API** — picking is a
native `<input webkitdirectory>` opened by a `<label for>`, which avoids the
user-gesture pitfalls (Brave blocks the FSA picker; `showDirectoryPicker` after
an `await` loses the gesture). This doc used to claim otherwise.

Dropping a folder anywhere on the window also works: `droppedEntries()` must
run synchronously inside the `drop` handler (the `DataTransfer` is emptied when
it returns), then `entriesFromDrop()` walks the entries. `readEntries` returns
at most ~100 entries per call, so it is read until empty.

`entriesFromFileList` returns `ImageEntry[]` with `getFile()` thunks — files are
read lazily, never eagerly. Memory cost of "load a folder" is O(N) lightweight
entry objects (~100 bytes each), not file contents.

The extension list is **authoritative**; don't reintroduce a MIME-type check in
front of it. `image/*` matches SVG (undecodable by `createImageBitmap`), ICO,
and macOS `._NAME.ARW` AppleDouble sidecars, which share the real file's
extension and doubled the photo count with unreadable 4 KB stubs.

## RAW / TIFF support

`rawPreview.worker.ts` extracts the embedded JPEG preview off the main thread.
`imageLoader.ts` dispatches to it and then decodes/downscales the result.

How the preview is found:

- **TIFF-based** (CR2, ARW, NEF, ORF, RW2, DNG, TIFF): walk the IFD chain plus
  SubIFD/ExifIFD links, collecting `StripOffsets`/`StripByteCounts` where
  `Compression == 6` and the `ThumbnailOffset`/`Length` pair.
- **Everything else** (CR3 is ISO-BMFF, RAF has a Fujifilm header): bounded scan
  of the front of the file for `FFD8FF … FFD9`.

Candidates are sorted by size and validated by their **SOF marker**, then the
first usable one wins. That validation is load-bearing, not a nicety:

- A CR2's sensor data is also a JPEG stream, but **SOF3 (lossless)** — no browser
  can decode it. Filtering on `Compression == 6` alone does *not* exclude it.
- An ARW's largest block is ~47 MB of **uncompressed** pixels.
- Previews under 800 px wide are thumbnails; reject and skip the file.

**Do not go back to exifr for this.** It was used here and never worked: the code
asked for `PreviewImage`/`JpgFromRaw`/`OtherImage`, which are **ExifTool** tag
names that exifr does not have. Unknown `pick` names make exifr disable every
block and return `undefined` — silently — so every RAW fell through to the small
IFD1 thumbnail. exifr also can't open CR3 or RAF at all (it dispatches on magic),
and its `thumbnail()` only reads the first 64 KB, which is the real source of the
"offset is outside the bounds of the DataView" errors.

**EXIF orientation** must be carried separately for RAW. An extracted preview is
a bare JPEG with no APP1/Exif segment, so `imageOrientation: 'from-image'` has
nothing to read — the flag only exists in the parent file's IFD0. The worker
returns it and `decodeToBitmap` applies it. Getting this wrong shows portrait
photos sideways *and* mis-classifies them as landscape for Ken Burns.

For pixel-accurate decoding (colour profiles, white balance, demosaicing) drop in
a WASM LibRaw build as a fallback when no preview is found; the worker's shape
supports it.

## Hosting + CSP

daslides.app is a Cloudflare Worker serving `dist/` as static assets
(`wrangler.jsonc`); Cloudflare builds every push to `main`. The base path is `/`.

Headers come from `src/_headers`, written to `dist/_headers` by the
`headers()` plugin in `vite.config.ts`. The CSP is strict (`'self'` only, no
eval, no inline styles); inline scripts are allowed by sha256 hashes computed
from the **built** `index.html`, so editing the stale-cache recovery script
needs no manual hash update. Anything that adds a third-party origin, a `blob:`
worker or WASM (`'wasm-unsafe-eval'`) must extend the policy there.

`import 'pixi.js/unsafe-eval'` in `engine.ts` is **required** — despite its
name it makes Pixi run *without* eval. Remove it and the renderer fails to start
on the live site while still working in `npm run dev` (no CSP there). Test CSP
changes with `npm run build && npx wrangler dev`, which applies `_headers`.

## Don'ts

- Don't switch shader transitions away from COVER fit for landscape photos. The image must fill the viewport (full width OR full height accordingly), no empty space, no bars, no stretching. They've asked for this multiple times. (Portrait photos in Ken Burns are the deliberate exception — see "Fit / vertical photos".)
- Don't let zoom go below 1.0 for a landscape photo — that drops it under cover fit and exposes the blurred-bar path. This was a real bug: normalizing Ken-Burns motion over `dwellSec` while advancing at `dwellSec + tDurSec` made the old `Math.min(1.25, …)` clamp extrapolate `mix(zooms.x, zooms.y, 1.25)` down to zoom 0.925 on ~half of all slides. Normalize over `spanMs` and never extrapolate past a keyframe.
- Don't normalize per-slide motion over `dwellSec`. Use `spanMs` (`dwellSec + 2 × tDurSec`) — see "Clock + render-on-demand".
- Don't animate Vintage Prints card positions between cycles. User dislikes "moving afterwards" behavior. Crossfade only; slow sine drift is the only motion.
- Don't add a sepia/grain/vignette filter to Vintage Prints. The macOS screensaver shows photos UNTOUCHED on paper prints.
- Don't render 1500 DOM rows. Always virtualize.
- Don't reintroduce `cacheAsTexture()` on Vintage cards. It allocates a
  power-of-two render target per card (~33 MB at 2x) outside the engine's texture
  budget, and sizes it from local bounds, which exclude filter padding — so it
  also clipped the shadow's penumbra. Cards now share one pre-blurred
  nine-sliced shadow and need no bake.
- Don't destroy a Vintage card with `destroy(true)` or `destroy({children:true})`.
  The first takes the engine-owned slide texture with it; the second leaks the
  `GraphicsContext` and never destroys filters. Use
  `{ children: true, context: true, texture: false }`.
- Don't start Vintage cards at alpha 0 when *seeding* the pile. Seeding can
  happen while paused, when the clock is frozen and `tick()` never runs, so the
  fade never starts and the screen stays black. `addPhoto(..., instant)` exists
  for this.
- Don't probe the DOM to decide whether the photo list is visible. The closed
  drawer is hidden with a `transform`, so it stays laid out and `clientHeight` is
  never 0. `setPanel()` pushes the state in.
- Don't put `aria-live` on anything that updates per slide — it makes a screen
  reader announce every photo for as long as the slideshow runs.
- Don't reintroduce `Assets` for slide textures. The engine owns them so it can control resolution, mipmaps and upload timing — see "Texture lifecycle".
- Don't let a texture upload land on a transition frame. Keep `queueUpload()`'s one-per-frame, not-while-`inTransition` drain.
- Don't force layout from `onSlideChange` — it fires at the instant a transition starts. (That is why the progress bar uses the Web Animations API instead of the `void offsetWidth` reflow trick.)
