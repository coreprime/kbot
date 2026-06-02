// Bloom separable Gaussian blur — run twice (horizontal then vertical)
// over the half-res bright-pass texture.  uDir carries the per-tap step
// in UV space (texel size * spread) so the same shader does both axes.

precision highp float;
varying vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uDir;   // UV-space step between taps

void main() {
  vec3 sum = texture2D(uTex, vUV).rgb * 0.227027;
  sum += texture2D(uTex, vUV + uDir * 1.0).rgb * 0.1945946;
  sum += texture2D(uTex, vUV - uDir * 1.0).rgb * 0.1945946;
  sum += texture2D(uTex, vUV + uDir * 2.0).rgb * 0.1216216;
  sum += texture2D(uTex, vUV - uDir * 2.0).rgb * 0.1216216;
  sum += texture2D(uTex, vUV + uDir * 3.0).rgb * 0.0540540;
  sum += texture2D(uTex, vUV - uDir * 3.0).rgb * 0.0540540;
  sum += texture2D(uTex, vUV + uDir * 4.0).rgb * 0.0162162;
  sum += texture2D(uTex, vUV - uDir * 4.0).rgb * 0.0162162;
  gl_FragColor = vec4(sum, 1.0);
}
