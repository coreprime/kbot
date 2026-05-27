// tab-bar.js
//
// Shared tab strip at the top of the editor.  Hosts both map tabs
// (when the user has a map open) and model / sandbox tabs.  Tab
// records flow in from the host as a tabs[] array + an active index;
// the "+" popup uses the same Dropdown primitive the ribbons use so
// outside-click + Esc dismissal stays consistent.
//
// The component is structural only — it renders whatever tab records
// the host hands it.  Per-type rendering (model glyph, dirty marker,
// title formatting) is data-driven from the record's `type`, `name`,
// `meta`, `map.dirty`, etc. fields.

import { signal } from '@preact/signals'
import { htm as html } from '/ui/common/htm-bind.js'
import {
  Dropdown, RibbonDropdownButton, MenuRow,
} from '/ui/common/ribbon.js'

// _state — singleton signal carrying { tabs, activeIndex }.  The
// host pushes updates via setTabs() each time the underlying tabs
// array or activeTabIndex changes (open, close, switch).
const _state = signal({ tabs: [], activeIndex: -1 })

// _bridge — host installs the click/close + "+" popup callbacks.
const _bridge = {
  onSwitch:    (_i) => {},
  onClose:     (_i) => {},
  onNewMap:    () => {},
  onOpenMap:   () => {},
  onOpenUnit:  () => {},
  onSandbox:   () => {},
}

export function configureTabBarBridge(impl) {
  Object.assign(_bridge, {
    onSwitch:    (_i) => {},
    onClose:     (_i) => {},
    onNewMap:    () => {},
    onOpenMap:   () => {},
    onOpenUnit:  () => {},
    onSandbox:   () => {},
  }, impl)
}

// setTabs — host pushes a fresh tabs[] + activeIndex pair.  The
// component re-renders whenever either changes.  Pass shallow-copied
// arrays so the signal sees a new reference (the legacy host mutates
// the same array in place, which wouldn't trigger a refresh).
export function setTabs(tabs, activeIndex) {
  _state.value = { tabs: tabs.slice(), activeIndex }
}

// _mapDisplayName — humanise a map record's name.  Mirrors the host's
// mapDisplayName helper without depending on it.
function _mapDisplayName(m) {
  if (!m) return '(no map)'
  return m.missionName || m.name || '(unnamed map)'
}

function _tabLabel(tab) {
  if (tab.type === 'model') return tab.meta?.unitTitle || tab.name || '(model)'
  return _mapDisplayName(tab.map)
}

function _tabTitle(tab) {
  if (tab.type === 'model') {
    const display = _tabLabel(tab)
    const metaBits = [tab.meta?.unitName?.toUpperCase(), tab.meta?.side, tab.meta?.category].filter(Boolean).join(' · ')
    return `${display}${metaBits ? ` · ${metaBits}` : ''}`
  }
  const m = tab.map
  const dirty = !!m?.dirty
  const display = _mapDisplayName(m)
  return `${display}${dirty ? ' (unsaved changes)' : ''} · ${m?.name || '(no file)'} · ${m?.tileW}×${m?.tileH}`
}

export function TabBar() {
  const { tabs, activeIndex } = _state.value
  return html`
    <nav class="map-tabs" role="tablist">
      <div class="map-tabs-list" id="map-tabs-list">
        ${tabs.map((tab, i) => {
          const dirty = tab.type !== 'model' && !!tab.map?.dirty
          const cls = [
            'map-tab',
            i === activeIndex ? 'active' : '',
            dirty ? 'dirty' : '',
            tab.type === 'model' ? 'map-tab-model' : '',
          ].filter(Boolean).join(' ')
          const display = _tabLabel(tab)
          const closeTitle = tab.type === 'model' ? 'Close this model' : 'Close this map'
          return html`
            <button key=${i}
                    type="button"
                    class=${cls}
                    data-tab-index=${i}
                    role="tab"
                    title=${_tabTitle(tab)}
                    onClick=${() => _bridge.onSwitch(i)}>
              ${tab.type === 'model' ? html`<span class="map-tab-icon">🛠</span>` : null}
              <span class="map-tab-label">${dirty ? `${display}*` : display}</span>
              <button type="button"
                      class="map-tab-close"
                      title=${closeTitle}
                      onClick=${(e) => { e.stopPropagation(); _bridge.onClose(i) }}>×</button>
            </button>
          `
        })}
      </div>
      <div class="ribbon-dropdown" id="map-tab-add-dropdown" style="display: contents">
        <${RibbonDropdownButton}
          id="map-tab-add"
          dropdownId="map-tab-add-dropdown"
          icon="+"
          className="map-tab-add"
          noChevron=${true}
          title="Open something new — map, unit, or sandbox." />
        <${Dropdown} id="map-tab-add-dropdown" anchorId="map-tab-add" className="map-tab-add-popup">
          <${MenuRow}
            icon="✨"
            label="New map"
            dropdownId="map-tab-add-dropdown"
            onClick=${() => _bridge.onNewMap()} />
          <${MenuRow}
            icon="📂"
            label="Open map"
            dropdownId="map-tab-add-dropdown"
            onClick=${() => _bridge.onOpenMap()} />
          <${MenuRow}
            icon="🛠"
            label="Open Unit"
            dropdownId="map-tab-add-dropdown"
            onClick=${() => _bridge.onOpenUnit()} />
          <${MenuRow}
            icon="🪖"
            label="Sandbox Mode"
            dropdownId="map-tab-add-dropdown"
            onClick=${() => _bridge.onSandbox()} />
        <//>
      </div>
    </nav>
  `
}
