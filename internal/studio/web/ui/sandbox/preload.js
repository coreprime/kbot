// preload.js
//
// Battlefield preload orchestration for the sandbox launch screen. Runs the
// asset-heavy launch work — terrain, the faction leader, and the leader's
// buildable units (so the build menu and first builds are instant) — as a
// sequence of weighted phases, reporting a single 0..1 progress fraction
// the loading overlay drives. Everything is best-effort: a phase that fails
// logs and advances rather than stalling the bar.

import { loadSandboxMap, spawnFactionLeader } from './map-loader.js'

const wsUrl = (p) => `${window.__WS_BASE__ || ''}${p}`

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
      const meta = await fetch(`/api/studio/unit/${encodeURIComponent(faction.commander)}`)
        .then((r) => (r.ok ? r.json() : null))
      const opts = (meta && Array.isArray(meta.buildOptions)) ? meta.buildOptions : []
      if (opts.length === 0) {
        ustep(1)
      } else {
        let done = 0
        for (const name of opts) {
          await Promise.allSettled([
            // Unit meta (build costs, footprint, weapons, its own buildOptions).
            fetch(`/api/studio/unit/${encodeURIComponent(name)}`).then((r) => r.ok && r.json()).catch(() => null),
            // Build picture for the dock cell.
            _preloadImage(wsUrl(`/api/studio/buildpic/${encodeURIComponent(name)}`)),
            // Model geometry + textures into the renderer's loader cache.
            view.loader ? view.loader.load(name).catch(() => null) : Promise.resolve(),
          ])
          done++
          ustep(done / opts.length, `Preloading units… (${done}/${opts.length})`)
        }
      }
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
