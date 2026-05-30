// FXAA post-process vertex shader.  Full-screen triangle pair; passes
// the interpolated UV down so the fragment shader samples the composite
// LDR texture once per output pixel.

attribute vec2 aPos;
varying vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
