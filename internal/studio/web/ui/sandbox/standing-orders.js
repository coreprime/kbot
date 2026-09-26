// standing-orders.js
//
// The unit meta (/api/studio/unit/{name}) carries each unit's standing orders
// resolved the way the game resolves the FBI: standingMoveOrder /
// standingFireOrder are 2 (Roam / Fire at Will) when the key is missing and
// otherwise the value's low two bits, so an explicit 0 — the commanders'
// StandingMoveOrder=0, the Lancet's StandingFireOrder=0 — is Hold Position /
// Hold Fire. The sim's spawn path takes 1 and 2 from the meta but reads 0 as
// "use its own default" (Maneuver / Fire at Will), so a unit whose resolved
// order is Hold needs a Stance order right after it spawns. A TA: Kingdoms
// meta sends an order only when its FBI value is non-zero, so its units keep
// the sim's spawn defaults.

const MOVE_MANEUVER = 1
const FIRE_AT_WILL = 2

// spawnStance returns the {move, fire} Stance order a freshly spawned unit
// needs so it starts on the orders its meta resolves, or null when the spawn
// already applies them (neither order is 0). An order outside 0..2 stays on
// the sim's spawn default.
export function spawnStance(meta) {
  const move = meta?.standingMoveOrder
  const fire = meta?.standingFireOrder
  if (move !== 0 && fire !== 0) return null
  const valid = (v) => Number.isInteger(v) && v >= 0 && v <= 2
  return {
    move: valid(move) ? move : MOVE_MANEUVER,
    fire: valid(fire) ? fire : FIRE_AT_WILL,
  }
}
