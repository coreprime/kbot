// Shadow-map fragment shader.  Honours alpha-keyed texels - without
// this transparent decals would still cast solid shadows.

precision mediump float;
varying vec2 vUV;
uniform sampler2D uTex;
uniform int uMode;
void main() {
  if (uMode == 0) {
    vec4 s = texture2D(uTex, vUV);
    if (s.a < 0.5) discard;
  }
  gl_FragColor = vec4(1.0);
}
