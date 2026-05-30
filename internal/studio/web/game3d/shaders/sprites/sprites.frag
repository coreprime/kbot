// Animated bitmap-projectile fragment shader.  Samples the current
// frame of the sprite atlas (looked up via per-particle UV rect) and
// multiplies it by the per-particle tint.  Transparent pixels in the
// source PNG (from the GAF's transparency index) carry alpha=0; we
// pre-multiply by the sampled alpha so the additive blend the renderer
// uses (gl.ONE / gl.ONE) doesn't leak a coloured box around the sprite.

precision mediump float;

uniform sampler2D uAtlas;

varying vec4 vColor;
varying vec4 vUvRect;

void main() {
  // gl_PointCoord is (0,0) at top-left → (1,1) at bottom-right of the
  // point sprite.  Map it into the per-frame sub-rect to sample the
  // current animation frame.
  vec2 uv = vec2(
    mix(vUvRect.x, vUvRect.z, gl_PointCoord.x),
    mix(vUvRect.y, vUvRect.w, gl_PointCoord.y)
  );
  vec4 tex = texture2D(uAtlas, uv);
  // Drop fully-transparent texels entirely — cheaper than blending and
  // means the projectile silhouette stays crisp regardless of how big
  // the point sprite gets at close camera distance.
  if (tex.a < 0.02) discard;
  vec4 c = tex * vColor;
  // Pre-multiplied additive output so smoke puffs behind the projectile
  // don't occlude it (matches the existing particle shader's blend
  // convention).
  gl_FragColor = vec4(c.rgb * c.a, c.a);
}
