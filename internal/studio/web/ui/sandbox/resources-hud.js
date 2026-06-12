// resources-hud.js
//
// Sandbox resource readout. The sim drains each unit's FBI price linearly
// over its construction and reports per-side spent totals + current
// drain-per-second on every snapshot; pools are INFINITE in the sandbox, so
// this is a usage meter, not a constraint — the ∞ stock makes that explicit.
// Which resources exist (TA metal+energy, TA:K mana) comes from the game
// adapter's resources table.
//
// Rides the shared 4 Hz inspector tick like the roster strip; only repaints
// when the rendered text actually changes.

import { hostCallbacks } from '../host-context.js'
import { subscribeTick } from '../common/refresh-tick.js'
import { activeGame } from '../common/game-registry.js'

let _root = null
let _last = ''

function ensureRoot() {
  if (_root && _root.isConnected) return _root
  const dlg = document.getElementById('model-viewer-dialog')
  if (!dlg) return null
  _root = document.createElement('div')
  _root.id = 'sandbox-resource-hud'
  _root.hidden = true
  dlg.appendChild(_root)
  return _root
}

// rateFor sums the named rate across every side — the sandbox has no "local
// player", and the meter is about what the field is consuming overall.
function sumField(resources, field) {
  let v = 0
  for (const r of resources) v += r[field] || 0
  return v
}

const FIELDS = {
  metal: ['metalRate', 'metalSpent'],
  energy: ['energyRate', 'energySpent'],
  mana: ['manaRate', 'manaSpent'],
}

function update() {
  const view = hostCallbacks.getActiveSandboxView?.()
  const dlg = document.getElementById('model-viewer-dialog')
  const sandboxActive = dlg && dlg.classList.contains('sandbox-mode') && !dlg.classList.contains('hidden')
  const root = ensureRoot()
  if (!root) return
  if (!sandboxActive || !view || !view.scene) {
    if (!root.hidden) { root.hidden = true; _last = '' }
    return
  }
  const resources = view.scene.resources || []
  const defs = activeGame().resources || []
  if (defs.length === 0) {
    if (!root.hidden) { root.hidden = true; _last = '' }
    return
  }
  const parts = []
  for (const def of defs) {
    const [rateField, spentField] = FIELDS[def.key] || []
    if (!rateField) continue
    const rate = sumField(resources, rateField)
    const spent = sumField(resources, spentField)
    parts.push(
      `<span class="res-item" title="${def.label} — infinite stock; drain reflects active builds">`
      + `<span class="res-label" style="color:${def.color}">${def.label}</span>`
      + `<span class="res-stock">∞</span>`
      + `<span class="res-rate">${rate > 0.05 ? `−${rate.toFixed(1)}/s` : '—'}</span>`
      + `<span class="res-spent">${spent >= 1 ? `${Math.round(spent)} used` : ''}</span>`
      + '</span>',
    )
  }
  const html = parts.join('')
  if (html === _last && !root.hidden) return
  _last = html
  root.hidden = false
  root.innerHTML = html
}

let _wired = false
export function wireResourcesHud() {
  if (_wired) return
  _wired = true
  subscribeTick(() => update())
}
