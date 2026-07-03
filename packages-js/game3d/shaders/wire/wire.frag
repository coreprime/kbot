// Wireframe fragment shader.  Flat uniform colour, alpha included so
// the renderer can blend semi-transparent overlays.

precision mediump float;

#include "../lib/logdepth.glsl"

uniform vec4 uColor;
void main() {
  gl_FragColor = uColor;
#ifdef LOGDEPTH_FRAGMENT
  logDepthFragment();
#endif
}
