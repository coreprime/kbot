// resources-hud.js
//
// Sandbox economy bar, bottom-left. Per game-adapter resource (TA
// metal+energy, TA:K mana) it shows the side's live STOCK against its
// storage CAPACITY (a fill bar, both summed from the standing units' FBI
// storage fields), the generation rate (+solar/mex output, mana recharge)
// and the current build drain (−). Stocks integrate for real sim-side, but
// the sandbox never gates on them — the ∞ badge marks builds as free.
//
// Rides the shared 4 Hz inspector tick like the roster strip; only repaints
// when the rendered numbers actually change.

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
  _root.id = 'sandbox-economy-bar'
  _root.hidden = true
  dlg.appendChild(_root)
  return _root
}

// Field triplets per resource key: [stock, cap, gen, drainRate, spent].
const FIELDS = {
  metal: ['metalStock', 'metalCap', 'metalGen', 'metalRate', 'metalSpent'],
  energy: ['energyStock', 'energyCap', 'energyGen', 'energyRate', 'energySpent'],
  mana: ['manaStock', 'manaCap', 'manaGen', 'manaRate', 'manaSpent'],
}

// sum aggregates a field across every side — the sandbox has no "local
// player"; the bar reads the whole field's economy.
function sum(resources, field) {
  let v = 0
  for (const r of resources) v += r[field] || 0
  return v
}

function fmt(n) {
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

function update() {
  const view = hostCallbacks.getActiveSandboxView?.()
  const dlg = document.getElementById('model-viewer-dialog')
  const sandboxActive = dlg && dlg.classList.contains('sandbox-mode') && !dlg.classList.contains('hidden')
  const root = ensureRoot()
  if (!root) return
  const defs = activeGame().resources || []
  if (!sandboxActive || !view || !view.scene || defs.length === 0) {
    if (!root.hidden) { root.hidden = true; _last = '' }
    return
  }
  const resources = view.scene.resources || []
  const rows = []
  for (const def of defs) {
    const [stockF, capF, genF, rateF] = FIELDS[def.key] || []
    if (!stockF) continue
    const stock = sum(resources, stockF)
    const cap = sum(resources, capF)
    const gen = sum(resources, genF)
    const drain = sum(resources, rateF)
    const fill = cap > 0 ? Math.max(0, Math.min(1, stock / cap)) : 0
    rows.push(
      `<div class="eco-row" title="${def.label} — stock ${fmt(stock)} of ${fmt(cap)} capacity; +${gen.toFixed(1)}/s generated, −${drain.toFixed(1)}/s building. Builds never stall (∞).">`
      + `<span class="eco-label" style="color:${def.color}">${def.label}</span>`
      + `<span class="eco-bar"><span class="eco-fill" style="width:${(fill * 100).toFixed(1)}%;background:${def.color}"></span></span>`
      + `<span class="eco-stock">${fmt(stock)}<span class="eco-cap">/${fmt(cap)}</span></span>`
      + `<span class="eco-rates">+${gen.toFixed(1)} −${drain.toFixed(1)}</span>`
      + '<span class="eco-inf" title="Infinite — costs are accounted but never gate">∞</span>'
      + '</div>',
    )
  }
  const html = rows.join('')
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
