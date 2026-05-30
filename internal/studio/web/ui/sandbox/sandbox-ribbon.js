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

import { signal } from '@preact/signals'
import { htm as html } from '/ui/common/htm-bind.js'
import { mv as mvSignal, runtimeTick, controlsDevSectionVisible, setControlsDevSectionVisible } from '/ui/common/inspector-store.js'
import { panelSignals } from '/ui/common/panel-store.js'
import {
  Ribbon, RibbonSection, RibbonButton,
  RibbonDropdownButton, Dropdown, MenuRow, MenuToggleRow,
  closeDropdownById,
} from '/ui/common/ribbon.js'
import { SplitMenuItems } from '/ui/common/split-host.js'
import { GraphicsOptionsItems } from '/ui/common/graphics-options-menu.js'
import { getGraphicsOptions, persistGraphicsOptions } from '/ui/common/graphics-options-state.js'

// _gfx — the Graphics Options menu state for sandbox mode (mirrors the
// shared GraphicsOptionsItems shape).  Seeded from the persisted blob
// so a fresh sandbox paints the user's last-chosen look; the host also
// reseeds via setSandboxGraphicsState() once a view's renderer inits
// (prefs may load after this module is first evaluated).
const _gfx = signal(getGraphicsOptions())

// setSandboxGraphicsState — partial merge into the Graphics Options
// state.  Called by the menu rows (to keep ticks in sync with the
// user's choice) and by the host when it applies persisted prefs.
export function setSandboxGraphicsState(patch) {
  if (!patch) return
  _gfx.value = { ..._gfx.value, ...patch }
}

// _applyGfxPatch — the setState the shared menu calls.  Mirrors the
// chosen value into the live signal AND persists it so the look
// survives reloads + applies to every pane the host re-seeds.
function _applyGfxPatch(patch) {
  setSandboxGraphicsState(patch)
  persistGraphicsOptions(patch)
}

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
  splitActive:       (_orient) => {},
  closeActive:       () => {},
  canClose:          () => false,
  setPanelVisible:   (_panelId, _visible) => {},

  // Graphics Options — applied scene-wide across every sandbox pane.
  setShadows:           (_on) => {},
  setShadowIntensity:   (_v) => {},   // already normalised 0..1
  setSelfShadow:        (_on) => {},
  setReflections:       (_on) => {},
  setSpecular:          (_on) => {},
  setGodBeams:          (_on) => {},
  setDoF:               (_on) => {},
  setWaterReflections:  (_on) => {},
  setWaves:             (_on) => {},
  setWavesIntensity:    (_v) => {},
  setBob:               (_on) => {},
  setBobAmount:         (_v) => {},
  setBobSpeed:          (_v) => {},
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
    splitActive:       (_orient) => {},
    closeActive:       () => {},
    canClose:          () => false,
    setPanelVisible:   (_panelId, _visible) => {},
    setShadows:           (_on) => {},
    setShadowIntensity:   (_v) => {},
    setSelfShadow:        (_on) => {},
    setReflections:       (_on) => {},
    setSpecular:          (_on) => {},
    setMetalSpec:         (_on) => {},
    setGodBeams:          (_on) => {},
    setDoF:               (_on) => {},
    setDoFDistance:       (_v) => {},
    setDoFLevel:          (_v) => {},
    setCinematic:         (_on) => {},
    setCinematicStrength: (_v) => {},
    setBloom:             (_on) => {},
    setBloomStrength:     (_v) => {},
    setLensFlare:         (_on) => {},
    setLensFlareStrength: (_v) => {},
    setWaterReflections:  (_on) => {},
    setWaves:             (_on) => {},
    setWavesIntensity:    (_v) => {},
    setBob:               (_on) => {},
    setBobAmount:         (_v) => {},
    setBobSpeed:          (_v) => {},
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
  { id: 'mv-inspector-projectiles', icon: '🚀', label: 'Projectiles',
    title: 'Projectiles overlay — every in-flight bomb, missile, and rocket with origin, destination, speed, and the unit that launched it.  Group by family or by owner.' },
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

// GraphicsOptionsDropdown — the shared Graphics Options menu body
// (shadows + lighting effects + liquid simulation) inside a sandbox
// ribbon dropdown.  Reads _gfx.value so it re-renders whenever a row
// updates the state.  Bridge setters apply scene-wide across panes.
function GraphicsOptionsDropdown() {
  const s = _gfx.value
  return html`
    <div class="ribbon-dropdown" id="sandbox-rb-gfx-dropdown">
      <${RibbonDropdownButton}
        id="sandbox-rb-gfx-btn"
        dropdownId="sandbox-rb-gfx-dropdown"
        icon="🎨"
        label="Graphics"
        title="Shadows, lighting effects + liquid simulation — applied to the whole battlefield." />
      <${Dropdown} id="sandbox-rb-gfx-dropdown" anchorId="sandbox-rb-gfx-btn">
        <${GraphicsOptionsItems}
          s=${s}
          setState=${_applyGfxPatch}
          bridge=${_bridge} />
      <//>
    </div>
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
      <${RibbonSection} label="View">
        <div class="ribbon-dropdown" id="sandbox-rb-view-dropdown">
          <${RibbonDropdownButton}
            id="sandbox-rb-view-btn"
            dropdownId="sandbox-rb-view-dropdown"
            icon="👁"
            label="View"
            title="Camera and pane-layout controls." />
          <${Dropdown} id="sandbox-rb-view-dropdown" anchorId="sandbox-rb-view-btn">
            <${MenuRow}
              icon="📷"
              label="Reset Camera"
              title="Reset Camera — recentre the camera on the spawn ring with the default angle and zoom."
              dropdownId="sandbox-rb-view-dropdown"
              onClick=${() => _bridge.resetCamera()} />
            <${SplitMenuItems}
              dropdownId="sandbox-rb-view-dropdown"
              onSplitH=${() => _bridge.splitActive('h')}
              onSplitV=${() => _bridge.splitActive('v')}
              onClose=${() => _bridge.closeActive()}
              canClose=${() => _bridge.canClose()} />
          <//>
        </div>
      <//>
      <${RibbonSection} label="Graphics Options">
        <${GraphicsOptionsDropdown} />
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
  closeDropdownById('sandbox-rb-view-dropdown')
  closeDropdownById('sandbox-rb-gfx-dropdown')
  closeDropdownById('sandbox-rb-devtools-dropdown')
}
