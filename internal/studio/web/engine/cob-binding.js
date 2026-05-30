// cob-binding.js
//
// Wires a CobRuntime to a Model (3DO piece tree).  After each tick
// the binding copies the runtime's per-piece animation state into
// the pieces' `move` / `rotate` / `visible` fields so the renderer
// picks it up.  Lives separately from the runtime so the runtime
// stays renderer-agnostic - a future server-side simulation could
// drive the same runtime without ever touching a 3DO Piece.
//
// The binding also owns the SFX particle pool the COB runtime
// emits into (via the `emitSfx` hook).  Particles are computed in
// world space - the binding resolves each emit's piece-anchor into
// a world position by walking the model's piece tree just before
// pushing into the pool.

import {
  ParticlePool,
  SFX_SMOKE_GREY,
  SFX_SMOKE_WHITE,
  SFX_SPARK,
  SFX_FIRE_FLASH,
  SFX_PROJECTILE_BULLET,
  SFX_PROJECTILE_SHELL,
  SFX_PROJECTILE_PLASMA,
  SFX_PROJECTILE_DGUN,
  SFX_PROJECTILE_LASER,
  SFX_PROJECTILE_MISSILE,
} from './cob-particles.js'
import { nullAudioPool } from './null-audio-pool.js'
import { makeRng } from './rng.js'
import { loadWeaponFx, pickExplosionVariant } from './weapon-fx-loader.js'

export class CobBinding {
  // model: Model from model-loader.js (with root piece + findPiece)
  // unit:  CobUnit from cob-runtime.js (per-unit script + animator state)
  // opts.audio: optional AudioPool-shaped object — when omitted the
  //   binding uses the shared NullAudioPool stub so the engine can
  //   compile + run headless (server-side simulation, replay scrubber).
  //   Renderer hosts inject a concrete AudioPool that drives <audio>
  //   elements.
  //
  // The host CobRuntime is reachable via `unit.runtime` and is also
  // mirrored on `this.runtime` so callers writing world-wide controls
  // (pause / playback / tick) don't have to walk `binding.unit.runtime`.
  constructor(model, unit, opts = {}) {
    this.model = model
    this.unit = unit
    this.runtime = unit.runtime
    // Build a quick model.piece → cob.pieceIndex map so the per-frame
    // sync doesn't redo name lookups.  Pieces whose names don't
    // appear in the COB (rare - typically the root "base" piece
    // matches) get index -1 and just sit at their static origin.
    this._pieceMap = new Map() // Piece → cobPieceIndex
    // Also build the inverse so the SFX emit hook can resolve a COB
    // pieceIndex back to the model's Piece for a world-space anchor.
    this._cobToPiece = new Map() // cobPieceIndex → Piece
    for (const p of model.flat) {
      const idx = unit.pieceIndexByName(p.name)
      this._pieceMap.set(p, idx)
      if (idx >= 0) this._cobToPiece.set(idx, p)
    }
    // ParticlePool inherits the binding's RNG so emit()'s fallback
    // drift-angle path is deterministic when the engine is seeded.  The
    // binding sets this.rng below — but we haven't read opts.rng yet, so
    // we pull it inline rather than re-ordering the constructor.
    this.particles = new ParticlePool(1024, { rng: opts.rng || null })
    // worldOffset — applied to every piece-anchored SFX emit so that
    // multi-entity hosts can place each unit at a different world
    // position while reusing the same binding code.  Single-entity
    // hosts that render their unit at the world origin leave this
    // at {0,0,0}.  Multi-entity hosts set it on every tick from each
    // unit's pos.
    this.worldOffset = { x: 0, y: 0, z: 0 }
    // Build% drives the sparkle-emission rate in _emitBuildSparkles
    // (and the renderer's nano-frame fade is set separately via the
    // host's setBuildPercent).  Host writes here through setBuildPercent
    // below; default 100% (= done = no sparkles).  Previously read
    // through a window.__modelViewer back-channel which assumed there
    // was exactly one host in the page — now sits on the binding so
    // each tab's host pushes its own value into its own bindings.
    this.buildPercent = 100
    // Audio pool — central registry for every sound the binding's
    // hooks emit.  Injected from the host so the engine package stays
    // headless: a renderer-side AudioPool drives <audio> elements,
    // a server-side simulation passes nothing and gets the shared
    // NullAudioPool (every method no-ops, zero allocation).  Lives
    // on the binding so it's ticked alongside particles + runtime in
    // the same per-frame call, and disposed when the binding tears
    // down on a unit-swap.
    this.audio = opts.audio || nullAudioPool
    // RNG used by every random spawn helper (SmokeUnit ray-pick, fire-burst
    // angle, build-sparkle scatter).  Defaults to a non-seeded fallback so
    // a binding constructed directly (without an engine) still works;
    // GameEngine.addUnit injects the engine's deterministic RNG so the full
    // sim is reproducible.  See engine/rng.js.
    this.rng = opts.rng || makeRng(null)
    // _lastFiredWeapon — the weapon TDF JSON for the most recent shot
    // this binding emitted.  Used by _onParticleExpire to look up the
    // real GAF explosion art for the impact.  Best-effort: when a unit
    // has multiple in-flight projectiles from different weapons, the
    // newer one's art is used for whichever expires next.  Suitable for
    // the common single-weapon case; a future pass can thread per-shot
    // weapon refs through the particle pool for full fidelity.
    this._lastFiredWeapon = null
    // _explosionOverlay — host-supplied ExplosionOverlay used to play
    // real APNG explosion sprites at impact.  Null in headless mode or
    // before the host wires one in; _onParticleExpire falls back to the
    // synthetic cluster path when this is null OR the weapon-fx fetch
    // returns no art for the named weapon.
    this._explosionOverlay = opts.explosionOverlay || null
    // _waterY — world-Y of the water plane (set by the host when in sea
    // mode).  _onParticleExpire passes it to pickExplosionVariant so an
    // impact below the surface gets the water explosion sprite.
    this._waterY = (opts.waterY != null) ? +opts.waterY : null
    // Wire the pool's on-expire callback so projectile particles
    // detonate visually instead of just vanishing.  This is the
    // single point of dispatch for TA-style impact effects:
    // bullet/laser hits get a tiny spark burst, missile hits a
    // medium fireball + smoke, shells a heavier explosion, d-gun
    // a violent oversized cluster matching its size in flight.
    this.particles.onExpire = (slot, pool) => this._onParticleExpire(slot, pool)
    // Install the unit's emit-sfx hook.  Keep any existing hook
    // intact so callers that supplied a log/getUnitValue keep them.
    const prevEmit = unit.hooks.emitSfx
    unit.hooks.emitSfx = (sfxType, pieceIdx) => {
      this._emitSfx(sfxType, pieceIdx)
      if (prevEmit) prevEmit(sfxType, pieceIdx)
    }
    // OP_EXPLODE → particle burst.  Without this the Killed script
    // and any weapon that uses `explode piece type N` just runs as a
    // silent state change; in TA they're the visible "this part flew
    // off in a fireball" moments, so we map every explode to a
    // sparks+smoke cluster at the piece's anchor.  Magnitude scales
    // with the bit mask (more set bits = bigger boom).
    const prevExplode = unit.hooks.explode
    unit.hooks.explode = (pieceIdx, sfxType) => {
      this._emitExplode(pieceIdx, sfxType)
      if (prevExplode) prevExplode(pieceIdx, sfxType)
    }
  }

  // tick advances the WHOLE runtime by dtMs (every unit, not just
  // this binding's one) and then pushes per-piece state into THIS
  // binding's model.  Returns the instruction count for the tick.
  //
  // The runtime ticks on a fixed 40 Hz grid; the renderer typically
  // runs at 60 Hz or faster, so most render frames see no fresh COB
  // value.  _sync uses dtMs to exponentially smooth the displayed
  // piece transforms toward the latest COB target — this turns the
  // visibly stepped "snap each tick" animation into a continuous
  // ease-toward-target on every render frame, without changing what
  // the runtime computes (the engine stays bytecode-pure; only the
  // displayed transform is interpolated).
  tick(dtMs) {
    const count = this.runtime.tick(dtMs)
    this._sync(dtMs)
    // Particles share the runtime's playback rate so slow-mo
    // applies uniformly to script + SFX.  Pause sets rate to 0 so
    // projectiles + effects freeze in place along with the scripts —
    // without this gate `dtMs * playbackRate` kept advancing them on
    // wall-clock time because playbackRate stays at 1 when paused
    // (only `paused` flips).  Mirrors the gate game-engine.js uses
    // in its own #syncBinding so both hosts behave identically.
    const partRate = this.runtime.paused ? 0 : (this.runtime.playbackRate || 1)
    this.particles.tick(dtMs * partRate)
    // Build-time transporter sparkles — emit a smattering of green
    // pulses across the unit's geometry while the build ramp is
    // in flight.  Skip while paused so a frozen unit doesn't keep
    // accumulating motionless sparkles (the particle pool's tick is
    // gated above; emitted sparkles would never decay).
    if (!this.runtime.paused) this._emitBuildSparkles(dtMs)
    // Audio pool — propagate the runtime's playbackRate + paused
    // state to every live <audio> element each frame so sounds
    // slow-mo / fast-forward / pause with the rest of the sim.
    // tick is a no-op when neither has changed since last call.
    this.audio.tick(this.runtime.playbackRate, this.runtime.paused)
    // Note: dynamic light contribution is exposed via getSceneLight()
    // as a pure getter — the renderer pulls it after tick(), so this
    // binding has no knowledge of a renderer.
    return count
  }

  // getSceneLight scans the alive particles for any flagged as a
  // light source and returns the strongest as { pos, color, strength }
  // (or null when nothing is lit).  One light at a time keeps shader
  // cost flat; in practice the d-gun dominates any other simultaneous
  // emitter (range 300 vs laser's 80) so picking the brightest is
  // enough.  Same shape as the engine's getSceneLight so the renderer
  // can poll either source through one code path.
  getSceneLight() {
    const p = this.particles
    let bestIdx = -1
    let bestScore = 0
    for (let i = 0; i < p.count; i++) {
      if (!p.alive[i]) continue
      const ls = p.lightStrength[i]
      if (!(ls > 0)) continue
      // Score combines range × brightness × alpha so a fading puff
      // gradually dims; the d-gun's huge range keeps it dominant.
      const lum = Math.max(p.r[i], p.g[i], p.b[i])
      const s = ls * lum * (p.a[i] / Math.max(0.001, p.a0[i]))
      if (s > bestScore) { bestScore = s; bestIdx = i }
    }
    if (bestIdx < 0) return null
    return {
      pos: [p.x[bestIdx], p.y[bestIdx], p.z[bestIdx]],
      color: [p.r[bestIdx], p.g[bestIdx], p.b[bestIdx]],
      strength: p.lightStrength[bestIdx],
    }
  }

  // start exposes the unit's entry-point launcher with the same name
  // so callers can write `binding.start('Activate')` without
  // dereferencing through `.unit`.  Args are pushed as initial
  // locals exactly like Cob's START_SCRIPT.
  //
  // Fire* hook: most TA fire scripts (armstump/armham/etc) only
  // toggle a `flare` piece's visibility and recoil the barrel —
  // there's no emit-sfx in the script itself, the muzzle flash is
  // the flare-piece geometry briefly shown.  At studio scale that
  // 100-200ms flash is easy to miss, so we inject a muzzle particle
  // burst at the fire-point piece whenever a Fire* script kicks off.
  // Hooked here (not in runCobEntry) so scripts started from other
  // scripts via `start-script Fire…` also get the burst.
  start(scriptName, args = []) {
    if (/^Fire(Primary|Secondary|Tertiary|Weapon\d+)$/i.test(scriptName)) {
      this._emitFireBurst(scriptName)
    }
    return this.unit.start(scriptName, args)
  }
  hasScript(name) { return this.unit.hasScript(name) }
  listScripts() { return this.unit.listScripts() }

  // signal forwards to the unit so the host can fire signals
  // outside of a running script (e.g. the UI's "Kill" button).
  signal(n) { this.unit.signal(n) }

  // _emitSfx routes a COB emit-sfx into the particle pool with a
  // world-space anchor derived from the named piece's current
  // transform.  Falls back to the unit's origin if the piece is
  // unknown / hidden.
  //
  // TA's sfxType is a 16-bit bag of flags + indices.  The mapping
  // below covers the categories real bos scripts emit:
  //   bit 8 (256) — smoke series.  257 = light grey, 258 = dark
  //                  grey (damage trail), 259+ = other smoke
  //                  variants.  SmokeUnit fires from this set
  //                  every 0.2-3s depending on HEALTH.
  //   bit 10 (1024) — particles / spark effects.
  //   0, 1, 2 — wake / vtol-fart trails (water/airborne motion).
  //   3       — brief muzzle flash.
  //   16      — nano-construction stream.
  // Anything unrecognised emits a generic smoke puff so unknown
  // SFX still register visibly (better than silently swallowing).
  _emitSfx(sfxType, pieceIdx) {
    const anchor = this._worldAnchor(pieceIdx)
    let kind = 1 // default = grey smoke
    let cluster = 1
    let smokeBias = false
    if (sfxType & 256) {
      // Smoke family.  Lower 8 bits pick the variant; 1 = light, 2
      // = dark/damage.  We collapse anything >= 2 to dark smoke so
      // damaged-unit trails read distinctly from idle exhaust.
      const sub = sfxType & 0xff
      kind = (sub <= 1) ? 2 /* light */ : 1 /* dark */
      // Each bos `emit-sfx 256|N` spawns one particle in the game;
      // SmokeUnit polls slowly (>= 200ms, scales with HEALTH) so a
      // single puff per call looks too thin.  Spawn a small cluster
      // so each call reads as a visible plume.  The cluster is
      // distributed via _emitCluster's per-particle offset so they
      // don't pile up exactly on top of each other.
      cluster = 3
      // Most TA bos scripts emit damage smoke `from base` — and the
      // base piece is at the unit's origin (Y≈0), inside the lower
      // hull.  Without an upward spawn bias the puff is occluded by
      // the unit body until it rises clear, which at TA scale can be
      // a full second of invisible particle.  Bias the smoke spawn
      // up to the top of the unit's bbox so it reads immediately.
      smokeBias = true
    } else if (sfxType & 1024) {
      kind = 3 // spark / particle effect
      cluster = 4
    } else if (sfxType === 3) {
      kind = 4 // muzzle flash
    } else if (sfxType === 16) {
      kind = 16 // nano particles
    } else if (sfxType === 0 || sfxType === 1 || sfxType === 2) {
      // Wake / vtol trails — light splashy effect.
      kind = 2
    }
    if (smokeBias) {
      // Lift spawn to the top of the unit so the puff is visible
      // above the hull from frame one.  +1 wu extra so smoke doesn't
      // z-fight the top surface.
      const liftedAnchor = [anchor[0], (this.model.bounds?.max?.[1] ?? anchor[1]) + 1, anchor[2]]
      this._emitCluster(kind, liftedAnchor, cluster, { spread: 1.4 })
    } else {
      this._emitCluster(kind, anchor, cluster)
    }
  }

  // _emitExplode renders OP_EXPLODE as a sparks+smoke burst.  TA's
  // sfxType for explode is a bag of bits — bit 2 = FALL (piece flies
  // off), 4 = SMOKE, 8 = FIRE, 16 = SMOKE_HEAVY, 32 = NONE, etc.
  // Rather than honour each bit precisely (the visible difference is
  // marginal at studio scale) we count set bits to size the burst —
  // a 5-bit Killed-final explode looks roughly 5× bigger than a
  // single-bit shatter.
  _emitExplode(pieceIdx, sfxType) {
    const anchor = this._worldAnchor(pieceIdx)
    // Bit 5 (32) is the "no effect, just remove" flag in TA — when
    // it's the only bit set we skip the visual entirely.
    if (sfxType === 32) return
    let bits = 0
    for (let v = sfxType; v; v >>= 1) if (v & 1) bits++
    const sparks = 4 + 2 * bits
    const smokes = 2 + bits
    this._emitCluster(3 /* spark */, anchor, sparks, { spread: 1.5 })
    this._emitCluster(1 /* dark smoke */, anchor, smokes, { spread: 2.0 })
    // Always include one bright flash so the burst registers even
    // if the sparks scatter wide.
    this.particles.emit(4 /* muzzle flash */, anchor)
  }

  // _emitFireBurst injects a muzzle-flash + smoke burst at the
  // weapon's fire-point piece.  Used as a UX backstop because most
  // TA fire scripts just toggle a `flare` piece visible for ~150ms
  // and don't emit any particles themselves; the brief flash is
  // easy to miss at studio camera distances.
  //
  // PRIMARY anchor source: the unit's QueryX BOS script — that's
  // the canonical "which piece does this weapon fire from?"
  // declaration in the .bos / .cob.  E.g. Commander has
  // QueryPrimary → lfirept (laser) and QueryTertiary → rbigflash
  // (d-gun).  Earlier this used a name-heuristic ("lfirept" as a
  // tertiary candidate) which incorrectly put the d-gun's muzzle
  // flash on the LASER piece because Commander has lfirept but no
  // flare3.  Going through runQuery uses the same source-of-truth
  // mv-controls uses for projectile anchors, so the muzzle flash
  // and the projectile always exit from the same piece.
  _emitFireBurst(scriptName) {
    const m = /^Fire(Primary|Secondary|Tertiary|Weapon(\d+))$/i.exec(scriptName)
    if (!m) return
    const slot = (m[1] || '').toLowerCase()
    const weaponN = m[2] ? +m[2] : (slot === 'primary' ? 1 : slot === 'secondary' ? 2 : slot === 'tertiary' ? 3 : 1)
    let piece = null
    // Try QueryX first — the BOS-declared firing piece.
    const queryName = m[2] ? `QueryWeapon${m[2]}` : `Query${slot[0].toUpperCase()}${slot.slice(1)}`
    if (this.unit && typeof this.unit.runQuery === 'function' && this.unit.hasScript(queryName)) {
      const idx = this.unit.runQuery(queryName, [0])
      const names = this.unit.pieceNames || []
      if (idx != null && idx >= 0 && idx < names.length) {
        const cand = this.model.findPiece(names[idx])
        if (cand) piece = cand
      }
    }
    // Heuristic fallback for units without QueryX (mostly aircraft,
    // turrets that use legacy naming).  Order: numbered flare first,
    // then alt naming TA models use.  First hit wins.
    if (!piece) {
      const candidates = []
      if (weaponN === 1) candidates.push('flare', 'flare1', 'rfirept', 'firept1', 'muzzle', 'muzzle1', 'barrel')
      else candidates.push(`flare${weaponN}`, `lfirept`, `firept${weaponN}`, `muzzle${weaponN}`, `barrel${weaponN}`)
      for (const name of candidates) {
        const p = this.model.findPiece(name)
        if (p) { piece = p; break }
      }
      // Last-ditch: any piece whose name matches /flare|firept|muzzl/i.
      if (!piece) piece = this.model.flat.find((p) => /flare|firept|muzzl/i.test(p.name)) || null
    }
    let anchor = [0, 0, 0]
    if (piece && piece.worldMatrix) {
      // piece.worldMatrix is already in WORLD space — the renderer
      // composes the unit-transform into its _modelMatrix per-entity
      // before walking the piece tree, so worldMatrix[12..14] is the
      // piece's world position with the unit transform already baked
      // in.  Adding `worldOffset` here would double the unit pos in
      // multi-entity mode (where worldOffset is non-zero), making
      // muzzle flashes appear at 2× the firing unit's world coords.
      // Single-entity mode renders at origin so the old +worldOffset
      // was a no-op; multi-entity mode is where the bug showed up.
      const wm = piece.worldMatrix
      anchor = [wm[12], wm[13], wm[14]]
    } else {
      // No piece resolved — fall back to the unit's worldOffset as
      // the spawn anchor.  Reaches here for units whose model has no
      // flare / firept / muzzle piece (e.g. weaponless support
      // structures).  worldOffset IS the unit's world position, set
      // per-tick by the engine.
      const wo = this.worldOffset
      if (wo) anchor = [wo.x, wo.y, wo.z]
    }
    this.particles.emit(4 /* muzzle flash */, anchor)
    this._emitCluster(3 /* spark */, anchor, 6, { spread: 1.2 })
    this._emitCluster(2 /* light smoke */, anchor, 4, { spread: 1.0 })
  }

  // _onParticleExpire dispatches an impact-burst when a projectile
  // particle's lifetime hits zero.  Called by the pool's onExpire
  // hook BEFORE the slot is freed, so pool[slot].x/y/z still hold
  // the projectile's final position.  Different projectile kinds
  // get different impact compositions — laser pulse fades silently
  // (it's a beam segment, not a travelling munition), bullet hits
  // tiny sparks, missile/shell trigger fireball + sparks + smoke,
  // d-gun produces a violent green-tinged explosion matching the
  // weapon's iconic "disintegration" feel.  Non-projectile kinds
  // (smoke, sparks) just expire silently — they ARE the effect.
  _onParticleExpire(slot, pool) {
    const k = pool.kind[slot]
    // Skip impact for SFX kinds that are themselves part of an
    // explosion or wake — they shouldn't recursively spawn more.
    if (k < SFX_PROJECTILE_BULLET) return
    const anchor = [pool.x[slot], pool.y[slot], pool.z[slot]]
    // Don't burst at the origin — projectiles that expired before
    // they actually moved (very-short-life laser pulses snapped to
    // muzzle, e.g.) shouldn't fake an explosion on top of the unit.
    // The muzzle flash already handles the "shot fired" visual.
    if (k === SFX_PROJECTILE_LASER) return
    // Real GAF explosion — fire-and-forget.  Falls through to the
    // synthetic cluster below regardless, so the impact still has
    // particles for the bloom + light contribution.  When the GAF
    // resolves successfully the sprite overlay plays on top; when
    // it 404s the sprite path silently no-ops and the synthetic
    // burst remains the entire impact.
    this._spawnRealExplosion(anchor)
    // TDF endSmoke=1 — extra smoke puff at the terminal point.  TA
    // ships this on explosive shells / missiles whose impact should
    // leave a lingering plume independent of the explosion proper.
    // Reads off the same _lastFiredWeapon best-effort cache the
    // sprite path uses.
    if (this._lastFiredWeapon && this._lastFiredWeapon.endSmoke) {
      this.particles.emit(SFX_SMOKE_GREY, anchor, { size: 10, lifeMs: 1800, riseSpeed: 2.0, drift: 1.2 })
    }
    // Impact magnitude scaler — projectile size is driven from the
    // weapon's TDF areaOfEffect by weapon-driver.projectileSize, so
    // reading back pool.size gives us a sim-time proxy for the blast
    // radius without having to keep a per-particle AoE field.  Ratio
    // is taken against each kind's base size so a TDF-silent shot
    // produces the historic visual.
    const sz = pool.size[slot] || 1
    const baseSizeByKind = {
      [SFX_PROJECTILE_BULLET]:  2.5,
      [SFX_PROJECTILE_PLASMA]:  3.5,
      [SFX_PROJECTILE_MISSILE]: 4.0,
      [SFX_PROJECTILE_SHELL]:   5.0,
      [SFX_PROJECTILE_DGUN]:    32.0,
    }
    const baseSz = baseSizeByKind[k] || sz
    const aoeMul = Math.max(0.6, Math.min(3.5, sz / baseSz))
    // Helper — multiply the cluster count + spread + flash size while
    // keeping minimums so a 1× shot still produces a visible burst.
    const cN     = (n) => Math.max(1,  Math.round(n * aoeMul))
    const cSpread= (s) => s * aoeMul
    const cSize  = (s) => s * aoeMul
    // Impact bursts.  Durations tuned to match TA's brief flash
    // rather than linger as static glow.  Smoke kinds (SMOKE_GREY,
    // SMOKE_WHITE) keep their KIND_DEFAULTS lifeMs (~3-4s) so the
    // smoke wisp dissipates naturally; we just shorten the fireball
    // flashes since those were the dominant "glow that won't fade"
    // contributors the user noticed.
    if (k === SFX_PROJECTILE_BULLET || k === SFX_PROJECTILE_PLASMA) {
      this._emitCluster(SFX_SPARK,       anchor, cN(8),  { spread: cSpread(2.0) })
      this._emitCluster(SFX_SMOKE_WHITE, anchor, cN(2),  { spread: cSpread(1.5) })
      this.particles.emit(SFX_FIRE_FLASH, anchor, { size: cSize(6), lifeMs: 120 })
      return
    }
    if (k === SFX_PROJECTILE_MISSILE || k === SFX_PROJECTILE_SHELL) {
      this._emitCluster(SFX_SPARK,       anchor, cN(18), { spread: cSpread(4.0) })
      this._emitCluster(SFX_SMOKE_GREY,  anchor, cN(6),  { spread: cSpread(3.0) })
      this.particles.emit(SFX_FIRE_FLASH, anchor, { size: cSize(14), lifeMs: 180 })
      return
    }
    if (k === SFX_PROJECTILE_DGUN) {
      this._emitCluster(SFX_SPARK,       anchor, cN(36), { spread: cSpread(9.0) })
      this._emitCluster(SFX_SMOKE_GREY,  anchor, cN(14), { spread: cSpread(8.0) })
      this.particles.emit(SFX_FIRE_FLASH, anchor, { size: cSize(36), lifeMs: 300, color: [2.0, 0.7, 0.25, 1.0] })
      this.particles.emit(SFX_FIRE_FLASH, anchor, { size: cSize(22), lifeMs: 400, color: [1.8, 0.4, 0.15, 0.9] })
      return
    }
  }

  // _spawnRealExplosion — best-effort path that asks the server for
  // the named weapon's GAF explosion APNG and plays it through the
  // host-supplied ExplosionOverlay.  No-ops cleanly when:
  //   - the host hasn't wired an overlay (_explosionOverlay null), or
  //   - we don't know which weapon to look up (_lastFiredWeapon null,
  //     e.g. fire emitted directly without going through spawnProjectile),
  //   - the server has no shipped art (404 → loadWeaponFx resolves null).
  // Variant is picked from the impact Y vs the binding's water plane
  // (set by the host on init).  The synthetic cluster path in
  // _onParticleExpire runs unconditionally so the impact still has the
  // sparks + smoke contribution even when the sprite plays on top.
  _spawnRealExplosion(anchor) {
    const overlay = this._explosionOverlay
    const weapon = this._lastFiredWeapon
    if (!overlay || !weapon || !weapon.name) return
    const variant = pickExplosionVariant(anchor[1], { waterY: this._waterY })
    loadWeaponFx(weapon.name, variant).then((img) => {
      if (!img || !this._explosionOverlay) return
      // Sprite world-unit size scales with the weapon's blast radius
      // (areaOfEffectWU), with a floor so a pinpoint bullet still
      // produces something visible if the weapon has shipped art.
      const aoe = +weapon.areaOfEffectWU || 0
      const sizeWU = Math.max(12, Math.min(160, aoe > 0 ? aoe : 24))
      // Life sized to TA's typical 0.8-1.2 s explosion playback; for
      // wider AoE (heavy nukes) we let the APNG play through twice
      // so the wider sprite has time to register on screen.
      const lifeMs = aoe > 100 ? 1600 : 900
      this._explosionOverlay.play(anchor, img, { sizeWU, lifeMs })
    }).catch(() => { /* network errors fall through to synthetic only */ })
  }

  // _emitShipWake drops a pair of foamy puffs at the ship's wake1 /
  // wake2 pieces.  Called by the controller every ~100 ms while a
  // ship is moving so the hull leaves a visible wake astern, as in
  // the original game.  Earlier this also fired for kbots and tanks
  // as a generic "engine exhaust" — that's NOT how TA renders walker
  // motion (legs don't smoke), so the path is now ship-only.
  //
  // worldPos is the unit's CURRENT world XYZ (passed in by the
  // caller from the controller's live this.pos).  We add the piece's
  // LOCAL origin, rotated by the unit's heading, so the wake puffs
  // stay attached to the stern as the ship turns and translates.
  // Reading `piece.worldMatrix` directly would lag a frame behind
  // the moving unit's transform — the matrix is only refreshed at
  // render time, after the controller's pos/heading update — so
  // we compute the world anchor here from authoritative state.
  // _emitBuildSparkles spits a smattering of bright-green pulses
  // across the unit's geometry while the build-% ramp is active —
  // gives the construction phase-in a Star Trek "transporter" feel
  // instead of just fading polygons into existence.  No-op once
  // build% reaches 100, so cost is zero for fully-built units.
  //
  // Density scales with how MUCH of the unit is still being built
  // (more sparkles when 80% incomplete, tapering off as the build
  // approaches 100%) so the effect peaks during the visible build
  // phase and fades out as the unit solidifies.
  //
  // Particles are spawned at each piece's WORLD position (read from
  // its already-current worldMatrix) plus a small random offset
  // — gives the visual of sparkles erupting from along the model
  // surface rather than from a single emission point.  Honours the
  // controller's unit position + heading via the per-piece world
  // matrices, so the effect tracks a moving unit naturally.
  // setBuildPercent pushes the host's current build % into this
  // binding so _emitBuildSparkles can scale the green sparkle emit
  // rate.  Hosts call this from their own setBuildPercent — the
  // renderer's uniform is set separately via renderer.setBuildPercent
  // so the visual fade can update independently of any binding.
  setBuildPercent(pct) {
    this.buildPercent = Math.max(0, Math.min(100, +pct || 0))
  }

  _emitBuildSparkles(dtMs) {
    // Build% comes from the host via setBuildPercent (above).  The
    // binding doesn't reach back to look it up — multi-tab hosts
    // would have all clobbered each other through a shared global.
    const buildPct = this.buildPercent
    if (buildPct == null || buildPct >= 100) return
    if (!this.model || !this.particles) return
    // Sparkle density — particles per SECOND of real time, scaled
    // by how-incomplete the build is.  At 0% build we emit at full
    // rate, at 100% we emit zero.  Cosine-eased so the peak holds
    // through the middle of the build then tapers near completion.
    const incomplete = Math.max(0, Math.min(1, 1 - buildPct / 100))
    const rateHz = 90 * incomplete
    // Advance the per-frame accumulator (in real ms, not sim ms —
    // the sparkle visual reads more cleanly when its cadence
    // doesn't slow to a crawl in 0.01× slow-mo).  When the unit
    // is paused / very-slow-mo'd the user still sees a steady
    // shimmer rather than a frozen unit.
    this._sparkleAcc = (this._sparkleAcc || 0) + (dtMs * rateHz / 1000)
    let toEmit = Math.floor(this._sparkleAcc)
    if (toEmit < 1) return
    this._sparkleAcc -= toEmit
    // Cap to avoid pool exhaustion on long-stall frames (the cosine
    // taper means rateHz peaks around 90 — at 60fps that's ~1.5/frame,
    // but a missed frame could batch dozens).
    if (toEmit > 12) toEmit = 12
    // Only pick from pieces that actually have surface triangles —
    // empty pieces (pivots / emitter anchors) shouldn't host sparkles
    // because they have no surface to land on.  Cache the candidate
    // list on first call; rebuilt on unit-swap because the binding
    // itself is replaced for every new model.
    if (!this._sparklePieces) {
      this._sparklePieces = this.model.flat.filter(p => p._tris && p._tris.length >= 9)
    }
    const pieces = this._sparklePieces
    if (!pieces || pieces.length === 0) return
    // Pick `toEmit` random pieces with replacement.  For each, pick a
    // random triangle from the piece's CPU triangle cache and emit a
    // sparkle at a random barycentric point on that triangle (local
    // coords) transformed into world space by the piece's worldMatrix.
    // This puts the sparkle ON the actual polygon surface, not in a
    // sphere around the piece pivot.
    for (let i = 0; i < toEmit; i++) {
      const piece = pieces[(this.rng.nextFloat() * pieces.length) | 0]
      if (!piece || !piece.visible || !piece.worldMatrix) continue
      const tris = piece._tris
      const triCount = (tris.length / 9) | 0
      if (triCount === 0) continue
      // Random triangle (9 floats per: ax,ay,az, bx,by,bz, cx,cy,cz).
      const tBase = ((this.rng.nextFloat() * triCount) | 0) * 9
      // Random barycentric coords (u, v) with the standard sqrt-trick
      // to get a uniform distribution over the triangle area; the
      // third weight w = 1 - u - v.
      let u = this.rng.nextFloat()
      let v = this.rng.nextFloat()
      if (u + v > 1) { u = 1 - u; v = 1 - v }
      const w = 1 - u - v
      const lx = tris[tBase]     * w + tris[tBase + 3] * u + tris[tBase + 6] * v
      const ly = tris[tBase + 1] * w + tris[tBase + 4] * u + tris[tBase + 7] * v
      const lz = tris[tBase + 2] * w + tris[tBase + 5] * u + tris[tBase + 8] * v
      // Transform local point by piece.worldMatrix (column-major 4x4).
      const m = piece.worldMatrix
      const wx = m[0] * lx + m[4] * ly + m[8]  * lz + m[12]
      const wy = m[1] * lx + m[5] * ly + m[9]  * lz + m[13]
      const wz = m[2] * lx + m[6] * ly + m[10] * lz + m[14]
      this.particles.emit(SFX_SPARK, [wx, wy, wz], {
        // Bright green with a hint of cyan — Star Trek transporter
        // glow.  Pre-multiplied additive blending in the particle
        // shader takes alpha=1 as "fully add to background", giving
        // the sparkle its bright pop against any backdrop.
        color: [0.30, 1.80, 0.80, 1.0],
        size: 2.5,
        lifeMs: 350,
        riseSpeed: 0.0,
        drift: 0.0,
      })
    }
  }

  _emitShipWake(worldPos, headingRad) {
    if (!this.model || !this.particles) return
    const sinH = Math.sin(headingRad)
    const cosH = Math.cos(headingRad)
    // Where do the wake puffs sit on the hull?  TA ships ship wake1
    // and wake2 pieces explicitly positioned at the stern in the
    // 3DO, but many models leave them at (0,0,0) and let the engine
    // figure out the stern from the unit's bbox.  Compute a stern
    // anchor (rear-Z, slightly offset left + right) as a fallback
    // when the piece's own origin is at the unit pivot.
    const b = this.model.bounds
    const sternZ = b ? b.min[2] : 0                  // rear edge of hull
    const halfBeam = b ? (b.max[0] - b.min[0]) * 0.25 : 4   // quarter-beam outboard
    const waterY = b ? b.min[1] + 1 : 0              // just above the keel
    const emitAt = (piece, fallbackLocalX) => {
      // Piece local origin in model space.  When it's (0,0,0)
      // (artist left positioning to the engine), substitute the
      // stern-offset fallback so the puff lands at the back of the
      // hull instead of dead-centre of the pivot.
      let ox = piece && piece.origin ? piece.origin[0] : 0
      let oy = piece && piece.origin ? piece.origin[1] : 0
      let oz = piece && piece.origin ? piece.origin[2] : 0
      const hasOrigin = Math.abs(ox) + Math.abs(oy) + Math.abs(oz) > 0.1
      if (!hasOrigin) {
        ox = fallbackLocalX
        oy = waterY
        oz = sternZ
      }
      // Rotate local XZ by heading around Y, then translate by
      // worldPos.  Matches the renderer's per-frame model matrix
      // (Mat4.translate then Mat4.rotateY).
      const wx = worldPos[0] + (ox * cosH + oz * sinH)
      const wy = (worldPos[1] || 0) + oy
      const wz = worldPos[2] + (-ox * sinH + oz * cosH)
      this.particles.emit(SFX_SMOKE_WHITE, [wx, wy, wz], {
        size: 9, lifeMs: 1400, riseSpeed: 0.3, drift: 1.2,
        color: [0.95, 0.97, 1.0, 0.85],
      })
    }
    emitAt(this.model.findPiece('wake1'), -halfBeam)
    emitAt(this.model.findPiece('wake2'),  halfBeam)
  }

  // _emitCluster spawns N particles at anchor with randomised
  // sub-pixel offsets so the cluster reads as a puff rather than a
  // single dot.  `spread` is the world-space radius of the
  // distribution (defaults to 0.8wu — enough to feel volumetric on
  // a TA unit, small enough to still look anchored to the piece).
  _emitCluster(kind, anchor, n, opts = {}) {
    const spread = opts.spread ?? 0.8
    for (let i = 0; i < n; i++) {
      const ang = this.rng.nextFloat() * Math.PI * 2
      const r = this.rng.nextFloat() * spread
      const dx = Math.cos(ang) * r
      const dz = Math.sin(ang) * r
      const dy = (this.rng.nextFloat() - 0.3) * spread * 0.5
      this.particles.emit(kind, [anchor[0] + dx, anchor[1] + dy, anchor[2] + dz])
    }
  }

  _worldAnchor(pieceIdx) {
    const piece = this._cobToPiece.get(pieceIdx)
    const wo = this.worldOffset || { x: 0, y: 0, z: 0 }
    if (!piece) return [wo.x, wo.y, wo.z]
    // piece.worldMatrix is already in WORLD space — the renderer
    // bakes the unit transform into its _modelMatrix per-entity (or
    // via setUnitTransform for the single-entity path) before walking
    // the piece tree, so worldMatrix[12..14] is the absolute world
    // position.  Adding worldOffset here would double the unit's pos
    // in multi-entity mode.  The renderer recomputes worldMatrix on every
    // frame; we read the translation column directly.  Slightly
    // stale (last frame's transform) but the particle lifetime is
    // so long compared to the per-frame budget that no one will see
    // it.  Indices 12/13/14 are the translation column of a 4×4
    // column-major Mat4.
    const m = piece.worldMatrix
    return [m[12], m[13], m[14]]
  }

  _sync(dtMs) {
    // Exponential smoothing rate.  k = 1 - exp(-dt/tau).
    //
    // tau (seconds) controls how quickly the displayed transform
    // chases the COB target.  Picked ~45 ms — half a 40 Hz tick
    // period, so two render frames at 60 Hz get the displayed value
    // ~50% of the way to a freshly-set "now" target, with full reach
    // inside ~4 frames (≈ 66 ms).  Slower would over-smear quick
    // poses (walk legs cycling at ~80 ms); faster wouldn't visibly
    // smooth at all.  Tweakable later if a unit needs snappier or
    // mushier feel.
    //
    // playbackRate scales tau so slow-mo doesn't make the lerp feel
    // even mushier — the user is already slowing time, the visual
    // shouldn't lag a SECOND time on top of that.
    const dt = Math.min(0.1, Math.max(0, (dtMs ?? 16.7) / 1000)) * this.runtime.playbackRate
    const tau = 0.045
    const k = 1 - Math.exp(-dt / tau)
    // First-sync gate — when the binding's never written to the
    // model pieces, snap rather than lerp so the unit doesn't
    // visibly drift from origin into its Create-pose on load.
    const firstSync = !this._syncedOnce
    this._syncedOnce = true
    for (const [piece, idx] of this._pieceMap) {
      if (idx < 0) continue
      const off = this.unit.pieceOffset(idx)
      const rot = this.unit.pieceRotation(idx)
      // Per-axis sign convention — derived from decompiled COB
      // scripts (not just visual guesswork).  TA's COB uses a
      // left-handed coord system; our renderer is right-handed with
      // the loader's X-flip applied to vertices+origins, and the
      // camera's default view direction puts the unit's +Y up and
      // +Z toward the rear (yaw 215° looks at the unit from
      // behind).  The combination needs Y to flip on BOTH move and
      // rotation, Z to flip on move only, and X to flip on rotation
      // only:
      //
      // MOVE:
      //   X passthrough — door1's `move x-axis +18.75` slides the
      //     piece in TA's +X direction (visible from above as the
      //     unit's right side), which our X-flipped vertex layout
      //     reflects without additional negation.
      //   Y passthrough — corgant's `move clamp4b y-axis -13.1wu`
      //     drops the clamps DOWN to the ground (gantry deployment).
      //     Negating this floated the clamps in the air.
      //   Z negated — armlab's corner doors slide OUTWARD toward
      //     the building walls; passthrough sent them INWARD across
      //     the bay.  Krogoth gantry tower stays grounded.
      //
      // ROTATE:
      //   X negated — armack's `turn guncase x-axis -68°` is intended
      //     to flip the guncase OPEN upward (like a lighter cap).
      //     Without negation it rotated DOWN into the body.  Same
      //     fix lifts corgant's `turn crane x-axis -37°` out of the
      //     ground instead of into it.
      //   Y negated — turret yaw (`turn turret y-axis <heading>` in
      //     AimWeapon) tracks the requested heading correctly under
      //     our right-handed convention only with the sign flip.
      //   Z passthrough — clamp swing rotations + stand1/stand2
      //     tilts in armlab's activatescr produce visually correct
      //     directions without inversion.
      // Targets in renderer convention.  See the long comment block
      // above for the per-axis sign rationale — preserving those
      // flips here keeps existing models posed correctly.
      const tx  =  off[0]
      const ty  =  off[1]
      const tz  = -off[2]
      const trx = -rot[0]
      const trY = -rot[1]
      const trz =  rot[2]
      if (firstSync) {
        // Snap on first sync so freshly-loaded units don't visibly
        // ease from origin to their Create-pose; lerp from frame 2.
        piece.move[0] = tx; piece.move[1] = ty; piece.move[2] = tz
        piece.rotate[0] = trx; piece.rotate[1] = trY; piece.rotate[2] = trz
      } else {
        piece.move[0] += (tx - piece.move[0]) * k
        piece.move[1] += (ty - piece.move[1]) * k
        piece.move[2] += (tz - piece.move[2]) * k
        // Wrap-aware lerp on ALL THREE rotation axes — buzzsaw barrels
        // spin around X via continuous `spin` opcodes, the COB target
        // wraps every revolution, and the displayed value accumulates
        // many revolutions as it chases.  Use a MODULO-based unwrap
        // so the delta works even when `target` and `current` are
        // several revolutions apart (earlier single-wrap fix missed
        // this, producing a visible snap-back on every revolution
        // once the displayed value had drifted past ±2π from target).
        // Also normalise the displayed angle into [-π, +π] after each
        // lerp so it stays bounded — keeps float precision intact on
        // long-running spins and makes the next frame's shortDelta a
        // single-wrap operation regardless of how long the spin runs.
        const TWO_PI = Math.PI * 2
        const shortDelta = (target, current) => {
          // Reduce the gap modulo 2π → in (-2π, +2π).
          let d = ((target - current) % TWO_PI + TWO_PI) % TWO_PI
          // Then collapse the upper half into negative territory so
          // the result is the SHORTEST signed arc in [-π, +π].
          if (d > Math.PI) d -= TWO_PI
          return d
        }
        const normalise = (a) => {
          // Map any angle to (-π, +π] without changing its visual
          // orientation — Mat4.rotateY(θ + 2π) renders identically
          // to Mat4.rotateY(θ).
          const m = ((a + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI
          return m
        }
        piece.rotate[0] = normalise(piece.rotate[0] + shortDelta(trx, piece.rotate[0]) * k)
        piece.rotate[1] = normalise(piece.rotate[1] + shortDelta(trY, piece.rotate[1]) * k)
        piece.rotate[2] = normalise(piece.rotate[2] + shortDelta(trz, piece.rotate[2]) * k)
      }
      piece.visible = this.unit.isPieceVisible(idx)
    }
  }
}
