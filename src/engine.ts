import {
  Application,
  Assets,
  Mesh,
  MeshGeometry,
  Shader,
  Texture,
  UniformGroup,
} from 'pixi.js';
import { TRANSITIONS, type TransitionDef, type TransitionId } from './transitions/index.ts';
import { VERTEX } from './transitions/shared.ts';
import { VintageScene } from './scenes/vintageScene.ts';
import { createWakeLock, type WakeLockHandle } from './wakeLock.ts';
import { getImageBlob } from './imageLoader.ts';
import type { ImageEntry } from './folder.ts';

interface LoadedSlide {
  entry: ImageEntry;
  texture: Texture;
  url: string;
  /** Random Ken-Burns motion params, set once per slide. */
  panZoom: { pan0: [number, number]; pan1: [number, number]; z0: number; z1: number };
  /**
   * Per-slide fade-with-zoom magnitude — how aggressive the Cross-Zoom is when
   * this slide is involved in a transition. Randomized 0.08–0.14 (researched
   * "premium sweet spot": 10–12%, with ±2% jitter for variety). The shader
   * uses two values per transition: outgoing pushes 1.0 → 1.0+magA, incoming
   * pulls 1.0+magB → 1.0. Independent per slide so adjacent transitions feel
   * different.
   */
  fadeMag: number;
}

const randInRange = (a: number, b: number) => a + Math.random() * (b - a);

/**
 * Compose a randomized Ken-Burns start/end keyframe for one slide.
 *
 * Two regimes selected from the texture's intrinsic orientation:
 *
 *   HORIZONTAL (aspect ≥ 1.0): pure COVER, zoom 1.0 ↔ 1.10, random direction.
 *     Pan is relative [-1, 1] per axis — the shader clamps to the per-axis
 *     safe range so aspect-matched and slightly-mismatched horizontals all
 *     behave well. This is the prior horizontal behaviour — unchanged.
 *
 *   VERTICAL (aspect < 1.0): photo height is ALWAYS ≥ 105 % of viewport
 *     (never letterboxed top/bottom). Min keyframe random ∈ [1.05, 1.20] of
 *     viewport height, max keyframe random ∈ [1.20, 1.40]. Random direction.
 *     For a vertical photo on a landscape screen this means the image
 *     extends past the screen vertically (top/bottom cropped) while still
 *     being narrower than the screen width — the sides are filled with the
 *     blurred-self backdrop. The zoom factor is `heightFactor × scale.y`
 *     where scale.y = imgAspect / screenAspect is the cover-fit ratio.
 */
function randPanZoom(imgAspect: number, screenAspect: number): LoadedSlide['panZoom'] {
  const startMin = Math.random() > 0.5;
  const rel = (): [number, number] => [
    (Math.random() * 2 - 1) * 0.85,
    (Math.random() * 2 - 1) * 0.85,
  ];

  if (imgAspect < 1.0 && imgAspect < screenAspect) {
    // Vertical photo on a wider screen — use heightFactor regime
    const scaleY = imgAspect / screenAspect;     // < 1
    const minH = randInRange(1.05, 1.20);
    const maxH = minH + randInRange(0.10, 0.20); // tighter keyframe
    const zMin = minH * scaleY;
    const zMax = maxH * scaleY;
    return startMin
      ? { z0: zMin, pan0: rel(), z1: zMax, pan1: rel() }
      : { z0: zMax, pan0: rel(), z1: zMin, pan1: rel() };
  }

  // Horizontal (or vertical-on-portrait): cover throughout, zoom 1.0 ↔ 1.15–1.30
  const tightZ   = randInRange(1.15, 1.30);
  const coverPan = rel();
  const tightPan: [number, number] = [
    -coverPan[0] * randInRange(0.7, 1.0) + (Math.random() - 0.5) * 0.15,
    -coverPan[1] * randInRange(0.7, 1.0) + (Math.random() - 0.5) * 0.15,
  ];
  return startMin
    ? { z0: 1.0,    pan0: coverPan, z1: tightZ, pan1: tightPan }
    : { z0: tightZ, pan0: tightPan, z1: 1.0,    pan1: coverPan };
}

export class Engine {
  app!: Application;

  // Shader-mode rendering
  private mesh!: Mesh<MeshGeometry, Shader>;
  private uniforms!: UniformGroup;

  // Scene-mode rendering (lazy)
  private vintageScene: VintageScene | null = null;

  private currentTransition: TransitionDef = TRANSITIONS.fadeZoom;
  private fallbackTex = Texture.WHITE;

  private items: ImageEntry[] = [];
  private cache = new Map<ImageEntry, Promise<LoadedSlide>>();
  /**
   * Entries that have failed to load (corrupt files, RAWs with no extractable
   * preview, browser-undecodable formats). Marked once, skipped forever — no
   * more spinning the CPU re-trying the same broken file every tick.
   * Cleared on setItems (fresh folder).
   */
  private failed = new Set<ImageEntry>();
  /**
   * Cache budget: cursor window (5) + scene mode's pile (up to 5 cards + 1 bg
   * = 6) with possible overlap. 14 gives generous headroom without unbounded
   * memory growth, even on libraries with thousands of photos.
   */
  private maxCache = 14;
  private cursor = 0;

  private playing = false;
  private inTransition = false;
  private dwellSec = 10;
  private tDurSec = 1.5;
  /** Holds the display awake while playback runs. */
  private wakeLock: WakeLockHandle = createWakeLock();

  /**
   * Pause tracking. When paused we stop Pixi's ticker entirely (no rAF, no
   * render, ~0 % GPU). On resume we shift all animation timestamps forward
   * by the paused duration so drift/camera don't visibly jump.
   */
  private pauseStartedAt = 0;
  /**
   * Set when navigation (next/prev/jump) is invoked while paused — the
   * ticker resumes for the transition, then the tick loop stops it again.
   */
  private restartPauseAfterTransition = false;
  private slideStart = 0;
  private transStart = 0;

  onSlideChange?: (index: number) => void;
  onPlayingChange?: (playing: boolean) => void;

  async init(host: HTMLElement) {
    this.app = new Application();
    await this.app.init({
      resizeTo: host,
      antialias: false,
      backgroundColor: 0x000000,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      preference: 'webgl',
      preferWebGLVersion: 2,
      powerPreference: 'high-performance',
    } as any);
    host.appendChild(this.app.canvas);

    this.app.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      console.warn('[slideshow] WebGL context lost');
    });
    this.app.canvas.addEventListener('webglcontextrestored', () => {
      console.info('[slideshow] WebGL context restored');
    });

    // Uncap the ticker so it runs at the display's native refresh rate
    // (60 / 90 / 100 / 120 / 144 Hz …). All animations use performance.now()
    // for time deltas, so motion stays the same speed regardless of fps.
    this.app.ticker.maxFPS = 0;
    this.app.ticker.minFPS = 1;

    this.buildMesh();
    this.setTransition('fadeZoom');

    this.app.ticker.add(() => this.tick());
    window.addEventListener('resize', () => this.handleResize());
  }

  // ─── rendering setup ──────────────────────────────────────────────────────

  private buildMesh() {
    const geometry = new MeshGeometry({
      positions: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });

    this.uniforms = new UniformGroup({
      uAspectA: { value: 1, type: 'f32' },
      uAspectB: { value: 1, type: 'f32' },
      uScreenAspect: { value: 1, type: 'f32' },
      uProgress: { value: 0, type: 'f32' },
      uDwellA: { value: 0, type: 'f32' },
      uDwellB: { value: 0, type: 'f32' },
      uTime: { value: 0, type: 'f32' },
      uPanZoomA: { value: new Float32Array([0, 0, 0, 0]), type: 'vec4<f32>' },
      uPanZoomB: { value: new Float32Array([0, 0, 0, 0]), type: 'vec4<f32>' },
      uZoomA: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
      uZoomB: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
      uKB: { value: 0, type: 'f32' },
      /** Per-slide Cross-Zoom magnitudes — x=A, y=B. Used by fadeZoom shader. */
      uFadeMag: { value: new Float32Array([0.1, 0.1]), type: 'vec2<f32>' },
    });

    // Minimal placeholder fragment — immediately replaced by setTransition().
    const INIT_FRAG = `#version 300 es
precision highp float;
out vec4 fragColor;
void main(){ fragColor = vec4(0.0); }`;
    const shader = this.makeShader(INIT_FRAG);
    this.mesh = new Mesh({ geometry, shader }) as Mesh<MeshGeometry, Shader>;
    this.app.stage.addChild(this.mesh);

    this.handleResize();
  }

  private makeShader(fragment: string): Shader {
    return Shader.from({
      gl: { vertex: VERTEX, fragment },
      resources: {
        sceneUniforms: this.uniforms,
        uTexA: this.fallbackTex.source,
        uTexB: this.fallbackTex.source,
      },
    });
  }

  private handleResize() {
    const w = this.app.renderer.screen.width;
    const h = this.app.renderer.screen.height;
    this.mesh.scale.set(w, h);
    this.uniforms.uniforms.uScreenAspect = w / Math.max(1, h);
    this.vintageScene?.resize(w, h);
  }

  // ─── mode + transition ────────────────────────────────────────────────────

  private ensureVintageScene(): VintageScene {
    if (!this.vintageScene) {
      this.vintageScene = new VintageScene();
      this.app.stage.addChild(this.vintageScene.root);
      this.vintageScene.resize(
        this.app.renderer.screen.width,
        this.app.renderer.screen.height,
      );
    }
    return this.vintageScene;
  }

  setTransition(id: TransitionId) {
    const def = TRANSITIONS[id];
    this.currentTransition = def;

    if (def.kind === 'shader') {
      const newShader = this.makeShader(def.fragment);
      const oldRes = this.mesh.shader!.resources as any;
      const newRes = newShader.resources as any;
      if (oldRes.uTexA) newRes.uTexA = oldRes.uTexA;
      if (oldRes.uTexB) newRes.uTexB = oldRes.uTexB;
      (this.mesh as any).shader = newShader;
      this.uniforms.uniforms.uKB = def.kenBurns ? 1 : 0;

      this.mesh.visible = true;
      if (this.vintageScene) {
        this.vintageScene.root.visible = false;
        this.vintageScene.reset();
      }
    } else {
      // scene
      const scene = this.ensureVintageScene();
      scene.root.visible = true;
      scene.reset();
      this.mesh.visible = false;

      // Seed the scene with the current slide if we have one
      const entry = this.items[this.cursor];
      if (entry) {
        (async () => {
          const focal = await this.loadSlide(entry);
          if (this.items[this.cursor] !== entry || this.currentTransition.kind !== 'scene') return;
          const history = await this.historySlides(3);
          scene.addPhoto(
            {
              focal: { texture: focal.texture, entry: focal.entry },
              history: history.map(s => ({ texture: s.texture, entry: s.entry })),
            },
            this.tDurSec,
            this.dwellSec,
          );
          this.slideStart = performance.now();
        })();
      }
    }
  }

  setDwell(sec: number) { this.dwellSec = Math.max(1, sec); }
  setTDur(sec: number)  { this.tDurSec  = Math.max(0.2, sec); }

  // ─── items / cache ────────────────────────────────────────────────────────

  private async releaseSlide(s: LoadedSlide) {
    const r = this.mesh.shader!.resources as any;
    if (r.uTexA === s.texture.source) r.uTexA = this.fallbackTex.source;
    if (r.uTexB === s.texture.source) r.uTexB = this.fallbackTex.source;
    try { await Assets.unload(s.url); } catch {}
    try { URL.revokeObjectURL(s.url); } catch {}
  }

  setItems(items: ImageEntry[]) {
    const r = this.mesh.shader!.resources as any;
    r.uTexA = this.fallbackTex.source;
    r.uTexB = this.fallbackTex.source;
    if (this.vintageScene) this.vintageScene.reset();

    const newSet = new Set(items);
    for (const [k, p] of this.cache) {
      if (!newSet.has(k)) {
        this.cache.delete(k);
        p.then(s => this.releaseSlide(s));
      }
    }
    this.items = items.slice();
    this.cursor = 0;
    this.failed.clear();
    this.preloadWindow();
    this.startSlide();
  }

  syncOrder(items: ImageEntry[], newCursor: number) {
    this.items = items.slice();
    this.cursor = Math.max(0, Math.min(items.length - 1, newCursor));
    this.preloadWindow();
    this.onSlideChange?.(this.cursor);
  }

  setPlaying(p: boolean) {
    const wasPlaying = this.playing;
    if (p === wasPlaying) return;
    this.playing = p;

    if (p) {
      // Resume: shift every animation timestamp forward by the paused duration,
      // then restart the ticker. Drift, camera, dwell — none of them notice
      // that time was suspended.
      if (this.pauseStartedAt > 0) {
        const delta = performance.now() - this.pauseStartedAt;
        this.shiftAllTimestamps(delta);
        this.pauseStartedAt = 0;
      }
      this.app.ticker.start();
      void this.wakeLock.acquire();
    } else {
      // Pause: stop the ticker entirely so the renderer does no work.
      // Note slideStart already reflects the just-completed pause window,
      // so when we resume we just shift it (see above).
      this.pauseStartedAt = performance.now();
      this.app.ticker.stop();
      void this.wakeLock.release();
    }
    this.onPlayingChange?.(p);
  }
  togglePlay() { this.setPlaying(!this.playing); }

  /** Shift all animation timestamps to compensate for pause duration. */
  private shiftAllTimestamps(deltaMs: number) {
    this.slideStart += deltaMs;
    this.transStart += deltaMs;
    this.vintageScene?.shiftTime(deltaMs);
  }

  /** One-shot render — used when paused and we need to display a new state. */
  private renderOnce() {
    this.app.renderer.render({ container: this.app.stage });
  }

  /**
   * Called from tick when a transition finishes. If navigation happened
   * while paused, we resumed the ticker just to animate the transition —
   * now that it's done, render one final frame and stop the ticker again.
   */
  private maybeRePauseAfterTransition() {
    if (!this.restartPauseAfterTransition) return;
    this.restartPauseAfterTransition = false;
    // Render the settled frame, then stop. Re-pausing the clock isn't needed
    // (pauseStartedAt was kept fresh in navigateTo).
    this.renderOnce();
    this.app.ticker.stop();
  }

  next() { this.advance(+1); }
  prev() { this.advance(-1); }
  jump(index: number) {
    if (index < 0 || index >= this.items.length) return;
    if (index === this.cursor) return;
    this.navigateTo(index);
  }
  getCursor() { return this.cursor; }

  shuffle() {
    if (this.items.length <= 1) return;
    const current = this.items[this.cursor];
    const rest = this.items.filter((_, i) => i !== this.cursor);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    this.items = [current, ...rest];
    this.cursor = 0;
    this.preloadWindow();
    this.onSlideChange?.(0);
    return this.items.slice();
  }

  private advance(dir: 1 | -1) {
    if (this.items.length === 0 || this.inTransition) return;
    const next = this.findLoadable(this.cursor, dir);
    if (next === null) {
      this.setPlaying(false);
      console.error('[slideshow] no loadable items in folder');
      return;
    }
    this.navigateTo(next);
  }

  /**
   * Start a transition to `index`. If the slideshow is paused we briefly
   * resume the ticker so the transition can animate, then re-pause once it
   * completes (handled in the tick loop via `restartPauseAfterTransition`).
   */
  private navigateTo(index: number) {
    if (!this.playing) {
      this.restartPauseAfterTransition = true;
      // Resume ticker without changing the `playing` flag — that flag controls
      // dwell-based auto-advance, which we don't want while "paused".
      if (this.pauseStartedAt > 0) {
        const delta = performance.now() - this.pauseStartedAt;
        this.shiftAllTimestamps(delta);
        this.pauseStartedAt = performance.now(); // freeze the clock again right away
      }
      this.app.ticker.start();
    }
    this.beginTransition(index).catch(() => {});
  }

  private preloadWindow() {
    if (this.items.length === 0) return;
    const keep = new Set<ImageEntry>();
    // Scene mode looks 3 BACK for the bg pile; shader mode only 1 back.
    const backN = this.currentTransition.kind === 'scene' ? 3 : 1;
    for (let d = -backN; d <= 3; d++) {
      const idx = (this.cursor + d + this.items.length) % this.items.length;
      const entry = this.items[idx];
      if (this.failed.has(entry)) continue;     // skip permanently-bad files
      keep.add(entry);
      this.loadSlide(entry).catch(() => {});    // failures already tracked
    }
    // Anything the scene currently has on screen MUST stay — evicting it
    // nulls a Texture source the GPU is about to sample → render crash.
    if (this.vintageScene) {
      for (const e of this.vintageScene.heldEntries()) keep.add(e);
    }
    if (this.cache.size > this.maxCache) {
      for (const [k, p] of this.cache) {
        if (!keep.has(k)) {
          this.cache.delete(k);
          p.then(s => this.releaseSlide(s));
          if (this.cache.size <= this.maxCache) break;
        }
      }
    }
  }

  /**
   * Resolve up to N previous slides for the vintage bg pile.
   *
   * Tolerant: skips entries already known to be failed, and skips per-entry
   * load rejections (the entry gets added to `this.failed` by loadSlide on
   * its way out). Walks back through the items as far as needed to gather
   * up to N loadable history slides; returns however many it managed to
   * load, even if fewer than N (the scene just shows fewer bg cards).
   */
  private async historySlides(n: number): Promise<LoadedSlide[]> {
    const out: LoadedSlide[] = [];
    const tried = new Set<ImageEntry>();
    for (let d = 1; d < this.items.length && out.length < n; d++) {
      const idx = (this.cursor - d + this.items.length) % this.items.length;
      const entry = this.items[idx];
      if (!entry || tried.has(entry) || this.failed.has(entry)) continue;
      tried.add(entry);
      try { out.push(await this.loadSlide(entry)); }
      catch { /* logged + added to failed by loadSlide */ }
    }
    return out;
  }

  private loadSlide(entry: ImageEntry): Promise<LoadedSlide> {
    if (this.failed.has(entry)) {
      return Promise.reject(new Error(`previously failed: ${entry.path}`));
    }
    if (this.cache.has(entry)) return this.cache.get(entry)!;
    const p = (async (): Promise<LoadedSlide> => {
      try {
        const file = await entry.getFile();
        // RAW / TIFF → embedded JPEG preview; everything else → raw File.
        // null means "no extractable preview and the browser can't decode it"
        // (e.g. a RAW with corrupt EXIF) — give up early instead of trying
        // an upload that will only fail downstream.
        const blob = await getImageBlob(file);
        if (!blob) throw new Error(`no preview extractable for ${entry.path}`);
        const url = URL.createObjectURL(blob);
        const texture = await Assets.load<Texture>({ src: url, parser: 'loadTextures' });
        const aspect = texture.width / Math.max(1, texture.height);
        const screen = this.app.renderer.screen;
        const screenAspect = screen.width / Math.max(1, screen.height);
        return {
          entry, texture, url,
          panZoom: randPanZoom(aspect, screenAspect),
          fadeMag: randInRange(0.08, 0.14),
        };
      } catch (err) {
        // Permanently mark this entry as bad so we don't loop on it.
        this.failed.add(entry);
        this.cache.delete(entry);
        console.warn('[slideshow] failed to load (skipping):', entry.path, err);
        throw err;
      }
    })();
    this.cache.set(entry, p);
    p.catch(() => {});
    return p;
  }

  /**
   * Find the next/previous loadable item starting from `from`. Returns the
   * index, or null if every item is failed.
   */
  private findLoadable(from: number, dir: 1 | -1): number | null {
    const n = this.items.length;
    if (n === 0) return null;
    for (let step = 1; step <= n; step++) {
      const idx = ((from + dir * step) % n + n) % n;
      if (!this.failed.has(this.items[idx])) return idx;
    }
    return null;
  }

  // ─── slide lifecycle ──────────────────────────────────────────────────────

  private async startSlide(): Promise<void> {
    if (this.items.length === 0) return;
    // Skip past a failed cursor (e.g. first item is corrupt)
    if (this.failed.has(this.items[this.cursor])) {
      const next = this.findLoadable(this.cursor, 1);
      if (next === null) { this.setPlaying(false); return; }
      this.cursor = next;
    }
    const entry = this.items[this.cursor];
    let slide: LoadedSlide;
    try { slide = await this.loadSlide(entry); }
    catch {
      // Newly-failed: bump cursor and try again
      const next = this.findLoadable(this.cursor, 1);
      if (next === null) { this.setPlaying(false); return; }
      this.cursor = next;
      return this.startSlide();
    }
    if (this.items[this.cursor] !== entry) return;

    if (this.currentTransition.kind === 'shader') {
      this.bindA(slide);
      this.bindB(slide);
      this.uniforms.uniforms.uProgress = 0;
      this.uniforms.uniforms.uDwellA = 0;
    } else {
      const history = await this.historySlides(3);
      if (this.items[this.cursor] !== entry) return; // changed mid-await
      this.ensureVintageScene().addPhoto(
        {
          focal: { texture: slide.texture, entry: slide.entry },
          history: history.map(s => ({ texture: s.texture, entry: s.entry })),
        },
        this.tDurSec,
        this.dwellSec,
      );
    }
    this.slideStart = performance.now();
    this.inTransition = false;
    this.onSlideChange?.(this.cursor);
    this.preloadWindow();
  }

  private bindA(slide: LoadedSlide) {
    const r = this.mesh.shader!.resources as any;
    r.uTexA = slide.texture.source;
    this.uniforms.uniforms.uAspectA =
      slide.texture.source.pixelWidth / Math.max(1, slide.texture.source.pixelHeight);
    const pz = slide.panZoom;
    (this.uniforms.uniforms.uPanZoomA as Float32Array).set([pz.pan0[0], pz.pan0[1], pz.pan1[0], pz.pan1[1]]);
    (this.uniforms.uniforms.uZoomA as Float32Array).set([pz.z0, pz.z1]);
    (this.uniforms.uniforms.uFadeMag as Float32Array)[0] = slide.fadeMag;
  }

  private bindB(slide: LoadedSlide) {
    const r = this.mesh.shader!.resources as any;
    r.uTexB = slide.texture.source;
    this.uniforms.uniforms.uAspectB =
      slide.texture.source.pixelWidth / Math.max(1, slide.texture.source.pixelHeight);
    const pz = slide.panZoom;
    (this.uniforms.uniforms.uPanZoomB as Float32Array).set([pz.pan0[0], pz.pan0[1], pz.pan1[0], pz.pan1[1]]);
    (this.uniforms.uniforms.uZoomB as Float32Array).set([pz.z0, pz.z1]);
    (this.uniforms.uniforms.uFadeMag as Float32Array)[1] = slide.fadeMag;
  }

  private async beginTransition(toIndex: number): Promise<void> {
    const entry = this.items[toIndex];
    let incoming: LoadedSlide;
    try { incoming = await this.loadSlide(entry); }
    catch {
      // Newly-discovered bad file. Jump past it.
      const skipTo = this.findLoadable(toIndex, 1);
      if (skipTo === null) { this.setPlaying(false); return; }
      // Avoid infinite recursion on weird circular failure
      if (skipTo === toIndex) return;
      return this.beginTransition(skipTo);
    }
    if (this.items[toIndex] !== entry) return;

    if (this.currentTransition.kind === 'shader') {
      this.bindB(incoming);
      this.uniforms.uniforms.uDwellB = 0;
    } else {
      // Set cursor BEFORE history lookup so historySlides() walks back from
      // the incoming slide, not the outgoing one.
      this.cursor = toIndex;
      const history = await this.historySlides(3);
      if (this.items[toIndex] !== entry) return;
      this.ensureVintageScene().addPhoto(
        {
          focal: { texture: incoming.texture, entry: incoming.entry },
          history: history.map(s => ({ texture: s.texture, entry: s.entry })),
        },
        this.tDurSec,
        this.dwellSec,
      );
    }
    this.transStart = performance.now();
    this.inTransition = true;
    if (this.currentTransition.kind === 'shader') this.cursor = toIndex;
    this.preloadWindow();
    this.onSlideChange?.(this.cursor);
  }

  // ─── per-frame ────────────────────────────────────────────────────────────

  private tick() {
    const now = performance.now();
    this.uniforms.uniforms.uTime = now / 1000;
    if (this.items.length === 0) return;

    if (this.currentTransition.kind === 'scene') {
      this.vintageScene?.tick();
      // Settle inTransition once the addPhoto animation has finished
      if (this.inTransition && now - this.transStart >= this.tDurSec * 1000) {
        this.inTransition = false;
        this.slideStart = now;
        this.maybeRePauseAfterTransition();
      }
      if (!this.inTransition && this.playing) {
        if ((now - this.slideStart) / 1000 >= this.dwellSec) {
          const next = this.findLoadable(this.cursor, 1);
          if (next === null) { this.setPlaying(false); return; }
          // Fire-and-forget; rejections are already logged inside.
          this.beginTransition(next).catch(() => {});
        }
      }
      return;
    }

    // Shader mode
    if (this.inTransition) {
      const t = Math.min(1, (now - this.transStart) / (this.tDurSec * 1000));
      this.uniforms.uniforms.uProgress = t;

      const dwellA = (now - this.slideStart) / (this.dwellSec * 1000);
      this.uniforms.uniforms.uDwellA = Math.min(1.25, dwellA);
      this.uniforms.uniforms.uDwellB = t * (this.tDurSec / this.dwellSec);

      if (t >= 1) {
        const r = this.mesh.shader!.resources as any;
        r.uTexA = r.uTexB;
        this.uniforms.uniforms.uAspectA = this.uniforms.uniforms.uAspectB;
        (this.uniforms.uniforms.uPanZoomA as Float32Array).set(this.uniforms.uniforms.uPanZoomB as Float32Array);
        (this.uniforms.uniforms.uZoomA as Float32Array).set(this.uniforms.uniforms.uZoomB as Float32Array);
        const fm = this.uniforms.uniforms.uFadeMag as Float32Array;
        fm[0] = fm[1];
        this.uniforms.uniforms.uProgress = 0;
        const newDwellA = this.uniforms.uniforms.uDwellB as number;
        this.uniforms.uniforms.uDwellA = newDwellA;
        this.slideStart = now - newDwellA * this.dwellSec * 1000;
        this.inTransition = false;
        this.maybeRePauseAfterTransition();
      }
    } else if (this.playing) {
      const elapsed = (now - this.slideStart) / 1000;
      this.uniforms.uniforms.uDwellA = Math.min(1.0, elapsed / this.dwellSec);
      if (elapsed >= this.dwellSec) {
        const next = this.findLoadable(this.cursor, 1);
        if (next === null) { this.setPlaying(false); return; }
        this.beginTransition(next).catch(() => {});
      }
    }
  }

  destroy() {
    this.app?.destroy(true, { children: true, texture: true });
  }
}
