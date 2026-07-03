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

// MAX_PULSE_LIGHTS is the HARD ceiling on simultaneous dynamic lights: the
// shader uniform arrays in shaders/main/main.frag and shaders/ground/ground.frag
// are sized to exactly this, so it must stay in lockstep with the
// MAX_PULSE_LIGHTS define in both.  The live count is capped well below this by
// the user's "Dynamic Lights" graphics option (see setMaxSceneLights) — the
// array is sized for the worst case the slider allows.
export const MAX_PULSE_LIGHTS = 256

// DEFAULT_MAX_SCENE_LIGHTS is the at-rest live cap, matching the graphics-option
// default so a fresh session lights the scene identically whether or not the
// slider has been touched.
export const DEFAULT_MAX_SCENE_LIGHTS = 32

// _maxSceneLights is the live cap gatherSceneLights truncates to.  Driven by
// the "Dynamic Lights" slider via setMaxSceneLights; clamped to [0,
// MAX_PULSE_LIGHTS] so a value can never overflow the shader arrays.
let _maxSceneLights = DEFAULT_MAX_SCENE_LIGHTS

// setMaxSceneLights sets how many of the strongest emitters the collector keeps
// each frame.  The renderer's setMaxDynamicLights routes the graphics-option
// value here so every render path agrees on the cap.
export function setMaxSceneLights(n) {
  const v = Math.max(0, Math.min(MAX_PULSE_LIGHTS, Math.floor(n) || 0))
  _maxSceneLights = v
}

// getMaxSceneLights returns the live cap.
export function getMaxSceneLights() {
  return _maxSceneLights
}

// gatherSceneLights scans the supplied particle pools for alive light-emitting
// particles, scores each by lightStrength × luminance × alpha-fade × life-fade,
// and returns the strongest up to `max` as plain { pos, color, strength }
// objects (the shape the renderer's setPulseLights consumes).  `pools` is any
// iterable of ParticlePool-shaped objects; null entries are skipped so callers
// can pass a unit's binding pool directly without guarding.
//
// The life-fade term (remaining-life ÷ spawn-life) is what lets a slot "free
// up" as a shot ages: projectile lights are emitted no-fade (constant alpha),
// so without it every in-flight shell scores identically and the oldest ones
// latch the slots forever — a fresh shot would stay dark until an old one
// expired.  Weighting by remaining life ranks fresh, bright shots above stale
// ones, so when more shots are airborne than the cap allows the newest win.
export function gatherSceneLights(pools, max = _maxSceneLights) {
  if (!(max > 0)) return []
  const found = []
  for (const p of pools) {
    if (!p || !p.count) continue
    for (let i = 0; i < p.count; i++) {
      if (!p.alive[i]) continue
      const ls = p.lightStrength[i]
      if (!(ls > 0)) continue
      const lum = Math.max(p.r[i], p.g[i], p.b[i])
      const lifeFrac = (p.life0 && p.life0[i] > 0)
        ? Math.max(0, p.life[i] / p.life0[i])
        : 1
      const s = ls * lum * (p.a[i] / Math.max(0.001, p.a0[i])) * lifeFrac
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
