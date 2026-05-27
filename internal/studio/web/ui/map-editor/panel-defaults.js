// panel-defaults.js
//
// Seed the persisted-visibility flag on each map-editor floating panel
// (Stats, Minimap, Camera & Cursor) BEFORE the React tree's first
// mount so the panels don't flash hidden then show.  Stats defaults
// to visible; Minimap + Camera honour the legacy state.showMinimap /
// state.showCameraInfo flags so upgrading users keep their saved
// View-menu choices.

const MAP_PANEL_IDS = ['map-stats-panel', 'minimap-panel', 'camera-info-panel']

export function seedMapPanelDefaults(reactUi, state) {
  if (!reactUi || typeof reactUi.setPanelVisible !== 'function') return
  for (const id of MAP_PANEL_IDS) {
    const vis = state.mvInspectorVisible || {}
    const wasSet = Object.prototype.hasOwnProperty.call(vis, id)
    let def = true
    if (id === 'minimap-panel')     def = state.showMinimap !== false
    if (id === 'camera-info-panel') def = state.showCameraInfo !== false
    reactUi.setPanelVisible(id, wasSet ? !!vis[id] : def)
  }
}
