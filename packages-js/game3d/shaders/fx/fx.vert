// Explosion-mesh vertex shader.  The explosion manager rebuilds one
// interleaved triangle buffer per frame (pos3 + rgba4) with all the
// shard / fireball / shockwave / mushroom geometry already in world space,
// so the draw is a single additive pass through the camera transform.
//
// It MUST write the same logarithmic depth every other world pass writes:
// the terrain, models and decals all override gl_FragDepth with log2(w), so
// an explosion drawn with the plain perspective z would be compared against
// terrain on an incompatible depth scale — a tall mushroom cloud then reads
// as buried in the hillside instead of towering above it.
#include "../lib/logdepth.glsl"

attribute vec3 aPos;
attribute vec4 aColor;

uniform mat4 uProj;
uniform mat4 uView;

varying vec4 vColor;

void main() {
  vColor = aColor;
  gl_Position = uProj * uView * vec4(aPos, 1.0);
#ifdef LOGDEPTH_VERTEX
  logDepthVertex();
#endif
}
