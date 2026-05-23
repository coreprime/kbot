// Wireframe fragment shader.  Flat uniform colour, alpha included so
// the renderer can blend semi-transparent overlays.

precision mediump float;
uniform vec4 uColor;
void main() { gl_FragColor = uColor; }
