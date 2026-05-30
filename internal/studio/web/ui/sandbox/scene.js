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
//   - A SmokeTrailManager and engine event subscriptions ('fire',
//     'death', 'move-stop').  These USED to live on SandboxView,
//     but anything that mutates engine/binding state (spawn a
//     projectile, emit a death puff, queue an audio cue) needs to
//     fire ONCE per event regardless of how many views observe — so
//     it lives at scene level now.  Without that move, a 2× split
//     would double every projectile + every death puff.
//   - A per-(unit,event-key) sound debounce map so a flurry of clicks
//     doesn't stack <audio> elements.
//
// All unit lifecycle / movement / attack-resolution / per-tick work
// lives in the GameEngine.  This class forwards addUnit / removeUnit /
// units / tick / etc. straight through so the existing SandboxView
// call sites don't change shape.

import { GameEngine } from '../../engine/game-engine.js'
import { AudioPool } from '../../game3d/audio-pool.js'
import {
  SmokeTrailManager,
  spawnProjectile,
  playWeaponSound,
  SFX_FIRE_FLASH,
} from '../../game3d/weapon-driver.js'

// Same 3 ms window that engine.tick uses to coalesce duplicate calls
// from N renderers.  See comment in game-engine.js.  The scene needs
// its own guard because smokeTrails.tick lives outside engine.tick.
const SCENE_TICK_COALESCE_MS = 3

// Per-(unit, eventKey) debounce in ms.  A second click within the
// window plays no sound — prevents the "select1 / select1 / select1"
// stack when the user spam-clicks a unit.
const UNIT_SOUND_DEBOUNCE_MS = 80

export class SandboxScene {
  constructor({ palette = null } = {}) {
    // Shared palette ref — passed through to rendering listeners so
    // the weapon driver can resolve TA colour indices for laser
    // beams.  Stored here (not on the engine) because the engine is
    // intentionally headless and has no rendering concerns.
    this.palette = palette
    // Inject the renderer-side AudioPool via factory.  The engine
    // package never imports a concrete audio implementation — keeping
    // the cross-package direction one-way (game3d → engine) means
    // a future headless server can construct GameEngine without
    // pulling in browser-only <audio>.
    this.engine = new GameEngine({ audioFactory: () => new AudioPool() })
    // Selected unit ids — pure UI state.  The controls layer reads
    // this to fan commands out to the highlighted units.
    this.selected = new Set()
    // Telemetry — monotonic counter the inspector uses to detect
    // "new units this frame" without diffing the whole map.
    this._spawnCount = 0
    // Smoke trails for in-flight missiles.  Scene-owned so all panes
    // observing this scene see the same trail visuals — without that,
    // two panes would each push duplicate puffs onto the same binding
    // particle pool.
    this.smokeTrails = new SmokeTrailManager()
    // Per-unit / per-event sound debounce ledger.  See playUnitSound.
    this._unitSoundDebounce = new Map()
    // Per-frame scene-tick coalesce.  Mirrors engine.tick's guard so
    // smoke-trail advance also folds to once per frame when N renderers
    // each call scene.tick().
    this._lastTickWallMs = 0
    this._lastTickResult = null
    // Engine event subscriptions — all scene-level concerns: spawn a
    // visible projectile, drop a death puff, voice an arrival ack.
    // Each mutates engine/binding state, so each must fire once per
    // event regardless of view count.
    this.engine.on('despawn', ({ unitId }) => this.selected.delete(unitId))
    this.engine.on('spawn', () => { this._spawnCount++ })
    this.engine.on('fire', (ev) => {
      if (!ev || !ev.weapon || !ev.weapon.name) return
      try {
        // Model weapons (missiles / rockets / bombs) are flown by the engine's
        // projectile sim and drawn as a real 3DO mesh (see #refreshEntities) —
        // skip the dead-reckoned particle here, but still play the muzzle
        // sound so firing is audible.
        if (ev.modelProjectile) {
          playWeaponSound({ binding: ev.unit.binding, weapon: ev.weapon, anchor: ev.anchor })
          return
        }
        spawnProjectile({
          binding: ev.unit.binding,
          weapon: ev.weapon,
          anchor: ev.anchor,
          target: ev.target,
          palette: this.palette,
          gravity: this.engine.gravity || 80,
          smokeTrails: this.smokeTrails,
        })
      } catch { /* ignore — projectile-vis failures must not stall sim */ }
    })
    this.engine.on('move-stop', (ev) => {
      if (ev && ev.unit) {
        this.playUnitSoundRandom(ev.unit, ['arrived1', 'arrived2', 'arrived3', 'arrived4', 'arrived5'])
      }
    })
    this.engine.on('death', (ev) => {
      const b = ev && ev.unit && ev.unit.binding
      if (!b || !b.particles) return
      b.particles.emit(SFX_FIRE_FLASH, ev.anchor, {
        size: 32, lifeMs: 600, color: [1.6, 0.6, 0.2, 1.0],
      })
    })
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
  // In-flight model-projectiles (missiles / rockets / bombs) for the view
  // to render as 3DO meshes — forwarded straight from the engine.
  projectiles() { return this.engine.projectiles() }
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

  // playUnitSound looks up `eventKey` (e.g. 'ok1', 'arrived3', 'select1')
  // on the unit's resolved FBI sounds map, picks the wav stem, and routes
  // it through the unit's per-binding AudioPool (so the sim-speed slider
  // + pause toggle apply and the Audio inspector picks it up).  Debounced
  // at UNIT_SOUND_DEBOUNCE_MS per unit+event so a flurry of clicks
  // doesn't stack <audio> elements.  Returns true when a sound was
  // queued, false otherwise.
  playUnitSound(unit, eventKey) {
    if (!unit || !unit.meta || !unit.meta.sounds || !unit.binding) return false
    const stem = unit.meta.sounds[eventKey]
    if (!stem) return false
    const key = `${unit.id}:${eventKey}`
    const now = (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now()
    const last = this._unitSoundDebounce.get(key) || 0
    if (now - last < UNIT_SOUND_DEBOUNCE_MS) return false
    this._unitSoundDebounce.set(key, now)
    const pool = unit.binding.audio
    if (!pool) return false
    pool.play(stem, {
      vol: 0.85,
      kind: 'unit',
      source: `${unit.name || 'Unit'}: ${eventKey}`,
      pos: [unit.pos.x, unit.pos.y || 0, unit.pos.z],
    })
    return true
  }

  // playUnitSoundRandom picks one event from a list (filtered to those
  // present in the unit's sounds map) and plays it.  Lets a unit cycle
  // through ok1..ok5 / arrived1..arrived5 the way TA does, without
  // callers tracking an index.
  playUnitSoundRandom(unit, eventKeys) {
    if (!unit || !unit.meta || !unit.meta.sounds) return false
    const present = eventKeys.filter((k) => unit.meta.sounds[k])
    if (present.length === 0) return false
    const pick = present[Math.floor(Math.random() * present.length)]
    return this.playUnitSound(unit, pick)
  }

  // tick advances the engine + smoke trails by dtMs.  Coalesces
  // duplicate calls within SCENE_TICK_COALESCE_MS so N renderers
  // sharing this scene only step the sim once per paint frame.
  tick(dtMs) {
    const wall = (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now()
    if (this._lastTickWallMs !== 0 && (wall - this._lastTickWallMs) < SCENE_TICK_COALESCE_MS) {
      return this._lastTickResult
    }
    this._lastTickWallMs = wall
    const result = this.engine.tick(dtMs)
    const rt = this.engine.runtime
    const rate = (rt && rt.paused) ? 0 : ((rt && rt.playbackRate) || 1)
    this.smokeTrails.tick(dtMs * rate)
    this._lastTickResult = result
    return result
  }

  // dispose drops scene-level scaffolding.  Called when a tab closes —
  // engine units are released by the engine's own teardown, smoke
  // trails get cleared so a fresh-open tab doesn't inherit stale
  // missile wakes.
  dispose() {
    try { this.smokeTrails.clear() } catch { /* ignore */ }
    this._unitSoundDebounce.clear()
  }
}
