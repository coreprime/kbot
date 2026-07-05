// logdepth.glsl — shared logarithmic-depth helpers.
//
// A perspective projection with a distant far plane wastes almost all of
// its depth precision on the near band (NDC z is ~1/w), so far geometry —
// wind turbines seen across a big map, terrain seams, decals lying on the
// terrain — z-fights and flickers. Logarithmic depth remaps the written
// depth to log2(w), spreading precision evenly across the whole range and
// removing the distance z-fighting without moving the near plane in.
//
// The whole block is gated on LOGDEPTH, which the renderer #defines (and
// enables GL_EXT_frag_depth for) only when the extension is present. When
// it's absent the shaders compile unchanged and rely on the renderer's
// raised-near-plane fallback instead.
//
// Usage:
//   vertex:   after gl_Position is set, call logDepthVertex();
//   fragment: as the last statement, call logDepthFragment();
//   both share uLogDepthFC (= 2.0 / log2(far + 1.0)), set per frame.

#ifdef LOGDEPTH
uniform highp float uLogDepthFC;   // 2.0 / log2(far + 1.0)
varying highp float vLogZ;         // gl_Position.w + 1.0, interpolated
#endif

#ifdef LOGDEPTH_VERTEX
void logDepthVertex() {
  // Carry w (+1 to keep the log argument >= 1) to the fragment stage.
  // gl_Position.z is left at its perspective value; the fragment shader
  // overrides gl_FragDepth so the interpolated, perspective-correct log of
  // w drives the depth test.
  vLogZ = 1.0 + gl_Position.w;
}
#endif

#ifdef LOGDEPTH_FRAGMENT
void logDepthFragment() {
  // half * log2(vLogZ) maps [near..far] onto [0..1] monotonically. clamp
  // guards against a w that dips just below 1 for geometry at the near plane.
  gl_FragDepthEXT = log2(max(1e-6, vLogZ)) * (0.5 * uLogDepthFC);
}

// logDepthFragmentBiased writes the same log depth pulled toward the camera by
// `bias` (a small positive constant in [0..1] depth units). glPolygonOffset
// biases the interpolated gl_Position.z, which the log-depth path OVERRIDES
// with gl_FragDepthEXT — so polygon offset is a no-op once log depth is on, and
// coplanar terrain decals z-fight regardless. Subtracting a firm constant here
// is the log-depth equivalent: it lifts the decal off the terrain in written
// depth so it always wins the LEQUAL test against the surface it lies on.
//
// A CONSTANT bias alone is not enough at GRAZING angles: there the written
// depth changes fast across a fragment (a steep screen-space slope), so a
// coplanar decal and the terrain under it land within the constant of each
// other and flicker. When screen-space derivatives are available we add a
// SLOPE-SCALED term — fwidth of the written depth — so the offset grows with
// the surface's depth gradient, exactly like glPolygonOffset's slope factor
// but in the log-depth domain. This is what removes the residual grazing-angle
// z-fight; without the extension it degrades to the constant bias.
void logDepthFragmentBiased(float bias) {
  float d = log2(max(1e-6, vLogZ)) * (0.5 * uLogDepthFC);
#ifdef LOGDEPTH_DERIV
  // Slope term: the depth change across one fragment, scaled up so a steep
  // (grazing) slope firmly clears the decal off the surface it lies on.
  float slope = fwidth(d) * 2.0;
  gl_FragDepthEXT = d - bias - slope;
#else
  gl_FragDepthEXT = d - bias;
#endif
}
#endif
