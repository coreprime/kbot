// Ground / sea-surface / seabed fragment shader.  Companion to
// ground.vert - the same uGroundMode switch picks between Grid,
// Terrain (textured), Sea (procedural waves), or the legacy fallback.

precision highp float;
precision highp int;

#include "../lib/sea-waves.glsl"

varying vec3 vWorldPos;
varying vec4 vLightSpacePos;
varying vec4 vLightSpacePos2;
varying float vMountainAmt;     // matches the vertex shader's ring fade
varying float vMountainHNorm;   // normalised peak height at this fragment
uniform sampler2D uShadowMap;
uniform sampler2D uShadowMap2;  // twin-sun environments
uniform sampler2D uTerrainTex;
uniform float uShadowEnabled;
uniform vec3 uLightColor2;      // when non-zero, the second sun also casts shadows
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uCenter;
uniform float uRadius;
uniform int uGroundMode;       // 0 = grid, 1 = terrain (textured), 2 = sea (procedural waves), 3 = legacy plain
uniform float uTileSize;       // world units per repeat (one TA map tile)
uniform float uTerrainReady;   // 1 once the terrain texture has uploaded
uniform float uTime;           // seconds since renderer start, drives sea animation
uniform vec3 uLightDir;        // world-space direction toward the sun, used by Sea specular
uniform vec3 uEyePos;          // camera world position - Sea Fresnel needs the real view dir
uniform float uSeabedActive;   // 1 when this pass renders the seabed below the water
uniform float uSeabedY;        // base Y of the seabed plane (below uGroundY)
uniform vec3 uHorizonColor;    // sky horizon colour - sea fades to this at distance
uniform float uOptSpecular;        // 0 disables broad/tight specular + sparkles
uniform float uWavesIntensity;     // multiplier on wave amplitude (also flat=0 when Waves toggle off)
uniform vec3 uWaterShallow;        // shallow / sunlit water tint (closest to surface light)
uniform vec3 uWaterMid;            // mid depth tint
uniform vec3 uWaterDeep;           // abyssal tint
uniform float uWaterTranslucency;  // multiplier on water alpha - higher = clearer
uniform vec3 uSeabedSand;          // colour of the bed's sand / dune surface
uniform vec3 uSeabedRock;          // colour of rocky outcrops
uniform vec3 uSeabedCaustic;       // tint of the caustic light shaft on the bed
// Background mountain shading.  Match the vertex shader's
// uMountainActive / uMountainStyle so geometry + material agree.
uniform float uMountainActive;
uniform int uMountainStyle;
uniform vec3 uMountainBase;        // lowland tint
uniform vec3 uMountainPeak;        // ridge / snow / metal-highlight tint
uniform float uMountainGloss;      // 0 matte, 1 mirror-metal
// Seabed knobs - mirror ground.vert's declarations so the
// fragment also sees them when picking the rock-vs-sand mix.
uniform float uSeabedHeightMul;
uniform float uSeabedScaleMul;
uniform float uSeabedRockChance;

// mountainShade colours the background-ring fragments.  Rocky &
// sand styles get a smooth base->peak gradient on vMountainHNorm.
// Metal style adds a 3D panel-grid striping in world space and a
// fake specular kick so its plates read as fabricated armour.
vec3 mountainShade(float shadow) {
  vec3 col = mix(uMountainBase, uMountainPeak, smoothstep(0.05, 0.95, vMountainHNorm));
  if (uMountainStyle == 1) {
    // Metal: smooth alloy reading, no panel-grid striping (the
    // grid showed up as visible wireframe-like lines and the user
    // wanted those gone).  Keeps the gloss specular kick so metal
    // mountains still read as something fabricated rather than
    // rocky - via a brighter peak tint + the cheap sun bounce.
    vec3 L = normalize(uLightDir);
    float spec = pow(max(0.0, L.y), 32.0) * uMountainGloss;
    col += vec3(0.50, 0.60, 0.75) * spec * 0.4;
  } else if (uMountainStyle == 2) {
    // Sand: warm sunlit-side / cool shadow-side bias based on
    // world X dominance.
    col = mix(col, col * vec3(1.10, 1.05, 0.92), 0.4);
  } else {
    // Rocky: darken the lowlands a hair so cliffs read against
    // them.  Cheap and tasteful.
    col *= mix(0.80, 1.05, vMountainHNorm);
  }
  return col * mix(0.55, 1.0, shadow);
}

// 5x5 PCF tap into the primary shadow map.  Returns 1.0 fully lit,
// 0.0 fully shadowed.  The ladder of `proj` validation skips
// fragments outside the shadow frustum so the ground beyond the
// shadow volume reads as lit, not a hard cutoff.
float sampleShadowPrimary() {
  if (uShadowEnabled < 0.5) return 1.0;
  vec3 proj = vLightSpacePos.xyz / vLightSpacePos.w;
  proj = proj * 0.5 + 0.5;
  if (proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0 || proj.z > 1.0) return 1.0;
  float lit = 0.0;
  float texel = 1.0 / 1024.0;
  for (int dx = -2; dx <= 2; dx++) {
    for (int dy = -2; dy <= 2; dy++) {
      float depth = texture2D(uShadowMap, proj.xy + vec2(float(dx), float(dy)) * texel).r;
      lit += (proj.z - 0.0008 < depth) ? 1.0 : 0.0;
    }
  }
  return lit / 25.0;
}

// Twin-sun secondary shadow sampler.  Identical to the primary
// except it pulls from uShadowMap2 + vLightSpacePos2.  Skipped
// when the renderer reports zero sun2 colour so single-sun
// environments don't pay for the second tap.
float sampleShadowSecondary() {
  if (uShadowEnabled < 0.5) return 1.0;
  vec3 proj = vLightSpacePos2.xyz / vLightSpacePos2.w;
  proj = proj * 0.5 + 0.5;
  if (proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0 || proj.z > 1.0) return 1.0;
  float lit = 0.0;
  float texel = 1.0 / 1024.0;
  for (int dx = -2; dx <= 2; dx++) {
    for (int dy = -2; dy <= 2; dy++) {
      float depth = texture2D(uShadowMap2, proj.xy + vec2(float(dx), float(dy)) * texel).r;
      lit += (proj.z - 0.0008 < depth) ? 1.0 : 0.0;
    }
  }
  return lit / 25.0;
}

// Combined ground shadow.  Each sun contributes its own light; a
// fragment lit by only one sun is half-darkened, by neither sun
// fully darkened, by both fully lit.  Averaging the two PCF
// results delivers exactly that behaviour and reads on-screen as
// two distinct unit silhouettes splayed in different directions.
float sampleShadow() {
  float s1 = sampleShadowPrimary();
  // dot >= 0.0001 mirrors the main.frag check so single-sun
  // environments don't pay for the second tap.
  if (dot(uLightColor2, uLightColor2) < 0.0001) return s1;
  float s2 = sampleShadowSecondary();
  return (s1 + s2) * 0.5;
}

void main() {
  vec2 g = vWorldPos.xz - uCenter.xz;
  float d = length(g);
  // Sea, terrain, and seabed all extend to the visible horizon -
  // they only differ in how they blend into the sky.  The
  // unit-radius alpha fade is now reserved for the Grid mode +
  // legacy fallback which intentionally stays as a small
  // decorative pad around the unit.
  float fade = (uGroundMode == 0 || uGroundMode == 3)
              ? clamp(1.0 - d / (uRadius * 1.8), 0.0, 1.0)
              : 1.0;
  float shadow = sampleShadow();

  if (uGroundMode == 0) {
    // Grid mode: light-green lattice over a dark-green fill, sized
    // to one TA map tile (uTileSize world units per cell).  fwidth
    // would give crisper sub-pixel lines but isn't available in
    // WebGL1 by default - a small constant line width works fine.
    vec2 tile = fract(vWorldPos.xz / uTileSize);
    float lineX = smoothstep(0.0, 0.04, tile.x) * (1.0 - smoothstep(0.96, 1.0, tile.x));
    float lineY = smoothstep(0.0, 0.04, tile.y) * (1.0 - smoothstep(0.96, 1.0, tile.y));
    float onLine = 1.0 - lineX * lineY;
    vec3 fill = vec3(0.04, 0.10, 0.06);
    vec3 line = vec3(0.30, 0.65, 0.34);
    vec3 base = mix(fill, line, onLine);
    base *= mix(1.0, shadow, 0.85 * fade);
    gl_FragColor = vec4(base, fade);
    return;
  }
  if (uGroundMode == 1 && uTerrainReady > 0.5) {
    // Terrain mode: tile the flat tileset texture.  REPEAT wrap
    // on the texture handles the UV overflow; no manual fract here.
    vec2 uv = vWorldPos.xz / uTileSize;
    vec3 base = texture2D(uTerrainTex, uv).rgb;
    base *= mix(1.0, shadow, 0.85);
    // Background mountains: blend in the procedural ring outside
    // the clearing.  The clearing keeps the real tileset look so
    // the unit sits on familiar ground; only the distant
    // mountains pick up the styled colouring.
    if (uMountainActive > 0.5 && vMountainAmt > 0.01) {
      base = mix(base, mountainShade(shadow), vMountainAmt);
    }
    // Horizon haze: same trick the sea pass uses - mix toward the
    // sky's horizon colour at long range so the terrain blends
    // smoothly into the skybox at the visible horizon instead of
    // ending at a hard line.  Distance from the camera, not from
    // the unit, because we want the haze to read consistently
    // wherever the user orbits.  Numbers pushed WAY out (1800 ..
    // 5500) so a zoomed-out user still sees most of the ring of
    // mountains in real terrain colours rather than a tight green
    // disk surrounded by sky haze.  Max blend reduced to 0.78 so
    // even the furthest band keeps a hint of land beneath the sky.
    float dCamT = length(uEyePos - vWorldPos);
    float horizonMix = smoothstep(1800.0, 5500.0, dCamT);
    base = mix(base, uHorizonColor, horizonMix * 0.78);
    gl_FragColor = vec4(base, 1.0);
    return;
  }
  if (uSeabedActive > 0.5) {
    // -- Seabed pass: rocks + dunes.  Drawn first, depth-tested
    // under the reflection + water surface.  Bed colours come
    // from the active environment preset so Archipelago gets
    // white sand, Metal gets dark plating, Lava glows red, etc.
    float bedH = seabedHeight(vWorldPos.xz, uSeabedHeightMul, uSeabedScaleMul, uSeabedRockChance);
    float rockMix = smoothstep(10.0, 22.0, bedH);
    vec3 col = mix(uSeabedSand, uSeabedRock, rockMix);
    // Subtle multi-octave noise lightens / darkens patches of
    // sand so the bed isn't a flat tint.
    float n1 = seaNoise(vWorldPos.xz * 0.012);
    float n2 = seaNoise(vWorldPos.xz * 0.045 + 7.1);
    float bedVar = 0.7 + 0.6 * n1 + 0.25 * n2;
    col *= bedVar;
    col *= 0.50 + 0.35 * shadow;
    // Seabed also fades into the horizon colour at distance so
    // the far-edge isn't a sharp ring of dark seafloor visible
    // through the haze of the water surface above.
    float dCamBed = length(uEyePos - vWorldPos);
    float bedHaze = smoothstep(500.0, 2200.0, dCamBed);
    col = mix(col, uHorizonColor * 0.45, bedHaze);
    gl_FragColor = vec4(col, 1.0);
    return;
  }
  if (uGroundMode == 2) {
    // -- Sea-surface pass --------------------------------------
    float t = uTime;
    vec3 hs = seaWaveHS(vWorldPos.xz, t);
    float h = hs.x * uWavesIntensity;
    float dhx = hs.y * uWavesIntensity;
    float dhz = hs.z * uWavesIntensity;
    float dCam = length(uEyePos - vWorldPos);
    float closeUp = 1.0 - smoothstep(120.0, 600.0, dCam);
    vec3 wn = normalize(vec3(-dhx * closeUp, 1.0, -dhz * closeUp));
    float slope = length(vec2(dhx, dhz)) * closeUp;

    vec3 shallowTint = uWaterShallow;
    vec3 midTint     = uWaterMid;
    vec3 deepTint    = uWaterDeep;
    float depthProxy = 1.6 - h;
    float absorb = exp(-depthProxy * 0.55);
    vec3 waterCol = mix(deepTint, midTint, smoothstep(0.0, 0.55, absorb));
    waterCol = mix(waterCol, shallowTint, smoothstep(0.55, 1.0, absorb));

    vec3 V = normalize(uEyePos - vWorldPos);
    float ndv = max(0.0, dot(wn, V));
    float fresnel = pow(1.0 - ndv, 4.0);
    vec3 skyTop = vec3(0.32, 0.58, 1.10);
    vec3 skyHor = vec3(1.15, 0.92, 0.65);
    vec3 sky = mix(skyTop, skyHor, fresnel);
    vec3 L = normalize(uLightDir);
    vec3 H = normalize(L + V);
    float ndh = max(0.0, dot(wn, H));
    float specBroad = pow(ndh, 28.0) * 0.32 * closeUp;
    float specTight = pow(ndh, 160.0) * 0.90 * closeUp;
    vec3 sunColor = vec3(1.55, 1.30, 0.90);
    float reflectivity = 0.10 + 0.90 * fresnel;
    vec3 surface = mix(waterCol, sky, reflectivity);
    surface += (specBroad + specTight) * sunColor * uOptSpecular;

    vec3 Rd = reflect(-L, wn);
    float sparkleAlign = pow(max(0.0, dot(Rd, V)), 110.0) * 0.22
                       + pow(max(0.0, dot(Rd, V)), 320.0) * 0.75;
    float sparkleNoise = sin(vWorldPos.x * 9.0 + t * 2.7)
                       * sin(vWorldPos.z * 11.0 + t * 2.3)
                       * sin((vWorldPos.x + vWorldPos.z) * 5.0 - t * 1.7);
    float sparkle = sparkleAlign * smoothstep(0.28, 0.95, abs(sparkleNoise));
    float sparkleFade = 1.0 - smoothstep(80.0, 350.0, dCam);
    surface += vec3(1.10, 0.95, 0.75) * sparkle * sparkleFade * uOptSpecular;

    float backlit = pow(max(0.0, dot(L, -V)) * 0.5 + 0.5, 2.0)
                  * smoothstep(0.20, 0.80, h);
    surface += vec3(0.18, 0.55, 0.95) * backlit * 0.55 * closeUp;

    float crestFoam = smoothstep(1.10, 2.10, h) * 0.95;
    float breakingFoam = smoothstep(0.30, 0.55, slope) * smoothstep(0.40, 0.95, h);
    float hazeFoam     = smoothstep(0.12, 0.28, slope) * 0.35;
    float foamFade = 1.0 - smoothstep(120.0, 500.0, dCam);
    surface = mix(surface, vec3(1.08, 1.10, 1.12),
                  clamp(crestFoam + breakingFoam + hazeFoam * 0.5, 0.0, 0.92) * foamFade);

    surface *= mix(1.0, shadow, 0.18);
    surface = surface / (surface * 0.55 + vec3(0.55));

    float horizonMix = smoothstep(500.0, 2400.0, dCam);
    surface = mix(surface, uHorizonColor, horizonMix * 0.92);

    float bedAtXZ = uSeabedY + seabedHeight(vWorldPos.xz, uSeabedHeightMul, uSeabedScaleMul, uSeabedRockChance);
    float bedDepth = max(0.0, vWorldPos.y - bedAtXZ);
    float aOut = mix(0.35, 0.62, smoothstep(1.0, 6.0, bedDepth));
    aOut = mix(aOut, 0.78, fresnel * 0.6);
    aOut = mix(aOut, 1.0, horizonMix);
    aOut = clamp(aOut * uWaterTranslucency, 0.05, 1.0);
    gl_FragColor = vec4(surface, aOut * fade);
    return;
  }

  // Legacy / fallback: same gentle decorative ground we used before
  // the three-mode rework.  Reached when terrain mode is selected
  // but the tile texture hasn't uploaded yet.
  float footprintMask = smoothstep(uRadius * 1.0, uRadius * 1.6, d);
  float grid = step(0.5, fract(g.x * 0.05) + fract(g.y * 0.05));
  vec3 base = mix(uColorA, uColorB, grid * 0.18 * footprintMask);
  // Even on the fallback paint the background mountains so the
  // feature is visible while the terrain texture is still
  // streaming in.
  if (uMountainActive > 0.5 && vMountainAmt > 0.01) {
    base = mix(base, mountainShade(shadow), vMountainAmt);
  }
  base *= mix(1.0, shadow, 0.85 * fade);
  gl_FragColor = vec4(base, fade);
}
