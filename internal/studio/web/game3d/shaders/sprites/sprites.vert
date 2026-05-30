// Animated bitmap-projectile vertex shader.  Each projectile is one
// GL_POINTS vertex carrying world pos, tint colour, world-units size,
// and per-particle UV sub-rect describing which frame of the sprite
// sheet to sample (computed JS-side from the particle's age + the
// sprite's frame metadata, so Step at any sim speed picks the right
// frame without the shader reading wall-clock).
//
// The atlas itself is a horizontal sprite sheet (frames laid out left
// to right), so the UV rect is a 4-float [u0, v0, u1, v1] sub-region
// of the texture.  v0/v1 are the full vertical extent in practice
// since each frame occupies the full sheet height; we keep the y span
// explicit so a future stacked atlas would Just Work.

attribute vec3 aPos;       // world position
attribute vec4 aColor;     // rgba tint multiplied onto the sampled texel
attribute float aSize;     // world-units sprite size (auto-resolves to pixels)
attribute vec4 aUvRect;    // (u0, v0, u1, v1) current-frame sub-rect

uniform mat4 uProj;
uniform mat4 uView;
uniform vec2 uViewport;

varying vec4 vColor;
varying vec4 vUvRect;

void main() {
  vec4 worldPos = vec4(aPos, 1.0);
  vec4 viewPos = uView * worldPos;
  gl_Position = uProj * viewPos;
  // Perspective-correct point sizing matches the regular particle
  // shader so the sprite scales with distance the same way a smoke
  // puff does (no surprise when projectiles fly past the camera).
  float dist = max(0.5, -viewPos.z);
  gl_PointSize = clamp(aSize * uViewport.y / (dist * 0.6), 1.0, 128.0);
  vColor = aColor;
  vUvRect = aUvRect;
}
