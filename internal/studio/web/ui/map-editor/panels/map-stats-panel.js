// map-stats-panel.js
//
// React-rendered Stats overlay for the map editor.  Three live counts:
// distinct tiles in use, distinct feature kinds in use, and the total
// number of features placed.  The host computes the values in
// computeDevStats() and publishes them through publishMapStats; the
// panel re-renders on each signal update.
//
// Uses the legacy `.dev-stats` chrome classes from studio.css so the
// migration is style-stable — only the wiring changes, the visual
// language is unchanged.  Mounts via the shared FloatingPanel (which
// owns drag, collapse, position persistence) configured with
// `.canvas-wrap` as the clamp container.

import { htm as html } from '@coreprime/kbot-ui/htm-bind'
import { FloatingPanel } from '@coreprime/kbot-ui/floating-panel'
import { mapStats } from '/ui/map-editor/store.js'

// PANEL_ID — historic-id alignment.  The legacy panel used
// `dev-stats-panel`; the migration renames it to `map-stats-panel`
// so the id reflects what the panel actually shows (it's a map
// stats HUD, not a generic "dev" panel).  Persistence keys live
// under the new id; the studio.js pref bridge maps the old key
// over on first read so an upgrading user keeps their layout.
const PANEL_ID = 'map-stats-panel'

function _Row({ label, value }) {
  return html`
    <div class="dev-stats-row">
      <span class="dev-stats-label">${label}</span>
      <span class="dev-stats-value">${value}</span>
    </div>
  `
}

export function MapStatsPanel() {
  const s = mapStats.value
  return html`
    <${FloatingPanel}
      id=${PANEL_ID}
      title="Stats"
      rootClass="dev-stats"
      headerClass="dev-stats-header"
      bodyClass="dev-stats-body"
      stageSelector=".canvas-wrap"
      noClose=${true}>
      <${_Row} label="Distinct tiles"    value=${s.distinctTiles} />
      <${_Row} label="Distinct features" value=${s.distinctFeatures} />
      <${_Row} label="Total features"    value=${s.totalFeatures} />
    <//>
  `
}
