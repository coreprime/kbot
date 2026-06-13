// preload.js
//
// Battlefield preload orchestration for the sandbox launch screen. Runs the
// asset-heavy launch work — terrain, the faction leader, and the leader's
// buildable units (so the build menu and first builds are instant) — as a
// sequence of weighted phases, reporting a single 0..1 progress fraction
// the loading overlay drives. Everything is best-effort: a phase that fails
// logs and advances rather than stalling the bar.

import { loadSandboxMap, spawnFactionLeader } from './map-loader.js'
import { withCobBytes } from '../../engine/net/cob-bytes.js'

const wsUrl = (p) => `${window.__WS_BASE__ || ''}${p}`

// The command-cursor glyphs the sandbox's armed-cursor overlay can show
// (see game3d/armed-cursor.js). Preloaded so the first gesture never waits
// on a fetch; a game that ships no GAF for one just 404s harmlessly.
const CURSOR_NAMES = [
  'cursornormal', 'cursorselect', 'cursormove', 'cursorattack',
  'cursorrepair', 'cursorpickup', 'cursorunload', 'cursorairstrike',
]

// Phase weights (must sum to ~1). The Grid (no map) collapses the terrain
// phases to zero and the rest absorb the slack — see _weights().
function _weights(hasMap, hasFaction) {
  const w = { terrain: 0.42, side: 0.05, leader: 0.18, units: 0.30, finish: 0.05 }
  if (!hasMap) { w.side += w.terrain; w.terrain = 0 }
  if (!hasFaction) { w.finish += w.leader + w.units; w.leader = 0; w.units = 0 }
  return w
}

// runSandboxPreload loads the chosen battlefield + faction with progress.
// onProgress(frac, label) is called repeatedly; frac is the global 0..1.
// Returns { where } (the battlefield display name) for the status line.
export async function runSandboxPreload(view, { mapPath, faction }, onProgress) {
  const report = (frac, label) => {
    try { onProgress?.(Math.max(0, Math.min(1, frac)), label) } catch { /* ignore */ }
  }
  const w = _weights(!!mapPath, !!(faction && faction.commander))
  let base = 0
  // local(0..1 within phase) → global fraction; advances `base` on finish.
  const phase = (weight, label) => {
    const start = base
    base += weight
    return (local, lbl) => report(start + weight * Math.max(0, Math.min(1, local)), lbl || label)
  }

  let where = 'The Grid'

  // ── Terrain (heightmap JSON → sim, terrain texture, mini-map) ──
  if (mapPath) {
    const step = phase(w.terrain, 'Reading battlefield…')
    try {
      const info = await loadSandboxMap(view, mapPath, step)
      where = info.name || where
    } catch (e) {
      step(1, 'Battlefield skipped')
      console.warn('preload: terrain failed', e)
    }
  }

  // ── Side data (cheap; warms the roster so the build bar is ready) ──
  {
    const step = phase(w.side, 'Loading side data…')
    try { await fetch('/api/studio/sandbox-sides').then((r) => (r.ok ? r.json() : null)) } catch { /* ignore */ }
    // Warm every command cursor the armed-cursor overlay swaps in, so the
    // first Move / Attack / Patrol / Repair / transport gesture shows its
    // glyph immediately instead of flashing a blank frame on first fetch.
    for (const c of CURSOR_NAMES) _preloadImage(wsUrl(`/api/studio/cursor/${c}`))
    step(1)
  }

  // ── Faction leader (model + textures, then spawn) ──
  if (faction && faction.commander) {
    const step = phase(w.leader, `Summoning ${faction.name || 'leader'}…`)
    try {
      step(0.15)
      await spawnFactionLeader(view, faction.commander, faction.index)
      step(1)
    } catch (e) {
      step(1, 'Leader skipped')
      console.warn('preload: leader failed', e)
    }

    // ── Buildable units: warm each option's meta + build picture + model
    // geometry so the build menu populates and the first build of any type
    // is instant. Bounded, best-effort, fine-grained progress. ──
    const ustep = phase(w.units, 'Preloading units…')
    try {
      ustep(0.02)
      // Walk the WHOLE build tree (commander → factories → their units → …),
      // not just the commander's direct options, so selecting a factory or
      // hovering/building anything never triggers a first-use fetch. Metas are
      // registered into the scene's spawn-meta cache (the local engine's
      // resolver plus the build / canBuildAt / resource-tooltip paths read it),
      // and build pictures + model geometry warm into their caches.
      const seen = new Set([faction.commander])
      const queue = [faction.commander]
      const all = []
      const MAX = 400 // runaway guard
      while (queue.length && all.length < MAX) {
        const name = queue.shift()
        const raw = await fetch(`/api/studio/unit/${encodeURIComponent(name)}`)
          .then((r) => (r.ok ? r.json() : null)).catch(() => null)
        if (!raw) continue
        // Attach the unit's COB bytecode now so the meta the engine's spawn
        // resolver reads is script-ready: a buildee or resolver-spawned unit
        // runs Create/Activate/aim threads without a first-use fetch (and so
        // an ActivateWhenBuilt structure actually opens). Best-effort — a
        // unit with no script is returned unchanged.
        const meta = await withCobBytes(name, raw).catch(() => raw)
        all.push(name)
        try { view.scene?._spawnMetas?.set(name, meta) } catch { /* best-effort */ }
        for (const opt of (Array.isArray(meta.buildOptions) ? meta.buildOptions : [])) {
          if (!seen.has(opt)) { seen.add(opt); queue.push(opt) }
        }
      }
      let done = 0
      for (const name of all) {
        await Promise.allSettled([
          _preloadImage(wsUrl(`/api/studio/buildpic/${encodeURIComponent(name)}`)),
          view.loader ? view.loader.load(name).catch(() => null) : Promise.resolve(),
          // Warm the decompiled-COB endpoint the renderer reads for the
          // piece-name map, so the first spawn's pose binding is instant.
          fetch(`/api/studio/cob/${encodeURIComponent(name)}?decompile=0`).catch(() => null),
        ])
        done++
        ustep(0.4 + 0.6 * (done / Math.max(1, all.length)), `Preloading units… (${done}/${all.length})`)
      }
      ustep(1)
    } catch (e) {
      ustep(1)
      console.warn('preload: units failed', e)
    }
  }

  // ── Finish ──
  phase(w.finish, 'Preparing field…')(1, 'Ready.')
  return { where }
}

// _preloadImage resolves once the image has loaded (or errored) — used to
// warm the browser image cache for build pictures.
function _preloadImage(src) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(true)
    img.onerror = () => resolve(false)
    img.src = src
  })
}
