// hover-sway.js — the hovercraft cushion sway, computed in WORLD space.
//
// A hovercraft's rock is a property of the air cushion under it, not of
// the hull's own axes: if a craft leaning toward the map's west edge yaws
// half a turn, the lean must stay pointing west — which the hull now
// experiences as a lean to its other side.  So the sway is generated as a
// world-frame lean vector first and only then composed with the unit's
// heading into the local pitch/roll channels the renderer's pose overlay
// applies (rotateX/rotateZ after the yaw).
//
// Everything here is a pure function of (time, heading, motion) so the
// sway is deterministic under a driven fx clock and unit-testable
// headlessly.  Amplitudes ride HOVERCRAFT_WOBBLE_SCALE (performance.js).

import { HOVERCRAFT_WOBBLE_SCALE } from './performance.js'

// Baseline / motion-driven lean amplitude (radians) and heave (world
// units).  The at-rest term keeps a parked craft barely shivering; the
// motion term (0..1, ground speed blended with acceleration magnitude)
// carries the bulk of the wobble.
const SWAY_AMP_REST = 0.027
const SWAY_AMP_MOTION = 0.075
const HEAVE_REST = 0.48
const HEAVE_MOTION = 1.3

/**
 * hoverSwayWorldLean returns the cushion's lean as a WORLD-frame tilt
 * vector: lx/lz are the small-angle tilts of the craft's up-axis toward
 * world +X / +Z (radians), heave the vertical breathe (wu).  Two
 * incommensurate frequencies per axis so the gyration never reads as a
 * clean loop; `phase` decorrelates units so a flotilla doesn't pump in
 * unison.  Heading-independent by construction.
 */
export function hoverSwayWorldLean(tSec, { motion = 0, phase = 0 } = {}) {
  const m = Math.min(1, Math.max(0, motion))
  const amp = (SWAY_AMP_REST + SWAY_AMP_MOTION * m) * HOVERCRAFT_WOBBLE_SCALE
  const t = tSec + phase
  const lx = amp * (Math.sin(t * 1.3 + 0.7) * 0.6 + Math.sin(t * 2.1) * 0.4)
  const lz = amp * (Math.sin(t * 1.7) * 0.6 + Math.sin(t * 0.9 + 1.3) * 0.4)
  const heave = (HEAVE_REST + HEAVE_MOTION * m) * HOVERCRAFT_WOBBLE_SCALE * Math.sin(t * 1.1)
  return { lx, lz, heave }
}

/**
 * worldLeanToLocal rotates a world-frame lean vector into a unit's local
 * pitch/roll channels given its yaw — the same inverse-heading transform
 * the grounded slope-tilt path uses, so both "lean stays put in the
 * world" behaviours agree.  A unit at heading θ and one at θ+π see the
 * SAME world lean as mirrored (negated) local pitch/roll.
 */
export function worldLeanToLocal(lx, lz, headingRad) {
  const c = Math.cos(headingRad)
  const s = Math.sin(headingRad)
  const llx = c * lx - s * lz
  const llz = s * lx + c * lz
  return { pitch: llz, roll: -llx }
}

/**
 * hoverSway composes the two: the local pitch/roll (+heave) overlay for a
 * hovercraft at `headingRad`, leaning about fixed world axes.
 */
export function hoverSway(tSec, headingRad, { motion = 0, phase = 0 } = {}) {
  const { lx, lz, heave } = hoverSwayWorldLean(tSec, { motion, phase })
  const { pitch, roll } = worldLeanToLocal(lx, lz, headingRad)
  return { pitch, roll, heave }
}
