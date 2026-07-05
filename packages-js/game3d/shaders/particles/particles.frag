// Particle fragment shader.  Renders each GL_POINTS quad as a soft
// circular splat - distance from the point centre drives an
// alpha falloff so the particle reads as a fluffy puff rather than
// a hard square.

precision mediump float;
varying vec4 vColor;

#include "../lib/logdepth.glsl"

void main() {
  // gl_PointCoord is in [0,1]; centre the disc.
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = length(d);
  // Quadratic falloff for a soft edge.  Discarding past r=0.5
  // skips the off-disc fragments entirely; cheaper than blending
  // to zero alpha.
  if (r > 0.5) discard;
  float alpha = vColor.a * (1.0 - r * 2.0) * (1.0 - r * 2.0);
  // Premultiply rgb by alpha so the renderer can use additive blend
  // (gl.ONE, gl.ONE) without smoke puffs occluding lasers behind
  // them.  Soft falloff at the edge still reads as a circular blob
  // because the modulated alpha attenuates the colour smoothly.
  gl_FragColor = vec4(vColor.rgb * alpha, alpha);
  // Write the SAME logarithmic depth the ground/unit passes wrote, so the
  // additive point tests correctly against the scene it composites over
  // (depth write is off in this pass, so this only affects the TEST — a mote
  // in front of the terrain now passes instead of being buried by the
  // log-vs-perspective depth mismatch).
  logDepthFragment();
}
