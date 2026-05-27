// sandbox-scene.js
//
// Sandbox-tab adapter around the headless GameEngine.  Owns:
//
//   - A GameEngine instance (per-tab — sim state is fully isolated
//     from other tabs).
//   - Selection state — Set of unit ids the user has highlighted.
//     This is a VIEW concern, not a sim one, so it stays here
//     instead of in the engine.
//   - The palette reference the rendering subscribers need to
//     resolve TA palette indices for laser beams.
//
// All unit lifecycle / movement / attack-resolution / per-tick work
// lives in the GameEngine now.  This class forwards addUnit /
// removeUnit / units / tick / etc. straight through so the existing
// SandboxView call sites don't change shape.  Rendering subscribers
// (the host view) attach via engine.on(...) to react to fire / hit /
// death events with particles + sound + projectile spawn.

import { GameEngine } from './game-engine.js'

export class SandboxScene {
  constructor({ palette = null } = {}) {
    // Shared palette ref — passed through to rendering listeners so
    // the weapon driver can resolve TA colour indices for laser
    // beams.  Stored here (not on the engine) because the engine is
    // intentionally headless and has no rendering concerns.
    this.palette = palette
    this.engine = new GameEngine()
    // Selected unit ids — pure UI state.  The controls layer reads
    // this to fan commands out to the highlighted units.
    this.selected = new Set()
    // Telemetry — monotonic counter the inspector uses to detect
    // "new units this frame" without diffing the whole map.
    this._spawnCount = 0
    // Subscribe to despawn so removed units fall out of the
    // selection set without the caller having to manage it.
    this.engine.on('despawn', ({ unitId }) => this.selected.delete(unitId))
    this.engine.on('spawn', () => { this._spawnCount++ })
  }

  // The engine's CobRuntime is the source of truth for sim time +
  // playback rate — surface it on the scene too so existing inspector
  // code (refreshMvRuntimeStats etc.) doesn't have to learn about
  // the indirection.
  get runtime() { return this.engine.runtime }

  // ── Unit lifecycle (forwarded) ────────────────────────────────────

  addUnit(opts) { return this.engine.addUnit(opts) }
  removeUnit(id) { this.engine.removeUnit(id) }
  units() { return this.engine.units() }
  unitById(id) { return this.engine.unitById(id) }
  unitCount() { return this.engine.unitCount() }

  // ── Selection ─────────────────────────────────────────────────────

  selectOnly(id) {
    this.selected.clear()
    if (id != null && this.engine.unitById(id)) this.selected.add(id)
  }
  selectAdd(id) {
    if (id != null && this.engine.unitById(id)) this.selected.add(id)
  }
  selectClear() { this.selected.clear() }
  isSelected(id) { return this.selected.has(id) }

  // ── Audio + per-frame tick ────────────────────────────────────────

  // setSilenced forwards to the engine — used by tab-switch so the
  // backgrounded sandbox view goes quiet without freezing its sim.
  setSilenced(s) { this.engine.setSilenced(s) }

  tick(dtMs) { return this.engine.tick(dtMs) }
}
