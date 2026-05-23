// Depth-of-field post-process vertex shader.  Draws a full-screen
// triangle pair so the fragment shader runs once per pixel of the
// default framebuffer.

attribute vec2 aPos;
varying vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
