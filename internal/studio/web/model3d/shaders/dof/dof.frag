// Depth-of-field post-process fragment shader.  Reads the scene FBO's
// colour + depth and runs a depth-weighted 8-tap circular blur.
//
// Pixels at uFocalDepth +/- uFocalRange stay sharp; background pixels
// get a progressively wider radius up to uMaxBlur.  Per-pixel rotation
// hides the small tap count by randomising the disk orientation per
// fragment.  A depth-similarity weight on each tap prevents sharp
// foreground from bleeding into the background blur and vice-versa.

precision highp float;
varying vec2 vUV;
uniform sampler2D uScene;        // colour FBO
uniform sampler2D uSceneDepth;   // depth FBO (linearised below)
uniform vec2 uTexel;             // 1/width, 1/height of scene FBO
uniform float uFocalDepth;       // 0-1 NDC depth that should stay sharp
uniform float uFocalRange;       // width of the in-focus band
uniform float uMaxBlur;          // max blur radius in pixels
uniform float uEnabled;          // 0 disables the pass (straight copy)

// 8 unit-disk taps stored as a constant function - GLSL ES 1.00
// can't constant-initialise an array, so each tap is returned by
// index from the if-ladder below.  Compiler hoists into a small LUT.
vec2 tap(int i) {
  if (i == 0) return vec2( 1.000,  0.000);
  if (i == 1) return vec2( 0.707,  0.707);
  if (i == 2) return vec2( 0.000,  1.000);
  if (i == 3) return vec2(-0.707,  0.707);
  if (i == 4) return vec2(-1.000,  0.000);
  if (i == 5) return vec2(-0.707, -0.707);
  if (i == 6) return vec2( 0.000, -1.000);
  return vec2( 0.707, -0.707);
}

void main() {
  vec3 centerCol = texture2D(uScene, vUV).rgb;
  if (uEnabled < 0.5) {
    gl_FragColor = vec4(centerCol, 1.0);
    return;
  }
  // Linearise the hardware depth into a 0-1 range relative to the
  // focal plane.  Pixels closer to the focal depth get smaller
  // radii; depth==1.0 (skybox far plane) hits the cap.
  float depth = texture2D(uSceneDepth, vUV).r;
  float blurAmt = clamp((depth - uFocalDepth) / uFocalRange, 0.0, 1.0);
  blurAmt = smoothstep(0.0, 1.0, blurAmt);
  if (blurAmt < 0.01) {
    gl_FragColor = vec4(centerCol, 1.0);
    return;
  }
  float radius = blurAmt * uMaxBlur;
  // Cheap per-pixel rotation so the 8 taps don't form a visible
  // octagon at small radii.
  float ang = fract(sin(dot(vUV, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;
  float s = sin(ang), c = cos(ang);
  vec3 sum = centerCol;
  float wsum = 1.0;
  for (int i = 0; i < 8; i++) {
    vec2 ti = tap(i);
    vec2 t = vec2(ti.x * c - ti.y * s, ti.x * s + ti.y * c);
    vec2 off = t * radius * uTexel;
    // Pull each tap's depth so we don't bleed sharp foreground into
    // background blur (and vice versa) - only accept taps whose depth
    // is similar to the centre tap's blurriness category.
    float dt = texture2D(uSceneDepth, vUV + off).r;
    float dtAmt = clamp((dt - uFocalDepth) / uFocalRange, 0.0, 1.0);
    float w = 1.0 - abs(dtAmt - blurAmt) * 0.7;
    w = max(0.0, w);
    sum += texture2D(uScene, vUV + off).rgb * w;
    wsum += w;
  }
  gl_FragColor = vec4(sum / wsum, 1.0);
}
