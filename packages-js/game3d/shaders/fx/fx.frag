// Explosion-mesh fragment shader.  Emissive vertex colour straight
// through — additive blending and the CPU-side luminance budget (see
// explosion-fx.js) decide how bright the composite may get, so the
// shader itself stays a passthrough that bloom can pick up.
//
// It writes the shared logarithmic depth so the explosion's depth TEST
// matches the terrain/model passes (which override gl_FragDepth the same
// way).  Without this a blast writes plain perspective z while terrain
// writes log2(w): the depth comparison is meaningless, so a rising mushroom
// cloud is wrongly occluded by the hillside it should tower over.  The pass
// still leaves depthMask off (additive fire never occludes the scene), but a
// blast behind a ridge is now correctly clipped and one above the terrain
// correctly draws in front of it.
precision mediump float;

#include "../lib/logdepth.glsl"

varying vec4 vColor;

void main() {
  gl_FragColor = vColor;
#ifdef LOGDEPTH_FRAGMENT
  logDepthFragment();
#endif
}
