// ModelRenderer — owns the WebGL context for a single canvas and the
// per-frame render loop.  The render pipeline is:
//
//   1. shadow pass  — re-render the model from the directional light's
//      POV into a depth texture, producing the shadow map.
//   2. sky pass     — paint a vertical gradient as the scene backdrop
//      via a full-screen quad with depth-test disabled.
//   3. ground pass  — a textured ground plane underneath the model
//      receives the projected shadow.
//   4. main pass    — model geometry, sampling the shadow map to
//      darken self-shadowed fragments and combining a sun directional
//      with a sky/ground hemisphere ambient.
//
// The pipeline is deliberately a hair richer than the editor's flat
// map renderer because the user wants the modelling tab to feel like
// a "showroom" — the geometry is the star.  Browsers without
// WEBGL_depth_texture skip step 1; the model falls back to flat
// lighting + a soft blob shadow on the ground plane.

import { Mat4 } from './mat4.js'

const VERTEX_STRIDE = 8 * 4 // 8 floats × 4 bytes
const POS_OFFSET = 0
const NRM_OFFSET = 3 * 4
const UV_OFFSET = 6 * 4

const SHADOW_MAP_SIZE = 1024

// ── Main shaders ─────────────────────────────────────────────────────
//
// vWorldPos is forwarded to the fragment shader so we can transform
// world-space positions into light space for shadow sampling.

// SEA_WAVES_GLSL holds the shared sea helpers (wave field, caustic,
// seabed height) injected into every shader that needs them — the
// ground program for surface & seabed, and the main program so the
// hull picks up bounce light + shimmer that tracks the water below.
// Declared first because const has temporal-dead-zone semantics; the
// MAIN/GROUND shader templates below interpolate it via ${...}.
const SEA_WAVES_GLSL = `
  // seaWaveHS: 5-octave wave field with prime-ratio frequencies and
  // cross-axis interference so the surface never reads as a tiled
  // grid of sines.  Peak amplitude is around 2.6 wu — tall enough to
  // produce visible cresting and breaking foam, low enough that a
  // battleship still sits on rather than under the wave.
  vec3 seaWaveHS(vec2 xz, float t) {
    // Five spatial scales.  Each octave gets its own offset so the
    // beat pattern between layers shifts the "interesting" parts of
    // the surface around as time progresses.
    vec2 p1 = xz * 0.085;   // long primary swell (~74 wu wavelength)
    vec2 p2 = xz * 0.21;    // secondary swell (~30 wu)
    vec2 p3 = xz * 0.46;    // chop (~14 wu)
    vec2 p4 = xz * 1.05;    // small chop (~6 wu)
    vec2 p5 = xz * 2.40;    // capillary detail (~2.6 wu)
    // Octave 1 — two crossing components, slightly off-perpendicular
    // so the long swell isn't axis-aligned.  Largest amplitude →
    // dominates the silhouette.
    float A1a = sin(p1.x * 0.97 + p1.y * 0.21 + t * 0.42);
    float A1b = sin(p1.y * 1.05 - p1.x * 0.18 - t * 0.36);
    // Octave 2 — different direction.
    float A2a = sin(p2.x * 0.78 - p2.y * 0.62 + t * 0.80);
    float A2b = sin(p2.x * 0.21 + p2.y * 0.93 - t * 0.72);
    // Octave 3 — chop with stronger time variation; crossing makes
    // wave crests look broken rather than parallel.
    float A3a = sin(p3.x * 1.13 + p3.y * 0.71 + t * 1.55);
    float A3b = sin(p3.x * 0.42 - p3.y * 1.07 + t * 1.30);
    // Octave 4 — small wavelets that put texture into the surface.
    float A4a = sin(p4.x * 1.31 + p4.y * 0.87 + t * 2.30);
    float A4b = sin(p4.x * 0.55 - p4.y * 1.21 + t * 2.65);
    // Octave 5 — capillary glitter (negligible height contribution,
    // matters mostly for the per-pixel normal).
    float A5a = sin(p5.x * 0.93 + p5.y * 0.47 + t * 3.85);
    float A5b = sin(p5.x * 0.27 - p5.y * 1.11 + t * 4.20);
    float h = A1a * 0.55 + A1b * 0.55
            + A2a * 0.42 + A2b * 0.32
            + A3a * 0.22 + A3b * 0.18
            + A4a * 0.10 + A4b * 0.10
            + A5a * 0.03 + A5b * 0.03;
    // Slope: chain-rule each component.  freqs were declared above so
    // the partials follow directly — keep these in sync if the
    // amplitudes/frequencies change.
    float dhx = cos(p1.x * 0.97 + p1.y * 0.21 + t * 0.42) * 0.97 * 0.085 * 0.55
              + cos(p1.y * 1.05 - p1.x * 0.18 - t * 0.36) * (-0.18) * 0.085 * 0.55
              + cos(p2.x * 0.78 - p2.y * 0.62 + t * 0.80) * 0.78 * 0.21 * 0.42
              + cos(p2.x * 0.21 + p2.y * 0.93 - t * 0.72) * 0.21 * 0.21 * 0.32
              + cos(p3.x * 1.13 + p3.y * 0.71 + t * 1.55) * 1.13 * 0.46 * 0.22
              + cos(p3.x * 0.42 - p3.y * 1.07 + t * 1.30) * 0.42 * 0.46 * 0.18
              + cos(p4.x * 1.31 + p4.y * 0.87 + t * 2.30) * 1.31 * 1.05 * 0.10
              + cos(p4.x * 0.55 - p4.y * 1.21 + t * 2.65) * 0.55 * 1.05 * 0.10
              + cos(p5.x * 0.93 + p5.y * 0.47 + t * 3.85) * 0.93 * 2.40 * 0.03
              + cos(p5.x * 0.27 - p5.y * 1.11 + t * 4.20) * 0.27 * 2.40 * 0.03;
    float dhz = cos(p1.x * 0.97 + p1.y * 0.21 + t * 0.42) * 0.21 * 0.085 * 0.55
              + cos(p1.y * 1.05 - p1.x * 0.18 - t * 0.36) * 1.05 * 0.085 * 0.55
              + cos(p2.x * 0.78 - p2.y * 0.62 + t * 0.80) * (-0.62) * 0.21 * 0.42
              + cos(p2.x * 0.21 + p2.y * 0.93 - t * 0.72) * 0.93 * 0.21 * 0.32
              + cos(p3.x * 1.13 + p3.y * 0.71 + t * 1.55) * 0.71 * 0.46 * 0.22
              + cos(p3.x * 0.42 - p3.y * 1.07 + t * 1.30) * (-1.07) * 0.46 * 0.18
              + cos(p4.x * 1.31 + p4.y * 0.87 + t * 2.30) * 0.87 * 1.05 * 0.10
              + cos(p4.x * 0.55 - p4.y * 1.21 + t * 2.65) * (-1.21) * 1.05 * 0.10
              + cos(p5.x * 0.93 + p5.y * 0.47 + t * 3.85) * 0.47 * 2.40 * 0.03
              + cos(p5.x * 0.27 - p5.y * 1.11 + t * 4.20) * (-1.11) * 2.40 * 0.03;
    return vec3(h, dhx, dhz);
  }

  // seaCaustic: the dancing sun-net on the seabed.  Three offset
  // sinusoid sums clamped through smoothstep produce a tessellated
  // caustic pattern that pulses with time.  Shared by the seabed
  // pass (paint on rocks) and the main shader (bounce light onto
  // the unit's hull).
  float seaCaustic(vec2 xz, float t) {
    vec2 cp = xz * 0.55;
    float c1 = abs(sin(cp.x + t * 0.55) + sin(cp.y * 0.95 - t * 0.6) + sin((cp.x + cp.y) * 0.6 + t * 0.4));
    float c2 = abs(sin(cp.x * 1.4 - t * 0.5) + sin(cp.y * 1.1 + t * 0.7) + sin((cp.x - cp.y) * 0.8 - t * 0.45));
    float caustic = 1.0 - smoothstep(0.2, 2.0, min(c1, c2));
    return pow(caustic, 1.4);
  }

  // seabedHeight: hash-grid placed rocks + low-freq dunes.  The same
  // function runs in both the seabed vertex shader (for displacement)
  // and the water surface shader (so the water alpha tracks how
  // shallow the bed is at that point, exposing the rocks through the
  // surface).
  float seabedHeight(vec2 xz) {
    // Large dunes — gentle low-amplitude undulation across the bed.
    vec2 dp = xz * 0.08;
    float dune = sin(dp.x * 0.9 + 0.4) * cos(dp.y * 1.1 - 0.7) * 0.40
               + sin(dp.x * 1.7 - dp.y * 0.6 + 1.9) * 0.25;
    // Hash-cell rock peaks.  Each cell may contain a single rock
    // whose centre is jittered inside the cell so they don't snap to
    // a grid.  Peaks capped at ~2 wu so they read as scattered rocks
    // rather than mountain ranges, and never poke through the
    // troughs of the water above.
    vec2 cell = floor(xz / 5.5);
    vec2 cf = fract(xz / 5.5);
    float h0 = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5);
    float h1 = fract(sin(dot(cell, vec2(269.5,  183.3))) * 17483.5);
    float h2 = fract(sin(dot(cell, vec2(419.2,  371.9))) * 28197.7);
    float present = step(0.72, h0);
    vec2 centre = vec2(h1, h2) * 0.7 + 0.15;
    float dist = length(cf - centre);
    float radius = 0.18 + h1 * 0.20;
    float peakH = 0.6 + h2 * 1.6;
    float rock = present * peakH * smoothstep(radius, 0.0, dist);
    return dune + rock;
  }
`

const MAIN_VS = `
  attribute vec3 aPos;
  attribute vec3 aNormal;
  attribute vec2 aUV;
  uniform mat4 uProj;
  uniform mat4 uView;
  uniform mat4 uWorld;
  uniform mat4 uLightSpace;
  varying vec2 vUV;
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying vec4 vLightSpacePos;
  void main() {
    vUV = aUV;
    vNormal = mat3(uWorld) * aNormal;
    vec4 worldPos = uWorld * vec4(aPos, 1.0);
    vWorldPos = worldPos.xyz;
    vLightSpacePos = uLightSpace * worldPos;
    gl_Position = uProj * uView * worldPos;
    gl_PointSize = 4.0;
  }
`

const MAIN_FS = `
  precision highp float;
  precision highp int;
  ${SEA_WAVES_GLSL}
  varying vec2 vUV;
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying vec4 vLightSpacePos;
  uniform sampler2D uTex;
  uniform sampler2D uShadowMap;
  uniform int uMode;            // 0 = textured, 1 = flat colour
  uniform vec4 uTint;
  uniform vec3 uLightDir;       // direction the light is coming FROM (toward sun)
  uniform vec3 uLightColor;
  uniform vec3 uSkyColor;       // hemisphere ambient when normal points up
  uniform vec3 uGroundColor;    // hemisphere ambient when normal points down
  uniform float uShadowEnabled; // 1 if uShadowMap is bound to a real depth texture, else 0
  uniform float uShadowBias;
  uniform float uFlatLighting;  // 1 = no directional/ambient/shadow, full bright (Flat display mode)
  uniform float uReflectionTint; // 1 = output is dimmed + blue-tinted, used by the water reflection pass
  uniform float uSeaActive;     // 1 in Sea mode — adds caustic bounce light + sun shimmer to the hull
  uniform float uTime;          // shared sea time (for the bounce light to animate with the water)

  // sampleShadow does a 3×3 PCF tap into the shadow map.  Returns
  // 1.0 = fully lit, 0.0 = fully shadowed (with a soft penumbra in
  // between).  Skipped when the depth-texture extension is missing.
  float sampleShadow(vec3 normal) {
    if (uShadowEnabled < 0.5) return 1.0;
    vec3 proj = vLightSpacePos.xyz / vLightSpacePos.w;
    proj = proj * 0.5 + 0.5;
    if (proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0 || proj.z > 1.0) return 1.0;
    // Slope-scaled bias: surfaces facing the light suffer less
    // self-acne, glancing surfaces need a heftier offset.
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

  void main() {
    vec4 base;
    if (uMode == 1) {
      base = uTint;
    } else {
      base = texture2D(uTex, vUV);
    }
    if (base.a < 0.5) discard;

    // Flat display mode: pass the texture (or tint) straight through,
    // skipping shadows + directional + ambient.  Used for diagnosing
    // texture issues with no shading bias.
    if (uFlatLighting > 0.5) {
      gl_FragColor = vec4(base.rgb, 1.0);
      return;
    }

    vec3 N = normalize(vNormal);
    vec3 L = normalize(uLightDir);
    float ndl = max(0.0, dot(N, L));
    // 3DO has no consistent winding direction, so we treat the
    // brighter face as the front — symmetric lighting reads
    // correctly from either side.
    ndl = max(ndl, max(0.0, dot(-N, L)) * 0.4);

    // Hemisphere ambient: sky tint from above, ground tint from below.
    // Multiplied by the texture so the colour temperature shifts with
    // the unit's pose (under-side picks up the warm ground bounce).
    float hemiMix = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 ambient = mix(uGroundColor, uSkyColor, hemiMix);

    // Rim light along the camera-facing silhouette.  Cheap fake — uses
    // world-space up as a stand-in for view direction; the unit
    // rotates under the camera so this still picks out the edges.
    float rim = pow(1.0 - max(0.0, N.z), 3.0) * 0.25;

    float shadow = sampleShadow(N);
    vec3 directLight = ndl * uLightColor * shadow;
    vec3 lighting = ambient + directLight + vec3(rim);

    // ── Sea bounce light ───────────────────────────────────────
    // When the unit sits on Sea ground, the water below kicks
    // light back up onto the hull two ways:
    //   * Caustic bounce — diffuse glow that rises through the
    //     surface and lights the sides + underside of the hull.
    //     Brightest under the unit; tinted with the lagoon's blue.
    //   * Sun shimmer — sharp diamond highlights where a wave
    //     facet reflects the sun directly at the hull.  Hits
    //     side-facing surfaces best, dances across them as the
    //     waves move.
    if (uSeaActive > 0.5) {
      // 1 when surface faces sideways or down, 0 when straight up
      // (no point trying to light a deck plate from below).
      float fromBelow = clamp(0.85 - N.y * 0.7, 0.0, 1.0);
      float caustic = seaCaustic(vWorldPos.xz, uTime);
      vec3 bounceTint = vec3(0.30, 0.65, 1.05);
      vec3 bounce = bounceTint * caustic * fromBelow * 0.85;
      // Sun shimmer: reflect the sun across an animated wave normal
      // sampled just below the unit's XZ, and check how aligned the
      // reflected ray is with the hull's surface normal — if so the
      // wave is mirroring the sun straight onto this fragment.
      vec3 hs = seaWaveHS(vWorldPos.xz, uTime);
      vec3 waveN = normalize(vec3(-hs.y, 1.0, -hs.z));
      vec3 sunRefl = reflect(-L, waveN);
      float shimmerAlign = pow(max(0.0, dot(sunRefl, -N)), 8.0);
      float shimmerNoise = sin(vWorldPos.x * 7.0 + uTime * 3.1)
                         * sin(vWorldPos.z * 9.0 + uTime * 2.7);
      float shimmer = shimmerAlign * smoothstep(0.20, 0.95, abs(shimmerNoise));
      bounce += vec3(1.85, 1.55, 1.10) * shimmer * fromBelow;
      lighting += bounce;
    }

    vec3 col = base.rgb * lighting;
    // Subtle vignette / ACES-ish tone curve to lift colour pop.
    col = col / (col + vec3(0.55));
    col = pow(col, vec3(0.9));
    if (uReflectionTint > 0.5) {
      // Mirror reflection underwater: shift toward the deep-water
      // hue, drop overall brightness so the surface clearly reads
      // as a reflection rather than the actual unit.
      col = mix(col, col * vec3(0.4, 0.6, 0.85), 0.65);
      col *= 0.7;
    }
    gl_FragColor = vec4(col, uReflectionTint > 0.5 ? 0.65 : 1.0);
  }
`

// ── Wireframe shader: thin line segments in a uniform colour ────────

const WIRE_VS = `
  attribute vec3 aPos;
  uniform mat4 uProj;
  uniform mat4 uView;
  uniform mat4 uWorld;
  uniform vec2 uPixelOffset; // NDC-space jitter for fake thick lines
  void main() {
    vec4 p = uProj * uView * uWorld * vec4(aPos, 1.0);
    p.xy += uPixelOffset * p.w;
    gl_Position = p;
  }
`

const WIRE_FS = `
  precision mediump float;
  uniform vec4 uColor;
  void main() { gl_FragColor = uColor; }
`

// ── Shadow pass: depth-only, no fragment writes needed ──────────────

const SHADOW_VS = `
  attribute vec3 aPos;
  attribute vec2 aUV;
  uniform mat4 uLightSpace;
  uniform mat4 uWorld;
  varying vec2 vUV;
  void main() {
    vUV = aUV;
    gl_Position = uLightSpace * uWorld * vec4(aPos, 1.0);
  }
`

// We still need a fragment shader to honour alpha-keyed primitives —
// otherwise transparent texels would cast solid shadows.
const SHADOW_FS = `
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
`

// ── Sky: vertical gradient quad ──────────────────────────────────────

const SKY_VS = `
  attribute vec2 aPos;
  varying vec2 vPos;
  void main() {
    vPos = aPos;
    gl_Position = vec4(aPos, 0.0, 1.0);
  }
`

const SKY_FS = `
  precision mediump float;
  varying vec2 vPos;
  uniform vec3 uTop;
  uniform vec3 uBottom;
  void main() {
    float t = clamp(vPos.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 col = mix(uBottom, uTop, smoothstep(0.0, 1.0, t));
    gl_FragColor = vec4(col, 1.0);
  }
`

// ── Ground plane: receives projected shadow ──────────────────────────

// SEA_WAVES_GLSL: the canonical wave height + slope used by BOTH the
// ground vertex shader (to displace surface tessellation) and the
// fragment shader (to re-evaluate the per-pixel normal).  Keeping
// the formula in one place is the only way the swell-crest silhouette
// and the per-pixel shading stay in sync; if they drift the surface
// reads as papered-on rather than truly waving.
//
// Returns:
//   .x = wave height (world Y offset)
//   .y = dH/dx (slope along world X)
//   .z = dH/dz (slope along world Z)
const GROUND_VS = `
  precision highp float;
  precision highp int;
  attribute vec3 aPos;
  uniform mat4 uProj;
  uniform mat4 uView;
  uniform mat4 uLightSpace;
  uniform float uGroundY;
  uniform float uSeabedY;
  uniform float uSeabedActive;
  uniform int uGroundMode;
  uniform float uTime;
  varying vec3 vWorldPos;
  varying vec4 vLightSpacePos;
  ${SEA_WAVES_GLSL}
  void main() {
    // Three displacement modes baked into one program:
    //   * Seabed pass — random rocks + dunes, at a depressed Y below
    //     the water plane.
    //   * Sea surface — the shared wave function rolls the tessellated
    //     quad in 3D so the silhouette actually crests.
    //   * Other ground modes — flat plane at uGroundY.
    float y;
    if (uSeabedActive > 0.5) {
      y = uSeabedY + seabedHeight(aPos.xz);
    } else if (uGroundMode == 2) {
      y = uGroundY + seaWaveHS(aPos.xz, uTime).x;
    } else {
      y = uGroundY;
    }
    vec3 worldPos = vec3(aPos.x, y, aPos.z);
    vWorldPos = worldPos;
    vLightSpacePos = uLightSpace * vec4(worldPos, 1.0);
    gl_Position = uProj * uView * vec4(worldPos, 1.0);
  }
`

const GROUND_FS = `
  precision highp float;
  precision highp int;
  ${SEA_WAVES_GLSL}
  varying vec3 vWorldPos;
  varying vec4 vLightSpacePos;
  uniform sampler2D uShadowMap;
  uniform sampler2D uTerrainTex;
  uniform float uShadowEnabled;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uCenter;
  uniform float uRadius;
  uniform int uGroundMode;       // 0 = grid, 1 = terrain (textured), 2 = sea (procedural waves), 3 = legacy plain
  uniform float uTileSize;       // world units per repeat (one TA map tile)
  uniform float uTerrainReady;   // 1 once the terrain texture has uploaded
  uniform float uTime;           // seconds since renderer start, drives sea animation
  uniform vec3 uLightDir;        // world-space direction toward the sun, used by Sea specular
  uniform vec3 uEyePos;          // camera world position — Sea Fresnel needs the real view dir
  uniform float uSeabedActive;   // 1 when this pass renders the seabed below the water
  uniform float uSeabedY;        // base Y of the seabed plane (below uGroundY)

  float sampleShadow() {
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

  void main() {
    vec2 g = vWorldPos.xz - uCenter.xz;
    float d = length(g);
    float fade = clamp(1.0 - d / (uRadius * 1.8), 0.0, 1.0);
    float shadow = sampleShadow();

    if (uGroundMode == 0) {
      // Grid mode: light-green lattice over a dark-green fill, sized
      // to one TA map tile (uTileSize world units per cell).  fwidth
      // would give crisper sub-pixel lines but isn't available in
      // WebGL1 by default — a small constant line width works fine.
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
      // Terrain mode: tile the greenworld flat texture.  REPEAT wrap
      // on the texture handles the UV overflow; no manual fract here.
      vec2 uv = vWorldPos.xz / uTileSize;
      vec3 base = texture2D(uTerrainTex, uv).rgb;
      base *= mix(1.0, shadow, 0.85 * fade);
      gl_FragColor = vec4(base, fade);
      return;
    }
    if (uSeabedActive > 0.5) {
      // ── Seabed pass: rocks + dunes lit by caustic light from
      // above.  Drawn first, depth-tested under the water surface.
      float bedH = seabedHeight(vWorldPos.xz);
      // Sand vs rock by elevation.
      vec3 sand = vec3(0.90, 0.80, 0.62);
      vec3 rock = vec3(0.42, 0.36, 0.30);
      float rockMix = smoothstep(0.4, 2.0, bedH);
      vec3 col = mix(sand, rock, rockMix);
      // Caustic net dances across the bed.  Tinted with the water
      // column so the light bands carry the lagoon's blue through
      // to the bottom.
      float caustic = seaCaustic(vWorldPos.xz, uTime);
      col += caustic * vec3(0.55, 0.85, 1.00) * 0.95;
      // Fake an "above-light" diffuse: sun mostly comes through the
      // surface, so we boost the unshadowed contribution and let
      // the caustic do most of the lighting work.  Real shadow
      // from above is too sharp to read underwater.
      col *= 0.55 + 0.45 * shadow;
      gl_FragColor = vec4(col, 1.0);
      return;
    }
    if (uGroundMode == 2) {
      // ── Sea-surface pass ────────────────────────────────────
      //
      // Translucent water on top of the rocky seabed: water column
      // colour (deep blue), sky reflection (Fresnel), sun specular,
      // sparkle, foam at crests, and an alpha that drops where the
      // seabed is shallow so the rocks show through.
      float t = uTime;
      vec3 hs = seaWaveHS(vWorldPos.xz, t);
      float h = hs.x;
      float dhx = hs.y;
      float dhz = hs.z;
      vec3 wn = normalize(vec3(-dhx, 1.0, -dhz));
      float slope = length(vec2(dhx, dhz));

      // ── Water column: cobalt → navy → midnight ───────────────
      // Bluer than the previous turquoise palette so the deep parts
      // read as ocean, not lagoon.  Three stops blend by an
      // "absorption" proxy that uses wave height (crests are
      // optically shallower).
      vec3 shallowTint = vec3(0.10, 0.45, 0.85);
      vec3 midTint     = vec3(0.04, 0.22, 0.62);
      vec3 deepTint    = vec3(0.02, 0.08, 0.24);
      float depthProxy = 1.6 - h;
      float absorb = exp(-depthProxy * 0.55);
      vec3 waterCol = mix(deepTint, midTint, smoothstep(0.0, 0.55, absorb));
      waterCol = mix(waterCol, shallowTint, smoothstep(0.55, 1.0, absorb));

      // ── Surface highlights ───────────────────────────────────
      vec3 V = normalize(uEyePos - vWorldPos);
      float ndv = max(0.0, dot(wn, V));
      float fresnel = pow(1.0 - ndv, 4.0);
      // Sky gradient: zenith blue, horizon warm peach.  Stops over
      // 1.0 because the tone-map pulls them back into range without
      // robbing saturation.
      vec3 skyTop = vec3(0.32, 0.58, 1.10);
      vec3 skyHor = vec3(1.15, 0.92, 0.65);
      vec3 sky = mix(skyTop, skyHor, fresnel);
      vec3 L = normalize(uLightDir);
      vec3 H = normalize(L + V);
      float ndh = max(0.0, dot(wn, H));
      float specBroad = pow(ndh, 28.0) * 0.95;
      float specTight = pow(ndh, 140.0) * 2.80;
      vec3 sunColor = vec3(1.40, 1.18, 0.85);
      float reflectivity = 0.10 + 0.90 * fresnel;
      vec3 surface = mix(waterCol, sky, reflectivity);
      surface += (specBroad + specTight) * sunColor;

      // ── Sun-glint sparkles dancing on wave peaks ─────────────
      vec3 Rd = reflect(-L, wn);
      float sparkleAlign = pow(max(0.0, dot(Rd, V)), 90.0) * 0.9
                         + pow(max(0.0, dot(Rd, V)), 280.0) * 3.0;
      float sparkleNoise = sin(vWorldPos.x * 9.0 + t * 2.7)
                         * sin(vWorldPos.z * 11.0 + t * 2.3)
                         * sin((vWorldPos.x + vWorldPos.z) * 5.0 - t * 1.7);
      float sparkle = sparkleAlign * smoothstep(0.28, 0.95, abs(sparkleNoise));
      surface += vec3(4.2, 3.80, 3.00) * sparkle;

      // ── Sub-surface scatter: backlit crest glow ──────────────
      float backlit = pow(max(0.0, dot(L, -V)) * 0.5 + 0.5, 2.0)
                    * smoothstep(0.20, 0.80, h);
      surface += vec3(0.18, 0.55, 0.95) * backlit * 0.55;

      // ── Foam ─────────────────────────────────────────────────
      // Three contributions:
      //   * Crest foam — accumulates on the very top of tall waves.
      //   * Breaking foam — slopes + height: where the wave is steep
      //     and tall it has "broken".
      //   * Haze foam — small streaks from chop.
      float crestFoam = smoothstep(1.10, 2.10, h) * 0.95;
      float breakingFoam = smoothstep(0.30, 0.55, slope) * smoothstep(0.40, 0.95, h);
      float hazeFoam     = smoothstep(0.12, 0.28, slope) * 0.35;
      surface = mix(surface, vec3(1.08, 1.10, 1.12),
                    clamp(crestFoam + breakingFoam + hazeFoam * 0.5, 0.0, 0.92));

      surface *= mix(1.0, shadow, 0.18 * fade);
      surface = surface / (surface * 0.55 + vec3(0.55));
      // Alpha: shallower (seabed close to surface) ⇒ more
      // transparent so rocks show through; deeper sand → opaque
      // blue.  bedDepth is positive distance from surface to bed.
      float bedAtXZ = uSeabedY + seabedHeight(vWorldPos.xz);
      float bedDepth = max(0.0, vWorldPos.y - bedAtXZ);
      float aOut = mix(0.30, 0.92, smoothstep(0.4, 3.5, bedDepth));
      aOut = mix(aOut, 0.95, fresnel * 0.6) * fade;
      gl_FragColor = vec4(surface, aOut);
      return;
    }

    // Legacy / fallback: same gentle decorative ground we used before
    // the three-mode rework.  Reached when terrain mode is selected
    // but the tile texture hasn't uploaded yet.
    float footprintMask = smoothstep(uRadius * 1.0, uRadius * 1.6, d);
    float grid = step(0.5, fract(g.x * 0.05) + fract(g.y * 0.05));
    vec3 base = mix(uColorA, uColorB, grid * 0.18 * footprintMask);
    base *= mix(1.0, shadow, 0.85 * fade);
    gl_FragColor = vec4(base, fade);
  }
`

export class ModelRenderer {
  constructor({ canvas, textureCache, gl }) {
    this.canvas = canvas
    const ctx = gl || canvas.getContext('webgl', { antialias: true, premultipliedAlpha: false, stencil: false })
    if (!ctx) throw new Error('WebGL unavailable')
    this.gl = ctx
    this.textureCache = textureCache
    this.model = null

    // Light comes from above-left-forward.  Direction points *toward*
    // the light from the model — typical convention for dot(N, L).
    this.lightDir = ModelRenderer.#normalise([-0.6, 0.95, 0.4])
    this.lightColor = [1.05, 1.0, 0.92]
    this.skyColor = [0.65, 0.7, 0.78]
    this.groundColor = [0.18, 0.16, 0.13]
    this.skyTop = [0.35, 0.45, 0.6]
    this.skyBottom = [0.07, 0.09, 0.12]
    this.groundColorA = [0.12, 0.14, 0.18]
    this.groundColorB = [0.18, 0.2, 0.25]

    this.autoRotate = true
    this.rotateY = 0
    this.lastFrameMs = 0
    this.running = false
    this.rafId = 0
    // _t0: monotonic clock baseline for the Sea ground shader's
    // animated waves (uTime = (now − _t0) / 1000).  Anchored at
    // construction so each ModelRenderer has its own t=0.
    this._t0 = performance.now()
    // hoveredPieceName: the piece currently hovered in the sidebar
    // tree, set by the host UI via setHoveredPieceName.  Triggers a
    // red-wireframe overlay around just that piece during draw.
    this._hoveredPieceName = null

    // ── View settings ────────────────────────────────────────────────
    // renderMode: 'full' (lit + textured), 'flat' (textured + flat
    // shading, no shadows), or 'wireframe' (line edges only).
    this.renderMode = 'full'
    // wireframeOverlay: draw the wireframe edges on top of whichever
    // mode is active.  Independent of renderMode.
    this.wireframeOverlay = false
    // wireframeWidth: thickness hint passed to gl.lineWidth.  Most
    // drivers cap at 1 — to make wider lines visible the renderer
    // also draws the wireframe pass multiple times with a tiny NDC
    // jitter as a cheap fake "wider line" fallback.
    this.wireframeWidth = 1
    // groundMode: 'grid' (light-green TA-tile lattice), 'terrain'
    // (greenworld flat texture, tiled), or 'off' (no ground plane).
    this.groundMode = 'terrain'
    // ── Terrain texture (lazy-loaded the first time the user picks
    // the Terrain ground mode).  GL texture ID + a ready flag the
    // ground shader uses to fall back to its plain look until decode.
    this._terrainTex = null
    this._terrainReady = false
    // Tileset name to fetch when the user picks Terrain.  Future
    // hook for tileset switching from the UI.
    this.terrainTileset = 'greenworld'

    // Enable optional extensions.  Anisotropic gets forwarded to the
    // texture cache so future uploads use it; depth-texture gates the
    // entire shadow-mapping pipeline.
    this._depthExt = ctx.getExtension('WEBGL_depth_texture') || ctx.getExtension('WEBKIT_WEBGL_depth_texture')
    const aniso = ctx.getExtension('EXT_texture_filter_anisotropic') || ctx.getExtension('WEBKIT_EXT_texture_filter_anisotropic')
    if (aniso && textureCache) textureCache.setAnisotropicExt(aniso)

    this.#initMainProgram()
    this.#initShadowProgram()
    this.#initSkyProgram()
    this.#initGroundProgram()
    this.#initWireProgram()
    if (this._depthExt) this.#initShadowFBO()

    // Scratch matrices live on the instance so per-frame work doesn't
    // allocate.  worldScratch threads through Piece.computeWorldMatrix.
    this._scratch = Mat4.create()
    this._worldScratch = Mat4.create()
    this._modelMatrix = Mat4.identity(Mat4.create())
    this._lightView = Mat4.create()
    this._lightProj = Mat4.create()
    this._lightSpace = Mat4.create()

    if (this.textureCache) this.textureCache.onAnyTextureReady = () => this.requestRedraw()

    // Kick off the terrain texture fetch eagerly — the user's first
    // sight of the viewer should already have grass, not the
    // procedural fallback ground.
    if (this.groundMode === 'terrain') this.#loadTerrainTexture()
  }

  setModel(model) {
    this.model = model
  }

  setCamera(camera) {
    this.camera = camera
  }

  setAutoRotate(on) {
    this.autoRotate = !!on
  }

  setRenderMode(mode) {
    if (['full', 'flat', 'wireframe'].includes(mode)) this.renderMode = mode
    this.requestRedraw()
  }

  setWireframeOverlay(on) {
    this.wireframeOverlay = !!on
    this.requestRedraw()
  }

  setWireframeWidth(px) {
    const n = Math.max(1, Math.min(6, parseInt(px, 10) || 1))
    this.wireframeWidth = n
    this.requestRedraw()
  }

  setHoveredPieceName(name) {
    const next = (typeof name === 'string' && name) ? name.toLowerCase() : null
    if (next === this._hoveredPieceName) return
    this._hoveredPieceName = next
    this.requestRedraw()
  }

  setGroundMode(mode) {
    if (!['grid', 'terrain', 'sea', 'off'].includes(mode)) return
    this.groundMode = mode
    if (mode === 'terrain' && !this._terrainTex) this.#loadTerrainTexture()
    // Sea mode wants the renderer ticking every frame so its time
    // uniform advances the wave animation even when auto-rotate is
    // off.  Start the RAF loop if it isn't already running.
    if (mode === 'sea' && !this.running) this.start()
    this.requestRedraw()
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr))
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr))
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
  }

  start() {
    if (this.running) return
    this.running = true
    this.lastFrameMs = performance.now()
    const loop = (ts) => {
      if (!this.running) return
      const dt = Math.min(0.1, (ts - this.lastFrameMs) / 1000)
      this.lastFrameMs = ts
      if (this.autoRotate && this.camera) {
        // Drive the camera's orbit yaw rather than spinning the
        // model in place — that way the ground / sea rotate WITH
        // the unit (they don't, of course, but the camera moving
        // around them produces the same parallax) and the user
        // can pick up a manual drag from wherever the auto-rotate
        // left off.
        this.camera.yaw += dt * (Math.PI / 15)
      }
      this.draw()
      this.rafId = requestAnimationFrame(loop)
    }
    this.rafId = requestAnimationFrame(loop)
  }

  stop() {
    this.running = false
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
  }

  requestRedraw() {
    if (this.running) return
    requestAnimationFrame(() => this.draw())
  }

  draw() {
    const gl = this.gl
    this.resize()

    if (!this.camera || !this.model) {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
      gl.clearColor(this.skyBottom[0], this.skyBottom[1], this.skyBottom[2], 1)
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      return
    }

    // In Sea mode the unit bobs on the swell — height + pitch + roll
    // come from sampling the same wave function the surface uses, so
    // the hull rides exactly the visible water under it.  Other
    // ground modes leave the model matrix identity (auto-rotate now
    // spins the camera around a stationary scene).
    Mat4.identity(this._modelMatrix)
    if (this.groundMode === 'sea' && this.model) {
      const t = (performance.now() - this._t0) / 1000
      const cx = (this.model.bounds.min[0] + this.model.bounds.max[0]) * 0.5
      const cz = (this.model.bounds.min[2] + this.model.bounds.max[2]) * 0.5
      this._applySeaBob(this._modelMatrix, cx, cz, t)
    }

    // Compute light-space matrix on every frame because the model
    // bounds change between loads and the auto-rotate yaw moves
    // geometry under the static world-space light.
    this.#updateLightMatrices()

    const aspect = gl.drawingBufferWidth / Math.max(1, gl.drawingBufferHeight)
    const span = Math.hypot(
      this.model.bounds.max[0] - this.model.bounds.min[0],
      this.model.bounds.max[1] - this.model.bounds.min[1],
      this.model.bounds.max[2] - this.model.bounds.min[2],
    )
    this.camera.updateMatrices(aspect, Math.max(0.05, span * 0.01), Math.max(100, span * 20 + 200))

    // Shadow pass is meaningful only when the main pass actually uses
    // shadows.  In Flat / Wireframe modes we skip it to save GPU.
    const usesShadows = this.renderMode === 'full'
    if (this._shadowFBO && usesShadows) this.#renderShadowPass()

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.BLEND)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

    this.#renderSky()

    // Depth-test enabled for ground + model.  LEQUAL so coplanar
    // base/decal pairs both contribute (same trick as before).
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LEQUAL)
    gl.disable(gl.CULL_FACE)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    // Studio Mode + Sea ground: render an upside-down "reflection"
    // copy of the unit BEFORE the water surface so the water tints
    // it as the surface paints over the reflected geometry.  Other
    // modes / grounds skip this — flat shading + wireframes don't
    // need the cinematic effect.
    const showReflection = this.renderMode === 'full' && this.groundMode === 'sea'
    if (showReflection) this.#renderReflection()
    if (this.groundMode !== 'off') this.#renderGround()

    if (this.renderMode === 'wireframe') {
      this.#renderWireframe([0.85, 0.92, 1.0, 1.0])
    } else {
      this.#renderMain(this.renderMode === 'flat')
      if (this.wireframeOverlay) {
        // Polygon offset isn't reliable in WebGL1 across drivers, so
        // we draw the overlay at very-low alpha with depth test still
        // on — line pixels that match the surface depth (LEQUAL)
        // overdraw the surface without z-fight.
        this.#renderWireframe([1.0, 1.0, 1.0, 0.55])
      }
    }
    if (this._hoveredPieceName) {
      // Hover highlight: bright red wireframe on just the hovered
      // piece, drawn AFTER the main scene with depth-test disabled
      // so it always sits on top, even on parts hidden behind other
      // geometry.  Helps the user pinpoint which piece a tree row
      // refers to even when it's tucked behind another panel.
      this.#renderHoverHighlight()
    }
  }

  #renderHoverHighlight() {
    const gl = this.gl
    gl.useProgram(this.programWire)
    gl.uniformMatrix4fv(this.uWireProj, false, this.camera.projMatrix)
    gl.uniformMatrix4fv(this.uWireView, false, this.camera.viewMatrix)
    gl.uniform4fv(this.uWireColor, [1.0, 0.25, 0.30, 1.0])
    gl.uniform2f(this.uWirePixelOffset, 0, 0)
    // Disable depth test so the highlight survives even when the
    // piece sits behind other geometry from the camera's POV.
    gl.disable(gl.DEPTH_TEST)
    gl.lineWidth?.(2)
    const draw = (piece, parent) => {
      if (!piece) return
      piece.computeWorldMatrix(parent, this._worldScratch)
      const lower = piece.name?.toLowerCase()
      if (piece.visible && piece.wireframe && lower === this._hoveredPieceName) {
        gl.uniformMatrix4fv(this.uWireWorld, false, piece.worldMatrix)
        gl.bindBuffer(gl.ARRAY_BUFFER, piece.wireframe.vbo)
        gl.enableVertexAttribArray(this.aWirePos)
        gl.vertexAttribPointer(this.aWirePos, 3, gl.FLOAT, false, 0, 0)
        gl.drawArrays(gl.LINES, 0, piece.wireframe.vertexCount)
      }
      for (const c of piece.children) draw(c, piece.worldMatrix)
    }
    draw(this.model.root, this._modelMatrix)
    gl.enable(gl.DEPTH_TEST)
  }

  dispose() {
    this.stop()
    const gl = this.gl
    if (this.model) this.model.dispose(gl)
    if (this.programMain) gl.deleteProgram(this.programMain)
    if (this.programShadow) gl.deleteProgram(this.programShadow)
    if (this.programSky) gl.deleteProgram(this.programSky)
    if (this.programGround) gl.deleteProgram(this.programGround)
    if (this.programWire) gl.deleteProgram(this.programWire)
    if (this._shadowFBO) gl.deleteFramebuffer(this._shadowFBO)
    if (this._shadowTex) gl.deleteTexture(this._shadowTex)
    if (this._terrainTex) gl.deleteTexture(this._terrainTex)
    if (this._skyVBO) gl.deleteBuffer(this._skyVBO)
    if (this._groundVBO) gl.deleteBuffer(this._groundVBO)
    if (this.textureCache) this.textureCache.dispose()
  }

  // ── Frame: shadow pass ──────────────────────────────────────────────

  #renderShadowPass() {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._shadowFBO)
    gl.viewport(0, 0, SHADOW_MAP_SIZE, SHADOW_MAP_SIZE)
    gl.clearColor(1, 1, 1, 1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LEQUAL)
    // Front-face cull during the shadow pass eliminates "peter-pan"
    // (model floating above its shadow) and the worst of self-shadow
    // acne on planar surfaces.
    gl.enable(gl.CULL_FACE)
    gl.cullFace(gl.FRONT)
    gl.disable(gl.BLEND)

    gl.useProgram(this.programShadow)
    gl.uniformMatrix4fv(this.uShadowLightSpace, false, this._lightSpace)
    this.#drawGeometry(this.model.root, this._modelMatrix, true)

    gl.disable(gl.CULL_FACE)
  }

  // ── Frame: sky pass ─────────────────────────────────────────────────

  #renderSky() {
    const gl = this.gl
    gl.useProgram(this.programSky)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._skyVBO)
    gl.enableVertexAttribArray(this.aSkyPos)
    gl.vertexAttribPointer(this.aSkyPos, 2, gl.FLOAT, false, 0, 0)
    gl.uniform3fv(this.uSkyTop, this.skyTop)
    gl.uniform3fv(this.uSkyBottom, this.skyBottom)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    gl.disableVertexAttribArray(this.aSkyPos)
  }

  // ── Frame: ground plane pass ───────────────────────────────────────

  #renderGround() {
    const gl = this.gl
    gl.useProgram(this.programGround)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._groundVBO)
    gl.enableVertexAttribArray(this.aGroundPos)
    gl.vertexAttribPointer(this.aGroundPos, 3, gl.FLOAT, false, 0, 0)
    gl.uniformMatrix4fv(this.uGroundProj, false, this.camera.projMatrix)
    gl.uniformMatrix4fv(this.uGroundView, false, this.camera.viewMatrix)
    gl.uniformMatrix4fv(this.uGroundLightSpace, false, this._lightSpace)
    gl.uniform3fv(this.uGroundColorA, this.groundColorA)
    gl.uniform3fv(this.uGroundColorB, this.groundColorB)
    // Position the ground plane just under the model's lowest vertex
    // so the unit always stands ON it — not above (looks like it's
    // floating) nor below (foot geometry pokes through).
    const groundY = this.model.bounds.min[1] - 0.05
    const cx = (this.model.bounds.min[0] + this.model.bounds.max[0]) * 0.5
    const cz = (this.model.bounds.min[2] + this.model.bounds.max[2]) * 0.5
    const span = Math.hypot(this.model.bounds.max[0] - this.model.bounds.min[0], this.model.bounds.max[2] - this.model.bounds.min[2])
    gl.uniform3fv(this.uGroundCenter, [cx, groundY, cz])
    gl.uniform1f(this.uGroundRadius, Math.max(span * 0.6, 4))
    gl.uniform1f(this.uGroundY, groundY)
    gl.uniform1f(this.uGroundShadowEnabled, (this._shadowFBO && this.renderMode === 'full') ? 1 : 0)
    if (this._shadowFBO) {
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, this._shadowTex)
      gl.uniform1i(this.uGroundShadowMap, 1)
    }
    // Mode + terrain texture.  TileSize ≈ 16 world units per cell —
    // matches TA's footprint convention (a "1x1" footprint slot in
    // a unit's FBI is ~16 world units), so a small unit covers one
    // grid cell and a Krogoth-class hulk straddles a few.
    const modeId = this.groundMode === 'grid' ? 0
      : this.groundMode === 'terrain' ? 1
      : this.groundMode === 'sea' ? 2
      : 3
    gl.uniform1i(this.uGroundModeId, modeId)
    gl.uniform1f(this.uGroundTileSize, 16)
    gl.uniform1f(this.uGroundTerrainReady, this._terrainReady ? 1 : 0)
    gl.uniform1f(this.uGroundTime, (performance.now() - this._t0) / 1000)
    gl.uniform3fv(this.uGroundLightDir, this.lightDir)
    gl.uniform3fv(this.uGroundEyePos, this.camera.eye)
    if (this._terrainTex) {
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, this._terrainTex)
      gl.uniform1i(this.uGroundTerrainTex, 2)
    }
    // In Sea mode, render the rocky seabed first (depressed Y, fully
    // opaque) and the translucent water surface on top.  The water
    // shader's per-fragment alpha drops where the bed sits close to
    // the surface so the rocks visibly poke through.  Other ground
    // modes skip the seabed pass entirely.
    const seabedY = groundY - 4.0
    gl.uniform1f(this.uGroundSeabedY, seabedY)
    if (this.groundMode === 'sea') {
      // Pass 1: seabed (opaque).  Write depth normally so the water
      // surface above will reject any fragments hidden behind tall
      // rocks (e.g. peaks poking above the trough Y).
      gl.uniform1f(this.uGroundSeabedActive, 1)
      gl.disable(gl.BLEND)
      gl.drawArrays(gl.TRIANGLES, 0, this._groundVertexCount || 6)
      gl.enable(gl.BLEND)
      gl.uniform1f(this.uGroundSeabedActive, 0)
    }
    gl.drawArrays(gl.TRIANGLES, 0, this._groundVertexCount || 6)
    gl.disableVertexAttribArray(this.aGroundPos)
  }

  // ── Frame: reflection pass for Studio Mode on Sea ───────────
  //
  // Renders the model a second time mirrored across the water
  // plane.  Result is the upside-down unit sitting just under the
  // water surface — when the ground (water) pass paints over it
  // with the translucent blue tint, what reads on screen is a
  // proper aquatic reflection (dimmer + bluer toward the deeper
  // troughs, brighter at the crests).  The main shader's
  // uReflectionTint uniform pushes the colour palette + alpha so
  // this pass doesn't look like a full duplicate of the unit.
  #renderReflection() {
    const gl = this.gl
    gl.useProgram(this.programMain)
    gl.uniformMatrix4fv(this.uProj, false, this.camera.projMatrix)
    gl.uniformMatrix4fv(this.uView, false, this.camera.viewMatrix)
    gl.uniformMatrix4fv(this.uLightSpace, false, this._lightSpace)
    gl.uniform3fv(this.uLightDir, this.lightDir)
    gl.uniform3fv(this.uLightColor, this.lightColor)
    gl.uniform3fv(this.uSkyColor, this.skyColor)
    gl.uniform3fv(this.uGroundColor, this.groundColor)
    gl.uniform1f(this.uFlatLighting, 0)
    gl.uniform1f(this.uShadowEnabled, 0) // reflection doesn't read the depth map
    gl.uniform1f(this.uReflectionTint, 1)
    // Reflection pass paints the mirrored unit dim+blue.  Sea bounce
    // on top of that would double-glow the reflection, so leave it
    // off for this pass.
    gl.uniform1f(this.uSeaActive, 0)
    gl.uniform1f(this.uMainTime, (performance.now() - this._t0) / 1000)

    // Mirror across water Y = model.bounds.min[1] - 0.05 (same Y
    // the ground plane sits at).  reflectMatrix = T(0, 2*Y, 0) * S(1,-1,1)
    // composed with the bob transform so the reflection rides the
    // swell upside-down in lock-step with the boat above.
    const waterY = this.model.bounds.min[1] - 0.05
    const mirror = this._scratch
    Mat4.identity(mirror)
    mirror[5] = -1                     // scale Y by -1
    mirror[13] = 2 * waterY            // translate Y by 2 * waterY
    const refl = this._scratch2 || (this._scratch2 = Mat4.create())
    if (this.groundMode === 'sea' && this.model) {
      const t = (performance.now() - this._t0) / 1000
      const cx = (this.model.bounds.min[0] + this.model.bounds.max[0]) * 0.5
      const cz = (this.model.bounds.min[2] + this.model.bounds.max[2]) * 0.5
      const bob = this._bobScratch || (this._bobScratch = Mat4.create())
      Mat4.identity(bob)
      this._applySeaBob(bob, cx, cz, t)
      Mat4.multiply(refl, mirror, bob)
    } else {
      Mat4.copy(refl, mirror)
    }
    // Blending: reflection paints with alpha (set by the fragment
    // shader when uReflectionTint > 0.5).  Depth write OFF so the
    // water surface afterwards can still draw — without this the
    // reflection geometry would occlude itself in weird ways at
    // the water plane.
    gl.depthMask(false)
    this.#drawGeometry(this.model.root, refl, false)
    gl.depthMask(true)

    gl.uniform1f(this.uReflectionTint, 0)
  }

  // ── Frame: main scene pass ─────────────────────────────────────────

  #renderMain(flat) {
    const gl = this.gl
    gl.useProgram(this.programMain)
    gl.uniformMatrix4fv(this.uProj, false, this.camera.projMatrix)
    gl.uniformMatrix4fv(this.uView, false, this.camera.viewMatrix)
    gl.uniformMatrix4fv(this.uLightSpace, false, this._lightSpace)
    gl.uniform3fv(this.uLightDir, this.lightDir)
    gl.uniform3fv(this.uLightColor, this.lightColor)
    gl.uniform3fv(this.uSkyColor, this.skyColor)
    gl.uniform3fv(this.uGroundColor, this.groundColor)
    // Flat mode bypasses the directional + ambient + shadow path so
    // the renderer prints the raw texture / palette colour.
    gl.uniform1f(this.uFlatLighting, flat ? 1 : 0)
    gl.uniform1f(this.uReflectionTint, 0)
    gl.uniform1f(this.uShadowEnabled, (this._shadowFBO && !flat) ? 1 : 0)
    gl.uniform1f(this.uShadowBias, 0.0025)
    // Sea bounce/shimmer: only paint onto the hull when the unit is
    // actually sitting on water AND we're in full studio mode.  Flat
    // and wireframe modes bypass it.
    gl.uniform1f(this.uSeaActive, (!flat && this.groundMode === 'sea') ? 1 : 0)
    gl.uniform1f(this.uMainTime, (performance.now() - this._t0) / 1000)
    if (this._shadowFBO && !flat) {
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, this._shadowTex)
      gl.uniform1i(this.uShadowMap, 1)
    }
    this.#drawGeometry(this.model.root, this._modelMatrix, false)
  }

  // #renderWireframe walks the piece tree and emits each piece's
  // wireframe VBO as GL_LINES.  WebGL's gl.lineWidth is widely
  // ignored by modern drivers (max width 1), so for any width > 1
  // we draw multiple passes with the line program's `uPixelOffset`
  // shoving each pass by ±1 pixel in screen space — a poor man's
  // "thick lines" that actually shows up cross-platform.
  #renderWireframe(color) {
    const gl = this.gl
    const width = Math.max(1, this.wireframeWidth | 0)
    gl.useProgram(this.programWire)
    gl.uniformMatrix4fv(this.uWireProj, false, this.camera.projMatrix)
    gl.uniformMatrix4fv(this.uWireView, false, this.camera.viewMatrix)
    gl.uniform4fv(this.uWireColor, color)
    try { gl.lineWidth(width) } catch { /* spec says only width 1 is required */ }
    const vw = gl.drawingBufferWidth || 1
    const vh = gl.drawingBufferHeight || 1
    const offsets = width <= 1 ? [[0, 0]] : this.#thickLineOffsets(width, vw, vh)
    const drawOnce = (piece, parent) => {
      if (!piece) return
      piece.computeWorldMatrix(parent, this._worldScratch)
      if (piece.visible && piece.wireframe) {
        gl.uniformMatrix4fv(this.uWireWorld, false, piece.worldMatrix)
        gl.bindBuffer(gl.ARRAY_BUFFER, piece.wireframe.vbo)
        gl.enableVertexAttribArray(this.aWirePos)
        gl.vertexAttribPointer(this.aWirePos, 3, gl.FLOAT, false, 0, 0)
        gl.drawArrays(gl.LINES, 0, piece.wireframe.vertexCount)
      }
      for (const c of piece.children) drawOnce(c, piece.worldMatrix)
    }
    for (const [dx, dy] of offsets) {
      gl.uniform2f(this.uWirePixelOffset, dx, dy)
      drawOnce(this.model.root, this._modelMatrix)
    }
    gl.uniform2f(this.uWirePixelOffset, 0, 0)
  }

  // #thickLineOffsets returns a ring of NDC-space pixel offsets for
  // a given thickness.  Sample around the centre so 2 px → 5 passes
  // (centre + N/E/S/W), 3 px → 9, etc.  Each (dx, dy) is in NDC
  // (range -1..+1), so we divide pixel deltas by half the viewport.
  #thickLineOffsets(width, vw, vh) {
    const out = []
    const r = (width - 1) / 2
    const step = 1.0
    for (let dy = -r; dy <= r; dy += step) {
      for (let dx = -r; dx <= r; dx += step) {
        out.push([(dx * 2) / vw, (dy * 2) / vh])
      }
    }
    return out
  }

  // #drawGeometry walks the piece tree and issues one drawArrays per
  // draw group.  `shadowPass` toggles between the texture-aware main
  // shader and the depth-only shadow shader; both share the same VBO
  // layout (pos, normal, uv) so we only need to flip which attribute
  // pointers and uniforms get updated.
  #drawGeometry(rootPiece, parentWorld, shadowPass) {
    const gl = this.gl
    const draw = (piece, parent) => {
      if (!piece) return
      piece.computeWorldMatrix(parent, this._worldScratch)
      if (piece.visible) {
        if (shadowPass) {
          gl.uniformMatrix4fv(this.uShadowWorld, false, piece.worldMatrix)
        } else {
          gl.uniformMatrix4fv(this.uWorld, false, piece.worldMatrix)
        }
        for (const group of piece.drawGroups) {
          gl.bindBuffer(gl.ARRAY_BUFFER, group.vbo)
          // Coplanar layers: apply a polygon offset proportional to
          // the group's tier so they win the depth test cleanly
          // instead of z-fighting against the base.  Tier 0 means
          // "first / base" — no offset.  Higher tiers nudge toward
          // the camera (negative factor & units).
          if (group.depthTier > 0) {
            gl.enable(gl.POLYGON_OFFSET_FILL)
            gl.polygonOffset(-group.depthTier, -group.depthTier)
          } else {
            gl.disable(gl.POLYGON_OFFSET_FILL)
          }
          if (shadowPass) {
            gl.enableVertexAttribArray(this.aShadowPos)
            gl.enableVertexAttribArray(this.aShadowUV)
            gl.vertexAttribPointer(this.aShadowPos, 3, gl.FLOAT, false, VERTEX_STRIDE, POS_OFFSET)
            gl.vertexAttribPointer(this.aShadowUV, 2, gl.FLOAT, false, VERTEX_STRIDE, UV_OFFSET)
            if (group.textureName && this.textureCache) {
              const entry = this.textureCache.get(group.textureName)
              gl.activeTexture(gl.TEXTURE0)
              gl.bindTexture(gl.TEXTURE_2D, entry.tex)
              gl.uniform1i(this.uShadowTex, 0)
              gl.uniform1i(this.uShadowMode, 0)
            } else {
              gl.uniform1i(this.uShadowMode, 1)
            }
          } else {
            gl.enableVertexAttribArray(this.aPos)
            gl.enableVertexAttribArray(this.aNormal)
            gl.enableVertexAttribArray(this.aUV)
            gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, VERTEX_STRIDE, POS_OFFSET)
            gl.vertexAttribPointer(this.aNormal, 3, gl.FLOAT, false, VERTEX_STRIDE, NRM_OFFSET)
            gl.vertexAttribPointer(this.aUV, 2, gl.FLOAT, false, VERTEX_STRIDE, UV_OFFSET)
            if (group.textureName && this.textureCache) {
              const entry = this.textureCache.get(group.textureName)
              gl.activeTexture(gl.TEXTURE0)
              gl.bindTexture(gl.TEXTURE_2D, entry.tex)
              gl.uniform1i(this.uTex, 0)
              gl.uniform1i(this.uMode, 0)
            } else if (group.color) {
              gl.uniform4fv(this.uTint, group.color)
              gl.uniform1i(this.uMode, 1)
            } else {
              gl.uniform4fv(this.uTint, [0.45, 0.45, 0.5, 1])
              gl.uniform1i(this.uMode, 1)
            }
          }
          gl.drawArrays(group.mode, 0, group.vertexCount)
        }
        // Reset polygon offset after each piece so it doesn't bleed
        // into subsequent unrelated draws (ground plane, etc.).
        gl.disable(gl.POLYGON_OFFSET_FILL)
      }
      for (const c of piece.children) draw(c, piece.worldMatrix)
    }
    draw(rootPiece, parentWorld)
  }

  // seaWaveSample mirrors GROUND_VS/FS's seaWaveHS() in plain JS so
  // the CPU can position the unit on the same surface the GPU draws.
  // Returns { h, dhx, dhz } — vertical offset plus partials.  Stay in
  // sync with SEA_WAVES_GLSL above; the boat's bobbing is built on
  // top of this and any drift between the two would float the unit
  // off the water.  Sampling the JS copy at the same (x, z, t) the
  // GPU does keeps the silhouette and the unit's heave consistent.
  seaWaveSample(x, z, t) {
    const p1x = x * 0.085, p1z = z * 0.085
    const p2x = x * 0.21, p2z = z * 0.21
    const p3x = x * 0.46, p3z = z * 0.46
    const p4x = x * 1.05, p4z = z * 1.05
    const p5x = x * 2.40, p5z = z * 2.40
    const ph1a = p1x * 0.97 + p1z * 0.21 + t * 0.42
    const ph1b = p1z * 1.05 - p1x * 0.18 - t * 0.36
    const ph2a = p2x * 0.78 - p2z * 0.62 + t * 0.80
    const ph2b = p2x * 0.21 + p2z * 0.93 - t * 0.72
    const ph3a = p3x * 1.13 + p3z * 0.71 + t * 1.55
    const ph3b = p3x * 0.42 - p3z * 1.07 + t * 1.30
    const ph4a = p4x * 1.31 + p4z * 0.87 + t * 2.30
    const ph4b = p4x * 0.55 - p4z * 1.21 + t * 2.65
    const ph5a = p5x * 0.93 + p5z * 0.47 + t * 3.85
    const ph5b = p5x * 0.27 - p5z * 1.11 + t * 4.20
    const h = Math.sin(ph1a) * 0.55 + Math.sin(ph1b) * 0.55
            + Math.sin(ph2a) * 0.42 + Math.sin(ph2b) * 0.32
            + Math.sin(ph3a) * 0.22 + Math.sin(ph3b) * 0.18
            + Math.sin(ph4a) * 0.10 + Math.sin(ph4b) * 0.10
            + Math.sin(ph5a) * 0.03 + Math.sin(ph5b) * 0.03
    const dhx = Math.cos(ph1a) * 0.97 * 0.085 * 0.55
              + Math.cos(ph1b) * (-0.18) * 0.085 * 0.55
              + Math.cos(ph2a) * 0.78 * 0.21 * 0.42
              + Math.cos(ph2b) * 0.21 * 0.21 * 0.32
              + Math.cos(ph3a) * 1.13 * 0.46 * 0.22
              + Math.cos(ph3b) * 0.42 * 0.46 * 0.18
              + Math.cos(ph4a) * 1.31 * 1.05 * 0.10
              + Math.cos(ph4b) * 0.55 * 1.05 * 0.10
              + Math.cos(ph5a) * 0.93 * 2.40 * 0.03
              + Math.cos(ph5b) * 0.27 * 2.40 * 0.03
    const dhz = Math.cos(ph1a) * 0.21 * 0.085 * 0.55
              + Math.cos(ph1b) * 1.05 * 0.085 * 0.55
              + Math.cos(ph2a) * (-0.62) * 0.21 * 0.42
              + Math.cos(ph2b) * 0.93 * 0.21 * 0.32
              + Math.cos(ph3a) * 0.71 * 0.46 * 0.22
              + Math.cos(ph3b) * (-1.07) * 0.46 * 0.18
              + Math.cos(ph4a) * 0.87 * 1.05 * 0.10
              + Math.cos(ph4b) * (-1.21) * 1.05 * 0.10
              + Math.cos(ph5a) * 0.47 * 2.40 * 0.03
              + Math.cos(ph5b) * (-1.11) * 2.40 * 0.03
    return { h, dhx, dhz }
  }

  // _applySeaBob composes T(0, h, 0) * Rx(pitch) * Rz(roll) onto a
  // matrix in place.  pitch comes from the surface slope along Z
  // (boat's nose dips into the trough), roll from the slope along X
  // (boat rolls toward the down-slope side).
  //
  // The bob is decoupled from the surface animation:
  //   * `tSlow = t * 0.75` — the boat rocks 25% slower than the
  //     visible wave train, so a battleship doesn't dart up and
  //     down like a buoy.
  //   * `BOB_SCALE = 0.30` — vertical heave and tilt are scaled to
  //     30% of the raw slope/height so even tall waves only nudge
  //     the unit.  A real ship's inertia damps high-frequency
  //     surface motion; this is the visual analogue.
  _applySeaBob(out, x, z, t) {
    const tSlow = t * 0.75
    const s = this.seaWaveSample(x, z, tSlow)
    const BOB_SCALE = 0.30
    const tilt = 0.55 * BOB_SCALE
    const pitch = Math.atan2(s.dhz, 1) * tilt
    const roll  = -Math.atan2(s.dhx, 1) * tilt
    Mat4.translate(out, out, 0, s.h * BOB_SCALE, 0)
    Mat4.rotateX(out, out, pitch)
    Mat4.rotateZ(out, out, roll)
  }

  // #updateLightMatrices builds the light's view + ortho projection
  // so the shadow map covers the entire model footprint plus a chunk
  // of the ground plane.  Light position is the model centroid pushed
  // back along the light direction; ortho extents follow the model's
  // bounding sphere.
  #updateLightMatrices() {
    const min = this.model.bounds.min
    const max = this.model.bounds.max
    const cx = (min[0] + max[0]) * 0.5
    const cy = (min[1] + max[1]) * 0.5
    const cz = (min[2] + max[2]) * 0.5
    const dx = max[0] - min[0], dy = max[1] - min[1], dz = max[2] - min[2]
    const radius = 0.5 * Math.hypot(dx, dy, dz)
    // Pad so corners of the bounding box (rotated by auto-rotate yaw)
    // never fall outside the light's frustum.
    const r = Math.max(2, radius * 1.6)
    const dist = Math.max(r * 3, r + 5)
    const eye = [cx + this.lightDir[0] * dist, cy + this.lightDir[1] * dist, cz + this.lightDir[2] * dist]
    Mat4.lookAt(this._lightView, eye, [cx, cy, cz], [0, 1, 0])
    Mat4.ortho(this._lightProj, -r, r, -r, r, 0.1, dist + r * 2)
    Mat4.multiply(this._lightSpace, this._lightProj, this._lightView)
  }

  // ── Shader/program setup ───────────────────────────────────────────

  #initMainProgram() {
    const prog = this.#linkProgram(MAIN_VS, MAIN_FS)
    this.programMain = prog
    const gl = this.gl
    this.aPos = gl.getAttribLocation(prog, 'aPos')
    this.aNormal = gl.getAttribLocation(prog, 'aNormal')
    this.aUV = gl.getAttribLocation(prog, 'aUV')
    this.uProj = gl.getUniformLocation(prog, 'uProj')
    this.uView = gl.getUniformLocation(prog, 'uView')
    this.uWorld = gl.getUniformLocation(prog, 'uWorld')
    this.uLightSpace = gl.getUniformLocation(prog, 'uLightSpace')
    this.uTex = gl.getUniformLocation(prog, 'uTex')
    this.uShadowMap = gl.getUniformLocation(prog, 'uShadowMap')
    this.uMode = gl.getUniformLocation(prog, 'uMode')
    this.uTint = gl.getUniformLocation(prog, 'uTint')
    this.uLightDir = gl.getUniformLocation(prog, 'uLightDir')
    this.uLightColor = gl.getUniformLocation(prog, 'uLightColor')
    this.uSkyColor = gl.getUniformLocation(prog, 'uSkyColor')
    this.uGroundColor = gl.getUniformLocation(prog, 'uGroundColor')
    this.uShadowEnabled = gl.getUniformLocation(prog, 'uShadowEnabled')
    this.uShadowBias = gl.getUniformLocation(prog, 'uShadowBias')
    this.uFlatLighting = gl.getUniformLocation(prog, 'uFlatLighting')
    this.uReflectionTint = gl.getUniformLocation(prog, 'uReflectionTint')
    this.uSeaActive = gl.getUniformLocation(prog, 'uSeaActive')
    this.uMainTime = gl.getUniformLocation(prog, 'uTime')
  }

  #initShadowProgram() {
    const prog = this.#linkProgram(SHADOW_VS, SHADOW_FS)
    this.programShadow = prog
    const gl = this.gl
    this.aShadowPos = gl.getAttribLocation(prog, 'aPos')
    this.aShadowUV = gl.getAttribLocation(prog, 'aUV')
    this.uShadowLightSpace = gl.getUniformLocation(prog, 'uLightSpace')
    this.uShadowWorld = gl.getUniformLocation(prog, 'uWorld')
    this.uShadowTex = gl.getUniformLocation(prog, 'uTex')
    this.uShadowMode = gl.getUniformLocation(prog, 'uMode')
  }

  #initSkyProgram() {
    const prog = this.#linkProgram(SKY_VS, SKY_FS)
    this.programSky = prog
    const gl = this.gl
    this.aSkyPos = gl.getAttribLocation(prog, 'aPos')
    this.uSkyTop = gl.getUniformLocation(prog, 'uTop')
    this.uSkyBottom = gl.getUniformLocation(prog, 'uBottom')
    // Full-screen triangle pair in NDC.
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, 1, 1,
      -1, -1, 1, 1, -1, 1,
    ]), gl.STATIC_DRAW)
    this._skyVBO = buf
  }

  #initGroundProgram() {
    const prog = this.#linkProgram(GROUND_VS, GROUND_FS)
    this.programGround = prog
    const gl = this.gl
    this.aGroundPos = gl.getAttribLocation(prog, 'aPos')
    this.uGroundProj = gl.getUniformLocation(prog, 'uProj')
    this.uGroundView = gl.getUniformLocation(prog, 'uView')
    this.uGroundLightSpace = gl.getUniformLocation(prog, 'uLightSpace')
    this.uGroundShadowMap = gl.getUniformLocation(prog, 'uShadowMap')
    this.uGroundShadowEnabled = gl.getUniformLocation(prog, 'uShadowEnabled')
    this.uGroundColorA = gl.getUniformLocation(prog, 'uColorA')
    this.uGroundColorB = gl.getUniformLocation(prog, 'uColorB')
    this.uGroundCenter = gl.getUniformLocation(prog, 'uCenter')
    this.uGroundRadius = gl.getUniformLocation(prog, 'uRadius')
    this.uGroundY = gl.getUniformLocation(prog, 'uGroundY')
    this.uGroundModeId = gl.getUniformLocation(prog, 'uGroundMode')
    this.uGroundTileSize = gl.getUniformLocation(prog, 'uTileSize')
    this.uGroundTerrainReady = gl.getUniformLocation(prog, 'uTerrainReady')
    this.uGroundTerrainTex = gl.getUniformLocation(prog, 'uTerrainTex')
    this.uGroundTime = gl.getUniformLocation(prog, 'uTime')
    this.uGroundLightDir = gl.getUniformLocation(prog, 'uLightDir')
    this.uGroundEyePos = gl.getUniformLocation(prog, 'uEyePos')
    this.uGroundSeabedY = gl.getUniformLocation(prog, 'uSeabedY')
    this.uGroundSeabedActive = gl.getUniformLocation(prog, 'uSeabedActive')
    // Lazy-allocate; #renderGround sizes the quad on each draw to keep
    // it large enough for the current model.  For now, a 400×400 plane
    // at y=0 works for every TA unit (largest mass is the Krogoth at
    // ~60 world units across).
    // Tessellated sea-plane: the swell needs real vertex displacement
    // to read as a 3D surface, so the quad becomes a NxN triangle grid.
    // 96² (≈9.2k tris) is comfortably within mobile GPU budgets and
    // gives ~4 wu spacing — finer than the shortest swell wavelength
    // so crests aren't aliased.  Grid mode / Terrain / Off all just
    // ignore the extra vertices (their Y is uGroundY).
    const half = 200
    const N = 96
    const verts = []
    const step = (2 * half) / N
    for (let j = 0; j < N; j++) {
      const z0 = -half + j * step
      const z1 = z0 + step
      for (let i = 0; i < N; i++) {
        const x0 = -half + i * step
        const x1 = x0 + step
        verts.push(x0, 0, z0,  x1, 0, z0,  x1, 0, z1)
        verts.push(x0, 0, z0,  x1, 0, z1,  x0, 0, z1)
      }
    }
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW)
    this._groundVBO = buf
    this._groundVertexCount = verts.length / 3
  }

  #initWireProgram() {
    const prog = this.#linkProgram(WIRE_VS, WIRE_FS)
    this.programWire = prog
    const gl = this.gl
    this.aWirePos = gl.getAttribLocation(prog, 'aPos')
    this.uWireProj = gl.getUniformLocation(prog, 'uProj')
    this.uWireView = gl.getUniformLocation(prog, 'uView')
    this.uWireWorld = gl.getUniformLocation(prog, 'uWorld')
    this.uWireColor = gl.getUniformLocation(prog, 'uColor')
    this.uWirePixelOffset = gl.getUniformLocation(prog, 'uPixelOffset')
  }

  // #loadTerrainTexture pulls the active tileset's flat-tile PNG from
  // the new /api/studio/ground-tile endpoint, uploads it with REPEAT
  // wrapping (so the ground shader can tile-sample by world-space
  // coords), and flips `_terrainReady` so the shader graduates from
  // its fallback look to real terrain.
  #loadTerrainTexture() {
    if (this._terrainTex) return
    const gl = this.gl
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.src = `/api/studio/ground-tile/${encodeURIComponent(this.terrainTileset)}`
    img.addEventListener('load', () => {
      const tex = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT)
      const pot = (img.naturalWidth & (img.naturalWidth - 1)) === 0 && (img.naturalHeight & (img.naturalHeight - 1)) === 0
      if (pot) {
        gl.generateMipmap(gl.TEXTURE_2D)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      this._terrainTex = tex
      this._terrainReady = true
      this.requestRedraw()
    }, { once: true })
    img.addEventListener('error', () => {
      console.warn(`terrain texture failed to load for tileset ${this.terrainTileset}`)
    }, { once: true })
  }

  #initShadowFBO() {
    const gl = this.gl
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT, SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const fbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0)
    // Some WebGL1 implementations also require a color attachment.
    const color = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, color)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0)
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      // Disable shadow mapping if the driver refused our setup; the
      // main shader's uShadowEnabled flag falls back to flat lighting.
      console.warn(`shadow FBO incomplete (0x${status.toString(16)}), shadows disabled`)
      gl.deleteFramebuffer(fbo)
      gl.deleteTexture(tex)
      gl.deleteTexture(color)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      this._depthExt = null
      return
    }
    this._shadowFBO = fbo
    this._shadowTex = tex
    this._shadowColorTex = color
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  #linkProgram(vsSrc, fsSrc) {
    const gl = this.gl
    const compile = (src, type) => {
      const sh = gl.createShader(type)
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(sh)
        gl.deleteShader(sh)
        throw new Error(`shader compile failed: ${info}`)
      }
      return sh
    }
    const vs = compile(vsSrc, gl.VERTEX_SHADER)
    const fs = compile(fsSrc, gl.FRAGMENT_SHADER)
    const prog = gl.createProgram()
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`program link failed: ${gl.getProgramInfoLog(prog)}`)
    }
    return prog
  }

  static #normalise(v) {
    const len = Math.hypot(v[0], v[1], v[2])
    if (len === 0) return [0, 1, 0]
    return [v[0] / len, v[1] / len, v[2] / len]
  }
}
