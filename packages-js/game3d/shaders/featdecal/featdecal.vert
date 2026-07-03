// Map-feature sprite-decal vertex shader.  Flat ground features (metal
// deposits, steam vents, scars…) are baked into world-space static buffers
// as terrain-conforming textured quads (pos3 + normal3 + uv2) at terrain
// install time (see map-features.js buildSpriteDecal), so the only
// per-frame work is the camera transform.
#include "../lib/logdepth.glsl"

attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec2 aUV;

uniform mat4 uProj;
uniform mat4 uView;

varying vec3 vNormal;
varying vec2 vUV;
varying vec3 vWorldPos;

void main() {
  vNormal = aNormal;
  vUV = aUV;
  vWorldPos = aPos;
  gl_Position = uProj * uView * vec4(aPos, 1.0);
#ifdef LOGDEPTH_VERTEX
  logDepthVertex();
#endif
}
