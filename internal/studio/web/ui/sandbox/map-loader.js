// map-loader.js
//
// Sandbox battlefield support: the Map picker (The Grid, or any TNT from
// the workspace) and the load path that installs a chosen map everywhere
// it matters — the wasm sim's height field (elevation, slope/water
// movement legality, terrain-blocked shots), the renderer's draped
// terrain mesh, the mini-map's backdrop, and the camera, which jumps to
// the map's first player start.

import { hostCallbacks, setStatus } from '../host-context.js'

const wsUrl = (p) => `${window.__WS_BASE__ || ''}${p}`

// loadSandboxMap fetches /api/studio/sandbox-map for the path and installs
// it on the active view. Returns the map info object.
export async function loadSandboxMap(view, path) {
  const res = await fetch(`/api/studio/sandbox-map?path=${encodeURIComponent(path)}`)
  if (!res.ok) throw new Error(`map load failed (${res.status})`)
  const info = await res.json()
  const bin = atob(info.heights)
  const heights = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) heights[i] = bin.charCodeAt(i)

  // Sim first — the height field must be in before any unit moves on it.
  if (view.scene?.source?.setTerrain) {
    view.scene.source.setTerrain({
      w: info.w, h: info.h,
      cellWU: info.cellWU, heightScale: info.heightScale,
      seaLevel: info.seaLevel | 0,
      data: heights,
    })
  }

  // Renderer: drape the full map render over a baked-height mesh.
  const image = await loadImage(wsUrl(info.textureUrl))
  view.renderer?.setMapTerrain({
    image, heights,
    w: info.w, h: info.h,
    cellWU: info.cellWU, heightScale: info.heightScale,
  })

  // Mini-map backdrop + fixed extent.
  const minimap = await loadImage(wsUrl(info.minimapUrl)).catch(() => null)
  view._sandboxMap = {
    path, name: info.name,
    worldW: info.worldW, worldH: info.worldH,
    minimapImage: minimap,
  }

  // Camera to the first player start (or the map centre).
  const start = (info.startPositions && info.startPositions[0])
    || { x: info.worldW / 2, z: info.worldH / 2 }
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