// side-bar-tab-strip.js
//
// The tab strip that heads an editor sidebar — e.g. the map editor's
// Sections / Features switch.  Renders the shared `.tabs` / `.tab`
// markup (a row of underline-style tabs with the active one lit) so
// every sidebar reuses one component instead of hand-rolling the strip.
//
// Usage:
//
//   import { SideBarTabStrip } from './side-bar-tab-strip.js'
//
//   <${SideBarTabStrip}
//     tabs=${[{ key: 'sections', label: 'Sections' }, ...]}
//     active=${drawer}
//     onSelect=${(key) => switchDrawer(key)} />
//
// `onSelect` receives the chosen tab key.  Presentational only — the
// caller owns the active key and the switch side effects.

import { htm as html } from './htm-bind.js'

export function SideBarTabStrip({ tabs, active, onSelect }) {
  return html`
    <div class="tabs" role="tablist">
      ${(tabs || []).map((t) => html`
        <button
          key=${t.key}
          data-tab=${t.key}
          role="tab"
          aria-selected=${active === t.key}
          class=${'tab' + (active === t.key ? ' active' : '')}
          onClick=${() => onSelect && onSelect(t.key)}>
          ${t.label}
        </button>
      `)}
    </div>
  `
}
