// Main scene fragment shader - everything that paints the unit.
// Builds up the lit colour from:
//   * Hemisphere ambient * baked AO         (#80 contact shadows)
//   * Key light + soft fill + back rim       (#84 three-point)
//   * Fresnel rim using true view direction  (#86 silhouette glow)
//   * Blinn-Phong specular sheen             (#81 panel highlights)
//   * Two-sun support (twin-sun environments)
//   * Sea bounce + sun shimmer (Sea mode only)
//   * Team-colour hue shift                   (#82)
//   * Reflection-pass tinting + clipping     (water reflection)

// Screen-space derivatives (dFdx/dFdy) for the auto-bump surface hint.
// `enable` (not require) so hardware without the extension still links —
// the bump branch is gated off there by the renderer anyway.
#extension GL_OES_standard_derivatives : enable
precision highp float;
precision highp int;

// Dynamic pulse-light slot count — the hard ceiling on simultaneous dynamic
// lights.  Must stay in lockstep with MAX_PULSE_LIGHTS in
// engine/scene-lights.js (the controller sizes its uniform-array uploads to
// it).  uPulseLightCount carries how many slots are actually live this frame
// (the "Dynamic Lights" graphics option) so the loop early-outs well before
// this ceiling at normal settings.
#define MAX_PULSE_LIGHTS 256

#include "../lib/sea-waves.glsl"

varying vec2 vUV;
varying vec3 vNormal;
varying vec3 vWorldPos;
varying vec4 vLightSpacePos;
varying vec4 vLightSpacePos2;
varying float vAO;
uniform sampler2D uTex;
uniform sampler2D uShadowMap;
uniform sampler2D uShadowMap2;
uniform int uMode;            // 0 = textured, 1 = flat colour
uniform vec4 uTint;
uniform vec3 uLightDir;       // direction the light is coming FROM (toward sun)
uniform vec3 uLightColor;
uniform vec3 uLightDir2;      // second light (twin-sun worlds), zero colour = inactive
uniform vec3 uLightColor2;
uniform vec3 uSkyColor;       // hemisphere ambient when normal points up
uniform vec3 uGroundColor;    // hemisphere ambient when normal points down
uniform vec3 uEyePos;         // world-space camera position - for view-direction rim + specular
uniform vec3 uFillColor;      // cinematic 3-point fill light tint (counter-key side)
uniform vec3 uBackColor;      // cinematic 3-point back light tint (rim/separation behind unit)
uniform float uShadowEnabled; // 1 if uShadowMap is bound to a real depth texture, else 0
uniform float uShadowBias;
uniform float uShadowStrength; // 0..1 — user shadow intensity (Graphics Options); scales how dark self-shadows go
uniform float uSelfShadow;     // 1 = the unit shadows its own geometry, 0 = self-shadowing off (cast ground shadow unaffected)
uniform float uFlatLighting;  // 1 = no directional/ambient/shadow, full bright (Flat display mode)
uniform float uReflectionTint; // 1 = output is dimmed + blue-tinted, used by the water reflection pass
uniform float uSeaActive;     // 1 in Sea mode - adds caustic bounce light + sun shimmer to the hull
uniform float uTime;          // shared sea time (for the bounce light to animate with the water)
uniform float uWaterY;        // world Y of the water plane - fades reflections out above it
uniform float uWaterOnHull;   // Water Surface Reflections toggle - 0 disables hull bounce/shimmer
uniform vec3 uTeamColor;      // selected team colour in linear RGB
uniform float uTeamColorEnable; // 0 = original blue (no recolour), 1 = hue-shift toward uTeamColor
uniform float uSpecScale;       // per-batch specular multiplier — >1 on Surface-Hints-detected metal textures, 1 elsewhere
uniform float uSpecularEnabled; // "Specular Highlights" master toggle — gates ALL hull shine (incl. Surface Hints)
uniform float uSpecularStrength;// "Specular Highlights" intensity slider; 1 = default
uniform float uRunningLights;   // Surface-hint "running lights" — colour-keyed blinking emissive lights (corv06a/b)
uniform float uRLEmit;          // running-lights per-texture emissive strength (hint)
uniform float uRLStrength;      // "Running Lights" intensity slider; 1 = default
uniform float uRLFadeOut;       // running-lights fade-out opacity (0..1): 0 = dim phase keeps the original texture, 1 = dim phase fades to black
uniform float uRLPhaseBuckets;  // running-lights timing: quantise hue into this many blink-phase buckets so similar shades pulse together (RUNNING_LIGHT_TIMING_BUCKETS)
uniform sampler2D uLampMap;     // running-lights lamp atlas — per-texel RGB = the texel's lamp's single dominant colour, A = lamp membership (built CPU-side)
uniform float uLampMapValid;    // 1 when uLampMap holds a real atlas for this batch, 0 = no lamps this draw
uniform float uBump;            // Surface-hint auto-bump — perturb the normal from the tile's luminance gradient
uniform float uBumpIntensity;   // bump relief strength (per-texture hint)
uniform float uBumpStrength;    // "Bump Mapping" intensity slider; 1 = default
uniform float uBumpSmooth;      // bump height-field low-pass radius (texels) — drops fine roughness so only large details bump
uniform float uBumpThreshold;   // bump grain deadzone — height gradients below this are dropped (grain → flat) while strong edges (rivets/seams) survive
uniform float uBumpScale;       // SIGNED relief depth: + = features protrude toward the viewer, − = recessed/engraved; magnitude deepens the normal tilt
uniform vec2  uTexel;           // 1 / texture size — texel step for texture-space bump sampling
uniform float uExposure;        // scene light-intensity / exposure (Graphics Options Brightness slider); 1 = default
uniform float uOutputAlpha;   // 1 = fully opaque (default); < 1 fades the textured pass for the build-progress nano-frame effect
// uLightingTier — Phase 2 perf knob.  0 = full (rim + back/fill +
// Blinn-Phong specular all contribute), 1 = cheap (Lambertian +
// ambient only).  The renderer sets this to 1 for entities that the
// shadow LOD already gave up on (px < ~40); the user can't tell the
// difference at that screen size, and we save the per-fragment
// Fresnel power + half-vector dot + back-light direction maths.
uniform float uLightingTier;
// Dynamic point lights — fed each frame by the controller from the
// strongest "light-emitting" active particles (tracer shells, d-gun, laser
// pulse).  Range 0 in a slot means no active light there, so the shader skips
// it with no measurable cost.  Range is the world-unit radius at which the
// contribution falls to ~half; we use 1/(1+(d/r)²) attenuation.
uniform vec3 uPulseLightPos[MAX_PULSE_LIGHTS];
uniform vec3 uPulseLightColor[MAX_PULSE_LIGHTS];
uniform float uPulseLightRange[MAX_PULSE_LIGHTS];
uniform int uPulseLightCount;
// Unit world-space centre — used by the pulse-light path to apply
// self-occlusion: fragments whose position vector (from centre)
// points AWAY from the light direction are inside the unit's own
// shadow as cast by the projectile.  Without this the back of the
// hull picks up the light through the unit's own body, washing the
// whole silhouette uniformly.
uniform vec3 uUnitCenter;
// Approximate world radius of the unit's bounding sphere.  Drives
// how sharply self-occlusion ramps in; a small unit shadows itself
// at finer distance, a big unit needs a larger transition band.
uniform float uUnitRadius;

// uPieceGlow — additive emissive RGBA contributed by per-piece-name
// overrides (see piece-light-overrides.js).  rgb = the lamp colour at
// peak intensity, a = current pulse intensity in [0..1] computed JS-
// side from the override's blink curve so the shader stays simple +
// branchless.  Zero alpha = no override on this piece (the default;
// every uncovered piece pays one mul-then-add of zero, which is
// cheaper than a conditional).
//
// The glow is added after tone-map / cinematic so it stays punchy and
// trips the bloom bright-pass, the same way the texture-keyed running
// lights do.  Lives in WORLD-emit space (no shading applied) — these
// are "the piece itself glows," not "the piece is lit by something."
uniform vec4  uPieceGlow;

// rgbToHsv / hsvToRgb come from the standard Sam Hocevar GLSL
// formulation - branchless, suitable for fragment shaders.  We use
// them to detect blue-team palette pixels by hue and shift them to
// the picker's chosen team colour without disturbing other
// colours on the texture.
vec3 rgbToHsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsvToRgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

// sampleShadowMap1: 3x3 PCF tap into the primary shadow map.  Kept
// as a separate function from sampleShadowMap2 because WebGL1
// doesn't allow sampler arrays or sampler indexing - each map
// gets its own copy of the sampling code.
float sampleShadowMap1(vec3 normal) {
  if (uShadowEnabled < 0.5) return 1.0;
  vec3 proj = vLightSpacePos.xyz / vLightSpacePos.w;
  proj = proj * 0.5 + 0.5;
  if (proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0 || proj.z > 1.0) return 1.0;
  float ndl = max(0.0, dot(normalize(normal), normalize(uLightDir)));
  float bias = max(uShadowBias * (1.0 - ndl), 0.0005);
  float lit = 0.0;
  float texel = 1.0 / 1024.0;
  for (int dx = -1; dx <= 1; dx++) {
    for (int dy = -1; dy <= 1; dy++) {
      float depth = texture2D(uShadowMap, proj.xy + vec2(float(dx), float(dy)) * texel).r;
      lit += (proj.z - bias < depth) ? 1.0 : 0.0;
    }
  }
  return lit / 9.0;
}
float sampleShadowMap2(vec3 normal) {
  if (uShadowEnabled < 0.5) return 1.0;
  vec3 proj = vLightSpacePos2.xyz / vLightSpacePos2.w;
  proj = proj * 0.5 + 0.5;
  if (proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0 || proj.z > 1.0) return 1.0;
  float ndl = max(0.0, dot(normalize(normal), normalize(uLightDir2)));
  float bias = max(uShadowBias * (1.0 - ndl), 0.0005);
  float lit = 0.0;
  float texel = 1.0 / 1024.0;
  for (int dx = -1; dx <= 1; dx++) {
    for (int dy = -1; dy <= 1; dy++) {
      float depth = texture2D(uShadowMap2, proj.xy + vec2(float(dx), float(dy)) * texel).r;
      lit += (proj.z - bias < depth) ? 1.0 : 0.0;
    }
  }
  return lit / 9.0;
}

// bumpHeight — the tile's luminance read as a surface HEIGHT (white = tall).
// `bias` shifts the mip so the height field follows the LARGE painted detail
// (panel breaks, rivet rows) rather than per-texel palette grain.  Feeds the
// tangent-space gradient that perturbs the shading normal.
float bumpHeight(vec2 uv, float bias) {
  return dot(texture2D(uTex, uv, bias).rgb, vec3(0.299, 0.587, 0.114));
}

void main() {
  // Geometric (macro) normal.  Ng stays the flat surface normal for the broad
  // coloured environment fills; N below gets sculpted by the bump height field
  // so only the KEY sun diffuse + specular pick up the surface relief.
  vec3 N = normalize(vNormal);
  vec3 Ng = N;
  vec2 uv = vUV;

  // Mikkelsen cotangent tangent frame from screen-space position + UV
  // derivatives — gives the bump a per-fragment tangent basis with no
  // precomputed per-vertex tangents.  Guarded against degenerate UVs: on
  // flat-coloured / non-textured faces duv≈0 collapses T and B to ~0, and an
  // unguarded inversesqrt(0) → +Inf would splatter NaN colour across the face
  // (the "strange colour distortion").  tbValid gates the bump branch below.
  vec3 dp1 = dFdx(vWorldPos), dp2 = dFdy(vWorldPos);
  vec2 duv1 = dFdx(vUV),      duv2 = dFdy(vUV);
  vec3 dp2perp = cross(dp2, N);
  vec3 dp1perp = cross(N, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float tbMax = max(dot(T, T), dot(B, B));
  bool tbValid = tbMax > 1e-10;
  if (tbValid) {
    float tbInv = inversesqrt(tbMax);
    T *= tbInv;
    B *= tbInv;
  }

  vec4 base;
  if (uMode == 1) {
    base = uTint;
  } else {
    base = texture2D(uTex, uv);
  }
  if (base.a < 0.5) discard;

  // Team-colour recolouring.  TA bakes the player's team colour into
  // a specific ramp of the palette - for our PNGs that lands in the
  // blue range (hue ~= 225 deg, normalised ~= 0.62).  We detect those
  // pixels by hue + saturation and rotate them to the picker's
  // chosen team colour, preserving the original ramp's value so the
  // shading on the recoloured panels still reads.
  if (uTeamColorEnable > 0.5 && uMode != 1) {
    vec3 hsv = rgbToHsv(base.rgb);
    float dh = abs(hsv.x - 0.62);
    if (dh > 0.5) dh = 1.0 - dh;
    if (dh < 0.08 && hsv.y > 0.30) {
      vec3 teamHsv = rgbToHsv(uTeamColor);
      hsv.x = teamHsv.x;
      // Lift saturation to the team colour's so the recolour reads
      // confidently - TA's pre-rendered blue pixels can be lower
      // saturation than a saturated red/yellow team accent.
      hsv.y = clamp(max(hsv.y, teamHsv.y * 0.75), 0.0, 1.0);
      base.rgb = hsvToRgb(hsv);
    }
  }

  // Reflection pass clipping: when this draw is the mirrored
  // copy, any fragment whose mirrored world Y is ABOVE the
  // waterline came from the original under-water portion of the
  // hull and would visibly interpenetrate with the original unit.
  // Drop those fragments so only the genuine "below water"
  // reflection of the above-water hull remains.
  if (uReflectionTint > 0.5 && vWorldPos.y > uWaterY) discard;

  // Flat display mode: pass the texture (or tint) straight through,
  // skipping shadows + directional + ambient.  Used for diagnosing
  // texture issues with no shading bias.
  if (uFlatLighting > 0.5) {
    gl_FragColor = vec4(base.rgb, 1.0);
    return;
  }

  // Relief bump — sculpt the shading normal from the tile's luminance height
  // field so painted plating / rivets / panel seams catch light and shade as
  // both the camera and the sun move.  It's a true tangent-space normal, NOT
  // a UV warp, so it can never pull a neighbouring atlas tile into the face
  // (the old parallax march did, which is what read as colour distortion).
  // Ng — the macro geometric normal — is kept for the broad coloured fills
  // (hemisphere ambient, cinematic fill, back light, fresnel rim, sea bounce)
  // so the bump can't scatter their tint; only the KEY sun diffuse + specular
  // ride the bumped N, where surface relief genuinely reads.  uBumpScale's
  // sign flips the relief (+ protrudes / lit on the sun-facing slope, −
  // engraves); its magnitude deepens the tilt.  tbValid skips degenerate
  // (flat-UV) faces so the frame can't blow up.
  if (uBump > 0.5 && uMode != 1 && tbValid && uBumpIntensity > 0.0) {
    float sm = max(uBumpSmooth, 1.0);
    float bias = log2(sm) + 1.0;     // low-pass to LARGE features, not grain
    vec2 d = uTexel * sm;            // central-difference step
    float hL = bumpHeight(uv - vec2(d.x, 0.0), bias);
    float hR = bumpHeight(uv + vec2(d.x, 0.0), bias);
    float hD = bumpHeight(uv - vec2(0.0, d.y), bias);
    float hU = bumpHeight(uv + vec2(0.0, d.y), bias);
    float dHdu = (hR - hL) * 0.5;   // ∂height/∂u
    float dHdv = (hU - hD) * 0.5;   // ∂height/∂v
    // Soft grain rolloff — a gentle rational knee that de-emphasises tiny
    // palette noise but always lets real slope through.  (The old hard
    // subtract-threshold zeroed every gradient below uBumpThreshold, which
    // left the relief completely unshaded — the "no real shading" report.)
    float gm = length(vec2(dHdu, dHdv));
    float keep = gm / (gm + max(uBumpThreshold, 1e-3));
    dHdu *= keep;
    dHdv *= keep;
    // Signed relief strength — sign(uBumpScale) flips protrude vs engrave,
    // |scale| (× the global Bump slider) deepens the tilt.  6× turns the small
    // luminance slope into a clearly readable surface tilt without tipping
    // into high-frequency shading noise.
    float k = uBumpIntensity * uBumpStrength * abs(uBumpScale) * 6.0
              * ((uBumpScale < 0.0) ? -1.0 : 1.0);
    // Build the height-field normal in tangent space, then rotate it into
    // world space through the cotangent frame.  z = 1 bounds the tilt so even
    // a steep gradient can't flip the normal past the surface plane.
    vec3 tn = normalize(vec3(-dHdu * k, -dHdv * k, 1.0));
    N = normalize(tn.x * T + tn.y * B + tn.z * Ng);
  }
  vec3 L = normalize(uLightDir);
  vec3 V = normalize(uEyePos - vWorldPos);
  float ndl = max(0.0, dot(N, L));
  // 3DO has no consistent winding direction, so we treat the
  // brighter face as the front - symmetric lighting reads
  // correctly from either side.
  ndl = max(ndl, max(0.0, dot(-N, L)) * 0.4);

  // Hemisphere ambient: sky tint from above, ground tint from below.
  // Multiplied by the texture so the colour temperature shifts with
  // the unit's pose (under-side picks up the warm ground bounce).
  // Baked AO darkens it in crevices so contact shadows read without
  // a screen-space pass.  AO is biased toward 1 so flat panels stay
  // open - only true creases pick up the darkening.
  float hemiMix = clamp(Ng.y * 0.5 + 0.5, 0.0, 1.0);
  // Ambient is a FILL, not a second key.  uSkyColor sits near 1.0 (it
  // also tints the sky/ground), so taking it un-scaled lit every face
  // to ~full texture value — flattening contrast and, once the bright
  // key piled on top and the tone curve compressed it, washing the
  // textures out.  Scale it to a fill level so shadow sides read as
  // shadow and the key actually sculpts the form.
  vec3 ambient = mix(uGroundColor, uSkyColor, hemiMix) * vAO * 0.55;

  // Cinematic 3-point lighting: the key light is uLightDir/uLightColor
  // (already the scene sun).  Fill kicks in from the OPPOSITE side
  // of the camera to lift the shadow side without flattening the
  // form.  Back light pushes a bright edge along the silhouette
  // facing away from the camera so the unit detaches from the
  // background.  Both lights are subordinate to the key and AO so
  // they don't wash out genuine sculpting.
  vec3 fillDir = normalize(vec3(-L.x, max(0.1, L.y * 0.4), -L.z));
  float ndf = max(0.0, dot(Ng, fillDir));
  ndf = max(ndf, max(0.0, dot(-Ng, fillDir)) * 0.4);
  vec3 fillLight = ndf * uFillColor * 0.55;

  // Cheap-tier (uLightingTier >= 0.5) — skip the rim, back-light, and
  // Blinn-Phong specular contributions.  The unit at this distance
  // reads as a small silhouette where the user can't tell the
  // difference; we save the per-fragment Fresnel-power + half-vector
  // dot + back-light direction maths.  Same threshold as the shadow
  // LOD: when shadows are already culled, lighting is too.
  bool cheapLighting = uLightingTier >= 0.5;

  // Back light: comes from BEHIND the unit relative to the camera,
  // tilted slightly above so it grazes the top edges.
  vec3 backLight = vec3(0.0);
  if (!cheapLighting) {
    vec3 backDir = normalize(vec3(-V.x, 0.3, -V.z));
    float ndb = max(0.0, dot(Ng, backDir));
    ndb = max(ndb, max(0.0, dot(-Ng, backDir)) * 0.4);
    backLight = pow(ndb, 4.0) * uBackColor * 0.7;
  }

  // True view-direction rim light - Fresnel-style 1 - max(0, N.V).
  // Picks out the silhouette as the camera orbits, not just the
  // unit's local up.  AO suppresses it inside crevices where a
  // silhouette ramp would otherwise look wrong.
  vec3 rim = vec3(0.0);
  if (!cheapLighting) {
    float fresnel = pow(1.0 - max(0.0, dot(Ng, V)), 4.0);
    rim = fresnel * mix(uSkyColor, uLightColor, 0.6) * 0.35 * vAO;
  }

  // Blinn-Phong specular sheen - the half-vector between L and V
  // dotted with N, raised to a moderate exponent for a panel-style
  // sheen rather than a glassy point.  Modulated by the texture
  // alpha later so the sheen rides on the material brightness.
  // Specular exponent.  TA hulls are chunky + low-poly and the sun sits
  // high, so a tight exponent (32) put N·H below the highlight threshold
  // on almost every face — the sheen never appeared.  A broad exponent
  // (14) gives a satin highlight that actually reads across the faceted
  // surfaces; metal batches still read sharper because they get 3× the
  // strength via uSpecScale.
  float spec = 0.0;
  if (!cheapLighting) {
    vec3 H = normalize(L + V);
    spec = pow(max(0.0, dot(N, H)), 14.0);
    // Also sheen the back-side a little - symmetric like ndl above.
    float specBack = pow(max(0.0, dot(-N, H)), 14.0) * 0.4;
    spec = max(spec, specBack);
  }

  // Self-shadow term — gated by the Graphics Options self-shadow
  // checkbox (uSelfShadow) and scaled by the shadow-intensity slider
  // (uShadowStrength).  When self-shadowing is off (or intensity 0)
  // the unit lights as if it never occludes itself; the cast shadow on
  // the ground is handled separately in the ground shader, so it stays.
  float shadow = mix(1.0, sampleShadowMap1(N), uShadowStrength * uSelfShadow);
  vec3 directLight = ndl * uLightColor * shadow;
  // Specular gating.  "Specular Highlights" (uSpecularEnabled) is the
  // master switch for ALL hull shine and uSpecularStrength is its
  // intensity slider.  "Surface Hints" only raises uSpecScale (1 → 3) on
  // textures whose name reads as metal, so it builds ON TOP of the base
  // specular rather than acting on its own — no specular, no metal glint.
  // specK is 0.85 baseline (vs the old 0.45) so the highlight registers
  // after the tone curve.
  float specOn = (uSpecularEnabled > 0.5) ? 1.0 : 0.0;
  float specK = 0.60 * specOn * uSpecularStrength;
  vec3 specular = spec * uLightColor * shadow * specK * uSpecScale;
  // Second sun contribution - twin-sun environments fill this in
  // with a non-zero colour, single-sun worlds leave it black and
  // it costs almost nothing.
  if (dot(uLightColor2, uLightColor2) > 0.0001) {
    vec3 L2 = normalize(uLightDir2);
    float ndl2 = max(0.0, dot(N, L2));
    ndl2 = max(ndl2, max(0.0, dot(-N, L2)) * 0.4);
    float shadow2 = mix(1.0, sampleShadowMap2(N), uShadowStrength * uSelfShadow);
    directLight += ndl2 * uLightColor2 * shadow2;
    if (!cheapLighting) {
      vec3 H2 = normalize(L2 + V);
      float spec2 = pow(max(0.0, dot(N, H2)), 14.0);
      specular += spec2 * uLightColor2 * shadow2 * specK * uSpecScale;
    }
  }
  // fillLight always contributes — it's a single dot product, no
  // power / fresnel maths.  At cheap tier it's the only non-key
  // light source for an otherwise-flat Lambertian appearance.
  vec3 lighting = ambient + directLight + fillLight + backLight + rim;

  // Dynamic pulse light (d-gun / laser).  Two directional terms
  // compose the shading so the unit reads as actually lit BY a
  // point in space rather than uniformly tinted:
  //
  //   1. Strict one-sided Lambert.  Only fragments whose normal
  //      faces toward the light are lit.  No symmetric back-face
  //      wash — that hid TA's inverted-winding facets but uniformly
  //      lit the whole unit, eliminating the directional contrast.
  //
  //   2. Unit self-occlusion.  The unit's own geometry should cast
  //      a shadow on its far side relative to the projectile.  We
  //      approximate this without shadow-map passes by comparing the
  //      fragment's position relative to the unit centre against the
  //      LIGHT direction relative to the centre: when the fragment
  //      sits on the OPPOSITE side of the unit from the light, the
  //      dot is negative and the contribution attenuates smoothly.
  //      A 0.4-radian smoothstep band keeps the boundary feathered.
  //
  // Falls off with inverse-square in distance so close shots flood
  // the unit and distant ones barely tint it.
  for (int pli = 0; pli < MAX_PULSE_LIGHTS; pli++) {
    if (pli >= uPulseLightCount) break;
    vec3 plColor = uPulseLightColor[pli];
    float plRange = uPulseLightRange[pli];
    if (dot(plColor, plColor) <= 0.0001 || plRange <= 0.0) continue;
    vec3 plPos = uPulseLightPos[pli];
    vec3 pulseDir = plPos - vWorldPos;
    float pulseDist = length(pulseDir);
    pulseDir = pulseDir / max(0.0001, pulseDist);
    float ndlPulse = max(0.0, dot(N, pulseDir));
    vec3 fromCentre = vWorldPos - uUnitCenter;
    vec3 lightFromCentre = plPos - uUnitCenter;
    float fcLen = max(0.0001, length(fromCentre));
    float lcLen = max(0.0001, length(lightFromCentre));
    float facing = dot(fromCentre / fcLen, lightFromCentre / lcLen);
    float selfOcclusion = smoothstep(-0.4, 0.4, facing);
    float r = pulseDist / plRange;
    float atten = 1.0 / (1.0 + r * r);
    lighting += plColor * ndlPulse * atten * selfOcclusion;
  }

  // -- Sea bounce light --------------------------------------------
  // When the unit sits on Sea ground, the water below kicks
  // light back up onto the hull two ways:
  //   * Caustic bounce - diffuse glow that rises through the
  //     surface and lights the sides + underside of the hull.
  //     Brightest under the unit; tinted with the lagoon's blue.
  //   * Sun shimmer - sharp diamond highlights where a wave
  //     facet reflects the sun directly at the hull.  Hits
  //     side-facing surfaces best, dances across them as the
  //     waves move.
  if (uSeaActive > 0.5 && uWaterOnHull > 0.5) {
    // Water reflections only land on the SIDES of a hull - the
    // plating that's near the waterline and faces roughly outward.
    // Two gates pick those out:
    //
    //   sideness = 1 - abs(N.y)
    //     Favours horizontal normals.  Tops (N.y ~= +1), bottoms
    //     (N.y ~= -1), and anything in between get progressively
    //     less.  Using abs() makes this robust to 3DO's inverted
    //     winding - the format stores no consistent face direction,
    //     so the renderer can't trust the sign of N.y to mean
    //     "this is the topside".
    //
    //   waterProximity = 1 - smoothstep(0, 8, y - waterY)
    //     A fragment 8 wu above the waterline gets nothing; one at
    //     the waterline gets full strength.  Stops decks + masts
    //     from picking up reflections just because they happen to
    //     have a sideways normal.
    float sideness = 1.0 - abs(Ng.y);
    // Extended falloff (was 8 wu) so the side plating ~12 wu up
    // the hull still picks up some bounce - keeps the effect
    // reading on tall units, not just the boot-stripe.
    float waterProximity = 1.0 - smoothstep(0.0, 12.0, max(0.0, vWorldPos.y - uWaterY));
    float gate = sideness * waterProximity;
    if (gate > 0.001) {
      // Diffuse bounce - kept strong since the user wanted clearly
      // visible reflections on the side plates.
      float caustic = seaCaustic(vWorldPos.xz, uTime);
      vec3 bounceTint = vec3(0.45, 0.95, 1.40);
      lighting += bounceTint * (0.30 + caustic) * gate * 1.40;

      // Sun shimmer - pulled WAY back (3.5 -> 0.9) and modulated by
      // value noise instead of just a pow(dot) so the highlights
      // read as scattered glints rather than a hard gridded grid.
      // The noise also varies in time so the shimmer twinkles
      // instead of moving in a regular pattern.
      vec3 hs = seaWaveHS(vWorldPos.xz, uTime);
      vec3 waveN = normalize(vec3(-hs.y, 1.0, -hs.z));
      vec3 sunRefl = reflect(-L, waveN);
      float shimmerAlign = pow(abs(dot(sunRefl, N)), 14.0);
      float shimmerNoise = seaNoise(vWorldPos.xz * 0.6 + uTime * 0.7);
      float shimmer = shimmerAlign * smoothstep(0.45, 0.85, shimmerNoise);
      lighting += vec3(1.30, 1.10, 0.80) * shimmer * gate;
    }
  }

  // Specular adds on top of (not multiplied with) the diffuse so the
  // highlight stays bright even on dark base textures - a sheen on
  // a black hull should still glint.
  vec3 col = base.rgb * lighting + specular;

  // Running lights surface hint — the saturated colour pixels on the tile
  // (blue / green / yellow status lamps on corv06a/b) blink and glow.
  // We colour-key by relative saturation + brightness and blink each lamp
  // with a phase keyed off its dominant hue (so blue/green/yellow pulse out
  // of step).  Two parts: the lamp pixel is self-lit here so it never sits
  // in shadow, while its additive glow is banked into rlEmissive and applied
  // AFTER the tone curve below — otherwise the Reinhard roll-off crushes the
  // bright lamp back toward the hull and it neither reads as emissive nor
  // feeds the bloom bright-pass.
  vec3 rlEmissive = vec3(0.0);
  if (uRunningLights > 0.5 && uLampMapValid > 0.5 && uMode != 1) {
    // ── Edge guard ──────────────────────────────────────────────────────
    // Fade the effect out within a couple of texels of the tile border.  The
    // outermost texels of a tile are often saturated frame/bleed pixels, and
    // any texture fetch aliases badly where a face is seen edge-on — both
    // light up as stray lamps along a surface's edges.  Distance to the
    // nearest u/v border, in texels (fract keeps it correct for tiled UVs);
    // 0 at the very edge, 1 a couple of texels in.
    vec2 uvf = fract(vUV);
    vec2 edgeUV = min(uvf, 1.0 - uvf);
    float edgePx = min(edgeUV.x / max(uTexel.x, 1e-6), edgeUV.y / max(uTexel.y, 1e-6));
    float edgeFade = smoothstep(0.5, 2.5, edgePx);

    // ── Lamp atlas ───────────────────────────────────────────────────────
    // The lamp atlas (lamp-map.js) has already grouped every proximal /
    // touching lamp texel into one connected component and baked that
    // component's SINGLE dominant colour here.  So an entire lamp shares one
    // colour → one blink phase → one intensity, with no per-pixel colour
    // drift — the split-purple-dot bug is gone because the split came from
    // sampling colour locally per fragment.  The sharp LOD-0 fetch gives
    // crisp membership + colour; a blurred mip gives a soft halo for the haze.
    vec4 lamp = texture2D(uLampMap, vUV);
    vec4 lampSoft = texture2D(uLampMap, vUV, 2.5);
    float member = lamp.a * edgeFade;
    vec3 hue = lamp.rgb;                              // component's vivid colour
    // Blink phase from the component hue, QUANTISED into uRLPhaseBuckets evenly
    // spaced buckets: every lamp whose hue lands in the same bucket pulses on
    // ONE cycle, so two slightly different shades of blue can't drift a little
    // out of phase.  (The CPU colour-merge already harmonises NEAR lamps; this
    // catches similar shades anywhere on the unit.)
    float nb = max(uRLPhaseBuckets, 1.0);
    float phase = (floor(rgbToHsv(hue).x * nb) / nb) * 6.2831853;
    float blink = smoothstep(0.12, 0.88, 0.5 + 0.5 * sin(uTime * 3.5 + phase));

    // Lamp body: recolour to the component colour, pulsing in sync.  The dim
    // phase fades from the original surface (uRLFadeOut 0) toward black (1).
    vec3 lampOff = col * (1.0 - uRLFadeOut);
    vec3 lampOn = hue * (0.95 + 0.55 * uRLStrength);
    col = mix(col, mix(lampOff, lampOn, blink), member);

    // Wide soft glow / hull light-wash from the blurred atlas, edge-faded so
    // it never blooms off the rim of a surface.  Divide out the mip's alpha
    // so the halo keeps the lamp's colour instead of fading toward black at
    // its fringe.
    float glow = smoothstep(0.05, 0.55, lampSoft.a) * edgeFade;
    vec3 glowHue = lampSoft.rgb / max(lampSoft.a, 0.02);
    // The hull-wash glow scales with uRLEmit (as the emissive does below) so the
    // per-texture Emit slider visibly controls how much the lamp lights its
    // surroundings — not just the bloom-only emissive, which reads as "Emit
    // does nothing" on dim/sparse lamps.  Emit 1 = unchanged from before.
    col += glowHue * (glow * blink) * 0.55 * uRLStrength * uRLEmit;   // hull wash (pre-tone)
    // Emissive (post tone curve), boosted so low-luma coloured lamps (blue /
    // teal weigh little in luma) still clear the bloom bright-pass.
    vec3 coreEm = hue * (blink * 2.2 * uRLStrength) * member;
    vec3 haloEm = glowHue * (blink * glow * 1.4 * uRLStrength);
    rlEmissive = (coreEm + haloEm) * uRLEmit;
  }

  // Exposure — the Graphics Options Brightness slider scales the whole
  // lit result before the tone curve, so the user can dial the scene
  // light intensity up/down.
  col *= uExposure;
  // Luminance-preserving Reinhard tone curve.  The old curve divided
  // each channel independently (`col/(col+0.55)`), which compresses the
  // brighter channel more than the dim ones — desaturating colours as
  // they got bright, the core of the "washed out" look in Studio Mode.
  // Instead compress on LUMINANCE and rescale RGB by the same ratio:
  // highlights still roll off, but hue + saturation are preserved so
  // textures keep the punch they have in Flat Shading.  For neutral
  // greys this is identical to the old curve, so overall brightness is
  // unchanged — only the colour fidelity improves.
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  float lumT = pow(lum / (lum + 0.55), 0.9);
  col *= lumT / max(lum, 1e-4);
  // Surface-hint running lights ride on top of the tone-mapped scene so the
  // lamps stay punchy (well above 1.0) and trip the bloom bright-pass.
  col += rlEmissive;
  // Per-piece glow override — added flat, post-tonemap.  Zero alpha
  // (the default) is a no-op so unhinted pieces pay nothing visible.
  // The renderer sets uPieceGlow once per piece draw call from the
  // piece-light-overrides table; pulse intensity is computed JS-side
  // and baked into the alpha channel, leaving the shader pure.
  col += uPieceGlow.rgb * uPieceGlow.a;
  if (uReflectionTint > 0.5) {
    // Mirror reflection underwater: shift toward the deep-water
    // hue but keep most of the original brightness so the
    // reflection survives the water-surface alpha blend on top.
    col = mix(col, col * vec3(0.55, 0.75, 0.95), 0.45);
    col *= 0.90;
  }
  // Reflection pass output at full alpha so the water surface's
  // alpha mix is the only thing dimming it - previously dropping
  // to 0.65 here compounded with the water alpha and made the
  // reflection nearly invisible.  The output alpha gates the build-
  // progress fade — below 100% build, uOutputAlpha = build/100
  // so the textured model fades in as construction completes.
  gl_FragColor = vec4(col, uOutputAlpha);
}
