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

precision highp float;
precision highp int;

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
uniform float uFlatLighting;  // 1 = no directional/ambient/shadow, full bright (Flat display mode)
uniform float uReflectionTint; // 1 = output is dimmed + blue-tinted, used by the water reflection pass
uniform float uSeaActive;     // 1 in Sea mode - adds caustic bounce light + sun shimmer to the hull
uniform float uTime;          // shared sea time (for the bounce light to animate with the water)
uniform float uWaterY;        // world Y of the water plane - fades reflections out above it
uniform float uWaterOnHull;   // Water Surface Reflections toggle - 0 disables hull bounce/shimmer
uniform vec3 uTeamColor;      // selected team colour in linear RGB
uniform float uTeamColorEnable; // 0 = original blue (no recolour), 1 = hue-shift toward uTeamColor
uniform float uOutputAlpha;   // 1 = fully opaque (default); < 1 fades the textured pass for the build-progress nano-frame effect

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

void main() {
  vec4 base;
  if (uMode == 1) {
    base = uTint;
  } else {
    base = texture2D(uTex, vUV);
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

  vec3 N = normalize(vNormal);
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
  float hemiMix = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 ambient = mix(uGroundColor, uSkyColor, hemiMix) * vAO;

  // Cinematic 3-point lighting: the key light is uLightDir/uLightColor
  // (already the scene sun).  Fill kicks in from the OPPOSITE side
  // of the camera to lift the shadow side without flattening the
  // form.  Back light pushes a bright edge along the silhouette
  // facing away from the camera so the unit detaches from the
  // background.  Both lights are subordinate to the key and AO so
  // they don't wash out genuine sculpting.
  vec3 fillDir = normalize(vec3(-L.x, max(0.1, L.y * 0.4), -L.z));
  float ndf = max(0.0, dot(N, fillDir));
  ndf = max(ndf, max(0.0, dot(-N, fillDir)) * 0.4);
  vec3 fillLight = ndf * uFillColor * 0.55;

  // Back light: comes from BEHIND the unit relative to the camera,
  // tilted slightly above so it grazes the top edges.
  vec3 backDir = normalize(vec3(-V.x, 0.3, -V.z));
  float ndb = max(0.0, dot(N, backDir));
  ndb = max(ndb, max(0.0, dot(-N, backDir)) * 0.4);
  vec3 backLight = pow(ndb, 4.0) * uBackColor * 0.7;

  // True view-direction rim light - Fresnel-style 1 - max(0, N.V).
  // Picks out the silhouette as the camera orbits, not just the
  // unit's local up.  AO suppresses it inside crevices where a
  // silhouette ramp would otherwise look wrong.
  float fresnel = pow(1.0 - max(0.0, dot(N, V)), 4.0);
  vec3 rim = fresnel * mix(uSkyColor, uLightColor, 0.6) * 0.35 * vAO;

  // Blinn-Phong specular sheen - the half-vector between L and V
  // dotted with N, raised to a moderate exponent for a panel-style
  // sheen rather than a glassy point.  Modulated by the texture
  // alpha later so the sheen rides on the material brightness.
  vec3 H = normalize(L + V);
  float spec = pow(max(0.0, dot(N, H)), 32.0);
  // Also sheen the back-side a little - symmetric like ndl above.
  float specBack = pow(max(0.0, dot(-N, H)), 32.0) * 0.4;
  spec = max(spec, specBack);

  float shadow = sampleShadowMap1(N);
  vec3 directLight = ndl * uLightColor * shadow;
  vec3 specular = spec * uLightColor * shadow * 0.45;
  // Second sun contribution - twin-sun environments fill this in
  // with a non-zero colour, single-sun worlds leave it black and
  // it costs almost nothing.
  if (dot(uLightColor2, uLightColor2) > 0.0001) {
    vec3 L2 = normalize(uLightDir2);
    float ndl2 = max(0.0, dot(N, L2));
    ndl2 = max(ndl2, max(0.0, dot(-N, L2)) * 0.4);
    float shadow2 = sampleShadowMap2(N);
    directLight += ndl2 * uLightColor2 * shadow2;
    vec3 H2 = normalize(L2 + V);
    float spec2 = pow(max(0.0, dot(N, H2)), 32.0);
    specular += spec2 * uLightColor2 * shadow2 * 0.45;
  }
  vec3 lighting = ambient + directLight + fillLight + backLight + rim;

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
    float sideness = 1.0 - abs(N.y);
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
  // Subtle vignette / ACES-ish tone curve to lift colour pop.
  col = col / (col + vec3(0.55));
  col = pow(col, vec3(0.9));
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
