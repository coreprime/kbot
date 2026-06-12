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

// Field tuples per resource key: [stock, cap, gen, drainRate, produced].
const FIELDS = {
  metal: ['metalStock', 'metalCap', 'metalGen', 'metalRate', 'metalProduced'],
  energy: ['energyStock', 'energyCap', 'energyGen', 'energyRate', 'energyProduced'],
  mana: ['manaStock', 'manaCap', 'manaGen', 'manaRate', 'manaProduced'],
}

// sum aggregates a field across every side — the sandbox has no "local
// player"; the bar reads the whole field's economy.
function sum(resources, field) {
  let v = 0
  for (const r of resources) v += r[field] || 0
  return v
}

// fmt renders friendly units: 200000 -> 200k, 1500000 -> 1.5M.
function fmt(n) {
  if (n >= 1e6) return `${trim((n / 1e6).toFixed(1))}M`
  if (n >= 1e5) return `${Math.round(n / 1000)}k`
  if (n >= 1e3) return `${trim((n / 1000).toFixed(1))}k`
  return String(Math.round(n))
}

function trim(s) {
  return s.endsWith('.0') ? s.slice(0, -2) : s
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
    const [stockF, capF, genF, rateF, prodF] = FIELDS[def.key] || []
    if (!stockF) continue
    const stock = sum(resources, stockF)
    const cap = sum(resources, capF)
    const gen = sum(resources, genF)
    const drain = sum(resources, rateF)
    const produced = sum(resources, prodF)
    const net = gen - drain
    const fill = cap > 0 ? Math.max(0, Math.min(1, stock / cap)) : 0
    const netCls = net >= 0 ? 'eco-rate-pos' : 'eco-rate-neg'
    const netTxt = `${net >= 0 ? '+' : '−'}${fmt(Math.abs(net))}/s`
    rows.push(
      `<div class="eco-row" title="${def.label} — ${fmt(stock)} of ${fmt(cap)} storage; +${fmt(gen)}/s generated, −${fmt(drain)}/s building; ${fmt(produced)} produced in total. Builds never stall (∞).">`
      + `<span class="eco-label" style="color:${def.color}">${def.label}</span>`
      + '<span class="eco-bar">'
      + `<span class="eco-fill" style="width:${(fill * 100).toFixed(1)}%;background:${def.color}"></span>`
      + `<span class="eco-bartext">${fmt(stock)} / ${fmt(cap)}</span>`
      + '</span>'
      + '<span class="eco-side">'
      + `<span class="eco-rate ${netCls}">${netTxt}</span>`
      + `<span class="eco-total">Σ ${fmt(produced)}</span>`
      + '</span>'
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
