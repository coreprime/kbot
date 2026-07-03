// Explosion-mesh fragment shader.  Emissive vertex colour straight
// through — additive blending and the CPU-side luminance budget (see
// explosion-fx.js) decide how bright the composite may get, so the
// shader itself stays a passthrough that bloom can pick up.
precision mediump float;

varying vec4 vColor;

void main() {
  gl_FragColor = vColor;
}
