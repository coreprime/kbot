// worlds.js
//
// World / environment scene definitions, authored as the editable JSON
// files under worlds/.  Each <key>.json describes one world: its sky
// (gradient + sun colours + positions + clouds), the unit key-light colour +
// direction, terrain tileset, water column, seabed, mountains, and gravity.
// Dropping a new JSON in that folder and appending its key to manifest.json
// adds a world — no code change needed.  scripts/gen-assets.mjs embeds the
// JSON into generated/world-data.js at package-build time so the published
// renderer carries its worlds with it (no host asset routes).
//
// The renderer imports the three preset maps below by reference and consumes
// them exactly as it did the old inline tables, so all existing call sites
// keep working:
//   * SKY_PRESETS[skyKey]        — gradient + sun1/sun2 + clouds (sky shader)
//   * ENVIRONMENT_PRESETS[key]   — lightDir/lightColor + water + seabed +
//                                  mountains + terrainTileset + sky pointer
//   * GRAVITY_BY_ENV[key]        — ballistic-solver world gravity
//
// loadWorlds() fetches every world once (cached promise) and fills the maps
// in place.  A minimal Greenworld/earth pair is seeded synchronously so the
// renderer can construct + draw its first frame before the fetch resolves.

export const GRAVITY_EARTH = 80

// Mutable maps — filled by loadWorlds(), seeded below so they're never empty.
export const SKY_PRESETS = {}
export const ENVIRONMENT_PRESETS = {}
export const GRAVITY_BY_ENV = {}
// UI list (picker order + labels), filled in manifest order by loadWorlds().
export const WORLD_LIST = []

// _toSky / _toEnv reshape a loaded world record into the two map entries the
// renderer expects.  sun2 = null collapses to the zero-colour disc the sky +
// scene-lighting passes treat as "no second sun".
function _toSky(w) {
  const s = w.sky || {}
  const out = {
    name: w.name,
    zenith: s.zenith,
    horizon: s.horizon,
    sun1: s.sun1,
    sun2: s.sun2 || { color: [0, 0, 0], dir: [0, 1, 0], size: 0 },
    cloudColor: s.cloudColor,
    cloudShadow: s.cloudShadow,
    cloudCoverage: s.cloudCoverage,
    cloudDensity: s.cloudDensity,
    cloudSpeed: s.cloudSpeed,
  }
  if (s.zenith2) out.zenith2 = s.zenith2
  return out
}
function _toEnv(w) {
  return {
    name: w.name,
    sky: w.skyKey,
    terrainTileset: w.terrainTileset,
    lightDir: w.lightDir,
    lightColor: w.lightColor,           // unit key-light tint — drives unit/scenery hue
    waterShallow: w.water.shallow,
    waterMid: w.water.mid,
    waterDeep: w.water.deep,
    waterTranslucency: w.water.translucency,
    seabedSand: w.seabed.sand,
    seabedRock: w.seabed.rock,
    seabedCaustic: w.seabed.caustic,
    mountainStyle: w.mountain.style,
    mountainHeight: w.mountain.height,
    mountainScale: w.mountain.scale,
    mountainBase: w.mountain.base,
    mountainPeak: w.mountain.peak,
    mountainGloss: w.mountain.gloss,
  }
}

function _install(w) {
  SKY_PRESETS[w.skyKey] = _toSky(w)
  ENVIRONMENT_PRESETS[w.key] = _toEnv(w)
  GRAVITY_BY_ENV[w.key] = (typeof w.gravity === 'number') ? w.gravity : GRAVITY_EARTH
}

// Synchronous bootstrap so SKY_PRESETS.earth + ENVIRONMENT_PRESETS.greenworld
// exist the instant the module loads (the renderer reads them in its
// constructor).  loadWorlds() overwrites these with the file copy + adds the
// rest.
_install({
  key: 'greenworld', skyKey: 'earth', name: 'Greenworld', gravity: 80,
  terrainTileset: 'greenworld',
  lightDir: [-0.55, 0.90, 0.45], lightColor: [1.55, 1.48, 1.32],
  sky: {
    zenith: [0.18, 0.42, 0.85], zenith2: [0.18, 0.42, 0.85], horizon: [0.78, 0.86, 0.95],
    sun1: { color: [2.40, 1.95, 1.30], dir: [-0.45, 0.35, -0.85], size: 0.040 }, sun2: null,
    cloudColor: [1.20, 1.18, 1.15], cloudShadow: [0.45, 0.55, 0.70],
    cloudCoverage: 0.78, cloudDensity: 0.95, cloudSpeed: 0.012,
  },
  water: { shallow: [0.10, 0.40, 0.72], mid: [0.04, 0.18, 0.45], deep: [0.01, 0.05, 0.20], translucency: 0.95 },
  seabed: { sand: [0.25, 0.32, 0.30], rock: [0.14, 0.18, 0.18], caustic: [0.35, 0.65, 0.95] },
  mountain: { style: 0, height: 62, scale: 1.0, base: [0.28, 0.32, 0.22], peak: [0.72, 0.78, 0.80], gloss: 0.0 },
})

let _loaded = null

// loadWorlds — install the embedded manifest + world data into the preset
// maps once.  Still async-shaped (callers were written against the fetching
// loader); returns a cached promise, safe to await repeatedly.  On any
// malformed world it resolves anyway (leaving the synchronous seed in
// place) so a bad file degrades to "only Greenworld" rather than a blank
// renderer.
export function loadWorlds() {
  if (_loaded) return _loaded
  _loaded = (async () => {
    try {
      const { WORLDS_MANIFEST, WORLD_DATA } = await import('./generated/world-data.js')
      WORLD_LIST.length = 0
      for (const m of WORLDS_MANIFEST.worlds) {
        const w = WORLD_DATA[m.key]
        if (w) _install(w)
        WORLD_LIST.push({ env: m.key, icon: m.icon, label: m.name, title: m.title })
      }
    } catch (e) {
      console.warn('[worlds] load failed, using Greenworld only:', e)
    }
  })()
  return _loaded
}
