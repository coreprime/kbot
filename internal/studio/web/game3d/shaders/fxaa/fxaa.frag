// FXAA (fast approximate anti-aliasing) post-process.  The DoF / post
// chain renders into an offscreen FBO whose colour attachment gets no
// MSAA (WebGL1 limitation), so once any post effect is active the edges
// would alias.  This pass runs over the composited LDR image and softens
// high-contrast edges.  uEnabled 0 = straight copy (no AA).
//
// Canonical simplified FXAA (Lottes' edge-directed luma blur): find the
// local luma gradient, walk along the edge, and blend the two samples
// that bracket it — clamped so we never blur across a real feature.

precision highp float;
varying vec2 vUV;
uniform sampler2D uTex;   // composited LDR scene
uniform vec2 uTexel;      // 1/width, 1/height
uniform float uEnabled;   // 0 = passthrough copy

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  vec3 rgbM = texture2D(uTex, vUV).rgb;
  if (uEnabled < 0.5) {
    gl_FragColor = vec4(rgbM, 1.0);
    return;
  }
  vec3 rgbNW = texture2D(uTex, vUV + vec2(-1.0, -1.0) * uTexel).rgb;
  vec3 rgbNE = texture2D(uTex, vUV + vec2( 1.0, -1.0) * uTexel).rgb;
  vec3 rgbSW = texture2D(uTex, vUV + vec2(-1.0,  1.0) * uTexel).rgb;
  vec3 rgbSE = texture2D(uTex, vUV + vec2( 1.0,  1.0) * uTexel).rgb;
  float lM = luma(rgbM);
  float lNW = luma(rgbNW), lNE = luma(rgbNE), lSW = luma(rgbSW), lSE = luma(rgbSE);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));

  vec2 dir;
  dir.x = -((lNW + lNE) - (lSW + lSE));
  dir.y =  ((lNW + lSW) - (lNE + lSE));

  const float REDUCE_MIN = 1.0 / 128.0;
  const float REDUCE_MUL = 1.0 / 8.0;
  const float SPAN_MAX = 8.0;
  float dirReduce = max((lNW + lNE + lSW + lSE) * 0.25 * REDUCE_MUL, REDUCE_MIN);
  float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = clamp(dir * rcpDirMin, vec2(-SPAN_MAX), vec2(SPAN_MAX)) * uTexel;

  vec3 rgbA = 0.5 * (
    texture2D(uTex, vUV + dir * (1.0 / 3.0 - 0.5)).rgb +
    texture2D(uTex, vUV + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 rgbB = rgbA * 0.5 + 0.25 * (
    texture2D(uTex, vUV + dir * -0.5).rgb +
    texture2D(uTex, vUV + dir *  0.5).rgb);
  float lB = luma(rgbB);
  gl_FragColor = vec4((lB < lMin || lB > lMax) ? rgbA : rgbB, 1.0);
}
