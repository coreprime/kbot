// Map-feature sprite-decal fragment shader.  Paints a flat ground
// feature's REAL GAF art (metal deposit plate, steam-vent mouth, scar…)
// onto the terrain surface: it samples the feature's own sprite texture and
// uses the sprite's ALPHA to feather the decal against the ground, so only
// the authored art shows and its edges fade out cleanly.  Lit matte by the
// same sun + hemispheric ambient the terrain and stand-ins use, washed by
// the scene's dynamic pulse lights, and faded into the horizon haze — so a
// metal patch reads as plating lying in the dirt, not a floating cut-out.

precision mediump float;

#include "../lib/logdepth.glsl"

#define MAX_PULSE_LIGHTS 256

varying vec3 vNormal;
varying vec2 vUV;
varying vec3 vWorldPos;

uniform sampler2D uSprite;
uniform vec3 uLightDir;      // toward the sun
uniform vec3 uSunTint;       // sun colour normalised to max-channel 1
uniform vec3 uHorizonColor;  // sky horizon for the distance haze
uniform vec3 uEyePos;
uniform float uExposure;
uniform float uMapFog;       // 1 = haze on, matches the map mesh

uniform vec3 uPulseLightPos[MAX_PULSE_LIGHTS];
uniform vec3 uPulseLightColor[MAX_PULSE_LIGHTS];
uniform float uPulseLightRange[MAX_PULSE_LIGHTS];
uniform int uPulseLightCount;

void main() {
#ifdef LOGDEPTH_FRAGMENT
  logDepthFragment();
#endif
  vec4 tex = texture2D(uSprite, vUV);
  // Edge alpha: the sprite's own transparency feathers the decal.  Drop
  // near-transparent fragments so the decal never draws a hard box.
  if (tex.a < 0.02) discard;

  vec3 n = normalize(vNormal);           // decals face +Y (up)
  float diff = max(0.0, dot(n, normalize(uLightDir)));
  float amb = 0.42 + 0.14 * max(0.0, n.y);
  vec3 col = tex.rgb * (amb + diff * 0.8);
  col *= mix(vec3(1.0), uSunTint, 0.45);

  // Dynamic weapon-light wash (muzzle flashes, explosions).
  vec3 pulse = vec3(0.0);
  for (int i = 0; i < MAX_PULSE_LIGHTS; i++) {
    if (i >= uPulseLightCount) break;
    float range = uPulseLightRange[i];
    if (range <= 0.0) continue;
    float d = distance(uPulseLightPos[i], vWorldPos) / range;
    pulse += uPulseLightColor[i] * (1.0 / (1.0 + d * d)) * 0.30;
  }
  col += tex.rgb * pulse;

  float dCam = length(uEyePos - vWorldPos);
  col = mix(col, uHorizonColor, smoothstep(1800.0, 5500.0, dCam) * 0.78 * uMapFog);
  gl_FragColor = vec4(col * uExposure, tex.a);
}
