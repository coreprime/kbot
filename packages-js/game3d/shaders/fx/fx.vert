// Explosion-mesh vertex shader.  The explosion manager rebuilds one
// interleaved triangle buffer per frame (pos3 + rgba4) with all the
// shard / fireball / shockwave geometry already in world space, so the
// draw is a single additive pass through the camera transform.
attribute vec3 aPos;
attribute vec4 aColor;

uniform mat4 uProj;
uniform mat4 uView;

varying vec4 vColor;

void main() {
  vColor = aColor;
  gl_Position = uProj * uView * vec4(aPos, 1.0);
}
