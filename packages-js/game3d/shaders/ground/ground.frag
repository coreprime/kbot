// Ground / sea-surface / seabed fragment shader.  Companion to
// ground.vert - the same uGroundMode switch picks between Grid,
// Terrain (textured), Sea (procedural waves), the legacy fallback,
// the baked battlefield mesh (4) + its water sheet (5), or the void
// grid drawn around an installed battlefield (6).

precision highp float;
precision highp int;

// Dynamic pulse-light slot count — the hard ceiling on simultaneous dynamic
// lights.  Must match MAX_PULSE_LIGHTS in engine/scene-lights.js and main.frag.
// uPulseLightCount carries how many slots are live this frame (the "Dynamic
// Lights" graphics option) so the loop early-outs before this ceiling.
#define MAX_PULSE_LIGHTS 256

#include "../lib/sea-waves.glsl"
#include "../lib/logdepth.glsl"

varying vec3 vWorldPos;
varying vec2 vMapUV;   // per-vertex map-composite UV (height-shifted), mode 4
varying vec4 vLightSpacePos;
varying vec4 vLightSpacePos2;
varying float vMountainAmt;     // matches the vertex shader's ring fade
varying float vMountainHNorm;   // normalised peak height at this fragment
uniform sampler2D uShadowMap;
uniform sampler2D uShadowMap2;  // twin-sun environments
uniform sampler2D uTerrainTex;
// Map-terrain (uGroundMode == 4): the full map render draped over the
// baked-height mesh. uMapRect is (originX, originZ, sizeX, sizeZ) in wu.
uniform sampler2D uMapTex;
uniform vec4 uMapRect;
// Near-detail clipmap cache: a high-res slice of the composite covering the
// camera's window (uMapClipRect = originX,originZ,sizeX,sizeZ in wu). Sampled
// instead of the lower-res base inside that window, cross-faded at the rim.
uniform sampler2D uMapClipTex;
uniform vec4 uMapClipRect;
uniform float uMapClipOn;
// Battlefield extras: the raw heightmap as a texture (red channel =
// height byte / 255), the world-unit scale of one height step, the sea
// surface Y, plus the fog + contour toggles.
uniform sampler2D uMapHeightTex;
uniform float uMapHeightScale;
uniform float uMapSeaY;
uniform float uMapFog;       // 1 = horizon haze on battlefields, 0 = clear to the edge
uniform float uMapContours;  // 1 = overlay elevation contour lines
uniform float uShadowEnabled;
uniform float uShadowStrength; // 0..1 scales shadow darkness — used for the construction fade (translucent shadow at low buildPercent, solid at 100)
uniform vec3 uLightColor2;      // when non-zero, the second sun also casts shadows
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uCenter;
uniform float uRadius;
uniform int uGroundMode;       // 0 = grid, 1 = terrain (textured), 2 = sea (procedural waves), 3 = legacy plain
uniform float uTileSize;       // world units per repeat (one TA map tile)
uniform float uTerrainReady;   // 1 once the terrain texture has uploaded
uniform float uTime;           // seconds since renderer start, drives sea animation
uniform float uExposure;       // scene brightness / exposure (Graphics Options Brightness) — 1 = default; applied to the final ground/sea colour to match the unit
uniform vec3  uSunTint;        // world sun colour normalised to max-channel 1 — terrain + seabed are tinted toward it so the ground reads as lit by the world's sun (amber Mars, orange Lava, cool moonlight, …)
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
// Dynamic pulse light (matches main.frag uniforms exactly).  Fed
// by the controller each frame from the strongest active light-
// emitting particle.  Used here so weapon SFX (d-gun, lasers) cast
// a visible coloured wash onto the terrain beneath them.  Zero
// colour means no active pulse — the cheap dot-product test gates
// the contribution off so quiescent frames pay almost nothing.
uniform vec3 uPulseLightPos[MAX_PULSE_LIGHTS];
uniform vec3 uPulseLightColor[MAX_PULSE_LIGHTS];
uniform float uPulseLightRange[MAX_PULSE_LIGHTS];
uniform int uPulseLightCount;

// pulseLightContribution sums the additive RGB every active dynamic point
// light deposits on a horizontal ground patch at worldPos.  Ground normal is
// implicit +Y; only the vertical component of the light direction matters for
// the Lambert dot.  Returns zero when no active pulse so callers can blindly
// add it; empty slots (range 0) are skipped.
vec3 pulseLightContribution(vec3 worldPos) {
  vec3 sum = vec3(0.0);
  for (int pli = 0; pli < MAX_PULSE_LIGHTS; pli++) {
    if (pli >= uPulseLightCount) break;
    vec3 plColor = uPulseLightColor[pli];
    float plRange = uPulseLightRange[pli];
    if (dot(plColor, plColor) < 0.0001 || plRange <= 0.0) continue;
    vec3 d = uPulseLightPos[pli] - worldPos;
    float dist = length(d);
    if (dist < 0.0001) continue;
    // ndl against +Y normal = max(0, d.y/dist).
    float ndl = max(0.0, d.y / dist);
    float r = dist / plRange;
    float atten = 1.0 / (1.0 + r * r);
    sum += plColor * ndl * atten;
  }
  return sum;
}
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
  float s = s1;
  if (dot(uLightColor2, uLightColor2) >= 0.0001) {
    float s2 = sampleShadowSecondary();
    s = (s1 + s2) * 0.5;
  }
  // Scale shadow strength toward "fully lit" (1.0) when uShadowStrength
  // is below 1.  Used by the construction-progress fade — at build 0%
  // the shadow vanishes (unit is still nano-mass), at 100% the shadow
  // is at full strength like any finished unit.
  return mix(1.0, s, clamp(uShadowStrength, 0.0, 1.0));
}

void main() {
#ifdef LOGDEPTH_FRAGMENT
  logDepthFragment();
#endif
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

  // (uGroundMode 6, the finite-pad void grid, was replaced by the infinite
  // ray-plane grid in the sky pass — see sky.frag uGridOn.)

  float shadow = sampleShadow();

  if (uGroundMode == 4) {
    // vMapUV carries TA's height/2 north shift, applied PER-VERTEX (ground.vert)
    // and interpolated here — so it can't fold into a smear on walls / block
    // tops the way a per-fragment shift did. It's already height-shifted and
    // edge-clamped.
    vec3 base = texture2D(uMapTex, vMapUV).rgb;
    // Near-detail clipmap: reconstruct the (already shifted) world XZ from the
    // interpolated UV, map it into the cache window, and cross-fade base→clip
    // across a rim margin. Outside the window (or when off) base + mips carry
    // the distance — native detail up close, bounded VRAM.
    if (uMapClipOn > 0.5) {
      vec2 effWorld = vMapUV * uMapRect.zw + uMapRect.xy;
      vec2 cUV = (effWorld - uMapClipRect.xy) / uMapClipRect.zw;
      vec2 e0 = smoothstep(vec2(0.0), vec2(0.06), cUV);
      vec2 e1 = smoothstep(vec2(0.0), vec2(0.06), vec2(1.0) - cUV);
      float cw = e0.x * e0.y * e1.x * e1.y;
      if (cw > 0.0) base = mix(base, texture2D(uMapClipTex, cUV).rgb, cw);
    }
    base *= mix(1.0, shadow, 0.85);
    // Elevation contours: a line at every height interval, derived from
    // the mesh's own Y so they hug the real terrain. Anti-aliased by
    // distance so zoomed-out views don't moiré.
    if (uMapContours > 0.5) {
      float interval = 8.0 * max(uMapHeightScale, 0.25);
      float f = abs(fract(vWorldPos.y / interval + 0.5) - 0.5) * interval;
      float dCamC = length(uEyePos - vWorldPos);
      float lineW = mix(0.45, 1.6, smoothstep(200.0, 2400.0, dCamC));
      float line = 1.0 - smoothstep(0.0, lineW, f);
      base = mix(base, vec3(1.0, 0.85, 0.25), line * 0.35);
    }
    float dCamM = length(uEyePos - vWorldPos);
    base = mix(base, uHorizonColor, smoothstep(1800.0, 5500.0, dCamM) * 0.78 * uMapFog);
    base += pulseLightContribution(vWorldPos);
    base *= mix(vec3(1.0), uSunTint, 0.45);
    gl_FragColor = vec4(base * uExposure, 1.0);
    return;
  }
  if (uGroundMode == 5) {
    // Battlefield water surface: a translucent animated sheet at sea
    // level over the real seabed terrain (the map mesh below keeps its
    // painted bed). Wave energy and opacity both scale with the true
    // water depth at this point, so puddles lie glassy and near-clear
    // while open sea rolls and saturates toward the deep tint.
    vec2 uv = (vWorldPos.xz - uMapRect.xy) / uMapRect.zw;
    float bedY = texture2D(uMapHeightTex, uv).r * 255.0 * uMapHeightScale;
    float depth = uMapSeaY - bedY;
    if (depth <= 0.3) discard; // dry land pokes through the sheet
    float t = uTime;
    float bodyAmp = smoothstep(2.0, 26.0, depth); // small/shallow bodies stay calm
    vec3 hs = seaWaveHS(vWorldPos.xz, t);
    float amp = uWavesIntensity * bodyAmp;
    float h = hs.x * amp;
    float dhx = hs.y * amp;
    float dhz = hs.z * amp;
    float dCam = length(uEyePos - vWorldPos);
    float closeUp = 1.0 - smoothstep(120.0, 900.0, dCam);
    vec3 wn = normalize(vec3(-dhx * closeUp, 1.0, -dhz * closeUp));

    float deepMix = smoothstep(1.0, 30.0, depth);
    vec3 waterCol = mix(uWaterShallow, mix(uWaterMid, uWaterDeep, smoothstep(0.45, 1.0, deepMix)), deepMix);

    vec3 V = normalize(uEyePos - vWorldPos);
    float ndv = max(0.0, dot(wn, V));
    float fresnel = pow(1.0 - ndv, 4.0);
    vec3 L = normalize(uLightDir);
    vec3 H = normalize(L + V);
    float ndh = max(0.0, dot(wn, H));
    float spec = (pow(ndh, 28.0) * 0.25 + pow(ndh, 160.0) * 0.7) * closeUp * uOptSpecular * bodyAmp;
    vec3 surface = mix(waterCol, uHorizonColor, fresnel * 0.5);
    surface += spec * vec3(1.45, 1.25, 0.95);
    // Crest foam only where the body is big enough to raise real waves.
    float foam = smoothstep(1.0, 2.0, h) * 0.8 * bodyAmp * closeUp;
    // Shoreline foam: a soft animated band where the bed rises to meet
    // the surface — two drifting sine phases over the shallow margin so
    // the lap line breathes instead of sitting as a hard contour.  Runs
    // on the same fx clock as the waves (deterministic under a driven
    // render), and fades with distance like the crest foam.
    float shore = 1.0 - smoothstep(0.35, 3.2, depth);
    float lap = 0.6
              + 0.25 * sin(t * 1.6 + (vWorldPos.x + vWorldPos.z) * 0.11)
              + 0.15 * sin(t * 2.3 - vWorldPos.x * 0.07 + vWorldPos.z * 0.05);
    foam += shore * lap * 0.55 * closeUp;
    foam = min(foam, 1.0);
    surface = mix(surface, vec3(1.05, 1.08, 1.10), foam);
    surface *= mix(1.0, shadow, 0.25);
    surface *= mix(vec3(1.0), uSunTint, 0.35);

    float aOut = mix(0.30, 0.80, deepMix);
    aOut = mix(aOut, 0.92, fresnel * 0.5);
    gl_FragColor = vec4(surface * uExposure, aOut * uWaterTranslucency);
    return;
  }
  if (uGroundMode == 0) {
    // Grid mode: Tron-style — a near-black floor with a faint green
    // tint and bright cyan-green tile lines that glow.  fwidth would
    // give crisper sub-pixel lines but isn't available in WebGL1 by
    // default - a small constant line width works fine.
    //
    // The two-tier line strength (thin sharp lattice plus a wider
    // bloom-ish falloff) reads as a glowing wire over a dark deck:
    // the wide falloff fakes a bloom halo around each line, the
    // sharp inner core keeps the geometry crisp.
    vec2 tile = fract(vWorldPos.xz / uTileSize);
    // Crisp inner line (~4% of a tile from each edge).
    float lineX = smoothstep(0.0, 0.04, tile.x) * (1.0 - smoothstep(0.96, 1.0, tile.x));
    float lineY = smoothstep(0.0, 0.04, tile.y) * (1.0 - smoothstep(0.96, 1.0, tile.y));
    float onLine = 1.0 - lineX * lineY;
    // Wider glow band (~14% from each edge) - read as a soft halo
    // around the crisp inner stroke, summed at reduced intensity.
    float gloX = smoothstep(0.0, 0.14, tile.x) * (1.0 - smoothstep(0.86, 1.0, tile.x));
    float gloY = smoothstep(0.0, 0.14, tile.y) * (1.0 - smoothstep(0.86, 1.0, tile.y));
    float onGlow = 1.0 - gloX * gloY;
    // Near-black deck with the faintest green undertone the user
    // wanted - reads as "Tron grid" instead of straight black so a
    // unit without a strong fill colour still reads against it.
    vec3 fill = vec3(0.005, 0.025, 0.012);
    // Cyan-green emissive line colour (over-bright in linear space
    // so the additive halo composites with feel-good intensity even
    // after the shadow multiply below).
    vec3 line = vec3(0.20, 1.20, 0.55);
    vec3 base = mix(fill, line, onLine);
    base *= mix(1.0, shadow, 0.85 * fade);
    // Halo - additive on top of the shadowed base so it doesn't get
    // muted in the shadow pass.  Capped at ~45% intensity so the
    // glow stays subtle (no nuclear-greenhouse bloom around every
    // tile).
    base += line * onGlow * 0.18;
    base += pulseLightContribution(vWorldPos);
    gl_FragColor = vec4(base * uExposure, fade);
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
    base += pulseLightContribution(vWorldPos);
    base *= mix(vec3(1.0), uSunTint, 0.45);   // tint terrain by the world's sun hue
    gl_FragColor = vec4(base * uExposure, 1.0);
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
    col *= mix(vec3(1.0), uSunTint, 0.45);    // tint seabed by the world's sun hue
    gl_FragColor = vec4(col * uExposure, 1.0);
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
    gl_FragColor = vec4(surface * uExposure, aOut * fade);
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
  base *= mix(vec3(1.0), uSunTint, 0.45);     // tint fallback ground by the world's sun hue
  gl_FragColor = vec4(base * uExposure, fade);
}
