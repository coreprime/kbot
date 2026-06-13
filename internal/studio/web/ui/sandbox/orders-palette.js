// orders-palette.js
//
// Sandbox command card — a vertical strip of order buttons pinned to the
// middle-left, styled as game UI (like the economy bar) rather than a top-menu
// ribbon. Only the orders valid for the current selection are shown:
// Move/Patrol for anything mobile, Attack for anything armed, Repair for
// mobile builders, Stop whenever a unit is selected. The armed command
// highlights. Rides the shared 4 Hz inspector tick; rebuilds only when the
// visible set or the armed command changes, and hides with an empty selection.

import { hostCallbacks } from '../host-context.js'
import { subscribeTick } from '../common/refresh-tick.js'

let _root = null
let _last = ''
let _wiredClicks = false

// Order definitions mirror the legacy ribbon's Orders section. `cmd` is the
// SandboxView pending-command id (Stop is special-cased — it clears targets).
const ORDERS = [
  { cmd: 'move',   icon: '🚶', label: 'Move' },
  { cmd: 'attack', icon: '🎯', label: 'Attack' },
  { cmd: 'patrol', icon: '🚩', label: 'Patrol' },
  { cmd: 'repair', icon: '🔧', label: 'Repair' },
  { cmd: 'stop',   icon: '✋', label: 'Stop' },
]

function ensureRoot() {
  if (_root && _root.isConnected) return _root
  const dlg = document.getElementById('model-viewer-dialog')
  if (!dlg) return null
  _root = document.createElement('div')
  _root.id = 'sandbox-orders-palette'
  _root.hidden = true
  dlg.appendChild(_root)
  return _root
}

// capabilities — union over the selection: an order shows if ANY selected unit
// supports it, matching the command-card convention. Move/Patrol need a mobile
// unit; Attack needs a declared weapon; Repair needs a mobile builder.
function capabilities(units) {
  let move = false, attack = false, build = false
  for (const u of units) {
    const m = u && u.meta
    if (!m) continue
    const mobile = m.canMove !== false
    if (mobile) move = true
    if (Array.isArray(m.weapons) && m.weapons.some((w) => w && w.name)) attack = true
    if (mobile && Array.isArray(m.buildOptions) && m.buildOptions.length > 0) build = true
  }
  return { move, attack, patrol: move, repair: build, stop: units.length > 0 }
}

function dispatch(view, cmd) {
  if (cmd === 'stop') {
    // Wipe move + attack targets on every selected unit so the sandbox driver
    // sees "no command" next tick (mirrors the old ribbon Stop), then disarm
    // any pending click-command.
    const scene = view.scene
    if (scene) {
      for (const id of scene.selected) {
        const u = scene.unitById ? scene.unitById(id) : null
        if (u) { u.moveTarget = null; u.attackTarget = null }
      }
    }
    if (view._pendingCmd) view.setPendingCommand(null)
    return
  }
  view.setPendingCommand(cmd)
}

function update() {
  const view = hostCallbacks.getActiveSandboxView?.()
  const dlg = document.getElementById('model-viewer-dialog')
  const sandboxActive = dlg && dlg.classList.contains('sandbox-mode') && !dlg.classList.contains('hidden')
  const root = ensureRoot()
  if (!root) return
  const units = (sandboxActive && view && typeof view.getSelectedUnits === 'function')
    ? view.getSelectedUnits().filter((u) => u && !u.dead)
    : []
  if (units.length === 0) {
    if (!root.hidden) { root.hidden = true; _last = '' }
    return
  }
  const caps = capabilities(units)
  const armed = view._pendingCmd || ''
  const shown = ORDERS.filter((o) => caps[o.cmd])
  const sig = shown.map((o) => o.cmd).join(',') + '|' + armed
  if (sig === _last && !root.hidden) return
  _last = sig
  root.hidden = false
  root.innerHTML = shown.map((o) =>
    `<button class="orders-btn${armed === o.cmd ? ' armed' : ''}" data-cmd="${o.cmd}" title="${o.label}">`
    + `<span class="orders-icon">${o.icon}</span><span class="orders-label">${o.label}</span>`
    + '</button>',
  ).join('')
  if (!_wiredClicks) {
    _wiredClicks = true
    root.addEventListener('click', (e) => {
      const btn = e.target.closest?.('.orders-btn')
      if (!btn) return
      const v = hostCallbacks.getActiveSandboxView?.()
      if (v) dispatch(v, btn.dataset.cmd)
    })
  }
}

let _wired = false
export function wireOrdersPalette() {
  if (_wired) return
  _wired = true
  subscribeTick(() => update())
}
