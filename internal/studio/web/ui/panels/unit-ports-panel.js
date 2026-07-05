// unit-ports-panel.js
//
// Read-only "Unit Ports" overlay — surfaces the live values of TA's
// well-known unit-value ports (ACTIVATION, STANDINGMOVEORDERS,
// STANDINGFIREORDERS, HEALTH, INBUILDSTANCE, BUILD_PERCENT_LEFT,
// YARD_OPEN, BUGGER_OFF, ARMORED) so the user can watch a script
// flip them without opening the Controls panel.
//
// Mirrors the Static Vars / Unit Variables panel's shape: the body
// subscribes to runtimeTick and re-reads mv.value.cobPorts each
// publish.  Sandbox-aware empty states match the Static Vars panel
// so the sandbox single-selection rule (one focused unit -> show
// values, zero/many -> empty message) feels uniform across the
// two read-only inspectors.
//
// Display is value-only — no editors.  The Controls panel keeps the
// editable slider/toggle UI; this one is the at-a-glance "what's the
// COB reading right now" view, similar to how Unit Variables surfaces
// static globals without an inline editor.

import { htm as html } from '@coreprime/kbot-ui/htm-bind'
import { FloatingPanel } from '@coreprime/kbot-ui/floating-panel'
import { panelSignals } from '@coreprime/kbot-ui/panel-store'
import { mv, sandboxActive, sandboxSelSize, runtimeTick } from '/ui/common/inspector-store.js'

const PANEL_ID = 'mv-inspector-unit-ports'

// _PORT_ROWS — every row this panel draws, in display order.  Each
// row knows how to read its raw integer value from the active mv
// proxy (which mirrors the live ModelViewer / CobBinding) and how
// to format that integer into a human label.  Keeping the read
// function inline makes the panel one place to look when the engine
// adds a new port; no separate adapter layer.
const _PORT_ROWS = [
  { key: 'activation',        label: 'Active',           portId: 1,
    read: (mv) => mv.cobPorts?.activation | 0,
    format: (v) => v === 1 ? 'On' : 'Off',
    tip: 'GET ACTIVATION — non-zero when the unit is "on" (factory producing, radar broadcasting, etc.).' },
  { key: 'moveOrders',        label: 'Move orders',      portId: 2,
    read: (mv) => mv.cobPorts?.moveOrders | 0,
    format: (v) => v === 0 ? 'Hold' : v === 1 ? 'Maneuver' : v === 2 ? 'Roam' : String(v),
    tip: 'GET STANDINGMOVEORDERS — 0 Hold / 1 Maneuver / 2 Roam.  Patrol AI reads this to decide whether to step toward an enemy.' },
  { key: 'fireOrders',        label: 'Fire orders',      portId: 3,
    read: (mv) => mv.cobPorts?.fireOrders | 0,
    format: (v) => v === 0 ? 'Hold' : v === 1 ? 'Return' : v === 2 ? 'Fire at will' : String(v),
    tip: 'GET STANDINGFIREORDERS — 0 Hold / 1 Return / 2 Fire at will.  Weapon scripts read this to gate Fire* threads.' },
  { key: 'health',            label: 'Health',           portId: 4,
    read: (mv) => Math.max(0, 100 - ((mv.cobDamage | 0))),
    format: (v) => `${v}%`,
    tip: 'GET HEALTH — 0..100.  Damage-state scripts and SmokeUnit poll this; synced with the Controls panel Damage slider.' },
  { key: 'inBuildStance',     label: 'In build stance',  portId: 5,
    read: (mv) => mv.cobPorts?.inBuildStance | 0,
    format: (v) => v === 1 ? 'Yes' : 'No',
    tip: 'GET INBUILDSTANCE — toggled by factory scripts via SET_VALUE while assembling a unit.' },
  { key: 'buildPercentLeft',  label: 'Build % left',     portId: 17,
    read: (mv) => Math.max(0, 100 - ((mv.cobBuildPercent | 0))),
    format: (v) => `${v}%`,
    tip: 'GET BUILD_PERCENT_LEFT — 100 = nothing built, 0 = fully built.  SmokeUnit blocks on this during early-build.' },
  { key: 'yardOpen',          label: 'Yard open',        portId: 18,
    read: (mv) => mv.cobPorts?.yardOpen | 0,
    format: (v) => v === 1 ? 'Yes' : 'No',
    tip: 'GET YARD_OPEN — factory door state.  Set by factory scripts via SET_VALUE during the build cycle.' },
  { key: 'buggerOff',         label: 'Bugger off',       portId: 19,
    read: (mv) => mv.cobPorts?.buggerOff | 0,
    format: (v) => v === 1 ? 'Yes' : 'No',
    tip: 'GET BUGGER_OFF — factory tells units it has produced to clear the rally point.  Set by SET_VALUE.' },
  { key: 'armoured',          label: 'Armoured',         portId: 20,
    read: (mv) => mv.cobPorts?.armoured | 0,
    format: (v) => v === 1 ? 'Yes' : 'No',
    tip: 'GET ARMORED — armour plating engaged.  Flipped by damage scripts via SET_VALUE.' },
]

// emptyMessage — mirrors StaticVarsPanel's empty-state semantics so
// the two panels feel uniform when no unit / multiple units are
// selected.  Returns null when there's a single live cob to render
// against, otherwise the message to display in place of the rows.
function emptyMessage() {
  const cob = mv.value && mv.value.cob
  if (cob && cob.unit) return null
  if (sandboxActive.value) {
    return sandboxSelSize.value > 1
      ? 'Multiple units selected, ports unavailable.'
      : 'No Unit Selected'
  }
  return 'No COB loaded.'
}

function UnitPortsBody() {
  const { visible } = panelSignals(PANEL_ID)
  void runtimeTick.value
  if (!visible.value) return null
  const msg = emptyMessage()
  if (msg !== null) {
    return html`<div class="mv-inspector-empty">${msg}</div>`
  }
  const proxy = mv.value
  return _PORT_ROWS.map((row) => {
    const raw = row.read(proxy)
    return html`
      <div class="mv-unit-port-row" key=${row.key} data-port=${row.key} title=${row.tip}>
        <span class="mv-unit-port-id">${row.portId}</span>
        <span class="mv-unit-port-name">${row.label}</span>
        <span class="mv-unit-port-value">${row.format(raw)}</span>
      </div>
    `
  })
}

export function UnitPortsPanel() {
  return html`
    <${FloatingPanel} id=${PANEL_ID} title="I/O Ports">
      <${UnitPortsBody} />
    <//>
  `
}
