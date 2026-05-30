// projectiles.js
//
// Per-tick flight simulation for TA weapons that carry a 3DO model — the
// missiles, rockets and bombs whose projectile is a real mesh in the game
// (the weapon TDF's `model=` field).  Lasers, plain bullets and shells with
// no model keep the lightweight dead-reckoned particle path in
// weapon-driver.js; this module exists for the ones the player can see fly.
//
// The simulation is headless and data-driven: every rate comes straight from
// the weapon TDF (weaponvelocity / weaponacceleration / startvelocity /
// turnrate / weapontimer / areaofeffect / dropped / vlaunch / tracks /
// selfprop / ballistic).  The engine owns the active list and steps it each
// tick; both the sandbox and the unit-editor render the resulting transforms,
// so a missile flies identically whichever view it's tested in.
//
// Heading/pitch are the renderer convention used everywhere else: heading 0 =
// +Z increasing toward +X, so forward = (sin h, cos h) on the ground plane
// and pitch lifts toward +Y.

import { angleToRadians } from './cob-opcodes.js'
import { shortestArc } from './locomotion.js'

// projectileMode picks a flight behaviour from the weapon TDF flags.
//   dropped   — gravity bomb: released at the carrier's velocity, no thrust.
//   vlaunch   — vertical launch: climbs straight up, then pitches over + homes.
//   guided    — self-propelled + tracking with a turn rate: homes on the target.
//   ballistic — unpowered arc under gravity (mortars, cannons that carry a model).
//   straight  — constant-heading powered shot (unguided rockets).
export function projectileMode(weapon) {
  if (!weapon) return 'straight'
  if (weapon.dropped) return 'dropped'
  if (weapon.vlaunch) return 'vlaunch'
  if ((weapon.tracks || weapon.selfProp) && weapon.turnRate > 0) return 'guided'
  if (weapon.ballistic) return 'ballistic'
  return 'straight'
}

// hasModelProjectile — true when the weapon flies a visible 3DO mesh that the
// projectile simulation should own (and the renderer should draw).  Beam
// weapons hit instantly and never travel, so they're excluded even if the TDF
// happens to name a model.
export function hasModelProjectile(weapon) {
  return !!(weapon && weapon.model && !weapon.beamWeapon)
}

// makeProjectile builds the simulation record for one shot.
//   anchor     — muzzle-exit world XYZ (the engine's firing-piece resolver).
//   target     — aim point [x,y,z]; for a unit target the engine also passes
//                targetUnitId so the guided modes re-read the live position.
//   gravity    — world gravity (wu/s²) for the falling/arcing modes.
export function makeProjectile({ id, ownerId, slot, weapon, anchor, target, targetUnitId = null, gravity = 80 }) {
  const mode = projectileMode(weapon)
  const vmax = (weapon.velocityWU > 0) ? weapon.velocityWU : 200
  const accel = (weapon.accelerationWU > 0) ? weapon.accelerationWU : 0
  // Launch speed: startvelocity if the TDF gives one, else top speed (no
  // ramp), except a dropped bomb leaves the rack with no forward thrust.
  const speed0 = (weapon.startVelocityWU > 0)
    ? weapon.startVelocityWU
    : (mode === 'dropped' ? 0 : vmax)
  const tx = target[0]
  const ty = (target.length >= 3) ? target[1] : 0
  const tz = target[2]
  const dx = tx - anchor[0]
  const dy = ty - anchor[1]
  const dz = tz - anchor[2]
  const d = Math.hypot(dx, dy, dz) || 1

  let vx, vy, vz
  if (mode === 'vlaunch') {
    vx = 0; vy = Math.max(1, speed0); vz = 0   // straight up off the rail
  } else if (mode === 'dropped') {
    // Bombs fall straight down from the bomber rather than inheriting its
    // forward momentum.  Real bombs do carry the carrier's velocity, but
    // they also have aerodynamic drag we don't model; without that drag the
    // bomb visually "outstrips" the bomber when it turns away on egress.
    // Dropping straight matches the in-game look of bombs falling from the
    // bomber and lays them along the flight path.
    vx = 0; vy = 0; vz = 0
  } else {
    vx = (dx / d) * speed0; vy = (dy / d) * speed0; vz = (dz / d) * speed0
  }

  // Lifetime: weapontimer if specified, else the time-of-flight at top speed
  // over the weapon's range (a little extra for arcing/homing paths so the
  // mesh doesn't vanish mid-pursuit).
  const range = (weapon.rangeWU > 0) ? weapon.rangeWU : vmax * 3
  const slack = (mode === 'ballistic' || mode === 'dropped') ? 1.6
    : (mode === 'guided' || mode === 'vlaunch') ? 1.4 : 1.2
  const lifeSec = (weapon.flightTimeSec > 0)
    ? weapon.flightTimeSec
    : Math.max(0.4, (range / vmax) * slack)

  return {
    id, ownerId, slot, mode,
    model: weapon.model,
    weaponName: weapon.name,
    pos: { x: anchor[0], y: anchor[1], z: anchor[2] },
    vel: { x: vx, y: vy, z: vz },
    launchY: anchor[1],
    // Carry the muzzle-exit anchor so inspectors can plot origin → destination
    // for a projectile that's already in flight (pos changes every tick).
    origin: { x: anchor[0], y: anchor[1], z: anchor[2] },
    target: { x: tx, y: ty, z: tz },
    targetUnitId,
    speed: Math.hypot(vx, vy, vz),
    vmax,
    accel,
    // The missile's own homing rate.  TA weapon `turnrate` is in TA angle
    // units per second (a half-turn ≈ 32768 → π rad/s, a believable missile
    // rate); 0 = unguided.
    turnRad: (weapon.turnRate > 0) ? angleToRadians(weapon.turnRate) : 0,
    gravity: (mode === 'ballistic' || mode === 'dropped') ? gravity : 0,
    // Blast diameter — carried for the hit event's damage radius, NOT for the
    // detonation trigger (a huge-AoE EMP missile must still fly all the way to
    // the aim point before it goes off, not detonate a blast-radius away).
    aoeWU: (weapon.areaOfEffectWU > 0) ? weapon.areaOfEffectWU : 0,
    ageSec: 0,
    lifeSec,
    phase: (mode === 'vlaunch') ? 'ascent' : 'cruise',
    heading: Math.atan2(vx, vz),
    pitch: Math.atan2(vy, Math.hypot(vx, vz)),
    dead: false,
    hit: false,   // true on the tick it reaches the target (vs. just expiring)
  }
}

// _steerToward rotates the velocity vector toward (target − pos) at turnRad
// rad/sec on both yaw and pitch, holding the current speed — the homing turn.
function _steerToward(p, dtSec) {
  const dx = p.target.x - p.pos.x
  const dy = p.target.y - p.pos.y
  const dz = p.target.z - p.pos.z
  const wantHeading = Math.atan2(dx, dz)
  const wantPitch = Math.atan2(dy, Math.hypot(dx, dz))
  let curHeading = Math.atan2(p.vel.x, p.vel.z)
  let curPitch = Math.atan2(p.vel.y, Math.hypot(p.vel.x, p.vel.z))
  const step = (p.turnRad > 0 ? p.turnRad : Math.PI) * dtSec
  const dh = shortestArc(wantHeading - curHeading)
  curHeading += (Math.abs(dh) <= step) ? dh : Math.sign(dh) * step
  const dp = wantPitch - curPitch
  curPitch += (Math.abs(dp) <= step) ? dp : Math.sign(dp) * step
  const cp = Math.cos(curPitch)
  p.vel.x = Math.sin(curHeading) * cp * p.speed
  p.vel.z = Math.cos(curHeading) * cp * p.speed
  p.vel.y = Math.sin(curPitch) * p.speed
}

// stepProjectile advances ONE projectile by dtSec.  opts.targetPos (a live
// {x,y,z}) lets a guided shot chase a moving unit; opts.groundY is the floor
// for falling modes (default 0).  Mutates p in place; sets p.dead (and p.hit
// when it reached the target rather than timing out).
export function stepProjectile(p, dtSec, opts = {}) {
  if (p.dead || dtSec <= 0) return
  const groundY = (opts.groundY != null) ? opts.groundY : 0
  if (opts.targetPos) {
    p.target.x = opts.targetPos.x
    p.target.y = opts.targetPos.y
    p.target.z = opts.targetPos.z
  }
  p.ageSec += dtSec

  // Ramp speed toward top speed under acceleration (instant when accel = 0).
  if (p.accel > 0) p.speed = Math.min(p.vmax, p.speed + p.accel * dtSec)
  else p.speed = p.vmax

  if (p.mode === 'guided' || (p.mode === 'vlaunch' && p.phase === 'home')) {
    _steerToward(p, dtSec)
  } else if (p.mode === 'vlaunch' && p.phase === 'ascent') {
    // Climb straight up, then pitch over once there's enough altitude to arc
    // toward the target without diving into the ground.  "Enough" = the
    // homing turn radius (speed / turnRate) — fully derived from the TDF.
    p.vel.x = 0; p.vel.z = 0; p.vel.y = p.speed
    const turnRadius = (p.turnRad > 0) ? p.speed / p.turnRad : 0
    if ((p.pos.y - p.launchY) >= turnRadius || (p.turnRad <= 0 && p.speed >= p.vmax)) {
      p.phase = 'home'
    }
  } else if (p.mode === 'dropped' || p.mode === 'ballistic') {
    p.vel.y -= p.gravity * dtSec   // unpowered: gravity bends the path
  } else {
    // Straight powered shot — re-scale the heading vector to the ramped speed.
    const s = Math.hypot(p.vel.x, p.vel.y, p.vel.z) || 1
    p.vel.x = (p.vel.x / s) * p.speed
    p.vel.y = (p.vel.y / s) * p.speed
    p.vel.z = (p.vel.z / s) * p.speed
  }

  p.pos.x += p.vel.x * dtSec
  p.pos.y += p.vel.y * dtSec
  p.pos.z += p.vel.z * dtSec

  const horiz = Math.hypot(p.vel.x, p.vel.z)
  p.heading = Math.atan2(p.vel.x, p.vel.z)
  p.pitch = Math.atan2(p.vel.y, horiz)

  // Detonation.  Reached the target (within one tick's travel, so a fast
  // shot registers the pass instead of tunnelling through); hit the ground
  // while falling; or ran out its flight time.  The trigger is pure physics —
  // the blast radius (aoeWU) is for damage, not for when it goes off.
  const distT = Math.hypot(p.target.x - p.pos.x, p.target.y - p.pos.y, p.target.z - p.pos.z)
  const reach = p.speed * dtSec
  if (distT <= reach) {
    p.dead = true; p.hit = true
  } else if ((p.mode === 'dropped' || p.mode === 'ballistic') && p.pos.y <= groundY) {
    p.pos.y = groundY; p.dead = true; p.hit = true
  } else if (p.ageSec >= p.lifeSec) {
    p.dead = true
  }
}
