// dev-stats.js
//
// Developer stats panel + matching Developer dialog — the
// distinct-tile count / distinct-feature count / total-feature count
// widget that lives next to the minimap, plus the Advanced ▸
// Developer dialog that surfaces the same numbers alongside a
// thumbnail grid of every distinct tile stamp and a Camera & Canvas
// diagnostics tab.
//
// Recomputes are gated on the shared contentVersion counter so
// scroll / hover / drag don't re-walk the whole tiles + features
// arrays; the dialog open() path force-refreshes so the tile grid
// stays accurate even when content hasn't changed.
//
// Cross-module deps via hostCallbacks:
//   - whenImageReady(img, kind, cb) — register a one-shot redraw
//     when an in-flight section atlas finishes decoding (for the
//     "?" placeholder cell in the dialog grid).

import { state, $, hostCallbacks, getReactUi } from '../host-context.js'
import { TILE_PX } from './constants.js'
import { getContentVersion } from './content-cache.js'
import { overscrollPadding } from './zoom-pan.js'
import { visibleTileBounds, visiblePixelBounds } from './viewport.js'
import { ensureGLRenderer, drawTransformedTile } from './canvas/webgl.js'
import { persistPanelCollapsed, makePanelDraggable } from '../common/panel-layout.js'

// distinctTileKey identifies a stamp's visible appearance — the
// source tile (sectionPath, sx, sy) and the rotation/flip applied to
// it.  This matches what builder.go bakes into the saved TNT's tile
// pool.
function distinctTileKey(stamp) {
  if (!stamp || !stamp.sectionPath) return null
  return `${stamp.sectionPath}|${stamp.sx}|${stamp.sy}|${stamp.rotation || 0}|${stamp.flipH ? 1 : 0}|${stamp.flipV ? 1 : 0}`
}

function computeDevStats() {
  const tileKeys = new Map() // key → { stamp, count }
  let occupied = 0
  for (const stamp of state.tiles || []) {
    const k = distinctTileKey(stamp)
    if (!k) continue
    occupied++
    const entry = tileKeys.get(k)
    if (entry) entry.count++
    else tileKeys.set(k, { stamp, count: 1 })
  }
  const featureNames = new Set()
  for (const f of state.features || []) {
    featureNames.add((f.name || '').toLowerCase())
  }
  const sectionPaths = new Set()
  for (const v of tileKeys.values()) sectionPaths.add(v.stamp.sectionPath)
  const total = (state.tileW || 0) * (state.tileH || 0)
  const compression = (occupied > 0) ? (occupied / tileKeys.size) : 0
  return {
    distinctTiles: tileKeys.size,
    distinctFeatures: featureNames.size,
    totalFeatures: (state.features || []).length,
    sectionsUsed: sectionPaths.size,
    occupiedTiles: occupied,
    totalTiles: total,
    compressionRatio: compression,
    tileEntries: tileKeys, // for the dialog grid
  }
}

let devStatsRefreshQueued = false
let lastDevStatsVersion = -1

// scheduleDevStatsRefresh defers a refresh to the next animation
// frame, no-oping when the underlying contentVersion hasn't ticked
// since the previous refresh.  Hot per-frame callers (renderCanvas,
// scroll handlers) can fire this freely.
export function scheduleDevStatsRefresh() {
  if (lastDevStatsVersion === getContentVersion()) return
  if (devStatsRefreshQueued) return
  devStatsRefreshQueued = true
  requestAnimationFrame(() => {
    devStatsRefreshQueued = false
    lastDevStatsVersion = getContentVersion()
    refreshDevStats()
  })
}

// devStatsCache memoises the last computeDevStats result and the
// content-version it was built for.  On a 256×256 map with thousands
// of features computeDevStats is the heaviest per-render work; gating
// it on contentVersion keeps scroll/hover from recomputing.
let devStatsCache = null
let devStatsCacheVersion = -1
function getDevStats() {
  if (devStatsCache && devStatsCacheVersion === getContentVersion()) return devStatsCache
  devStatsCache = computeDevStats()
  devStatsCacheVersion = getContentVersion()
  return devStatsCache
}

export function refreshDevStats() {
  const dlgOpen = !$('#developer-dialog')?.classList.contains('hidden')
  // Skip the full compute when content hasn't changed AND the dialog
  // isn't open (its tile grid is the only reader that NEEDS the live
  // tileEntries map; the panel just shows the three counts).
  const stats = getDevStats()
  // Publish to the React Map Stats panel via the inspector store.
  const ui = getReactUi()
  if (ui && typeof ui.publishMapStats === 'function') {
    ui.publishMapStats(stats)
  }
  const set = (id, v) => { const el = $('#' + id); if (el) el.textContent = String(v) }
  // Legacy DOM lookup retained for the Developer dialog's table cells
  // — those still live inside the dev-dialog markup and want refresh
  // via the same compute call.
  set('dev-stats-distinct-tiles', stats.distinctTiles)
  set('dev-stats-distinct-features', stats.distinctFeatures)
  set('dev-stats-total-features', stats.totalFeatures)
  if (dlgOpen) {
    set('dev-dlg-distinct-tiles', stats.distinctTiles)
    set('dev-dlg-sections-used', stats.sectionsUsed)
    set('dev-dlg-occupied', `${stats.occupiedTiles} / ${stats.totalTiles}`)
    set('dev-dlg-compression', stats.compressionRatio > 0 ? `${stats.compressionRatio.toFixed(2)}×` : '—')
    renderDevTilesGrid(stats.tileEntries)
    renderDevDiagnostics()
  }
}

// renderDevDiagnostics fills the Camera & Canvas tab with live
// numbers pulled straight from the rendering DOM so the user can
// see exactly what state the renderer is reading.  Read-only —
// purely for debugging.
function renderDevDiagnostics() {
  const tbody = $('#dev-diag-table tbody')
  if (!tbody) return
  const canvas = $('#canvas')
  const glCanvas = $('#canvas-gl')
  const wrap = $('#canvas-scroll')
  const stack = $('#canvas-stack')
  const num = (v) => (v == null ? '—' : `${v}`)
  const tb = visibleTileBounds()
  const vp = visiblePixelBounds()
  const rows = [
    ['Mode', state.mode || '—'],
    ['View mode', state.viewMode || '—'],
    ['Zoom', `${(state.zoom * 100).toFixed(1)}%  (raw ${state.zoom.toFixed(4)})`],
    ['Map size (tiles)', `${state.tileW} × ${state.tileH}  (attr ${state.tileW * 2} × ${state.tileH * 2})`],
    ['Map size (game-px)', `${state.tileW * TILE_PX} × ${state.tileH * TILE_PX}`],
    ['2D canvas backing buffer', canvas ? `${canvas.width} × ${canvas.height}` : '—'],
    ['2D canvas CSS size', canvas ? `${parseFloat(canvas.style.width || 0).toFixed(1)} × ${parseFloat(canvas.style.height || 0).toFixed(1)}` : '—'],
    ['GL canvas backing buffer', glCanvas ? `${glCanvas.width} × ${glCanvas.height}` : '—'],
    ['GL canvas CSS size', glCanvas ? `${parseFloat(glCanvas.style.width || 0).toFixed(1)} × ${parseFloat(glCanvas.style.height || 0).toFixed(1)}` : '—'],
    ['Scroll viewport (canvas-scroll)', wrap ? `${wrap.clientWidth} × ${wrap.clientHeight}` : '—'],
    ['Scroll position', wrap ? `(${wrap.scrollLeft}, ${wrap.scrollTop})` : '—'],
    ['Stack size (canvas-stack)', stack ? `${parseFloat(stack.style.width || 0).toFixed(0)} × ${parseFloat(stack.style.height || 0).toFixed(0)}` : '—'],
    ['Overscroll padding', `(${overscrollPadding.x}, ${overscrollPadding.y})`],
    ['Canvas offset (left, top)', canvas ? `(${parseFloat(canvas.style.left || 0).toFixed(0)}, ${parseFloat(canvas.style.top || 0).toFixed(0)})` : '—'],
    ['Visible tile bounds', tb ? `tx [${tb.minTX}..${tb.maxTX}]  ty [${tb.minTY}..${tb.maxTY}]` : '—'],
    ['Visible pixel bounds', vp ? `x [${vp.minX}..${vp.maxX}]  y [${vp.minY}..${vp.maxY}]` : '—'],
    ['Content version', num(getContentVersion())],
    ['Tile / feature counts', `${(state.tiles || []).filter(Boolean).length} tile cells • ${(state.features || []).length} features`],
    ['Renderer', ensureGLRenderer() ? 'WebGL2 (tiles+features)' : '2D fallback'],
    ['devicePixelRatio', String(window.devicePixelRatio || 1)],
  ]
  // Re-build the table contents from scratch — small enough that
  // the cost is negligible and avoids per-row id juggling.
  tbody.replaceChildren(...rows.map(([label, value]) => {
    const tr = document.createElement('tr')
    const th = document.createElement('th'); th.textContent = label
    const td = document.createElement('td'); td.textContent = value
    tr.appendChild(th); tr.appendChild(td)
    return tr
  }))
}

// renderDevTilesGrid paints a thumbnail per distinct tile +
// occurrence count.  Each thumbnail is a tiny canvas that copies
// the right 32x32 region of the source section image and applies
// the same rotation / flip the stamp uses — so the user sees the
// tile exactly as it appears on the map.
function renderDevTilesGrid(tileEntries) {
  const grid = $('#dev-tiles-grid')
  if (!grid) return
  // Sort by descending count so the most-used tiles show first.
  const rows = Array.from(tileEntries.values()).sort((a, b) => b.count - a.count)
  const frag = document.createDocumentFragment()
  for (const { stamp, count } of rows) {
    const cell = document.createElement('div')
    cell.className = 'dev-tile-cell'
    const cnv = document.createElement('canvas')
    cnv.width = 32; cnv.height = 32
    cnv.style.width = '56px'
    cnv.style.height = '56px'
    cnv.style.imageRendering = 'pixelated'
    const cctx = cnv.getContext('2d')
    cctx.imageSmoothingEnabled = false
    const img = state.sectionImages.get(stamp.sectionPath)
    if (img && img.complete && img.naturalWidth > 0) {
      drawTransformedTile(cctx, img, stamp.sx, stamp.sy, stamp.rotation || 0, !!stamp.flipH, !!stamp.flipV, 0, 0)
    } else {
      cctx.fillStyle = '#3a4d61'
      cctx.fillRect(0, 0, 32, 32)
      hostCallbacks.whenImageReady?.(img, 'dev-stats', refreshDevStats)
    }
    cell.appendChild(cnv)
    const tag = document.createElement('div')
    tag.className = 'dev-tile-count'
    tag.textContent = String(count)
    cell.appendChild(tag)
    cell.title = `${stamp.sectionPath} · (${stamp.sx},${stamp.sy})  rot=${stamp.rotation || 0}${stamp.flipH ? ' H' : ''}${stamp.flipV ? ' V' : ''}\n${count}× on map`
    frag.appendChild(cell)
  }
  grid.replaceChildren(frag)
}

export function wireDeveloperPanel() {
  const panel = $('#dev-stats-panel')
  const toggle = $('#dev-stats-toggle')
  const header = $('#dev-stats-header')
  if (!panel || !toggle || !header) return
  toggle.addEventListener('click', () => {
    panel.classList.toggle('collapsed')
    toggle.textContent = panel.classList.contains('collapsed') ? '+' : '−'
    persistPanelCollapsed('dev-stats-panel', panel.classList.contains('collapsed'))
  })
  makePanelDraggable(panel, header)
}

export function openDeveloperDialog() {
  const dlg = $('#developer-dialog')
  if (!dlg) return
  dlg.classList.remove('hidden')
  // Default to the Distinct Tiles tab.
  const tabs = dlg.querySelectorAll('.dev-tab')
  const bodies = dlg.querySelectorAll('.dev-tab-body')
  tabs.forEach((t, i) => t.classList.toggle('active', i === 0))
  bodies.forEach((b, i) => b.classList.toggle('active', i === 0))
  refreshDevStats()
}

export function closeDeveloperDialog() {
  $('#developer-dialog')?.classList.add('hidden')
}
