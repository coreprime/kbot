// Map-feature batch fragment shader: cheap matte lighting for thousands
// of baked low-poly stand-ins — one directional sun + a hemispheric
// ambient, the scene's dynamic pulse lights (so weapon fire washes the
// forest), and the same horizon haze the battlefield mesh fades into.
// No shadow-map taps: features are small, matte and numerous, so the
// two texture fetches per fragment would cost more than the soft AO
// baked into their vertex colours is worth.

precision mediump float;

#define MAX_PULSE_LIGHTS 256

varying vec3 vNormal;
varying vec3 vColor;
varying vec3 vWorldPos;

uniform vec3 uLightDir;      // toward the sun
uniform vec3 uSunTint;       // sun colour normalised to max-channel 1
uniform vec3 uHorizonColor;  // sky horizon for the distance haze
uniform vec3 uEyePos;
uniform float uExposure;
uniform float uMapFog;       // 1 = haze on, matches the map mesh

uniform vec3 uPulseLightPos[MAX_PULSE_LIGHTS];
uniform vec3 uPulseLightColor[MAX_PULSE_LIGHTS];
uniform float uPulseLightRange[MAX_PULSE_LIGHTS];
uniform int uPulseLightCount;

void main() {
  vec3 n = normalize(vNormal);
  float diff = max(0.0, dot(n, normalize(uLightDir)));
  // Hemispheric ambient: up-facing surfaces read brighter (sky fill).
  float amb = 0.34 + 0.16 * max(0.0, n.y);
  vec3 col = vColor * (amb + diff * 0.85);
  col *= mix(vec3(1.0), uSunTint, 0.45);
  // Dynamic weapon-light wash (muzzle flashes, explosions).
  vec3 pulse = vec3(0.0);
  for (int i = 0; i < MAX_PULSE_LIGHTS; i++) {
    if (i >= uPulseLightCount) break;
    float range = uPulseLightRange[i];
    if (range <= 0.0) continue;
    float d = distance(uPulseLightPos[i], vWorldPos) / range;
    pulse += uPulseLightColor[i] * (1.0 / (1.0 + d * d)) * 0.30;
  }
  col += vColor * pulse;
  float dCam = length(uEyePos - vWorldPos);
  col = mix(col, uHorizonColor, smoothstep(1800.0, 5500.0, dCam) * 0.78 * uMapFog);
  gl_FragColor = vec4(col * uExposure, 1.0);
}
