// Ground / sea-surface / seabed vertex shader.  One program drives
// all three:
//   * Seabed pass - rocks + dunes at uSeabedY (uSeabedActive=1)
//   * Sea surface - waves on top of uGroundY (uGroundMode=2)
//   * Flat ground - terrain or grid at uGroundY (uGroundMode 0/1/3)
//
// Background mountains: when uMountainActive=1 (non-sea ground modes
// only) the vertex shader bulges the tessellated quad up into a ring
// of procedural mountains beyond uClearRadius from the unit.  The
// style switch picks between rocky fbm, angular metal protrusions
// (sharp ridges + flat tops), and rolling sand dunes - so a Metal
// world feels mechanical and a Greenworld feels geological.

precision highp float;
precision highp int;

#include "../lib/sea-waves.glsl"

attribute vec3 aPos;
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uLightSpace;
uniform mat4 uLightSpace2; // twin-sun environments: shadow proj for sun2
uniform float uGroundY;
uniform float uSeabedY;
uniform float uSeabedActive;
uniform int uGroundMode;
uniform float uTime;
uniform float uWavesIntensity;
// Background mountain controls.  uMountainActive=0 disables the
// whole feature; non-zero lifts the ring outside the unit's
// clearing into procedural terrain.
uniform vec3 uClearCenter;
uniform float uClearRadius;
uniform float uClearFalloff;
uniform float uMountainHeight;
uniform float uMountainScale;
uniform float uMountainActive;
uniform int uMountainStyle;
// Seabed knobs - feed into the parameterised seabedHeight()
// overload from sea-waves.glsl.  Defaults match the pre-slider
// values so omitting them keeps the original look.
uniform float uSeabedHeightMul;
uniform float uSeabedScaleMul;
uniform float uSeabedRockChance;
varying vec3 vWorldPos;
varying vec4 vLightSpacePos;
varying vec4 vLightSpacePos2;   // sun2 shadow proj (twin-sun envs)
varying float vMountainAmt;     // 0 inside the clearing, smoothstepped to 1 in full mountains
varying float vMountainHNorm;   // 0..1 normalised height of the mountain at this XZ

// Mountain noise helpers - separate from the sea library because
// the underlying scales / octave counts differ.  Both use the same
// hash so we don't double up that work.
float mtNoise(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float mtValueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = mtNoise(i);
  float b = mtNoise(i + vec2(1.0, 0.0));
  float c = mtNoise(i + vec2(0.0, 1.0));
  float d = mtNoise(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float mtFbm(vec2 p) {
  float v = 0.0;
  float a = 0.55;
  for (int i = 0; i < 5; i++) {
    v += a * mtValueNoise(p);
    p = p * 2.07 + vec2(11.7, 5.3);
    a *= 0.5;
  }
  return v;
}
// Sharper ridged value combo - mirrors the noise around 0.5 then
// inverts so peaks read as crests, used to draw angular protrusions
// for metal worlds.
float mtAngular(vec2 p) {
  float v = 0.0;
  float a = 0.6;
  for (int i = 0; i < 4; i++) {
    float n = mtValueNoise(p);
    v += a * (1.0 - abs(n - 0.5) * 2.0);
    p = p * 2.13 + vec2(17.0, 3.0);
    a *= 0.55;
  }
  return clamp(v - 0.35, 0.0, 1.5);
}
// mountainHeight returns a 0..1+ multiplier on uMountainHeight.
// style:  0=rocky, 1=angular metal, 2=sand dunes.
//
// The base wavelength used to be 450 wu, which meant individual
// peaks were so far apart that at typical viewing ranges (300-800
// wu) the camera saw less than one full cycle - reading as a
// gentle hump rather than a mountain ring.  Cut to 180 wu so the
// horizon shows 3-5 distinct peaks at default zoom, matching the
// silhouette of a real mountain range.
float mountainHeight(vec2 xz, int style, float scale) {
  vec2 p = xz / (180.0 * scale);
  if (style == 1) {
    // Metal: sharper angular ridges + quantise into discrete
    // height plateaus so each face reads as a fabricated panel.
    float a = mtAngular(p * 1.4);
    float plate = floor(a * 4.0) / 4.0;  // 4 tiers
    return mix(a, plate, 0.55);
  }
  if (style == 2) {
    // Sand dunes: smooth, rounded, biased low.
    return smoothstep(0.25, 0.95, mtFbm(p * 0.7));
  }
  // Rocky default: fbm + a high-frequency detail layer for scree.
  float lo = mtFbm(p);
  float hi = mtFbm(p * 2.8 + 5.0) * 0.35;
  return smoothstep(0.20, 1.05, lo + hi);
}

void main() {
  // Three displacement modes baked into one program:
  //   * Seabed pass - random rocks + dunes, at a depressed Y below
  //     the water plane.
  //   * Sea surface - the shared wave function rolls the tessellated
  //     quad in 3D so the silhouette actually crests.
  //   * Other ground modes - flat plane at uGroundY, optionally
  //     bulged outward by the background mountain ring.
  float y;
  float mountAmt = 0.0;
  float mountHNorm = 0.0;
  if (uSeabedActive > 0.5) {
    y = uSeabedY + seabedHeight(aPos.xz, uSeabedHeightMul, uSeabedScaleMul, uSeabedRockChance);
  } else if (uGroundMode == 2) {
    y = uGroundY + seaWaveHS(aPos.xz, uTime).x * uWavesIntensity;
  } else if (uGroundMode == 4) {
    // Map-terrain mesh: heights are baked into the vertex Y by the
    // renderer (one vertex per heightmap cell), so no displacement —
    // and no mountain ring bulging the battlefield.
    y = aPos.y;
  } else {
    y = uGroundY;
    if (uMountainActive > 0.5) {
      float d = length(aPos.xz - uClearCenter.xz);
      mountAmt = smoothstep(uClearRadius, uClearRadius + uClearFalloff, d);
      mountHNorm = mountainHeight(aPos.xz, uMountainStyle, uMountainScale);
      y += mountHNorm * uMountainHeight * mountAmt;
    }
  }
  vMountainAmt = mountAmt;
  vMountainHNorm = mountHNorm;
  vec3 worldPos = vec3(aPos.x, y, aPos.z);
  vWorldPos = worldPos;
  vLightSpacePos = uLightSpace * vec4(worldPos, 1.0);
  vLightSpacePos2 = uLightSpace2 * vec4(worldPos, 1.0);
  gl_Position = uProj * uView * vec4(worldPos, 1.0);
}
