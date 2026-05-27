// sandbox-ribbon.js
//
// React-rendered ribbon for sandbox mode.  Composes the shared
// ribbon primitives (Ribbon, RibbonSection, RibbonButton,
// RibbonDropdownButton, Dropdown, MenuRow, MenuToggleRow) from
// /ui/common/ribbon.js so the markup is consistent with the
// (future) unit-editor ribbon migration.
//
// All sandbox-specific actions (Spawn / Move / Attack / Stop / etc.)
// route through host-supplied callbacks in a singleton bridge — the
// component doesn't reach into sandboxViewInstance / scene globals
// directly.  Toggling the Developer Tools panel rows hits the same
// panel-store helpers the floating-panel chrome uses, so the
// dropdown and the panel ✕ button stay in lockstep.

import { htm as html } from '/ui/common/htm-bind.js'
import { mv as mvSignal, runtimeTick, controlsDevSectionVisible, setControlsDevSectionVisible } from '/ui/common/inspector-store.js'
import { panelSignals } from '/ui/common/panel-store.js'
import {
  Ribbon, RibbonSection, RibbonButton,
  RibbonDropdownButton, Dropdown, MenuRow, MenuToggleRow,
  closeDropdownById,
} from '/ui/common/ribbon.js'

// _bridge — host installs the action callbacks (spawn, stop, etc.)
// plus the setSandboxPanelVisible function the dev-tools rows use.
const _bridge = {
  openSpawnPicker:   (_anchorEl) => {},
  setPendingCommand: (_cmd) => {},
  stopSelected:      () => {},
  selectAll:         () => {},
  deselectAll:       () => {},
  clearField:        () => {},
  resetCamera:       () => {},
  setPanelVisible:   (_panelId, _visible) => {},
}

export function configureSandboxRibbonBridge(impl) {
  Object.assign(_bridge, {
    openSpawnPicker:   (_anchorEl) => {},
    setPendingCommand: (_cmd) => {},
    stopSelected:      () => {},
    selectAll:         () => {},
    deselectAll:       () => {},
    clearField:        () => {},
    resetCamera:       () => {},
    setPanelVisible:   (_panelId, _visible) => {},
  }, impl)
}

// _PANEL_ROWS — defines every panel-toggle row in the Developer
// Tools dropdown.  Data-driven so adding a new floating panel only
// needs one line here + a panel-store registration.
const _PANEL_ROWS = [
  { id: 'mv-inspector-scripts',    icon: '⏱', label: 'Runtime',
    title: 'Runtime overlay — active script threads, instruction counters, sim ticks.' },
  { id: 'mv-inspector-effects',    icon: '✨', label: 'Effects',
    title: 'Effects overlay — every live particle across every binding (projectiles, smoke, sparks).' },
  { id: 'mv-inspector-audio',      icon: '🔊', label: 'Audio',
    title: 'Audio overlay — every sound currently playing across every unit.' },
  { id: 'sandbox-panel',           icon: '🛠', label: 'Sandbox Controls',
    title: 'Sandbox Controls — the floating Spawn panel.' },
  { id: 'mv-inspector-camera',     icon: '🎥', label: 'Renderer',
    title: 'Renderer overlay — camera pose, FPS, tracking checkbox.' },
  { id: 'mv-inspector-staticvars', icon: '📊', label: 'Unit Variables',
    title: 'Unit Variables overlay — current value of every COB `static-var` the scripts share.' },
  { id: 'mv-inspector-unit-ports', icon: '🔌', label: 'Unit Ports',
    title: 'Unit Ports overlay — read-only view of every well-known COB unit-value port (Active, Health, Build %, Move/Fire orders, etc.) for the selected unit.' },
]

// _PanelToggle — reads the panel's visibility signal directly so the
// row's check + active state flip the instant the panel-store
// changes (via the ✕ button OR another dropdown).
function _PanelToggle({ id, icon, label, title }) {
  const sig = panelSignals(id, { defaultVisible: true })
  const visible = !!sig.visible.value
  return html`
    <${MenuToggleRow} icon=${icon} label=${label} title=${title}
                      on=${visible}
                      onChange=${(next) => _bridge.setPanelVisible(id, next)} />
  `
}

export function SandboxRibbon() {
  // Subscribe to runtimeTick + mv so future per-tick state (selection
  // size, etc) can re-render here without manual signal plumbing per
  // button.  Cheap when the ribbon is hidden (tab inactive).
  void runtimeTick.value
  void mvSignal.value
  const devVisible = !!controlsDevSectionVisible.value
  return html`
    <${Ribbon} id="sandbox-ribbon" className="sandbox-ribbon" align="space-between">
      <${RibbonSection} label="Sandbox">
        <div class="ribbon-dropdown" id="sandbox-rb-sandbox-dropdown">
          <${RibbonDropdownButton}
            id="sandbox-rb-sandbox-btn"
            dropdownId="sandbox-rb-sandbox-dropdown"
            icon="🛠"
            label="Sandbox"
            title="Sandbox actions — spawn a unit or clear the battlefield." />
          <${Dropdown} id="sandbox-rb-sandbox-dropdown" anchorId="sandbox-rb-sandbox-btn">
            <${MenuRow}
              icon="🛠"
              label="Spawn Unit"
              title="Spawn Unit — pick a unit and drop it on the battlefield with a click."
              dropdownId="sandbox-rb-sandbox-dropdown"
              onClick=${() => _bridge.openSpawnPicker(document.getElementById('sandbox-rb-sandbox-btn'))} />
            <${MenuRow}
              icon="🧹"
              label="Clear Field"
              title="Clear Field — remove every unit from the battlefield.  Asks for confirmation first."
              dropdownId="sandbox-rb-sandbox-dropdown"
              onClick=${() => _bridge.clearField()} />
          <//>
        </div>
      <//>
      <${RibbonSection} label="Orders">
        <${RibbonButton}
          id="sandbox-rb-move"
          icon="🚶"
          label="Move"
          title="Move — arm the next ground click as a move order for the current selection (right-click works without arming)."
          onClick=${() => _bridge.setPendingCommand('move')} />
        <${RibbonButton}
          id="sandbox-rb-attack"
          icon="🎯"
          label="Attack"
          title="Attack — arm the next unit click as an attack order for the current selection (right-click an enemy works without arming)."
          onClick=${() => _bridge.setPendingCommand('attack')} />
        <${RibbonButton}
          id="sandbox-rb-stop"
          icon="✋"
          label="Stop"
          title="Stop — clear move + attack orders on every selected unit."
          onClick=${() => _bridge.stopSelected()} />
      <//>
      <${RibbonSection} label="Selection">
        <${RibbonButton}
          id="sandbox-rb-select-all"
          icon="☑"
          label="All"
          title="Select All — pick every living unit on the field."
          onClick=${() => _bridge.selectAll()} />
        <${RibbonButton}
          id="sandbox-rb-deselect"
          icon="☐"
          label="None"
          title="Deselect — clear the current selection."
          onClick=${() => _bridge.deselectAll()} />
      <//>
      <${RibbonSection} label="Camera">
        <${RibbonButton}
          id="sandbox-rb-reset-cam"
          icon="📷"
          label="Reset"
          title="Reset Camera — recentre the camera on the spawn ring with the default angle and zoom."
          onClick=${() => _bridge.resetCamera()} />
      <//>
      <${RibbonSection} label="Developer Tools" right=${true} className="sandbox-rb-devtools-section">
        <div class="ribbon-dropdown" id="sandbox-rb-devtools-dropdown">
          <${RibbonDropdownButton}
            id="sandbox-rb-devtools-btn"
            dropdownId="sandbox-rb-devtools-dropdown"
            icon="🛠"
            label="Panels"
            title="Toggle visibility of the floating inspector panels." />
          <${Dropdown} id="sandbox-rb-devtools-dropdown" anchorId="sandbox-rb-devtools-btn" className="sandbox-rb-devtools-popup-cls">
            <${MenuToggleRow}
              icon="🎮"
              label="Developer Controls"
              title="Developer Controls — show / hide the editors at the bottom of the Controls panel that let you set Health, Build %, Build stance, and the other per-unit COB ports."
              on=${devVisible}
              onChange=${(next) => setControlsDevSectionVisible(next)} />
            ${_PANEL_ROWS.map((p) => html`
              <${_PanelToggle} key=${p.id} id=${p.id} icon=${p.icon} label=${p.label} title=${p.title} />
            `)}
          <//>
        </div>
      <//>
    <//>
  `
}

// closeSandboxRibbonDropdowns — host helper to dismiss any open
// sandbox-ribbon dropdown (e.g. on tab switch).  Cheap idempotent.
export function closeSandboxRibbonDropdowns() {
  closeDropdownById('sandbox-rb-sandbox-dropdown')
  closeDropdownById('sandbox-rb-devtools-dropdown')
}
