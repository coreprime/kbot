// Map-feature batch fragment shader: cheap lighting for thousands of
// baked low-poly stand-ins — one directional sun + a hemispheric ambient,
// the scene's dynamic pulse lights (so weapon fire washes the forest),
// and the same horizon haze the battlefield mesh fades into.  No
// shadow-map taps: features are small and numerous, so the two texture
// fetches per fragment would cost more than the soft AO baked into their
// vertex colours is worth.
//
// Each vertex carries a material pair (metalness, emissive).  Metallic
// features (the metal-deposit plates, steel scatter, crystals) get a
// Blinn specular highlight from the sun and the pulse lights so they read
// as reflective plating that catches the light — not flat grey cardboard.
// Emissive features (vent throats) add their own colour so they glow hot
// even in shadow.

precision mediump float;

#include "../lib/logdepth.glsl"

#define MAX_PULSE_LIGHTS 256

varying vec3 vNormal;
varying vec3 vColor;
varying vec3 vWorldPos;
varying vec2 vMaterial;   // x = metalness, y = emissive

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
#ifdef LOGDEPTH_FRAGMENT
  logDepthFragment();
#endif
  vec3 n = normalize(vNormal);
  // Two-sided matte lighting: the low-poly stand-ins are flat-shaded and
  // some faces (canopy undersides, terrain-conforming decals) can present a
  // back-face to the camera.  Flip the normal toward the eye so those faces
  // still catch the sun instead of collapsing to near-black.
  vec3 toEye = normalize(uEyePos - vWorldPos);
  if (dot(n, toEye) < 0.0) n = -n;
  vec3 L = normalize(uLightDir);
  float diff = max(0.0, dot(n, L));
  // Hemispheric ambient: up-facing surfaces read brighter (sky fill).
  float amb = 0.34 + 0.16 * max(0.0, n.y);
  vec3 col = vColor * (amb + diff * 0.85);
  col *= mix(vec3(1.0), uSunTint, 0.45);

  float metal = vMaterial.x;
  // Sun specular (Blinn-Phong half-vector).  Metallic features tint the
  // highlight toward their own colour (real metal reflects its own hue),
  // matte features get none.  The tight exponent + boosted metalness give
  // a bright, plate-like glint that clearly reads as a reflective surface.
  if (metal > 0.001) {
    vec3 h = normalize(L + toEye);
    float spec = pow(max(0.0, dot(n, h)), 48.0);
    vec3 specTint = mix(uSunTint, vColor * 2.0 + uSunTint, 0.6);
    col += specTint * (spec * metal * 2.2 * diff);
    // A faint fresnel rim lifts grazing angles so the plate edge catches
    // the sky even when the highlight is off to one side.
    float fres = pow(1.0 - max(0.0, dot(n, toEye)), 3.0);
    col += vColor * (fres * metal * 0.25);
  }

  // Dynamic weapon-light wash (muzzle flashes, explosions).
  vec3 pulse = vec3(0.0);
  vec3 pulseSpec = vec3(0.0);
  for (int i = 0; i < MAX_PULSE_LIGHTS; i++) {
    if (i >= uPulseLightCount) break;
    float range = uPulseLightRange[i];
    if (range <= 0.0) continue;
    vec3 toLight = uPulseLightPos[i] - vWorldPos;
    float d = length(toLight) / range;
    float atten = 1.0 / (1.0 + d * d);
    pulse += uPulseLightColor[i] * atten * 0.30;
    // Metal also throws a specular glint back from weapon light so the
    // plate visibly flashes when fire washes over it.
    if (metal > 0.001) {
      vec3 hp = normalize(normalize(toLight) + toEye);
      float sp = pow(max(0.0, dot(n, hp)), 48.0);
      pulseSpec += uPulseLightColor[i] * (sp * atten);
    }
  }
  col += vColor * pulse;
  col += pulseSpec * (metal * 1.6);

  // Emissive glow (vent throats) — added straight, so it survives shadow
  // and reads as heat radiating from within.
  col += vColor * vMaterial.y;

  float dCam = length(uEyePos - vWorldPos);
  col = mix(col, uHorizonColor, smoothstep(1800.0, 5500.0, dCam) * 0.78 * uMapFog);
  gl_FragColor = vec4(col * uExposure, 1.0);
}
