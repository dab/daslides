import { FRAG_PRELUDE } from './shared.ts';
import type { TransitionDef } from './types.ts';

/**
 * Ken Burns — contain-aware.
 *
 * One keyframe per slide is the photo's **containScale** — the largest zoom
 * at which the WHOLE photo is visible. For aspect-matched photos that's 1.0
 * (exact cover). For a portrait photo on a landscape screen it's ~0.376 —
 * the photo fills the screen height with the bars on the sides filled by a
 * heavily-blurred copy of the same photo (Plex / Apple-TV pattern).
 *
 * The other keyframe is at zoom ≈ 1.10 — exact cover + 10 %, tight crop.
 *
 * Linear interpolation (documentary feel). Which keyframe is start vs end is
 * randomized 50/50 in JS, so half the slides reveal the full photo at the
 * beginning and half at the end.
 */
export const kenBurns: TransitionDef = {
  id: 'kenBurns',
  label: 'Ken Burns',
  kind: 'shader',
  kenBurns: true,
  fragment:
    FRAG_PRELUDE +
    /* glsl */ `
void main(void) {
  vec3 a = sampleSlideContain(uTexA, vUV, uAspectA, uPanZoomA, uZoomA, uDwellA);
  vec3 b = sampleSlideContain(uTexB, vUV, uAspectB, uPanZoomB, uZoomB, uDwellB);
  vec3 col = mix(a, b, ease(uProgress));
  fragColor = vec4(col, 1.0);
}
`,
};
