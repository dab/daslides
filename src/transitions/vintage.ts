import type { TransitionDef } from './types.ts';

/**
 * Vintage Prints — macOS screensaver style.
 *
 * NOT a color-grade transition. It renders a *pile* of paper prints — each with
 * a warm off-white border and a soft drop shadow, slightly tilted — against a
 * plain dark background. Each cycle crossfades a whole new pile in: a focal
 * print plus a few behind it drawn from the recent history. Cards never animate
 * their positions; the only motion is a slow camera push across the pile and a
 * continuous sine drift per card.
 *
 * Because this isn't a 2-texture crossfade, it can't live in a fragment shader.
 * It's a Pixi scene graph — implemented in `src/scenes/vintageScene.ts` and
 * driven by the engine when this transition is active.
 */
export const vintage: TransitionDef = {
  id: 'vintage',
  label: 'Vintage Prints',
  kind: 'scene',
};
