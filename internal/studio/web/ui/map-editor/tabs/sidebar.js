// sidebar.js
//
// The map-editor's left rail, built on the shared @coreprime/kbot-ui SideBar
// shell: the Sections / Features tab strip, the filter row (search box,
// "Used only" checkbox, "Include wreckage" checkbox), and the section /
// feature drawer.
//
// The drawer body (`<div id="drawer">`) is repainted imperatively by
// studio.js's renderDrawer pipeline, which writes tile / feature buttons
// straight into the element.  A normal Preact child would have that
// paint clobbered on every re-render (filter keystroke, tab switch), so
// the drawer is wrapped in <${FrozenSlot}>: Preact mounts it once, then
// opts out of reconciling it, leaving the legacy paint untouched.
//
// Two checkbox rows are visibility-gated: "Used only" + "Include
// wreckage" only make sense on the Features drawer.  The host
// publishes the visibility flags through the store after every
// switchTab, mirroring the legacy hide/show logic verbatim.

import { htm as html } from '@coreprime/kbot-ui/htm-bind'
import { SideBar, FrozenSlot } from '@coreprime/kbot-ui/side-bar'
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
    <${SideBar}
      tabs=${_TABS}
      active=${drawer}
      onSelect=${(key) => sidebarBridge.onTabChange(key)}>
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
      <${FrozenSlot}>
        <div id="drawer" class="drawer">
          <div class="loading">Loading sections…</div>
        </div>
      <//>
    <//>
  `
}
