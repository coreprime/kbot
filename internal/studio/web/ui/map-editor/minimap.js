// minimap.js
//
// Floating minimap panel — a 200×200 thumbnail of the whole map plus
// optional hover-feature dots, start-position markers, and a
// viewport rectangle showing what slice of the map the user is
// currently looking at.
//
// The minimap used to copy the main canvas via drawImage on every
// render, which is slow on large maps and wrong now that the main
// canvas viewport-culls.  Instead we maintain a separate offscreen
// "base" canvas at one-pixel-per-tile resolution that's only
// rebuilt when tile data changes (`minimapBaseStale`); rendering
// the visible minimap is then a single drawImage from this small
// cached canvas plus the dot / start-pos / viewport overlays.
//
// patchMinimapTile / invalidateMinimapBase let callers commit
// in-place tile edits without forcing a full rebuild — stamp + erase
// patch the single pixel, structural edits (paste, load, resize,
// undo) blow away the whole base.
//
// Cross-module deps via hostCallbacks:
//   - whenImageReady(img, kind, cb) — register a one-shot redraw
//     when an in-flight section atlas finally decodes.  Without
//     this, freshly-stamped tiles would stay grey in the minimap
//     until the user happened to repaint for some other reason.
//   - featureAnchorWorld(feature) — projects a feature's attribute-
//     grid coords to world-pixel space.  Used for the hover dots.
//   - scheduleMinimapRender() — rAF-batched repaint, called after
//     a single-pixel patch so the panel reflects the edit on the
//     next frame.

import { state, $, clamp, hostCallbacks } from '../host-context.js'
import { TILE_PX, VOID_COLOR, FEATURE_HIGHLIGHT_LIMIT, TAK_TERRAIN_KEY } from './constants.js'
import { overscrollPadding } from './zoom-pan.js'
import { bumpContentVersion, getFeaturesByName } from './content-cache.js'

export const MINIMAP_PX = 200
// MINIMAP_HOVER_DOT_LIMIT — once the hovered feature type has more
// than this many placements the dot pass would just look like a
// uniform haze and we'd pay the loop cost on every mouse-move, so
// we skip dots entirely above this count.
const MINIMAP_HOVER_DOT_LIMIT = 100

// minimapBase holds the cached map render at one pixel per tile.
// Feature changes never touch the base — only the dot overlay
// drawn on top by renderMinimap depends on features — so
// invalidation is split between tile-only and feature-only paths.
let minimapBase = null
let minimapBaseStale = true

export function invalidateMinimapBase() {
  minimapBaseStale = true
  bumpContentVersion()
}

// getMinimapBaseSnapshot / setMinimapBaseSnapshot let the multi-tab
// swap save the active tab's minimap-base cache + stale flag so a
// later switch back to that tab restores it without forcing a full
// rebuild.  The host owns when these fire (snapshot before swap,
// restore after).
export function getMinimapBaseSnapshot() {
  return { canvas: minimapBase, stale: minimapBaseStale }
}

export function setMinimapBaseSnapshot(snapshot) {
  minimapBase = snapshot?.canvas ?? null
  minimapBaseStale = snapshot?.stale !== false
}

// sectionThumbCache maps a sectionPath to a downscaled canvas
// where each 32-px source tile collapses to a single pixel.  Built
// once per section via cascading half-size downsamples (browsers
// handle big single-step downscales poorly — direct 32→1 gives
// essentially one sampled pixel, which is what made the minimap
// look like noise on AC01-style maps).  Stored result is tiny
// (e.g. 64×64 for a 2048×2048 atlas) and stays valid for the life
// of the image.
const sectionThumbCache = new Map()
function sectionThumb(path, img) {
  if (!img || !img.complete || img.naturalWidth === 0) return null
  const cached = sectionThumbCache.get(path)
  if (cached && cached.srcW === img.naturalWidth && cached.srcH === img.naturalHeight) {
    return cached.canvas
  }
  const w = img.naturalWidth
  const h = img.naturalHeight
  const targetW = Math.max(1, Math.floor(w / TILE_PX))
  const targetH = Math.max(1, Math.floor(h / TILE_PX))
  let cur = img
  let cw = w, ch = h
  while (cw > targetW * 2 || ch > targetH * 2) {
    const nw = Math.max(targetW, Math.floor(cw / 2))
    const nh = Math.max(targetH, Math.floor(ch / 2))
    const c = document.createElement('canvas')
    c.width = nw
    c.height = nh
    const cctx = c.getContext('2d')
    cctx.imageSmoothingEnabled = true
    cctx.imageSmoothingQuality = 'high'
    cctx.drawImage(cur, 0, 0, nw, nh)
    cur = c
    cw = nw
    ch = nh
  }
  const final = document.createElement('canvas')
  final.width = targetW
  final.height = targetH
  const fctx = final.getContext('2d')
  fctx.imageSmoothingEnabled = true
  fctx.imageSmoothingQuality = 'high'
  fctx.drawImage(cur, 0, 0, targetW, targetH)
  sectionThumbCache.set(path, { canvas: final, srcW: w, srcH: h })
  return final
}

// patchMinimapTile updates a single pixel of the cached minimap
// base for an in-place tile edit (stamp / erase).  Skips when the
// base is already fully stale (a full rebuild will pick it up) or
// hasn't been allocated yet (first render will build it from
// scratch).
export function patchMinimapTile(tx, ty) {
  if (!minimapBase || minimapBaseStale) return
  if (minimapBase.width !== state.tileW || minimapBase.height !== state.tileH) {
    minimapBaseStale = true
    return
  }
  const ctx = minimapBase.getContext('2d')
  const stamp = state.tiles[ty * state.tileW + tx]
  if (!stamp) {
    ctx.fillStyle = VOID_COLOR
    ctx.fillRect(tx, ty, 1, 1)
    return
  }
  const img = state.sectionImages.get(stamp.sectionPath)
  const thumb = sectionThumb(stamp.sectionPath, img)
  if (!thumb) {
    hostCallbacks.whenImageReady?.(img, 'minimap-base', invalidateMinimapBase)
    return
  }
  ctx.clearRect(tx, ty, 1, 1)
  ctx.drawImage(thumb, stamp.sx, stamp.sy, 1, 1, tx, ty, 1, 1)
  hostCallbacks.scheduleMinimapRender?.()
}

function rebuildMinimapBase() {
  if (!minimapBase) minimapBase = document.createElement('canvas')
  // Base is one pixel per tile.  Per-tile colour comes from the
  // cached section thumb (cascading downsample) rather than
  // drawImage'ing the raw 32×32 source rect to 1 px, which
  // collapses to a single sampled pixel on most browsers and looks
  // like static.
  const W = state.tileW
  const H = state.tileH
  if (minimapBase.width !== W || minimapBase.height !== H) {
    minimapBase.width = W
    minimapBase.height = H
  }
  const ctx = minimapBase.getContext('2d')
  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = VOID_COLOR
  ctx.fillRect(0, 0, W, H)
  // TA:Kingdoms maps have no tile pool — the minimap base is the terrain
  // backdrop downscaled to one pixel per graphic unit (smoothing on so it
  // averages rather than point-samples to noise).
  const takTerrain = state.sectionImages.get(TAK_TERRAIN_KEY)
  if (takTerrain) {
    if (takTerrain.complete && takTerrain.naturalWidth > 0) {
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(takTerrain, 0, 0, W, H)
    } else {
      // Backdrop still decoding — repaint the minimap once it's ready (the
      // big terrain PNG often resolves after the first minimap render).
      hostCallbacks.whenImageReady?.(takTerrain, 'minimap-base', () => {
        invalidateMinimapBase()
        hostCallbacks.scheduleMinimapRender?.()
      })
    }
    minimapBaseStale = false
    return
  }
  for (let ty = 0; ty < state.tileH; ty++) {
    for (let tx = 0; tx < state.tileW; tx++) {
      const stamp = state.tiles[ty * state.tileW + tx]
      if (!stamp) continue
      const img = state.sectionImages.get(stamp.sectionPath)
      const thumb = sectionThumb(stamp.sectionPath, img)
      if (!thumb) {
        hostCallbacks.whenImageReady?.(img, 'minimap-base', invalidateMinimapBase)
        continue
      }
      ctx.drawImage(thumb, stamp.sx, stamp.sy, 1, 1, tx, ty, 1, 1)
    }
  }
  minimapBaseStale = false
}

// activeSchemaSlot returns the user-selected schema (or null when
// the map has no OTA / the schema index is out of range).  Inline
// helper so the minimap doesn't need a back-channel into studio.js
// for what's a one-line lookup against state.ota.
function activeSchemaSlot() {
  if (!state.ota || !state.ota.schemas[state.activeSchema]) return null
  return state.ota.schemas[state.activeSchema]
}

export function renderMinimap() {
  const mini = $('#minimap')
  if (!mini) return
  const ctx = mini.getContext('2d')
  ctx.imageSmoothingEnabled = false

  // Preserve aspect ratio: fit the map into MINIMAP_PX × MINIMAP_PX.
  const ratio = state.tileW / state.tileH
  let dw = MINIMAP_PX
  let dh = MINIMAP_PX
  if (ratio >= 1) {
    dh = Math.round(MINIMAP_PX / ratio)
  } else {
    dw = Math.round(MINIMAP_PX * ratio)
  }
  mini.width = MINIMAP_PX
  mini.height = MINIMAP_PX
  ctx.fillStyle = VOID_COLOR
  ctx.fillRect(0, 0, MINIMAP_PX, MINIMAP_PX)
  const ox = Math.floor((MINIMAP_PX - dw) / 2)
  const oy = Math.floor((MINIMAP_PX - dh) / 2)
  if (minimapBaseStale) rebuildMinimapBase()
  if (minimapBase) {
    ctx.drawImage(minimapBase, 0, 0, minimapBase.width, minimapBase.height, ox, oy, dw, dh)
  }

  // Feature dots: only drawn for the currently-highlighted feature
  // type so a dense map doesn't drown the minimap in red specks.
  // Highlight comes from drawer hover or canvas hover — when
  // nothing is hovered we draw none.  Skipped entirely when the
  // hovered type has more than MINIMAP_HOVER_DOT_LIMIT placements.
  const target = state.highlightFeatureName
  // Same opt-out as the canvas outline pass — once the map crosses
  // FEATURE_HIGHLIGHT_LIMIT total features the highlight makes
  // every mouse-move sluggish, so disable both.
  if (target && (state.features || []).length <= FEATURE_HIGHLIGHT_LIMIT) {
    const indices = getFeaturesByName(target)
    if (indices.length > 0 && indices.length <= MINIMAP_HOVER_DOT_LIMIT) {
      ctx.fillStyle = '#f85149'
      const anchor = hostCallbacks.featureAnchorWorld
      for (const idx of indices) {
        const f = state.features[idx]
        const a = anchor ? anchor(f) : null
        if (!a) continue
        const px = ox + (a.px / (state.tileW * TILE_PX)) * dw
        const py = oy + (a.py / (state.tileH * TILE_PX)) * dh
        ctx.beginPath()
        ctx.arc(px, py, 2.8, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }

  drawMinimapStartPositions(ctx, ox, oy, dw, dh)

  updateMinimapViewport(ox, oy, dw, dh)
}

// drawMinimapStartPositions overlays the active schema's start
// markers onto the minimap as numbered gold circles.  Always
// rendered (no hover gate) so the user can see at a glance where
// the players spawn — the markers double as a sanity check that
// the schema lines up with the terrain.
function drawMinimapStartPositions(ctx, ox, oy, dw, dh) {
  const schema = activeSchemaSlot()
  if (!schema || !schema.startPositions || schema.startPositions.length === 0) return
  const fontFamily = getComputedStyle(document.body).fontFamily
  const mapW = state.tileW * TILE_PX
  const mapH = state.tileH * TILE_PX
  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const sp of schema.startPositions) {
    if (typeof sp.x !== 'number' || typeof sp.z !== 'number') continue
    const px = ox + (sp.x / mapW) * dw
    const py = oy + (sp.z / mapH) * dh
    ctx.fillStyle = 'rgba(255, 200, 0, 0.95)'
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(px, py, 10, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = '#1a1a1a'
    ctx.font = `bold 14px ${fontFamily}`
    ctx.fillText(String(sp.number || ''), px, py + 1)
  }
  ctx.restore()
}

// updateMinimapViewport draws a rectangle showing what portion of
// the map is currently visible in the scroll viewport.
function updateMinimapViewport(ox, oy, dw, dh) {
  const wrap = $('#canvas-scroll')
  const canvas = $('#canvas')
  const vp = $('#minimap-viewport')
  if (!wrap || !canvas || !vp) return
  const fullW = canvas.width * state.zoom
  const fullH = canvas.height * state.zoom
  if (fullW <= wrap.clientWidth && fullH <= wrap.clientHeight) {
    vp.style.display = 'none'
    return
  }
  vp.style.display = 'block'
  // Scroll position is in stack-pixels; the canvas starts at the
  // padding offset, so subtract that and clamp to the map for the
  // minimap rect.
  const sL = clamp(wrap.scrollLeft - overscrollPadding.x, 0, fullW)
  const sT = clamp(wrap.scrollTop - overscrollPadding.y, 0, fullH)
  const fracL = sL / fullW
  const fracT = sT / fullH
  const fracW = Math.min(1, wrap.clientWidth / fullW)
  const fracH = Math.min(1, wrap.clientHeight / fullH)

  // vp lives inside .minimap-body, which is position:relative and
  // is the viewport's offset parent.  The minimap canvas itself
  // sits at (0,0) within that body, occupying its full size — the
  // content (after aspect-ratio fit) lies in [ox..ox+dw] ×
  // [oy..oy+dh] of the canvas.
  vp.style.left = (ox + fracL * dw) + 'px'
  vp.style.top = (oy + fracT * dh) + 'px'
  vp.style.width = (fracW * dw) + 'px'
  vp.style.height = (fracH * dh) + 'px'
}

// wireMinimap hooks the canvas-scroll listener that drives both
// the main-canvas re-render and the minimap viewport overlay.  The
// minimap panel itself is React-managed (see
// /ui/map-editor/panels/minimap-panel.js); mouse panning routes
// through the map-ribbon bridge's minimapBeginPan / Pan / EndPan
// actions, which the host translates via _doMinimapPan.
// FloatingPanel owns drag / collapse / close / position
// persistence — no per-id wiring left to do here.
export function wireMinimap() {
  const wrap = $('#canvas-scroll')
  if (wrap) {
    wrap.addEventListener('scroll', () => {
      hostCallbacks.scheduleRenderCanvas?.()
      hostCallbacks.scheduleMinimapRender?.()
    })
  }
}
