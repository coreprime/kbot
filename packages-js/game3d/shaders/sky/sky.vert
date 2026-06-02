// Sky vertex shader.  Draws a full-screen triangle pair sitting at the
// far plane (z=1).  The fragment shader uses uInvViewProj to project
// the NDC fragment back into a world-space view direction; that
// direction drives the gradient, sun discs and procedural clouds.

attribute vec2 aPos;
varying vec2 vNDC;
void main() {
  vNDC = aPos;
  gl_Position = vec4(aPos, 1.0, 1.0);
}
