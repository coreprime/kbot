// floating-panel-tab-strip.js
//
// Tab strip for inspector floating panels that switch between a small
// set of views (e.g. the Sync Diagnostics panel's Summary / Units /
// Projectiles tabs).  Matches the inspector visual family — a row of
// pill buttons with the active one lit — so any panel adopting it feels
// native rather than hand-rolled.  Named for its home: it lives inside
// FloatingPanel headers, distinct from the app-level interface tabs.
//
// Usage:
//
//   import { FloatingPanelTabStrip } from './floating-panel-tab-strip.js'
//
//   <${FloatingPanelTabStrip}
//     tabs=${[{ id: 'units', label: 'Units (3)' }, ...]}
//     active=${tab}
//     onSelect=${setTab} />
//
// `onSelect` receives the chosen tab id.  Clicks stop propagation so a
// strip living inside a draggable FloatingPanel header doesn't kick off
// a panel drag.

import { htm as html } from './htm-bind.js'

const _stopProp = (e) => e.stopPropagation()

export function FloatingPanelTabStrip({ tabs, active, onSelect }) {
  return html`
    <div class="mv-tab-strip" role="tablist">
      ${(tabs || []).map((t) => html`
        <button
          key=${t.id}
          role="tab"
          aria-selected=${active === t.id}
          class=${`mv-tab${active === t.id ? ' is-active' : ''}`}
          onClick=${(e) => { _stopProp(e); onSelect && onSelect(t.id) }}
          onPointerDown=${_stopProp}
          onMouseDown=${_stopProp}>${t.label}</button>
      `)}
    </div>
  `
}
