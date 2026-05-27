// exports.js
//
// All the "download this map as a PNG" handlers, plus the
// reverse pathway (import a heightmap PNG back into
// state.heights).
//
// Three flavours of export:
//   - Pure client-side: exportHeightmap, exportMinimap.  Render
//     directly from state into a hidden canvas, blob it out.
//   - Server-side rendered: exportFullRender, exportMapImage,
//     exportBuildmap, exportVoidmap.  POST the saved payload to
//     one of the /api/studio/export-* endpoints; the server
//     returns the rendered PNG.
//   - Imports: onImportHeightmapFile decodes an uploaded PNG
//     and writes its luminance into state.heights, wrapped in
//     an undo transaction.
//
// confirmLargeRender warns the user before kicking off a 1:1
// full-render of a giant map — those can chew memory and produce
// huge PNG files.

import { state, $, clamp, setStatus, sanitiseFilename, hostCallbacks } from '../host-context.js'
import { beginTransaction, commitTransaction } from './undo.js'
import { buildSavePayload } from './save-payload.js'

export function exportHeightmap() {
  const attrW = state.tileW * 2
  const attrH = state.tileH * 2
  const c = document.createElement('canvas')
  c.width = attrW; c.height = attrH
  const ctx = c.getContext('2d')
  const img = ctx.createImageData(attrW, attrH)
  for (let i = 0; i < attrW * attrH; i++) {
    const h = clamp(state.heights[i] | 0, 0, 255)
    img.data[i * 4 + 0] = h
    img.data[i * 4 + 1] = h
    img.data[i * 4 + 2] = h
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  c.toBlob((blob) => {
    if (!blob) { setStatus('Heightmap export failed.'); return }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${sanitiseFilename(state.name)}-heightmap.png`
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
    setStatus(`Exported ${attrW}×${attrH} heightmap PNG.`)
  }, 'image/png')
}

export function exportMinimap() {
  // Ensure the visible minimap canvas is in sync with the latest
  // map state before exporting — renderMinimap is idempotent, so
  // re-running it here is cheap and avoids exporting a stale
  // frame.
  hostCallbacks.renderMinimap?.()
  const mini = $('#minimap')
  if (!mini) { setStatus('Minimap not available to export.'); return }
  mini.toBlob((blob) => {
    if (!blob) { setStatus('Minimap export failed.'); return }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${sanitiseFilename(state.name)}-minimap.png`
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
    setStatus(`Exported ${mini.width}×${mini.height} minimap PNG.`)
  }, 'image/png')
}

// exportFromBackend POSTs the current map state to one of the
// /api/studio/export-* endpoints and triggers a download of the
// returned PNG.  The endpoints share their request shape with
// /api/studio/save (saveRequest), so we can reuse
// buildSavePayload() for all of them — same data, three
// different renderers on the server side.
async function exportFromBackend(endpoint, suffix, label) {
  setStatus(`Rendering ${label}…`)
  try {
    const resp = await fetch(`/api/studio/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildSavePayload()),
    })
    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(text || `HTTP ${resp.status}`)
    }
    const blob = await resp.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${sanitiseFilename(state.name)}-${suffix}.png`
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
    setStatus(`Exported ${label} PNG.`)
  } catch (err) {
    setStatus(`${label} export failed: ${err.message || err}`)
  }
}

// confirmLargeRender warns the user that a 1:1 PNG render of a
// big map could chew memory and produce a huge file.  Shared by
// both the full render (with features + markers) and the bare
// map image — both ship the same per-pixel payload, only their
// compositing differs.
function confirmLargeRender(label) {
  const pxW = state.tileW * 32
  const pxH = state.tileH * 32
  if (pxW * pxH > 6000 * 6000) {
    const ok = window.confirm(
      `${label} is ${pxW}×${pxH} pixels.  This can take a while and the PNG file may be very large.  Continue?`,
    )
    if (!ok) { setStatus(`${label} cancelled.`); return false }
  }
  return true
}

export function exportFullRender() {
  if (!confirmLargeRender('Full render')) return
  exportFromBackend('export-render', 'render', 'full render')
}

export function exportMapImage() {
  if (!confirmLargeRender('Map image')) return
  exportFromBackend('export-map-image', 'map', 'map image')
}

export function exportBuildmap() {
  exportFromBackend('export-buildmap', 'buildmap', 'buildmap')
}

export function exportVoidmap() {
  exportFromBackend('export-voidmap', 'voidmap', 'voidmap')
}

export async function onImportHeightmapFile(e) {
  const file = e.target.files && e.target.files[0]
  e.target.value = ''
  if (!file) return
  const attrW = state.tileW * 2
  const attrH = state.tileH * 2
  const img = new Image()
  const url = URL.createObjectURL(file)
  try {
    await new Promise((resolve, reject) => {
      img.onload = resolve
      img.onerror = () => reject(new Error('decode failed'))
      img.src = url
    })
    const c = document.createElement('canvas')
    c.width = attrW; c.height = attrH
    const ctx = c.getContext('2d')
    // Nearest-neighbour-ish: disable smoothing so a same-size
    // import is exact, and a different-size import is sampled
    // rather than blurred.
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(img, 0, 0, attrW, attrH)
    const data = ctx.getImageData(0, 0, attrW, attrH).data
    beginTransaction()
    for (let i = 0; i < attrW * attrH; i++) {
      // Use luminance so colour PNGs still produce sensible heights.
      const r = data[i * 4 + 0]
      const g = data[i * 4 + 1]
      const b = data[i * 4 + 2]
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) | 0
      state.heights[i] = clamp(lum, 0, 255)
    }
    commitTransaction('Import heightmap')
    hostCallbacks.renderCanvas?.()
    setStatus(`Imported heightmap from ${file.name} (${img.naturalWidth}×${img.naturalHeight} → ${attrW}×${attrH}).`)
  } catch (err) {
    setStatus(`Heightmap import failed: ${err.message}`)
  } finally {
    URL.revokeObjectURL(url)
  }
}
