import {
  Container,
  NineSliceSprite,
  Sprite,
  Texture,
} from 'pixi.js';
import type { ImageEntry } from '../folder.ts';
import { TAU, lerp, ease, rand, rndRange as rrange } from '../util.ts';

/**
 * Vintage Prints — pile-of-photos scene.
 *
 * Layout:
 *   slot 0  = FOCAL print, centered, photo sized to ~85% of short screen edge
 *   slot 1+ = BG prints, similar size, large random rotation, offset from
 *             center so several layered together fill the whole viewport.
 *             Z-ordered behind the focal.
 *
 * Lifecycle on addPhoto():
 *   - new focal card created at slot 0 with the incoming texture, fades in
 *   - new bg cards created at slots 1..N with textures from the recent history
 *     (the focal-that-just-was at slot 1, etc.), each at NEW randomized slot
 *     positions
 *   - every previously-living card simultaneously fades out IN PLACE
 *   - cards never animate their position; the only "motion" between cycles is
 *     a very slow continuous sine drift around each card's slot pose
 *
 * The drift is the only motion that runs while a card is alive — periods of
 * 30–60s, amplitudes of a few px / fractions of a degree, so it reads as
 * "alive" without being distracting.
 */

interface PrintCard {
  container: Container;
  entry: ImageEntry;

  /** Anchor pose — drift orbits around these. */
  baseX: number;
  baseY: number;
  baseAngle: number;
  baseScale: number;

  /** Independent drift phases & periods, randomized at construction. */
  driftPhaseX: number;
  driftPhaseY: number;
  driftPhaseR: number;
  driftPhaseS: number;
  driftPeriodX: number;
  driftPeriodY: number;
  driftPeriodR: number;
  driftPeriodS: number;
  driftAmpX: number;
  driftAmpY: number;
  driftAmpR: number;
  driftAmpS: number;

  /** Opacity tween. */
  fadeStart: number;
  fadeDur: number;
  fadeFrom: number;
  fadeTo: number;

  dying: boolean;
  /** When to remove (after fade-out completes). */
  destroyAtMs: number;

  birthTime: number;
}

interface SlotPose {
  x: number;
  y: number;
  angle: number;
  scale: number;
}

interface AddPhotoCtx {
  focal: { texture: Texture; entry: ImageEntry };
  /** Most-recent-first; up to 3 used. */
  history: { texture: Texture; entry: ImageEntry }[];
}

/** Camera (whole-pile) transform state. */
interface Camera {
  rotFrom: number;
  rotTo: number;
  scaleFrom: number;
  scaleTo: number;
  start: number;
  /** Total milliseconds the linear ramp spans. */
  dur: number;
}

/** Whole-pile camera zoom range. photoSize() budgets against CAM_SCALE_MAX. */
const CAM_SCALE_MIN = 1.00;
const CAM_SCALE_MAX = 1.22;

/**
 * Shared drop-shadow texture, nine-sliced onto every card.
 *
 * Previously each card blurred its own shadow rectangle and the whole card was
 * baked with cacheAsTexture(). That cost a power-of-two render target per card
 * (4096x2048 = 33 MB on a 2x display, up to eight at once) and then threw the
 * blur away: the cache is sized from local bounds, which do not include filter
 * padding, so the penumbra was clipped to a hard-edged band.
 *
 * A Gaussian blur of an axis-aligned rectangle decomposes exactly into nine
 * slices — the edges are one-dimensional profiles that are constant along their
 * length, and the corners are those profiles multiplied together — so one small
 * texture reproduces the shadow of any card size pixel-for-pixel. The card
 * border is driven by the viewport and the offset and blur are constants, so
 * every card wants the same shadow.
 */
const SHADOW_OFFSET = 6;    // card-space offset, down-right
const SHADOW_PAD = 30;      // room for the blur to fall off in
const SHADOW_BORDER = 48;   // nine-slice inset; must exceed SHADOW_PAD
const SHADOW_TEX = SHADOW_BORDER * 2 + 8;

let shadowTexture: Texture | null = null;

function getShadowTexture(): Texture {
  if (shadowTexture) return shadowTexture;
  const c = document.createElement('canvas');
  c.width = c.height = SHADOW_TEX;
  const g = c.getContext('2d')!;
  g.filter = 'blur(10px)';
  g.fillStyle = 'rgba(0,0,0,0.30)';
  const inner = SHADOW_TEX - SHADOW_PAD * 2;
  g.fillRect(SHADOW_PAD, SHADOW_PAD, inner, inner);
  // Punch the middle out. The paper covers it anyway, and leaving it solid
  // would darken the card while it crossfades — without the bake, each child
  // now blends with the background separately.
  g.filter = 'none';
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = '#000';
  g.fillRect(SHADOW_BORDER, SHADOW_BORDER, SHADOW_TEX - SHADOW_BORDER * 2,
             SHADOW_TEX - SHADOW_BORDER * 2);
  shadowTexture = Texture.from(c);
  return shadowTexture;
}

export class VintageScene {
  root = new Container();
  private cardsLayer = new Container();
  private cards: PrintCard[] = [];

  private screenW = 1;
  private screenH = 1;

  /**
   * Whole-pile camera. Each focal cycle starts a fresh linear ramp from a
   * small random rotation/scale to a slightly larger one — the macOS
   * screensaver "pushing through the photo pile" feel.
   */
  private camera: Camera = {
    rotFrom: 0, rotTo: 0, scaleFrom: 1, scaleTo: 1, start: 0, dur: 1,
  };

  constructor() {
    this.root.addChild(this.cardsLayer);
  }

  needsReseed = false;

  resize(w: number, h: number) {
    if (w === this.screenW && h === this.screenH) return;
    const sx = w / this.screenW;
    const sy = h / this.screenH;
    const oldCx = this.screenW / 2;
    const oldCy = this.screenH / 2;
    this.screenW = w;
    this.screenH = h;
    this.cardsLayer.pivot.set(w / 2, h / 2);
    this.cardsLayer.position.set(w / 2, h / 2);
    // Move the existing cards rather than destroying them. Pixi fires a resize
    // event per frame for the whole of a window drag, so rebuilding meant a
    // black frame and a fresh fade-up-from-black on every single one. Card
    // contents stay their old size until the next cycle replaces them, which is
    // invisible next to the pile blinking out.
    for (const c of this.cards) {
      c.baseX = (c.baseX - oldCx) * sx + w / 2;
      c.baseY = (c.baseY - oldCy) * sy + h / 2;
    }
    // Only an empty pile needs seeding. This used to be set unconditionally,
    // so the no-op resize Pixi emits on startup left the flag armed and the
    // next identical-size resize event rebuilt the whole pile for nothing —
    // cancelling any transition in flight along with it.
    if (this.cards.length === 0) this.needsReseed = true;
  }

  /** Entries currently referenced by any live card. */
  heldEntries(): Set<ImageEntry> {
    const set = new Set<ImageEntry>();
    for (const c of this.cards) set.add(c.entry);
    return set;
  }

  /**
   * Begin a new pile cycle.
   * - All existing cards start fading out (in place).
   * - A new focal card is created and fades in at slot 0.
   * - Up to bgSlots() new bg cards are created using history textures, fading
   *   in at randomized slot poses behind the focal.
   * - The pile camera kicks off a new slow rotation + zoom-in ramp.
   *
   * @param dwellSec how long the focal will stay on screen — used as the
   *                 timescale for the camera ramp.
   */
  addPhoto(
    ctx: AddPhotoCtx,
    fadeDurSec: number,
    dwellSec: number,
    now: number,
    /**
     * Show the new cards immediately instead of fading them in. Used when
     * seeding an empty pile, which has nothing to cross-fade *from* — and which
     * can happen while paused, when the clock is frozen and tick() never runs,
     * so a fade would leave the cards at alpha 0 forever and the screen black.
     */
    instant = false,
  ) {
    const fadeMs = instant ? 0 : fadeDurSec * 1000;

    // Camera: pile slowly rotates and zooms over each cycle. Targets are
    // ABSOLUTE bounded values (never accumulate). Research-backed for a
    // visibly-alive-but-not-distracting screensaver feel:
    //
    //   scale  ∈ [1.00 .. 1.22]   — standard Ken Burns range (2 %/s on 10 s dwell)
    //   rot    ∈ [-0.105 .. +0.105] rad (~±6°)
    const curRot = this.cardsLayer.rotation;
    const curScale = this.cardsLayer.scale.x;

    // Ping-pong between a near band and a far band. The old version added a
    // delta and clamped at the top, so once the scale reached ~1.08 the clamp
    // produced scaleFrom === scaleTo and roughly seven cycles in ten had no
    // zoom at all — only rotation and the per-card drift.
    const targetScale = curScale < (CAM_SCALE_MIN + CAM_SCALE_MAX) / 2
      ? rrange((CAM_SCALE_MIN + CAM_SCALE_MAX) / 2 + 0.02, CAM_SCALE_MAX)
      : rrange(CAM_SCALE_MIN, (CAM_SCALE_MIN + CAM_SCALE_MAX) / 2 - 0.02);

    // Rotation: damp the current value 40 % toward 0, then add a kick.
    // Caps at ±0.105 rad (~±6°). Tends back to neutral over time.
    const dirSign = Math.random() > 0.5 ? 1 : -1;
    const targetRot = Math.max(-0.105, Math.min(0.105,
      curRot * 0.4 + dirSign * rrange(0.035, 0.075),
    ));

    this.camera = {
      rotFrom: curRot,
      rotTo: targetRot,
      scaleFrom: curScale,
      scaleTo: targetScale,
      start: now,
      dur: (dwellSec + fadeDurSec) * 1000,
    };

    // Fade out everyone currently living
    for (const c of this.cards) {
      if (c.dying) continue;
      c.fadeFrom = c.container.alpha;
      c.fadeTo = 0;
      c.fadeStart = now;
      c.fadeDur = fadeMs;
      c.dying = true;
      // Exactly fadeMs, no grace period: the engine settles the transition on
      // the first frame at or after fadeMs and then stops the ticker if paused,
      // so a card scheduled even slightly later was never reaped — it sat at
      // alpha 0 holding a slide texture un-evictable for the whole pause.
      c.destroyAtMs = now + fadeMs;
    }

    // Build new bg cards FIRST (so we can z-order focal above them), oldest
    // first so the most recent photo ends up nearest the front — it used to be
    // the other way round, with the oldest drawn on top.
    const flip = rand() < 0.5 ? -1 : 1;
    const placed: SlotPose[] = [];
    const slots = this.bgSlots();
    for (let i = slots - 1; i >= 0; i--) {
      const h = ctx.history[i];
      if (!h) continue;
      const pose = this.bgSlotPose(i, flip, placed);
      placed.push(pose);
      const card = this.makeCard(h.texture, h.entry, pose, now);
      card.fadeFrom = 0;
      card.fadeTo = 1.0;
      card.fadeStart = now;
      card.fadeDur = fadeMs;
      card.container.alpha = instant ? 1 : 0;
      this.cardsLayer.addChild(card.container);
      this.cards.push(card);
    }

    // Focal card on top
    const focalCard = this.makeCard(ctx.focal.texture, ctx.focal.entry, this.focalSlotPose(), now);
    focalCard.fadeFrom = 0;
    focalCard.fadeTo = 1.0;
    focalCard.fadeStart = now;
    focalCard.fadeDur = fadeMs;
    focalCard.container.alpha = instant ? 1 : 0;
    this.cardsLayer.addChild(focalCard.container);
    this.cards.push(focalCard);

    this.needsReseed = false;
  }

  /** Per-frame update — applies fade tween and continuous drift. */
  tick(now: number) {
    // ── Pile camera (whole-scene rotation + zoom) ───────────────────────
    // Linear ramp through the dwell — slow, never resets abruptly. If we run
    // past `dur` (paused, manual nav, etc.) the camera just keeps the final
    // pose rather than continuing to inflate.
    {
      // Clamped both ends: lerp doesn't clamp, so a `now` before the ramp
      // started would extrapolate past the first keyframe.
      const t = Math.min(1, Math.max(0, (now - this.camera.start) / Math.max(1, this.camera.dur)));
      const rot = lerp(this.camera.rotFrom, this.camera.rotTo, t);
      const scl = lerp(this.camera.scaleFrom, this.camera.scaleTo, t);
      this.cardsLayer.rotation = rot;
      this.cardsLayer.scale.set(scl);
    }

    for (const c of [...this.cards]) {
      // Reap fully faded-out cards
      if (c.dying && now >= c.destroyAtMs) {
        const idx = this.cards.indexOf(c);
        if (idx >= 0) this.cards.splice(idx, 1);
        this.cardsLayer.removeChild(c.container);
        // texture:false — the slide texture is engine-owned and shared by
        // other cards; destroying it is the documented way to crash the batcher.
        c.container.destroy({ children: true, texture: false });
        continue;
      }

      // Opacity tween
      if (c.fadeDur > 0) {
        const t = Math.min(1, (now - c.fadeStart) / c.fadeDur);
        c.container.alpha = lerp(c.fadeFrom, c.fadeTo, ease(t));
      }

      // Continuous slow drift around the base pose.
      // sine waves with long periods + independent phases per axis.
      const t = (now - c.birthTime) / 1000;
      const dx = Math.sin(t * TAU / c.driftPeriodX + c.driftPhaseX) * c.driftAmpX;
      const dy = Math.sin(t * TAU / c.driftPeriodY + c.driftPhaseY) * c.driftAmpY;
      const dr = Math.sin(t * TAU / c.driftPeriodR + c.driftPhaseR) * c.driftAmpR;
      const ds = Math.sin(t * TAU / c.driftPeriodS + c.driftPhaseS) * c.driftAmpS;

      c.container.position.set(c.baseX + dx, c.baseY + dy);
      c.container.rotation = c.baseAngle + dr;
      c.container.scale.set(c.baseScale * (1 + ds));
    }
  }

  reset() {
    for (const c of this.cards) {
      this.cardsLayer.removeChild(c.container);
      c.container.destroy({ children: true, texture: false });
    }
    this.cards = [];
  }

  // ─── slot poses ───────────────────────────────────────────────────────────

  private focalSlotPose(): SlotPose {
    return {
      x: this.screenW / 2,
      y: this.screenH / 2,
      angle: (rand() - 0.5) * 0.05,       // ±~1.4°
      scale: 1.0,
    };
  }

  /**
   * Bg card pose — offset and rotated so several of them fill the frame.
   *
   * Spread follows the viewport: on a tall screen the cards fan out vertically,
   * on a wide one horizontally. `rank % 2` alone put two cards left and one
   * right every single cycle, so the pile was permanently lopsided despite the
   * comment claiming otherwise — the starting side is now random per cycle.
   */
  private bgSlotPose(rank: number, flip: number, placed: SlotPose[]): SlotPose {
    const slots = this.bgSlots();
    const cx = this.screenW / 2;
    const cy = this.screenH / 2;
    const tall = this.screenH > this.screenW;
    const side = (rank % 2 === 0 ? -1 : 1) * flip;
    // Push along the long axis, jitter across the short one.
    // More cards -> push them further out, so they tile the long axis instead
    // of stacking in the middle.
    const reach = slots >= 4 ? 0.38 : 0.28;
    const majorSpread = rrange(0.12, reach);
    const minorSpread = rrange(-0.13, 0.13);
    let pose: SlotPose = { x: cx, y: cy, angle: 0, scale: 1 };
    // A few tries to avoid landing on top of an already-placed card, which
    // fully occluded it and showed three photos instead of four.
    for (let attempt = 0; attempt < 6; attempt++) {
      const major = (attempt === 0 ? majorSpread : rrange(0.12, reach)) * side;
      const minor = (attempt === 0 ? minorSpread : rrange(-0.13, 0.13));
      pose = {
        x: cx + (tall ? minor * this.screenW : major * this.screenW),
        y: cy + (tall ? major * this.screenH : minor * this.screenH),
        angle: (rand() - 0.5) * 0.55,     // ±~16°
        scale: rrange(0.95, 1.05),
      };
      const minGap = Math.min(this.screenW, this.screenH) * 0.12;
      if (placed.every(p => Math.hypot(p.x - pose.x, p.y - pose.y) >= minGap)) break;
    }
    return pose;
  }

  // ─── card construction ────────────────────────────────────────────────────

  /**
   * Sizing: photo fits within 80% of EACH viewport axis (preserves aspect).
   * After the camera zoom-in (up to ~1.12) the displayed photo lands at
   * roughly 88% of the corresponding axis — comfortably the user's 85–90%
   * target while leaving room for the paper border to remain on-screen.
   */
  /** Paper mat width. Viewport-driven, so every card in a given frame matches. */
  private borderPx(): number {
    return Math.round(Math.min(this.screenW, this.screenH) * 0.045);
  }

  /**
   * How many background prints to build this cycle.
   *
   * An elongated screen needs more of them: making each card big enough to
   * cover a 21:9 frame on its own is impossible without cropping its mat, so
   * coverage comes from the number of cards and their spread instead.
   */
  bgSlots(): number {
    const ratio = Math.max(this.screenW, this.screenH) / Math.min(this.screenW, this.screenH);
    return ratio < 2 ? 3 : ratio < 2.5 ? 4 : 5;
  }

  private photoSize(texture: Texture): { w: number; h: number } {
    const aspect = texture.width / Math.max(1, texture.height);
    const short = Math.min(this.screenW, this.screenH);
    const long = Math.max(this.screenW, this.screenH);
    const border = this.borderPx();

    // Size so the card still fits at the camera's closest zoom, mat included.
    // The old rule fitted inside 80 % of both axes against an assumed 1.12 cap
    // that is really 1.22, so the focal card's mat was cropped most of the time.
    const shortLimit = Math.max(120, short / CAM_SCALE_MAX - 2 * border);
    const longLimit = Math.max(160, long / CAM_SCALE_MAX - 2 * border);

    const ratio = Math.max(aspect, 1 / aspect);
    let shortEdge = shortLimit;
    let longEdge = shortEdge * ratio;
    if (longEdge > longLimit) {
      longEdge = longLimit;
      shortEdge = longEdge / ratio;
    }
    return aspect >= 1
      ? { w: longEdge, h: shortEdge }
      : { w: shortEdge, h: longEdge };
  }

  private makeCard(
    texture: Texture,
    entry: ImageEntry,
    pose: SlotPose,
    now: number,
  ): PrintCard {
    const container = new Container();

    const { w: photoW, h: photoH } = this.photoSize(texture);
    // Border sized for an AUTHENTIC printed photo at typical viewing distance.
    // Industry standard pro-lab print = 1/4" border on a 4×6 ≈ 5 % of the
    // short edge. Photos in the pile are sized ~80 % of viewport short edge,
    // so 4.5 % of viewport short edge ≈ 5.6 % of photo short edge — squarely
    // in the "this is obviously a paper print" range. Uniform across all
    // cards (driven by viewport, not per-card dimensions).
    const border = this.borderPx();
    const totalW = photoW + 2 * border;
    const totalH = photoH + 2 * border;
    const x0 = -totalW / 2;
    const y0 = -totalH / 2;

    // Drop shadow — the shared pre-blurred texture, stretched to this card.
    // A sprite drawn at width W represents a shadow rect of W - 2*PAD inset
    // PAD from its left edge, so offsetting by PAD lines the rect up with the
    // paper (plus the usual down-right offset).
    const shadow = new NineSliceSprite({
      texture: getShadowTexture(),
      leftWidth: SHADOW_BORDER,
      topHeight: SHADOW_BORDER,
      rightWidth: SHADOW_BORDER,
      bottomHeight: SHADOW_BORDER,
      width: totalW + SHADOW_PAD * 2,
      height: totalH + SHADOW_PAD * 2,
    });
    shadow.position.set(
      x0 + SHADOW_OFFSET - SHADOW_PAD,
      y0 + SHADOW_OFFSET - SHADOW_PAD,
    );

    // Warm off-white paper. A tinted sprite rather than Graphics: cheaper, and
    // it avoids Pixi's GraphicsContext needing an explicit destroy option.
    const paper = new Sprite(Texture.WHITE);
    paper.tint = 0xf5efe4;
    paper.setSize(totalW, totalH);
    paper.position.set(x0, y0);

    // Photo — scaled to exact (photoW, photoH)
    const sprite = new Sprite(texture);
    sprite.anchor.set(0.5);
    sprite.scale.set(
      photoW / Math.max(1, texture.width),
      photoH / Math.max(1, texture.height),
    );
    sprite.position.set(0, 0);

    container.addChild(shadow);
    container.addChild(paper);
    container.addChild(sprite);
    container.position.set(pose.x, pose.y);
    container.rotation = pose.angle;
    container.scale.set(pose.scale);

    // Deliberately NOT cached with cacheAsTexture(): there is no per-frame work
    // left to bake (three batched quads, no filters), and caching cost a
    // power-of-two render target per card while clipping the shadow's penumbra.

    return {
      container, entry,
      baseX: pose.x,
      baseY: pose.y,
      baseAngle: pose.angle,
      baseScale: pose.scale,
      // Drift — visibly alive within the slow camera move. Periods short
      // enough to perceive motion within a 10 s dwell; amplitudes big
      // enough to read at viewing distance without crossing into "look
      // at me" territory.
      driftPhaseX: rand() * TAU,
      driftPhaseY: rand() * TAU,
      driftPhaseR: rand() * TAU,
      driftPhaseS: rand() * TAU,
      driftPeriodX: rrange(20, 35),
      driftPeriodY: rrange(25, 40),
      driftPeriodR: rrange(28, 45),
      driftPeriodS: rrange(25, 40),
      driftAmpX: rrange(8, 14),                   // pixels
      driftAmpY: rrange(6, 11),
      driftAmpR: rrange(0.014, 0.022),            // radians (~0.8°–1.3°)
      driftAmpS: rrange(0.008, 0.014),            // ±1 % scale
      fadeStart: 0,
      fadeDur: 0,
      fadeFrom: 0,
      fadeTo: 1,
      dying: false,
      destroyAtMs: 0,
      birthTime: now,
    };
  }
}
