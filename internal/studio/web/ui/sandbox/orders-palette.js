// orders-palette.js
//
// Sandbox command card — a boxed, vertical strip of order buttons pinned to the
// middle-left, styled as game UI (not a top-menu ribbon). The whole box slides
// in from the left when units are selected and slides back out when the
// selection clears. Icons are the game's own command cursors (per-game
// appropriate) where one exists; Stop gets an inline glyph.
//
// Only orders valid for the WHOLE selection are shown — the intersection of
// capabilities, so a mixed bag only offers what every selected unit can do:
// Move/Patrol need every unit mobile, Attack needs every unit armed, Repair
// needs every unit a mobile builder. Stop shows whenever anything is selected.
//
// Rides the shared 4 Hz inspector tick; rebuilds the button row only when the
// visible set or the armed command changes.

import { hostCallbacks } from '../host-context.js'
import { subscribeTick } from '../common/refresh-tick.js'

let _root = null
let _last = ''
let _wiredClicks = false

// `cursor` is the game's command-cursor stem served at /api/studio/cursor/<x>;
// null falls back to the inline glyph. `cmd` is the SandboxView pending-command
// (Stop is special-cased — it clears targets).
const ORDERS = [
  { cmd: 'move',   label: 'Move',   cursor: 'cursormove',   glyph: '🚶' },
  { cmd: 'attack', label: 'Attack', cursor: 'cursorattack', glyph: '🎯' },
  { cmd: 'patrol', label: 'Patrol', cursor: 'cursorpatrol', glyph: '🚩' },
  { cmd: 'repair', label: 'Repair', cursor: 'cursorrepair', glyph: '🔧' },
  { cmd: 'stop',   label: 'Stop',   cursor: null,           glyph: '■' },
]

function ensureRoot() {
  if (_root && _root.isConnected) return _root
  const dlg = document.getElementById('model-viewer-dialog')
  if (!dlg) return null
  _root = document.createElement('div')
  _root.id = 'sandbox-orders-palette'
  dlg.appendChild(_root)
  return _root
}

// capabilities — INTERSECTION over the selection: an order shows only if every
// selected unit supports it ("commonly available"). Move/Patrol need a mobile
// unit; Attack a declared weapon; Repair a mobile builder.
function capabilities(units) {
  const mobile = (m) => m && m.canMove !== false
  const armed = (m) => m && Array.isArray(m.weapons) && m.weapons.some((w) => w && w.name)
  const builder = (m) => mobile(m) && Array.isArray(m.buildOptions) && m.buildOptions.length > 0
  const all = (fn) => units.length > 0 && units.every((u) => fn(u && u.meta))
  const move = all(mobile)
  return { move, attack: all(armed), patrol: move, repair: all(builder), stop: units.length > 0 }
}

function dispatch(view, cmd) {
  if (cmd === 'stop') {
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

// iconHTML — the game's command cursor as the button glyph. innerHTML-built
// <img> bypasses the page's src shim, so the workspace base is applied by hand.
function iconHTML(o) {
  if (o.cursor) {
    const base = (typeof window !== 'undefined' && window.__WS_BASE__) || ''
    return `<img class="orders-icon" src="${base}/api/studio/cursor/${o.cursor}" alt="" draggable="false">`
  }
  return `<span class="orders-icon orders-icon-glyph">${o.glyph}</span>`
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
  const caps = capabilities(units)
  const shown = ORDERS.filter((o) => caps[o.cmd])
  if (shown.length === 0) {
    // Slide the box out (kept in the DOM so the transition plays); next show
    // rebuilds the row, so forget the last signature.
    if (root.classList.contains('shown')) { root.classList.remove('shown'); _last = '' }
    return
  }
  const armed = view._pendingCmd || ''
  const sig = shown.map((o) => o.cmd).join(',') + '|' + armed
  if (sig !== _last) {
    _last = sig
    root.innerHTML = shown.map((o) =>
      `<button class="orders-btn${armed === o.cmd ? ' armed' : ''}" data-cmd="${o.cmd}" title="${o.label}">`
      + iconHTML(o) + `<span class="orders-label">${o.label}</span>`
      + '</button>',
    ).join('')
  }
  root.classList.add('shown')
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
