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

import { ParticlePool } from './cob-particles.js'

export class CobBinding {
  // model: Model from model-loader.js (with root piece + findPiece)
  // runtime: CobRuntime from cob-runtime.js
  constructor(model, runtime) {
    this.model = model
    this.runtime = runtime
    // Build a quick model.piece → cob.pieceIndex map so the per-frame
    // sync doesn't redo name lookups.  Pieces whose names don't
    // appear in the COB (rare - typically the root "base" piece
    // matches) get index -1 and just sit at their static origin.
    this._pieceMap = new Map() // Piece → cobPieceIndex
    // Also build the inverse so the SFX emit hook can resolve a COB
    // pieceIndex back to the model's Piece for a world-space anchor.
    this._cobToPiece = new Map() // cobPieceIndex → Piece
    for (const p of model.flat) {
      const idx = runtime.pieceIndexByName(p.name)
      this._pieceMap.set(p, idx)
      if (idx >= 0) this._cobToPiece.set(idx, p)
    }
    this.particles = new ParticlePool(1024)
    // Install the runtime's emit-sfx hook.  Keep any existing hook
    // intact so callers that supplied a log/getUnitValue keep them.
    const prevEmit = runtime.hooks.emitSfx
    runtime.hooks.emitSfx = (sfxType, pieceIdx) => {
      this._emitSfx(sfxType, pieceIdx)
      if (prevEmit) prevEmit(sfxType, pieceIdx)
    }
    // OP_EXPLODE → particle burst.  Without this the Killed script
    // and any weapon that uses `explode piece type N` just runs as a
    // silent state change; in TA they're the visible "this part flew
    // off in a fireball" moments, so we map every explode to a
    // sparks+smoke cluster at the piece's anchor.  Magnitude scales
    // with the bit mask (more set bits = bigger boom).
    const prevExplode = runtime.hooks.explode
    runtime.hooks.explode = (pieceIdx, sfxType) => {
      this._emitExplode(pieceIdx, sfxType)
      if (prevExplode) prevExplode(pieceIdx, sfxType)
    }
  }

  // tick advances the runtime by dtMs and pushes resulting per-piece
  // state into the model.  Returns the instruction count from the
  // runtime tick - useful as a runaway / metrics signal.
  tick(dtMs) {
    const count = this.runtime.tick(dtMs)
    this._sync()
    // Particles share the runtime's playback rate so slow-mo
    // applies uniformly to script + SFX.
    this.particles.tick(dtMs * this.runtime.playbackRate)
    return count
  }

  // start exposes the runtime's entry-point launcher with the same
  // name so callers can write `binding.start('Activate')` without
  // dereferencing through `.runtime`.  Args are pushed as initial
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
    return this.runtime.start(scriptName, args)
  }
  hasScript(name) { return this.runtime.hasScript(name) }
  listScripts() { return this.runtime.listScripts() }

  // signal forwards to the runtime so the host can fire signals
  // outside of a running script (e.g. the UI's "Kill" button).
  signal(n) { this.runtime.signal(n) }

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
  _emitFireBurst(scriptName) {
    const m = /^Fire(Primary|Secondary|Tertiary|Weapon(\d+))$/i.exec(scriptName)
    if (!m) return
    const slot = (m[1] || '').toLowerCase()
    const weaponN = m[2] ? +m[2] : (slot === 'primary' ? 1 : slot === 'secondary' ? 2 : slot === 'tertiary' ? 3 : 1)
    // Heuristic piece selection in order: explicit numbered flare
    // (flare2 for secondary), generic flare, then alt naming TA
    // models use (rfirept/lfirept on twin-cannon units, muzzleN,
    // barrelN).  First hit wins; falls back to model origin.
    const candidates = []
    if (weaponN === 1) candidates.push('flare', 'flare1', 'rfirept', 'firept1', 'muzzle', 'muzzle1', 'barrel')
    else candidates.push(`flare${weaponN}`, `lfirept`, `firept${weaponN}`, `muzzle${weaponN}`, `barrel${weaponN}`)
    let piece = null
    for (const name of candidates) {
      const p = this.model.findPiece(name)
      if (p) { piece = p; break }
    }
    // Last-ditch: any piece whose name matches /flare|firept|muzzl/i.
    if (!piece) piece = this.model.flat.find((p) => /flare|firept|muzzl/i.test(p.name)) || null
    let anchor = [0, 0, 0]
    if (piece && piece.worldMatrix) {
      const wm = piece.worldMatrix
      anchor = [wm[12], wm[13], wm[14]]
    }
    this.particles.emit(4 /* muzzle flash */, anchor)
    this._emitCluster(3 /* spark */, anchor, 6, { spread: 1.2 })
    this._emitCluster(2 /* light smoke */, anchor, 4, { spread: 1.0 })
  }

  // _emitCluster spawns N particles at anchor with randomised
  // sub-pixel offsets so the cluster reads as a puff rather than a
  // single dot.  `spread` is the world-space radius of the
  // distribution (defaults to 0.8wu — enough to feel volumetric on
  // a TA unit, small enough to still look anchored to the piece).
  _emitCluster(kind, anchor, n, opts = {}) {
    const spread = opts.spread ?? 0.8
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2
      const r = Math.random() * spread
      const dx = Math.cos(ang) * r
      const dz = Math.sin(ang) * r
      const dy = (Math.random() - 0.3) * spread * 0.5
      this.particles.emit(kind, [anchor[0] + dx, anchor[1] + dy, anchor[2] + dz])
    }
  }

  _worldAnchor(pieceIdx) {
    const piece = this._cobToPiece.get(pieceIdx)
    if (!piece) return [0, 0, 0]
    // The renderer recomputes worldMatrix on every frame; we just
    // read the translation column for the anchor.  Slightly stale
    // (last frame's transform) but the particle lifetime is so
    // long compared to the per-frame budget that no one will see
    // it.  Indices 12/13/14 are the translation row of a 4×4
    // column-major matrix in our Mat4 representation.
    const m = piece.worldMatrix
    return [m[12], m[13], m[14]]
  }

  _sync() {
    for (const [piece, idx] of this._pieceMap) {
      if (idx < 0) continue
      const off = this.runtime.pieceOffset(idx)
      const rot = this.runtime.pieceRotation(idx)
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
      piece.move[0] = off[0]
      piece.move[1] = off[1]
      piece.move[2] = -off[2]
      piece.rotate[0] = -rot[0]
      piece.rotate[1] = -rot[1]
      piece.rotate[2] = rot[2]
      piece.visible = this.runtime.isPieceVisible(idx)
    }
  }
}
