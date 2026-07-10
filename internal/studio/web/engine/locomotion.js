// locomotion.js
//
// Shared per-tick movement integrator for self-propelled ground + water
// units (walkers, vehicles, the Commander, ships and submarines).  The
// headless engine's #stepMovement / #stepAttack are the SINGLE mover for
// both views — the sandbox renders the engine units directly, and the
// unit editor adopts its unit into an engine and reads the engine-computed
// pose back each frame — so a unit drives identically whichever view it's
// tested in.
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

// The simulation runs unit locomotion at 30 Hz (sim.TickHz), so every FBI
// per-frame rate converts to a per-second rate by × 30. Movement and COB
// scripting share this one 30 Hz clock — the engine advances both on the same
// tick — so these helpers and the wasm sim agree on the per-frame→per-second
// scaling.
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
  let desired = Math.min(maxSpeed * face, brakeCap)
  // Turn-radius reachability.  A unit curves with radius = speed / turnRate.
  // If that circle is WIDER than the distance to the target it can never bend
  // onto the point — it just orbits forever (the fast-fighter, sluggish-turn
  // case: radius ≈ 260 wu for a target 130 wu away).  Only in that case slow
  // down so the radius fits (≈ the distance), which lets the unit spiral in.
  // Moderate-turn units (ground, ships) have radius ≤ dist already, so this
  // never bites and their existing brake-driven approach is unchanged.
  if (adh > 0.35 && turn > 1e-4 && (desired / turn) > dist) {
    desired = Math.min(desired, turn * dist * 0.9)
  }

  // Ramp the actual speed toward the desired one under accel / brake.
  if (speed < desired) speed = Math.min(desired, speed + accel * dtSec)
  else speed = Math.max(desired, speed - brake * dtSec)
  state.speed = speed

  const step = Math.min(dist, speed * dtSec)
  state.x += Math.sin(state.heading) * step
  state.z += Math.cos(state.heading) * step
  return { arrived: false, isMoving: true, dist }
}

// _turnToward rotates the heading toward `want` at the FBI turn rate.
function _turnToward(state, want, meta, dtSec) {
  const dh = shortestArc(want - state.heading)
  const step = turnRateRadPerSec(meta) * dtSec
  if (Math.abs(dh) > step) state.heading += Math.sign(dh) * step
  else state.heading = want
}

// _flyForward turns toward `want` and drives forward along the heading at
// (ramped) max speed — the "always flying" motion fixed-wing aircraft use.
function _flyForward(state, want, meta, dtSec) {
  _turnToward(state, want, meta, dtSec)
  const target = maxSpeedWUPerSec(meta)
  let s = state.speed || 0
  if (s < target) s = Math.min(target, s + accelWUPerSec2(meta) * dtSec)
  else s = Math.max(target, s - brakeWUPerSec2(meta) * dtSec)
  state.speed = s
  state.x += Math.sin(state.heading) * s * dtSec
  state.z += Math.cos(state.heading) * s * dtSec
}

// attackManeuver — fly an aircraft's attack pattern around a target at (tx,tz),
// using its weapon `range` (world units) for standoff + fly-by geometry.  Two
// flavours, picked from the FBI:
//   * Hover gunship (meta.isHover, e.g. Brawler) — close to within range, then
//     STRAFE: slide along an arc left↔right around the target at standoff,
//     always FACING it, so it pours fire in while weaving.
//   * Fixed-wing (e.g. Hawk) — can't stop: fly straight AT the target (firing
//     once in range), overshoot, then arc out to a wide turn-around point and
//     come back for another pass (alternating sides ⇒ figure-eight).
// state carries x/z/heading/speed plus persistent maneuver fields (atkPhase,
// sweepPhase/Center, egX/egZ, flybySide).  Mutated in place.  Returns
// { inRange } so the caller knows whether the weapon may fire this tick.
export function attackManeuver(state, tx, tz, meta, range, dtSec, opts = {}) {
  const dx = tx - state.x
  const dz = tz - state.z
  const dist = Math.hypot(dx, dz)
  const bearing = Math.atan2(dx, dz)

  if (meta && meta.isHover) {
    const standoff = Math.max(24, range * 0.6)
    if (dist > range) {
      // Out of range — close in head-on.
      state.atkPhase = 'approach'
      _flyForward(state, bearing, meta, dtSec)
    } else {
      // In range — strafe an arc around the target, nose always on it.
      if (state.atkPhase !== 'strafe') {
        state.atkPhase = 'strafe'
        state.sweepCenter = Math.atan2(state.x - tx, state.z - tz)  // lock the side we arrived from
        state.sweepPhase = 0
      }
      state.sweepPhase += dtSec * 0.8
      const ang = state.sweepCenter + 0.7 * Math.sin(state.sweepPhase)   // ±40° sweep
      const desX = tx + standoff * Math.sin(ang)
      const desZ = tz + standoff * Math.cos(ang)
      const mdx = desX - state.x, mdz = desZ - state.z
      const md = Math.hypot(mdx, mdz)
      const step = Math.min(md, maxSpeedWUPerSec(meta) * dtSec)
      if (md > 1e-3) { state.x += (mdx / md) * step; state.z += (mdz / md) * step }
      state.speed = md > 1e-3 ? maxSpeedWUPerSec(meta) : 0
      _turnToward(state, bearing, meta, dtSec)   // face the target while strafing
    }
    return { inRange: dist <= range }
  }

  // Fixed-wing fly-by.  A missile-armed fighter peels at ~40 % of weapon
  // range, before it ends up dangerously close.  A bomber (opts.bomberMode)
  // commits to its current heading inside the drop window so the whole bomb
  // string lays on a straight line — a chasing turn truncates the run and
  // bombs 3-4 end up landing 20+ wu off the aim point — and only banks away
  // once it has cleared the FAR edge of the window (target + opts.bomberPass-
  // throughDist).
  const passthrough = (opts.bomberMode && opts.bomberPassthroughDist > 0)
    ? opts.bomberPassthroughDist : 0
  const egressDist = opts.bomberMode ? 30 : Math.max(30, range * 0.4)
  if (state.atkPhase !== 'egress') {
    state.atkPhase = 'approach'
    // Hold heading inside the drop zone (bomber + within passthrough distance
    // of the target).  Everywhere else, steer to the target bearing.
    const inDropZone = opts.bomberMode && dist <= passthrough
    _flyForward(state, inDropZone ? state.heading : bearing, meta, dtSec)
    // Past-target test: forward·(target - pos) negative ⇒ the carrier has
    // crossed the aim point.  Bombers wait for that AND to have flown clear
    // of the far drop-zone edge before peeling off; non-bombers peel as soon
    // as they get inside the standoff range.
    const fwdX = Math.sin(state.heading), fwdZ = Math.cos(state.heading)
    const dot = fwdX * dx + fwdZ * dz
    const pastTarget = (dot < 0)
    const triggerEgress = opts.bomberMode
      ? (pastTarget && dist >= passthrough)
      : (dist < egressDist)
    if (triggerEgress) {
      state.atkPhase = 'egress'
      const sx = fwdZ, sz = -fwdX
      state.flybySide = (state.flybySide || 1) * -1
      const lead = Math.max(180, range * 1.2)
      const lat = Math.max(120, range * 0.7) * state.flybySide
      state.egX = tx + fwdX * lead + sx * lat
      state.egZ = tz + fwdZ * lead + sz * lat
    }
  } else {
    const ex = state.egX - state.x, ez = state.egZ - state.z
    _flyForward(state, Math.atan2(ex, ez), meta, dtSec)
    if (Math.hypot(ex, ez) < 40) state.atkPhase = 'approach'   // come back around for another run
  }
  return { inRange: dist <= range }
}
