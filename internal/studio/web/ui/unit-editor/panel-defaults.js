// panel-defaults.js
//
// Seed the persisted-visibility flag on each of the unit-editor's
// floating inspector panels BEFORE the React island's first mount so
// the Preact tree doesn't flash visible then hide.  Defaults match
// the legacy wireMvInspectors path (true unless explicitly closed in
// some prior session).

const INSPECTOR_PANEL_IDS = [
  'mv-inspector-staticvars',
  'mv-inspector-audio',
  'mv-inspector-effects',
  'mv-inspector-camera',
  'mv-inspector-actions',
  'mv-inspector-ports',
  'mv-inspector-scripts',
]

export function seedInspectorPanelDefaults(reactUi, state) {
  if (!reactUi || typeof reactUi.setPanelVisible !== 'function') return
  for (const id of INSPECTOR_PANEL_IDS) {
    const vis = state.mvInspectorVisible || {}
    const wasSet = Object.prototype.hasOwnProperty.call(vis, id)
    reactUi.setPanelVisible(id, wasSet ? !!vis[id] : true)
  }
}
