// Map-feature batch vertex shader.  Feature stand-ins are baked into
// world-space static buffers at terrain install time (see
// map-features.js), so the only per-frame work is the camera transform.
#include "../lib/logdepth.glsl"

attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec3 aColor;
attribute vec2 aMaterial;   // x = metalness, y = emissive

uniform mat4 uProj;
uniform mat4 uView;

varying vec3 vNormal;
varying vec3 vColor;
varying vec3 vWorldPos;
varying vec2 vMaterial;

void main() {
  vNormal = aNormal;
  vColor = aColor;
  vWorldPos = aPos;
  vMaterial = aMaterial;
  gl_Position = uProj * uView * vec4(aPos, 1.0);
#ifdef LOGDEPTH_VERTEX
  logDepthVertex();
#endif
}
