// static-vars-panel.js
//
// React-rendered Unit Variables (formerly Static Vars) panel.
// Subscribes to the inspector store and renders a table of the COB
// unit's `static-var` globals.  Sandbox-aware empty states:
//
//   no cob.unit + selSize === 0   → "No Unit Selected"
//   no cob.unit + selSize > 1     → "Multiple units selected, variables unavailable."
//   single-unit viewer with no cob → "No COB loaded."
//
// Single-source-of-truth on the panel-store visibility signal: the
// FloatingPanel chrome handles the .hidden class, the body's heavy
// loop bails when not visible so the 4 Hz refresh tick stays cheap
// in the common case (panel collapsed / closed / sandbox idle).

import { htm as html } from '@kbot/ui/htm-bind'
import { FloatingPanel } from '@kbot/ui/floating-panel'
import { panelSignals } from '@kbot/ui/panel-store'
import { mv, sandboxActive, sandboxSelSize, runtimeTick } from '/ui/common/inspector-store.js'

const PANEL_ID = 'mv-inspector-staticvars'

function emptyMessage() {
  const cob = mv.value && mv.value.cob
  if (cob && cob.unit) return null  // not empty — body will render rows
  if (sandboxActive.value) {
    return sandboxSelSize.value > 1
      ? 'Multiple units selected, variables unavailable.'
      : 'No Unit Selected'
  }
  return 'No COB loaded.'
}

// StaticVarsBody — pure subscriber.  Reads the inspector signals on
// every render; Preact + the @preact/signals integration only re-
// invokes the function when one of those .value reads changes.
function StaticVarsBody() {
  const { visible } = panelSignals(PANEL_ID)
  // Subscribe to runtimeTick so per-publish refresh re-reads the
  // unit's staticVars array — in unit-editor mode mv.value's
  // reference doesn't change between ticks, so without this read
  // a script setting a global wouldn't surface in the panel until
  // a tab switch / model reload.
  void runtimeTick.value
  // Cheap early-out: a hidden / collapsed panel has nothing to draw,
  // and reading the signals here still keeps us subscribed for when
  // visibility flips back on.
  if (!visible.value) return null
  const msg = emptyMessage()
  if (msg !== null) {
    return html`<div class="mv-inspector-empty">${msg}</div>`
  }
  const vars = mv.value.cob.unit.staticVars
  if (!vars || vars.length === 0) {
    return html`<div class="mv-inspector-empty">No static vars.</div>`
  }
  // Render rows.  Keys = index since the slot's identity is its
  // position in the COB's globals array, never its value.
  return vars.map((v, i) => html`
    <div class="mv-staticvar-row" key=${i}>
      <span class="mv-sv-name">global_${i}</span>
      <span class="mv-sv-value">${v | 0}</span>
    </div>
  `)
}

export function StaticVarsPanel() {
  return html`
    <${FloatingPanel} id=${PANEL_ID} title="Script Variables">
      <${StaticVarsBody} />
    <//>
  `
}
