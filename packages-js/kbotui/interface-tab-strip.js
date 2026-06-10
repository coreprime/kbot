// interface-tab-strip.js
//
// The application's top-level tab strip — the row of tabs at the top of
// the editor shell, distinct from the per-panel FloatingPanelTabStrip.
// Hosts both map tabs
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
import { htm as html } from './htm-bind.js'
import {
  Dropdown, RibbonDropdownButton, MenuRow, MenuSectionLabel,
} from './ribbon.js'

// _state — singleton signal carrying { tabs, activeIndex }.  The
// host pushes updates via setTabs() each time the underlying tabs
// array or activeTabIndex changes (open, close, switch).
const _state = signal({ tabs: [], activeIndex: -1 })

// _bridge — host installs the click/close + "+" popup callbacks.
const _bridge = {
  onSwitch:    (_i) => {},
  onClose:     (_i) => {},
  onWelcome:   () => {},
  onNewMap:    () => {},
  onOpenMap:   () => {},
  onOpenUnit:  () => {},
  onSandboxLocal: () => {},
  onSandboxHost:  () => {},
  onSandboxJoin:  () => {},
  onBrowseFiles: () => {},
}

export function configureTabBarBridge(impl) {
  Object.assign(_bridge, {
    onSwitch:    (_i) => {},
    onClose:     (_i) => {},
    onWelcome:   () => {},
    onNewMap:    () => {},
    onOpenMap:   () => {},
    onOpenUnit:  () => {},
    onSandboxLocal: () => {},
    onSandboxHost:  () => {},
    onSandboxJoin:  () => {},
    onBrowseFiles: () => {},
  }, impl)
}

// setTabs — host pushes a fresh tabs[] + activeIndex pair.  The
// component re-renders whenever either changes.  Pass shallow-copied
// arrays so the signal sees a new reference (the legacy host mutates
// the same array in place, which wouldn't trigger a refresh).
export function setTabs(tabs, activeIndex) {
  _state.value = { tabs: tabs.slice(), activeIndex }
}

// _tabType returns the registrar typeId for a tab record.  Falls back
// to the legacy `tab.type` field for any pre-registrar consumer.
function _tabType(tab) { return tab.typeId || tab.type || '' }

// Label + tooltip are data-driven from the tab record — the strip keeps NO
// per-type (map/unit/sandbox/…) knowledge. A tab provides its own label via
// displayName(); an optional tabTitle() supplies a richer tooltip.
function _tabLabel(tab) {
  return tab.displayName
    || (tab.instance && typeof tab.instance.displayName === 'function' ? tab.instance.displayName() : '')
    || tab.name
    || '(untitled)'
}

function _tabTitle(tab) {
  if (tab.instance && typeof tab.instance.tabTitle === 'function') return tab.instance.tabTitle()
  return _tabLabel(tab)
}

export function InterfaceTabStrip() {
  const { tabs, activeIndex } = _state.value
  return html`
    <nav class="map-tabs" role="tablist">
      <div class="map-tabs-list" id="map-tabs-list">
        ${tabs.map((tab, i) => {
          const t = _tabType(tab)
          const modelLike = t === 'unit-editor' || t === 'sandbox'
          const dirty = !!(tab.instance && typeof tab.instance.dirty === 'function' && tab.instance.dirty())
          const cls = [
            'map-tab',
            i === activeIndex ? 'active' : '',
            dirty ? 'dirty' : '',
            modelLike ? 'map-tab-model' : '',
          ].filter(Boolean).join(' ')
          const display = _tabLabel(tab)
          const closeTitle = `Close ${display}`
          const icon = tab.descriptor?.glyph || tab.glyph || ''
          return html`
            <button key=${i}
                    type="button"
                    class=${cls}
                    data-tab-index=${i}
                    role="tab"
                    title=${_tabTitle(tab)}
                    onClick=${() => _bridge.onSwitch(i)}>
              ${icon ? html`<span class="map-tab-icon">${icon}</span>` : null}
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
            icon="🏠"
            label="Welcome"
            dropdownId="map-tab-add-dropdown"
            onClick=${() => _bridge.onWelcome()} />
          <${MenuSectionLabel}>Mapping<//>
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
          <${MenuSectionLabel}>Units<//>
          <${MenuRow}
            icon="🛠"
            label="Open Unit"
            dropdownId="map-tab-add-dropdown"
            onClick=${() => _bridge.onOpenUnit()} />
          <${MenuSectionLabel}>Sandbox<//>
          <${MenuRow}
            icon="🪖"
            label="Local"
            dropdownId="map-tab-add-dropdown"
            onClick=${() => _bridge.onSandboxLocal()} />
          <${MenuRow}
            icon="🌐"
            label="Host New"
            dropdownId="map-tab-add-dropdown"
            onClick=${() => _bridge.onSandboxHost()} />
          <${MenuRow}
            icon="🔗"
            label="Join Hosted"
            dropdownId="map-tab-add-dropdown"
            onClick=${() => _bridge.onSandboxJoin()} />
          <${MenuSectionLabel}>Browse<//>
          <${MenuRow}
            icon="🗂"
            label="Browse Files"
            dropdownId="map-tab-add-dropdown"
            onClick=${() => _bridge.onBrowseFiles()} />
        <//>
      </div>
    </nav>
  `
}
