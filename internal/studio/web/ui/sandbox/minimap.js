// minimap.js
//
// Sandbox mini-map, bottom-right: every live unit as a team-coloured dot
// over an auto-fitted world extent (square, padded, never tighter than
// ±300wu so a small skirmish doesn't fill the frame). Selected units ring
// white.
//
// Left-click navigates: clicking a unit dot selects it, clicking empty
// ground jumps the camera there — the classic minimap-as-viewport gesture.
// Right-click commands: on an opposing unit with a selection held it
// orders the attack, on empty ground it issues a move (shift queues both),
// so the map doubles as a long-range order surface.
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

// ensureRoot adopts the canvas the React MinimapPanel mounted (standard
// floating-panel chrome, no close button). The panel element is the
// hide/show handle; the canvas is the draw + click surface.
function ensureRoot() {
  const panel = document.getElementById('sandbox-minimap')
  const canvas = document.getElementById('sandbox-minimap-canvas')
  if (!panel || !canvas) return null
  if (_canvas !== canvas) {
    _canvas = canvas
    _canvas.addEventListener('click', onClick)
    _canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); onOrder(e) })
  }
  _root = panel
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

// clickPoint converts an event to map-pixel coords + the nearest unit dot.
function clickPoint(view, e) {
  const rect = _canvas.getBoundingClientRect()
  const px = (e.clientX - rect.left) * (SIZE / rect.width)
  const py = (e.clientY - rect.top) * (SIZE / rect.height)
  let hit = null
  let hitD = 10 // px — comfortable thumb radius
  for (const u of liveUnits(view)) {
    const [ux, uy] = worldToMap(u.pos.x, u.pos.z)
    const d = Math.hypot(ux - px, uy - py)
    if (d < hitD) { hit = u; hitD = d }
  }
  return { px, py, hit }
}

function onClick(e) {
  const view = activeView()
  if (!view) return
  const { px, py, hit } = clickPoint(view, e)
  if (hit) {
    view.scene.selectClear()
    view.scene.selectAdd(hit.id)
    view.setStatus(`Selected ${hit.name} via mini-map.`)
    return
  }
  // Empty ground: jump the camera there — the minimap as a viewport.
  const [wx, wz] = mapToWorld(px, py)
  if (view.camera) {
    view.camera.target[0] = wx
    view.camera.target[2] = wz
    view.setStatus(`Camera to (${wx.toFixed(0)}, ${wz.toFixed(0)}).`)
  }
}

function onOrder(e) {
  const view = activeView()
  if (!view) return
  const { px, py, hit } = clickPoint(view, e)
  const sel = view.getSelectedUnits()
  if (sel.length === 0) return
  const queued = !!e.shiftKey
  if (hit && !view.scene.selected.has(hit.id) &&
      !sel.every((s) => (s.side | 0) === (hit.side | 0))) {
    const n = view.issueAttack(hit, queued)
    view.setStatus(`${queued ? 'Attack queued' : 'Attack'} via mini-map — ${n} unit(s) on ${hit.name}.`)
    return
  }
  const [wx, wz] = mapToWorld(px, py)
  const n = view.issueMove([wx, 0, wz], queued)
  view.setStatus(`${queued ? 'Move queued' : 'Move'} via mini-map — ${n} unit(s) to (${wx.toFixed(0)}, ${wz.toFixed(0)}).`)
}

// cameraGroundQuad intersects the camera's four corner rays with the
// y=0 ground plane, returning [[x,z] x4] in world units (or null when
// the camera/matrices aren't ready). Rays pointing above the horizon
// clamp to a distant point so the quad stays drawable.
function cameraGroundQuad(view) {
  const cam = view.camera
  if (!cam || !cam.invViewProj) return null
  const ivp = cam.invViewProj()
  if (!ivp) return null
  const un = (ndcX, ndcY, ndcZ) => {
    const v = [ndcX, ndcY, ndcZ, 1]
    const o = [0, 0, 0, 0]
    for (let r = 0; r < 4; r++) {
      o[r] = ivp[r] * v[0] + ivp[r + 4] * v[1] + ivp[r + 8] * v[2] + ivp[r + 12] * v[3]
    }
    if (Math.abs(o[3]) < 1e-9) return null
    return [o[0] / o[3], o[1] / o[3], o[2] / o[3]]
  }
  const corners = [[-1, 1], [1, 1], [1, -1], [-1, -1]] // TL TR BR BL in NDC
  const out = []
  for (const [nx, ny] of corners) {
    const near = un(nx, ny, -1)
    const far = un(nx, ny, 1)
    if (!near || !far) return null
    const dy = far[1] - near[1]
    let t = Math.abs(dy) > 1e-6 ? -near[1] / dy : 1
    if (!(t > 0)) t = 1            // above horizon: clamp to the far plane
    t = Math.min(t, 1)
    out.push([near[0] + (far[0] - near[0]) * t, near[2] + (far[2] - near[2]) * t])
  }
  return out
}

function draw() {
  const view = activeView()
  const root = ensureRoot()
  if (!root) return
  if (!view) {
    root.style.display = 'none'
    return
  }
  const units = liveUnits(view)
  root.style.display = ''

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
  // Camera viewport: the true ground footprint of the perspective
  // frustum — each screen corner's view ray intersected with the ground
  // plane — so the shape reads as the real trapezoid of what the camera
  // sees, not an abstract rectangle. Rays that miss the ground (looking
  // at the sky) clamp to a far point along the ray.
  const frustum = cameraGroundQuad(view)
  if (frustum) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)'
    ctx.lineWidth = 1.2
    ctx.beginPath()
    for (let i = 0; i < frustum.length; i++) {
      const [fx, fy] = worldToMap(frustum[i][0], frustum[i][1])
      if (i === 0) ctx.moveTo(fx, fy)
      else ctx.lineTo(fx, fy)
    }
    ctx.closePath()
    ctx.stroke()
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
