// map-loader.js
//
// Sandbox battlefield support: the Map picker (The Grid, or any TNT from
// the workspace) and the load path that installs a chosen map everywhere
// it matters — the wasm sim's height field (elevation, slope/water
// movement legality, terrain-blocked shots), the renderer's draped
// terrain mesh, the mini-map's backdrop, and the camera, which jumps to
// the map's first player start.

import { hostCallbacks, setStatus } from '../host-context.js'
import { reapplyContours } from './ribbon-bridge.js'
import { simFeatureSpecs } from './map-features-sim.js'

const wsUrl = (p) => `${window.__WS_BASE__ || ''}${p}`

// loadSandboxMap fetches /api/studio/sandbox-map for the path and installs
// it on the active view. Returns the map info object. onStep(local, label)
// is an optional progress callback (local 0..1 within the map load) the
// launch loading screen drives.
export async function loadSandboxMap(view, path, onStep) {
  const step = (local, label) => { try { onStep?.(local, label) } catch { /* ignore */ } }
  step(0.04, 'Reading battlefield…')
  const res = await fetch(`/api/studio/sandbox-map?path=${encodeURIComponent(path)}`)
  if (!res.ok) throw new Error(`map load failed (${res.status})`)
  const info = await res.json()
  step(0.18, 'Building terrain…')
  const bin = atob(info.heights)
  const heights = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) heights[i] = bin.charCodeAt(i)
  let voids = null
  if (info.voids) {
    const vbin = atob(info.voids)
    voids = new Uint8Array(vbin.length)
    for (let i = 0; i < vbin.length; i++) voids[i] = vbin.charCodeAt(i)
  }

  // Sim first — the height field must be in before any unit moves on it.
  const source = view.scene?.source
  if (source?.setTerrain) {
    source.setTerrain({
      w: info.w, h: info.h,
      cellWU: info.cellWU, heightScale: info.heightScale,
      seaLevel: info.seaLevel | 0,
      // No uniform surface-metal flood: the sandbox runs the discrete
      // "extractors only on real deposits" model, so the cell-metal grid is
      // populated ONLY by metal-deposit features (pushSimResourceFeatures →
      // stampMetalPatch). With no deposit under its footprint, an extractor's
      // overlap rule refuses the plot; on one, its yield samples the stamp.
      data: heights,
      voids,
    })
    // Push the map's resource features into the sim so the build-placement
    // probe can see them: a metal deposit stamps metal into the cell grid (a
    // metal extractor founded off-metal then reads RED), and a geothermal vent
    // marks the only site a geothermal plant may be founded over. Runs AFTER
    // setTerrain so a metal patch has a cell grid to stamp. Non-fatal — a map
    // whose feature-defs fail to load still installs its terrain.
    if (source.addFeature) {
      await pushSimResourceFeatures(source, info)
    }
  }

  // Renderer: drape the full map render over a baked-height mesh. The
  // terrain composite is the heaviest fetch in the launch — first render
  // of a full TA tile map can take a beat — so it owns the bulk of the
  // map-load progress span.
  step(0.25, 'Rendering terrain…')
  // Load the composite ONCE at (near-)native resolution and keep it in memory:
  // the renderer's clipmap slices the camera's near window out of it in-process
  // for crisp near detail, so this single up-front fetch is the only server
  // touch for the ground texture. Long edge = cells×16 px, capped at the GL max.
  const srcLong = Math.min(16384, Math.max(info.w, info.h) * 16)
  const texUrl = info.textureUrl + (info.textureUrl.includes('?') ? '&' : '?') + 'max=' + srcLong
  const image = await loadImage(wsUrl(texUrl))
  const terrain = {
    image, heights,
    w: info.w, h: info.h,
    cellWU: info.cellWU, heightScale: info.heightScale,
    seaLevel: info.seaLevel | 0,
    // Placed scenery: the map's trees / rocks / metal / geo vents as
    // procedural 3D stand-ins baked at their cell centres and terrain height.
    features: Array.isArray(info.features) ? info.features : [],
  }
  // Prefer the world's high-level installer: it drapes the terrain AND bakes
  // the feature surrogates (and metal/steam decals + live vents) in one pass.
  // Fall back to the bare renderer if no world is present.
  if (view._world?.setTerrain) view._world.setTerrain(terrain)
  else view.renderer?.setMapTerrain(terrain)
  // A fresh renderer terrain starts with contours off; honour the View menu's
  // remembered choice so a ticked Contour Lines box actually shows the overlay.
  reapplyContours(view)
  step(0.85, 'Drawing mini-map…')

  // Mini-map backdrop + fixed extent.
  const minimap = await loadImage(wsUrl(info.minimapUrl)).catch(() => null)
  step(1, 'Battlefield ready.')
  // Camera (and the faction leader's spawn) at the first player start,
  // or the map centre when the OTA carries none.
  const start = (info.startPositions && info.startPositions[0])
    || { x: info.worldW / 2, z: info.worldH / 2 }
  view._sandboxMap = {
    path, name: info.name,
    worldW: info.worldW, worldH: info.worldH,
    minimapImage: minimap,
    start,
  }
  // Keep the height field on the view so click-to-ground picks can ray-march
  // against the real terrain surface (clicking a hilltop from an angle should
  // land on the hill, not on the flat y=0 plane far behind it). Matches the
  // renderer's mesh Y = heights[idx] * heightScale.
  view._terrain = {
    heights, w: info.w, h: info.h,
    cellWU: info.cellWU, heightScale: info.heightScale,
  }
  if (view.camera) {
    view.camera.target[0] = start.x
    view.camera.target[1] = 0
    view.camera.target[2] = start.z
  }
  return info
}

// clearSandboxMap reverts the view to The Grid.
export function clearSandboxMap(view) {
  view.scene?.source?.setTerrain?.(null)
  // world.setTerrain(null) also tears down the feature surrogates + vents;
  // fall back to the bare renderer clear when no world is present.
  if (view._world?.setTerrain) view._world.setTerrain(null)
  else view.renderer?.clearMapTerrain?.()
  view._sandboxMap = null
  view._terrain = null
}

// spawnFactionLeader drops the chosen faction's leader unit (commander /
// monarch) at the battlefield's player 1 start — the origin on The Grid.
export async function spawnFactionLeader(view, commander, sideIndex = 0) {
  if (!commander || !view.scene) return
  const map = view._sandboxMap
  const start = map?.start || { x: 0, z: 0 }
  // Face the action: the leader spawns looking at the map centre, and
  // the camera settles behind its shoulder looking the same way, so the
  // first thing the player sees is the direction of the battlefield.
  const cx = map ? map.worldW / 2 : 0
  const cz = map ? map.worldH / 2 : 0
  const dx = cx - start.x
  const dz = cz - start.z
  // Game heading convention: a unit at heading θ faces (-sin θ, -cos θ), so
  // facing along (dx, dz) means θ = atan2(-dx, -dz).
  const headingRad = (dx || dz) ? Math.atan2(-dx, -dz) : 0
  // Route through the view's spawn path so the local/join split is handled:
  // in a hosted match the leader round-trips a Spawn order through the
  // authority (and materializes on the next snapshot) instead of being
  // inserted into a local-only world. Falls back to a direct scene insert if
  // the view exposes no spawn helper.
  if (typeof view.spawn === 'function') {
    await view.spawn(commander, { x: start.x, z: start.z, headingRad, side: sideIndex | 0 })
  } else {
    const model = await view.loader.load(commander)
    await view.scene.addUnit({
      name: commander, model,
      x: start.x, z: start.z,
      headingRad,
      side: sideIndex | 0,
    })
  }
  if (view.camera && (dx || dz)) {
    view.camera.target = [start.x, 20, start.z]
    // Eye sits opposite the look direction: yaw such that the camera
    // looks from behind the leader toward the centre.
    view.camera.yaw = Math.atan2(-dx, -dz)
    view.camera.pitch = 32 * Math.PI / 180
    view.camera.distance = 420
  }
}

// _featureDefsCache memoizes the /api/studio/feature-defs catalogue (the id →
// featuredef table); the endpoint is session-cached server-side, but this also
// spares a second fetch when several maps load in a row.
let _featureDefsCache = null

async function fetchFeatureDefs() {
  if (_featureDefsCache) return _featureDefsCache
  try {
    const res = await fetch('/api/studio/feature-defs')
    _featureDefsCache = res.ok ? await res.json() : {}
  } catch {
    _featureDefsCache = {}
  }
  return _featureDefsCache
}

// pushSimResourceFeatures resolves each placed feature's featuredef and installs
// the metal deposits + geothermal vents into the sim via addFeature. Errors are
// swallowed per the map-load contract — a missing catalogue just leaves the sim
// without resource sites, exactly as before this plumbing existed.
async function pushSimResourceFeatures(source, info) {
  const features = Array.isArray(info.features) ? info.features : []
  if (!features.length) return
  const defs = await fetchFeatureDefs()
  const specs = simFeatureSpecs(features, defs, info.cellWU || 16)
  for (const spec of specs) source.addFeature(spec)
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`image failed: ${url}`))
    img.src = url
  })
}

// ── Picker ──────────────────────────────────────────────────────────

let _picker = null

// openSandboxMapPicker shows the battlefield list anchored near the
// Sandbox panel: The Grid first, then every map in the workspace with its
// embedded minimap as the thumbnail.
export async function openSandboxMapPicker() {
  closeSandboxMapPicker()
  const dlg = document.getElementById('model-viewer-dialog')
  const view = hostCallbacks.getActiveSandboxView?.()
  if (!dlg || !view) return
  const root = document.createElement('div')
  root.id = 'sandbox-map-picker'
  root.innerHTML = '<div class="map-picker-title">Battlefield</div><div class="map-picker-list"><div class="map-picker-loading">Loading maps…</div></div>'
  dlg.appendChild(root)
  _picker = root

  let maps = []
  try {
    const res = await fetch('/api/studio/maps')
    const data = await res.json()
    maps = data.maps || []
  } catch { /* list stays empty; The Grid still offered */ }
  if (_picker !== root) return // closed while loading

  const list = root.querySelector('.map-picker-list')
  const current = view._sandboxMap?.path || ''
  const rows = [
    `<div class="map-picker-row${current ? '' : ' active'}" data-path="">
       <span class="map-picker-thumb map-picker-grid"></span>
       <span class="map-picker-name">The Grid</span>
     </div>`,
  ]
  for (const m of maps) {
    rows.push(
      `<div class="map-picker-row${current === m.path ? ' active' : ''}" data-path="${m.path}">
         <img class="map-picker-thumb" loading="lazy" data-mini="${m.path}" alt="" />
         <span class="map-picker-name">${m.name || m.path}</span>
       </div>`,
    )
  }
  list.innerHTML = rows.join('')
  for (const img of list.querySelectorAll('img[data-mini]')) {
    img.src = `/api/studio/minimap/${img.dataset.mini}`
    img.onerror = () => { img.style.visibility = 'hidden' }
  }
  list.addEventListener('click', async (e) => {
    const row = e.target.closest('.map-picker-row')
    if (!row) return
    const path = row.dataset.path
    closeSandboxMapPicker()
    const v = hostCallbacks.getActiveSandboxView?.()
    if (!v) return
    try {
      if (!path) {
        clearSandboxMap(v)
        setStatus('Battlefield: The Grid.')
      } else {
        setStatus('Loading battlefield…')
        const info = await loadSandboxMap(v, path)
        setStatus(`Battlefield: ${info.name} — camera at player 1 start.`)
      }
    } catch (err) {
      setStatus(`Map load failed: ${err?.message || err}`)
    }
  })
  // Click-away dismiss.
  setTimeout(() => {
    const away = (e) => {
      if (_picker && !_picker.contains(e.target)) closeSandboxMapPicker()
    }
    document.addEventListener('pointerdown', away, { once: true, capture: true })
  }, 0)
}

export function closeSandboxMapPicker() {
  if (_picker) {
    _picker.remove()
    _picker = null
  }
}