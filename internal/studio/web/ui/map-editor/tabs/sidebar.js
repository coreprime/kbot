// sidebar.js
//
// React-rendered map-editor sidebar header: the Sections / Features
// tab strip + the filter row (search box, "Used only" checkbox,
// "Include wreckage" checkbox).
//
// The drawer body itself (`<div id="drawer">` in index.html) is NOT
// part of this component — it lives as a sibling under
// `<aside class="sidebar">`.  This split is deliberate: studio.js's
// renderDrawer pipeline paints tile / feature buttons directly into
// `#drawer`, and React's child diff would clobber that paint every
// time a signal change re-renders MapSidebar (filter input keystrokes,
// tab switch, etc.).  By mounting MapSidebar into a dedicated
// `#sidebar-tabs-mount` slot and leaving `#drawer` outside the React
// tree, the legacy paint survives all React re-renders.
//
// Two checkbox rows are visibility-gated: "Used only" + "Include
// wreckage" only make sense on the Features drawer.  The host
// publishes the visibility flags through the store after every
// switchTab, mirroring the legacy hide/show logic verbatim.

import { htm as html } from '@kbot/ui/htm-bind'
import {
  sidebarDrawer, sidebarFilter, sidebarUsedOnly, sidebarWreckage,
  sidebarUsedOnlyVisible, sidebarWreckageVisible,
  sidebarBridge,
} from '/ui/map-editor/store.js'

const _TABS = [
  { key: 'sections', label: 'Sections' },
  { key: 'features', label: 'Features' },
]

export function MapSidebar() {
  const drawer   = sidebarDrawer.value
  const filter   = sidebarFilter.value
  const used     = sidebarUsedOnly.value
  const wreckage = sidebarWreckage.value
  const showUsed     = sidebarUsedOnlyVisible.value
  const showWreckage = sidebarWreckageVisible.value
  return html`
    <div class="tabs">
      ${_TABS.map((t) => html`
        <button key=${t.key}
                data-tab=${t.key}
                class=${'tab' + (drawer === t.key ? ' active' : '')}
                onClick=${() => sidebarBridge.onTabChange(t.key)}>
          ${t.label}
        </button>
      `)}
    </div>
    <div class="filter">
      <input type="search" id="filter"
             placeholder="Filter by name, world, group"
             autocomplete="off" autocorrect="off"
             autocapitalize="off" spellcheck=${false}
             value=${filter}
             onInput=${(e) => sidebarBridge.onFilterChange(e.currentTarget.value)} />
      <div class="filter-row">
        <label class=${'filter-toggle' + (showUsed ? '' : ' hidden')}
               id="filter-used-wrap"
               title="Only show features currently placed on the map">
          <input type="checkbox" id="filter-used"
                 checked=${used}
                 onChange=${(e) => sidebarBridge.onUsedOnlyChange(e.currentTarget.checked)} />
          <span>Used only</span>
        </label>
        <label class=${'filter-toggle' + (showWreckage ? '' : ' hidden')}
               id="filter-wreckage-wrap"
               title="Wreckage / corpses are filtered out by default">
          <input type="checkbox" id="filter-wreckage"
                 checked=${wreckage}
                 onChange=${(e) => sidebarBridge.onWreckageChange(e.currentTarget.checked)} />
          <span>Include wreckage</span>
        </label>
      </div>
    </div>
  `
}
