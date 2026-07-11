// world-state-adapter.js
//
// Converts the sandbox scene's interpolated adapter state into the worldState
// shape @coreprime/kbot-game3d's world.applyState() consumes, so a sandbox pane
// drives the high-level renderer the same way the replayer does — the pane no
// longer hand-assembles renderer entities, scene lights or explosion geometry.
//
// The sim frames still come from the local wasm engine (the no-drift property):
// this only reshapes each already-interpolated frame the scene produced into
// applyState's contract. Piece transforms travel PACKED (engine stride-7) and
// are applied BY NAME inside the world through the unit's COB piece table —
// index-blind application scrambles bodies, so pieceNames rides alongside.

import { lerpPackedPieces } from '@coreprime/kbot-game3d'

// snapshotToWorldState reads the scene's live, interpolated unit adapters and
// projectile list and returns { units, projectiles } for world.applyState.
//
// Live deaths do NOT flow through here — a dead unit is dropped from the unit
// set and its destruction plays through world.unitDeath on the scene's death
// event (the same one-shot fan-out the debris field used), so the blast/debris/
// wreck ladder fires exactly once with its pack-sourced AoE.
//
// opts:
//   alpha         0..1 sub-tick phase for packed-piece interpolation.
//   isSelected    (id) → bool: mark the unit in the selection ring.
//   isHighlighted (id) → bool: hover / inspector outline for the frame.
//   padSeat       (unit) → [x,y,z] | null: pin a nascent factory buildee to the
//                 builder's live build-pad piece (rides the spinning plate).
//   carrierOf     (id) → carrier adapter | null: resolve a passenger's carrier.
export function snapshotToWorldState(scene, opts = {}) {
  const alpha = opts.alpha != null ? opts.alpha : 1
  const isSelected = opts.isSelected || (() => false)
  const isHighlighted = opts.isHighlighted || (() => false)
  const padSeat = opts.padSeat || (() => null)
  const carrierOf = opts.carrierOf || (() => null)

  const units = []
  for (const u of scene.units()) {
    if (!u.model) continue
    // A dead unit's destruction is played by the death-event fan-out; a
    // corpsetype-3 kill leaves nothing to draw.
    if (u.dead || u.corpseHidden) continue

    let posX = u.pos.x
    let posY = u.pos.y
    let posZ = u.pos.z

    // Transport attach: a passenger inside a surface transport (the hold) is
    // hidden; air-transport sling cargo hangs beneath the carrier (position
    // pinned by the sim, so it rides along without extra work here).
    if (u.carriedBy) {
      const carrier = carrierOf(u.carriedBy)
      if (carrier && carrier.meta && !carrier.meta.isAircraft) continue
    }

    // Factory buildee rides the build plate: pin its position to the builder's
    // QueryBuildInfo pad piece (its facing stays the buildee's own sim heading,
    // which the sim spins with the pad each tick).
    if (u.buildPercent < 100) {
      const seat = padSeat(u)
      if (seat) { posX = seat[0]; posY = seat[1]; posZ = seat[2] }
    }

    const out = {
      id: u.id,
      // A destroyed unit whose corpse survived renders its wreck 3DO in its
      // authored static pose (no COB animation).
      model: u.wreckName || u.name,
      x: posX,
      y: posY,
      z: posZ,
      heading: u.heading,
      side: u.side | 0,
      buildPercent: u.buildPercent,
      selected: !!isSelected(u.id),
      highlight: !!isHighlighted(u.id),
    }

    // Locomotion presentation overlay (aircraft bank, hovercraft gyration).
    const meta = u.meta || null
    if (meta) {
      if (meta.isAircraft) out.air = true
      if (meta.isHovercraft) out.hover = true
    }

    // Health bar + damage smoke: only meaningful while the sim reports health.
    if (u.health != null && Number.isFinite(u.health)) {
      out.hp01 = Math.max(0, Math.min(1, u.health / 100))
    }

    // COB piece animation — hand the world the interpolated engine stride-7
    // buffer plus the unit's COB piece-name table so it applies transforms by
    // name into its own per-pane model clone. A wreck has no live pose.
    const names = u._cobPieceNames
    if (!u.wreckName && names && names.length && u._pieces1) {
      out.pieceNames = names
      out.piecesPacked = (u._pieces0 && alpha < 1)
        ? lerpPackedPieces(u._pieces0, u._pieces1, alpha)
        : u._pieces1
    }

    units.push(out)
  }

  // In-flight model projectiles (missiles / rockets / bombs): the sim owns
  // their flight and the world draws the weapon's 3DO along the trajectory.
  // Particle shots (no 3DO) carry no model and are drawn by the fire visual.
  const projectiles = []
  for (const p of scene.projectiles()) {
    if (!p.model) continue
    projectiles.push({
      id: p.id,
      model: p.model,
      x: p.pos.x,
      y: p.pos.y,
      z: p.pos.z,
      heading: p.heading,
      pitch: p.pitch,
    })
  }

  return { units, projectiles }
}
