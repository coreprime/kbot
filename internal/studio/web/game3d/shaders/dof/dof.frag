// Scene-composite post-process fragment shader.  Reads the scene FBO's
// colour + depth and produces the final image.  It folds three stages
// the renderer drives independently:
//
//   1. Depth-of-field — a depth-weighted 8-tap circular blur.  Pixels
//      at uFocalDepth +/- uFocalRange stay sharp; background pixels get
//      a progressively wider radius up to uMaxBlur.  Gated by uEnabled.
//   2. Bloom add — a pre-blurred bright-pass texture (uBloom) added on
//      top, scaled by uBloomStrength.  Gated by uBloomOn.
//   3. Cinematic grade — ACES-ish filmic tonemap + contrast/saturation
//      lift + a soft vignette.  Gated by uCinematic; uGrade scales how
//      far the grade pushes from the raw image.
//
// FXAA runs as a SEPARATE later pass on this shader's LDR output, so
// the anti-aliasing samples the final graded pixels.

precision highp float;
varying vec2 vUV;
uniform sampler2D uScene;        // colour FBO
uniform sampler2D uSceneDepth;   // depth FBO
uniform sampler2D uBloom;        // pre-blurred bright-pass (half-res)
uniform vec2 uTexel;             // 1/width, 1/height of scene FBO
uniform float uFocalDepth;       // 0-1 NDC depth that should stay sharp
uniform float uFocalRange;       // width of the in-focus band
uniform float uMaxBlur;          // max blur radius in pixels
uniform float uEnabled;          // 0 disables the DoF blur (sharp copy)
uniform float uBloomOn;          // 1 adds the bloom texture
uniform float uBloomStrength;    // bloom add multiplier
uniform float uCinematic;        // 1 enables tonemap + grade + vignette
uniform float uGrade;            // 0..1 grade intensity (mix toward graded)

// 8 unit-disk taps stored as a constant function - GLSL ES 1.00
// can't constant-initialise an array, so each tap is returned by
// index from the if-ladder below.
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

// ACES filmic tonemap approximation (Narkowicz fit) - compresses the
// highlights into a gentle filmic roll-off so bright panels + sun
// glints don't clip flat to white.
vec3 acesTonemap(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec3 col = texture2D(uScene, vUV).rgb;

  // 1. Depth of field.
  if (uEnabled > 0.5) {
    float depth = texture2D(uSceneDepth, vUV).r;
    float blurAmt = clamp((depth - uFocalDepth) / uFocalRange, 0.0, 1.0);
    blurAmt = smoothstep(0.0, 1.0, blurAmt);
    if (blurAmt >= 0.01) {
      float radius = blurAmt * uMaxBlur;
      float ang = fract(sin(dot(vUV, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;
      float s = sin(ang), c = cos(ang);
      vec3 sum = col;
      float wsum = 1.0;
      for (int i = 0; i < 8; i++) {
        vec2 ti = tap(i);
        vec2 t = vec2(ti.x * c - ti.y * s, ti.x * s + ti.y * c);
        vec2 off = t * radius * uTexel;
        float dt = texture2D(uSceneDepth, vUV + off).r;
        float dtAmt = clamp((dt - uFocalDepth) / uFocalRange, 0.0, 1.0);
        float w = max(0.0, 1.0 - abs(dtAmt - blurAmt) * 0.7);
        sum += texture2D(uScene, vUV + off).rgb * w;
        wsum += w;
      }
      col = sum / wsum;
    }
  }

  // 2. Bloom add.
  if (uBloomOn > 0.5) {
    col += texture2D(uBloom, vUV).rgb * uBloomStrength;
  }

  // 3. Cinematic grade.
  if (uCinematic > 0.5) {
    vec3 graded = acesTonemap(col * 1.18);            // slight exposure lift into the tonemap
    float l = dot(graded, vec3(0.2126, 0.7152, 0.0722));
    graded = mix(vec3(l), graded, 1.12);              // +saturation
    graded = (graded - 0.5) * 1.06 + 0.5;             // +contrast around mid grey
    // Soft vignette - darkens the corners to focus the eye.
    vec2 dd = vUV - 0.5;
    float vig = smoothstep(0.85, 0.35, dot(dd, dd) * 2.0);
    graded *= mix(1.0, vig, 0.55);
    col = mix(col, graded, clamp(uGrade, 0.0, 1.0));
  }

  gl_FragColor = vec4(col, 1.0);
}
