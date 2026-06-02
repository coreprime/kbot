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
uniform float uFlareOn;          // 1 enables the screen-space sun lens flare
uniform vec2 uFlarePos;          // sun position in screen UV (0..1)
uniform vec3 uFlareColor;        // flare tint (sun colour, normalised)
uniform float uFlareStrength;    // flare intensity multiplier

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

  // 2b. Lens flare — a glow at the sun's screen position plus a few
  // ghosts strung along the sun→centre axis.  uFlarePos is the sun's
  // projected screen UV; the host sets uFlareOn whenever the sun is in
  // FRONT of the camera, even when it projects OFF the visible frame.
  // That lets the ghost streaks reach across the frame toward the sun
  // when you look in its direction (the sun sits high overhead, so it's
  // rarely framed directly).  Two falloffs tame the off-screen case:
  //   offDist  — how far the sun is outside the [0,1] frame.
  //   reach    — overall flare presence; fades over ~1-2 screens so a
  //              sun far from the look direction contributes nothing.
  //   coreFade — fades the bright core/halo faster, so an off-screen sun
  //              doesn't smear a hard blob bleeding from the edge while
  //              the dimmer ghosts still streak in.
  if (uFlareOn > 0.5) {
    float aspect = uTexel.y / uTexel.x;   // w/h — keep the glow circular
    vec2 q = clamp(uFlarePos, 0.0, 1.0);
    float offDist = length(uFlarePos - q);
    float reach = exp(-offDist * 1.5);
    float coreFade = exp(-offDist * 7.0);
    // Occlusion only when the sun pixel is actually on screen — off
    // screen we can't depth-test it, so assume it's visible (sky).
    float vis = (offDist < 0.0005)
      ? smoothstep(0.985, 0.999, texture2D(uSceneDepth, uFlarePos).r)
      : 1.0;
    if (vis > 0.001 && reach > 0.003) {
      vec3 flare = vec3(0.0);
      float dc = length((vUV - uFlarePos) * vec2(aspect, 1.0));
      flare += uFlareColor * exp(-dc * 16.0) * 1.3 * coreFade;   // tight core
      flare += uFlareColor * exp(-dc * 3.5) * 0.22 * coreFade;   // soft halo
      vec2 dir = vec2(0.5) - uFlarePos;
      for (int i = 1; i <= 4; i++) {
        vec2 gp = uFlarePos + dir * (float(i) * 0.34);
        float gd = length((vUV - gp) * vec2(aspect, 1.0));
        flare += uFlareColor * exp(-gd * 26.0) * (0.14 / float(i));
      }
      col += flare * vis * reach * uFlareStrength;
    }
  }

  // 3. Cinematic grade.
  //
  // The scene texture is ALREADY in display space (the main pass writes
  // tone-mapped LDR colour).  Running a full ACES tonemap over it would
  // double-tonemap — crushing + desaturating the midtones into a flat,
  // washed-out look.  Instead we apply a gentle filmic *grade*: a soft
  // S-curve for contrast, a touch of saturation to enrich the palette,
  // a light ACES roll-off applied ONLY to the brightest pixels (so sun
  // glints / muzzle flashes soften without dulling unit colours), and a
  // subtle vignette.  Net effect reads "filmic", not "washed".
  if (uCinematic > 0.5) {
    vec3 g = col;
    // Soft S-curve contrast about mid grey — the core filmic feel.
    g = clamp((g - 0.5) * 1.08 + 0.5, 0.0, 1.0);
    // Saturation lift to enrich (counteracts any roll-off desaturation).
    float l = dot(g, vec3(0.2126, 0.7152, 0.0722));
    g = mix(vec3(l), g, 1.15);
    // Highlight-only ACES roll-off, blended in lightly so only the top
    // end softens — midtones keep their full chroma.
    vec3 rolled = acesTonemap(g);
    float hi = smoothstep(0.72, 1.0, l);
    g = mix(g, rolled, hi * 0.5);
    // Subtle vignette - frames the shot without darkening the subject.
    vec2 dd = vUV - 0.5;
    float vig = smoothstep(1.0, 0.35, dot(dd, dd) * 2.0);
    g *= mix(1.0, vig, 0.28);
    col = mix(col, clamp(g, 0.0, 1.0), clamp(uGrade, 0.0, 1.0));
  }

  gl_FragColor = vec4(col, 1.0);
}
