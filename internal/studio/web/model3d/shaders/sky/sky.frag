// SKY_FS implements a parameterisable skybox:
//   * Zenith/horizon gradient (uZenith / uHorizon).
//   * Up to two suns (uSun1Color/Dir/Size, uSun2Color/Dir/Size).
//     A zero-magnitude colour disables that sun.
//   * Procedural fbm clouds at a configurable altitude band, with
//     drift speed and shadow tint.
// All knobs are uniforms so the JS side can pick a preset per render
// (earth, twin-sun alien, mars, etc.) without touching the shader.

precision highp float;
varying vec2 vNDC;
uniform mat4 uInvViewProj;
uniform vec3 uEyePos;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSun1Color;
uniform vec3 uSun1Dir;
uniform float uSun1Size;
uniform vec3 uSun2Color;
uniform vec3 uSun2Dir;
uniform float uSun2Size;
uniform vec3 uCloudColor;
uniform vec3 uCloudShadow;
uniform float uCloudCoverage;
uniform float uCloudDensity;
uniform float uCloudSpeed;
uniform float uTime;
uniform float uOptGodBeams; // 0 disables crepuscular rays from the sun(s)

// Hash + value noise + fbm.  Compact enough to fit in WebGL1 and
// accurate enough that a 5-octave fbm reads as drifting clouds
// rather than checkerboard noise.
float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * vnoise(p);
    p = p * 2.07 + vec2(11.7, 5.3);
    a *= 0.5;
  }
  return v;
}

// sunDisc combines a sharp pow() falloff for the sun's body and a
// looser pow() for the surrounding glow.  uSize maps to the dot
// exponent: smaller -> wider disc (closer to 1.0 means crisp
// pinpoint sun, larger means soft halo with no defined edge).
vec3 sunDisc(vec3 dir, vec3 sunDir, vec3 sunColor, float size) {
  if (dot(sunColor, sunColor) < 0.0001) return vec3(0.0);
  float a = max(0.0, dot(dir, normalize(sunDir)));
  // Disc body: very sharp peak.
  float discE = max(1.0, 1.0 / max(size, 0.0005));
  float body = pow(a, discE);
  // Outer glow: softer, broader.
  float halo = pow(a, max(20.0, discE * 0.08)) * 0.45;
  return sunColor * (body + halo);
}

void main() {
  // Reconstruct a world-space ray through this NDC fragment.  The
  // near + far points come from inv(VP).(x,y,+/-1); their direction
  // is the view ray.  Using +/-1 instead of just the far point keeps
  // the math stable even when the camera near plane is tiny.
  vec4 nearH = uInvViewProj * vec4(vNDC, -1.0, 1.0);
  vec4 farH  = uInvViewProj * vec4(vNDC,  1.0, 1.0);
  vec3 nearW = nearH.xyz / nearH.w;
  vec3 farW  = farH.xyz / farH.w;
  vec3 dir = normalize(farW - nearW);

  // Vertical gradient driven by the ray's Y component.  smoothstep
  // pulls the horizon line down slightly so the zenith colour
  // dominates upward views without a hard band.
  float y = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(uHorizon, uZenith, smoothstep(0.40, 0.95, y));

  // Suns: each contributes a disc + halo, additively on top of the
  // sky.  Disabled when colour is the zero vector.
  col += sunDisc(dir, uSun1Dir, uSun1Color, uSun1Size);
  col += sunDisc(dir, uSun2Dir, uSun2Color, uSun2Size);

  // Procedural clouds at altitude.  Projected onto a flat cloud
  // sheet at unit height; the dir.y > 0 branch keeps the
  // projection sane when the camera looks at the horizon.  Two
  // octaves of fbm break the cloud puffs into bodies + wispy
  // edges; the horizon fade is gentle so even small upward
  // angles pick up a few clouds drifting in.
  //
  // cMask is also fed back into the god-ray calculation below
  // (beams shine through GAPS in clouds, not through dense bodies),
  // so we compute it outside the dir.y > 0 guard at default 0.
  float cMask = 0.0;
  if (dir.y > 0.005) {
    vec2 cp = dir.xz / max(dir.y, 0.005) * 0.40 + vec2(uTime * uCloudSpeed, uTime * uCloudSpeed * 0.7);
    float c = fbm(cp);
    float c2 = fbm(cp * 0.45 - 1.7);
    cMask = smoothstep(1.0 - uCloudCoverage, 1.0 - uCloudCoverage + 0.30, c * (c2 + 0.3) * 1.8);
    vec3 cloudCol = mix(uCloudShadow, uCloudColor, smoothstep(0.25, 0.95, c));
    float horizonFade = smoothstep(0.01, 0.18, dir.y);
    col = mix(col, cloudCol, cMask * uCloudDensity * horizonFade);
  }

  // -- God-rays / crepuscular beams --------------------------------
  // Radial streaks emanating from the sun, brightest where the
  // view direction is near the sun and the cloud cover is low.
  // The stripe pattern uses an angular noise of the tangent
  // component (dir minus its projection onto the sun direction);
  // that gives streaks that radiate outward from the sun rather
  // than wrap around the sphere.  Multiple sines of the angle
  // create irregular thick/thin beams instead of a perfect fan.
  if (uOptGodBeams > 0.5 && dot(uSun1Color, uSun1Color) > 0.0001) {
    vec3 toSun = normalize(uSun1Dir);
    vec3 tang = dir - toSun * dot(dir, toSun);
    float tLen = length(tang);
    float ang = atan(tang.y, dot(tang, normalize(vec3(toSun.z, 0.0, -toSun.x) + 1e-5)));
    // Value-noise-modulated shafts: instead of regular sine
    // stripes, sample noise along the angular axis to pick out
    // irregular bright shafts.  Two scales give chunky main
    // beams + finer cross-modulation; a slow time drift makes
    // the shafts breathe rather than march at a fixed cadence.
    float shaftHi = vnoise(vec2(ang * 2.2, uTime * 0.03));
    float shaftLo = vnoise(vec2(ang * 5.7 + 11.0, -uTime * 0.05));
    float beam = pow(smoothstep(0.45, 0.85, shaftHi), 1.4)
               * (0.5 + 0.5 * shaftLo);
    // Wider falloff so shafts reach further across the sky, with
    // a much softer cloud-gap cutoff - patchy clouds modulate the
    // intensity but don't kill the beam outright.
    float coneFall = exp(-tLen * 1.4);
    float gap = mix(0.45, 1.0, 1.0 - smoothstep(0.40, 0.95, cMask));
    float upward = smoothstep(-0.05, 0.20, dir.y);
    col += uSun1Color * beam * coneFall * gap * upward * 1.80;
  }
  if (uOptGodBeams > 0.5 && dot(uSun2Color, uSun2Color) > 0.0001) {
    vec3 toSun = normalize(uSun2Dir);
    vec3 tang = dir - toSun * dot(dir, toSun);
    float tLen = length(tang);
    float ang = atan(tang.y, dot(tang, normalize(vec3(toSun.z, 0.0, -toSun.x) + 1e-5)));
    float shaftHi = vnoise(vec2(ang * 2.2, uTime * 0.03));
    float shaftLo = vnoise(vec2(ang * 5.7 + 11.0, -uTime * 0.05));
    float beam = pow(smoothstep(0.45, 0.85, shaftHi), 1.4)
               * (0.5 + 0.5 * shaftLo);
    float coneFall = exp(-tLen * 1.4);
    float gap = mix(0.45, 1.0, 1.0 - smoothstep(0.40, 0.95, cMask));
    float upward = smoothstep(-0.05, 0.20, dir.y);
    col += uSun2Color * beam * coneFall * gap * upward * 1.50;
  }

  gl_FragColor = vec4(col, 1.0);
}
