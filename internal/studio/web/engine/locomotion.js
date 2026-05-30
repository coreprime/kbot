// locomotion.js
//
// Shared per-tick movement integrator for self-propelled ground + water
// units (walkers, vehicles, the Commander, ships and submarines).  Both
// movement drivers — the headless engine's #stepMovement (sandbox) and the
// unit-editor MvControls._updateMove — call stepSurfaceLocomotion so a unit
// drives the SAME way whichever view it's tested in.
//
// The model is "drive-and-steer", not "pivot-then-go": the unit keeps
// translating forward while it rotates toward the target, so its path curves
// in an ARC the way a real tank / boat does.  The turn radius isn't a tunable
// — it falls out of the physics: radius = forwardSpeed / turnRate, both taken
// straight from the unit's FBI stats.  Speed ramps up under Acceleration and
// eases off under BrakeRate (so units lean into a stop instead of snapping to
// it), and forward thrust is cut when the target sits well behind the unit so
// it pivots rather than driving a huge loop away from the goal.
//
// All angles are in the renderer convention: heading 0 = +Z, increasing
// toward +X, so forward = (sin(heading), cos(heading)).

import { TA_TURNS_PER_CIRCLE } from './cob-opcodes.js'

// TA simulates unit locomotion at 30 Hz, so every FBI per-frame rate converts
// to a per-second rate by × 30.  This is deliberately NOT the COB script tick
// (40 Hz) — movement and scripting run on different clocks in TA.
const TA_MOVE_HZ = 30

// Convert FBI MaxVelocity (world-units / frame) → wu / second.
export function maxSpeedWUPerSec(meta) {
  const v = (meta && meta.maxVelocity > 0) ? meta.maxVelocity : 1.0
  return v * TA_MOVE_HZ
}

// Convert FBI TurnRate (TA-angle / frame) → radians / second.
export function turnRateRadPerSec(meta) {
  const t = (meta && meta.turnRate > 0) ? meta.turnRate : 600
  return (t / TA_TURNS_PER_CIRCLE) * Math.PI * 2 * TA_MOVE_HZ
}

// FBI Acceleration / BrakeRate are world-units / frame²; × 30² → wu / sec².
// Clamped to a band so every unit ramps perceptibly (an under-spec FBI still
// eases in/out) without a brisk unit snapping straight to top speed.
export function accelWUPerSec2(meta) {
  const a = (meta && meta.acceleration > 0) ? meta.acceleration : 0.05
  return Math.max(8, Math.min(240, a * TA_MOVE_HZ * TA_MOVE_HZ))
}
export function brakeWUPerSec2(meta) {
  const b = (meta && meta.brakeRate > 0) ? meta.brakeRate : 0.1
  return Math.max(12, Math.min(400, b * TA_MOVE_HZ * TA_MOVE_HZ))
}

// shortestArc maps an angle delta into (-π, +π] — the shortest signed turn.
export function shortestArc(a) {
  while (a > Math.PI) a -= Math.PI * 2
  while (a < -Math.PI) a += Math.PI * 2
  return a
}

// stepSurfaceLocomotion advances ONE tick of arc movement toward (tx, tz).
//
//   state — { x, z, heading, speed } in world units / radians / (wu/sec).
//           Mutated in place: x, z, heading and speed are all updated.
//   meta  — the unit's FBI-derived stats (maxVelocity, turnRate,
//           acceleration, brakeRate).
//   dtSec — wall delta already scaled by playback rate (0 while paused).
//
// Returns { arrived, isMoving, dist }.  `arrived` is true on the tick the
// unit reaches the target and has braked to a stop — the caller clears its
// move-target then.
export function stepSurfaceLocomotion(state, tx, tz, meta, dtSec, opts = {}) {
  const arriveDist = opts.arriveDist != null ? opts.arriveDist : 0.5
  const dx = tx - state.x
  const dz = tz - state.z
  const dist = Math.hypot(dx, dz)

  const maxSpeed = maxSpeedWUPerSec(meta)
  const accel = accelWUPerSec2(meta)
  const brake = brakeWUPerSec2(meta)
  const turn = turnRateRadPerSec(meta)
  let speed = state.speed || 0

  // Within the arrival radius — bleed the remaining momentum off so the unit
  // glides to a stop rather than stamping onto the exact point.
  if (dist < arriveDist) {
    speed = Math.max(0, speed - brake * dtSec)
    state.speed = speed
    if (speed <= 0.05) { state.speed = 0; return { arrived: true, isMoving: false, dist } }
    const glide = Math.min(dist, speed * dtSec)
    state.x += Math.sin(state.heading) * glide
    state.z += Math.cos(state.heading) * glide
    return { arrived: false, isMoving: true, dist }
  }

  // Steer toward the target at the FBI turn rate (rate-limited — no snapping).
  const want = Math.atan2(dx, dz)
  const dh = shortestArc(want - state.heading)
  const turnStep = turn * dtSec
  if (Math.abs(dh) > turnStep) state.heading += Math.sign(dh) * turnStep
  else state.heading = want

  // How much forward thrust to allow while turning — this is what bends the
  // path into an arc.  Full thrust while the nose is within 90° of the
  // target; fade to zero by ~150° so when the goal is essentially behind the
  // unit it pivots on the spot (you can't arc to a point directly behind you)
  // instead of driving a wide loop in the wrong direction.
  const adh = Math.abs(dh)
  const HALF_PI = Math.PI / 2
  const PIVOT = 2.618 // ≈150°
  let face = 1
  if (adh >= PIVOT) face = 0
  else if (adh > HALF_PI) face = 1 - (adh - HALF_PI) / (PIVOT - HALF_PI)

  // Brake into the target: the fastest speed from which we can still decel to
  // ~0 by the time we arrive is sqrt(2·brake·distRemaining).  Capping desired
  // speed to that gives a smooth slow-down on approach AND tightens the turn
  // radius near the goal (slower ⇒ smaller radius), helping the unit settle
  // onto the point instead of circling it.
  const brakeCap = Math.sqrt(Math.max(0, 2 * brake * (dist - arriveDist)))
  const desired = Math.min(maxSpeed * face, brakeCap)

  // Ramp the actual speed toward the desired one under accel / brake.
  if (speed < desired) speed = Math.min(desired, speed + accel * dtSec)
  else speed = Math.max(desired, speed - brake * dtSec)
  state.speed = speed

  const step = Math.min(dist, speed * dtSec)
  state.x += Math.sin(state.heading) * step
  state.z += Math.cos(state.heading) * step
  return { arrived: false, isMoving: true, dist }
}
