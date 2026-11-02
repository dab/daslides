import {
  Application,
  ImageSource,
  Mesh,
  MeshGeometry,
  Shader,
  Texture,
  UniformGroup,
  type TextureSource,
} from 'pixi.js';
import { TRANSITIONS, type TransitionDef, type TransitionId } from './transitions/index.ts';
import { VERTEX } from './transitions/shared.ts';
import { VintageScene } from './scenes/vintageScene.ts';
import { createWakeLock, type WakeLockHandle } from './wakeLock.ts';
import { decodeToBitmap, getImageBlob } from './imageLoader.ts';
import { clamp, rndRange as randInRange } from './util.ts';
import { perfFrame, perfMark, perfStats, perfTransition } from './perf.ts';
import type { ImageEntry } from './folder.ts';

interface LoadedSlide {
  entry: ImageEntry;
  texture: Texture;
  /** Intrinsic aspect, kept so keyframes can be regenerated on resize. */
  imgAspect: number;
  /**
   * The decoded bitmap backing `texture`. We own it: Pixi's
   * `TextureSource.destroy()` nulls `resource` but never calls `close()`, so
   * releaseSlide has to.
   */
  bitmap: ImageBitmap;
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
  /** One Shader per shader transition, built on first use. */
  private shaderCache = new Map<TransitionId, Shader>();

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
   * Cache budget: the cursor window (5) plus the Vintage pile (a focal card
   * plus 3-5 background cards, which can overlap the window). 14 leaves
   * headroom without unbounded growth on libraries of thousands of photos.
   */
  private maxCache = 14;
  /**
   * Byte ceiling for resident slide textures (~384 MB). Entries in the preload
   * window are exempt — see preloadWindow().
   */
  private maxTextureBytes = 384 * 1024 * 1024;
  private residentBytes = 0;
  /** Byte cost per cached entry, so eviction can settle the total up front. */
  private slideBytes = new Map<ImageEntry, number>();
  private cursor = 0;

  private playing = false;
  private inTransition = false;
  /** Set while beginTransition is between its first await and settling. */
  private transitionPending = false;
  /** Latch so the "nothing loads" message is reported once per folder. */
  private gaveUp = false;
  /** Latch for the one-time canvas fade-in. */
  private revealed = false;
  /** Decoded-but-not-yet-uploaded texture sources; see queueUpload(). */
  private uploadQueue: TextureSource[] = [];
  private uploadRaf = 0;
  private navToken = 0;
  private dwellSec = 10;
  private tDurSec = 1.5;
  /** Holds the display awake while playback runs. */
  private wakeLock: WakeLockHandle = createWakeLock();

  /**
   * Pausable animation clock. All animation timestamps (slideStart, transStart,
   * and the vintage scene's card birth/fade times) live in *clock* time, not
   * raw performance.now(). The clock advances only while not paused, so pausing
   * is simply "stop the clock" and resuming is "keep going" — no timestamp
   * patching, no drift. `clock()` reads it; `freezeClock()` / `unfreezeClock()`
   * toggle it.
   */
  private pausedAccum = 0;     // total ms the clock has spent frozen
  private pauseMark = 0;       // performance.now() at freeze; 0 while running
  private slideStart = 0;      // clock time the current slide began
  private transStart = 0;      // clock time the current transition began
  /**
   * Timer that advances to the next slide during a *static* dwell (Fade with
   * Zoom shows a pixel-identical frame for the whole dwell, so we stop the
   * renderer and wake only to start the next transition). 0 = none pending.
   */
  private dwellTimer = 0;

  onSlideChange?: (index: number) => void;
  onPlayingChange?: (playing: boolean) => void;
  /** Every item in the folder failed to decode — nothing can be shown. */
  onAllFailed?: () => void;

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
      // Pixi re-uploads every texture on the next bind by itself; the only gap
      // is that nothing asks for a frame. With the ticker stopped — a static
      // dwell, or paused — the canvas would stay blank until the next
      // transition, which for a slideshow left running on a tablet could be
      // forever.
      console.info('[slideshow] WebGL context restored');
      this.sync();
    });

    // Uncap the ticker so it runs at the display's native refresh rate
    // (60 / 90 / 100 / 120 / 144 Hz …). All animations use performance.now()
    // for time deltas, so motion stays the same speed regardless of fps.
    this.app.ticker.maxFPS = 0;
    this.app.ticker.minFPS = 1;

    this.buildMesh();
    this.setTransition('fadeZoom');

    this.app.ticker.add(() => this.tick());
    // Single source of truth for sizing — Pixi's renderer emits 'resize' after
    // it has updated `screen`, so we never read stale dimensions (the old
    // window listener could fire before Pixi reflowed).
    this.app.renderer.on('resize', () => this.handleResize());

    // Dev-only overlay; a no-op unless the URL has ?perf=1.
    perfStats(() => {
      const caps = this.textureCaps();
      return {
        slides: `${this.cache.size} resident, ${this.uploadQueue.length} queued upload`,
        texmem: `${(this.residentBytes / 1048576).toFixed(1)} MB / `
              + `${(this.maxTextureBytes / 1048576).toFixed(0)} MB`,
        screen: `${this.app.renderer.screen.width}x${this.app.renderer.screen.height}`
              + ` @${this.app.renderer.resolution}x -> cap ${caps.capW}x${caps.capH}`,
        mode: `${this.currentTransition.id}  dwell ${this.dwellSec}s  fade ${this.tDurSec}s`,
      };
    });

    // Nothing loaded yet — settle into the idle state (ticker stopped, one
    // frame on screen) instead of rendering an empty canvas every vsync.
    this.sync();
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
      uPanZoomA: { value: new Float32Array([0, 0, 0, 0]), type: 'vec4<f32>' },
      uPanZoomB: { value: new Float32Array([0, 0, 0, 0]), type: 'vec4<f32>' },
      uZoomA: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
      uZoomB: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
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
    // Ken-Burns keyframes are generated against the screen aspect at LOAD time
    // and cached on the slide, so after a resize or orientation change every
    // cached slide carries keyframes for the old aspect. For a portrait photo
    // the vertical regime bakes an aspect-dependent zoom (heightFactor x
    // scale.y), so stale keyframes mis-size its blurred side bars. Landscape
    // keyframes (1.0 .. tightZ) are aspect-independent and unaffected.
    //
    // The currently-bound slide keeps its old keyframes for the rest of its
    // dwell — rebinding mid-motion would snap the framing. It is re-bound on
    // the next transition.
    const screenAspect = w / Math.max(1, h);
    for (const p of this.cache.values()) {
      p.then(sl => { sl.panZoom = randPanZoom(sl.imgAspect, screenAspect); }).catch(() => {});
    }
    this.vintageScene?.resize(w, h);
    if (this.vintageScene?.needsReseed && this.currentTransition.kind === 'scene') {
      this.vintageScene.needsReseed = false;
      this.reseedScene();
    }
    // When the ticker is stopped (paused / static dwell) nothing would redraw
    // the resized frame — paint it once so the canvas tracks the window.
    if (!this.app.ticker.started) this.renderOnce();
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
    if (!this.app) return; // not initialized yet — main re-applies after init
    const def = TRANSITIONS[id];
    this.currentTransition = def;
    this.inTransition = false;
    const myToken = ++this.navToken;

    if (def.kind === 'shader') {
      // Cache per transition: setTransition used to build a fresh Shader every
      // switch and never destroy the old one. The GLSL program itself is cached
      // by Pixi, but the discarded Shader/bind-group objects leaked and the
      // per-program uniform-location value cache reset, forcing a full uniform
      // re-upload on the first frame after each switch.
      let newShader = this.shaderCache.get(id);
      if (!newShader) {
        newShader = this.makeShader(def.fragment);
        this.shaderCache.set(id, newShader);
      }
      const oldRes = this.mesh.shader!.resources as any;
      const newRes = newShader.resources as any;
      if (oldRes.uTexA) newRes.uTexA = oldRes.uTexA;
      if (oldRes.uTexB) newRes.uTexB = oldRes.uTexB;
      (this.mesh as any).shader = newShader;

      this.mesh.visible = true;
      if (this.vintageScene) {
        this.vintageScene.root.visible = false;
        this.vintageScene.reset();
      }

      // Re-bind the current slide. Coming back from Vintage (scene) mode the
      // mesh samplers may have been evicted to white, so without this we'd
      // flash a blank/stale frame until the next auto-advance.
      const entry = this.items[this.cursor];
      if (entry) {
        this.loadSlide(entry).then(slide => {
          if (this.navToken !== myToken) return;
          this.bind('A', slide);
          this.bind('B', slide);
          this.uniforms.uniforms.uProgress = 0;
          this.uniforms.uniforms.uDwellA = 0;
          this.slideStart = this.clock();
          this.sync();
          this.reveal();
        }).catch(() => {});
      }
    } else {
      // scene
      const scene = this.ensureVintageScene();
      scene.root.visible = true;
      scene.reset();
      this.mesh.visible = false;
      this.reseedScene();
    }
    this.sync();
  }

  private reseedScene() {
    const entry = this.items[this.cursor];
    if (!entry) return;
    const myToken = ++this.navToken;
    (async () => {
      const focal = await this.loadSlide(entry);
      if (this.navToken !== myToken) return;
      const history = await this.historySlides(this.ensureVintageScene().bgSlots());
      if (this.navToken !== myToken) return;
      // Seeding, not transitioning: show the pile at once. A fade here would
      // never run if we are paused (the clock is frozen, so tick() can't raise
      // the alpha) and the screen would stay black.
      this.ensureVintageScene().addPhoto(
        {
          focal: { texture: focal.texture, entry: focal.entry },
          history: history.map(s => ({ texture: s.texture, entry: s.entry })),
        },
        this.tDurSec,
        this.dwellSec,
        this.clock(),
        true,
      );
      this.slideStart = this.clock();
      this.sync();
      this.reveal();
    })();
  }

  // Bounds match the min/max advertised on #dwell and #tdur, so the UI and the
  // engine can't disagree about what is in effect.
  setDwell(sec: number) { this.setTiming(clamp(sec, 2, 60), this.tDurSec); }
  setTDur(sec: number)  { this.setTiming(this.dwellSec, clamp(sec, 0.5, 10)); }

  /**
   * Change dwell / fade duration while preserving the current slide's motion
   * progress. `spanMs` is the denominator of the Ken-Burns parameterization, so
   * naively changing dwell 10 -> 30 would collapse `uDwellA` by 3x and jump the
   * zoom backwards. Read the fraction against the OLD span, then re-anchor
   * `slideStart` against the NEW one.
   */
  private setTiming(dwell: number, tdur: number) {
    if (!this.app || this.items.length === 0) {
      this.dwellSec = dwell;
      this.tDurSec = tdur;
      return;
    }
    const now = this.clock();
    const frac = (now - this.slideStart) / this.spanMs;   // OLD span
    this.dwellSec = dwell;
    this.tDurSec = tdur;                                   // span changes here
    this.slideStart = now - frac * this.spanMs;            // NEW span
    this.sync();
  }

  // ─── items / cache ────────────────────────────────────────────────────────

  /**
   * Free a slide. Order matters: rebind the samplers FIRST, or the batcher can
   * dereference a destroyed source ("can't access property 'alphaMode'").
   *
   * Slide textures are engine-owned (not Assets-managed), so destroying them
   * directly is correct here — `Assets` is no longer involved at all.
   */
  private releaseSlide(s: LoadedSlide) {
    const r = this.mesh.shader!.resources as any;
    if (r.uTexA === s.texture.source) r.uTexA = this.fallbackTex.source;
    if (r.uTexB === s.texture.source) r.uTexB = this.fallbackTex.source;
    const q = this.uploadQueue.indexOf(s.texture.source);
    if (q >= 0) this.uploadQueue.splice(q, 1);
    try { s.texture.destroy(true); } catch {}
    try { s.bitmap.close(); } catch {}
  }

  setItems(items: ImageEntry[]) {
    const r = this.mesh.shader!.resources as any;
    r.uTexA = this.fallbackTex.source;
    r.uTexB = this.fallbackTex.source;
    this.inTransition = false;
    this.clearDwell();
    if (this.vintageScene) this.vintageScene.reset();

    const newSet = new Set(items);
    for (const [k, p] of this.cache) {
      if (!newSet.has(k)) this.evict(k, p);
    }
    this.items = items.slice();
    this.cursor = 0;
    this.failed.clear();
    this.gaveUp = false;
    this.preloadWindow();
    this.startSlide();
  }

  setPlaying(p: boolean) {
    if (!this.app) return;
    if (p === this.playing) return;
    this.playing = p;
    if (p) void this.wakeLock.acquire();
    else void this.wakeLock.release();
    this.sync();
    this.onPlayingChange?.(p);
  }
  togglePlay() { this.setPlaying(!this.playing); }

  // ─── clock + run-state ──────────────────────────────────────────────────────

  /** Current animation-clock time (ms). Frozen while paused. */
  private clock(): number {
    return (this.pauseMark || performance.now()) - this.pausedAccum;
  }
  private freezeClock() {
    if (!this.pauseMark) this.pauseMark = performance.now();
  }
  private unfreezeClock() {
    if (this.pauseMark) {
      this.pausedAccum += performance.now() - this.pauseMark;
      this.pauseMark = 0;
    }
  }

  /**
   * A slide's full visible life, in ms: its incoming transition, its dwell, and
   * its outgoing transition. `slideStart` marks the beginning of that window
   * (== the incoming transition's `transStart`), so per-slide Ken-Burns motion
   * normalized over `spanMs` runs at ONE constant rate from keyframe to
   * keyframe with no dead window and no clamping mid-playback.
   *
   * Normalizing over `dwellSec` alone — as this used to — left the motion
   * pinned at its end keyframe for the last `tDurSec` of every slide, then
   * extrapolated past it during the transition (which drove zoom below 1.0 and
   * exposed blurred bars on landscape photos). Don't reintroduce that.
   */
  private get spanMs(): number {
    return (this.dwellSec + 2 * this.tDurSec) * 1000;
  }

  /** True for transitions that animate continuously *during* the dwell. */
  private get continuousMotion(): boolean {
    const def = this.currentTransition;
    return def.kind === 'scene' || (def.kind === 'shader' && def.kenBurns);
  }

  /**
   * Reconcile renderer + clock + dwell-timer with the current state. The one
   * place that decides whether we render every frame, run a static dwell, or
   * sit fully paused:
   *
   *   - transition in flight, or playing with continuous motion → render every
   *     frame (ticker on, clock running).
   *   - playing but the frame is static (Fade with Zoom mid-dwell) → stop the
   *     renderer, keep the clock running, and arm a timer for the next slide.
   *   - paused → freeze the clock, stop the renderer, hold the last frame.
   */
  private sync() {
    this.clearDwell();
    const animate = this.inTransition || (this.playing && this.continuousMotion);

    if (animate) {
      this.unfreezeClock();
      if (!this.app.ticker.started) this.app.ticker.start();
      return;
    }

    if (this.app.ticker.started) this.app.ticker.stop();

    if (this.playing) {
      this.unfreezeClock();
      this.scheduleDwell();
    } else {
      this.freezeClock();
    }
    this.renderOnce();
  }

  /** Arm the static-dwell timer to advance after the remaining dwell elapses. */
  private scheduleDwell() {
    if (this.items.length === 0) return;
    const elapsed = (this.clock() - this.slideStart) / 1000;
    const remaining = Math.max(0, this.dwellSec + this.tDurSec - elapsed) * 1000;
    this.dwellTimer = window.setTimeout(() => {
      this.dwellTimer = 0;
      if (!this.playing) return;
      const next = this.findLoadable(this.cursor, 1);
      if (next === null) { this.giveUp(); return; }
      this.beginTransition(next).catch(() => {});
    }, remaining);
  }
  private clearDwell() {
    if (this.dwellTimer) { clearTimeout(this.dwellTimer); this.dwellTimer = 0; }
  }

  /** One-shot render — used whenever the ticker is stopped but state changed. */
  /** Nothing in the folder can be decoded. Stop, and say so once. */
  private giveUp() {
    this.setPlaying(false);
    if (this.gaveUp) return;
    this.gaveUp = true;
    console.error('[slideshow] no loadable items in folder');
    this.onAllFailed?.();
  }

  private renderOnce() {
    this.app.renderer.render({ container: this.app.stage });
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
    if (next === null) { this.giveUp(); return; }
    this.navigateTo(next);
  }

  /**
   * Start a transition to `index`. Works the same paused or playing:
   * `beginTransition` sets `inTransition` and calls `sync()`, which starts the
   * ticker (and unfreezes the clock) for the duration of the animation; when
   * the transition settles, `sync()` returns us to the prior paused/static
   * state automatically.
   */
  private navigateTo(index: number) {
    this.beginTransition(index).catch(() => {});
  }

  private preloadWindow() {
    if (this.items.length === 0) return;
    const keep = new Set<ImageEntry>();
    // Urgency order, not index order: the current slide first, then forward
    // (the next transition needs +1), then the backward history only the
    // vintage pile uses. Every one of these competes for the same decode
    // budget, so on a cold folder the order decides whether +1 is ready when
    // the dwell expires. Scene mode looks 3 back for the bg pile; shader mode
    // only 1 back.
    const offsets = this.currentTransition.kind === 'scene'
      ? [0, 1, 2, 3, -1, -2, -3]
      : [0, 1, 2, 3, -1];
    for (const d of offsets) {
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
    // Evict on BOTH a slide count and a byte budget. The count alone is not a
    // memory bound: on a high-DPI display the resolution cap barely bites, so 14
    // resident slides could still reach ~1.3 GB. `keep` always wins — the
    // working set is needed — so on a big screen this bounds the cache to the
    // preload window instead of to 14.
    const over = () =>
      this.cache.size > this.maxCache || this.residentBytes > this.maxTextureBytes;
    if (over()) {
      for (const [k, p] of this.cache) {
        if (keep.has(k)) continue;
        this.evict(k, p);
        if (!over()) break;
      }
    }
  }

  /**
   * Drop an entry from the cache and free its texture once it resolves.
   *
   * Byte accounting is settled synchronously here rather than in releaseSlide,
   * which runs a microtask later — otherwise `residentBytes` would lag the
   * eviction loop and it would over-evict in a single pass.
   */
  private evict(entry: ImageEntry, p: Promise<LoadedSlide>) {
    this.cache.delete(entry);
    this.residentBytes -= this.slideBytes.get(entry) ?? 0;
    this.slideBytes.delete(entry);
    p.then(s => this.releaseSlide(s)).catch(() => {});
  }

  /** RGBA8 plus the ~1/3 a full mip chain adds. */
  private static sourceBytes(src: TextureSource): number {
    return Math.round((src.pixelWidth * src.pixelHeight * 4 * 4) / 3);
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
    let d = 1;
    while (out.length < n && d < this.items.length) {
      // Collect the next batch of untried, non-failed candidates in recency
      // order, then load them CONCURRENTLY. This used to await each load in
      // turn, so a cold pile cost the sum of three decodes — easily longer than
      // the fade it was supposed to be starting.
      const batch: ImageEntry[] = [];
      while (batch.length < n - out.length && d < this.items.length) {
        const idx = (this.cursor - d + this.items.length) % this.items.length;
        d++;
        const entry = this.items[idx];
        if (!entry || tried.has(entry) || this.failed.has(entry)) continue;
        tried.add(entry);
        batch.push(entry);
      }
      if (batch.length === 0) break;
      // allSettled preserves order, so recency survives; rejections are already
      // logged and recorded in `failed` by loadSlide.
      for (const res of await Promise.allSettled(batch.map(e => this.loadSlide(e)))) {
        if (res.status === 'fulfilled') out.push(res.value);
      }
    }
    return out;
  }

  /**
   * Per-axis device-pixel cap for a slide texture.
   *
   * `renderer.screen` is in CSS pixels, so device pixels are `screen x
   * resolution`. The MAX_TEXTURE_SIZE clamp is not an optimisation — Pixi does
   * not validate against it, so a 6000 px photo on a device reporting 4096
   * (plenty of older iPads and mid-range Android) made texImage2D raise
   * INVALID_VALUE and render a black slide, with no exception to explain it.
   */
  private textureCaps(): { capW: number; capH: number } {
    const screen = this.app.renderer.screen;
    const res = this.app.renderer.resolution;
    const gl = (this.app.renderer as any).gl as WebGL2RenderingContext | undefined;
    const hw = (gl && (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number)) || 4096;
    let w = Math.ceil(screen.width * res);
    let h = Math.ceil(screen.height * res);
    // Degenerate layout (startup, hidden container): fall back to something
    // generous rather than baking a tiny texture we can never re-sharpen. Don't
    // use a per-axis floor here — that would inflate the cap on short viewports
    // (a 1280x720 screen would ask for 1024 tall) and waste memory.
    if (w < 64 || h < 64) { w = 1920; h = 1080; }
    return { capW: Math.min(w, hw), capH: Math.min(h, hw) };
  }

  /**
   * Upload at most ONE texture per animation frame, and never on a transition
   * frame.
   *
   * preloadWindow starts 5-7 loads at once, so without this their continuations
   * land in a single microtask drain and run several multi-megabyte texImage2D
   * calls back to back — one long dropped frame. Draining on our own rAF (rather
   * than from tick()) keeps it to one code path that works whether the Pixi
   * ticker is running or stopped, and keeps the upload out of the render pass.
   */
  private queueUpload(source: TextureSource) {
    this.uploadQueue.push(source);
    if (!this.uploadRaf) this.scheduleUpload();
  }

  private scheduleUpload() {
    this.uploadRaf = requestAnimationFrame(() => {
      this.uploadRaf = 0;
      if (!this.inTransition) {
        let source = this.uploadQueue.shift();
        while (source && source.destroyed) source = this.uploadQueue.shift();
        if (source) {
          const t0 = performance.now();
          this.app.renderer.texture.initSource(source);
          perfMark('upload', performance.now() - t0,
            `${source.pixelWidth}x${source.pixelHeight}`);
        }
      }
      if (this.uploadQueue.length) this.scheduleUpload();
    });
  }

  private loadSlide(entry: ImageEntry): Promise<LoadedSlide> {
    if (this.failed.has(entry)) {
      return Promise.reject(new Error(`previously failed: ${entry.path}`));
    }
    if (this.cache.has(entry)) return this.cache.get(entry)!;
    const p = (async (): Promise<LoadedSlide> => {
      let bitmap: ImageBitmap | undefined;
      try {
        const file = await entry.getFile();
        const { blob, orientation } = await getImageBlob(file);
        if (!blob) throw new Error(`no usable preview in ${entry.path}`);
        const { capW, capH } = this.textureCaps();
        const t0 = performance.now();
        bitmap = await decodeToBitmap(blob, capW, capH, orientation);
        perfMark('decode', performance.now() - t0, `${bitmap.width}x${bitmap.height}`);
        const source = new ImageSource({
          resource: bitmap,
          // The bitmap is already premultiplied (decodeToBitmap asks for it),
          // so declare that rather than letting Pixi premultiply again on
          // upload — which would double-premultiply and force a driver-side
          // CPU pass over every pixel.
          alphaMode: 'premultiplied-alpha',
          // Sufficient on its own: GlTextureSystem._initSource derives
          // mipLevelCount itself (WebGL2 supports non-power-of-two mipmaps), and
          // the default scaleMode 'linear' already yields LINEAR_MIPMAP_LINEAR.
          // Do NOT also pass mipLevelCount — it is overwritten.
          autoGenerateMipmaps: true,
          label: entry.path,
        });
        // Must be set AFTER construction: ImageSource's constructor assigns
        // `autoGarbageCollect = true` unconditionally after super(), so passing
        // it in the options above would be silently ignored. The engine evicts
        // explicitly (releaseSlide), so Pixi's idle GC must not second-guess it
        // and silently discard a prewarmed upload.
        source.autoGarbageCollect = false;
        const texture = new Texture({ source });
        this.queueUpload(source);
        const bytes = Engine.sourceBytes(source);
        this.slideBytes.set(entry, bytes);
        this.residentBytes += bytes;

        const aspect = source.pixelWidth / Math.max(1, source.pixelHeight);
        const screen = this.app.renderer.screen;
        const screenAspect = screen.width / Math.max(1, screen.height);
        return {
          entry, texture, bitmap, imgAspect: aspect,
          panZoom: randPanZoom(aspect, screenAspect),
          fadeMag: randInRange(0.08, 0.14),
        };
      } catch (err) {
        bitmap?.close();
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
    const myToken = ++this.navToken;
    // Skip past a failed cursor (e.g. first item is corrupt)
    if (this.failed.has(this.items[this.cursor])) {
      const next = this.findLoadable(this.cursor, 1);
      if (next === null) { this.giveUp(); return; }
      this.cursor = next;
    }
    const entry = this.items[this.cursor];
    let slide: LoadedSlide;
    try { slide = await this.loadSlide(entry); }
    catch {
      // Newly-failed: bump cursor and try again
      const next = this.findLoadable(this.cursor, 1);
      if (next === null) { this.giveUp(); return; }
      this.cursor = next;
      return this.startSlide();
    }
    if (this.navToken !== myToken) return;

    if (this.currentTransition.kind === 'shader') {
      this.bind('A', slide);
      this.bind('B', slide);
      this.uniforms.uniforms.uProgress = 0;
      this.uniforms.uniforms.uDwellA = 0;
    } else {
      const history = await this.historySlides(this.ensureVintageScene().bgSlots());
      if (this.navToken !== myToken) return;
      // Same as reseedScene: this is a seed, so no fade.
      this.ensureVintageScene().addPhoto(
        {
          focal: { texture: slide.texture, entry: slide.entry },
          history: history.map(s => ({ texture: s.texture, entry: s.entry })),
        },
        this.tDurSec,
        this.dwellSec,
        this.clock(),
        true,
      );
    }
    this.slideStart = this.clock();
    this.inTransition = false;
    this.onSlideChange?.(this.cursor);
    this.preloadWindow();
    this.sync();
    this.reveal();
  }

  /**
   * Fade the canvas up the first time a slide is on it.
   *
   * Every slide but the first gets a crossfade; the first one was an instant
   * cut from black. Doing it in CSS keeps it out of the shader and the engine's
   * state — there is nothing to cross-fade *from* on the first frame.
   */
  private reveal() {
    if (this.revealed) return;
    this.revealed = true;
    this.app.canvas.classList.add('is-ready');
  }

  /** Bind a loaded slide to shader sampler A or B with its motion params. */
  private bind(which: 'A' | 'B', slide: LoadedSlide) {
    const r = this.mesh.shader!.resources as any;
    const u = this.uniforms.uniforms;
    const src = slide.texture.source;
    const aspect = src.pixelWidth / Math.max(1, src.pixelHeight);
    const pz = slide.panZoom;
    const panZoom = [pz.pan0[0], pz.pan0[1], pz.pan1[0], pz.pan1[1]];
    if (which === 'A') {
      r.uTexA = src;
      u.uAspectA = aspect;
      (u.uPanZoomA as Float32Array).set(panZoom);
      (u.uZoomA as Float32Array).set([pz.z0, pz.z1]);
      (u.uFadeMag as Float32Array)[0] = slide.fadeMag;
    } else {
      r.uTexB = src;
      u.uAspectB = aspect;
      (u.uPanZoomB as Float32Array).set(panZoom);
      (u.uZoomB as Float32Array).set([pz.z0, pz.z1]);
      (u.uFadeMag as Float32Array)[1] = slide.fadeMag;
    }
  }

  private async beginTransition(toIndex: number): Promise<void> {
    // `inTransition` only flips AFTER the await below, so without this guard
    // tick() re-enters every frame while a load is pending — on a cache miss
    // that is dozens of discarded navigations, each bumping navToken. Guarding
    // on `inTransition` too makes jump() during a crossfade a no-op, which
    // matches what advance() already does.
    if (this.transitionPending || this.inTransition) return;
    if (this.items.length === 0) return;
    this.transitionPending = true;
    try {
      const myToken = ++this.navToken;

      // Walk forward past newly-discovered bad files. A loop rather than
      // recursion so the re-entrancy guard above doesn't block the retry.
      let index = toIndex;
      let incoming: LoadedSlide | undefined;
      for (let step = 0; step < this.items.length; step++) {
        try { incoming = await this.loadSlide(this.items[index]); break; }
        catch {
          const skipTo = this.findLoadable(index, 1);
          if (skipTo === null) { this.giveUp(); return; }
          if (skipTo === index) return;
          index = skipTo;
        }
      }
      if (!incoming) { this.giveUp(); return; }
      if (this.navToken !== myToken) return;

      // Set cursor BEFORE the history lookup so historySlides() walks back from
      // the incoming slide, not the outgoing one.
      this.cursor = index;

      // Scene mode must resolve its background pile BEFORE the transition clock
      // starts. Previously transStart was stamped first and the pile was awaited
      // after, so addPhoto received a `now` already in the past: cards appeared
      // at non-zero alpha, and if the loads outlasted tDurSec they snapped
      // straight to full opacity — a hard cut with no fade at all.
      //
      // The re-entrancy guard above is what makes this safe: tick() keeps
      // seeing an expired dwell while we await here, and without it would start
      // a fresh transition every frame.
      let history: LoadedSlide[] = [];
      if (this.currentTransition.kind === 'scene') {
        history = await this.historySlides(this.ensureVintageScene().bgSlots());
        if (this.navToken !== myToken) return;
      }

      // Flip inTransition + sync() so the ticker runs (and the clock is
      // unfrozen) for the animation even if we're paused — sync() returns us to
      // the prior state once the transition ends.
      this.inTransition = true;
      perfTransition(true);
      this.sync();
      this.transStart = this.clock();

      if (this.currentTransition.kind === 'shader') {
        this.bind('B', incoming);
        this.uniforms.uniforms.uDwellB = 0;
      } else {
        this.ensureVintageScene().addPhoto(
          {
            focal: { texture: incoming.texture, entry: incoming.entry },
            history: history.map(s => ({ texture: s.texture, entry: s.entry })),
          },
          this.tDurSec,
          this.dwellSec,
          this.transStart,
        );
      }
      this.preloadWindow();
      this.onSlideChange?.(this.cursor);
    } finally {
      this.transitionPending = false;
    }
  }

  // ─── per-frame ────────────────────────────────────────────────────────────

  private tick() {
    perfFrame(performance.now());
    const now = this.clock();
    if (this.items.length === 0) return;

    if (this.currentTransition.kind === 'scene') {
      this.vintageScene?.tick(now);
      // Settle inTransition once the addPhoto animation has finished
      if (this.inTransition && now - this.transStart >= this.tDurSec * 1000) {
        this.inTransition = false;
        this.slideStart = now;
        perfTransition(false);
        this.sync();
      }
      if (!this.inTransition && this.playing) {
        if ((now - this.slideStart) / 1000 >= this.dwellSec) {
          const next = this.findLoadable(this.cursor, 1);
          if (next === null) { this.giveUp(); return; }
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

      this.uniforms.uniforms.uDwellA = Math.min(1, (now - this.slideStart) / this.spanMs);
      this.uniforms.uniforms.uDwellB = Math.min(1, (now - this.transStart) / this.spanMs);

      if (t >= 1) {
        const r = this.mesh.shader!.resources as any;
        r.uTexA = r.uTexB;
        this.uniforms.uniforms.uAspectA = this.uniforms.uniforms.uAspectB;
        (this.uniforms.uniforms.uPanZoomA as Float32Array).set(this.uniforms.uniforms.uPanZoomB as Float32Array);
        (this.uniforms.uniforms.uZoomA as Float32Array).set(this.uniforms.uniforms.uZoomB as Float32Array);
        const fm = this.uniforms.uniforms.uFadeMag as Float32Array;
        fm[0] = fm[1];
        this.uniforms.uniforms.uProgress = 0;
        // B becomes A. `slideStart` is *definitionally* the clock time this
        // slide's visible life began — which is exactly `transStart`. Assigning
        // it directly (rather than back-dating from `now`) keeps the dwell
        // parameterization continuous with zero frame-overshoot drift.
        this.uniforms.uniforms.uDwellA = this.uniforms.uniforms.uDwellB;
        this.slideStart = this.transStart;
        this.inTransition = false;
        perfTransition(false);
        this.sync();
      }
    } else if (this.playing) {
      const elapsed = (now - this.slideStart) / 1000;
      this.uniforms.uniforms.uDwellA = Math.min(1, (now - this.slideStart) / this.spanMs);
      if (elapsed >= this.dwellSec + this.tDurSec) {
        const next = this.findLoadable(this.cursor, 1);
        if (next === null) { this.giveUp(); return; }
        this.beginTransition(next).catch(() => {});
      }
    }
  }

  destroy() {
    if (this.uploadRaf) { cancelAnimationFrame(this.uploadRaf); this.uploadRaf = 0; }
    this.shaderCache.clear();
    this.uploadQueue.length = 0;
    this.app?.destroy(true, { children: true, texture: true });
  }
}
