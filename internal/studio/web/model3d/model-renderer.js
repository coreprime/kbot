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
import { loadAllShaders } from './shader-loader.js'

const VERTEX_STRIDE = 9 * 4 // 9 floats × 4 bytes (pos×3, normal×3, uv×2, ao×1)
const POS_OFFSET = 0
const NRM_OFFSET = 3 * 4
const UV_OFFSET = 6 * 4
const AO_OFFSET = 8 * 4

const SHADOW_MAP_SIZE = 1024

// Shader sources live in shaders/{main,sky,ground,shadow,wire,dof}/
// as .vert/.frag files so they open with proper GLSL highlighting in
// editors.  shader-loader.js fetches + resolves `#include` directives
// and the renderer pulls the bodies via init() before linking
// programs.  All the inline template-literal shader constants that
// used to live here have moved to those files; this comment is the
// trail of breadcrumbs.

// SKY_PRESETS: every aesthetic knob the skybox shader reads.  Each
// preset is a fully-formed sky scheme — call ModelRenderer.setSky-
// Scheme('alien-twin') and the whole sky redraws to match.  Adding a
// new preset is a single object literal here — no shader edits.
//
// Keys:
//   * zenith / horizon: gradient stops (linear-ish RGB; can exceed 1
//     because the renderer doesn't tone-map the sky pass).
//   * sun1 / sun2: { color, dir, size }.  color = [0,0,0] disables.
//     size ~0.005 = pinpoint star, ~0.04 = soft halo.
//   * cloudColor / cloudShadow: highlight + body tints.
//   * cloudCoverage: 0..1, fraction of sky filled.
//   * cloudDensity: 0..1, opacity of cloud bodies on top of sky.
//   * cloudSpeed: drift velocity (UV units per second).
//
// The renderer falls back to sun1.dir = current scene lightDir when
// the preset doesn't specify one — that way the unit's shadows match
// the visible sun without the caller having to keep both in sync.
const SKY_PRESETS = {
  earth: {
    name: 'Earth (day)',
    zenith: [0.18, 0.42, 0.85],
    horizon: [0.78, 0.86, 0.95],
    // sun1 sits low above the horizon so it actually appears in the
    // default camera view (which mostly looks at the unit, with a
    // narrow strip of sky above).  The unit's shadow light direction
    // is the renderer's separate `lightDir` — keeping them split
    // lets us put the visible sun where the camera is pointing
    // without disturbing the unit's shading.
    zenith2: [0.18, 0.42, 0.85],
    sun1: { color: [2.40, 1.95, 1.30], dir: [-0.45, 0.35, -0.85], size: 0.040 },
    sun2: { color: [0, 0, 0], dir: [0, 1, 0], size: 0 },
    cloudColor: [1.20, 1.18, 1.15],
    cloudShadow: [0.45, 0.55, 0.70],
    cloudCoverage: 0.78,
    cloudDensity: 0.95,
    cloudSpeed: 0.012,
  },
  sunset: {
    name: 'Earth (sunset)',
    zenith: [0.18, 0.18, 0.45],
    horizon: [1.35, 0.55, 0.30],
    sun1: { color: [2.60, 1.20, 0.45], dir: [-0.60, 0.18, 0.78], size: 0.055 },
    sun2: { color: [0, 0, 0], dir: [0, 1, 0], size: 0 },
    cloudColor: [1.30, 0.85, 0.65],
    cloudShadow: [0.40, 0.22, 0.30],
    cloudCoverage: 0.55,
    cloudDensity: 0.85,
    cloudSpeed: 0.008,
  },
  alienTwin: {
    name: 'Alien (twin suns)',
    zenith: [0.18, 0.05, 0.42],
    horizon: [0.85, 0.45, 0.70],
    // Twin suns sit on either side of the default camera's forward
    // axis (yaw=215 deg, pitch=18 deg → forward ≈ (0.55, -0.31, 0.78))
    // so BOTH land in the sky strip above the unit.  Amber sun1
    // toward the left, cool-blue sun2 toward the right; their
    // shadows splay in opposite directions (visible on the ground
    // beneath any unit).  Sizes bumped enough that the discs read
    // as discrete bodies in the small sky strip the default view
    // exposes — 0.045/0.030 used to disappear into the gradient.
    sun1: { color: [2.60, 1.20, 0.55], dir: [-0.55, 0.45, 0.70], size: 0.070 },
    sun2: { color: [0.65, 1.05, 2.10], dir: [ 0.85, 0.30, 0.50], size: 0.055 },
    cloudColor: [0.85, 0.50, 0.70],
    cloudShadow: [0.30, 0.08, 0.25],
    cloudCoverage: 0.70,
    cloudDensity: 0.75,
    cloudSpeed: 0.020,
  },
  mars: {
    name: 'Mars (dusty)',
    zenith: [0.55, 0.32, 0.20],
    horizon: [1.05, 0.65, 0.35],
    sun1: { color: [1.55, 1.20, 0.85], dir: [-0.40, 0.30, 0.80], size: 0.030 },
    sun2: { color: [0, 0, 0], dir: [0, 1, 0], size: 0 },
    cloudColor: [0.75, 0.55, 0.40],
    cloudShadow: [0.40, 0.22, 0.15],
    cloudCoverage: 0.30,
    cloudDensity: 0.45,
    cloudSpeed: 0.025,
  },
  night: {
    name: 'Earth (night)',
    zenith: [0.02, 0.03, 0.10],
    horizon: [0.08, 0.12, 0.22],
    sun1: { color: [1.30, 1.35, 1.55], dir: [-0.50, 0.50, 0.70], size: 0.015 },
    sun2: { color: [0, 0, 0], dir: [0, 1, 0], size: 0 },
    cloudColor: [0.30, 0.32, 0.38],
    cloudShadow: [0.08, 0.10, 0.16],
    cloudCoverage: 0.40,
    cloudDensity: 0.55,
    cloudSpeed: 0.006,
  },
  arctic: {
    name: 'Arctic (pale)',
    zenith: [0.55, 0.65, 0.78],
    horizon: [0.92, 0.95, 0.98],
    sun1: { color: [1.60, 1.55, 1.30], dir: [-0.45, 0.30, -0.78], size: 0.030 },
    sun2: { color: [0, 0, 0], dir: [0, 1, 0], size: 0 },
    cloudColor: [1.05, 1.05, 1.08],
    cloudShadow: [0.65, 0.70, 0.78],
    cloudCoverage: 0.65,
    cloudDensity: 0.85,
    cloudSpeed: 0.010,
  },
  lava: {
    name: 'Lava world',
    zenith: [0.35, 0.10, 0.05],
    horizon: [1.30, 0.45, 0.15],
    sun1: { color: [2.20, 0.70, 0.15], dir: [-0.40, 0.25, -0.80], size: 0.045 },
    sun2: { color: [0, 0, 0], dir: [0, 1, 0], size: 0 },
    cloudColor: [0.95, 0.55, 0.35],
    cloudShadow: [0.30, 0.10, 0.05],
    cloudCoverage: 0.45,
    cloudDensity: 0.75,
    cloudSpeed: 0.018,
  },
  desert: {
    name: 'Desert (hot)',
    zenith: [0.42, 0.55, 0.80],
    horizon: [1.20, 0.95, 0.55],
    sun1: { color: [2.30, 1.85, 1.10], dir: [-0.40, 0.30, -0.85], size: 0.038 },
    sun2: { color: [0, 0, 0], dir: [0, 1, 0], size: 0 },
    cloudColor: [1.15, 1.05, 0.85],
    cloudShadow: [0.55, 0.45, 0.30],
    cloudCoverage: 0.30,
    cloudDensity: 0.55,
    cloudSpeed: 0.015,
  },
  archipelago: {
    name: 'Archipelago',
    // Tropical clear sky — strong blue above, hazy white at horizon.
    zenith: [0.10, 0.45, 0.92],
    horizon: [0.85, 0.95, 1.02],
    sun1: { color: [2.50, 2.20, 1.55], dir: [-0.45, 0.45, -0.78], size: 0.030 },
    sun2: { color: [0, 0, 0], dir: [0, 1, 0], size: 0 },
    cloudColor: [1.15, 1.15, 1.18],
    cloudShadow: [0.65, 0.72, 0.80],
    cloudCoverage: 0.35,
    cloudDensity: 0.70,
    cloudSpeed: 0.012,
  },
  metal: {
    name: 'Metal world',
    // Cloudless metallic sky — neutral steel above, hot exhaust
    // band at horizon (think industrial smog without the clouds).
    zenith: [0.32, 0.36, 0.42],
    horizon: [0.85, 0.78, 0.65],
    sun1: { color: [1.95, 1.85, 1.65], dir: [-0.50, 0.45, -0.75], size: 0.025 },
    sun2: { color: [0, 0, 0], dir: [0, 1, 0], size: 0 },
    cloudColor: [0.0, 0.0, 0.0],
    cloudShadow: [0.0, 0.0, 0.0],
    cloudCoverage: 0.0,   // no clouds per request
    cloudDensity: 0.0,
    cloudSpeed: 0.0,
  },
  lunar: {
    name: 'Lunar',
    // Airless world — near-black sky shading into a faint planet
    // glow at the horizon.  No clouds because no atmosphere.
    zenith: [0.005, 0.008, 0.025],
    horizon: [0.12, 0.10, 0.16],
    sun1: { color: [3.00, 2.85, 2.55], dir: [-0.45, 0.55, -0.70], size: 0.020 },
    sun2: { color: [0, 0, 0], dir: [0, 1, 0], size: 0 },
    cloudColor: [0.0, 0.0, 0.0],
    cloudShadow: [0.0, 0.0, 0.0],
    cloudCoverage: 0.0,
    cloudDensity: 0.0,
    cloudSpeed: 0.0,
  },
  slate: {
    name: 'Slate (overcast)',
    // Gunmetal overcast sky — heavy cloud cover, diffuse light.
    zenith: [0.32, 0.34, 0.38],
    horizon: [0.65, 0.65, 0.68],
    sun1: { color: [1.20, 1.20, 1.18], dir: [-0.45, 0.65, -0.65], size: 0.040 },
    sun2: { color: [0, 0, 0], dir: [0, 1, 0], size: 0 },
    cloudColor: [0.78, 0.78, 0.80],
    cloudShadow: [0.40, 0.40, 0.45],
    cloudCoverage: 0.95,
    cloudDensity: 0.85,
    cloudSpeed: 0.018,
  },
  marsh: {
    name: 'Marsh (hazy)',
    // Swampy haze — yellowed sky with low-hanging clouds.
    zenith: [0.55, 0.60, 0.55],
    horizon: [0.92, 0.88, 0.65],
    sun1: { color: [1.85, 1.65, 1.10], dir: [-0.45, 0.55, -0.70], size: 0.045 },
    sun2: { color: [0, 0, 0], dir: [0, 1, 0], size: 0 },
    cloudColor: [0.92, 0.88, 0.72],
    cloudShadow: [0.45, 0.42, 0.30],
    cloudCoverage: 0.55,
    cloudDensity: 0.70,
    cloudSpeed: 0.008,
  },
}

// ENVIRONMENT_PRESETS bundle every visual world knob into one
// switchable choice — sky scheme, terrain tileset, water tints,
// even the light direction.  setEnvironment(name) on the renderer
// swaps the whole stack so the user picks "Mars" once and the sky,
// ground, water, and shadows all match.
//
// Tilesets reference the TA tilesets served from /api/studio/ground-
// tile/{tileset}.  Unknown ones fall back to 'greenworld' at the
// server-side handler, so a typo is a visual mismatch, not a crash.
//
// waterShallow / waterDeep / waterAccent are not yet plumbed into
// the sea shader; defined here so a future water-tint pass can pick
// up the preset without re-editing the renderer.  For now the sea
// shader uses its built-in aqua palette.
// ENVIRONMENT_PRESETS map onto Total Annihilation's actual map
// tilesets where one exists — Greenworld is the default since most
// TA maps use it, and the other built-in TA tilesets get their own
// thematically appropriate water + seabed + sky settings.  A few
// extras (sunset / night / alien-twin) extend the picker for
// special moods without needing dedicated tileset assets.
//
// Per-environment fields:
//   * sky                — name of a SKY_PRESETS entry
//   * terrainTileset     — passed to /api/studio/ground-tile/{name}
//   * lightDir           — world-space direction toward the sun
//   * waterShallow/Mid/Deep — three-stop water column tint
//   * waterTranslucency  — alpha multiplier (0.5 = opaque, 1.5 = glass)
//   * seabedSand/Rock    — colours of the seabed dunes + outcrops
//   * seabedCaustic      — tint of the caustic light shaft on the bed
// Gravity table — per-environment world-Y acceleration in wu/sec²,
// consumed by the ballistic aim solver to set barrel pitch on
// cannon-class weapons.  Earth-like tilesets use ~80 (calibrated so
// the ARM_BATS cannon at its 1250 wu range / 350 wu/sec velocity
// elevates to ~28°, which matches the visual TA cannon-up posture).
// Lunar drops to a quarter, Mars to ~⅜ — so switching environment
// visibly changes the barrel angle for the same range.
//
// Indexed by ENVIRONMENT_PRESETS key.  Anything not listed falls
// back to GRAVITY_EARTH.  Exposed via renderer.getGravity() so
// mv-controls can re-query each aim cycle without poking internals.
const GRAVITY_EARTH = 80
const GRAVITY_BY_ENV = {
  greenworld:  80,
  archipelago: 80,
  desert:      80,
  marsh:       80,
  arctic:      80,
  slate:       80,
  sunset:      80,
  night:       80,
  alienTwin:   90,   // alien world — heavier
  metal:       80,
  lava:        80,
  mars:        30,   // ~⅜ Earth
  moon:        20,   // ~¼ Earth (ENVIRONMENT_PRESETS key)
}
const ENVIRONMENT_PRESETS = {
  greenworld: {
    name: 'Greenworld',
    sky: 'earth',
    terrainTileset: 'greenworld',
    lightDir: [-0.6, 0.95, 0.4],
    // Deeper blue ocean per request — moves away from the previous
    // tropical aqua toward a temperate / open-ocean look.
    waterShallow: [0.10, 0.40, 0.72],
    waterMid:     [0.04, 0.18, 0.45],
    waterDeep:    [0.01, 0.05, 0.20],
    waterTranslucency: 0.95,
    seabedSand:    [0.25, 0.32, 0.30],
    seabedRock:    [0.14, 0.18, 0.18],
    seabedCaustic: [0.35, 0.65, 0.95],
    // Rocky mountain ring - mossy green-brown lowlands climbing to
    // pale grey-blue peaks.  Default for the temperate-Earth feel.
    mountainStyle: 0,
    mountainHeight: 62,
    mountainScale: 1.0,
    mountainBase: [0.28, 0.32, 0.22],
    mountainPeak: [0.72, 0.78, 0.80],
    mountainGloss: 0.0,
  },
  archipelago: {
    name: 'Archipelago',
    sky: 'archipelago',
    terrainTileset: 'archipelago',
    lightDir: [-0.50, 0.92, 0.35],
    // Crystal Caribbean: vibrant aqua, very translucent so the
    // pale sandy bed reads clearly through the water.
    waterShallow: [0.40, 0.92, 0.95],
    waterMid:     [0.12, 0.65, 0.85],
    waterDeep:    [0.04, 0.22, 0.45],
    waterTranslucency: 1.55,
    seabedSand:    [0.95, 0.92, 0.78],   // white tropical sand
    seabedRock:    [0.78, 0.72, 0.55],
    seabedCaustic: [0.95, 0.95, 0.85],
    // Low tropical headlands - shorter peaks, pale beachy tones.
    mountainStyle: 0,
    mountainHeight: 40,
    mountainScale: 1.3,
    mountainBase: [0.68, 0.62, 0.42],
    mountainPeak: [0.92, 0.88, 0.72],
    mountainGloss: 0.0,
  },
  metal: {
    name: 'Metal world',
    sky: 'metal',
    terrainTileset: 'metal',
    lightDir: [-0.55, 0.85, 0.30],
    // Oily industrial liquid: thick dark goo with a metallic sheen
    // at the top, drops to deep black underneath.  Translucency
    // pushed down so the bed is barely visible — this stuff isn't
    // water, it's coolant.
    waterShallow: [0.32, 0.30, 0.28],
    waterMid:     [0.14, 0.12, 0.12],
    waterDeep:    [0.04, 0.04, 0.05],
    waterTranslucency: 0.55,
    seabedSand:    [0.22, 0.22, 0.24],
    seabedRock:    [0.36, 0.32, 0.28],   // rust-stained metal plates
    seabedCaustic: [0.55, 0.55, 0.65],
    // Angular metal protrusions - mechanical, plated, glossy.
    // Style 1 triggers the ridged-value noise + panel grid in
    // ground.frag so these read as fabricated structures.
    mountainStyle: 1,
    mountainHeight: 80,
    mountainScale: 0.85,
    mountainBase: [0.18, 0.20, 0.24],
    mountainPeak: [0.55, 0.58, 0.65],
    mountainGloss: 0.85,
  },
  lava: {
    name: 'Lava world',
    sky: 'lava',
    terrainTileset: 'lava',
    lightDir: [-0.50, 0.70, 0.40],
    // Glowing molten lake — yellow-hot crusts breaking through
    // dark cooled flows, going black in the deeps.  Translucency
    // up because the molten layer is bright enough to bleed.
    waterShallow: [1.40, 0.55, 0.08],
    waterMid:     [0.85, 0.18, 0.02],
    waterDeep:    [0.18, 0.04, 0.01],
    waterTranslucency: 1.15,
    seabedSand:    [0.55, 0.20, 0.08],   // cooled lava crust
    seabedRock:    [0.18, 0.06, 0.03],
    seabedCaustic: [1.50, 0.85, 0.25],
    // Volcanic stratovolcanoes - dark obsidian lowlands, glowing
    // red-orange near the peaks where fresh lava cools.
    mountainStyle: 0,
    mountainHeight: 95,
    mountainScale: 1.1,
    mountainBase: [0.18, 0.07, 0.04],
    mountainPeak: [0.85, 0.32, 0.10],
    mountainGloss: 0.0,
  },
  moon: {
    name: 'Lunar',
    sky: 'lunar',
    terrainTileset: 'moon',
    lightDir: [-0.45, 0.85, 0.35],
    // Lunar water — barely there.  Cold pale blue tint with very
    // high translucency so the bed dominates the look.  Stylised
    // — there's obviously no real water on the moon.
    waterShallow: [0.45, 0.55, 0.70],
    waterMid:     [0.20, 0.30, 0.45],
    waterDeep:    [0.05, 0.08, 0.18],
    waterTranslucency: 1.85,
    seabedSand:    [0.62, 0.60, 0.58],   // lunar regolith
    seabedRock:    [0.32, 0.30, 0.28],
    seabedCaustic: [0.80, 0.85, 0.95],
    // Lunar highlands - cratered grey, no atmosphere so no haze
    // pull on the peaks.  Lower height than Earth ranges.
    mountainStyle: 0,
    mountainHeight: 55,
    mountainScale: 1.4,
    mountainBase: [0.32, 0.32, 0.32],
    mountainPeak: [0.78, 0.78, 0.78],
    mountainGloss: 0.0,
  },
  mars: {
    name: 'Mars',
    sky: 'mars',
    terrainTileset: 'mars',
    lightDir: [-0.55, 0.65, 0.40],
    // Purple Martian water as requested — rusty mauve at the top,
    // deepening to dark indigo.
    waterShallow: [0.62, 0.38, 0.72],
    waterMid:     [0.32, 0.18, 0.50],
    waterDeep:    [0.08, 0.04, 0.18],
    waterTranslucency: 0.90,
    seabedSand:    [0.55, 0.30, 0.22],   // iron-oxide red
    seabedRock:    [0.32, 0.18, 0.14],
    seabedCaustic: [0.80, 0.55, 0.85],
    // Rust-red Martian highlands.
    mountainStyle: 0,
    mountainHeight: 70,
    mountainScale: 1.2,
    mountainBase: [0.48, 0.22, 0.14],
    mountainPeak: [0.85, 0.55, 0.35],
    mountainGloss: 0.0,
  },
  slate: {
    name: 'Slate',
    sky: 'slate',
    terrainTileset: 'slate',
    lightDir: [-0.45, 0.85, 0.40],
    // Cold grey water under overcast sky — like a quarry pool.
    waterShallow: [0.32, 0.38, 0.42],
    waterMid:     [0.15, 0.20, 0.25],
    waterDeep:    [0.04, 0.06, 0.10],
    waterTranslucency: 0.80,
    seabedSand:    [0.28, 0.30, 0.30],
    seabedRock:    [0.15, 0.17, 0.18],
    seabedCaustic: [0.55, 0.65, 0.75],
    // Cold grey quarry crags.
    mountainStyle: 0,
    mountainHeight: 65,
    mountainScale: 1.05,
    mountainBase: [0.22, 0.24, 0.26],
    mountainPeak: [0.62, 0.66, 0.70],
    mountainGloss: 0.0,
  },
  marsh: {
    name: 'Marsh',
    sky: 'marsh',
    terrainTileset: 'marsh',
    lightDir: [-0.45, 0.85, 0.40],
    // Tannin-stained swamp water — brown-green muddy translucent.
    waterShallow: [0.45, 0.55, 0.30],
    waterMid:     [0.20, 0.28, 0.12],
    waterDeep:    [0.06, 0.10, 0.04],
    waterTranslucency: 0.85,
    seabedSand:    [0.32, 0.30, 0.18],
    seabedRock:    [0.15, 0.18, 0.10],
    seabedCaustic: [0.65, 0.75, 0.45],
    // Marshland hummocks - flat-ish terrain in the distance, mossy.
    mountainStyle: 0,
    mountainHeight: 42,
    mountainScale: 1.4,
    mountainBase: [0.20, 0.22, 0.14],
    mountainPeak: [0.45, 0.52, 0.32],
    mountainGloss: 0.0,
  },
  desert: {
    name: 'Desert (acid)',
    sky: 'desert',
    terrainTileset: 'desert',
    lightDir: [-0.55, 0.85, 0.35],
    // Acid lake — pale chartreuse shallows over toxic green deeps.
    waterShallow: [0.55, 0.92, 0.30],
    waterMid:     [0.18, 0.55, 0.15],
    waterDeep:    [0.05, 0.18, 0.06],
    waterTranslucency: 0.95,
    seabedSand:    [0.55, 0.48, 0.22],   // dry yellow dirt
    seabedRock:    [0.28, 0.22, 0.10],
    seabedCaustic: [0.85, 0.95, 0.45],
    // Sand dunes - style 2 picks the smooth rolling profile.
    mountainStyle: 2,
    mountainHeight: 52,
    mountainScale: 1.5,
    mountainBase: [0.62, 0.45, 0.22],
    mountainPeak: [0.92, 0.75, 0.45],
    mountainGloss: 0.0,
  },
  sunset: {
    name: 'Sunset',
    sky: 'sunset',
    terrainTileset: 'greenworld',
    lightDir: [-0.55, 0.35, 0.50],
    // Lit warm at the surface by the low sun, deepening to a
    // muted purple-blue underneath.
    waterShallow: [0.55, 0.55, 0.65],
    waterMid:     [0.20, 0.20, 0.45],
    waterDeep:    [0.05, 0.05, 0.18],
    waterTranslucency: 0.95,
    seabedSand:    [0.32, 0.25, 0.22],
    seabedRock:    [0.18, 0.12, 0.10],
    seabedCaustic: [0.85, 0.55, 0.45],
    // Sunset-warm mountain silhouettes.
    mountainStyle: 0,
    mountainHeight: 62,
    mountainScale: 1.0,
    mountainBase: [0.28, 0.18, 0.18],
    mountainPeak: [0.88, 0.55, 0.38],
    mountainGloss: 0.0,
  },
  night: {
    name: 'Night',
    sky: 'night',
    terrainTileset: 'greenworld',
    lightDir: [-0.40, 0.85, 0.30],
    waterShallow: [0.10, 0.20, 0.32],
    waterMid:     [0.04, 0.08, 0.18],
    waterDeep:    [0.01, 0.02, 0.06],
    waterTranslucency: 0.85,
    seabedSand:    [0.10, 0.12, 0.15],
    seabedRock:    [0.04, 0.05, 0.08],
    seabedCaustic: [0.20, 0.35, 0.55],
    // Night-time silhouettes - dim, cool grey-blue.
    mountainStyle: 0,
    mountainHeight: 62,
    mountainScale: 1.0,
    mountainBase: [0.08, 0.10, 0.14],
    mountainPeak: [0.32, 0.38, 0.48],
    mountainGloss: 0.0,
  },
  alienTwin: {
    name: 'Alien (twin suns)',
    sky: 'alienTwin',
    terrainTileset: 'moon',
    lightDir: [-0.45, 0.75, 0.40],
    // Bioluminescent alien water — cyan shallows, electric teal
    // mid, deep void.
    waterShallow: [0.30, 0.95, 0.85],
    waterMid:     [0.12, 0.50, 0.65],
    waterDeep:    [0.04, 0.10, 0.22],
    waterTranslucency: 1.10,
    seabedSand:    [0.42, 0.32, 0.55],
    seabedRock:    [0.20, 0.12, 0.32],
    seabedCaustic: [0.60, 1.00, 0.95],
    // Alien angular spires - sharp metal-style ridges in a deep
    // bioluminescent palette.
    mountainStyle: 1,
    mountainHeight: 85,
    mountainScale: 0.9,
    mountainBase: [0.16, 0.10, 0.28],
    mountainPeak: [0.55, 0.32, 0.78],
    mountainGloss: 0.65,
  },
}

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
    // Brighter than 1.0 — Studio Mode was reading darker than Flat /
    // Wireframe because the per-pixel lighting goes through the
    // tone-map (`col / (col + 0.55)`), which clips a single light
    // unit to ~0.65 luminance.  Bumping the sun + ambient pushes
    // typical hull pixels back into a comfortable 0.7-0.85 range.
    this.lightColor = [1.55, 1.45, 1.30]
    // Optional second light, used by the twin-sun environment.  All
    // zeros → no second light, no second shadow pass.  Set by
    // setEnvironment when the active sky scheme defines sun2.
    this.lightDir2 = [0, 1, 0]
    this.lightColor2 = [0, 0, 0]
    // skyScheme picks the gradient + suns + clouds painted by the
    // skybox shader.  Setter `setSkyScheme(name)` swaps presets at
    // runtime; the renderer doesn't care which preset is active —
    // it just hands the uniforms to the GPU each frame.
    this.skyScheme = SKY_PRESETS.earth
    // activeEnvironment tracks the full env preset (sky scheme +
    // terrain + light dir + water tints).  Pulled from each frame
    // when the sea shader needs its tint stops.
    this.activeEnvironment = ENVIRONMENT_PRESETS.greenworld
    this.skyColor = [0.95, 1.00, 1.08]
    this.groundColor = [0.32, 0.30, 0.26]
    this.skyTop = [0.35, 0.45, 0.6]
    this.skyBottom = [0.07, 0.09, 0.12]
    this.groundColorA = [0.12, 0.14, 0.18]
    this.groundColorB = [0.18, 0.2, 0.25]

    // Team colour picker.  When teamColorEnable is true, the MAIN_FS
    // shifts the texture's blue (hue ≈ 225°) team palette range to
    // this RGB.  The "blue" team is the original game default, so
    // null means "leave the texture alone".
    this.teamColor = null
    this.teamColorEnable = false

    // Background mountain ring.  The renderer paints procedural
    // mountains on non-sea ground modes, outside a clearing centred
    // on the unit.  Style + colours come from the active environment
    // preset; the radius / falloff / height multiplier scale with
    // the unit's bounding span so a Krogoth gets a bigger valley
    // than a flea.  optBgTerrain gates the whole feature.
    this.optBgTerrain = true
    this.bgTerrainHeightMul = 1.0       // user-controlled scalar applied to env's mountainHeight
    this.bgTerrainScaleMul = 1.0        // user-controlled scalar applied to env's mountainScale
    this.bgTerrainStyle = 0             // 0=rocky 1=angular metal 2=sand dunes (env overrides on setEnv)
    this.bgTerrainBase = [0.30, 0.30, 0.34]
    this.bgTerrainPeak = [0.85, 0.85, 0.90]
    this.bgTerrainGloss = 0.0
    // Seabed feature sliders mirror the same idea for sea worlds.
    // These multiply uniforms in the GLSL seabedHeight() helper - 1.0
    // = stock tuning, 0 = smooth dune-only bed, larger = more
    // dramatic outcrops.
    this.seabedHeightMul = 1.0
    this.seabedScaleMul = 1.0
    this.seabedRockChance = 0.12

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
    // _hoveredTexture — the Textures tab in the left panel sets
    // this when the user hovers a texture row.  Every piece whose
    // drawGroups reference that texture gets its wireframe painted
    // alongside the piece-hover highlight, so the user can see
    // which faces use that atlas.
    this._hoveredTexture = null

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
    // buildPercent: 0..100 simulated construction progress.  Below
    // 100, the main pass renders at reduced alpha and a pulsing
    // green nano-wireframe overlay is drawn underneath / over (so
    // the unit reads as "still building").  100 = textured normally.
    this.buildPercent = 100
    // groundMode: 'grid' (light-green TA-tile lattice), 'terrain'
    // (greenworld flat texture, tiled), or 'off' (no ground plane).
    this.groundMode = 'terrain'
    // ── Terrain texture (lazy-loaded the first time the user picks
    // the Terrain ground mode).  GL texture ID + a ready flag the
    // ground shader uses to fall back to its plain look until decode.
    this._terrainTex = null
    this._terrainReady = false
    // Tileset name to fetch when the user picks Terrain.  Environment
    // presets swap this to match the visual world (mars → 'desert',
    // arctic → 'arctic', etc.).
    this.terrainTileset = 'greenworld'

    // ── Studio Options toggles ──────────────────────────────────
    // Each gates a specific effect that the user can flip off when
    // they want a cleaner / faster render or are looking for
    // something specific in the model.  All default to on.
    // Submersion mode tells the renderer how to position the unit
    // relative to the water plane: 'surface' = ship riding the
    // boot-stripe at waterline; 'submerged' = submarine fully under
    // water; '' = sits ON the water (the previous default).  Comes
    // in from the host via setSubmersionMode().
    this.submersionMode = ''
    this.optReflections = true       // unit's mirrored reflection on the water
    this.optBob = true               // unit heave + pitch + roll on the swell
    this.optWaterReflections = true  // sky / sun reflected in the water surface
    this.optSpecular = true          // sun's specular highlight on water + hull
    this.optGodBeams = true          // light shafts from the sun(s)
    this.optWaves = true             // animate sea surface; false → flat sea
    // Slider-controlled multipliers — all default to 1.0 (no scaling).
    this.bobAmount = 1.0             // scales heave + pitch + roll
    this.bobSpeed = 1.0              // scales the bob's time progression
    this.wavesIntensity = 1.0        // scales wave amplitude (both vertex + frag)

    // Enable optional extensions.  Anisotropic gets forwarded to the
    // texture cache so future uploads use it; depth-texture gates the
    // entire shadow-mapping pipeline.
    this._depthExt = ctx.getExtension('WEBGL_depth_texture') || ctx.getExtension('WEBKIT_WEBGL_depth_texture')
    const aniso = ctx.getExtension('EXT_texture_filter_anisotropic') || ctx.getExtension('WEBKIT_EXT_texture_filter_anisotropic')
    if (aniso && textureCache) textureCache.setAnisotropicExt(aniso)

    // DoF toggle + tuning parameters.  Default off so users see no
    // surprises until they opt in via the Studio Options checkbox.
    this.optDof = false
    // NDC depth is wildly nonlinear: with near=0.05 / far=6000,
    // z_ndc=0.985 sits at only ~3 world units from the camera, so
    // the old defaults were sweeping the unit itself into the blur
    // zone.  Bumping focalDepth to 0.998 puts the in-focus plane at
    // roughly 25 wu (~10x further) - matching where the unit sits at
    // default framing.  focalRange widened to 0.0015 so the ramp out
    // to full blur covers a meaningful distance instead of saturating
    // a few world units past the unit.  Max blur dropped to 8 px
    // since only the genuine background should pick it up now.
    this.dofFocalDepth = 0.998
    this.dofFocalRange = 0.0015
    this.dofMaxBlur = 8
    // Shader program init is deferred to ModelRenderer.init() — that
    // method fetches shader sources from shaders/ and links them.  Set
    // to true once init() has resolved so render() bails early when
    // called from a stray RAF before shaders are ready.
    this._programsReady = false

    // Scratch matrices live on the instance so per-frame work doesn't
    // allocate.  worldScratch threads through Piece.computeWorldMatrix.
    this._scratch = Mat4.create()
    this._worldScratch = Mat4.create()
    this._modelMatrix = Mat4.identity(Mat4.create())
    // unitTransform = { x, y, z, headingRad } — applied to
    // _modelMatrix every frame so the Controls panel's Move action
    // can walk / fly the unit around the scene.  Y is the runtime
    // altitude offset (aircraft rise during flight); the
    // mode-specific submersion offset is layered on TOP via
    // getUnitYOffset so a flying-over-water unit still sits above
    // the surface, not below.  Defaults are zero so legacy call
    // sites that never set this see the unit at world origin.
    this._unitTransform = { x: 0, y: 0, z: 0, headingRad: 0 }
    // Multi-entity mode — when an array is set here, draw() iterates
    // over each entity and renders its model independently after the
    // shared sky/ground pass.  Each entity is
    // { model, transform: {x,y,z,headingRad}, binding, buildPercent,
    //   particles, selected }.  When null, the renderer falls back
    //  to single-unit mode driven by `this.model` + _unitTransform.
    this._entities = null
    this._lightView = Mat4.create()
    this._lightProj = Mat4.create()
    this._lightSpace = Mat4.create()
    // Second-light matrices (twin-sun worlds).  Same role as the
    // first set, but driven by lightDir2.  Live alongside the
    // first set so #updateLightMatrices can fill both in one go.
    this._lightView2 = Mat4.create()
    this._lightProj2 = Mat4.create()
    this._lightSpace2 = Mat4.create()

    if (this.textureCache) this.textureCache.onAnyTextureReady = () => this.requestRedraw()

    // Kick off the terrain texture fetch eagerly — the user's first
    // sight of the viewer should already have grass, not the
    // procedural fallback ground.
    if (this.groundMode === 'terrain') this.#loadTerrainTexture()
  }

  // init fetches every shader from shaders/ + links the GPU programs.
  // Must be awaited before the renderer is asked to draw a frame; the
  // viewer wires this into open() before calling start().  Safe to
  // call more than once - subsequent calls return the same Promise so
  // multiple async callers can join on a single init.
  init() {
    if (this._initPromise) return this._initPromise
    this._initPromise = (async () => {
      const sources = await loadAllShaders()
      this.#initMainProgram(sources.main.vs, sources.main.fs)
      this.#initShadowProgram(sources.shadow.vs, sources.shadow.fs)
      this.#initSkyProgram(sources.sky.vs, sources.sky.fs)
      this.#initGroundProgram(sources.ground.vs, sources.ground.fs)
      this.#initWireProgram(sources.wire.vs, sources.wire.fs)
      this.#initParticlesProgram(sources.particles.vs, sources.particles.fs)
      if (this._depthExt) {
        this.#initShadowFBO()
        // DoF needs the same depth-texture extension as shadows -
        // when missing, the renderer skips the post-process pass
        // entirely.
        this.#initDoFProgram(sources.dof.vs, sources.dof.fs)
      }
      this._programsReady = true
      this.requestRedraw()
    })()
    return this._initPromise
  }

  setModel(model) {
    this.model = model
  }

  // setCobBinding attaches a per-frame COB-runtime tick to this
  // renderer.  Pass null to detach (e.g. switching to a unit
  // without a script).  When set, the render loop calls
  // binding.tick(dtMs) before each draw, which advances the COB
  // animators and copies per-piece state into the Model.
  setCobBinding(binding) {
    this.cobBinding = binding || null
    // Hand the binding a back-reference to THIS renderer so per-tick
    // hooks (the dynamic pulse-light from active particles) can push
    // state into our uniforms without chasing the viewer's closures.
    if (binding) binding.renderer = this
    // Forward the binding's particle pool to the renderer's SFX
    // pass.  Detaching the binding also detaches the pool so the
    // old unit's particles don't keep drawing.
    this.setParticlePool(binding ? binding.particles : null)
    // Force a redraw on attach so static scripts (Create) get
    // their initial piece transforms applied immediately.
    if (binding) binding.tick(0)
    this.requestRedraw()
  }

  setCamera(camera) {
    this.camera = camera
  }

  setAutoRotate(on) {
    this.autoRotate = !!on
  }

  // setPulseLight pushes a single dynamic point light into the next
  // main + reflection passes.  pos = [x,y,z], color = [r,g,b] (over-1
  // values are fine — the contribution is additive and tone-mapped
  // post-lighting), range = WORLD-unit radius at which intensity falls
  // to ~50%.  Pass null (or range = 0) to clear and let the shader
  // skip the path.  Called per-frame by cob-binding from the strongest
  // active light-emitting particle.
  setPulseLight(pos, color, range) {
    if (!pos || !color || !(range > 0)) {
      this._pulseLight = null
    } else {
      this._pulseLight = { pos, color, range }
    }
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

  // setBuildPercent updates the nano-frame fade.  0 = pure green
  // pulsing wireframe (textures invisible), 100 = textured normal.
  // Below 100 we keep the render loop running so the pulse
  // animates continuously; at exactly 100 the existing redraw is
  // enough (the static textured model doesn't need a frame loop).
  setBuildPercent(percent) {
    this.buildPercent = Math.max(0, Math.min(100, +percent || 0))
    if (this.buildPercent < 100 && !this.running) this.start()
    this.requestRedraw()
  }

  setHoveredPieceName(name) {
    const next = (typeof name === 'string' && name) ? name.toLowerCase() : null
    if (next === this._hoveredPieceName) return
    this._hoveredPieceName = next
    this.requestRedraw()
  }

  // setHoveredTexture flags every piece whose drawGroups reference
  // the given texture name for the red-wireframe overlay.  Pair
  // with the Textures tab in the model-viewer's left panel — the
  // user hovers a texture row and every face painted with that
  // atlas lights up.  null clears the highlight.
  setHoveredTexture(name) {
    const next = (typeof name === 'string' && name) ? name.toLowerCase() : null
    if (next === this._hoveredTexture) return
    this._hoveredTexture = next
    this.requestRedraw()
  }

  // setUnitTransform places the unit at (x, y, z) world units with
  // the given Y-axis heading.  Used by the Controls panel's Move
  // action to walk the unit toward a clicked target, and by the
  // flight scheduler to raise aircraft above the ground while in
  // motion.  Values are written into _modelMatrix at the start of
  // every frame; persists across ticks so the move-loop only needs
  // to update on motion change.  The legacy 3-arg signature
  // (x, z, headingRad) is still accepted for callers that don't
  // care about altitude.
  setUnitTransform(x, yOrZ, zOrHeading, headingRad) {
    if (headingRad === undefined) {
      // Legacy 3-arg form: (x, z, headingRad).  Altitude stays 0.
      this._unitTransform.x = +x || 0
      this._unitTransform.y = 0
      this._unitTransform.z = +yOrZ || 0
      this._unitTransform.headingRad = +zOrHeading || 0
    } else {
      this._unitTransform.x = +x || 0
      this._unitTransform.y = +yOrZ || 0
      this._unitTransform.z = +zOrHeading || 0
      this._unitTransform.headingRad = +headingRad || 0
    }
    this.requestRedraw()
  }

  // unitWorldXZ returns the unit's current world XZ position.  The
  // aim+fire scheduler uses this to compute the vector from unit
  // origin to target so its heading/pitch math is in the same
  // coordinate space the renderer translates by.
  unitWorldXZ() { return [this._unitTransform.x, this._unitTransform.z] }
  unitWorldY() { return this._unitTransform.y }
  unitHeading() { return this._unitTransform.headingRad }

  // setEntities switches the renderer into multi-entity mode.  When
  // entities are present, draw() draws each entity's model after the
  // shared sky / ground pass instead of the single `this.model`.
  // Pass null to return to single-unit mode.  Each entity:
  //   { model, transform: {x, y, z, headingRad},
  //     particles?, buildPercent?, selected?, teamColor? }
  setEntities(entitiesArr) {
    this._entities = (Array.isArray(entitiesArr) && entitiesArr.length > 0) ? entitiesArr : null
    this.requestRedraw()
  }

  // worldToCanvas projects a world-space (x, y, z) point onto the
  // canvas's CSS pixel grid using the camera's live VP matrix.  The
  // caller adds the canvas's bounding-rect offset to get viewport
  // coordinates suitable for a position:fixed overlay.  Returns null
  // when the point is behind the near plane (w <= 0) so the overlay
  // can be hidden in that case rather than drawn off-screen with a
  // post-divide NaN.
  worldToCanvas(world) {
    if (!this.camera) return null
    const c = this.camera
    const x = world[0], y = world[1], z = world[2]
    // Apply view × proj manually so we can read the w component
    // before the homogeneous divide.  proj * view * p = clip.
    const view = c.viewMatrix, proj = c.projMatrix
    // view * (x,y,z,1)
    const vx = view[0]*x + view[4]*y + view[8] *z + view[12]
    const vy = view[1]*x + view[5]*y + view[9] *z + view[13]
    const vz = view[2]*x + view[6]*y + view[10]*z + view[14]
    const vw = view[3]*x + view[7]*y + view[11]*z + view[15]
    // proj * view * p
    const cx = proj[0]*vx + proj[4]*vy + proj[8] *vz + proj[12]*vw
    const cy = proj[1]*vx + proj[5]*vy + proj[9] *vz + proj[13]*vw
    /*const cz = proj[2]*vx + proj[6]*vy + proj[10]*vz + proj[14]*vw*/
    const cw = proj[3]*vx + proj[7]*vy + proj[11]*vz + proj[15]*vw
    if (cw <= 1e-6) return null // behind camera or at the eye
    const ndcX = cx / cw
    const ndcY = cy / cw
    // CSS pixels (canvas-local).  Y flipped because NDC Y is up but
    // CSS Y is down.
    const w = this.canvas?.clientWidth || this.gl.drawingBufferWidth
    const h = this.canvas?.clientHeight || this.gl.drawingBufferHeight
    return {
      x: (ndcX * 0.5 + 0.5) * w,
      y: (1 - (ndcY * 0.5 + 0.5)) * h,
    }
  }

  // canvasToGroundPoint translates a viewport pixel (canvas-local)
  // into the world-space ground-plane (Y=0) point under that pixel.
  // Returns null when the ray misses the plane (e.g. user clicked
  // the sky above the horizon).  Used by the Controls panel to
  // resolve a click into a move/aim target.
  canvasToGroundPoint(cx, cy) {
    if (!this.camera) return null
    const w = this.gl.drawingBufferWidth
    const h = this.gl.drawingBufferHeight
    // Normalised device coordinates [-1, 1].
    const ndcX = (cx / Math.max(1, w)) * 2 - 1
    const ndcY = 1 - (cy / Math.max(1, h)) * 2
    const c = this.camera
    // Reuse the camera's live proj+view matrices — they're already
    // synced by the per-frame update so they match what the user
    // actually sees on screen.  Combine into a VP, then invert to
    // unproject NDC back into world coords.  Mat4.invert returns
    // null on a singular matrix (degenerate camera state).
    const vp = Mat4.create()
    Mat4.multiply(vp, c.projMatrix, c.viewMatrix)
    const inv = Mat4.create()
    if (!Mat4.invert(inv, vp)) return null
    // Unproject NDC at the near + far depth, then intersect the ray
    // (eye → far point) with the y=0 ground plane.  Inline 4-vector
    // multiplication keeps this self-contained (mat4.js has no
    // transformPoint helper).
    const unproject = (nx, ny, nz) => {
      const w = inv[3] * nx + inv[7] * ny + inv[11] * nz + inv[15]
      if (Math.abs(w) < 1e-9) return null
      return [
        (inv[0] * nx + inv[4] * ny + inv[8]  * nz + inv[12]) / w,
        (inv[1] * nx + inv[5] * ny + inv[9]  * nz + inv[13]) / w,
        (inv[2] * nx + inv[6] * ny + inv[10] * nz + inv[14]) / w,
      ]
    }
    const nearP = unproject(ndcX, ndcY, -1)
    const farP  = unproject(ndcX, ndcY,  1)
    if (!nearP || !farP) return null
    // Intersection plane Y — for sea ground mode we want the water
    // surface, not y=0 (which sits well below the visible water
    // and would map a click "on the boat" to a far-distant point).
    // Other ground modes (terrain / grid / off) use y=0.
    const planeY = (this.groundMode === 'sea') ? this._getWaterY() : 0
    const dy = farP[1] - nearP[1]
    if (Math.abs(dy) < 1e-6) return null
    const t = (planeY - nearP[1]) / dy
    if (t < 0) return null
    return [
      nearP[0] + (farP[0] - nearP[0]) * t,
      planeY,
      nearP[2] + (farP[2] - nearP[2]) * t,
    ]
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

  // setSkyScheme swaps the skybox preset.  Accepts a preset name
  // (key of SKY_PRESETS) or a fully-formed scheme object — the
  // latter lets callers script bespoke skies without touching the
  // preset table.  Falls back silently to the current scheme if the
  // name isn't recognised.
  setSkyScheme(nameOrScheme) {
    if (typeof nameOrScheme === 'string') {
      const preset = SKY_PRESETS[nameOrScheme]
      if (!preset) return
      this.skyScheme = preset
    } else if (nameOrScheme && nameOrScheme.zenith) {
      this.skyScheme = nameOrScheme
    }
    this.requestRedraw()
  }

  // skyPresets exposes the available named presets to the UI so the
  // host (Studio) can populate a picker without re-importing them.
  static get skyPresets() { return SKY_PRESETS }

  // setEnvironment swaps the whole world look (sky scheme + terrain
  // tileset + scene light direction + water hints) from one of the
  // ENVIRONMENT_PRESETS.  The Studio Options UI calls this when the
  // user picks Mars / Lava / etc.; passing a custom object also
  // works for scripted scenes.
  setEnvironment(nameOrPreset) {
    let env
    let envKey = null
    if (typeof nameOrPreset === 'string') {
      env = ENVIRONMENT_PRESETS[nameOrPreset]
      if (!env) return
      envKey = nameOrPreset
    } else if (nameOrPreset && nameOrPreset.sky) {
      env = nameOrPreset
    } else {
      return
    }
    // Cache the active env so the sea shader can pull water tints
    // from it each frame.  See #renderGround.
    this.activeEnvironment = env
    // Track the environment key separately — gravity lookups go
    // through this rather than the preset object so the ballistic
    // aim solver can be redirected to a different world's gravity
    // without rebuilding the entire env (useful for a future
    // "gravity slider" debug control too).
    this._envKey = envKey
    this.setSkyScheme(env.sky)
    if (env.lightDir) this.lightDir = ModelRenderer.#normalise(env.lightDir)
    // Pull sun2 from the active sky scheme so the scene-lighting
    // pass casts a shadow from it too (single suns leave it at
    // zero colour, in which case the shadow pass is skipped).
    const sky = this.skyScheme || {}
    const sun2 = sky.sun2 || { color: [0, 0, 0] }
    const sun2Mag = sun2.color[0] + sun2.color[1] + sun2.color[2]
    if (sun2Mag > 0.001 && sun2.dir) {
      this.lightDir2 = ModelRenderer.#normalise(sun2.dir)
      // Dim the second light a bit so its shadow contribution
      // doesn't overpower the primary — twin-sun scenes still want
      // a clear primary key light, with the second adding texture.
      this.lightColor2 = [sun2.color[0] * 0.6, sun2.color[1] * 0.6, sun2.color[2] * 0.6]
    } else {
      this.lightColor2 = [0, 0, 0]
    }
    // Tileset switch: drop the cached terrain texture so the lazy
    // fetcher picks up the new tileset the next time Terrain mode is
    // active.  If the user is currently in Terrain mode, trigger the
    // fetch right away so the swap is instant.
    if (env.terrainTileset && env.terrainTileset !== this.terrainTileset) {
      this.terrainTileset = env.terrainTileset
      if (this._terrainTex) {
        this.gl.deleteTexture(this._terrainTex)
        this._terrainTex = null
        this._terrainReady = false
      }
      if (this.groundMode === 'terrain') this.#loadTerrainTexture()
    }
    this.requestRedraw()
  }

  static get environmentPresets() { return ENVIRONMENT_PRESETS }

  // ── Studio Options setters ──────────────────────────────────
  // Each flag drops its corresponding visual contribution.  The
  // shaders/passes read the flag via uniforms so flipping a toggle
  // takes effect on the next frame.
  // setSubmersionMode shifts the water plane so the unit reads as
  // sitting in the water at an appropriate depth.  Values:
  //   'surface'   — ship; water covers the bottom ~15% of the hull
  //   'submerged' — sub; entire unit ~2 wu below water surface
  //   ''          — no shift; unit sits ON the water
  // The shift is achieved by raising the water plane (uGroundY) for
  // the sea pass instead of moving the unit, so the bob math, the
  // seabed Y, and the reflection mirror all stay in sync via the
  // same _getWaterY().
  setSubmersionMode(mode) {
    this.submersionMode = mode || ''
    this.requestRedraw()
  }

  // getGravity returns the world gravity in wu/sec² for the active
  // environment, used by the ballistic aim solver to set barrel
  // pitch on cannon-class weapons.  Switching to a lunar / mars
  // env lowers this value and the next aim cycle naturally elevates
  // the barrels further to compensate.  Defaults to Earth gravity
  // when the env name doesn't appear in the GRAVITY_BY_ENV table
  // (custom env objects, unknown keys).
  getGravity() {
    const k = this._envKey
    if (k && Object.prototype.hasOwnProperty.call(GRAVITY_BY_ENV, k)) {
      return GRAVITY_BY_ENV[k]
    }
    return GRAVITY_EARTH
  }

  // getUnitYOffset returns the world-Y translation to apply to the
  // unit model in Sea mode.  For submerged units (subs) the model
  // bounds are at the origin but the water plane is far above and
  // the seabed sits 45 wu below the water — without an offset, a
  // sub at bounds.min[1] = 0 would be buried inside the bed.  This
  // method lifts the unit so its TOP sits ~12 wu below the water
  // surface (periscope depth), guaranteeing clearance over the bed.
  // Surface ships and other modes return 0.  Exposed so the host
  // can also offset the camera target to keep framing locked on
  // the actually-rendered unit position.
  getUnitYOffset() {
    if (!this.model || this.submersionMode !== 'submerged') return 0
    const waterY = this._getWaterY()
    const height = Math.max(1, this.model.bounds.max[1] - this.model.bounds.min[1])
    const desiredTop = waterY - 12.0
    const desiredMin = desiredTop - height
    return desiredMin - this.model.bounds.min[1]
  }

  // _getWaterY returns the world Y of the water surface.  Centralised
  // here because every sea pass (ground, reflection, bob, main shader
  // uniform) needs the same value — drift between them would float
  // the unit off the wave or misposition the reflection mirror.
  _getWaterY() {
    if (!this.model) return 0
    const base = this.model.bounds.min[1] - 0.05
    const height = Math.max(1, this.model.bounds.max[1] - this.model.bounds.min[1])
    if (this.submersionMode === 'surface') {
      // Push water up by 15% of unit height so the boot-stripe area
      // lines up with the visible waterline on most TA hull textures.
      return base + height * 0.15
    }
    if (this.submersionMode === 'submerged') {
      // Push the water plane well above the unit so the orbit-
      // camera's default framing puts the eye below the surface —
      // the user opens a sub and is immediately looking at it
      // through metres of water above (periscope-cam feel).  The
      // camera's eye is ~target + distance*sin(pitch); for typical
      // units distance ≈ 1.5× span at pitch 18°, so the eye sits
      // about 0.5× span above the unit centroid.  Water at top +
      // 3× unit-height puts the surface a good margin above the
      // eye for any reasonable bounding box.
      return base + height + Math.max(height * 3.0, 40)
    }
    return base
  }

  // _fillColor returns the cinematic fill light tint — a cool, ~30% blue
  // tinge of the sky's ambient.  Cool fill against a warm key reads as
  // the classic 3-point film lighting (key=sun, fill=skylight bounce,
  // back=hot rim).  We pull from the active sky ambient so each
  // environment preset gets a fill that matches the world's mood (cold
  // arctic skylight vs warm sunset bounce).
  _fillColor() {
    const s = this.skyColor || [1, 1, 1]
    return [s[0] * 0.55, s[1] * 0.65, s[2] * 0.80]
  }

  // _backColor returns the back-light tint — warm, slightly hotter than
  // the key so the rim picks out the silhouette cleanly.  Mirrors the
  // active sun colour but with a 20% lift so it shows up even on
  // overcast presets where the sun colour itself is muted.
  _backColor() {
    const k = this.lightColor || [1, 1, 1]
    return [Math.min(1.2, k[0] * 1.2), Math.min(1.2, k[1] * 1.1), Math.min(1.2, k[2] * 0.95)]
  }

  // setTeamColor accepts either null (use original blue) or an [r,g,b]
  // triple in 0–1 linear space.  The shader compares the texture's hue
  // against the blue team-color range and rotates matching pixels to
  // the chosen team's hue.
  setTeamColor(rgb) {
    if (rgb == null) {
      this.teamColor = null
      this.teamColorEnable = false
    } else {
      this.teamColor = [rgb[0], rgb[1], rgb[2]]
      this.teamColorEnable = true
    }
    this.requestRedraw()
  }

  // setDoFEnabled turns the post-process depth-of-field pass on/off.
  // When off, the renderer skips the scene FBO entirely so the cost is
  // a single extra `if` per frame.
  setDoFEnabled(on) { this.optDof = !!on; this.requestRedraw() }

  // setBgTerrainEnabled toggles the background-mountain ring.  When
  // off, the vertex shader's uMountainActive=0 fast-path keeps the
  // ground flat - no cost beyond a few extra clamps per vertex.
  setBgTerrainEnabled(on) { this.optBgTerrain = !!on; this.requestRedraw() }
  // setBgTerrainHeight scales the ENV-driven peak height by a user
  // factor (0..2).  1 = preset default.
  setBgTerrainHeight(v) { this.bgTerrainHeightMul = Math.max(0, +v) || 0; this.requestRedraw() }
  // setBgTerrainScale stretches the noise field horizontally so the
  // mountains read wider / narrower without changing their height.
  setBgTerrainScale(v) { this.bgTerrainScaleMul = Math.max(0.05, +v) || 1; this.requestRedraw() }

  // setSeabedHeight and setSeabedScale - the sea counterpart to the
  // mountain knobs.  Multiply the seabedHeight() output before it's
  // applied to the seabed Y, and stretch the noise scale.
  setSeabedHeight(v) { this.seabedHeightMul = Math.max(0, +v) || 0; this.requestRedraw() }
  setSeabedScale(v) { this.seabedScaleMul = Math.max(0.05, +v) || 1; this.requestRedraw() }
  setSeabedRockChance(v) { this.seabedRockChance = Math.max(0, Math.min(1, +v)) || 0; this.requestRedraw() }

  setReflectionsEnabled(on) { this.optReflections = !!on; this.requestRedraw() }
  setBobEnabled(on) { this.optBob = !!on; this.requestRedraw() }
  setWaterReflectionsEnabled(on) { this.optWaterReflections = !!on; this.requestRedraw() }
  setSpecularEnabled(on) { this.optSpecular = !!on; this.requestRedraw() }
  setGodBeamsEnabled(on) { this.optGodBeams = !!on; this.requestRedraw() }
  setWavesEnabled(on) { this.optWaves = !!on; this.requestRedraw() }
  setBobAmount(v) { this.bobAmount = Math.max(0, +v) || 0; this.requestRedraw() }
  setBobSpeed(v) { this.bobSpeed = Math.max(0, +v) || 0; this.requestRedraw() }
  setWavesIntensity(v) { this.wavesIntensity = Math.max(0, +v) || 0; this.requestRedraw() }

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
      // FPS sampling — push the per-frame dt into a rolling 60-sample
      // ring so getFPS() can return a smoothed value (1-second window
      // at 60 Hz, ~2 seconds at 30 Hz).  Cheap: push + length cap.
      if (!this._fpsSamples) this._fpsSamples = []
      if (dt > 0) {
        this._fpsSamples.push(dt)
        if (this._fpsSamples.length > 60) this._fpsSamples.shift()
      }
      if (this.autoRotate && this.camera) {
        // Drive the camera's orbit yaw rather than spinning the
        // model in place — that way the ground / sea rotate WITH
        // the unit (they don't, of course, but the camera moving
        // around them produces the same parallax) and the user
        // can pick up a manual drag from wherever the auto-rotate
        // left off.
        this.camera.yaw += dt * (Math.PI / 15)
      }
      // COB animation tick — drives per-piece move/turn/spin
      // animators and writes the results into the model's piece
      // tree.  Must run before draw() so the new transforms land
      // in this frame's geometry pass.
      if (this.cobBinding) this.cobBinding.tick(dt * 1000)
      this.draw()
      // Notify external observers (studio inspector overlays) that
      // a frame finished.  The host wires a refresh callback so
      // overlays show up-to-date COB / camera state.  Cheap when
      // unhooked.
      if (this.onAfterFrame) this.onAfterFrame(dt * 1000)
      this.rafId = requestAnimationFrame(loop)
    }
    this.rafId = requestAnimationFrame(loop)
  }

  stop() {
    this.running = false
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
  }

  // clearCanvas paints the canvas with the sky-bottom colour and
  // wipes the depth buffer.  Called by the host on tab switch so a
  // tab that's about to lose the screen doesn't leave its last
  // rendered frame visible while the incoming tab's first paint is
  // pending.  Cheap — one viewport / clearColor / clear call.
  // Multiple renderers share the same gl context (per canvas) so any
  // renderer can invoke this and it clears the shared surface.
  clearCanvas() {
    const gl = this.gl
    if (!gl) return
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
    const c = this.skyBottom || [0.05, 0.07, 0.12]
    gl.clearColor(c[0], c[1], c[2], 1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
  }

  // getFPS returns the smoothed frames-per-second over the last
  // ~60 frames of the render loop.  Returns 0 when the loop isn't
  // running yet (no model loaded) so the Renderer overlay can
  // distinguish "idle" from "running slowly".
  getFPS() {
    if (!this._fpsSamples || this._fpsSamples.length === 0) return 0
    let sum = 0
    for (const s of this._fpsSamples) sum += s
    const avg = sum / this._fpsSamples.length
    return avg > 0 ? 1 / avg : 0
  }

  requestRedraw() {
    if (this.running) return
    requestAnimationFrame(() => this.draw())
  }

  draw() {
    const gl = this.gl
    // Shader programs are loaded asynchronously by init(); until they
    // resolve there's nothing to draw.  When init completes it calls
    // requestRedraw() which triggers a fresh draw with everything
    // ready - so silently skipping here is harmless.
    if (!this._programsReady) return
    this.resize()
    // Camera tracking is a per-frame operation owned by OrbitCamera —
    // when a unit is locked in, applyTracking() pulls camera.target
    // onto the unit's centre of mass BEFORE updateMatrices runs so
    // the view matrix this frame already reflects the new framing.
    // No-op when nothing's tracked.
    if (this.camera && typeof this.camera.applyTracking === 'function') {
      this.camera.applyTracking()
    }

    // In multi-entity mode we proceed even with no `this.model` since
    // the entities array supplies models per-pass.  Camera is always
    // required.
    const haveModel = !!this.model || (this._entities && this._entities.length > 0)
    if (!this.camera || !haveModel) {
      // Empty-scene fallback (sandbox with nothing spawned, or
      // single-unit between model loads).  We still want a usable
      // backdrop: refresh the camera matrices + paint the sky AND
      // draw the ground plane so the user sees the grid / terrain /
      // sea immediately rather than a flat blue void.
      // Synth a minimal bounds so #renderGround's centre/span math
      // (model.bounds-driven) doesn't NPE — the ground geometry
      // itself is a fixed-size VBO, the bounds only affect
      // shadow-falloff radius and centre, which the empty scene
      // anchors at the world origin.
      if (this.camera) {
        const aspect = gl.drawingBufferWidth / Math.max(1, gl.drawingBufferHeight)
        this.camera.updateMatrices(aspect, 0.5, 8000)
      }
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
      gl.clearColor(this.skyBottom[0], this.skyBottom[1], this.skyBottom[2], 1)
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      if (this.groundMode !== 'off' && this._groundVBO && this.camera) {
        const _savedModel = this.model
        const _savedEntities = this._entities
        // Pretend we're in multi-entity mode so #renderGround takes the
        // camera-target-anchored branch with a generous radius — the
        // synthesised single-pixel bounds would otherwise feather the
        // ground out before it reached the visible horizon.
        this._entities = this._entities || [{}]
        this.model = { bounds: { min: [-4, 0, -4], max: [4, 0, 4] } }
        try { this.#renderGround() } catch { /* shader may not be ready yet */ }
        this.model = _savedModel
        this._entities = _savedEntities
      }
      return
    }

    // Multi-entity mode: for the shared setup (camera + sky + ground
    // + shadow) we adopt the FIRST entity's model as `this.model` so
    // the existing bounds-based computations still work.  Per-entity
    // model matrices are built inside the per-entity loop below.
    let _savedModel = null
    if (this._entities) {
      _savedModel = this.model
      this.model = this._entities[0].model
    }
    // In Sea mode the unit bobs on the swell — height + pitch + roll
    // come from sampling the same wave function the surface uses, so
    // the hull rides exactly the visible water under it.  Other
    // ground modes leave the model matrix identity (auto-rotate now
    // spins the camera around a stationary scene).
    Mat4.identity(this._modelMatrix)
    // Unit-position translation (Controls panel Move).  Applied
    // BEFORE the rotation so the heading rotates around the unit's
    // own pivot, and BEFORE the sea-bob so the bob still rides on
    // top of the walking unit.  Y component is the aircraft-flight
    // altitude (zero for ground units).
    const ut = this._unitTransform
    if (ut.x !== 0 || ut.y !== 0 || ut.z !== 0) {
      Mat4.translate(this._modelMatrix, this._modelMatrix, ut.x, ut.y, ut.z)
    }
    if (ut.headingRad !== 0) {
      Mat4.rotateY(this._modelMatrix, this._modelMatrix, ut.headingRad)
    }
    if (this.groundMode === 'sea' && this.model) {
      // Submersion offset comes first — the model is lifted into
      // place between water and seabed (subs) BEFORE the bob is
      // applied so the bob's vertical heave rides on top of the
      // already-positioned unit.
      const yOff = this.getUnitYOffset()
      if (yOff !== 0) {
        Mat4.translate(this._modelMatrix, this._modelMatrix, 0, yOff, 0)
      }
      if (this.optBob) {
        const t = (performance.now() - this._t0) / 1000
        const cx = (this.model.bounds.min[0] + this.model.bounds.max[0]) * 0.5
        const cz = (this.model.bounds.min[2] + this.model.bounds.max[2]) * 0.5
        this._applySeaBob(this._modelMatrix, cx, cz, t)
      }
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
    // Far plane has to reach the new ~2.5 km sea horizon — the
    // ground tessellation extends much further than the unit so the
    // water + seabed are visible all the way out.
    this.camera.updateMatrices(aspect, Math.max(0.05, span * 0.01), Math.max(6000, span * 30 + 1000))

    // Shadow pass is meaningful only when the main pass actually uses
    // shadows.  In Flat / Wireframe modes we skip it to save GPU.
    const usesShadows = this.renderMode === 'full'
    if (this._shadowFBO && usesShadows) {
      this.#renderShadowPass(0)
      // Second shadow pass only when the active environment has a
      // real second sun — single-sun worlds skip the cost.
      const sun2Mag = this.lightColor2[0] + this.lightColor2[1] + this.lightColor2[2]
      if (sun2Mag > 0.001 && this._shadowFBO2) this.#renderShadowPass(1)
    }

    // DoF needs an offscreen colour + depth target to do its
    // distance-weighted blur from.  When the scene FBO is set up, we
    // render the entire pass into it and composite via #compositeDoF
    // below.  Falling back to the default framebuffer when DoF is
    // disabled / unavailable keeps the existing direct-render path.
    const useScenePass = this.optDof && this.#ensureSceneFBO()
    if (useScenePass) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._sceneFBO)
      gl.viewport(0, 0, this._sceneW, this._sceneH)
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
    }
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
    // Reflection only renders when the camera is ABOVE the water
    // plane.  Below the surface the mirrored geometry would be
    // visible directly (no water surface between camera + reflection)
    // and the trick of "the reflection IS a flipped copy" leaks out.
    const waterY = this._getWaterY()
    const cameraAboveWater = !this.camera || this.camera.eye[1] > waterY
    const showReflection = this.renderMode === 'full' && this.groundMode === 'sea' && this.optReflections && cameraAboveWater
    if (this.groundMode === 'sea') {
      // Sea pipeline: seabed first (writes depth), reflection second
      // (depth-tested against the bed so it can't ghost through it),
      // water surface third (alpha-blends over both).  The reflection
      // physically sits between the bed and the surface, exactly
      // where its mirrored geometry lives in world space.
      this._groundPass = 'seabed'
      this.#renderGround()
      if (showReflection) this.#renderReflection()
      this._groundPass = 'water'
      this.#renderGround()
      this._groundPass = null
    } else if (this.groundMode !== 'off') {
      this.#renderGround()
    }

    if (this.renderMode === 'wireframe') {
      this.#renderWireframe([0.85, 0.92, 1.0, 1.0])
    } else if (this._entities) {
      // Multi-entity main pass — iterate each entity, swap this.model
      // + _modelMatrix to point at it, then run the standard single-
      // entity main pass.  Build% / unit-centre / pulse-light all
      // get recomputed inside #renderMain from this.model + the
      // mutated _modelMatrix, so each entity renders correctly.
      const savedBp = this.buildPercent
      const savedUt = { x: this._unitTransform.x, y: this._unitTransform.y, z: this._unitTransform.z, headingRad: this._unitTransform.headingRad }
      // Save the renderer's team-colour fields so the per-entity loop
      // can swap them per unit and restore on the way out — entities
      // can carry their own team colour (sandbox sides) without
      // leaking into the post-loop passes (wireframe overlay, ghost
      // placement preview, etc.).
      const savedTC = this.teamColor
      const savedTCe = this.teamColorEnable
      for (const ent of this._entities) {
        this.model = ent.model
        if (typeof ent.buildPercent === 'number') this.buildPercent = ent.buildPercent
        // Per-entity team colour — sandbox passes ent.teamColor as
        // either an [r,g,b] tuple (recolour) or null (use the model's
        // authored ARM-blue pixels untouched).  Unset entry = inherit
        // the renderer's currently-committed team colour (the single-
        // unit picker's selection), preserving existing behaviour for
        // entities that don't opt in.
        if (Object.prototype.hasOwnProperty.call(ent, 'teamColor')) {
          if (ent.teamColor) {
            this.teamColor = [ent.teamColor[0], ent.teamColor[1], ent.teamColor[2]]
            this.teamColorEnable = true
          } else {
            this.teamColor = null
            this.teamColorEnable = false
          }
        }
        const t = ent.transform || { x: 0, y: 0, z: 0, headingRad: 0 }
        this._unitTransform.x = +t.x || 0
        this._unitTransform.y = +t.y || 0
        this._unitTransform.z = +t.z || 0
        this._unitTransform.headingRad = +t.headingRad || 0
        Mat4.identity(this._modelMatrix)
        if (t.x !== 0 || t.y !== 0 || t.z !== 0) {
          Mat4.translate(this._modelMatrix, this._modelMatrix, t.x, t.y, t.z)
        }
        if (t.headingRad !== 0) {
          Mat4.rotateY(this._modelMatrix, this._modelMatrix, t.headingRad)
        }
        // Ghost entities (sandbox placement preview) render as a
        // pulsing green wireframe instead of the solid main pass — no
        // shadow, no fill, just an outline so the user sees the unit's
        // silhouette under the cursor before committing to the spawn.
        if (ent.ghost) {
          const pulse = 0.55 + 0.45 * Math.sin((performance.now() - this._t0) * 0.006)
          gl.enable(gl.BLEND)
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
          gl.depthMask(false)
          const prevWidth = this.wireframeWidth
          this.wireframeWidth = 2
          this.#renderWireframe([0.3, 1.0, 0.45, 0.85 * pulse])
          this.wireframeWidth = prevWidth
          gl.depthMask(true)
          continue
        }
        this.#renderMain(this.renderMode === 'flat')
      }
      // Restore globals for subsequent passes (wireframe overlay,
      // particles, etc.) and for any post-frame code that reads
      // unitWorldXZ / buildPercent expecting the "primary" unit.
      // Team colour is restored too so the wireframe overlay /
      // ghost-placement pulse don't inherit the last drawn entity's
      // recoloured palette.
      this.buildPercent = savedBp
      this._unitTransform.x = savedUt.x
      this._unitTransform.y = savedUt.y
      this._unitTransform.z = savedUt.z
      this._unitTransform.headingRad = savedUt.headingRad
      this.teamColor = savedTC
      this.teamColorEnable = savedTCe
      // Selection rings — ground-aligned green hairline squares per
      // entity with `selected: true`.  Drawn AFTER the entity loop so
      // the ring composites on top of the unit when the camera looks
      // down from above (depth still respected so rings clip behind
      // taller foreground geometry).  Sandbox is the only consumer
      // today; viewer never sets `selected` on its single entity.
      this.#renderSelectionRings(this._entities)
    } else {
      this.#renderMain(this.renderMode === 'flat')
      if (this.wireframeOverlay) {
        // Polygon offset isn't reliable in WebGL1 across drivers, so
        // we draw the overlay at very-low alpha with depth test still
        // on — line pixels that match the surface depth (LEQUAL)
        // overdraw the surface without z-fight.
        this.#renderWireframe([1.0, 1.0, 1.0, 0.55])
      }
      // Build-progress nano-frame overlay.  When the simulated
      // build percent is below 100, draw a pulsing green wireframe
      // so the unit reads as "still being constructed".  Pulse
      // floor at 0.6 so even at the dimmest point the lines stay
      // readable.  Alpha scales with remaining-build, so a low
      // build% shows a dense bright wireframe while a high build%
      // shows just a faint nano-flicker.  We explicitly turn on
      // BLEND + nudge line width up to 2 px for visibility, and
      // turn depth-write OFF so the bright nano-lines don't
      // pollute the depth buffer for the DoF post-process.
      if (this.buildPercent < 100) {
        const pulse = 0.6 + 0.4 * Math.sin((performance.now() - this._t0) * 0.005)
        const remaining = 1 - this.buildPercent / 100
        const alpha = Math.min(1, 0.45 + 0.55 * remaining) * pulse
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
        gl.depthMask(false)
        const prevWidth = this.wireframeWidth
        this.wireframeWidth = 2
        this.#renderWireframe([0.25, 1.0, 0.45, alpha])
        this.wireframeWidth = prevWidth
        gl.depthMask(true)
      }
    }
    if (this._hoveredPieceName || this._hoveredTexture) {
      // Hover highlight: bright red wireframe on the hovered piece
      // (with its descendants) AND/OR every piece whose drawGroups
      // reference the hovered texture.  Drawn AFTER the main scene
      // with depth-test disabled so it always sits on top, even on
      // parts hidden behind other geometry — pinpoints which piece
      // a tree row or texture row refers to even when tucked behind
      // another panel.
      this.#renderHoverHighlight()
    }

    // COB SFX particles — drawn after the unit so smoke + sparks
    // composite over the hull.  Inside the scene FBO when DoF is
    // active so the post-process catches them too.  In multi-entity
    // mode we render each entity's own particle pool in turn (each
    // CobBinding owns its own pool) by swapping the pool ref before
    // each call.
    if (this._entities) {
      const savedPool = this._particlePool
      for (const ent of this._entities) {
        const pool = ent.binding && ent.binding.particles
        if (pool && pool.count > 0) {
          this._particlePool = pool
          this.#renderParticles()
        }
      }
      this._particlePool = savedPool
    } else {
      this.#renderParticles()
    }

    // When the scene rendered into our offscreen FBO (DoF enabled),
    // composite to the default framebuffer via the post-process pass.
    if (useScenePass) this.#compositeDoF()

    // Restore single-unit `this.model` after multi-entity rendering
    // so callers reading mv.model (the inspectors, the piece tree)
    // don't see the LAST entity in the loop as the active unit.
    // Unconditional restore when entities were present — the prior
    // `_savedModel !== null` guard skipped the restore for the sandbox
    // (which legitimately starts with this.model === null), leaving the
    // last entity's model leaked onto this.model.  The next frame's
    // empty-scene fallback then saw `!!this.model` as truthy and went
    // down the unit-bounds-anchored ground path, which shrunk the grid
    // footprint down to a tiny pad around the leaked model's centre —
    // the "grid disappears on Clear Field" symptom.
    if (this._entities) {
      this.model = _savedModel
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
    // Two-pass walk: first locate the hovered piece (matching by
    // lowercased name), then paint that piece AND every descendant
    // in red.  Highlighting the whole sub-tree (not just the leaf)
    // mirrors how TA scripts manipulate piece hierarchies — selecting
    // "wing1" should call attention to the wingtip + flare children
    // too so the user sees the entire animated group.
    const wantPiece   = this._hoveredPieceName
    const wantTexture = this._hoveredTexture
    const paintPiece = (piece) => {
      if (!piece.visible || !piece.wireframe) return
      gl.uniformMatrix4fv(this.uWireWorld, false, piece.worldMatrix)
      gl.bindBuffer(gl.ARRAY_BUFFER, piece.wireframe.vbo)
      gl.enableVertexAttribArray(this.aWirePos)
      gl.vertexAttribPointer(this.aWirePos, 3, gl.FLOAT, false, 0, 0)
      gl.drawArrays(gl.LINES, 0, piece.wireframe.vertexCount)
    }
    const paintHierarchy = (piece, parent) => {
      if (!piece) return
      piece.computeWorldMatrix(parent, this._worldScratch)
      paintPiece(piece)
      for (const c of piece.children) paintHierarchy(c, piece.worldMatrix)
    }
    // Single recursive walk: refresh every piece's world matrix
    // (so paintHierarchy below sees fresh transforms), then for
    // each piece decide whether to highlight it based on the two
    // hover criteria.
    //   * wantPiece — when the piece's name matches, paint it +
    //     all descendants (existing piece-hover behaviour).
    //   * wantTexture — when ANY of the piece's drawGroups
    //     references the texture, paint just that piece.  No
    //     descendant cascade — the user is asking "which pieces
    //     use this texture", not "which pieces are under this
    //     texture in the hierarchy".
    // Paint only the wireframe edges belonging to primitives that
    // use `wantTexture`.  The piece's per-texture wireframe map
    // (built by the model loader) carries exactly the edges whose
    // tris share a texture name, so a one-face logo decal lights
    // up that face instead of the whole hull (which the combined
    // piece.wireframe would cover).
    const paintPieceTexture = (piece) => {
      if (!piece.visible || !piece.wireframeByTex) return
      const w = piece.wireframeByTex.get(wantTexture)
      if (!w) return
      gl.uniformMatrix4fv(this.uWireWorld, false, piece.worldMatrix)
      gl.bindBuffer(gl.ARRAY_BUFFER, w.vbo)
      gl.enableVertexAttribArray(this.aWirePos)
      gl.vertexAttribPointer(this.aWirePos, 3, gl.FLOAT, false, 0, 0)
      gl.drawArrays(gl.LINES, 0, w.vertexCount)
    }
    const walk = (piece, parent) => {
      if (!piece) return
      piece.computeWorldMatrix(parent, this._worldScratch)
      if (wantPiece && piece.name?.toLowerCase() === wantPiece) {
        paintHierarchy(piece, parent)
        return  // descendant matches absorbed into the cascade
      }
      if (wantTexture) paintPieceTexture(piece)
      for (const c of piece.children) walk(c, piece.worldMatrix)
    }
    walk(this.model.root, this._modelMatrix)
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

  #renderShadowPass(lightIdx = 0) {
    const gl = this.gl
    const fbo = lightIdx === 1 ? this._shadowFBO2 : this._shadowFBO
    const space = lightIdx === 1 ? this._lightSpace2 : this._lightSpace
    if (!fbo) return
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
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
    gl.uniformMatrix4fv(this.uShadowLightSpace, false, space)
    // Multi-entity mode (sandbox) — each entity contributes its own
    // shadow at its CURRENT world position, not the first entity's
    // bounds-center.  Without this loop the renderer's per-entity main
    // pass below paints every unit correctly but every shadow stayed
    // glued to wherever the first spawn landed.  We mutate this.model
    // + this._modelMatrix per entity, draw geometry, then restore the
    // outer-scope state so the post-shadow main pass picks up where
    // this loop leaves it.
    if (this._entities && this._entities.length > 0) {
      const savedModel = this.model
      const savedMatrix = new Float32Array(this._modelMatrix)
      for (const ent of this._entities) {
        // Ghost entities (placement preview) have no live unit so
        // no shadow — matches the "this isn't a real spawn yet" read
        // of the wireframe ghost.
        if (ent.ghost || !ent.model) continue
        this.model = ent.model
        const t = ent.transform || { x: 0, y: 0, z: 0, headingRad: 0 }
        Mat4.identity(this._modelMatrix)
        if (t.x !== 0 || t.y !== 0 || t.z !== 0) {
          Mat4.translate(this._modelMatrix, this._modelMatrix, t.x, t.y, t.z)
        }
        if (t.headingRad !== 0) {
          Mat4.rotateY(this._modelMatrix, this._modelMatrix, t.headingRad)
        }
        this.#drawGeometry(this.model.root, this._modelMatrix, true)
      }
      this.model = savedModel
      this._modelMatrix.set(savedMatrix)
    } else {
      this.#drawGeometry(this.model.root, this._modelMatrix, true)
    }

    gl.disable(gl.CULL_FACE)
  }

  // ── Frame: sky pass ─────────────────────────────────────────────────

  #renderSky() {
    const gl = this.gl
    gl.useProgram(this.programSky)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._skyVBO)
    gl.enableVertexAttribArray(this.aSkyPos)
    gl.vertexAttribPointer(this.aSkyPos, 2, gl.FLOAT, false, 0, 0)
    // Build inv(view*proj) so the fragment shader can recover a
    // world-space ray for each pixel.  The matrix changes only when
    // the camera moves so a per-frame inversion is cheap.
    Mat4.invert(this._invProj, this.camera.projMatrix)
    Mat4.invert(this._invView, this.camera.viewMatrix)
    Mat4.multiply(this._invVP, this._invView, this._invProj)
    gl.uniformMatrix4fv(this.uSkyInvVP, false, this._invVP)
    gl.uniform3fv(this.uSkyEyePos, this.camera.eye)
    const s = this.skyScheme
    gl.uniform3fv(this.uSkyZenith, s.zenith)
    gl.uniform3fv(this.uSkyHorizon, s.horizon)
    // Sun 1 — direction is the main scene light direction, normalised
    // by the renderer's own normalise (lightDir already is).
    gl.uniform3fv(this.uSkySun1Col, s.sun1.color)
    gl.uniform3fv(this.uSkySun1Dir, s.sun1.dir || this.lightDir)
    gl.uniform1f(this.uSkySun1Size, s.sun1.size)
    // Sun 2 — colour [0,0,0] means "off"; pass anyway to avoid
    // uniform-undefined warnings on some drivers.
    gl.uniform3fv(this.uSkySun2Col, s.sun2.color)
    gl.uniform3fv(this.uSkySun2Dir, s.sun2.dir)
    gl.uniform1f(this.uSkySun2Size, s.sun2.size)
    gl.uniform3fv(this.uSkyCloudCol, s.cloudColor)
    gl.uniform3fv(this.uSkyCloudShd, s.cloudShadow)
    gl.uniform1f(this.uSkyCloudCov, s.cloudCoverage)
    gl.uniform1f(this.uSkyCloudDen, s.cloudDensity)
    gl.uniform1f(this.uSkyCloudSpd, s.cloudSpeed)
    gl.uniform1f(this.uSkyTime, (performance.now() - this._t0) / 1000)
    gl.uniform1f(this.uSkyOptGodBeams, this.optGodBeams ? 1 : 0)
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
    gl.uniformMatrix4fv(this.uGroundLightSpace2, false, this._lightSpace2)
    gl.uniform3fv(this.uGroundColorA, this.groundColorA)
    gl.uniform3fv(this.uGroundColorB, this.groundColorB)
    // Hand the ground program sun2's colour so it can short-circuit
    // the second shadow tap on single-sun environments.
    gl.uniform3fv(this.uGroundLightColor2, this.lightColor2)
    // In non-sea modes the ground plane sits just under the model's
    // lowest vertex so the unit stands ON it.  In Sea mode it gets
    // shifted up by submersionMode so ships ride at boot-stripe
    // level and subs end up under the surface — _getWaterY()
    // bakes that adjustment in.
    const groundY = this.groundMode === 'sea' ? this._getWaterY() : (this.model.bounds.min[1] - 0.05)
    // Multi-entity mode (sandbox) anchors the ground footprint on the
    // camera target with a radius scaled to the current zoom — single
    // unit-sized pad would feather out a few feet from the model and
    // leave the rest of the canvas a blue void.  Single-unit mode
    // keeps the original behaviour: pad centred on the model, sized to
    // its bounds (so the grid hugs the unit's footprint).
    let cx, cz, radius
    if (this._entities && this._entities.length > 0 && this.camera && this.camera.target) {
      cx = this.camera.target[0]
      cz = this.camera.target[2]
      // Cover roughly twice the camera distance so panning + zooming
      // out still find ground under the cursor.  Clamped to a sane
      // floor for very close zooms.
      radius = Math.max(200, (this.camera.distance || 200) * 2)
    } else {
      cx = (this.model.bounds.min[0] + this.model.bounds.max[0]) * 0.5
      cz = (this.model.bounds.min[2] + this.model.bounds.max[2]) * 0.5
      const span = Math.hypot(this.model.bounds.max[0] - this.model.bounds.min[0], this.model.bounds.max[2] - this.model.bounds.min[2])
      radius = Math.max(span * 0.6, 4)
    }
    gl.uniform3fv(this.uGroundCenter, [cx, groundY, cz])
    gl.uniform1f(this.uGroundRadius, radius)
    gl.uniform1f(this.uGroundY, groundY)
    gl.uniform1f(this.uGroundShadowEnabled, (this._shadowFBO && this.renderMode === 'full') ? 1 : 0)
    // Shadow opacity tracks construction progress — translucent at low
    // build %, solid at 100%.  Cubic ease so the shadow stays subtle
    // until the build is nearly done, then snaps to full presence.
    const _bps = (this.buildPercent ?? 100) / 100
    gl.uniform1f(this.uGroundShadowStrength, _bps * _bps * _bps)
    if (this._shadowFBO) {
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, this._shadowTex)
      gl.uniform1i(this.uGroundShadowMap, 1)
      // Twin-sun secondary shadow.  Bound regardless of whether
      // it's actively used - the fragment shader gates the sample
      // on uLightColor2 so single-sun envs spend no extra ALU.
      // Sampler still needs to point at a real texture or some
      // drivers throw INVALID_OPERATION.
      gl.activeTexture(gl.TEXTURE3)
      gl.bindTexture(gl.TEXTURE_2D, this._shadowTex2 || this._shadowTex)
      gl.uniform1i(this.uGroundShadowMap2, 3)
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
    gl.uniform3fv(this.uGroundHorizonColor, this.skyScheme.horizon)
    gl.uniform1f(this.uGroundOptWaterReflections, this.optWaterReflections ? 1 : 0)
    gl.uniform1f(this.uGroundOptSpecular, this.optSpecular ? 1 : 0)
    // Waves toggle off → flat sea (intensity 0); otherwise use the
    // slider value so the user can scale waves from glassy to gale.
    gl.uniform1f(this.uGroundWavesIntensity, this.optWaves ? this.wavesIntensity : 0.0)
    // Per-environment water + seabed colours come from the active
    // environment preset.  Default values pull from greenworld so
    // an environment that doesn't override a particular stop still
    // looks like temperate ocean.
    const env = this.activeEnvironment || ENVIRONMENT_PRESETS.greenworld
    gl.uniform3fv(this.uGroundWaterShallow, env.waterShallow || [0.10, 0.40, 0.72])
    gl.uniform3fv(this.uGroundWaterMid,     env.waterMid     || [0.04, 0.18, 0.45])
    gl.uniform3fv(this.uGroundWaterDeep,    env.waterDeep    || [0.01, 0.05, 0.20])
    gl.uniform1f(this.uGroundWaterTranslucency, env.waterTranslucency ?? 1.0)
    gl.uniform3fv(this.uGroundSeabedSand,    env.seabedSand    || [0.25, 0.32, 0.30])
    gl.uniform3fv(this.uGroundSeabedRock,    env.seabedRock    || [0.14, 0.18, 0.18])
    gl.uniform3fv(this.uGroundSeabedCaustic, env.seabedCaustic || [0.35, 0.65, 0.95])
    // Seabed feature knobs — user-controlled multipliers on the
    // GLSL seabedHeight() helper.
    gl.uniform1f(this.uGroundSeabedHeightMul, this.seabedHeightMul)
    gl.uniform1f(this.uGroundSeabedScaleMul, this.seabedScaleMul)
    gl.uniform1f(this.uGroundSeabedRockChance, this.seabedRockChance)
    // Dynamic pulse light — same source as the main pass (set per
    // frame by setPulseLight from the strongest active particle).
    // Terrain modes use this to spill a coloured wash from weapon
    // SFX onto the ground beneath the firing unit; cleared (null)
    // means the shader's gate skips the contribution entirely.
    const _gpl = this._pulseLight
    if (_gpl && _gpl.range > 0) {
      gl.uniform3fv(this.uGroundPulseLightPos, _gpl.pos)
      gl.uniform3fv(this.uGroundPulseLightColor, _gpl.color)
      gl.uniform1f(this.uGroundPulseLightRange, _gpl.range)
    } else {
      gl.uniform3fv(this.uGroundPulseLightPos, [0, 0, 0])
      gl.uniform3fv(this.uGroundPulseLightColor, [0, 0, 0])
      gl.uniform1f(this.uGroundPulseLightRange, 0)
    }
    // Background mountain ring.  Active only on non-sea ground
    // modes; sea pass already paints water + seabed and shouldn't
    // be displaced.  Inner clearing scales with the unit's bounding
    // span so a Krogoth doesn't get hemmed in.
    const bgActive = this.optBgTerrain && this.groundMode !== 'sea' && this.groundMode !== 'off'
    gl.uniform1f(this.uGroundMountainActive, bgActive ? 1 : 0)
    if (bgActive) {
      // Mountain-ring clearing scales with whatever sits at the
      // ground centre: a single unit's bounding span in single-unit
      // mode, or a generous sandbox-sized constant in multi-entity
      // mode (where `span` from a synthesised bounds would be tiny).
      const bgSpan = (this._entities && this._entities.length > 0)
        ? Math.max(200, (this.camera?.distance || 200) * 0.6)
        : Math.hypot(
            this.model.bounds.max[0] - this.model.bounds.min[0],
            this.model.bounds.max[2] - this.model.bounds.min[2],
          )
      const clearR = Math.max(bgSpan * 3.5, 120)
      gl.uniform3fv(this.uGroundClearCenter, [cx, groundY, cz])
      gl.uniform1f(this.uGroundClearRadius, clearR)
      gl.uniform1f(this.uGroundClearFalloff, Math.max(bgSpan * 2.5, 80))
      gl.uniform1f(this.uGroundMountainHeight, (env.mountainHeight || 62) * this.bgTerrainHeightMul)
      gl.uniform1f(this.uGroundMountainScale, (env.mountainScale || 1) * this.bgTerrainScaleMul)
      gl.uniform1i(this.uGroundMountainStyle, env.mountainStyle ?? this.bgTerrainStyle)
      gl.uniform3fv(this.uGroundMountainBase, env.mountainBase || this.bgTerrainBase)
      gl.uniform3fv(this.uGroundMountainPeak, env.mountainPeak || this.bgTerrainPeak)
      gl.uniform1f(this.uGroundMountainGloss, env.mountainGloss ?? this.bgTerrainGloss)
    }
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
    // Seabed sits ~45 wu below the water plane — deep enough that
    // the new taller rock outcrops (~6 wu peaks + ~5 wu dune crests)
    // never reach the wave troughs above (~2.6 wu deep), and the
    // water column reads as a real ocean depth.
    const seabedY = groundY - 45.0
    gl.uniform1f(this.uGroundSeabedY, seabedY)
    if (this.groundMode === 'sea') {
      if (!this._groundPass || this._groundPass === 'seabed') {
        // Pass 1: seabed (opaque).  Write depth normally so the
        // reflection + water passes can depth-test against it —
        // anything geometrically below the bed gets clipped.
        gl.uniform1f(this.uGroundSeabedActive, 1)
        gl.disable(gl.BLEND)
        gl.drawArrays(gl.TRIANGLES, 0, this._groundVertexCount || 6)
        gl.enable(gl.BLEND)
        gl.uniform1f(this.uGroundSeabedActive, 0)
      }
      if (!this._groundPass || this._groundPass === 'water') {
        gl.drawArrays(gl.TRIANGLES, 0, this._groundVertexCount || 6)
      }
    } else {
      gl.drawArrays(gl.TRIANGLES, 0, this._groundVertexCount || 6)
    }
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
    gl.uniformMatrix4fv(this.uLightSpace2, false, this._lightSpace2)
    gl.uniform3fv(this.uLightDir, this.lightDir)
    gl.uniform3fv(this.uLightColor, this.lightColor)
    gl.uniform3fv(this.uLightDir2, this.lightDir2)
    gl.uniform3fv(this.uLightColor2, this.lightColor2)
    gl.uniform3fv(this.uSkyColorMain, this.skyColor)
    gl.uniform3fv(this.uGroundColor, this.groundColor)
    gl.uniform3fv(this.uMainEyePos, this.camera.eye)
    gl.uniform3fv(this.uMainFillColor, this._fillColor())
    gl.uniform3fv(this.uMainBackColor, this._backColor())
    gl.uniform1f(this.uFlatLighting, 0)
    gl.uniform1f(this.uShadowEnabled, 0) // reflection doesn't read the depth map
    gl.uniform1f(this.uReflectionTint, 1)
    // Reflection pass paints the mirrored unit dim+blue.  Sea bounce
    // on top of that would double-glow the reflection, so leave it
    // off for this pass.
    gl.uniform1f(this.uSeaActive, 0)
    gl.uniform1f(this.uMainTime, (performance.now() - this._t0) / 1000)
    gl.uniform1f(this.uMainWaterY, this._getWaterY())
    gl.uniform1f(this.uMainWaterOnHull, 0)
    gl.uniform1f(this.uMainWavesIntensity, this.optWaves ? this.wavesIntensity : 0.0)
    gl.uniform3fv(this.uMainTeamColor, this.teamColor || [0, 0, 1])
    gl.uniform1f(this.uMainTeamColorEnable, this.teamColorEnable ? 1 : 0)
    // Dynamic pulse light — fed by setPulseLight() from the
    // controller each frame.  Zero colour gates the shader path off
    // when no weapon is firing.  Same uniforms in main + reflection
    // passes so the d-gun light reflects off water too.
    const _pl = this._pulseLight
    if (_pl && _pl.range > 0) {
      gl.uniform3fv(this.uPulseLightPos, _pl.pos)
      gl.uniform3fv(this.uPulseLightColor, _pl.color)
      gl.uniform1f(this.uPulseLightRange, _pl.range)
    } else {
      gl.uniform3fv(this.uPulseLightPos, [0, 0, 0])
      gl.uniform3fv(this.uPulseLightColor, [0, 0, 0])
      gl.uniform1f(this.uPulseLightRange, 0)
    }
    // Unit centre + radius for the pulse-light self-occlusion test.
    // Centre = model bbox centroid translated by the unit transform
    // (so it follows a walking unit).  Radius = bbox diagonal/2 with
    // a small floor so vanishingly small units don't divide by zero.
    if (this.model && this.model.bounds) {
      const _b = this.model.bounds
      const _ut = this._unitTransform
      const _cx = (_b.min[0] + _b.max[0]) * 0.5 + (_ut ? _ut.x : 0)
      const _cy = (_b.min[1] + _b.max[1]) * 0.5 + (_ut ? _ut.y : 0)
      const _cz = (_b.min[2] + _b.max[2]) * 0.5 + (_ut ? _ut.z : 0)
      const _dx = _b.max[0] - _b.min[0], _dy = _b.max[1] - _b.min[1], _dz = _b.max[2] - _b.min[2]
      const _radius = Math.max(2, 0.5 * Math.hypot(_dx, _dy, _dz))
      gl.uniform3fv(this.uUnitCenter, [_cx, _cy, _cz])
      gl.uniform1f(this.uUnitRadius, _radius)
    } else {
      gl.uniform3fv(this.uUnitCenter, [0, 0, 0])
      gl.uniform1f(this.uUnitRadius, 10)
    }
    // Build-progress fade.  When buildPercent < 100, the textured
    // model renders at reduced alpha so the green nano-wireframe
    // overlay drawn afterwards reads cleanly; at 100 the texture
    // is fully opaque.  Cubic ease so the fade-in feels weighty
    // toward the end of construction rather than linearly bright.
    const _bp = (this.buildPercent ?? 100) / 100
    gl.uniform1f(this.uMainOutputAlpha, _bp * _bp * _bp)

    // Mirror across the water plane.  _getWaterY() handles the
    // submersion-mode offset so a sub's reflection mirrors across
    // the shifted-up water level, not the unit's bounding-box floor.
    const waterY = this._getWaterY()
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
      // Mirror the SAME unit translate + heading rotation the main
      // pass applies, otherwise a moving unit's reflection stays
      // anchored at world origin while the actual unit walks away.
      // Y-mirror commutes with Y-axis rotation so the rotateY here
      // produces the correct mirrored orientation when multiplied
      // by `mirror` below.
      const ut = this._unitTransform
      if (ut.x !== 0 || ut.z !== 0) Mat4.translate(bob, bob, ut.x, 0, ut.z)
      if (ut.headingRad !== 0) Mat4.rotateY(bob, bob, ut.headingRad)
      // Same submersion lift the main model gets — without it the
      // mirrored unit reflects from y=0 instead of from the unit's
      // actually-displayed position.
      const yOff = this.getUnitYOffset()
      if (yOff !== 0) Mat4.translate(bob, bob, 0, yOff, 0)
      this._applySeaBob(bob, cx, cz, t)
      Mat4.multiply(refl, mirror, bob)
    } else {
      Mat4.copy(refl, mirror)
    }
    // Pipeline (in the caller) is: seabed → reflection → water.  The
    // reflection now WRITES depth so the water surface above can
    // depth-test against it (LEQUAL → water at the water plane is
    // <= reflection at top of mirrored hull, so water still wins).
    // Polygon offset pushes the reflection's depth slightly away
    // from the camera so it can't z-fight against the water surface
    // at the boundary where they touch.
    gl.enable(gl.POLYGON_OFFSET_FILL)
    gl.polygonOffset(1.0, 1.0)
    this.#drawGeometry(this.model.root, refl, false)
    gl.polygonOffset(0.0, 0.0)
    gl.disable(gl.POLYGON_OFFSET_FILL)

    gl.uniform1f(this.uReflectionTint, 0)
  }

  // ── Frame: main scene pass ─────────────────────────────────────────

  #renderMain(flat) {
    const gl = this.gl
    gl.useProgram(this.programMain)
    gl.uniformMatrix4fv(this.uProj, false, this.camera.projMatrix)
    gl.uniformMatrix4fv(this.uView, false, this.camera.viewMatrix)
    gl.uniformMatrix4fv(this.uLightSpace, false, this._lightSpace)
    gl.uniformMatrix4fv(this.uLightSpace2, false, this._lightSpace2)
    gl.uniform3fv(this.uLightDir, this.lightDir)
    gl.uniform3fv(this.uLightColor, this.lightColor)
    gl.uniform3fv(this.uLightDir2, this.lightDir2)
    gl.uniform3fv(this.uLightColor2, this.lightColor2)
    gl.uniform3fv(this.uSkyColorMain, this.skyColor)
    gl.uniform3fv(this.uGroundColor, this.groundColor)
    gl.uniform3fv(this.uMainEyePos, this.camera.eye)
    gl.uniform3fv(this.uMainFillColor, this._fillColor())
    gl.uniform3fv(this.uMainBackColor, this._backColor())
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
    gl.uniform1f(this.uMainWaterY, this._getWaterY())
    gl.uniform1f(this.uMainWaterOnHull, this.optWaterReflections ? 1 : 0)
    gl.uniform1f(this.uMainWavesIntensity, this.optWaves ? this.wavesIntensity : 0.0)
    gl.uniform3fv(this.uMainTeamColor, this.teamColor || [0, 0, 1])
    gl.uniform1f(this.uMainTeamColorEnable, this.teamColorEnable ? 1 : 0)
    // Dynamic pulse light — fed by setPulseLight() from the
    // controller each frame.  Zero colour gates the shader path off
    // when no weapon is firing.  Same uniforms in main + reflection
    // passes so the d-gun light reflects off water too.
    const _pl = this._pulseLight
    if (_pl && _pl.range > 0) {
      gl.uniform3fv(this.uPulseLightPos, _pl.pos)
      gl.uniform3fv(this.uPulseLightColor, _pl.color)
      gl.uniform1f(this.uPulseLightRange, _pl.range)
    } else {
      gl.uniform3fv(this.uPulseLightPos, [0, 0, 0])
      gl.uniform3fv(this.uPulseLightColor, [0, 0, 0])
      gl.uniform1f(this.uPulseLightRange, 0)
    }
    // Unit centre + radius for the pulse-light self-occlusion test.
    // Centre = model bbox centroid translated by the unit transform
    // (so it follows a walking unit).  Radius = bbox diagonal/2 with
    // a small floor so vanishingly small units don't divide by zero.
    if (this.model && this.model.bounds) {
      const _b = this.model.bounds
      const _ut = this._unitTransform
      const _cx = (_b.min[0] + _b.max[0]) * 0.5 + (_ut ? _ut.x : 0)
      const _cy = (_b.min[1] + _b.max[1]) * 0.5 + (_ut ? _ut.y : 0)
      const _cz = (_b.min[2] + _b.max[2]) * 0.5 + (_ut ? _ut.z : 0)
      const _dx = _b.max[0] - _b.min[0], _dy = _b.max[1] - _b.min[1], _dz = _b.max[2] - _b.min[2]
      const _radius = Math.max(2, 0.5 * Math.hypot(_dx, _dy, _dz))
      gl.uniform3fv(this.uUnitCenter, [_cx, _cy, _cz])
      gl.uniform1f(this.uUnitRadius, _radius)
    } else {
      gl.uniform3fv(this.uUnitCenter, [0, 0, 0])
      gl.uniform1f(this.uUnitRadius, 10)
    }
    // Build-progress fade.  When buildPercent < 100, the textured
    // model renders at reduced alpha so the green nano-wireframe
    // overlay drawn afterwards reads cleanly; at 100 the texture
    // is fully opaque.  Cubic ease so the fade-in feels weighty
    // toward the end of construction rather than linearly bright.
    const _bp = (this.buildPercent ?? 100) / 100
    gl.uniform1f(this.uMainOutputAlpha, _bp * _bp * _bp)
    if (this._shadowFBO && !flat) {
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, this._shadowTex)
      gl.uniform1i(this.uShadowMap, 1)
      // Bind the second light's shadow map regardless of whether
      // it's actively in use — the shader's branch on uLightColor2
      // determines whether the sample contributes.  Pointing the
      // sampler at a real texture (even if it's a stale frame's
      // content) keeps WebGL happy.
      gl.activeTexture(gl.TEXTURE3)
      gl.bindTexture(gl.TEXTURE_2D, this._shadowTex2 || this._shadowTex)
      gl.uniform1i(this.uShadowMap2, 3)
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
            // aAO may bind to -1 if the driver optimised the attribute
            // away (e.g. when the AO term is dead-code-eliminated in
            // future shader changes) — guard the enable to stay safe.
            if (this.aAO >= 0) {
              gl.enableVertexAttribArray(this.aAO)
              gl.vertexAttribPointer(this.aAO, 1, gl.FLOAT, false, VERTEX_STRIDE, AO_OFFSET)
            }
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
    // Same gust envelope as GLSL — keeps the JS-sampled bob in sync
    // with the visible surface during the rougher patches.
    let gust = 1.0
             + 0.35 * Math.sin(x * 0.018 + t * 0.13) * Math.cos(z * 0.020 - t * 0.10)
             + 0.25 * Math.sin((x + z) * 0.013 + t * 0.07)
             + 0.15 * Math.cos(x * 0.031 - z * 0.024 + t * 0.19)
    if (gust < 0.55) gust = 0.55
    if (gust > 1.75) gust = 1.75
    const hRaw = Math.sin(ph1a) * 0.55 + Math.sin(ph1b) * 0.55
               + Math.sin(ph2a) * 0.42 + Math.sin(ph2b) * 0.32
               + Math.sin(ph3a) * 0.22 + Math.sin(ph3b) * 0.18
               + Math.sin(ph4a) * 0.10 + Math.sin(ph4b) * 0.10
               + Math.sin(ph5a) * 0.03 + Math.sin(ph5b) * 0.03
    const h = hRaw * gust
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
    return { h, dhx: dhx * gust, dhz: dhz * gust }
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
    // Speed multiplier scales the bob's time progression; default
    // 1.0 means the same 0.75× slowdown as before (the "0.75" inside
    // tSlow is the inherent damping for tall ships).
    const tSlow = t * 0.75 * this.bobSpeed
    const s = this.seaWaveSample(x, z, tSlow)
    // Amount multiplier scales the heave + tilt linearly.  When the
    // Waves toggle is off the boat still bobs from the static
    // sample at the same XZ — it would otherwise lurch when the
    // user flips waves back on with the unit at a wave crest.
    const BOB_SCALE = 0.30 * this.bobAmount
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
    let cx, cy, cz, r
    if (this._entities && this._entities.length > 0) {
      // Multi-entity (sandbox) — compute the bounding sphere of all
      // entities' world positions PLUS each unit's per-model bounds
      // radius.  Without this the frustum stays sized for the first
      // entity, so units placed further out cast no shadow (their
      // geometry falls outside the shadow-map's ortho frame).  Pads
      // each unit's bounds by the same 1.6× the single-unit path
      // uses so rotated kbots don't clip at the frustum corners.
      let minX = Infinity, minY = Infinity, minZ = Infinity
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
      let maxUnitRadius = 4
      for (const ent of this._entities) {
        if (!ent.model || !ent.model.bounds) continue
        const t = ent.transform || { x: 0, y: 0, z: 0 }
        const bmin = ent.model.bounds.min
        const bmax = ent.model.bounds.max
        const ux = t.x + (bmin[0] + bmax[0]) * 0.5
        const uy = t.y + (bmin[1] + bmax[1]) * 0.5
        const uz = t.z + (bmin[2] + bmax[2]) * 0.5
        const ur = 0.5 * Math.hypot(bmax[0] - bmin[0], bmax[1] - bmin[1], bmax[2] - bmin[2])
        if (ur > maxUnitRadius) maxUnitRadius = ur
        if (ux - ur < minX) minX = ux - ur
        if (uy - ur < minY) minY = uy - ur
        if (uz - ur < minZ) minZ = uz - ur
        if (ux + ur > maxX) maxX = ux + ur
        if (uy + ur > maxY) maxY = uy + ur
        if (uz + ur > maxZ) maxZ = uz + ur
      }
      cx = (minX + maxX) * 0.5
      cy = (minY + maxY) * 0.5
      cz = (minZ + maxZ) * 0.5
      const halfX = (maxX - minX) * 0.5
      const halfY = (maxY - minY) * 0.5
      const halfZ = (maxZ - minZ) * 0.5
      r = Math.max(2, Math.hypot(halfX, halfY, halfZ) * 1.6)
    } else {
      const min = this.model.bounds.min
      const max = this.model.bounds.max
      // Centre the shadow frustum on the unit's CURRENT world
      // position, not its model-local bounding box.  When the unit
      // walks via _unitTransform, the model vertices are translated
      // into world space at draw time but the shadow frustum has to
      // follow — otherwise a unit that walks ~50 wu from spawn ends
      // up outside the light's ortho frame and its shadow vanishes
      // (or, worse, gets pinned to the spawn point).  Adding
      // _unitTransform.{x,y,z} to the model-local centroid lands the
      // frustum on the unit no matter where it's walked to.
      const ut = this._unitTransform
      cx = (min[0] + max[0]) * 0.5 + (ut ? ut.x : 0)
      cy = (min[1] + max[1]) * 0.5 + (ut ? ut.y : 0)
      cz = (min[2] + max[2]) * 0.5 + (ut ? ut.z : 0)
      const dx = max[0] - min[0], dy = max[1] - min[1], dz = max[2] - min[2]
      const radius = 0.5 * Math.hypot(dx, dy, dz)
      // Pad so corners of the bounding box (rotated by auto-rotate yaw)
      // never fall outside the light's frustum.
      r = Math.max(2, radius * 1.6)
    }
    const dist = Math.max(r * 3, r + 5)
    const eye = [cx + this.lightDir[0] * dist, cy + this.lightDir[1] * dist, cz + this.lightDir[2] * dist]
    Mat4.lookAt(this._lightView, eye, [cx, cy, cz], [0, 1, 0])
    Mat4.ortho(this._lightProj, -r, r, -r, r, 0.1, dist + r * 2)
    Mat4.multiply(this._lightSpace, this._lightProj, this._lightView)
    // Same shadow-frustum math for the second light when it's
    // active.  Skipping it for single-sun worlds (lightColor2 zero)
    // saves the per-frame matrix work AND keeps the shadow pass
    // skip below cheap.
    const sun2Mag = this.lightColor2[0] + this.lightColor2[1] + this.lightColor2[2]
    if (sun2Mag > 0.001) {
      const eye2 = [cx + this.lightDir2[0] * dist, cy + this.lightDir2[1] * dist, cz + this.lightDir2[2] * dist]
      Mat4.lookAt(this._lightView2, eye2, [cx, cy, cz], [0, 1, 0])
      Mat4.ortho(this._lightProj2, -r, r, -r, r, 0.1, dist + r * 2)
      Mat4.multiply(this._lightSpace2, this._lightProj2, this._lightView2)
    }
  }

  // ── Shader/program setup ───────────────────────────────────────────

  #initMainProgram(vsSrc, fsSrc) {
    const prog = this.#linkProgram(vsSrc, fsSrc)
    this.programMain = prog
    const gl = this.gl
    this.aPos = gl.getAttribLocation(prog, 'aPos')
    this.aNormal = gl.getAttribLocation(prog, 'aNormal')
    this.aUV = gl.getAttribLocation(prog, 'aUV')
    this.aAO = gl.getAttribLocation(prog, 'aAO')
    this.uProj = gl.getUniformLocation(prog, 'uProj')
    this.uView = gl.getUniformLocation(prog, 'uView')
    this.uWorld = gl.getUniformLocation(prog, 'uWorld')
    this.uLightSpace = gl.getUniformLocation(prog, 'uLightSpace')
    this.uLightSpace2 = gl.getUniformLocation(prog, 'uLightSpace2')
    this.uTex = gl.getUniformLocation(prog, 'uTex')
    this.uShadowMap = gl.getUniformLocation(prog, 'uShadowMap')
    this.uShadowMap2 = gl.getUniformLocation(prog, 'uShadowMap2')
    this.uMode = gl.getUniformLocation(prog, 'uMode')
    this.uTint = gl.getUniformLocation(prog, 'uTint')
    this.uLightDir = gl.getUniformLocation(prog, 'uLightDir')
    this.uLightColor = gl.getUniformLocation(prog, 'uLightColor')
    this.uLightDir2 = gl.getUniformLocation(prog, 'uLightDir2')
    this.uLightColor2 = gl.getUniformLocation(prog, 'uLightColor2')
    this.uSkyColorMain = gl.getUniformLocation(prog, 'uSkyColor')
    this.uGroundColor = gl.getUniformLocation(prog, 'uGroundColor')
    this.uMainEyePos = gl.getUniformLocation(prog, 'uEyePos')
    this.uMainFillColor = gl.getUniformLocation(prog, 'uFillColor')
    this.uMainBackColor = gl.getUniformLocation(prog, 'uBackColor')
    this.uShadowEnabled = gl.getUniformLocation(prog, 'uShadowEnabled')
    this.uShadowBias = gl.getUniformLocation(prog, 'uShadowBias')
    this.uFlatLighting = gl.getUniformLocation(prog, 'uFlatLighting')
    this.uReflectionTint = gl.getUniformLocation(prog, 'uReflectionTint')
    this.uSeaActive = gl.getUniformLocation(prog, 'uSeaActive')
    this.uMainTime = gl.getUniformLocation(prog, 'uTime')
    this.uMainWaterY = gl.getUniformLocation(prog, 'uWaterY')
    this.uMainWavesIntensity = gl.getUniformLocation(prog, 'uWavesIntensity')
    this.uMainWaterOnHull = gl.getUniformLocation(prog, 'uWaterOnHull')
    this.uMainTeamColor = gl.getUniformLocation(prog, 'uTeamColor')
    this.uMainTeamColorEnable = gl.getUniformLocation(prog, 'uTeamColorEnable')
    // Dynamic pulse-light (weapon SFX) — set each frame by the
    // controller via setPulseLight(pos, color, range).  Defaults to
    // zero colour so the shader's gate skips it when no weapon is
    // firing.
    this.uPulseLightPos = gl.getUniformLocation(prog, 'uPulseLightPos')
    this.uPulseLightColor = gl.getUniformLocation(prog, 'uPulseLightColor')
    this.uPulseLightRange = gl.getUniformLocation(prog, 'uPulseLightRange')
    // Unit centre + radius — pulse light uses them for self-shadowing
    // so the projectile light doesn't bleed through to the unit's
    // opposite side.
    this.uUnitCenter = gl.getUniformLocation(prog, 'uUnitCenter')
    this.uUnitRadius = gl.getUniformLocation(prog, 'uUnitRadius')
    this.uMainOutputAlpha = gl.getUniformLocation(prog, 'uOutputAlpha')
  }

  #initShadowProgram(vsSrc, fsSrc) {
    const prog = this.#linkProgram(vsSrc, fsSrc)
    this.programShadow = prog
    const gl = this.gl
    this.aShadowPos = gl.getAttribLocation(prog, 'aPos')
    this.aShadowUV = gl.getAttribLocation(prog, 'aUV')
    this.uShadowLightSpace = gl.getUniformLocation(prog, 'uLightSpace')
    this.uShadowWorld = gl.getUniformLocation(prog, 'uWorld')
    this.uShadowTex = gl.getUniformLocation(prog, 'uTex')
    this.uShadowMode = gl.getUniformLocation(prog, 'uMode')
  }

  #initSkyProgram(vsSrc, fsSrc) {
    const prog = this.#linkProgram(vsSrc, fsSrc)
    this.programSky = prog
    const gl = this.gl
    this.aSkyPos = gl.getAttribLocation(prog, 'aPos')
    this.uSkyInvVP    = gl.getUniformLocation(prog, 'uInvViewProj')
    this.uSkyEyePos   = gl.getUniformLocation(prog, 'uEyePos')
    this.uSkyZenith   = gl.getUniformLocation(prog, 'uZenith')
    this.uSkyHorizon  = gl.getUniformLocation(prog, 'uHorizon')
    this.uSkySun1Col  = gl.getUniformLocation(prog, 'uSun1Color')
    this.uSkySun1Dir  = gl.getUniformLocation(prog, 'uSun1Dir')
    this.uSkySun1Size = gl.getUniformLocation(prog, 'uSun1Size')
    this.uSkySun2Col  = gl.getUniformLocation(prog, 'uSun2Color')
    this.uSkySun2Dir  = gl.getUniformLocation(prog, 'uSun2Dir')
    this.uSkySun2Size = gl.getUniformLocation(prog, 'uSun2Size')
    this.uSkyCloudCol = gl.getUniformLocation(prog, 'uCloudColor')
    this.uSkyCloudShd = gl.getUniformLocation(prog, 'uCloudShadow')
    this.uSkyCloudCov = gl.getUniformLocation(prog, 'uCloudCoverage')
    this.uSkyCloudDen = gl.getUniformLocation(prog, 'uCloudDensity')
    this.uSkyCloudSpd = gl.getUniformLocation(prog, 'uCloudSpeed')
    this.uSkyTime     = gl.getUniformLocation(prog, 'uTime')
    this.uSkyOptGodBeams = gl.getUniformLocation(prog, 'uOptGodBeams')
    // Full-screen triangle pair in NDC.
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, 1, 1,
      -1, -1, 1, 1, -1, 1,
    ]), gl.STATIC_DRAW)
    this._skyVBO = buf
    // Scratch matrices for inv(view-proj) computation each frame.
    this._invProj = Mat4.create()
    this._invView = Mat4.create()
    this._invVP   = Mat4.create()
  }

  #initGroundProgram(vsSrc, fsSrc) {
    const prog = this.#linkProgram(vsSrc, fsSrc)
    this.programGround = prog
    const gl = this.gl
    this.aGroundPos = gl.getAttribLocation(prog, 'aPos')
    this.uGroundProj = gl.getUniformLocation(prog, 'uProj')
    this.uGroundView = gl.getUniformLocation(prog, 'uView')
    this.uGroundLightSpace = gl.getUniformLocation(prog, 'uLightSpace')
    this.uGroundLightSpace2 = gl.getUniformLocation(prog, 'uLightSpace2')
    this.uGroundShadowMap = gl.getUniformLocation(prog, 'uShadowMap')
    this.uGroundShadowMap2 = gl.getUniformLocation(prog, 'uShadowMap2')
    this.uGroundShadowEnabled = gl.getUniformLocation(prog, 'uShadowEnabled')
    this.uGroundShadowStrength = gl.getUniformLocation(prog, 'uShadowStrength')
    this.uGroundLightColor2 = gl.getUniformLocation(prog, 'uLightColor2')
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
    this.uGroundHorizonColor = gl.getUniformLocation(prog, 'uHorizonColor')
    this.uGroundOptWaterReflections = gl.getUniformLocation(prog, 'uOptWaterReflections')
    this.uGroundOptSpecular = gl.getUniformLocation(prog, 'uOptSpecular')
    this.uGroundWavesIntensity = gl.getUniformLocation(prog, 'uWavesIntensity')
    this.uGroundWaterShallow = gl.getUniformLocation(prog, 'uWaterShallow')
    this.uGroundWaterMid = gl.getUniformLocation(prog, 'uWaterMid')
    this.uGroundWaterDeep = gl.getUniformLocation(prog, 'uWaterDeep')
    this.uGroundWaterTranslucency = gl.getUniformLocation(prog, 'uWaterTranslucency')
    this.uGroundSeabedSand = gl.getUniformLocation(prog, 'uSeabedSand')
    this.uGroundSeabedRock = gl.getUniformLocation(prog, 'uSeabedRock')
    this.uGroundSeabedCaustic = gl.getUniformLocation(prog, 'uSeabedCaustic')
    // Background mountain uniforms — paired with state on the renderer
    // instance.  When optBgTerrain is false, uMountainActive is sent
    // as 0 and the vertex shader short-circuits the displacement.
    this.uGroundClearCenter = gl.getUniformLocation(prog, 'uClearCenter')
    this.uGroundClearRadius = gl.getUniformLocation(prog, 'uClearRadius')
    this.uGroundClearFalloff = gl.getUniformLocation(prog, 'uClearFalloff')
    this.uGroundMountainHeight = gl.getUniformLocation(prog, 'uMountainHeight')
    this.uGroundMountainScale = gl.getUniformLocation(prog, 'uMountainScale')
    this.uGroundMountainActive = gl.getUniformLocation(prog, 'uMountainActive')
    this.uGroundMountainStyle = gl.getUniformLocation(prog, 'uMountainStyle')
    this.uGroundMountainBase = gl.getUniformLocation(prog, 'uMountainBase')
    this.uGroundMountainPeak = gl.getUniformLocation(prog, 'uMountainPeak')
    this.uGroundMountainGloss = gl.getUniformLocation(prog, 'uMountainGloss')
    this.uGroundSeabedHeightMul = gl.getUniformLocation(prog, 'uSeabedHeightMul')
    this.uGroundSeabedScaleMul = gl.getUniformLocation(prog, 'uSeabedScaleMul')
    this.uGroundSeabedRockChance = gl.getUniformLocation(prog, 'uSeabedRockChance')
    // Dynamic pulse-light — same set as the main shader, lets weapon
    // SFX (d-gun, lasers) tint the terrain beneath them.  Set in
    // #renderGround from this._pulseLight which the controller
    // updates per frame via setPulseLight().
    this.uGroundPulseLightPos = gl.getUniformLocation(prog, 'uPulseLightPos')
    this.uGroundPulseLightColor = gl.getUniformLocation(prog, 'uPulseLightColor')
    this.uGroundPulseLightRange = gl.getUniformLocation(prog, 'uPulseLightRange')
    // Lazy-allocate; #renderGround sizes the quad on each draw to keep
    // it large enough for the current model.  For now, a 400×400 plane
    // at y=0 works for every TA unit (largest mass is the Krogoth at
    // ~60 world units across).
    // Tessellated sea-plane.  The grid extends to ~2.5 km on a side
    // so the water + seabed reach the horizon; tessellation is dense
    // near the centre and exponentially coarser at the edge so the
    // GPU only pays for waves where the camera can actually see them.
    //   * Inner ring (~600 wu radius) — fine vertices, sharp swells.
    //   * Outer rings — coarse vertices, faked flat at distance.
    // Non-uniform mapping: cube the parameter t∈[-1,1] so spacing
    // near 0 is tight and spacing near ±1 is loose.  Total ~96² ≈
    // 9k quads, well within mobile budgets.
    const half = 2500
    const N = 96
    const verts = []
    // Build a 1-D ramp of x coordinates with cubic spacing.
    const xs = new Array(N + 1)
    for (let i = 0; i <= N; i++) {
      const t = (i / N) * 2 - 1               // -1..1
      xs[i] = Math.sign(t) * Math.pow(Math.abs(t), 2.4) * half
    }
    for (let j = 0; j < N; j++) {
      const z0 = xs[j], z1 = xs[j + 1]
      for (let i = 0; i < N; i++) {
        const x0 = xs[i], x1 = xs[i + 1]
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

  #initWireProgram(vsSrc, fsSrc) {
    const prog = this.#linkProgram(vsSrc, fsSrc)
    this.programWire = prog
    const gl = this.gl
    this.aWirePos = gl.getAttribLocation(prog, 'aPos')
    this.uWireProj = gl.getUniformLocation(prog, 'uProj')
    this.uWireView = gl.getUniformLocation(prog, 'uView')
    this.uWireWorld = gl.getUniformLocation(prog, 'uWorld')
    this.uWireColor = gl.getUniformLocation(prog, 'uColor')
    this.uWirePixelOffset = gl.getUniformLocation(prog, 'uPixelOffset')
  }

  // #initParticlesProgram links the COB-SFX particle program and
  // allocates the interleaved-attribute VBO the per-frame upload
  // streams into.  Layout: pos(3) + color(4) + size(1) = 8 floats
  // per particle.  Sized for an initial capacity of 1024 particles
  // — the upload path grows the buffer if a frame ever wants more.
  #initParticlesProgram(vsSrc, fsSrc) {
    const prog = this.#linkProgram(vsSrc, fsSrc)
    this.programParticles = prog
    const gl = this.gl
    this.aPartPos = gl.getAttribLocation(prog, 'aPos')
    this.aPartColor = gl.getAttribLocation(prog, 'aColor')
    this.aPartSize = gl.getAttribLocation(prog, 'aSize')
    this.uPartProj = gl.getUniformLocation(prog, 'uProj')
    this.uPartView = gl.getUniformLocation(prog, 'uView')
    this.uPartViewport = gl.getUniformLocation(prog, 'uViewport')
    this._partCapacity = 1024
    this._partInterleaved = new Float32Array(this._partCapacity * 8)
    this._partVBO = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this._partVBO)
    gl.bufferData(gl.ARRAY_BUFFER, this._partInterleaved.byteLength, gl.DYNAMIC_DRAW)
  }

  // setParticlePool attaches a CobBinding's ParticlePool to the
  // renderer.  Per-frame the renderer ticks the pool against the
  // frame dt + uploads the alive prefix to the GPU and draws.
  // Detach by passing null when the unit changes.
  setParticlePool(pool) { this._particlePool = pool || null }

  // #renderSelectionRings draws a unit-square line-loop on the ground
  // plane per entity flagged `selected: true`.  Square scales with the
  // unit's XZ bounding-box radius + a small pad so the outline reads
  // as "this is the unit you've clicked".  The square ROTATES with
  // the unit (entity.transform.headingRad) so its near edge always
  // faces the unit's forward — a directional cue that the user has
  // selected a unit pointing this way.  GL_LINE_LOOP, single uWireWorld
  // per entity, no pixel-thickening pass (hairline by design).
  //
  // Cheap: 4 vertices × N selected units × one uniform write each.
  // For 50 units that's 200 verts, well under the cost of one main
  // pass on a single unit.
  #renderSelectionRings(entities) {
    if (!entities || !entities.length) return
    if (!this.programWire) return
    const gl = this.gl
    // Lazy-build the unit-square VBO (4 corners on the ground plane,
    // ±0.5 wu — actual unit footprint comes from per-entity scale in
    // the uWireWorld matrix).  Re-used every frame; cheap to keep
    // resident.
    if (!this._selRingVBO) {
      const v = new Float32Array([
        -0.5, 0, -0.5,
         0.5, 0, -0.5,
         0.5, 0,  0.5,
        -0.5, 0,  0.5,
      ])
      this._selRingVBO = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, this._selRingVBO)
      gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW)
    }
    // Identify selected, non-ghost entries.  Skip the work entirely
    // when none match — avoids program switch + buffer bind for the
    // common "no selection" case.
    let count = 0
    for (const ent of entities) {
      if (ent.selected && !ent.ghost) count++
    }
    if (count === 0) return
    gl.useProgram(this.programWire)
    gl.uniformMatrix4fv(this.uWireProj, false, this.camera.projMatrix)
    gl.uniformMatrix4fv(this.uWireView, false, this.camera.viewMatrix)
    gl.uniform2f(this.uWirePixelOffset, 0, 0)
    // ARM-green hairline.  Slight transparency keeps the ring from
    // drowning out the unit underneath; depth still on so taller
    // foreground geometry (cliffs, other units) properly occludes.
    gl.uniform4f(this.uWireColor, 0.25, 1.0, 0.40, 0.95)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._selRingVBO)
    gl.enableVertexAttribArray(this.aWirePos)
    gl.vertexAttribPointer(this.aWirePos, 3, gl.FLOAT, false, 0, 0)
    // Reusable scratch matrix — populated per-entity by ring math.
    if (!this._selRingMat) this._selRingMat = Mat4.identity(Mat4.create())
    const mat = this._selRingMat
    for (const ent of entities) {
      if (!ent.selected || ent.ghost) continue
      const t = ent.transform || { x: 0, y: 0, z: 0, headingRad: 0 }
      // Ring radius — derived from the model's XZ bounding box plus
      // a small absolute pad so even tiny units (PeeWees) get a
      // visible ring instead of a single pixel.  Falls back to a
      // sensible default when the model has no bounds yet.
      const b = ent.model && ent.model.bounds
      let radius = 12
      if (b && b.min && b.max) {
        const dx = b.max[0] - b.min[0]
        const dz = b.max[2] - b.min[2]
        radius = 0.5 * Math.max(dx, dz) + 4
      }
      // World matrix built inline as translate × rotateY × scale.
      // Column-major layout (glMatrix convention): the upper-left 3×3
      // holds rotateY composed with non-uniform scale (2r on X/Z, 1
      // on Y so the ground square keeps height 0); the last column
      // holds the world-space translation.  Y nudged slightly above
      // the ground plane so the line clears the grid texture without
      // z-fighting.  Mat4 doesn't ship a scale() helper, and chaining
      // identity → translate → rotateY → manual-scale would duplicate
      // matrix multiplies for what amounts to four scalar writes —
      // worth inlining at the cost of one comment block.
      const heading = +t.headingRad || 0
      const s = Math.sin(heading), c = Math.cos(heading)
      const r2 = radius * 2
      mat[0] =  c * r2; mat[1] = 0;  mat[2]  = -s * r2; mat[3]  = 0
      mat[4] =  0;      mat[5] = 1;  mat[6]  =  0;      mat[7]  = 0
      mat[8] =  s * r2; mat[9] = 0;  mat[10] =  c * r2; mat[11] = 0
      mat[12] = +t.x || 0; mat[13] = 0.25; mat[14] = +t.z || 0; mat[15] = 1
      gl.uniformMatrix4fv(this.uWireWorld, false, mat)
      gl.drawArrays(gl.LINE_LOOP, 0, 4)
    }
  }

  // #renderParticles emits the alive prefix of the pool as a single
  // additive-blended GL_POINTS draw.  Called after the main scene
  // pass so particles composite over the unit/ground.  Skipped when
  // no pool is bound or it's empty.
  #renderParticles() {
    const pool = this._particlePool
    if (!pool || pool.count === 0 || !this.programParticles) return
    const gl = this.gl
    // Grow the interleaved buffer if the pool overflowed our capacity.
    if (pool.count > this._partCapacity) {
      while (this._partCapacity < pool.count) this._partCapacity *= 2
      this._partInterleaved = new Float32Array(this._partCapacity * 8)
      gl.bindBuffer(gl.ARRAY_BUFFER, this._partVBO)
      gl.bufferData(gl.ARRAY_BUFFER, this._partInterleaved.byteLength, gl.DYNAMIC_DRAW)
    }
    // Pack alive particles into the interleaved layout the shader
    // attributes expect: [px, py, pz, r, g, b, a, size] × N.
    const data = this._partInterleaved
    for (let i = 0; i < pool.count; i++) {
      const o = i * 8
      data[o + 0] = pool.x[i]
      data[o + 1] = pool.y[i]
      data[o + 2] = pool.z[i]
      data[o + 3] = pool.r[i]
      data[o + 4] = pool.g[i]
      data[o + 5] = pool.b[i]
      data[o + 6] = pool.a[i]
      data[o + 7] = pool.size[i]
    }
    gl.useProgram(this.programParticles)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._partVBO)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, pool.count * 8))
    const STRIDE = 8 * 4
    gl.enableVertexAttribArray(this.aPartPos)
    gl.vertexAttribPointer(this.aPartPos, 3, gl.FLOAT, false, STRIDE, 0)
    gl.enableVertexAttribArray(this.aPartColor)
    gl.vertexAttribPointer(this.aPartColor, 4, gl.FLOAT, false, STRIDE, 3 * 4)
    gl.enableVertexAttribArray(this.aPartSize)
    gl.vertexAttribPointer(this.aPartSize, 1, gl.FLOAT, false, STRIDE, 7 * 4)
    gl.uniformMatrix4fv(this.uPartProj, false, this.camera.projMatrix)
    gl.uniformMatrix4fv(this.uPartView, false, this.camera.viewMatrix)
    gl.uniform2f(this.uPartViewport, gl.drawingBufferWidth, gl.drawingBufferHeight)
    // Premultiplied-alpha additive blend: src * 1 + dst * 1.
    // The shader already pre-multiplies colour by alpha (colour-
    // values stay >1 for bright effects so they self-clamp at the
    // tone-map).  Switching from SRC_ALPHA / ONE_MINUS_SRC_ALPHA
    // means smoke puffs no longer OCCLUDE the bright projectile
    // and beam particles behind them — lasers / d-gun / sparks
    // shine through clouds the way they do in the original game.
    // Smoke colour values are < 1 so its additive contribution
    // just hazes the background slightly instead of going opaque.
    // Depth test stays on, depth write OFF so particles don't
    // pollute the depth buffer (would interfere with DoF post-FX).
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE)
    gl.depthMask(false)
    gl.drawArrays(gl.POINTS, 0, pool.count)
    gl.depthMask(true)
    // Reset to the studio's default alpha blend so anything drawn
    // after this pass (currently nothing, but defensive in case the
    // pipeline gains a post-pass) starts from a known state.
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  }

  // #initDoFProgram links the post-process DoF program + sets up the
  // shared full-screen quad VBO it draws into.  The scene FBO is
  // (re)allocated per-frame because the canvas size can change with
  // window resizes — see #ensureSceneFBO.
  #initDoFProgram(vsSrc, fsSrc) {
    const prog = this.#linkProgram(vsSrc, fsSrc)
    this.programDoF = prog
    const gl = this.gl
    this.aDoFPos = gl.getAttribLocation(prog, 'aPos')
    this.uDoFScene = gl.getUniformLocation(prog, 'uScene')
    this.uDoFSceneDepth = gl.getUniformLocation(prog, 'uSceneDepth')
    this.uDoFTexel = gl.getUniformLocation(prog, 'uTexel')
    this.uDoFFocalDepth = gl.getUniformLocation(prog, 'uFocalDepth')
    this.uDoFFocalRange = gl.getUniformLocation(prog, 'uFocalRange')
    this.uDoFMaxBlur = gl.getUniformLocation(prog, 'uMaxBlur')
    this.uDoFEnabled = gl.getUniformLocation(prog, 'uEnabled')
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, 1, 1,
      -1, -1, 1, 1, -1, 1,
    ]), gl.STATIC_DRAW)
    this._dofVBO = buf
  }

  // #ensureSceneFBO (re)allocates the scene colour + depth attachments
  // when the canvas dimensions change.  No-op when sized correctly.
  // Returns false when the FBO can't be created (no depth-texture
  // extension, no GL state) so callers can skip the DoF pass.
  #ensureSceneFBO() {
    if (!this._depthExt || !this.programDoF) return false
    const gl = this.gl
    const w = gl.drawingBufferWidth | 0
    const h = gl.drawingBufferHeight | 0
    if (w <= 0 || h <= 0) return false
    if (this._sceneFBO && this._sceneW === w && this._sceneH === h) return true
    if (this._sceneFBO) gl.deleteFramebuffer(this._sceneFBO)
    if (this._sceneColorTex) gl.deleteTexture(this._sceneColorTex)
    if (this._sceneDepthTex) gl.deleteTexture(this._sceneDepthTex)
    this._sceneFBO = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._sceneFBO)
    const color = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, color)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0)
    const depth = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, depth)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_SHORT, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0)
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(this._sceneFBO)
      gl.deleteTexture(color)
      gl.deleteTexture(depth)
      this._sceneFBO = null
      this._sceneColorTex = null
      this._sceneDepthTex = null
      return false
    }
    this._sceneColorTex = color
    this._sceneDepthTex = depth
    this._sceneW = w
    this._sceneH = h
    return true
  }

  // #compositeDoF draws the scene FBO into the default framebuffer
  // through the DoF post-process shader.  When DoF is disabled or the
  // FBO isn't ready, it does a straight copy (uEnabled=0).
  #compositeDoF() {
    const gl = this.gl
    if (!this.programDoF || !this._sceneFBO) return
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.BLEND)
    gl.useProgram(this.programDoF)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this._sceneColorTex)
    gl.uniform1i(this.uDoFScene, 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this._sceneDepthTex)
    gl.uniform1i(this.uDoFSceneDepth, 1)
    gl.uniform2f(this.uDoFTexel, 1 / this._sceneW, 1 / this._sceneH)
    gl.uniform1f(this.uDoFFocalDepth, this.dofFocalDepth)
    gl.uniform1f(this.uDoFFocalRange, this.dofFocalRange)
    gl.uniform1f(this.uDoFMaxBlur, this.dofMaxBlur)
    gl.uniform1f(this.uDoFEnabled, this.optDof ? 1 : 0)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._dofVBO)
    gl.enableVertexAttribArray(this.aDoFPos)
    gl.vertexAttribPointer(this.aDoFPos, 2, gl.FLOAT, false, 0, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
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
    // Second shadow FBO + textures for the twin-sun environment.
    // Built lazily on the same depth-texture path as the first.
    const tex2 = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex2)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT, SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const fbo2 = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo2)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex2, 0)
    const color2 = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, color2)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color2, 0)
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
      this._shadowFBO2 = fbo2
      this._shadowTex2 = tex2
      this._shadowColorTex2 = color2
    } else {
      gl.deleteFramebuffer(fbo2)
      gl.deleteTexture(tex2)
      gl.deleteTexture(color2)
    }
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
