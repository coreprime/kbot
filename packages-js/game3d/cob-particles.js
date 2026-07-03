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
export const SFX_PROJECTILE_BULLET = 200
export const SFX_PROJECTILE_SHELL  = 201
export const SFX_PROJECTILE_PLASMA = 202
export const SFX_PROJECTILE_DGUN   = 203 // Commander disintegrator — iconic bright-green energy ball.
// Laser pulse segment — drawn as a chain of these along the firing
// line by the weapon code to fake an instant beam.  Short life, tiny
// size, very bright; caller supplies the tint via opts.color so beam
// colour follows the TDF `color`/`rgbcolor` palette index.
export const SFX_PROJECTILE_LASER  = 204
// Missile body — small bright dot with a longer life than a bullet
// so the smoke trail spawned alongside it has time to deposit.  Used
// for ANY TDF that sets `smoketrail=1` (rockets, AAS, plasma cannons
// with smoke).
export const SFX_PROJECTILE_MISSILE = 205
// Animated bitmap projectile — rendered as a billboarded textured quad
// whose frames cycle from an fx.gaf sprite sheet (one strip per stock
// `rendertype=4` weapon variant).  Carries a `spriteId` opt that the
// renderer looks up in its sprite registry to find the atlas texture +
// frame metadata.  See game3d/weapon-bitmap-loader.js + the bitmap
// shader path.  Falls back to a coloured point sprite when the sprite
// hasn't loaded yet (spriteId==0).
export const SFX_PROJECTILE_SPRITE = 206
// Sub-bubbles — small light-blue spheres released by submerged units.
// Maps from the COB `emit-sfx 259` opcode (TA_SFXTYPE_SUBBUBBLES,
// SFXTYPE_POINTBASED | 3).  Rises slowly through the water column
// then pops at the surface.  See smokeunit.h for the source enum; the
// emit-sfx events are routed to this pool by the snapshot consumer.
export const SFX_SUB_BUBBLES    = 260
export const SFX_NANO_PARTICLES = 16  // construction nano lathe stream
// SFX_WAKE was 257, which collided with TA's SFXTYPE_WHITESMOKE
// (POINTBASED | 1) — a COB script that emits whitesmoke would have
// matched our wake handling if anything ever cross-keyed the two.
// Moved to 270 (out of the POINTBASED 256-263 band) to remove the
// foot-gun.  Still pool-tag-only until the wake path needs it.
export const SFX_WAKE           = 270
// Weapon projectiles — bright travelling pellets that fly from the
// firing piece toward the target.  Bullet = small bright tracer
// (kbot machine-guns), Shell = bigger orange ball (cannons + heavy
// weapons), Plasma = cyan (laser/EMG variants).  All three live as
// regular pool particles but the caller passes an explicit velocity
// + (optional) gravity via emit() opts, and an `noFade` flag so the
// projectile stays full-bright until it expires.

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
  // Alpha + life halved again from the previous pass (was 0.50 α /
  // 2800 ms / 2000 ms) — even at 50% opacity the trails were stacking
  // into opaque clouds whenever a battalion fired or moved together,
  // blocking the scene.  α=0.25 + ~half life lets the puffs disperse
  // before the next batch lands.  Per-weapon AoE-scaling + per-unit
  // damage-state alpha modulation are documented as Tier-1/Tier-2
  // upgrades in the in-tree "Dynamic smoke" notes — those would let
  // these defaults relax (heavy weapons + dying units could push
  // alpha back up) without re-introducing the everyone-leaks-fog
  // problem the static values had.
  [SFX_SMOKE_GREY]:     { color: [0.45, 0.45, 0.48, 0.25], size: 14.0, lifeMs: 1400, riseSpeed: 3.6, drift: 1.6 },
  // SMOKE_WHITE (exhaust / dust): bright, slightly translucent,
  // medium life so it visibly drifts off the unit instead of
  // popping out instantly.  Same tuning rationale as SMOKE_GREY —
  // alpha + life halved so muzzle puffs and aircraft jetwash from a
  // mass of units don't blanket the silhouette of whatever they're
  // shooting at.
  [SFX_SMOKE_WHITE]:    { color: [0.92, 0.92, 0.96, 0.25], size: 11.0, lifeMs: 1000, riseSpeed: 2.4, drift: 1.2 },
  // Sparks fade fast in TA (~200ms).  Earlier 450ms left a halo of
  // sparks lingering well after the impact concluded.
  [SFX_SPARK]:          { color: [1.50, 0.75, 0.25, 1.00], size: 3.0,  lifeMs: 220,  riseSpeed: -2.5, drift: 1.6 },
  // FIRE_FLASH (muzzle flash): big, very bright — single bright
  // flare at the barrel tip on each fire tick.  Life nudged up
  // from a frame-blink to ~half-second so consecutive shots stack
  // into a visible overlap and the user actually sees the flash
  // (the in-script `show flare`/`hide flare` toggle is only 100-
  // 150ms and similarly easy to miss).
  // Earlier 500ms gave each muzzle flash a static "lantern hanging
  // at the barrel" feel.  150ms reads as a brief muzzle pop, then
  // gone — matching the in-game flicker.
  [SFX_FIRE_FLASH]:     { color: [1.80, 1.25, 0.55, 1.00], size: 14.0, lifeMs: 150,  riseSpeed: 0.0, drift: 0.0 },
  [SFX_NANO_PARTICLES]: { color: [0.45, 0.95, 1.20, 0.85], size: 2.0,  lifeMs: 600,  riseSpeed: 0.8, drift: 2.4 },
  // Projectiles — the caller supplies velocity explicitly via
  // opts.velocity so rise/drift here are placeholder zeros.  Size +
  // colour tuned so the bullet/shell/plasma reads as a distinct
  // weapon visual at TA's scene scale.
  [SFX_PROJECTILE_BULLET]: { color: [1.80, 1.50, 0.40, 1.00], size: 2.5, lifeMs: 4000, riseSpeed: 0.0, drift: 0.0 },
  [SFX_PROJECTILE_SHELL]:  { color: [1.90, 1.10, 0.40, 1.00], size: 5.0, lifeMs: 6000, riseSpeed: 0.0, drift: 0.0 },
  [SFX_PROJECTILE_PLASMA]: { color: [0.50, 1.80, 2.00, 1.00], size: 3.5, lifeMs: 4000, riseSpeed: 0.0, drift: 0.0, lightStrength: 0.0 },
  // D-Gun (commander disintegrator) — the iconic TA "green ball of
  // death".  Big bright additive-green sprite that's unmistakable
  // against any terrain.  ARM_DISINTEGRATOR's weaponvelocity is 200
  // (half the laser's 400), so the visible travel is also slow, which
  // matches the in-game "you can see it coming" feel.  Size pumped
  // up so it's clearly a giant energy orb, not a stray pixel.
  // D-Gun (commander disintegrator) — TA's signature commander
  // weapon.  Rendered as a giant violent ball of energy: bright
  // red-orange core with a hint of yellow.  Massive size (32 wu) so
  // it visibly threatens whatever it's pointed at, regardless of
  // camera distance.  The renderer separately treats this particle
  // kind as a point-light source (see emit() — `lightStrength` opt
  // is auto-set when this kind is spawned), pulsing the scene with
  // a matching red flash so the d-gun visibly illuminates nearby
  // surfaces.
  // lightStrength is the WORLD radius this particle illuminates at
  // intensity 1.0; the renderer scales fragment contribution by
  // 1/(1+(d/r)²).  D-gun gets a massive 300-wu reach so it visibly
  // floods the scene with red while in flight — matches the user's
  // "violently strong light source" expectation.
  [SFX_PROJECTILE_DGUN]:   { color: [2.00, 0.55, 0.20, 1.00], size: 32.0, lifeMs: 6000, riseSpeed: 0.0, drift: 0.0, lightStrength: 300.0 },
  // Laser pulse segment — fat bright spot.  Default colour is the
  // ARM-laser green (palette idx 232).  Beams are drawn by emitting
  // a dense chain of these along the line in one call (see
  // _spawnLaserBeam) so the entire path reads as one continuous
  // unmissable streak.  Earlier passes used size 14 / 500 ms and
  // users reported the beam still wasn't visible — the previous
  // tweak missed because the additive-pre-multiplied alpha is
  // tone-mapped before display; the only way to make a beam pop is
  // to make the per-pulse blob big enough to physically overlap
  // multiple pixels and bright enough that the tone-map doesn't
  // crush it.  Size 28 wu (about half a kbot torso) + alpha 1.0
  // + 1100 ms life make the beam a clear LINE rather than a sparse
  // string of dots.  lightStrength matches D-gun's range so the
  // beam visibly washes nearby surfaces with its tint.
  // Pulse life was 1100ms which lingered as a static glow long after
  // the shot itself.  TA's actual beams flash for ~150-250ms total.
  // 220ms reads as a quick flash without disappearing mid-frame.
  // lightStrength reduced from 280 — the point-light glow on
  // surrounding surfaces was so intense it visually overpowered the
  // beam line itself.  90 gives a noticeable but subtle wash that
  // tints the unit's lit side without making the silhouette the
  // dominant visual element of a shot.
  // Laser pulse size + reach reduced significantly from the earlier
  // 28-wu / 90-light tuning — the beam was visually dominating the
  // scene out of proportion to its damage.  12 wu reads as a clear
  // beam line without obscuring the unit firing it; lightStrength 45
  // still washes nearby surfaces with the beam tint but no longer
  // overwhelms the laser's own silhouette.  150 ms life keeps the
  // flash snappy (TA beams are visible for ~1-2 frames in the
  // original engine).
  [SFX_PROJECTILE_LASER]:   { color: [0.55, 2.80, 0.70, 1.00], size: 12.0, lifeMs: 150,  riseSpeed: 0.0, drift: 0.0, lightStrength: 45.0 },
  // Missile body — small orange-yellow flame.  Pairs with a per-tick
  // smoke trail spawned by the controller code so the projectile
  // visibly drags a white wake behind it.  Life is sized in opts to
  // cover the actual flight time.
  [SFX_PROJECTILE_MISSILE]: { color: [1.90, 1.40, 0.40, 1.00], size: 4.0, lifeMs: 3000, riseSpeed: 0.0, drift: 0.0 },
  // Animated bitmap projectile — visual hue is the texture itself; the
  // colour tint here is white (multiplied with the sampled texel) so the
  // sprite's painted yellow / blue / red shows through unmodified.  Size
  // is a sane default; the spawner overrides per-shot based on the
  // weapon's AoE / sprite scale.  noFade is the typical projectile
  // behaviour so the bolt reads as a solid object until impact.
  [SFX_PROJECTILE_SPRITE]: { color: [1.00, 1.00, 1.00, 1.00], size: 8.0, lifeMs: 4000, riseSpeed: 0.0, drift: 0.0 },
  // SUB_BUBBLES — pale blue, half-transparent, lazily rises.  Cavedog's
  // sub units (ARMSUB / CORSUB / etc.) emit these via
  // `emit-sfx SFXTYPE_SUBBUBBLES from <piece>` in their BOS.  Should
  // read as "this thing is underwater" without dominating the scene;
  // alpha kept low + life short for the same reason smoke is kept thin.
  [SFX_SUB_BUBBLES]:    { color: [0.55, 0.80, 1.00, 0.45], size: 3.5,  lifeMs: 1800, riseSpeed: 4.5, drift: 0.6 },
}

export class ParticlePool {
  constructor(capacity = 512, opts = {}) {
    this.capacity = capacity
    // Optional RNG injected by the binding so the fallback drift angle
    // (when emit() is called without an explicit velocity) draws from the
    // deterministic stream.  Falls back to Math.random when no RNG is
    // provided so standalone pools — particle previews, tests — still work.
    this.rng = opts.rng || null
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
    // Gravity per particle — applied to vy each tick.  Zero for the
    // standard SFX kinds (smoke / sparks float freely); positive for
    // ballistic projectiles so shells arc visibly.
    this.gravity = new Float32Array(capacity)
    // noFade flag — 0 = particle alpha fades linearly to zero over
    // its life (standard SFX behaviour), 1 = stays at spawn alpha
    // until life expires (projectiles want a crisp visible bullet
    // that disappears at impact, not a faint tracer that dims out).
    this.noFade = new Uint8Array(capacity)
    // lightStrength — non-zero means this particle is a dynamic
    // point light source.  Stored as the WORLD-unit radius at which
    // its illumination falls to ~half; the renderer scales the
    // contribution by 1/(1+(dist/lightStrength)²).  Zero (default)
    // skips the light path entirely.
    this.lightStrength = new Float32Array(capacity)
    // Per-particle kind tag.  Set on emit() so the pool's onExpire
    // hook (used for impact explosions, missile chain-burst, etc.)
    // knows what KIND of particle is expiring at its last position.
    // Uint16 covers our SFX_* range easily.
    this.kind = new Uint16Array(capacity)
    // Animated-sprite particle metadata.  spriteId is a numeric handle
    // into the renderer's sprite registry (see weapon-bitmap-loader.js);
    // 0 means "no sprite" (the particle renders as a coloured point
    // sprite via the existing path).  age tracks tick-driven elapsed
    // milliseconds since spawn so the renderer can compute the current
    // animation frame deterministically — Step at any sim speed advances
    // the visible frame by exactly its tick share, not by wall-clock.
    this.spriteId = new Uint16Array(capacity)
    this.age      = new Float32Array(capacity)
    this.alive = new Uint8Array(capacity)
    this.count = 0
    // onExpire(slot) — optional callback invoked when a particle's
    // life hits zero, BEFORE the slot is freed.  Used by the binding
    // to emit impact-clusters at the dying projectile's position.
    // The callback reads pool.x/y/z/kind at `slot` to know where to
    // burst and what to detonate as.
    this.onExpire = null
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
    // velocity:  explicit `opts.velocity = [vx, vy, vz]` wins —
    // used by the projectile emitter to point the bullet/shell
    // along the firing direction.  Without it, fall back to the
    // legacy "random horizontal drift + vertical rise" used by
    // smoke/spark SFX so a single emit point doesn't produce a
    // vertical line.
    if (opts.velocity) {
      this.vx[slot] = opts.velocity[0]
      this.vy[slot] = opts.velocity[1]
      this.vz[slot] = opts.velocity[2]
    } else {
      const rand = this.rng ? this.rng.nextFloat() : Math.random()
      const ang = rand * Math.PI * 2
      this.vx[slot] = Math.cos(ang) * drift
      this.vy[slot] = rise
      this.vz[slot] = Math.sin(ang) * drift
    }
    this.r[slot] = color[0]
    this.g[slot] = color[1]
    this.b[slot] = color[2]
    this.a[slot] = color[3] ?? 1
    this.a0[slot] = this.a[slot]
    this.size[slot] = size
    this.life[slot] = life
    this.life0[slot] = life
    // gravity:  applied to vy each tick; default 0.  Ballistic
    // projectiles pass the active world gravity here so shells arc.
    this.gravity[slot] = +opts.gravity || 0
    // noFade:  projectiles want full alpha until impact; smoke etc.
    // want the linear fade-to-zero so the puff dissipates.
    this.noFade[slot] = opts.noFade ? 1 : 0
    // lightStrength: explicit opts.lightStrength wins (used by the
    // controller to override the kind default for special weapons);
    // otherwise the kind's default (0 = not a light).
    this.lightStrength[slot] = +(opts.lightStrength ?? d.lightStrength ?? 0)
    // Per-particle kind so onExpire can dispatch the right impact
    // burst (small bullet hit vs. d-gun blast vs. missile detonation).
    this.kind[slot] = kind | 0
    // Sprite handle + zero-age start.  Defaults to 0 (no sprite) so
    // the existing point-sprite render path stays unchanged for every
    // non-bitmap particle.
    this.spriteId[slot] = (opts.spriteId | 0) || 0
    this.age[slot] = 0
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
      if (this.life[i] <= 0) {
        // Fire the onExpire hook BEFORE marking dead so the callback
        // can read this slot's final position/kind to detonate an
        // impact burst (sparks/smoke/fireball cluster at the point
        // the projectile expired).  The hook may emit new particles;
        // _allocSlot grows the pool if needed, so re-entry is safe.
        if (this.onExpire) this.onExpire(i, this)
        this.alive[i] = 0
        continue
      }
      // Tick-driven age advance.  Animated sprites compute frame index
      // from age + sprite metadata; using sim-scaled dtMs (the same
      // signal that drives motion + life) keeps Step deterministic.
      this.age[i] += dtMs
      this.x[i] += this.vx[i] * dt
      this.y[i] += this.vy[i] * dt
      this.z[i] += this.vz[i] * dt
      // Gravity acceleration on Y velocity — zero for normal SFX, a
      // positive value for ballistic projectiles so cannon shells
      // arc down toward the ground.  Subtracted because positive Y
      // is up in world space.
      if (this.gravity[i]) this.vy[i] -= this.gravity[i] * dt
      // Linear fade based on remaining life.  Visually a bit harsh
      // but cheap; could swap to ease-out (square the ratio) if it
      // ever reads as too abrupt.  noFade particles (projectiles)
      // stay at spawn alpha so a tracer reads as a crisp dot until
      // its life ends, not a fading streak.
      if (!this.noFade[i]) {
        this.a[i] = this.a0[i] * (this.life[i] / this.life0[i])
      }
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
      for (const name of ['x','y','z','vx','vy','vz','r','g','b','a','a0','size','life','life0','gravity','lightStrength','age']) {
        const next = new Float32Array(nc)
        next.set(this[name])
        this[name] = next
      }
      for (const name of ['alive','noFade']) {
        const next = new Uint8Array(nc)
        next.set(this[name])
        this[name] = next
      }
      // `kind` + `spriteId` are Uint16 so they live separately from the
      // Uint8 / Float32 groups.
      for (const name of ['kind','spriteId']) {
        const next = new Uint16Array(nc)
        next.set(this[name])
        this[name] = next
      }
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
    this.gravity[to] = this.gravity[from]
    this.noFade[to] = this.noFade[from]
    this.lightStrength[to] = this.lightStrength[from]
    this.kind[to] = this.kind[from]
    this.spriteId[to] = this.spriteId[from]
    this.age[to] = this.age[from]
    this.alive[to] = 1
  }
}
