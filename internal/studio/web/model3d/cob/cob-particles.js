// cob-particles.js
//
// Tiny CPU-side particle system used by the COB runtime to render
// SFX (smoke trails, damage sparks, muzzle flashes).  Designed
// renderer-agnostic so a future game-clone can plug it in by giving
// the renderer-side draw code a list of (worldPos, color, size,
// alpha) quads to splat each frame.  The studio's draw uses an
// additive-blended GL_POINTS pass that's cheap enough to mix into
// the existing pipeline without a new program (sprite shader would
// look prettier but doubles the GL setup cost).
//
// Each particle is a fixed-size record kept in a free-list pool so
// the emitter doesn't allocate during the hot per-frame path.  Pool
// growth happens once on first overflow; the pool then plateaus.

// Particle kinds.  These map to the bos `emit-sfx` opcode's sfxType
// stack value - we don't honour every retail TA effect, just the
// handful units actually emit in the viewer.  Add more as the
// runtime exposes them (jetwash, water-spray, exhaust smoke, etc.).
export const SFX_SMOKE_GREY     = 1   // generic black/grey smoke (damage trails)
export const SFX_SMOKE_WHITE    = 2   // light smoke (steam, dust)
export const SFX_SPARK          = 3   // bright damage spark
export const SFX_FIRE_FLASH     = 4   // brief orange muzzle flash
export const SFX_NANO_PARTICLES = 16  // construction nano lathe stream
export const SFX_WAKE           = 257 // ship wake (handled by the renderer's water shader; pool tag for future)

// Default per-kind appearance.  The runtime can override any of
// these via the emit() call, but most COB calls just pass the kind
// id and let the defaults speak.  Sizes are tuned to read as
// volumetric puffs on a TA-scale unit (~50 wu): smoke needs to be
// large enough to silhouette against the sky.  Damage smoke is the
// most-emitted kind so it gets the highest visibility budget.
const KIND_DEFAULTS = {
  // SMOKE_GREY (damage trail): big, dark, long-lived.  Brighter
  // than physically grey to read against bright TA terrain; pure
  // RGB grey at 0.36 disappeared into the green-grass backdrop.
  // Size + life nudged up because SmokeUnit's bos polls at HEALTH ×
  // 50ms intervals — at HEALTH=20 (80% damage) that's a puff per
  // second, so each puff has to linger long enough that the trail
  // reads as a continuous plume instead of a strobe.
  [SFX_SMOKE_GREY]:     { color: [0.45, 0.45, 0.48, 0.96], size: 14.0, lifeMs: 4200, riseSpeed: 3.6, drift: 1.6 },
  // SMOKE_WHITE (exhaust / dust): bright, slightly translucent,
  // medium life so it visibly drifts off the unit instead of
  // popping out instantly.
  [SFX_SMOKE_WHITE]:    { color: [0.92, 0.92, 0.96, 0.90], size: 11.0, lifeMs: 3000, riseSpeed: 2.4, drift: 1.2 },
  [SFX_SPARK]:          { color: [1.50, 0.75, 0.25, 1.00], size: 3.0,  lifeMs: 450,  riseSpeed: -2.5, drift: 1.6 },
  // FIRE_FLASH (muzzle flash): big, very bright — single bright
  // flare at the barrel tip on each fire tick.  Life nudged up
  // from a frame-blink to ~half-second so consecutive shots stack
  // into a visible overlap and the user actually sees the flash
  // (the in-script `show flare`/`hide flare` toggle is only 100-
  // 150ms and similarly easy to miss).
  [SFX_FIRE_FLASH]:     { color: [1.80, 1.25, 0.55, 1.00], size: 14.0, lifeMs: 500,  riseSpeed: 0.0, drift: 0.0 },
  [SFX_NANO_PARTICLES]: { color: [0.45, 0.95, 1.20, 0.85], size: 2.0,  lifeMs: 600,  riseSpeed: 0.8, drift: 2.4 },
}

export class ParticlePool {
  constructor(capacity = 512) {
    this.capacity = capacity
    // Flat float arrays so the GL upload can be a single
    // glBufferSubData per frame instead of a per-particle loop.
    this.x   = new Float32Array(capacity)
    this.y   = new Float32Array(capacity)
    this.z   = new Float32Array(capacity)
    this.vx  = new Float32Array(capacity)
    this.vy  = new Float32Array(capacity)
    this.vz  = new Float32Array(capacity)
    this.r   = new Float32Array(capacity)
    this.g   = new Float32Array(capacity)
    this.b   = new Float32Array(capacity)
    this.a   = new Float32Array(capacity)   // current alpha (decays with age)
    this.a0  = new Float32Array(capacity)   // spawn alpha (so the fade is proportional)
    this.size = new Float32Array(capacity)
    this.life = new Float32Array(capacity)  // remaining life in ms
    this.life0 = new Float32Array(capacity) // spawn life (denominator for fade)
    this.alive = new Uint8Array(capacity)
    this.count = 0
  }

  // emit spawns one particle.  worldPos is `[x, y, z]`.  kind picks
  // the colour/size/life defaults; opts can override any of those
  // (e.g. tinting the smoke with a per-team colour, or extending
  // the muzzle flash for cinematic shots).
  emit(kind, worldPos, opts = {}) {
    const d = KIND_DEFAULTS[kind] || KIND_DEFAULTS[SFX_SMOKE_GREY]
    const slot = this._allocSlot()
    if (slot < 0) return
    const color = opts.color || d.color
    const size  = opts.size  ?? d.size
    const life  = opts.lifeMs ?? d.lifeMs
    const rise  = opts.riseSpeed ?? d.riseSpeed
    const drift = opts.drift ?? d.drift
    this.x[slot] = worldPos[0]
    this.y[slot] = worldPos[1]
    this.z[slot] = worldPos[2]
    // Drift is random horizontal velocity so a single emit point
    // doesn't produce a vertical line.  Rise is the deterministic
    // vertical component (positive = floats up like smoke, negative
    // = falls like a spark).
    const ang = Math.random() * Math.PI * 2
    this.vx[slot] = Math.cos(ang) * drift
    this.vy[slot] = rise
    this.vz[slot] = Math.sin(ang) * drift
    this.r[slot] = color[0]
    this.g[slot] = color[1]
    this.b[slot] = color[2]
    this.a[slot] = color[3] ?? 1
    this.a0[slot] = this.a[slot]
    this.size[slot] = size
    this.life[slot] = life
    this.life0[slot] = life
    this.alive[slot] = 1
  }

  // tick advances all particles by `dtMs`.  Removes any whose life
  // hit zero by compact-swap to keep the alive prefix contiguous,
  // which makes the upload path one glBufferSubData over [0..count].
  tick(dtMs) {
    const dt = dtMs * 0.001
    for (let i = 0; i < this.count; i++) {
      if (!this.alive[i]) continue
      this.life[i] -= dtMs
      if (this.life[i] <= 0) { this.alive[i] = 0; continue }
      this.x[i] += this.vx[i] * dt
      this.y[i] += this.vy[i] * dt
      this.z[i] += this.vz[i] * dt
      // Linear fade based on remaining life.  Visually a bit harsh
      // but cheap; could swap to ease-out (square the ratio) if it
      // ever reads as too abrupt.
      this.a[i] = this.a0[i] * (this.life[i] / this.life0[i])
    }
    // Compact the dead slots out of the alive prefix so render
    // doesn't waste a draw on them.
    let w = 0
    for (let i = 0; i < this.count; i++) {
      if (!this.alive[i]) continue
      if (w !== i) this._copy(i, w)
      w++
    }
    this.count = w
  }

  _allocSlot() {
    if (this.count >= this.capacity) {
      // Grow once - particle counts plateau quickly.  Doubling
      // matches the standard amortised-O(1) growth pattern.
      const nc = this.capacity * 2
      for (const name of ['x','y','z','vx','vy','vz','r','g','b','a','a0','size','life','life0']) {
        const next = new Float32Array(nc)
        next.set(this[name])
        this[name] = next
      }
      const aliveNext = new Uint8Array(nc)
      aliveNext.set(this.alive)
      this.alive = aliveNext
      this.capacity = nc
    }
    const slot = this.count
    this.count++
    return slot
  }

  _copy(from, to) {
    this.x[to] = this.x[from]; this.y[to] = this.y[from]; this.z[to] = this.z[from]
    this.vx[to] = this.vx[from]; this.vy[to] = this.vy[from]; this.vz[to] = this.vz[from]
    this.r[to] = this.r[from]; this.g[to] = this.g[from]; this.b[to] = this.b[from]
    this.a[to] = this.a[from]; this.a0[to] = this.a0[from]
    this.size[to] = this.size[from]
    this.life[to] = this.life[from]; this.life0[to] = this.life0[from]
    this.alive[to] = 1
  }
}
