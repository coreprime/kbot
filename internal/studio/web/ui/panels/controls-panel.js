// controls-panel.js
//
// React-rendered Controls overlay — the panel that combines a unit-
// driver action grid (Move / Primary / Secondary / Tertiary / Stop /
// Reset) with the per-port editor surface below it (Move orders /
// Fire orders / Active / Health / Build stance / Build % / Armoured).
//
// Special wrinkle: the action grid keeps its DOM-attached event
// handlers intact because MvControls (single-unit mode) and the
// sandbox controls-intercept (multi-unit mode) both wire click
// listeners + write `disabled` / `armed` / `live` classes onto the
// individual buttons.  Preact re-renders would normally wipe those
// imperative writes.  The trick: render the action grid HTML ONCE
// via `dangerouslySetInnerHTML` (a constant string), then let the
// host code own the buttons.  React still controls the surrounding
// chrome — visibility of the Create banner, the sandbox empty row,
// and the per-port body — but never touches the grid's children.
//
// The body, in contrast, IS fully React.  Each port row is a small
// component that writes through to mv.cobPorts / cobDamage /
// cobBuildPercent directly on change — same source of truth the
// legacy renderMvPortsPanel hit, no imperative refresh needed.

import { useRef, useLayoutEffect } from 'preact/hooks'
import { htm as html } from '/ui/common/htm-bind.js'
import { FloatingPanel } from '/ui/common/floating-panel.js'
import { panelSignals } from '/ui/common/panel-store.js'
import { mv, sandboxActive, sandboxSelSize, runtimeTick, controlsDevSectionVisible } from '/ui/common/inspector-store.js'
import { hostBridge } from '/ui/common/host-bridge.js'
import { PortChoiceRow, PortToggleRow, PortChipRow, PortSliderRow } from '/ui/unit-editor/panels/port-rows.js'

const PANEL_ID = 'mv-inspector-ports'

// Static HTML for the action grid.  Frozen so React's
// dangerouslySetInnerHTML sees the same string each render and skips
// the innerHTML write — MvControls' / sandbox-intercept's click
// listeners survive across every panel re-render.  Mirrors the
// legacy template byte-for-byte so the existing CSS + JS selectors
// (#mv-controls-actions, .mv-ctrl-action, data-ctrl-action, etc.)
// match.
//
// The per-port editor surface below the grid is wrapped in
// `.mv-controls-port-body` (NOT `.mv-inspector-body`) so the gated-
// state CSS rule can dim it without also dimming the Create banner.
// The Create banner sits ABOVE the grid as a sibling of the
// FloatingPanel-wrapped body; if both surfaces shared the
// `.mv-inspector-body` class the gating selector would catch the
// banner too and the user couldn't click "Create Unit" on an unborn
// unit (which is exactly when the banner appears).
const ACTION_GRID_HTML = `
  <button class="mv-ctrl-action" data-ctrl-action="move" disabled
          title="Move — click here, then click in the scene to walk the unit there at its FBI-defined speed.  StartMoving / StopMoving scripts fire when those exist.">
    <span class="ico">🚶</span><span class="lbl">Move</span>
  </button>
  <button class="mv-ctrl-action" data-ctrl-action="primary" disabled
          title="Primary weapon — click here, then click in the scene to lock the primary aim.  AimPrimary fires each tick; when it returns 1 FirePrimary fires at the weapon's reload rate.">
    <span class="ico">🎯</span><span class="lbl">Primary</span>
  </button>
  <button class="mv-ctrl-action" data-ctrl-action="secondary" disabled
          title="Secondary weapon — click here, then click in the scene to lock the secondary aim.  Stored target is independent of Primary's.">
    <span class="ico">🎯</span><span class="lbl">Secondary</span>
  </button>
  <button class="mv-ctrl-action" data-ctrl-action="tertiary" disabled
          title="Tertiary weapon — click here, then click in the scene to lock the tertiary aim.  Stored target is independent of the other two.">
    <span class="ico">🎯</span><span class="lbl">Tertiary</span>
  </button>
  <button class="mv-ctrl-action mv-ctrl-action-stop" data-ctrl-action="stop"
          title="Stop — clear every move + aim target on this unit.  The walk loop halts (StopMoving fires when defined) and Aim*/Fire* schedulers drop their targets.">
    <span class="ico">✋</span><span class="lbl">Stop</span>
  </button>
  <button class="mv-ctrl-action mv-ctrl-action-reset" id="mv-controls-reset-btn" disabled
          title="Reset is only available after the unit has been created.">
    <span class="ico">↺</span><span class="lbl">Reset</span>
  </button>
`

// _stopProp — drag-suppression helper shared by every interactive
// chunk inside the panel.  Without it, mousedown bubbles into the
// FloatingPanel header drag handler and the user's intended click
// turns into a panel drag start.
const _stopProp = (e) => e.stopPropagation()

function CreateBanner({ onClick }) {
  return html`
    <div class="mv-controls-create-row">
      <button class="btn primary mv-controls-create-btn"
              title="Run the unit's Create script — initialises piece visibility / poses and unlocks the Move / Aim / Fire controls."
              onClick=${(e) => { _stopProp(e); onClick() }}
              onPointerDown=${_stopProp}
              onMouseDown=${_stopProp}>
        ⚙ Create Unit
      </button>
    </div>
  `
}

function EmptyRow() {
  return html`
    <div class="mv-controls-empty-row">
      <div class="mv-inspector-empty">No Units Selected</div>
    </div>
  `
}

function ControlsBody() {
  const proxy = mv.value
  // Tick read — re-render every publish so port edits + script-driven
  // SET_VALUE flips (factories toggling IN_BUILD_STANCE, damage
  // scripts setting ARMORED) surface immediately.
  void runtimeTick.value
  if (!proxy || !proxy.cob) return null
  const ports = proxy.cobPorts
  if (!ports) return null
  const um = proxy.unitMeta || {}
  const cob = proxy.cob
  // Same capability gating the legacy renderMvPortsPanel used —
  // showActive comes from onoffable=1 in FBI; showMoveFire from
  // canMove or isBuilder; showBuildStance from isBuilder; showArmoured
  // from the COB statically referencing UV_ARMORED via GET/SET.
  const showActive = (um.onoffable === true || um.onoffable === 1)
  const showMoveFire = !!(um.canMove || um.isBuilder)
  const showBuildStance = !!um.isBuilder
  const showArmoured = !!(cob.unit && cob.unit.usesUnitValuePort && cob.unit.usesUnitValuePort(20))
  const setBuildPercent = (pct) => {
    if (proxy._autoBuild) proxy._autoBuild = null
    if (typeof proxy.setBuildPercent === 'function') proxy.setBuildPercent(pct)
    else proxy.cobBuildPercent = pct
  }
  return html`
    ${showMoveFire ? html`
      <${PortChoiceRow}
        label="Move orders" portKey="moveOrders" current=${ports.moveOrders}
        options=${[
          ['Hold',     0, 'Hold Position — never leave the spot'],
          ['Maneuver', 1, 'Maneuver — move only to gain line of sight'],
          ['Roam',     2, 'Roam — chase enemies freely (default)'],
        ]}
        tip="GET STANDINGMOVEORDERS — patrol AI scripts read this to decide whether to step toward an enemy.  Factories pass the value to units they produce."
        onChange=${(v) => { ports.moveOrders = v }} />
      <${PortChoiceRow}
        label="Fire orders" portKey="fireOrders" current=${ports.fireOrders}
        options=${[
          ['Hold',         0, 'Hold Fire — never engage'],
          ['Return',       1, 'Return Fire — only shoot back when attacked'],
          ['Fire at will', 2, 'Fire at Will — engage anything in range (default)'],
        ]}
        tip="GET STANDINGFIREORDERS — weapon scripts read this to gate Fire* threads.  Factories pass the value to units they produce."
        onChange=${(v) => { ports.fireOrders = v }} />
    ` : null}
    <div class="mv-port-dev-section">
      ${showActive ? html`
        <${PortToggleRow}
          label="Active" portKey="activation" on=${ports.activation === 1}
          tip='GET ACTIVATION returns 1 when the unit is "on" (factory producing, radar broadcasting, etc.).'
          onChange=${(on) => { ports.activation = on ? 1 : 0 }} />
      ` : null}
      <${PortSliderRow}
        label="Health" portKey="health"
        value=${Math.max(0, 100 - (proxy.cobDamage | 0))}
        tip="GET HEALTH returns this 0–100 value.  Drives SmokeUnit + damage-state scripts.  Synced with the COB ribbon's Damage slider."
        onInput=${(v) => { proxy.cobDamage = Math.max(0, Math.min(100, 100 - v)) }} />
      ${showBuildStance ? html`
        <${PortChipRow}
          label="In build stance" portKey="inBuildStance"
          yes=${ports.inBuildStance === 1}
          tip="GET INBUILDSTANCE — set by factory scripts via SET_VALUE while assembling a unit.  Read-only here; toggled by the running script." />
      ` : null}
      <${PortSliderRow}
        label="Build % left" portKey="buildPercentLeft"
        value=${Math.max(0, 100 - (proxy.cobBuildPercent | 0))}
        tip="GET BUILD_PERCENT_LEFT — 100 means nothing built yet, 0 means fully built.  Synced with the COB ribbon's Build slider."
        onInput=${(v) => setBuildPercent(Math.max(0, Math.min(100, 100 - v)))} />
      ${showArmoured ? html`
        <${PortChipRow}
          label="Armoured" portKey="armoured"
          yes=${ports.armoured === 1}
          tip="GET ARMORED returns 1 when the unit's armour plating is engaged.  Read-only here; flipped by damage scripts via SET_VALUE." />
      ` : null}
    </div>
  `
}

export function ControlsPanel() {
  const { visible } = panelSignals(PANEL_ID)
  // Reading these in the render body subscribes the component to
  // their changes — re-renders fire on each inspector publish + on
  // user toggles of the developer-section visibility.
  void visible.value
  void runtimeTick.value
  const proxy = mv.value
  const cob = proxy && proxy.cob
  const lifecycle = cob && cob._lifecycle
  const hasCreate = !!(cob && cob.hasScript && cob.hasScript('Create'))
  const blocked = !cob || lifecycle === 'unborn' || lifecycle === 'creating'
  const showCreate = !!cob && hasCreate && lifecycle === 'unborn'
  const sandbox = sandboxActive.value
  const selSize = sandboxSelSize.value
  const sandboxNoSel = sandbox && selSize === 0
  // Visibility for the three swap-row slots — exactly one of
  // "Create banner / action grid / sandbox empty row" is shown at a
  // time.  The other two render with display:none so MvControls'
  // click listeners on the action-grid buttons survive across the
  // toggles (preserved DOM = preserved listeners).
  const showCreateRow = showCreate
  const showEmptyRow  = !showCreate && sandboxNoSel
  const showGrid      = !showCreate && !sandboxNoSel
  // Body display — hidden when sandbox is in zero / multi selection
  // (no single focused unit to drive the per-port editors against).
  const showBody = !sandbox || selSize === 1
  // Reset-button live state is the one piece of the grid React still
  // owns — it's expressed as an attribute on a fixed-id button, so
  // setting it through a useLayoutEffect-style ref doesn't conflict
  // with MvControls (which never touches Reset's disabled flag).
  const canReset = !!cob && lifecycle === 'created'
  // Combine the chrome-level classes the legacy panel needs:
  //   mv-controls-gated     — opacity + pointer-events:none on grid+body
  //   mv-controls-no-dev    — hide the developer-port-section in sandbox
  const devVisible = controlsDevSectionVisible.value
  const panelClassName = [
    blocked ? 'mv-controls-gated' : '',
    devVisible ? '' : 'mv-controls-no-dev',
  ].filter(Boolean).join(' ')
  const onCreate = () => { hostBridge.runControlsCreate() }
  // Action-grid title tooltip — explains the gated state when the
  // grid is visible but inert (Create thread running).
  const gridTitle = (blocked && !showCreate)
    ? 'Create script running — controls activate once it finishes.'
    : undefined
  return html`
    <${FloatingPanel} id=${PANEL_ID} title="Controls" className=${panelClassName}>
      <div class="mv-controls-create-row" style=${showCreateRow ? '' : 'display:none'}>
        ${showCreateRow ? html`<${CreateBanner} onClick=${onCreate} />` : null}
      </div>
      <div class="mv-controls-empty-row" style=${showEmptyRow ? '' : 'display:none'}>
        ${showEmptyRow ? html`<${EmptyRow} />` : null}
      </div>
      <${ActionGrid} visible=${showGrid} canReset=${canReset} title=${gridTitle} />
      <div class="mv-controls-port-body" style=${showBody ? '' : 'display:none'}>
        ${showBody ? html`<${ControlsBody} />` : null}
      </div>
    <//>
  `
}

// ActionGrid — fixed-shape container the host wires into.  Inner
// buttons go in via dangerouslySetInnerHTML so React's diff never
// touches them; preserved across every parent re-render so the
// listeners MvControls / sandbox-intercept attached at boot stay
// alive for the panel's lifetime.  Reset's disabled state is the
// one React-owned attribute (set via a ref after the grid mounts).
function ActionGrid({ visible, canReset, title }) {
  const ref = useRef(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const reset = el.querySelector('#mv-controls-reset-btn')
    if (reset) {
      reset.disabled = !canReset
      reset.title = canReset
        ? 'Reset State — revert the unit to its pre-Create state: clear threads, animators, particles, audio, weapon history, and replay the build animation.'
        : 'Reset is only available after the unit has been created.'
    }
  }, [canReset])
  return html`
    <div ref=${ref}
         class="mv-controls-actions" id="mv-controls-actions"
         style=${visible ? '' : 'display:none'}
         title=${title || ''}
         dangerouslySetInnerHTML=${{ __html: ACTION_GRID_HTML }}></div>
  `
}
