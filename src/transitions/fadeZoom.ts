import { FRAG_PRELUDE } from './shared.ts';
import type { TransitionDef } from './types.ts';

/**
 * Fade with Zoom (canonical Cross-Zoom / push-pull dolly).
 *
 * Research-backed pattern (Codrops, GSAP, Premiere "Cross Zoom"):
 *   - outgoing pushes in: 1.0 → 1.0 + magA
 *   - incoming pulls back: 1.0 + magB → 1.0
 *   - opacity crossfade with cubic ease-in-out
 *   - per-slide random magnitude (uFadeMag.x / .y), 0.08–0.14 — feels different
 *     every transition without ever being jarring
 *   - duration ≈ 1.5 s, motion stays ≥ 1.0 so COVER is preserved
 *
 * No pan, no rotation — research found those add vestibular load without
 * elegance gain at this duration.
 */
export const fadeZoom: TransitionDef = {
  id: 'fadeZoom',
  label: 'Fade with Zoom',
  kind: 'shader',
  kenBurns: false,
  fragment:
    FRAG_PRELUDE +
    /* glsl */ `
uniform vec2 uFadeMag;  // x = outgoing magnitude, y = incoming magnitude

void main(void) {
  // Outgoing pushes 1.0 → 1.0 + magA (camera dollies forward)
  vec3 a = sampleSlide(uTexA, vUV, uAspectA,
    vec4(0.0), vec2(1.0, 1.0 + uFadeMag.x), uProgress);

  // Incoming pulls 1.0 + magB → 1.0 (camera settles to rest)
  vec3 b = sampleSlide(uTexB, vUV, uAspectB,
    vec4(0.0), vec2(1.0 + uFadeMag.y, 1.0), uProgress);

  vec3 col = mix(a, b, ease(uProgress));
  fragColor = vec4(col, 1.0);
}
`,
};
