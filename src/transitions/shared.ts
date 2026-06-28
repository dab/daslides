/**
 * Shared GLSL for shader-based transitions (fadeZoom, kenBurns).
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
uniform float uTime;
uniform vec4  uPanZoomA;     // xy=startRelPan, zw=endRelPan, axis ∈ [-1, 1]
uniform vec4  uPanZoomB;
uniform vec2  uZoomA;        // x=startZoom, y=endZoom (absolute)
uniform vec2  uZoomB;
uniform float uKB;           // unused (each shader gates motion via its own params)

float ease(float t){ return t * t * (3.0 - 2.0 * t); }

/* ─── shared math ─────────────────────────────────────────────────────── */

vec2 coverScale(float imgAspect) {
  return (imgAspect > uScreenAspect)
    ? vec2(uScreenAspect / imgAspect, 1.0)   // photo wider — crops sides
    : vec2(1.0, imgAspect / uScreenAspect);  // photo taller — crops top/bottom
}

/* ─── blurred backdrop (Plex / Jellyfin / Apple-TV pattern) ───────────── */

/**
 * 18-tap golden-angle rotating-kernel blur over a cover-fit base, dimmed +
 * slightly saturated. Cheap, no second pass, looks good as an ambient halo.
 */
vec3 blurredBg(sampler2D tex, vec2 uv, float imgAspect) {
  vec2 base = (uv - 0.5) * coverScale(imgAspect) + 0.5;
  vec3 sum = vec3(0.0);
  const float radius = 0.075;
  for (int i = 0; i < 18; i++) {
    float a = float(i) * 2.39996;
    float s = 0.35 + 0.65 * fract(float(i) * 0.61803);
    vec2 off = vec2(cos(a), sin(a)) * radius * s;
    sum += texture(tex, clamp(base + off, 0.0, 1.0)).rgb;
  }
  vec3 col = sum / 18.0;
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
 * Zoom param convention (per slide, resize-agnostic, set in JS):
 *   param = 0.0   → resolved zoom = containScale (whole photo visible)
 *   param ∈ (0,1] → resolved zoom = mix(containScale, 1.0, param)
 *   param > 1.0   → resolved zoom = param        (tight cover)
 *
 * containScale = min(imgAspect, screenAspect) / max(imgAspect, screenAspect)
 * — equals 1 for aspect-matched photos, < 1 for portrait-on-landscape etc.
 * Computed in the shader from uScreenAspect, so a window resize correctly
 * updates the "full visible" keyframe.
 *
 * Why this layout (matches Final Cut Pro / Avid Pan & Zoom keyframe model):
 *   The animation parameters (zoom and pan) are resolved to ABSOLUTE values
 *   at each keyframe FIRST, then linearly interpolated in time. This keeps
 *   the motion C¹ across the contain↔cover boundary. The naive "interpolate
 *   the param, then map to zoom" creates a velocity kink at param=1.0 — two
 *   different slopes meeting at a point, only continuous in position, not
 *   in derivative. Resolving first then lerping is one continuous
 *   parameterization across the whole range.
 *
 * Bars (when resolved zoom is below the cover threshold) are filled with a
 * blurred copy of the same photo — Plex / Jellyfin / Apple-TV pattern.
 */
vec3 sampleSlideContain(
    sampler2D tex, vec2 uv, float imgAspect,
    vec4 panZoom, vec2 zooms, float t)
{
  vec2 scale = coverScale(imgAspect);
  float containScale = min(imgAspect, uScreenAspect) / max(imgAspect, uScreenAspect);

  // Resolve params to ABSOLUTE zooms at each keyframe (not per-t)
  float z0 = zooms.x < 1.0 ? mix(containScale, 1.0, zooms.x) : zooms.x;
  float z1 = zooms.y < 1.0 ? mix(containScale, 1.0, zooms.y) : zooms.y;

  // Resolve relative pans to ABSOLUTE pans, each at its own keyframe's zoom
  vec2 maxPan0 = max(vec2(0.0), 0.5 * (1.0 - scale / z0));
  vec2 maxPan1 = max(vec2(0.0), 0.5 * (1.0 - scale / z1));
  vec2 absPan0 = panZoom.xy * maxPan0;
  vec2 absPan1 = panZoom.zw * maxPan1;

  // LINEAR interpolation of absolute zoom + pan → constant velocity, no kink
  float zoom = mix(z0, z1, t);
  vec2  pan  = mix(absPan0, absPan1, t);

  vec2 c = (uv - 0.5) * scale / zoom + pan + 0.5;

  // Photo rect mask with feathered edge (anti-aliased boundary)
  vec2 outVec = max(vec2(0.0), max(-c, c - vec2(1.0)));
  float dist = max(outVec.x, outVec.y);
  float photoAlpha = 1.0 - smoothstep(0.0, 0.0025, dist);

  vec3 photo = texture(tex, clamp(c, 0.0, 1.0)).rgb;
  // Skip the 18-tap blur work when we're fully inside the photo rect — modern
  // GPUs handle this branch well because adjacent pixels agree.
  vec3 bg = photoAlpha >= 1.0 ? vec3(0.0) : blurredBg(tex, uv, imgAspect);
  return mix(bg, photo, photoAlpha);
}
`;
