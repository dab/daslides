/**
 * Shared GLSL for shader-based transitions (fadeZoom, kenBurns).
 *
 * Slide textures carry a full mip chain (see engine.loadSlide), so minification
 * is trilinear rather than a single bilinear tap — which is what keeps fine
 * detail from crawling while Ken Burns pans.
 *
 * Two samplers:
 *   sampleSlide        — pure COVER. Zoom ≥ 1.0 expected. The image always
 *                        fills the viewport; no bars; one texture sample per
 *                        pixel. Used by Fade with Zoom.
 *
 *   sampleSlideContain — handles zoom ≥ containScale, so at the lower end
 *                        the WHOLE photo is visible with bars on the
 *                        aspect-mismatch axis. Bars are filled with a
 *                        heavily-blurred copy of the same photo (the Plex /
 *                        Jellyfin / Apple-TV pattern). The sampler crossfades
 *                        between photo and backdrop at the rect boundary so
 *                        you never see a hard edge. Used by Ken Burns: at
 *                        one keyframe per slide the photo is *almost fully
 *                        visible*, at the other it's at exact cover + 10 %.
 *
 * GLSL ES 3.00 / WebGL2.
 */

export const VERTEX = /* glsl */ `#version 300 es
in vec2 aPosition;
in vec2 aUV;
out vec2 vUV;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

void main(void) {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
}
`;

export const FRAG_PRELUDE = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUV;
out vec4 fragColor;

uniform sampler2D uTexA;
uniform sampler2D uTexB;

uniform float uAspectA;
uniform float uAspectB;
uniform float uScreenAspect;
uniform float uProgress;     // 0..1 during transition, 0 otherwise
uniform float uDwellA;       // 0..1 over slide A's dwell
uniform float uDwellB;
uniform vec4  uPanZoomA;     // xy=startRelPan, zw=endRelPan, axis ∈ [-1, 1]
uniform vec4  uPanZoomB;
uniform vec2  uZoomA;        // x=startZoom, y=endZoom (absolute)
uniform vec2  uZoomB;

float ease(float t){ return t * t * (3.0 - 2.0 * t); }

/* ─── shared math ─────────────────────────────────────────────────────── */

vec2 coverScale(float imgAspect) {
  return (imgAspect > uScreenAspect)
    ? vec2(uScreenAspect / imgAspect, 1.0)   // photo wider — crops sides
    : vec2(1.0, imgAspect / uScreenAspect);  // photo taller — crops top/bottom
}

/* ─── blurred backdrop (Plex / Jellyfin / Apple-TV pattern) ───────────── */

/**
 * Golden-angle rotating-kernel blur over a cover-fit base, dimmed + slightly
 * saturated. Cheap, no second pass, looks good as an ambient halo.
 *
 * Sampled from a small MIP LEVEL, with an explicit LOD. Two reasons:
 *
 *  1. Speed. This used to take 18 taps at full resolution, and for a portrait
 *     photo on a landscape screen it covers 60-70 % of the frame (double that
 *     mid-crossfade) — scattered 0.075-UV fetches across a multi-megabyte
 *     surface, which is maximally texture-cache-hostile. Reading a ~64 px mip
 *     instead keeps the whole working set in cache, so 8 taps now cost far less
 *     than 18 did, and look smoother because each mip texel is already an
 *     average.
 *
 *  2. Correctness. This is called from inside non-uniform control flow (the
 *     photoAlpha test in sampleSlideContain). Implicit-derivative fetches are
 *     undefined there, which was harmless only while textures had no mip chain.
 *     textureLod takes no derivatives, so it is legal — keep it that way.
 */
vec3 blurredBg(sampler2D tex, vec2 uv, float imgAspect) {
  vec2 base = (uv - 0.5) * coverScale(imgAspect) + 0.5;
  // Pick the mip whose long edge is ~64 px, whatever the source resolution.
  ivec2 ts = textureSize(tex, 0);
  float lod = log2(max(1.0, float(max(ts.x, ts.y)) / 64.0));
  vec3 sum = vec3(0.0);
  const float radius = 0.075;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 2.39996;
    float s = 0.35 + 0.65 * fract(float(i) * 0.61803);
    vec2 off = vec2(cos(a), sin(a)) * radius * s;
    sum += textureLod(tex, clamp(base + off, 0.0, 1.0), lod).rgb;
  }
  vec3 col = sum / 8.0;
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, 1.20);
  return col * 0.50;
}

/* ─── samplers ────────────────────────────────────────────────────────── */

/** Pure COVER sample. Zoom must be ≥ 1.0 — no bars are ever shown. */
vec3 sampleSlide(
    sampler2D tex, vec2 uv, float imgAspect,
    vec4 panZoom, vec2 zooms, float t)
{
  vec2  relPan = mix(panZoom.xy, panZoom.zw, t);
  float zoom   = mix(zooms.x, zooms.y, t);

  vec2 scale  = coverScale(imgAspect);
  vec2 maxPan = max(vec2(0.0), 0.5 * (1.0 - scale / zoom));
  vec2 pan    = relPan * maxPan;

  vec2 c = (uv - 0.5) * scale / zoom + pan + 0.5;
  return texture(tex, clamp(c, 0.0, 1.0)).rgb;
}

/**
 * CONTAIN-capable sample with constant-velocity Ken Burns motion.
 *
 * zooms.x and zooms.y are ABSOLUTE zoom factors. The Final-Cut /
 * Avid-Pan-and-Zoom pattern: resolve everything to absolute values at each
 * keyframe, then linearly interpolate in time. No piecewise functions, no
 * velocity kink, one continuous parameterization across contain↔cover.
 *
 * For HORIZONTAL photos the engine emits zoom values in [1.0, 1.10] — no bars.
 * For VERTICAL photos the engine emits values like (heightFactor × scale.y)
 * where heightFactor in [1.05, 1.35] — the photo always extends >= 105% of
 * viewport height (no top/bottom letterbox), but the image is narrower than
 * the screen so sides get the blurred-self backdrop fill (Plex/Apple-TV
 * pattern).
 */
vec3 sampleSlideContain(
    sampler2D tex, vec2 uv, float imgAspect,
    vec4 panZoom, vec2 zooms, float t)
{
  vec2 scale = coverScale(imgAspect);

  // Absolute pans at each keyframe (resolved at its own zoom level)
  vec2 maxPan0 = max(vec2(0.0), 0.5 * (1.0 - scale / zooms.x));
  vec2 maxPan1 = max(vec2(0.0), 0.5 * (1.0 - scale / zooms.y));
  vec2 absPan0 = panZoom.xy * maxPan0;
  vec2 absPan1 = panZoom.zw * maxPan1;

  // LINEAR interpolation of absolute zoom + pan → constant velocity
  float zoom = mix(zooms.x, zooms.y, t);
  vec2  pan  = mix(absPan0, absPan1, t);

  vec2 c = (uv - 0.5) * scale / zoom + pan + 0.5;

  // Photo rect mask with feathered edge (anti-aliased boundary)
  vec2 outVec = max(vec2(0.0), max(-c, c - vec2(1.0)));
  float dist = max(outVec.x, outVec.y);
  float photoAlpha = 1.0 - smoothstep(0.0, 0.0025, dist);

  // Derivatives are taken from the UNCLAMPED coordinate. Clamping first would
  // flatten them to zero outside the photo rect, and now that textures carry a
  // mip chain that collapses the LOD and leaves a soft seam at the rect edge.
  vec3 photo = textureGrad(tex, clamp(c, 0.0, 1.0), dFdx(c), dFdy(c)).rgb;
  // Skip the blur when fully inside the photo rect — GPUs branch well when
  // adjacent pixels agree.
  vec3 bg = photoAlpha >= 1.0 ? vec3(0.0) : blurredBg(tex, uv, imgAspect);
  return mix(bg, photo, photoAlpha);
}
`;
