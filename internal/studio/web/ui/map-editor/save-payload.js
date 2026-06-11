// save-payload.js
//
// buildSavePayload snapshots the current per-map state into the
// shape the save / quality-check / export endpoints accept.
// Splitting it into its own module lets:
//
//   - save() / saveLoose() ship it verbatim,
//   - the Quality Checker re-send the same payload across
//     multiple fix iterations without rebuilding it each time,
//   - the export-* endpoints (full render, map image, buildmap,
//     voidmap) use the identical payload — same data, different
//     server-side renderers.
//
// The first lines drop any in-flight terrain clipboard and
// in-progress placement so the persisted map matches what the
// user actually sees on screen.

import { state } from '../host-context.js'
import { dropTerrainClipboard } from './clipboard.js'
import { hostCallbacks } from '../host-context.js'
import { getCurrentTakMapPath } from './tak-edit.js'

export function buildSavePayload() {
  if (state.terrainClipboard) dropTerrainClipboard()
  hostCallbacks.cancelPlacement?.()
  return {
    // '' for TA maps; the open map's VFS path for TA:K, which routes the
    // server to the in-place 0x4000 save instead of the TA builder.
    takMapPath: getCurrentTakMapPath(),
    mapName: state.name,
    displayName: state.ota?.missionName || state.name,
    tileW: state.tileW,
    tileH: state.tileH,
    planet: state.planet,
    tiles: state.tiles,
    heights: state.heights,
    voids: state.voids,
    features: state.features.map((f) => ({ name: f.name, ax: f.ax, ay: f.ay })),
    seaLevel: state.ota?.seaLevel ?? 0,
    ota: state.ota,
    activeSchema: state.activeSchema | 0,
  }
}
