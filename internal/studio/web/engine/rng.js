// rng.js
//
// Deterministic 32-bit RNG used by the engine.  Wraps Mulberry32 — a tiny
// (8-line) splittable PRNG with passable statistical quality and zero
// dependencies.  More than enough for game state: aim jitter, target
// selection, particle spawn offsets, etc.  Not cryptographic.
//
// Why this exists: Math.random() is implementation-defined and unseeded,
// which makes the whole simulation impossible to replay.  Every Math.random
// call in the engine should route through an Rng instance so that
//   const a = new GameEngine({ seed: 42 })  // ...drive a fixed-dt tick loop
//   const b = new GameEngine({ seed: 42 })  // ...drive the same tick loop
// produces bit-identical state on the same JavaScript engine.
//
// Threading:
//   * GameEngine owns one master Rng (engine.rng).
//   * CobRuntime gets the same instance so OP_RAND becomes deterministic
//     across every script in the sim.
//   * CobBinding gets the same instance so SmokeUnit / SFX particle
//     spawn positions are also deterministic.
//   * Sub-streams: call rng.fork() to derive an independent child stream
//     deterministically from the parent.  Useful when a unit / weapon /
//     projectile needs its own draws so adding+removing a sibling unit
//     doesn't perturb every other unit's RNG sequence.

// Mulberry32 — state is a single uint32.  Pure function step + state
// mutation kept inside the class so consumers always see the {next,
// nextFloat, range, fork} surface without worrying about the bit math.
export class Rng {
  // seed: integer.  Coerced to uint32.  Same seed → same sequence.
  constructor(seed = 0) {
    // Mulberry32 produces a length-2^32 cycle from any non-zero state;
    // a zero seed degenerates into a fixed-point at zero so we offset
    // it into a known non-zero value.  Matches the common convention in
    // other Mulberry32 ports.
    let s = (seed | 0) >>> 0
    if (s === 0) s = 0x9E3779B9   // golden-ratio fractional bits
    this._state = s
  }

  // next32 — raw 32-bit step.  Returns a uint32 in [0, 2^32).  This is the
  // primitive every other helper sits on top of.
  next32() {
    let t = (this._state + 0x6D2B79F5) | 0
    this._state = t >>> 0
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0)
  }

  // nextFloat — Math.random()-compatible double in [0, 1).  Use this in
  // place of every `Math.random()` call inside the sim.
  nextFloat() {
    // 2^-32 — divides the uint32 down into the unit interval.
    return this.next32() * 2.3283064365386963e-10
  }

  // range — uniform integer in [lo, hi] inclusive, matching the TA COB
  // `rand(lo, hi)` semantics.  Caller is expected to pass integers; the
  // |0 coerces so a stray float doesn't shift the sampling distribution.
  range(lo, hi) {
    const l = lo | 0, h = hi | 0
    const a = Math.min(l, h), b = Math.max(l, h)
    return a + Math.floor(this.nextFloat() * (b - a + 1))
  }

  // fork — derive a new independent Rng from this one's NEXT draw.  The
  // child's seed is one step of the parent, so a parent-then-fork sequence
  // is reproducible without sharing the parent's state with the child.
  // Use this to give per-unit / per-weapon substreams: the master engine
  // RNG forks once per addUnit() and the unit keeps its own Rng, so adding
  // unit N doesn't change the random sequence unit N-1 sees.
  fork() {
    return new Rng(this.next32())
  }

  // snapshot/restore — useful for replay tools that want to checkpoint the
  // exact RNG state at a known tick.  Trivially small (a single uint32)
  // so the cost is negligible per snapshot.
  snapshot() { return this._state >>> 0 }
  restore(s) { this._state = (s | 0) >>> 0 }
}

// makeRng — convenience for the common case where the caller wants the
// "default" engine RNG.  When no seed is provided, the engine is
// non-deterministic by design (replicates the historic Math.random
// behaviour by drawing a fresh seed from Math.random itself); pass an
// explicit integer seed when determinism matters.
export function makeRng(seed) {
  if (seed == null) {
    // 32-bit-wide draw from the global RNG.  This is the ONLY place the
    // engine falls back to Math.random — everywhere else routes through
    // an Rng instance so the user can pin the whole sim by passing
    // `new GameEngine({ seed })`.
    return new Rng((Math.random() * 0x100000000) >>> 0)
  }
  return new Rng(seed)
}
