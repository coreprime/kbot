// Map-feature batch vertex shader.  Feature stand-ins are baked into
// world-space static buffers at terrain install time (see
// map-features.js), so the only per-frame work is the camera transform.
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec3 aColor;

uniform mat4 uProj;
uniform mat4 uView;

varying vec3 vNormal;
varying vec3 vColor;
varying vec3 vWorldPos;

void main() {
  vNormal = aNormal;
  vColor = aColor;
  vWorldPos = aPos;
  gl_Position = uProj * uView * vec4(aPos, 1.0);
}
