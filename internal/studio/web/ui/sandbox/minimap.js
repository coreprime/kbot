// minimap.js
//
// Sandbox mini-map, bottom-right: every live unit as a team-coloured dot
// over an auto-fitted world extent (square, padded, never tighter than
// ±300wu so a small skirmish doesn't fill the frame). Selected units ring
// white.
//
// Clicks command: clicking a unit selects it; with a selection held,
// clicking an OPPOSING unit orders the attack instead (shift queues it) —
// the same semantics as clicking the unit in the 3D view. Clicking empty
// map ground with a selection issues a move (shift queues), so the map
// doubles as a long-range order surface.
//
// Redraws on the shared 4 Hz inspector tick.

import { hostCallbacks } from '../host-context.js'
import { subscribeTick } from '../common/refresh-tick.js'
import { displayRgbForSide } from '@kbot/game3d/team-colors'

const SIZE = 184
const MIN_EXTENT = 300 // wu half-width floor for the auto-fit

let _root = null
let _canvas = null
// Live world→map transform from the latest draw, reused by the click
// handler: world = (px - SIZE/2) / scale + cx.
let _view = { cx: 0, cz: 0, scale: 1 }

function ensureRoot() {
  if (_root && _root.isConnected) return _root
  const dlg = document.getElementById('model-viewer-dialog')
  if (!dlg) return null
  _root = document.createElement('div')
  _root.id = 'sandbox-minimap'
  _root.hidden = true
  _canvas = document.createElement('canvas')
  _canvas.width = SIZE
  _canvas.height = SIZE
  _root.appendChild(_canvas)
  _canvas.addEventListener('click', onClick)
  _canvas.addEventListener('contextmenu', (e) => e.preventDefault())
  dlg.appendChild(_root)
  return _root
}

function activeView() {
  const view = hostCallbacks.getActiveSandboxView?.()
  const dlg = document.getElementById('model-viewer-dialog')
  const sandboxActive = dlg && dlg.classList.contains('sandbox-mode') && !dlg.classList.contains('hidden')
  return (sandboxActive && view && view.scene) ? view : null
}

function liveUnits(view) {
  const out = []
  for (const u of view.scene.units()) {
    if (u && !u.dead) out.push(u)
  }
  return out
}

// mapToWorld / worldToMap convert through the last draw's fitted transform.
function worldToMap(x, z) {
  return [
    SIZE / 2 + (x - _view.cx) * _view.scale,
    SIZE / 2 + (z - _view.cz) * _view.scale,
  ]
}

function mapToWorld(px, py) {
  return [
    (px - SIZE / 2) / _view.scale + _view.cx,
    (py - SIZE / 2) / _view.scale + _view.cz,
  ]
}

function onClick(e) {
  const view = activeView()
  if (!view) return
  const rect = _canvas.getBoundingClientRect()
  const px = (e.clientX - rect.left) * (SIZE / rect.width)
  const py = (e.clientY - rect.top) * (SIZE / rect.height)
  // Nearest unit within a comfortable thumb radius.
  let hit = null
  let hitD = 10 // px
  for (const u of liveUnits(view)) {
    const [ux, uy] = worldToMap(u.pos.x, u.pos.z)
    const d = Math.hypot(ux - px, uy - py)
    if (d < hitD) { hit = u; hitD = d }
  }
  const sel = view.getSelectedUnits()
  if (hit) {
    const sameTeam = sel.length > 0 && sel.every((s) => (s.side | 0) === (hit.side | 0))
    if (sel.length > 0 && !view.scene.selected.has(hit.id) && !sameTeam) {
      const queued = !!e.shiftKey
      const n = view.issueAttack(hit, queued)
      view.setStatus(`${queued ? 'Attack queued' : 'Attack'} via mini-map — ${n} unit(s) on ${hit.name}.`)
      return
    }
    view.scene.selectClear()
    view.scene.selectAdd(hit.id)
    view.setStatus(`Selected ${hit.name} via mini-map.`)
    return
  }
  if (sel.length > 0) {
    const [wx, wz] = mapToWorld(px, py)
    const queued = !!e.shiftKey
    const n = view.issueMove([wx, 0, wz], queued)
    view.setStatus(`${queued ? 'Move queued' : 'Move'} via mini-map — ${n} unit(s) to (${wx.toFixed(0)}, ${wz.toFixed(0)}).`)
  }
}

function draw() {
  const view = activeView()
  const root = ensureRoot()
  if (!root) return
  if (!view) {
    if (!root.hidden) root.hidden = true
    return
  }
  const units = liveUnits(view)
  root.hidden = false
  // Extent: a loaded battlefield pins the view to the whole map (its
  // terrain render is the backdrop); The Grid keeps the unit auto-fit,
  // floored at MIN_EXTENT.
  const smap = view._sandboxMap
  let cx = 0, cz = 0, half = MIN_EXTENT
  if (smap) {
    cx = smap.worldW / 2
    cz = smap.worldH / 2
    half = Math.max(smap.worldW, smap.worldH) / 2
  } else if (units.length > 0) {
    let loX = Infinity, hiX = -Infinity, loZ = Infinity, hiZ = -Infinity
    for (const u of units) {
      loX = Math.min(loX, u.pos.x); hiX = Math.max(hiX, u.pos.x)
      loZ = Math.min(loZ, u.pos.z); hiZ = Math.max(hiZ, u.pos.z)
    }
    cx = (loX + hiX) / 2
    cz = (loZ + hiZ) / 2
    half = Math.max(MIN_EXTENT, (hiX - loX) / 2 * 1.2, (hiZ - loZ) / 2 * 1.2)
  }
  _view = { cx, cz, scale: (SIZE / 2 - 6) / half }
  const ctx = _canvas.getContext('2d')
  ctx.clearRect(0, 0, SIZE, SIZE)
  ctx.fillStyle = 'rgba(8, 10, 14, 0.92)'
  ctx.fillRect(0, 0, SIZE, SIZE)
  // Battlefield backdrop: the map's own minimap, mapped through the same
  // world→map transform the dots use so positions line up exactly.
  if (smap && smap.minimapImage) {
    const [x0, y0] = worldToMap(0, 0)
    const [x1, y1] = worldToMap(smap.worldW, smap.worldH)
    try { ctx.drawImage(smap.minimapImage, x0, y0, x1 - x0, y1 - y0) } catch { /* decode race */ }
  }
  // Light grid for scale reading: lines every 200wu.
  ctx.strokeStyle = 'rgba(80, 200, 120, 0.18)'
  ctx.lineWidth = 1
  const step = 200 * _view.scale
  if (step > 8) {
    const ox = (SIZE / 2 - (cx % 200) * _view.scale + SIZE * 10) % step
    const oz = (SIZE / 2 - (cz % 200) * _view.scale + SIZE * 10) % step
    ctx.beginPath()
    for (let x = ox; x < SIZE; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, SIZE) }
    for (let y = oz; y < SIZE; y += step) { ctx.moveTo(0, y); ctx.lineTo(SIZE, y) }
    ctx.stroke()
  }
  for (const u of units) {
    const [x, y] = worldToMap(u.pos.x, u.pos.z)
    const sel = view.scene.selected.has(u.id)
    const [r, g, b] = displayRgbForSide(u.side | 0)
    ctx.fillStyle = `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`
    ctx.beginPath()
    ctx.arc(x, y, sel ? 3.5 : 2.6, 0, Math.PI * 2)
    ctx.fill()
    if (sel) {
      ctx.strokeStyle = 'rgba(255,255,255,0.95)'
      ctx.lineWidth = 1.2
      ctx.beginPath()
      ctx.arc(x, y, 5, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
}

let _wired = false
export function wireMinimap() {
  if (_wired) return
  _wired = true
  subscribeTick(() => draw())
}
