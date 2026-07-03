// Main scene vertex shader - transforms unit geometry into clip space
// and computes the per-vertex data the fragment shader needs.  Two
// notable wrinkles:
//
//   * Refraction warp during the reflection pass.  When the renderer
//     draws the mirrored hull below the water plane, this shader
//     perturbs each vertex's XZ by the wave slope so the reflection
//     ripples with the surface above instead of being a rigid mirror.
//   * AO attribute - the loader bakes per-vertex AO from face-normal
//     divergence (see model-loader.js).  We just pass it through to
//     the fragment shader for the ambient term.

#include "../lib/sea-waves.glsl"
#include "../lib/logdepth.glsl"

attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec2 aUV;
attribute float aAO;            // baked AO factor (1=open, 0=fully occluded)
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uWorld;
uniform mat4 uLightSpace;
uniform mat4 uLightSpace2;
uniform float uReflectionTint;
uniform float uTime;
uniform float uWaterY;
uniform float uWavesIntensity;
varying vec2 vUV;
varying vec3 vNormal;
varying vec3 vWorldPos;
varying vec4 vLightSpacePos;
varying vec4 vLightSpacePos2;
varying float vAO;

void main() {
  vUV = aUV;
  vNormal = mat3(uWorld) * aNormal;
  vAO = aAO;
  vec4 worldPos = uWorld * vec4(aPos, 1.0);
  // Refraction warp: when this draw is the reflection pass, push
  // each vertex sideways by the wave slope at the vertex's XZ.
  // Vertices closer to the surface get smaller offsets; deeper
  // fragments shift further - same way Snell's law refracts a
  // straight-down view through a wavy interface.  Stylised, not
  // physically exact, but it reads as the reflection rippling
  // with the waves above instead of being a perfect rigid mirror.
  if (uReflectionTint > 0.5) {
    vec3 hs = seaWaveHS(worldPos.xz, uTime);
    float depthBelow = max(0.0, uWaterY - worldPos.y);
    vec2 refr = vec2(hs.y, hs.z) * uWavesIntensity * depthBelow * 0.35;
    worldPos.xz += refr;
  }
  vWorldPos = worldPos.xyz;
  vLightSpacePos = uLightSpace * worldPos;
  vLightSpacePos2 = uLightSpace2 * worldPos;
  gl_Position = uProj * uView * worldPos;
  gl_PointSize = 4.0;
#ifdef LOGDEPTH_VERTEX
  logDepthVertex();
#endif
}
