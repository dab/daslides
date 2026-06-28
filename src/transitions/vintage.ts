import type { TransitionDef } from './types.ts';

/**
 * Vintage Prints — macOS screensaver style.
 *
 * NOT a color-grade transition. The authentic screensaver renders a *pile* of
 * paper prints — each with a white border and soft drop shadow, slightly
 * tilted — on a background formed by the previously-focal photo blurred and
 * dimmed. New photos fade in on top; older ones drift back into the pile and
 * eventually off-screen.
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
