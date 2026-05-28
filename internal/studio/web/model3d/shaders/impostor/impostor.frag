// Impostor fragment shader.  Paints each GL_POINTS sprite as a
// soft-edged circle of the provided team / model tint.  A short
// alpha ramp at the edge keeps the dot from reading as a pixelated
// square at the typical 4-10 px sizes the LOD classifier emits.
//
// Premultiplied output so the caller can use the same blend equation
// the particle pass uses (gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA) and
// composite over the ground / sky cleanly.

precision mediump float;
varying vec3 vColor;

void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = length(d);
  if (r > 0.5) discard;
  // Soft edge between r = 0.42 and r = 0.5.  Inside that band the
  // alpha ramps from 1 → 0; the disc reads as a coloured dot with
  // a one-pixel anti-aliased edge at typical impostor sizes.
  float alpha = smoothstep(0.5, 0.42, r);
  gl_FragColor = vec4(vColor, alpha);
}
