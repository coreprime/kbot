// Bloom bright-pass — keeps only the pixels brighter than uThreshold
// (the sun glints, muzzle flashes, lasers, glowing panels) and fades
// them in by how far over the threshold they sit, so the blur + add
// downstream only glows the genuinely bright parts of the frame.

precision highp float;
varying vec2 vUV;
uniform sampler2D uTex;     // scene colour
uniform float uThreshold;   // luma cutoff (0..1)

void main() {
  vec3 c = texture2D(uTex, vUV).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float k = max(0.0, l - uThreshold) / max(0.0001, 1.0 - uThreshold);
  gl_FragColor = vec4(c * k, 1.0);
}
