// map-terrain.js — feed a packed map into the renderer's baked-mesh path.
//
// A `kbot pack --maps` map ships as maps/<name>.json (heights, void cells,
// tile placements, features, OTA header) plus two PNGs: the 32×32 tile-pool
// atlas and the authentic TNT minimap render. This helper turns that pack
// form into exactly the arguments ModelRenderer.setMapTerrain() takes —
// compositing the full ground texture from the tile atlas on a canvas —
// so a driver renders real terrain with one call:
//
//   const terrain = await loadMapTerrain(provider, 'greenhaven')
//   world.renderer.setMapTerrain(terrain)
//   world.camera.target = [terrain.startPositions[0].x, 0,
//                          terrain.startPositions[0].z]
//
// The scale constants mirror the studio sandbox so units, maps and the
// engine's height field always agree: one heightmap cell (half a TA tile)
// is 16 world units; raw height bytes scale by 0.61 world-Y per unit.

/** World units per heightmap cell (half a 32px TA tile). */
export const MAP_CELL_WU = 16

/** World-Y per raw TNT height unit — display scale only. */
export const MAP_HEIGHT_SCALE = 0.61

const TILE_PX = 32

/**
 * loadMapTerrain fetches a packed map and builds the renderer terrain
 * payload.
 *
 * @param {Object} provider  An AssetProvider with map(name) and
 *   mapTiles(name) — HttpPackProvider implements both; minimap(name) is
 *   surfaced when present.
 * @param {string} name  The map's base name (no extension).
 * @returns {Promise<{
 *   image: HTMLCanvasElement, heights: Uint8Array, w: number, h: number,
 *   cellWU: number, heightScale: number, seaLevel: number,
 *   worldW: number, worldH: number, voids: Uint8Array|null,
 *   startPositions: Array<{number: number, x: number, z: number}>,
 *   features: Array<{name: string, ax: number, ay: number}>,
 *   name: string, minimapUrl: string|null, ota: Object|null,
 * }>}
 */
export async function loadMapTerrain(provider, name) {
  if (!provider || typeof provider.map !== 'function') {
    throw new Error('loadMapTerrain: provider.map(name) is required')
  }
  const [data, pool] = await Promise.all([
    provider.map(name),
    typeof provider.mapTiles === 'function' ? provider.mapTiles(name) : null,
  ])
  if (!data) throw new Error(`loadMapTerrain: map ${name} not found`)

  // Heightmap cells: one per TNT attribute cell — twice the tile grid on
  // each axis. heights[] in the pack is row-major ints in that grid.
  const w = data.tileW * 2
  const h = data.tileH * 2
  const heights = new Uint8Array(w * h)
  const srcHeights = data.heights || []
  for (let i = 0; i < heights.length && i < srcHeights.length; i++) {
    heights[i] = srcHeights[i]
  }
  let voids = null
  if (Array.isArray(data.voids) && data.voids.some((v) => v)) {
    voids = new Uint8Array(w * h)
    for (let i = 0; i < voids.length && i < data.voids.length; i++) {
      voids[i] = data.voids[i] ? 1 : 0
    }
  }

  // Full ground texture: blit each placed tile out of the pool atlas.
  const canvas = document.createElement('canvas')
  canvas.width = data.tileW * TILE_PX
  canvas.height = data.tileH * TILE_PX
  const cx = canvas.getContext('2d')
  if (pool) {
    const tiles = data.tiles || []
    for (let ty = 0; ty < data.tileH; ty++) {
      for (let tx = 0; tx < data.tileW; tx++) {
        const t = tiles[ty * data.tileW + tx]
        if (!t) continue
        cx.drawImage(
          pool,
          t.sx * TILE_PX, t.sy * TILE_PX, TILE_PX, TILE_PX,
          tx * TILE_PX, ty * TILE_PX, TILE_PX, TILE_PX,
        )
      }
    }
  }

  // Sea level: the OTA's value wins when it carries one (TNT headers are
  // occasionally stale); start positions come from the first schema.
  let seaLevel = data.seaLevel | 0
  const ota = data.ota || null
  if (ota && ota.seaLevel > 0) seaLevel = ota.seaLevel
  // Planet keyword from the OTA GlobalHeader (e.g. "Acid", "Green", "Lava",
  // "Metal", "Moon", "Desert"). Drives the auto-selected sky/environment when
  // the caller didn't pin one (see planetEnvironment / create-world setTerrain).
  // Accept a normalised `planet` or the raw header field, and fall back to the
  // lavaworld flag so a lava map still reads hot even without a planet string.
  let planet = (ota && (ota.planet || ota.Planet)) || null
  if (!planet && ota && (ota.lavaworld === 1 || ota.lavaworld === '1' || ota.lavaWorld)) {
    planet = 'Lava'
  }
  const startPositions = []
  if (ota && Array.isArray(ota.schemas) && ota.schemas.length) {
    for (const sp of ota.schemas[0].startPositions || []) {
      // OTA start positions are map pixels; 1 px = 1 world unit.
      startPositions.push({ number: sp.number, x: sp.x, z: sp.z })
    }
  }

  return {
    image: canvas,
    heights,
    w,
    h,
    cellWU: MAP_CELL_WU,
    heightScale: MAP_HEIGHT_SCALE,
    seaLevel,
    worldW: w * MAP_CELL_WU,
    worldH: h * MAP_CELL_WU,
    voids,
    startPositions,
    features: data.features || [],
    name: data.name || name,
    planet,
    minimapUrl: typeof provider.minimap === 'function' ? provider.minimap(name) : null,
    ota,
  }
}

// planetEnvironment maps a TA OTA "planet" keyword to one of the renderer's
// ENVIRONMENT_PRESETS keys, so an installed battlefield can auto-pick a
// map-appropriate sky/cloud layer when the caller didn't pin an environment.
// Returns null for an unknown/empty planet so callers keep their default.
export function planetEnvironment(planet) {
  const p = String(planet || '').toLowerCase()
  if (!p) return null
  if (/lava|inferno|volcan|hell/.test(p)) return 'lava'
  if (/acid|marsh|swamp|bog/.test(p)) return 'marsh'
  if (/metal|urban|industr/.test(p)) return 'metal'
  if (/moon|luna/.test(p)) return 'moon'
  if (/mars|red/.test(p)) return 'mars'
  if (/desert|sand|dune|arid/.test(p)) return 'desert'
  if (/slate|rock|barren|ash/.test(p)) return 'slate'
  if (/archipel|water|ocean|sea|tropic/.test(p)) return 'archipelago'
  if (/green|earth|forest|grass|temperate/.test(p)) return 'greenworld'
  return null
}
