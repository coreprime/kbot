// render.js
//
// renderCanvas — the per-frame orchestrator that paints every
// layer of the map editor canvas.  Now that every sub-pass lives
// in its own module the body is mostly call sites:
//
//   - Sync canvas backing buffer + CSS dimensions (lazy — pixel
//     buffer reallocation costs 64 MB on a 128-tile map, so only
//     do it when state.tileW/tileH actually changed).
//   - WebGL pass for tiles + features when ensureGLRenderer
//     succeeds; 2D fallback drawTiles + drawFeatures otherwise.
//   - Map / Heightmap / Blended viewmode dispatch with the
//     matching overlays.
//   - The translucent overlays — gridlines, voids, buildable,
//     drop preview, terrain clipboard, placement, selected /
//     highlighted feature outlines, start positions, brush
//     cursors, ruler.
//   - Schedule the minimap re-render, the developer-stats
//     refresh, and the feature-info / camera-info panel updates
//     that ride along after every frame.
//
// Cross-module deps via hostCallbacks:
//   - none — everything we need is now a module-level import.

import { state, $, activeMap } from '../../host-context.js'
import { TILE_PX, VOID_COLOR } from '../constants.js'
import { applyOverscrollPadding } from '../zoom-pan.js'
import { visiblePixelBounds, visibleTileBounds } from '../viewport.js'
import {
  ensureGLRenderer,
  glClearViewport,
  glRenderTilesAndFeatures,
} from './webgl.js'
import {
  drawHeightmap,
  drawHeightmapOverlay,
  drawHeightContours,
} from './heightmap.js'
import { drawTiles } from './tiles.js'
import {
  drawGridlines,
  drawVoidOverlay,
  drawBuildableOverlay,
} from './overlays.js'
import {
  drawFeatures,
  drawDropPreview,
  drawFeatureDragPreview,
} from './features.js'
import { drawTerrainOverlays } from './terrain.js'
import {
  drawPlacementPreview,
  hideRotationBadge,
} from './placement.js'
import {
  drawSelectedFeatureOutline,
  drawHighlightedFeatureOutlines,
} from './feature-overlays.js'
import { drawStartPositions } from './start-positions.js'
import {
  drawEraseBrush,
  drawHeightmapBrush,
} from './brush-cursors.js'
import { drawRulerOverlay } from './ruler.js'
import { scheduleMinimapRender } from '../render-queue.js'
import { scheduleDevStatsRefresh } from '../dev-stats.js'
import { updateFeatureInfoPanel } from '../feature-info.js'
import { updateCameraInfoPanel } from '../camera-info.js'

export function renderCanvas() {
  // No-op when no map tab is the active context — every state.X read
  // below routes through the host-context Proxy to activeMap(), which
  // returns null when the user is on the welcome screen or a unit /
  // sandbox tab.  Stale scheduleRenderCanvas() ticks (e.g. from the
  // ResizeObserver on the editor view) would otherwise crash on
  // state.features being undefined.
  if (!activeMap()) return
  const canvas = $('#canvas')
  const glCanvas = $('#canvas-gl')
  const wantW = state.tileW * TILE_PX
  const wantH = state.tileH * TILE_PX
  // Reassigning canvas.width/height reallocates the pixel buffer
  // — for a 128-tile map that's a 64 MB texture, and a 256-tile
  // map is 256 MB.  Doing it every render (including on every
  // scroll tick) is what made the editor feel "insanely slow".
  // Only pay that cost when the dimensions actually change.
  const dimsChanged = canvas.width !== wantW || canvas.height !== wantH
  if (dimsChanged) {
    canvas.width = wantW
    canvas.height = wantH
    if (glCanvas) {
      glCanvas.width = wantW
      glCanvas.height = wantH
    }
  }
  // Sync the CSS size on BOTH canvases regardless of whether the
  // 2D canvas's value happened to match — the two layers must
  // always agree on dimensions or features render outside the
  // visible canvas.  This also catches the map-switch case where
  // the previous map's GL canvas style was left stale because the
  // 2D canvas's style happened to already be the new target after
  // a dimsChanged reset.
  const wantStyleW = wantW * state.zoom + 'px'
  const wantStyleH = wantH * state.zoom + 'px'
  if (canvas.style.width !== wantStyleW) canvas.style.width = wantStyleW
  if (canvas.style.height !== wantStyleH) canvas.style.height = wantStyleH
  if (glCanvas) {
    if (glCanvas.style.width !== wantStyleW) glCanvas.style.width = wantStyleW
    if (glCanvas.style.height !== wantStyleH) glCanvas.style.height = wantStyleH
  }
  // .canvas-stack is the normal-flow scroll content; we pad it
  // with half a viewport on every side so the user can pan the
  // map past any edge until that edge sits at the centre of the
  // viewport.
  applyOverscrollPadding()
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false

  // 2D overlay layer must be transparent everywhere we don't
  // paint an overlay, so the WebGL tile+feature layer shows
  // through.  Clear the visible viewport instead of fill-rect-
  // with-void-colour — the void is now drawn by the GL layer's
  // clear().
  const vp = visiblePixelBounds()
  if (dimsChanged) {
    ctx.clearRect(0, 0, wantW, wantH)
  } else {
    ctx.clearRect(vp.minX, vp.minY, vp.maxX - vp.minX, vp.maxY - vp.minY)
  }

  // Tiles + features render via WebGL.  Heightmap view stays on
  // 2D (it's a one-off greyscale fill, not a per-tile drawImage
  // hot path).  When the GL context isn't available (no WebGL
  // support), fall back to the 2D path so the editor still works.
  // Note that the GL renderer iterates tile *cells* — it needs
  // visibleTileBounds, not the pixel bounds we use for the 2D
  // clearRect.
  const glReady = ensureGLRenderer()
  const tb = visibleTileBounds()
  if (state.viewMode === 'heightmap') {
    if (glReady) glClearViewport()
    drawHeightmap(ctx)
  } else {
    if (glReady) {
      glRenderTilesAndFeatures(tb)
    } else {
      ctx.fillStyle = VOID_COLOR
      ctx.fillRect(vp.minX, vp.minY, vp.maxX - vp.minX, vp.maxY - vp.minY)
      drawTiles(ctx)
    }
    if (state.viewMode === 'blended') drawHeightmapOverlay(ctx)
    // Optional height contour overlay on Map / Blended views.
    // The Heightmap view always draws contours via drawHeightmap
    // → here we re-use the same function so the on-screen lines
    // match.
    if (state.showContours) {
      const attrW = state.tileW * 2
      const attrH = state.tileH * 2
      const cell = TILE_PX / 2
      drawHeightContours(ctx, attrW, attrH, cell)
    }
  }

  // Grid overlay — density adapts to zoom so you can see per-tile
  // outlines when you're close and big 8×8 blocks when zoomed
  // out.  Major lines every 8 tiles are drawn heavier so the user
  // keeps a sense of the larger grid even at the densest zoom.
  if (state.showGridlines) drawGridlines(ctx, canvas)

  // Features are rendered by the WebGL layer above when GL is
  // active; fall back to the 2D path only when GL isn't
  // available.
  if (!glReady && state.showFeatures && state.viewMode !== 'tiles' && state.viewMode !== 'heightmap') {
    drawFeatures(ctx)
  }

  // Drop-preview, terrain rectangle selection, terrain clipboard
  // preview, placement preview, selected-feature highlight —
  // each draws its own overlay so the user always sees what
  // their next action will do.
  drawDropPreview(ctx)
  drawFeatureDragPreview(ctx)
  drawTerrainOverlays(ctx)
  drawPlacementPreview(ctx)
  drawSelectedFeatureOutline(ctx)
  drawHighlightedFeatureOutlines(ctx)
  drawStartPositions(ctx)
  drawEraseBrush(ctx)
  drawHeightmapBrush(ctx)
  drawVoidOverlay(ctx)
  drawBuildableOverlay(ctx)
  drawRulerOverlay(ctx)

  // Rotation badge is an HTML overlay — hide it when there's
  // nothing to rotate.  The drawPlacementPreview / drawTerrain-
  // Clipboard functions used to re-show + reposition it via
  // updateRotationBadge; the badge itself was deprecated in
  // round 33 but the hide call is kept guarded for any third-
  // party extension that re-injects the legacy element.
  if (!state.placement && !state.terrainClipboard) hideRotationBadge()

  // Mirror the main canvas into the floating minimap.
  scheduleMinimapRender()
  // Refresh the developer stats panel on the next frame too —
  // keeps the counts in sync with whatever the user just
  // stamped.
  scheduleDevStatsRefresh()
  // Keep the per-feature callout in sync with the current
  // selection.
  updateFeatureInfoPanel()
  updateCameraInfoPanel()
}
