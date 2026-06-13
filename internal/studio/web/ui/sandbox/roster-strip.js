// roster-strip.js
//
// Bottom-centre selection roster for the sandbox, dock-style. With fewer
// than five units selected every unit gets its own cell — build picture + an
// individual health bar; five or more collapse into one cell per unit TYPE
// with a count badge and a bar showing the group's AVERAGE health. Build
// pictures come from /api/studio/buildpic/<name> (the game's own art, so
// TA's and TA:K's differing aspect ratios carry through — the img scales by
// height only).
//
// A single selected BUILDER appends its build menu: each buildable type as a
// cell with the unit's resource costs beneath (labels from the game
// adapter's resources table) and, on factories, a counter of copies queued
// in the production run. Clicking queues on a factory (repeat clicks stack,
// types mix freely — the sim owns the run) or arms the placement ghost on a
// mobile builder.
//
// Hovering magnifies icons macOS-dock style: the pointered icon swells and
// neighbours scale off smoothly with distance (see #dockMagnify).
//
// Updates ride the shared 4 Hz inspector tick (subscribeTick) rather than a
// per-frame hook: selection, health and queue state change at sim cadence,
// and the DOM only rebuilds when the roster's signature actually changes,
// so hover/animation frames never churn it.

import { hostCallbacks, setStatus } from '../host-context.js'
import { subscribeTick } from '../common/refresh-tick.js'
import { activeGame } from '../common/game-registry.js'

const GROUP_THRESHOLD = 5

let _root = null
let _sig = ''

// Per-type meta cache for the build row's cost lines. A miss kicks an async
// fetch and re-renders when it lands; null marks "no meta" so a 404 is
// probed at most once.
const _metaCache = new Map()
const _metaInflight = new Set()

function buildMeta(name) {
  if (_metaCache.has(name)) return _metaCache.get(name)
  if (!_metaInflight.has(name)) {
    _metaInflight.add(name)
    fetch(`/api/studio/unit/${encodeURIComponent(name)}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((meta) => {
        _metaCache.set(name, meta)
        _metaInflight.delete(name)
        _sig = '' // costs arrived — rebuild on the next tick
      })
  }
  return undefined
}

function ensureRoot() {
  if (_root && _root.isConnected) return _root
  const dlg = document.getElementById('model-viewer-dialog')
  if (!dlg) return null
  _root = document.createElement('div')
  _root.id = 'sandbox-roster-strip'
  _root.hidden = true
  _root.addEventListener('mousemove', dockMagnify)
  _root.addEventListener('mouseleave', dockReset)
  _root.addEventListener('mouseover', tipShow)
  _root.addEventListener('mouseout', tipHide)
  // mouseout never fires when focus leaves the window or a pointerdown
  // re-renders the strip under the cursor, so the tip needs belt-and-braces
  // dismissal on both.
  _root.addEventListener('pointerleave', () => { if (_tip) _tip.hidden = true })
  window.addEventListener('blur', () => { if (_tip) _tip.hidden = true })
  // Last-resort sweep: any pointer travel outside the strip dismisses the
  // tip, catching paths where the browser never delivered mouseout (focus
  // stolen mid-hover, DOM swapped under a stationary cursor).
  const sweep = (e) => {
    if (_tip && !_tip.hidden && _root && !_root.contains(e.target)) _tip.hidden = true
  }
  document.addEventListener('pointermove', sweep, { passive: true })
  document.addEventListener('mousemove', sweep, { passive: true })
  dlg.appendChild(_root)
  return _root
}

// ── Dock magnification ──────────────────────────────────────────────
//
// Classic dock falloff: the icon under the pointer scales to ~1.5×, decaying
// by a gaussian of horizontal distance so neighbours swell and contract as
// the cursor sweeps. Transform-origin is the strip's baseline so icons grow
// upward out of the bar.

const DOCK_MAX_BOOST = 0.5
const DOCK_FALLOFF_PX = 70

function dockMagnify(e) {
  if (!_root) return
  for (const cell of _root.children) {
    if (!cell.classList || !cell.classList.contains('roster-cell')) continue
    const r = cell.getBoundingClientRect()
    const d = Math.abs(e.clientX - (r.left + r.width / 2))
    const s = 1 + DOCK_MAX_BOOST * Math.exp(-(d * d) / (DOCK_FALLOFF_PX * DOCK_FALLOFF_PX))
    cell.style.transform = `scale(${s.toFixed(3)})`
  }
}

function dockReset() {
  if (!_root) return
  for (const cell of _root.children) {
    if (cell.style) cell.style.transform = ''
  }
  if (_tip) _tip.hidden = true
}

// ── Hover tooltip ───────────────────────────────────────────────────
//
// One floating tip above the hovered cell: the unit's human-readable name
// (meta.title, falling back to the codename) and — on a factory's build
// row — the resource costs, which live here instead of under the icon.

let _tip = null

function ensureTip() {
  if (_tip && _tip.isConnected) return _tip
  const dlg = document.getElementById('model-viewer-dialog')
  if (!dlg) return null
  _tip = document.createElement('div')
  _tip.id = 'roster-tip'
  _tip.hidden = true
  dlg.appendChild(_tip)
  return _tip
}

function tipShow(e) {
  const cell = e.target.closest?.('.roster-cell')
  if (!cell || !_root || !_root.contains(cell)) return
  const tip = ensureTip()
  if (!tip) return
  const name = cell.dataset.build || cell.dataset.unit
  if (!name) return
  const meta = buildMeta(name)
  // First hover races the meta fetch — retry shortly so the display name
  // and costs replace the codename once the cache fills.
  if (meta === undefined) {
    setTimeout(() => {
      if (!_tip || _tip.hidden) return
      if (cell.isConnected && cell.matches(':hover') && _root && _root.matches(':hover')) tipShow({ target: cell })
      else _tip.hidden = true
    }, 350)
  }
  const title = (meta && meta.title) || name
  let html = `<div class="roster-tip-name">${title}</div>`
  if (cell.dataset.build) {
    const cost = costLineHTML(name)
    if (cost.includes('span')) html += cost
  }
  tip.innerHTML = html
  tip.hidden = false
  const host = tip.parentElement.getBoundingClientRect()
  const r = cell.getBoundingClientRect()
  tip.style.left = `${r.left + r.width / 2 - host.left}px`
  const strip = _root.getBoundingClientRect()
  tip.style.bottom = `${host.bottom - strip.top + 10}px`
}

function tipHide(e) {
  if (!_tip) return
  const into = e.relatedTarget
  if (into && _root && _root.contains(into) && into.closest?.('.roster-cell')) return
  _tip.hidden = true
}

function healthFrac(u) {
  return Math.max(0, Math.min(1, (u.health ?? 100) / 100))
}

function barColor(frac) {
  return `hsl(${Math.round(120 * frac)}, 85%, 45%)`
}

// costLineHTML renders a buildable type's resource prices using the game
// adapter's resource table ("118 Metal · 1536 Energy" for TA, "285 Mana" for
// TA:K). Each value carries its resource name so the colour isn't the only
// cue for which figure is which. Empty until the meta cache resolves.
function costLineHTML(name) {
  const meta = buildMeta(name)
  if (!meta) return '<div class="roster-cost"></div>'
  const parts = []
  for (const res of activeGame().resources || []) {
    const v = meta[res.costField]
    if (v > 0) parts.push(`<span class="roster-cost-item" style="color:${res.color}">${Math.round(v)}<span class="roster-cost-label">${res.label}</span></span>`)
  }
  return `<div class="roster-cost">${parts.join('<span class="roster-cost-sep">·</span>')}</div>`
}

// buildCellHTML — one constructible unit in the single-builder build row
// and (for factories) the production-run counter. Resource costs live in
// the hover tip for every builder, keeping the dock row compact.
function buildCellHTML(name, queued) {
  return `
    <div class="roster-cell roster-build-cell" data-build="${name}">
      <div class="roster-pic-wrap roster-pic-wrap-sm">
        <img class="roster-pic roster-pic-sm" data-unit="${name}" alt="${name}" />
        ${queued > 0 ? `<span class="roster-count">${queued}</span>` : ''}
      </div>
    </div>`
}

function cellHTML({ name, count, frac }) {
  const pct = Math.round(frac * 100)
  return `
    <div class="roster-cell" data-unit="${name}">
      <div class="roster-pic-wrap">
        <img class="roster-pic" data-unit="${name}" alt="${name}" />
        ${count > 1 ? `<span class="roster-count">${count}</span>` : ''}
      </div>
      <div class="roster-bar"><div class="roster-bar-fill" style="width:${pct}%;background:${barColor(frac)}"></div></div>
    </div>`
}

// queuedCount tallies how many of a type the builder has in flight: the
// pending production run plus the unit currently raising on the pad.
function queuedCount(builder, name) {
  let n = 0
  for (const q of builder.prodQueue || []) {
    if (q === name) n++
  }
  if (builder.building === name) n++
  return n
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
    if (!root.hidden) { root.hidden = true; _sig = '' }
    if (_tip) _tip.hidden = true
    return
  }

  let cells
  if (units.length < GROUP_THRESHOLD) {
    cells = units.map((u) => ({ name: u.name, ids: [u.id], count: 1, frac: healthFrac(u) }))
  } else {
    const groups = new Map()
    for (const u of units) {
      let g = groups.get(u.name)
      if (!g) { g = { name: u.name, ids: [], count: 0, frac: 0 }; groups.set(u.name, g) }
      g.ids.push(u.id)
      g.count++
      g.frac += healthFrac(u)
    }
    cells = [...groups.values()].map((g) => ({ ...g, frac: g.frac / g.count }))
  }

  // Single builder selected → append its build menu (the game adapter's
  // canbuild data rides the unit meta as buildOptions).
  const builder = units.length === 1 ? units[0] : null
  const buildOpts = (builder && builder.meta && Array.isArray(builder.meta.buildOptions))
    ? builder.meta.buildOptions
    : []

  const sig = cells.map((c) => `${c.name}:${c.count}:${Math.round(c.frac * 50)}`).join('|')
    + (buildOpts.length
      ? `+build:${builder.name}:${builder.building || ''}:${(builder.prodQueue || []).join(',')}`
      : '')
  if (sig === _sig && !root.hidden) return
  _sig = sig
  root.hidden = false
  root.innerHTML = cells.map((c) => cellHTML(c)).join('')
    + (buildOpts.length
      ? `<div class="roster-divider"></div>${buildOpts.map((n) => buildCellHTML(n, queuedCount(builder, n))).join('')}`
      : '')
  // The rebuild replaced every cell node, so a tip anchored to a removed
  // cell would float forever — hide it and let the next hover re-show it.
  if (_tip) _tip.hidden = true
  // Set image sources as PROPERTY writes after the markup lands: the
  // workspace URL shim rewrites src assignments to carry the /workspaces/
  // prefix, but it cannot see attributes baked into innerHTML.
  for (const img of root.querySelectorAll('.roster-pic')) {
    img.onerror = () => { img.style.visibility = 'hidden' }
    img.src = `/api/studio/buildpic/${encodeURIComponent(img.dataset.unit)}`
  }
  // Click narrows the selection to the cell's unit(s).
  const byName = new Map(cells.map((c) => [c.name, c.ids]))
  for (const el of root.querySelectorAll('.roster-cell:not(.roster-build-cell)')) {
    el.addEventListener('click', () => {
      const v = hostCallbacks.getActiveSandboxView?.()
      const ids = byName.get(el.dataset.unit)
      if (!v || !v.scene || !ids) return
      v.scene.selectClear()
      for (const id of ids) v.scene.selectAdd(id)
      _sig = '' // force a rebuild against the narrowed selection
    })
  }
  // Build cells: a factory QUEUES the unit on its sim-side production run
  // (repeat clicks stack copies, mixed types interleave in click order; the
  // counter badge tracks the run). A mobile builder arms the placement
  // ghost — the user picks the site and the builder walks over to raise it.
  for (const el of root.querySelectorAll('.roster-build-cell')) {
    el.addEventListener('click', async () => {
      const v = hostCallbacks.getActiveSandboxView?.()
      if (!v || !v.scene || !builder) return
      const name = el.dataset.build
      try {
        const isFactory = builder.meta && builder.meta.canMove === false
        if (isFactory) {
          await v.scene.build(builder.id, name, builder.pos.x, builder.pos.z)
          const n = queuedCount(builder, name) + 1
          setStatus(`Queued ${name} — ${n} in this factory's production run.`)
          _sig = '' // refresh the counter on the next tick
        } else if (typeof v.beginBuildPlacement === 'function') {
          await v.beginBuildPlacement(name, builder)
          setStatus(`Place ${name} — click a site; ${builder.name} will walk over and build it.`)
        }
      } catch (e) {
        setStatus(`Build failed: ${e?.message || e}`)
      }
    })
  }
}

// wireRosterStrip registers the tick subscriber. Called once from the
// sandbox tab module at boot; idempotent.
let _wired = false
export function wireRosterStrip() {
  if (_wired) return
  _wired = true
  subscribeTick(() => update())
}
