// terrain-los.js — line-of-sight raycast of a shot path against the terrain.
//
// A weapon visual draws a beam/tracer/projectile from the muzzle to the
// target the wire reported.  But the wire's "shot" is fire intent, not a
// guaranteed hit: if a ridge sits between shooter and target the real engine
// blocks the round, the target takes no damage, and the bolt should splash on
// the hillside — NOT reach across the ridge and flash on the unit.
//
// raycastTerrain walks the segment from `from` to `to` and returns the first
// point where the straight-line path passes BELOW the terrain surface
// (heightAt(x,z)).  That point is where the shot buries into the slope; the
// caller terminates the beam there with a dirt impact instead of a target hit.
//
// The march is a fixed world-unit step (STEP_WU) with a binary refinement at
// the crossing so a coarse step still lands the impact on the slope face
// rather than STEP_WU past it.  Endpoints are treated tolerantly: the muzzle
// and the target sit AT their own surfaces (a unit's barrel, the target's
// hull), so a tiny start/end skin is ignored — only a genuine intervening
// rise blocks the shot, not the grazing contact at either end.
//
// Pure + deterministic (no rng, no GL): heightAt is any (x,z)→y sampler
// (createTerrainSampler.heightAt or the renderer's terrainHeightAt), so the
// whole thing runs headless under Node for tests.

// World-unit spacing of the coarse march.  A TA cell is 16wu; sampling every
// few units catches any ridge a shot could hide behind without walking the
// whole span vertex-by-vertex.
export const LOS_STEP_WU = 4

// Refinement iterations once a coarse step straddles the surface — halves the
// bracket each pass, so 6 gets the impact within STEP_WU/64 (< 0.1wu).
const LOS_REFINE_ITERS = 6

// Skin (world units) at each endpoint where a below-surface sample does NOT
// count as a block: the muzzle and the aim point legitimately sit on/at their
// own surfaces.  Only relief BETWEEN the ends occludes.
export const LOS_END_SKIN_WU = 6

// raycastTerrain marches `from`→`to` (each [x,y,z], world frame) and returns
// the terrain-blocked impact, or null when the path is clear.
//
//   heightAt(x, z) → terrain surface Y (world units)
//
// Options:
//   stepWU   — coarse march spacing (default LOS_STEP_WU)
//   endSkin  — endpoint tolerance (default LOS_END_SKIN_WU)
//
// Returns null (clear line of fire) or:
//   { point:[x,y,z],   // where the ray first dips below the surface
//     t,               // fraction along from→to (0..1) of that point
//     dist }           // world distance from `from` to the impact
// so the caller can decide the terminated shot is closer than the target.
export function raycastTerrain(from, to, heightAt, { stepWU = LOS_STEP_WU, endSkin = LOS_END_SKIN_WU } = {}) {
  if (!Array.isArray(from) || !Array.isArray(to) || typeof heightAt !== 'function') return null
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const dz = to[2] - from[2]
  const total = Math.hypot(dx, dy, dz)
  if (!(total > 0)) return null

  // Height of the ray above the surface at fraction t (positive = clearance).
  const clearance = (t) => {
    const x = from[0] + dx * t
    const y = from[1] + dy * t
    const z = from[2] + dz * t
    return y - heightAt(x, z)
  }

  // Skip the endpoint skins: a shot grazes its own muzzle/target surface.
  const skinT = total > 0 ? Math.min(0.49, endSkin / total) : 0
  const t0 = skinT
  const t1 = 1 - skinT
  if (t1 <= t0) return null

  const steps = Math.max(1, Math.ceil((total * (t1 - t0)) / stepWU))
  let prevT = t0
  let prevC = clearance(t0)
  // A ray that already starts underground (start skin cleared it, but the very
  // next sample is buried) still blocks — the loop below catches it on the
  // first interval.
  for (let i = 1; i <= steps; i++) {
    const t = t0 + (t1 - t0) * (i / steps)
    const c = clearance(t)
    if (c <= 0 && prevC > 0) {
      // The segment [prevT, t] straddles the surface — refine to the crossing.
      let lo = prevT, hi = t
      for (let k = 0; k < LOS_REFINE_ITERS; k++) {
        const mid = (lo + hi) * 0.5
        if (clearance(mid) > 0) lo = mid
        else hi = mid
      }
      const tt = hi
      return {
        point: [from[0] + dx * tt, from[1] + dy * tt, from[2] + dz * tt],
        t: tt,
        dist: total * tt,
      }
    }
    // A path buried from the outset (prevC ≤ 0 at the first post-skin sample):
    // block right at the entry so a shot fired straight into a wall splashes.
    if (c <= 0 && prevC <= 0 && i === 1) {
      return {
        point: [from[0] + dx * prevT, from[1] + dy * prevT, from[2] + dz * prevT],
        t: prevT,
        dist: total * prevT,
      }
    }
    prevT = t
    prevC = c
  }
  return null
}
