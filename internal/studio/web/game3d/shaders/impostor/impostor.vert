// Impostor vertex shader.  Each Phase 3 far-tier entity collapses to
// one GL_POINTS vertex whose centre is the unit's world position
// and whose pixel size is the projected pixel radius pre-computed
// by the renderer's LOD classifier.  No geometry walk, no per-piece
// transforms — the whole unit becomes a coloured point sprite.
//
// Layout (per impostor — 7 floats stride):
//   aPos    = world position (3 floats)
//   aColor  = solid RGB tint (3 floats)
//   aSize   = pixel diameter at the canvas (1 float)
//
// The fragment shader paints a soft-edged circular disc using the
// gl_PointCoord, so the result reads as a coloured pellet rather
// than a hard square the way GL_POINTS would give us by default.

attribute vec3 aPos;
attribute vec3 aColor;
attribute float aSize;

uniform mat4 uProj;
uniform mat4 uView;

varying vec3 vColor;

void main() {
  gl_Position = uProj * uView * vec4(aPos, 1.0);
  gl_PointSize = clamp(aSize, 1.0, 32.0);
  vColor = aColor;
}
