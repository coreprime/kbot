// sandbox-scene.js
//
// Multi-unit scene container.  Owns:
//
//   - A shared CobRuntime (already multi-unit capable — addUnit / units()
//     / tick walk every registered unit).
//   - A list of UnitInstance entries, each pairing a Model + CobUnit +
//     CobBinding + per-unit state (world pos, heading, damage, etc.)
//   - A shared particle pool (one per scene rather than per unit so
//     projectiles fired by unit A can hit unit B without the per-binding
//     pools getting in each other's way).
//   - A shared audio pool — sounds from any unit play through one pool
//     for sane sim-speed + pause handling.
//   - Selection state — Set of unit ids that the user has selected.
//
// The renderer is OUT of scope here — sandbox-scene is pure data +
// per-frame tick.  The viewer drives rendering by iterating
// scene.units() and asking the renderer to draw each in turn.

import { CobRuntime } from './cob/cob-runtime.js'
import { CobBinding } from './cob/cob-binding.js'
import { spawnProjectile } from './weapon-driver.js'

let _nextScenePieceId = 1

export class SandboxScene {
  constructor({ palette = null } = {}) {
    // Shared palette ref — the weapon driver needs it to resolve TA
    // colour indices for laser beams, and the unit editor's palette
    // is already loaded by the view that hosts us, so we just adopt
    // its ref rather than fetch separately.
    this.palette = palette
    this.runtime = new CobRuntime()
    // Map<unitId, UnitInstance>.  Iteration order is insertion order
    // (Map semantics) which matches the order units were spawned —
    // gives the user a predictable Z-order in the inspector when
    // multiple units sit at the same height.
    this._units = new Map()
    // Selected unit ids.  Empty set when nothing's selected.  The
    // controls layer uses this to decide which units take a command.
    this.selected = new Set()
    // Telemetry counter — strictly monotonic so the inspector can
    // diff "are there new units this frame".
    this._spawnCount = 0
  }

  // ── Unit lifecycle ──────────────────────────────────────────────

  // addUnit spawns a new unit at (x, z) on the ground plane.  Caller
  // provides the loaded Model + parsed CobScript; the scene builds
  // the CobUnit + CobBinding internally.  Returns the UnitInstance.
  addUnit({ name, model, cobScript, x = 0, z = 0, headingRad = 0 }) {
    const id = _nextScenePieceId++
    // Spawn a fresh CobUnit on the shared runtime — addUnit returns
    // the live CobUnit object with its own thread list / static vars /
    // animator state.  Hooks default to no-op; the binding wires up
    // the SFX-emit hook below.
    const cobUnit = cobScript ? this.runtime.addUnit(cobScript, {}) : null
    const binding = (cobUnit && model) ? new CobBinding(model, cobUnit) : null
    const inst = {
      id, name,
      model, cobUnit, binding,
      // World-space placement.  Heading is body yaw in radians; 0 =
      // facing -Z (3DO authoring convention).
      pos: { x, y: 0, z },
      heading: headingRad,
      isMoving: false,
      // Movement target — null when idle.  When set, the per-tick
      // mover walks the unit toward it at FBI MaxVelocity.
      moveTarget: null,
      // Attack target — an enemy UnitInstance.  When set, the unit
      // chases / fires at the target until it dies or the user stops
      // it.  Null = no attack order.
      attackTarget: null,
      // Health, in TA's percent units.  100 = full, 0 = dead.  Damage
      // events accumulate here; the COB's GET HEALTH hook reads it
      // straight off this field so SmokeUnit / Killed scripts see
      // the live value.
      health: 100,
      dead: false,
      // Build %: 100 = fully built, 0 = construction wireframe.  We
      // skip the build ramp for sandbox spawns — units enter
      // pre-built so the user can immediately move + fight them.
      buildPercent: 100,
      meta: null,  // populated by the caller after FBI fetch
    }
    // Wire the COB's GET_UNIT_VALUE hook so HEALTH / BUILD_PERCENT
    // reads off this instance's live state — matches what
    // ModelViewer.open() does for the single-unit case.
    if (cobUnit) {
      cobUnit.hooks.getUnitValue = (port) => {
        switch (port) {
          case 4:  return Math.max(0, 100 - (100 - inst.health) | 0)  // HEALTH
          case 6:  return Math.max(0, 100 - (inst.buildPercent | 0))  // BUILD_PERCENT_LEFT
          default: return 0
        }
      }
    }
    this._units.set(id, inst)
    this._spawnCount++
    return inst
  }

  removeUnit(id) {
    const inst = this._units.get(id)
    if (!inst) return
    if (inst.cobUnit) this.runtime.removeUnit(inst.cobUnit.id)
    if (inst.binding && inst.binding.audio) inst.binding.audio.dispose()
    this._units.delete(id)
    this.selected.delete(id)
  }

  // units returns an iterable of every live UnitInstance.  Caller
  // typically iterates this from a render loop to draw / tick each.
  units() { return this._units.values() }
  unitById(id) { return this._units.get(id) }
  unitCount() { return this._units.size }

  // ── Selection ──────────────────────────────────────────────────

  selectOnly(id) {
    this.selected.clear()
    if (id != null && this._units.has(id)) this.selected.add(id)
  }
  selectAdd(id) {
    if (id != null && this._units.has(id)) this.selected.add(id)
  }
  selectClear() { this.selected.clear() }
  isSelected(id) { return this.selected.has(id) }

  // ── Per-frame tick ─────────────────────────────────────────────

  // tick advances the shared runtime (drains all scripts on all units
  // in one fixed-step pass), then walks units to apply per-instance
  // movement + attack logic.  Returns the runtime's instruction count
  // for the inspector telemetry.
  //
  // Per-unit binding tick is INTENTIONALLY skipped here because each
  // CobBinding's tick already calls this.runtime.tick() — running
  // them all here would double-step every unit's script.  Instead we
  // manually advance binding-side state (particles, audio, piece
  // sync) without re-ticking the runtime.
  tick(dtMs) {
    const insts = this.runtime.tick(dtMs)
    const dtSec = (dtMs * (this.runtime.playbackRate || 1)) / 1000
    const simNowMs = this.runtime.simTimeMs || 0
    for (const u of this._units.values()) {
      if (u.dead) continue
      // ── Attack resolution ───────────────────────────────────
      // When a unit has an attack target, we want it to face the
      // target, walk into range, and fire its primary weapon on a
      // fixed cadence.  We synthesise a hit-scan: each shot subtracts
      // a fixed amount of HP from the target and emits a muzzle
      // flash for the firer.  Travel-time projectile graphics are
      // intentionally skipped to keep sandbox attack predictable —
      // the user immediately sees damage land, the firer animates,
      // and the target's HP counts down in the roster.
      if (u.attackTarget) {
        const t = u.attackTarget
        if (!t || t.dead || !this._units.has(t.id)) {
          u.attackTarget = null
        } else {
          const dxA = t.pos.x - u.pos.x
          const dzA = t.pos.z - u.pos.z
          const distA = Math.hypot(dxA, dzA)
          u.heading = Math.atan2(dxA, dzA)
          // Effective range: prefer FBI/weapon range, else a sandbox
          // default of 220 wu so weapons-less spawns still skirmish.
          const range = (u.meta && u.meta.weaponRange) || 220
          if (distA > range) {
            // Walk into range on the same channel as a Move order so
            // the existing movement code drives it; we just rewrite
            // the target each frame as the prey shifts.
            u.moveTarget = { x: t.pos.x, z: t.pos.z }
          } else {
            // In range — stop and pour fire on the target.
            u.moveTarget = null
            const cadenceMs = 1000
            u._nextFireSimMs = u._nextFireSimMs || 0
            if (simNowMs >= u._nextFireSimMs) {
              u._nextFireSimMs = simNowMs + cadenceMs
              // Aim + fire — call AimPrimary first (turns turret +
              // returns TRUE when on-target).  Many TA Fire scripts
              // are no-ops until AimPrimary has fired at least once,
              // because they read the aim-state static the Aim
              // script sets.  Args are heading + pitch in TA's
              // 65536-per-revolution fixed-point — pitch 0 = level.
              if (u.binding) {
                const aimHeadingTA = Math.round((u.heading) * 65536 / (Math.PI * 2)) & 0xffff
                if (u.binding.hasScript('AimPrimary')) {
                  try { u.binding.start('AimPrimary', [aimHeadingTA, 0]) } catch { /* ignore */ }
                }
                if (u.binding.hasScript('FirePrimary')) {
                  try { u.binding.start('FirePrimary') } catch { /* ignore */ }
                } else if (u.binding.particles) {
                  u.binding.particles.emit(4 /* SFX_FIRE_FLASH */, [u.pos.x, u.pos.y + 14, u.pos.z], { size: 10, lifeMs: 140 })
                }
                // Spawn the actual TA projectile (bullet, shell,
                // missile, plasma, dgun, or laser beam) through the
                // shared weapon-driver so sandbox shots look exactly
                // like unit-editor shots.  Skipped when the unit has
                // no FBI weapon meta — falls back to the muzzle
                // flash above + hit-scan damage below.
                const w = u.meta && u.meta.weapons && u.meta.weapons[0]
                if (w && w.name) {
                  const anchor = [u.pos.x, u.pos.y + 14, u.pos.z]
                  const tgt = [t.pos.x, t.pos.y + 14, t.pos.z]
                  try {
                    spawnProjectile({
                      binding: u.binding,
                      weapon: w,
                      anchor,
                      target: tgt,
                      palette: this.palette,
                    })
                  } catch { /* ignore */ }
                }
              }
              // Hit-scan damage — fixed at 12 HP/shot, scaled by the
              // FBI weapondamage if known.  Kills the target when
              // HP would go negative; further shots no-op since we
              // null attackTarget above on dead.
              const dmg = (u.meta && u.meta.weaponDamage) || 12
              t.health = Math.max(0, t.health - dmg)
              if (t.health <= 0) {
                t.dead = true
                t.moveTarget = null
                t.attackTarget = null
                // Death puff so the kill reads visually.
                if (t.binding && t.binding.particles) {
                  t.binding.particles.emit(4 /* SFX_FIRE_FLASH */, [t.pos.x, t.pos.y + 18, t.pos.z], { size: 32, lifeMs: 600, color: [1.6, 0.6, 0.2, 1.0] })
                }
              }
            }
          }
        }
      }
      // ── Movement integration ────────────────────────────────
      // Mirrors the single-unit viewer's MvControls movement (see
      // mv-controls.js _updateMove): turn toward target at FBI
      // TurnRate (shortest-arc unwrap), advance forward at FBI
      // MaxVelocity, snap to target inside arrive threshold.  Kbots
      // and tanks pivot in place then walk; that keeps the heading
      // animation readable instead of snapping which previously made
      // units teleport-spin to face a new move order.
      const wasMoving = !!u.isMoving
      if (u.moveTarget) {
        const dx = u.moveTarget.x - u.pos.x
        const dz = u.moveTarget.z - u.pos.z
        const dist = Math.hypot(dx, dz)
        if (dist < 0.5) {
          u.moveTarget = null
          u.isMoving = false
        } else {
          // Desired heading: atan2 with the renderer's +Z-forward
          // convention.  Shortest-arc unwrap so a 350° target from
          // heading 10° turns 20° clockwise instead of 340° the long
          // way around.
          const want = Math.atan2(dx, dz)
          // FBI TurnRate: TA-angle units per frame.  Convert to
          // rad/sec = (TA/frame) × (2π / 65536) × 30 Hz.  600 is the
          // unit-editor default fallback.
          const turnRateTA = (u.meta && u.meta.turnRate) ? u.meta.turnRate : 600
          const turnRate = (turnRateTA / 65536) * Math.PI * 2 * 30
          let dh = want - u.heading
          while (dh > Math.PI) dh -= Math.PI * 2
          while (dh < -Math.PI) dh += Math.PI * 2
          const turnStep = turnRate * dtSec
          let aligned
          if (Math.abs(dh) > turnStep) {
            u.heading += Math.sign(dh) * turnStep
            aligned = false
          } else {
            u.heading = want
            aligned = true
          }
          // Walk forward only once aligned — matches the kbot/tank
          // pivot-then-walk feel of the unit viewer.  Ships + hovers
          // would walk-while-turning; sandbox doesn't currently track
          // unit-type meta deep enough to gate that, so we keep the
          // pivot-first model uniform.
          if (aligned) {
            const speed = (u.meta && u.meta.maxVelocity > 0)
              ? u.meta.maxVelocity * 30 /* FBI units/frame × 30Hz → wu/sec */
              : 30
            const step = Math.min(dist, speed * dtSec)
            u.pos.x += Math.sin(u.heading) * step
            u.pos.z += Math.cos(u.heading) * step
          }
          u.isMoving = true
        }
      } else {
        u.isMoving = false
      }
      // Edge-triggered StartMoving / StopMoving — mirrors the single-
      // unit viewer's MvControls walking pattern.  Most TA kbot/tank
      // BOS scripts use these as the on/off switch for their leg
      // animation loop; without firing them the unit just slides
      // across the ground with no walk cycle.
      if (u.isMoving && !wasMoving && u.binding) {
        if (u.binding.hasScript('StartMoving')) {
          try { u.binding.start('StartMoving') } catch { /* ignore */ }
        }
      } else if (!u.isMoving && wasMoving && u.binding) {
        if (u.binding.hasScript('StopMoving')) {
          try { u.binding.start('StopMoving') } catch { /* ignore */ }
        }
      }
      // ── Particle + audio + piece-sync per-binding ───────────
      // We synthesise a binding tick by calling its underlying
      // helpers WITHOUT re-ticking the runtime.  cob-binding.tick
      // re-runs the runtime which would double-step every unit.
      const b = u.binding
      if (b) {
        // Push the unit's current world pos into the binding so
        // particle anchors (muzzle flash, SFX emits, explosions)
        // land at the unit's actual position, not at the model-
        // local origin all units share.  Cheap — just three field
        // writes per frame.
        if (b.worldOffset) {
          b.worldOffset.x = u.pos.x
          b.worldOffset.y = u.pos.y
          b.worldOffset.z = u.pos.z
        }
        // Replicate the binding tick's post-runtime work directly:
        // sync piece transforms + advance particles + audio.
        b._sync && b._sync(dtMs)
        if (b.particles) b.particles.tick(dtMs * (this.runtime.playbackRate || 1))
        if (b.audio) b.audio.tick(this.runtime.playbackRate || 1, this.runtime.paused)
      }
    }
    return insts
  }
}
