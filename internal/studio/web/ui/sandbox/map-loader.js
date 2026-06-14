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
  if (view.scene?.source?.setTerrain) {
    view.scene.source.setTerrain({
      w: info.w, h: info.h,
      cellWU: info.cellWU, heightScale: info.heightScale,
      seaLevel: info.seaLevel | 0,
      // MaxSlope→delta scale for this heightmap (TA 40 / TA:K 100); the sim
      // defaults it when absent, so older payloads stay TA-calibrated.
      slopeScalePct: info.slopeScalePct | 0,
      data: heights,
      voids,
    })
  }

  // Renderer: drape the full map render over a baked-height mesh. The
  // terrain composite is the heaviest fetch in the launch — first render
  // of a full TA tile map can take a beat — so it owns the bulk of the
  // map-load progress span.
  step(0.25, 'Rendering terrain…')
  const image = await loadImage(wsUrl(info.textureUrl))
  view.renderer?.setMapTerrain({
    image, heights,
    w: info.w, h: info.h,
    cellWU: info.cellWU, heightScale: info.heightScale,
    seaLevel: info.seaLevel | 0,
  })
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
  view.renderer?.clearMapTerrain?.()
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
  const headingRad = (dx || dz) ? Math.atan2(dx, dz) : 0
  const model = await view.loader.load(commander)
  await view.scene.addUnit({
    name: commander, model,
    x: start.x, z: start.z,
    headingRad,
    side: sideIndex | 0,
  })
  if (view.camera && (dx || dz)) {
    view.camera.target = [start.x, 20, start.z]
    // Eye sits opposite the look direction: yaw such that the camera
    // looks from behind the leader toward the centre.
    view.camera.yaw = Math.atan2(-dx, -dz)
    view.camera.pitch = 32 * Math.PI / 180
    view.camera.distance = 420
  }
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