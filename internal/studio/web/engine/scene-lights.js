// scene-lights.js
//
// Shared dynamic-light collector used by every render path that feeds the
// renderer's pulse-light slots: the wasm sandbox scene, the legacy multi-unit
// GameEngine, and a single COB binding in the unit viewer.  Each scans its
// particle pools for live light-emitting particles (muzzle flashes, tracer
// shells, the d-gun ball) and the renderer washes that colour onto nearby
// surfaces.
//
// One collector keeps all three paths agreeing on which shots light the scene.
// It also returns the strongest SEVERAL emitters rather than a single winner:
// with no-fade tracer particles every concurrent shot scores equally, so a
// single-winner scan latched onto the oldest shell and later shots produced no
// light at all.  Returning the top N lets several shots glow at once, matching
// what a rapid-firing battleship looks like in the original game.

// MAX_PULSE_LIGHTS bounds how many dynamic lights the renderer carries at
// once.  It must stay in lockstep with the MAX_PULSE_LIGHTS define in
// shaders/main/main.frag and shaders/ground/ground.frag — the uniform arrays
// there are sized to it.
export const MAX_PULSE_LIGHTS = 4

// gatherSceneLights scans the supplied particle pools for alive light-emitting
// particles, scores each by lightStrength × luminance × alpha-fade, and returns
// the strongest up to `max` as plain { pos, color, strength } objects (the
// shape the renderer's setPulseLights consumes).  `pools` is any iterable of
// ParticlePool-shaped objects; null entries are skipped so callers can pass a
// unit's binding pool directly without guarding.
export function gatherSceneLights(pools, max = MAX_PULSE_LIGHTS) {
  const found = []
  for (const p of pools) {
    if (!p || !p.count) continue
    for (let i = 0; i < p.count; i++) {
      if (!p.alive[i]) continue
      const ls = p.lightStrength[i]
      if (!(ls > 0)) continue
      const lum = Math.max(p.r[i], p.g[i], p.b[i])
      const s = ls * lum * (p.a[i] / Math.max(0.001, p.a0[i]))
      if (!(s > 0)) continue
      found.push({
        s,
        pos: [p.x[i], p.y[i], p.z[i]],
        color: [p.r[i], p.g[i], p.b[i]],
        strength: ls,
      })
    }
  }
  if (found.length === 0) return []
  found.sort((a, b) => b.s - a.s)
  if (found.length > max) found.length = max
  return found.map((f) => ({ pos: f.pos, color: f.color, strength: f.strength }))
}
