// roster-strip.js
//
// Bottom-centre selection roster for the sandbox. With fewer than five
// units selected every unit gets its own cell — build picture + an
// individual health bar; five or more collapse into one cell per unit TYPE
// with a count badge and a bar showing the group's AVERAGE health. Build
// pictures come from /api/studio/buildpic/<name> (the game's own art, so
// TA's and TA:K's differing aspect ratios carry through — the img scales by
// height only).
//
// Updates ride the shared 4 Hz inspector tick (subscribeTick) rather than a
// per-frame hook: selection and health change at sim cadence, and the DOM
// only rebuilds when the roster's signature (ids + rounded healths)
// actually changes, so hover/animation frames never churn it.
//
// Clicking a cell narrows the selection to that unit (or that type).

import { hostCallbacks, setStatus } from '../host-context.js'
import { subscribeTick } from '../common/refresh-tick.js'

const GROUP_THRESHOLD = 5

let _root = null
let _sig = ''

function ensureRoot() {
  if (_root && _root.isConnected) return _root
  const dlg = document.getElementById('model-viewer-dialog')
  if (!dlg) return null
  _root = document.createElement('div')
  _root.id = 'sandbox-roster-strip'
  _root.hidden = true
  dlg.appendChild(_root)
  return _root
}

function healthFrac(u) {
  return Math.max(0, Math.min(1, (u.health ?? 100) / 100))
}

function barColor(frac) {
  return `hsl(${Math.round(120 * frac)}, 85%, 45%)`
}

// buildCellHTML — one constructible unit in the single-builder build row.
function buildCellHTML(name) {
  return `
    <div class="roster-cell roster-build-cell" data-build="${name}" title="Build ${name}">
      <div class="roster-pic-wrap roster-pic-wrap-sm">
        <img class="roster-pic roster-pic-sm" data-unit="${name}" alt="${name}" />
      </div>
    </div>`
}

function cellHTML({ name, title, count, frac }) {
  const pct = Math.round(frac * 100)
  return `
    <div class="roster-cell" data-unit="${name}" title="${title || name}${count > 1 ? ` ×${count}` : ''} — ${pct}% health">
      <div class="roster-pic-wrap">
        <img class="roster-pic" data-unit="${name}" alt="${name}" />
        ${count > 1 ? `<span class="roster-count">${count}</span>` : ''}
      </div>
      <div class="roster-bar"><div class="roster-bar-fill" style="width:${pct}%;background:${barColor(frac)}"></div></div>
    </div>`
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
  const buildOpts = (units.length === 1 && units[0].meta && Array.isArray(units[0].meta.buildOptions))
    ? units[0].meta.buildOptions
    : []

  const sig = cells.map((c) => `${c.name}:${c.count}:${Math.round(c.frac * 50)}`).join('|')
    + (buildOpts.length ? '+build:' + units[0].name : '')
  if (sig === _sig && !root.hidden) return
  _sig = sig
  root.hidden = false
  root.innerHTML = cells.map((c) => cellHTML(c)).join('')
    + (buildOpts.length
      ? `<div class="roster-divider"></div>${buildOpts.map((n) => buildCellHTML(n)).join('')}`
      : '')
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
  // Build cells construct the unit at the builder. A factory (an immobile
  // builder) does the TA thing: the unit appears on the pad and ROLLS OFF to
  // a clear spot near the exit, so back-to-back builds never stack. Mobile
  // builders still place beside themselves — the walk-up-and-lathe build
  // cycle is a separate refinement. Build time / economy are not modelled;
  // the point here is that WHAT a unit can build comes from the game data.
  const builder = units.length === 1 ? units[0] : null
  let buildSeq = 0
  for (const el of root.querySelectorAll('.roster-build-cell')) {
    el.addEventListener('click', async () => {
      const v = hostCallbacks.getActiveSandboxView?.()
      if (!v || !v.scene || !builder) return
      const name = el.dataset.build
      try {
        const model = await v.loader.load(name)
        const isFactory = builder.meta && builder.meta.canMove === false
        if (isFactory) {
          // Spawn on the pad slightly toward the exit, facing out, then
          // roll off to the nearest clear spot.
          const h = builder.heading || 0
          const u = await v.scene.addUnit({
            name, model,
            x: builder.pos.x + Math.sin(h) * 14,
            z: builder.pos.z + Math.cos(h) * 14,
            headingRad: h,
            side: builder.side,
          })
          const spot = findRolloffSpot(v.scene, builder, h)
          if (u && spot) u.moveTarget = { x: spot.x, z: spot.z }
          setStatus(`Built ${name} — rolling off.`)
        } else {
          const angle = (buildSeq++ * 0.9) + 0.6
          const x = builder.pos.x + Math.cos(angle) * 55
          const z = builder.pos.z + Math.sin(angle) * 55
          await v.scene.addUnit({ name, model, x, z, side: builder.side })
          setStatus(`Built ${name} (instant — sandbox).`)
        }
      } catch (e) {
        setStatus(`Build failed: ${e?.message || e}`)
      }
    })
  }
}

// rolloffClearance — minimum distance (wu) a rolloff spot keeps from every
// other live unit, sized to a vehicle footprint so freshly-built units park
// beside each other instead of inside each other.
const ROLLOFF_CLEARANCE = 30

// findRolloffSpot scans rings in front of the factory (preferring straight
// out the exit, fanning sideways, then widening) for a spot clear of every
// live unit. A unit's spot is where it IS — its latest sim pose (_p1, synced
// every tick; display pos only refreshes on painted frames) — and where it
// is GOING (its move destination), so back-to-back builds don't all pick the
// same square while the first tank is still rolling toward it. Falls back to
// straight ahead so a crowded base still gets a destination.
function findRolloffSpot(scene, builder, heading) {
  const blockers = []
  for (const u of scene.units()) {
    if (!u || u.dead || u === builder) continue
    const p = u._p1 || u.pos
    blockers.push([p.x, p.z])
    const mt = u.moveTarget
    if (mt) blockers.push([mt.x, mt.z])
  }
  const clearAt = (x, z) =>
    blockers.every(([bx, bz]) => Math.hypot(bx - x, bz - z) >= ROLLOFF_CLEARANCE)
  for (const r of [70, 100, 130, 160]) {
    for (const da of [0, 0.5, -0.5, 1.0, -1.0, 1.5, -1.5, Math.PI]) {
      const a = heading + da
      const x = builder.pos.x + Math.sin(a) * r
      const z = builder.pos.z + Math.cos(a) * r
      if (clearAt(x, z)) return { x, z }
    }
  }
  return {
    x: builder.pos.x + Math.sin(heading) * 90,
    z: builder.pos.z + Math.cos(heading) * 90,
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
