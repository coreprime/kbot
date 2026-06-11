// weapon-driver.js
//
// Shared weapon-firing primitives used by single-entity and
// multi-entity host views.  A weapon "shot" needs the same things in
// both modes: a particle of the right visual kind, optional smoke
// trail, an instant-hit laser beam (for beamweapons), and the weapon's
// start sound.  Each path also needs a binding so the particle / audio
// pools live with the firing unit, plus the FBI weapon metadata
// (range / velocity / ballistic / etc.) and a palette so laser beams
// render in TA-accurate colours.
//
// The functions here are pure helpers — they don't keep any state.
// Each call decides the visual kind from the weapon metadata + the
// weapon's name (carried over from the original heuristic-based
// implementation), then routes the emit through the binding's pool.

import {
  SFX_PROJECTILE_BULLET,
  SFX_PROJECTILE_SHELL,
  SFX_PROJECTILE_PLASMA,
  SFX_PROJECTILE_DGUN,
  SFX_PROJECTILE_LASER,
  SFX_PROJECTILE_MISSILE,
  SFX_PROJECTILE_SPRITE,
  SFX_FIRE_FLASH,
  SFX_SMOKE_WHITE,
} from '/engine/cob-particles.js'
import {
  WEAPON_RENDERTYPE_LASER,
  WEAPON_RENDERTYPE_PROJECTILE,
  WEAPON_RENDERTYPE_MINDGUN,
  WEAPON_RENDERTYPE_DGUN,
  WEAPON_RENDERTYPE_BITMAP,
  WEAPON_RENDERTYPE_FLAME,
  WEAPON_RENDERTYPE_BOMB,
  WEAPON_RENDERTYPE_LIGHTNING,
  hasRenderType,
} from '/engine/weapon-rendertype.js'
import { loadWeaponBitmap } from '/engine/weapon-bitmap-loader.js'

// Per-kind brightness multipliers applied on top of the palette-derived
// hue so each projectile family keeps its visual identity even when the
// raw colour is the same.  Beams need to glow hot to read at distance,
// d-gun reads as a violent overcharge, missile bodies are dim sparks.
// Values are linear; >1 pushes into the bloom threshold so the FX chain
// can lift them above HDR clamp.
const PROJECTILE_BRIGHTNESS = {
  // Laser multiplier reduced from 1.8 → 1.3 so the beam still reads as
  // saturated against terrain without blowing past the HDR clamp on
  // the post-FX bloom (1.8 was tone-mapping into a fat solid streak).
  [SFX_PROJECTILE_LASER]:   1.3,
  [SFX_PROJECTILE_DGUN]:    1.6,   // bright energy ball
  [SFX_PROJECTILE_PLASMA]:  1.5,
  [SFX_PROJECTILE_SHELL]:   1.1,
  [SFX_PROJECTILE_MISSILE]: 1.1,
  [SFX_PROJECTILE_BULLET]:  1.0,
  // Sprite kind multiplies the SAMPLED TEXEL by the tint — we want the
  // GAF-baked colours to come through verbatim (the bitmap projectile
  // sprites are pre-shaded by the original artists), so the per-kind
  // tint is white and the brightness multiplier is 1.0.
  [SFX_PROJECTILE_SPRITE]:  1.0,
}

// Per-kind fallback hues used when the weapon's TDF doesn't ship a
// colour index (most non-laser weapons omit `color=`).  The hues are game
// configuration — the active game's adapter supplies them keyed by kind
// name via setProjectileFallbackColors() at boot; unset kinds fall back
// to white.
const PROJECTILE_FALLBACK_COLOUR = {}

// _KIND_BY_NAME maps the adapter config's kind names onto the SFX kind
// constants the driver dispatches on.
const _KIND_BY_NAME = {
  laser:   SFX_PROJECTILE_LASER,
  dgun:    SFX_PROJECTILE_DGUN,
  plasma:  SFX_PROJECTILE_PLASMA,
  shell:   SFX_PROJECTILE_SHELL,
  missile: SFX_PROJECTILE_MISSILE,
  bullet:  SFX_PROJECTILE_BULLET,
}

// setProjectileFallbackColors installs the game's per-kind fallback hues
// ({ laser: [r,g,b], ... } in 0..2 floats — additive blend + bloom rely on
// >1 channels). Unknown kind names are ignored.
export function setProjectileFallbackColors(colors) {
  for (const k of Object.keys(PROJECTILE_FALLBACK_COLOUR)) delete PROJECTILE_FALLBACK_COLOUR[k]
  for (const [name, rgb] of Object.entries(colors || {})) {
    const kind = _KIND_BY_NAME[name]
    if (kind != null && Array.isArray(rgb)) PROJECTILE_FALLBACK_COLOUR[kind] = rgb
  }
}

// projectileColor — the SINGLE source of truth for a projectile's tint
// across every kind.  Reads the TDF `color=` (or `color2=` as a fallback)
// through the palette, then scales it by the per-kind brightness so the
// hand-authored weapon hue still reads as a laser / plasma / bullet
// rather than collapsing to a dim palette entry.  Returns [r,g,b,a] in
// 0..2 float range — the additive blend tolerates >1 channels and the
// post-FX bloom relies on them to bloom on.
export function projectileColor(weapon, kind, palette) {
  // Sprite particles render a pre-painted GAF bitmap; the weapon's
  // `color=` field on rendertype=4 is the SLOT index (a small enum
  // selecting which fx.gaf sequence to use), NOT a palette tint.
  // Returning white means the sampled texel passes through unmodified
  // and the projectile reads as the artist drew it.  Documented in
  // engine/weapon-bitmap-loader.js + internal/studio/weapon_bitmap.go.
  if (kind === SFX_PROJECTILE_SPRITE) return [1.0, 1.0, 1.0, 1.0]
  const w = weapon || {}
  const mul = PROJECTILE_BRIGHTNESS[kind] || 1.0
  const idx = (w.colorIdx > 0) ? w.colorIdx : (w.color2Idx > 0 ? w.color2Idx : 0)
  if (palette && idx > 0) {
    const c = palette.colorFor(idx)
    return [Math.min(2, c[0] * mul), Math.min(2, c[1] * mul), Math.min(2, c[2] * mul), 1]
  }
  const fb = PROJECTILE_FALLBACK_COLOUR[kind] || [1.0, 1.0, 1.0]
  return [fb[0] * mul, fb[1] * mul, fb[2] * mul, 1]
}

// Back-compat alias — older call sites import `laserColor` directly.
// Beam shots are just the SFX_PROJECTILE_LASER variant of
// projectileColor, so the alias keeps the caller terse without
// duplicating the lookup logic.
export function laserColor(weapon, palette) {
  return projectileColor(weapon, SFX_PROJECTILE_LASER, palette)
}

// pickProjectileKind — pick the visual particle kind for a weapon.
//
// PRIMARY signal is the weapon's TDF `rendertype` (see
// engine/weapon-rendertype.js for the audit + constants).  Every stock
// TA weapon ships rendertype, and it's the same value TA's own engine
// uses to pick the projectile visual — so consulting it makes our
// classifier match TA's behaviour by construction.
//
// FALLBACK (for mod weapons that omit rendertype) is the older flag-
// based heuristic.  Name regex is the absolute last resort.
export function pickProjectileKind(weapon) {
  const w = weapon || {}
  if (hasRenderType(w)) {
    switch (w.renderType) {
      case WEAPON_RENDERTYPE_LASER:
      case WEAPON_RENDERTYPE_MINDGUN:    // beam-like paralyser variant
      case WEAPON_RENDERTYPE_LIGHTNING:  // instant-hit lightning bolt
        return SFX_PROJECTILE_LASER
      case WEAPON_RENDERTYPE_PROJECTILE: // smoke-trailed missile / torpedo
        return SFX_PROJECTILE_MISSILE
      case WEAPON_RENDERTYPE_DGUN:
        return SFX_PROJECTILE_DGUN
      case WEAPON_RENDERTYPE_BITMAP:
        // Bitmap sprite is the catch-all bullet / plasma / shell class.
        // Split by physics: ballistic=1 reads as a heavy shell arcing
        // through the air; smokeTrail=1 (rare with bitmap) reads as a
        // missile; otherwise a bright bullet/plasma tracer.
        if (w.ballistic) return SFX_PROJECTILE_SHELL
        if (w.smokeTrail) return SFX_PROJECTILE_MISSILE
        return SFX_PROJECTILE_BULLET
      case WEAPON_RENDERTYPE_FLAME:
        // Flamethrower stream — closest visual fit is the plasma bolt
        // kind (bright, additive, short-lived).
        return SFX_PROJECTILE_PLASMA
      case WEAPON_RENDERTYPE_BOMB:
        // Gravity bombs always ship as model-projectiles (model=bomb),
        // so this kind is the particle fallback when the bomb's 3DO
        // mesh isn't available.  Missile reads closest to "thing
        // falling out of the sky."
        return SFX_PROJECTILE_MISSILE
    }
  }
  // ── Flag heuristic fallback (mod weapons without rendertype) ──
  // D-Gun family: commandfire + beamweapon is the unique pair in TA's
  // stock data (mirrors rendertype=3).
  if (w.commandFire && w.beamWeapon) return SFX_PROJECTILE_DGUN
  if (w.commandFire && (+w.areaOfEffectWU >= 80)) return SFX_PROJECTILE_DGUN
  if (w.beamWeapon) return SFX_PROJECTILE_LASER
  if (w.smokeTrail || w.selfProp || w.dropped || w.vlaunch) return SFX_PROJECTILE_MISSILE
  if (w.ballistic) return SFX_PROJECTILE_SHELL
  // ── Last-resort name regex ──
  const n = w.name || ''
  if (/disintegrator|dgun|d_gun/i.test(n)) return SFX_PROJECTILE_DGUN
  if (/missile|rocket|torpedo/i.test(n) || /missile|rocket/i.test(w.model || '')) return SFX_PROJECTILE_MISSILE
  if (/laser|beam/i.test(n)) return SFX_PROJECTILE_LASER
  if (/plasma|emg|emp/i.test(n)) return SFX_PROJECTILE_PLASMA
  if (/cannon|mortar|shell/i.test(n)) return SFX_PROJECTILE_SHELL
  return SFX_PROJECTILE_BULLET
}

// Per-kind default size in world units used to derive a sensible visual
// scale when the weapon's TDF doesn't push us anywhere unusual.  Mirrors
// the KIND_DEFAULTS in cob-particles for the projectile families; we
// keep our own copy here so the multiplier scaling below stays decoupled
// from the pool's render defaults.
const PROJECTILE_BASE_SIZE = {
  // Beam pulse base size mirrors the trimmed KIND_DEFAULTS — 12 wu reads
  // as a clean line without dominating the unit's silhouette.
  [SFX_PROJECTILE_LASER]:   12.0,
  [SFX_PROJECTILE_DGUN]:    32.0,
  [SFX_PROJECTILE_PLASMA]:  3.5,
  [SFX_PROJECTILE_SHELL]:   5.0,
  [SFX_PROJECTILE_MISSILE]: 4.0,
  [SFX_PROJECTILE_BULLET]:  2.5,
  // Animated bitmap projectile — the EMG-class yellow bolt reads at
  // roughly 8 world units (about the diameter of a Peewee gun barrel).
  // AoE-scaling on top still applies, so heavier weapons get a bigger
  // sprite without the artist's hand-painted bolt blowing up unreadably.
  [SFX_PROJECTILE_SPRITE]:  8.0,
}

// projectileSize — visual sprite size derived from the weapon's blast
// radius.  TA's `areaofeffect` is the blast DIAMETER in world units, so
// half of it is the radius; we scale the kind's base size up smoothly
// (with a soft cap) so a big AoE warhead reads visibly bigger than a
// pinpoint bullet without making every shell fill the screen.  Falls
// through to the kind base when the TDF doesn't ship areaofeffect.
export function projectileSize(weapon, kind) {
  const base = PROJECTILE_BASE_SIZE[kind] || 3.0
  const aoe = +((weapon || {}).areaOfEffectWU) || 0
  if (aoe <= 0) return base
  // Reference AoE = 32 wu (a typical Peewee/cannon round).  Square-root
  // scaling so a 4× larger AoE only doubles the sprite — keeps
  // pinpoint vs. heavy weapons distinguishable without making a 256-wu
  // nuke literally 16× the size of a bullet.
  const refAoE = 32
  const factor = Math.sqrt(aoe / refAoE)
  return base * Math.max(0.6, Math.min(3.5, factor))
}

// projectileLightStrength — dynamic-light reach derived from the AoE.
// Bigger blast → wider pulse on nearby surfaces.  The Laser and D-Gun
// kinds have non-zero base reach baked into KIND_DEFAULTS already; this
// helper computes an additional AoE-scaled value the emitter can pass
// when it wants every shot's glow to track its real game-data magnitude.
export function projectileLightStrength(weapon, kind) {
  const aoe = +((weapon || {}).areaOfEffectWU) || 0
  if (aoe <= 0) return 0
  // Lasers and the D-gun keep their baked-in floor (90 / 300) — only
  // raise it for AoE that's beyond that floor.  Other kinds get a
  // proportional pulse so a heavy plasma weapon visibly throbs the
  // scene more than a peashooter.
  const base = (kind === SFX_PROJECTILE_LASER) ? 90
             : (kind === SFX_PROJECTILE_DGUN)  ? 300
             : 0
  const scaled = aoe * 1.4
  return Math.max(base, Math.min(400, scaled))
}

// spawnLaserBeam draws a single-frame "instant hit" beam from anchor
// to target by emitting a chain of bright pulse particles along the
// line.  Real TA renders a coloured beam visible for a frame or two;
// we approximate with one pulse per 4 wu (capped at 120 so the pool
// stays sane on long-range shots).
export function spawnLaserBeam({ binding, weapon, anchor, target, palette }) {
  if (!binding || !binding.particles) return
  const dx = target[0] - anchor[0]
  const dy = target[1] - anchor[1]
  const dz = target[2] - anchor[2]
  const len = Math.hypot(dx, dy, dz)
  if (len < 0.001) return
  const color = laserColor(weapon, palette)
  // Pulse spacing widened from 4 → 6 wu so the chain isn't a solid
  // wall of overlapping sprites — with the trimmed 12 wu pulse size
  // 6 wu spacing keeps adjacent pulses just touching, producing a
  // continuous line without the fat solid streak the dense 4 wu
  // packing was creating.
  const segs = Math.max(12, Math.min(80, Math.round(len / 6)))
  for (let i = 0; i <= segs; i++) {
    const t = i / segs
    const p = [anchor[0] + dx * t, anchor[1] + dy * t, anchor[2] + dz * t]
    binding.particles.emit(SFX_PROJECTILE_LASER, p, {
      color,
      velocity: [0, 0, 0],
      gravity: 0,
      noFade: false,
    })
  }
}

// playWeaponSound routes a weapon's per-shot sound through the
// binding's AudioPool.  Source pos is the muzzle anchor (firing
// piece world XYZ) so the Audio inspector shows the discharge
// location even after the projectile moves on.  No-ops cleanly when
// the binding has no audio pool or the weapon has no soundStart.
export function playWeaponSound({ binding, weapon, anchor }) {
  if (!binding || !binding.audio) return
  if (!weapon || !weapon.soundStart) return
  binding.audio.play(weapon.soundStart, {
    vol: 0.7,
    kind: 'weapon-fire',
    source: weapon.name ? `${weapon.name}: fire` : 'Weapon fire',
    pos: anchor,
  })
}

// SmokeTrailManager owns the per-frame "drop a puff at the missile's
// current position every 40 ms of sim-time" emitter.  Both single-
// entity and multi-entity host paths need this, and the math is
// non-trivial enough (recompute the projectile's parametric position
// from launch + velocity + gravity·t²/2 because the pool compacts
// dead slots and we can't track an index) that having two copies
// invited drift.  One implementation, every host imports it.
//
// Usage:
//   const trails = new SmokeTrailManager()
//   // when a missile fires (typically from a 'fire' event subscriber):
//   trails.schedule(binding, anchor, velocity, gravity, lifeMs)
//   // every frame, with sim-time scaled dtMs (so slow-mo + pause work):
//   trails.tick(dtSimMs)
//   // on view dispose:
//   trails.clear()
//
// Per-frame ticking lets the trail cadence scale with playback rate
// — at 0.1× sim a slow missile leaves puffs every 400 ms wall ≈
// 40 ms sim, matching what its slowed velocity actually traces.
export class SmokeTrailManager {
  constructor() {
    this._trails = []
  }

  // schedule registers a new missile trail.  Captures the launch
  // anchor + velocity + gravity so puffs can be re-derived from
  // (anchor + velocity·t - ½·gravity·t²) without needing a live ref
  // to the projectile particle (which the pool may compact away).
  // Binding ref is held weakly via the trail record — when the unit
  // disposes, the binding's particle pool stops accepting emits and
  // the trail effectively becomes a no-op until it expires.
  //
  // intervalMs is the per-trail puff cadence (TA `smokedelay`).  Falls
  // back to the historic 40 ms default when omitted so existing
  // weapons (and weapons that don't ship the TDF field) keep their
  // current visual.
  schedule(binding, anchor, velocity, gravity, lifeMs, intervalMs, opts = {}) {
    if (!binding || !binding.particles) return
    this._trails.push({
      binding,
      anchor:   [anchor[0], anchor[1], anchor[2]],
      velocity: [velocity[0], velocity[1], velocity[2]],
      gravity:  gravity || 0,
      lifeMs:   Math.max(50, lifeMs || 0),
      // Floor at 20 ms so a bogus 0 / negative TDF field doesn't
      // spin up an infinite emit loop in the inner while().
      intervalMs: Math.max(20, +intervalMs > 0 ? +intervalMs : 40),
      ageMs: 0,
      nextEmitMs: 0,
      // Per-puff kind / size / life override.  Defaults give the
      // original white smoke trail used by missiles; the D-Gun path
      // overrides with a hot orange fire puff so the disintegrator
      // ball drags a visible flame behind it instead of trailing
      // missile-style smoke.
      puffKind:  opts.puffKind  || SFX_SMOKE_WHITE,
      puffSize:  +opts.puffSize  || 4,
      puffLife:  +opts.puffLife  || 800,
      puffRise:  +opts.puffRise  || 1.5,
      puffDrift: +opts.puffDrift || 0.8,
      puffColor: opts.puffColor || null,
    })
  }

  // tick advances every live trail by dtSimMs and drops puffs at
  // each trail's own intervalMs (TDF `smokedelay`).  Trails older
  // than their declared lifeMs are pruned in-place (the projectile
  // is past its max range or would have hit by now).
  tick(dtSimMs) {
    if (!this._trails.length) return
    let writeIdx = 0
    for (let i = 0; i < this._trails.length; i++) {
      const t = this._trails[i]
      t.ageMs += dtSimMs
      if (t.ageMs >= t.lifeMs) continue
      const b = t.binding
      if (!b || !b.particles) continue
      while (t.ageMs >= t.nextEmitMs) {
        t.nextEmitMs += t.intervalMs
        const elapsed = Math.min(t.ageMs, t.lifeMs) / 1000
        const px = t.anchor[0] + t.velocity[0] * elapsed
        const py = t.anchor[1] + t.velocity[1] * elapsed - 0.5 * t.gravity * elapsed * elapsed
        const pz = t.anchor[2] + t.velocity[2] * elapsed
        const emitOpts = {
          size:      t.puffSize,
          lifeMs:    t.puffLife,
          riseSpeed: t.puffRise,
          drift:     t.puffDrift,
        }
        if (t.puffColor) emitOpts.color = t.puffColor
        b.particles.emit(t.puffKind, [px, py, pz], emitOpts)
      }
      this._trails[writeIdx++] = t
    }
    this._trails.length = writeIdx
  }

  // clear drops every in-flight trail.  Called on view dispose so a
  // re-open doesn't inherit stale missile wakes from the previous
  // session.
  clear() { this._trails.length = 0 }
}

// resolveSpriteId asks the renderer whether the named weapon already
// has a registered fx.gaf bitmap sprite.  On miss it kicks off an
// async fetch + registration so a *subsequent* shot of the same
// weapon picks up the real sprite — the current shot uses the
// synthetic fallback (BULLET/SHELL/MISSILE) so the projectile is
// still visible while the asset loads.
//
// Only rendertype=4 weapons with a color slot in the supported range
// have bitmap projectiles; everything else short-circuits to 0.  See
// internal/studio/weapon_bitmap.go for the slot→sequence mapping +
// the documented "color=2 is a hack" reproduction.
function resolveSpriteId(binding, weapon) {
  if (!binding || !binding._renderer || !weapon) return 0
  if (!weapon.name) return 0
  if (!hasRenderType(weapon) || weapon.renderType !== WEAPON_RENDERTYPE_BITMAP) return 0
  const slot = +weapon.color || 0
  // 255 is the EARTHQUAKE "(No art)" sentinel — don't fetch.  Anything
  // outside the documented slot range falls through too so a wildly
  // mis-set TDF doesn't keep round-tripping 404s.
  if (slot < 0 || slot > 7) return 0
  const r = binding._renderer
  const existing = r.weaponBitmapId ? r.weaponBitmapId(weapon.name) : 0
  if (existing) return existing
  // First-sight: kick off the async load; subsequent shots will pick
  // up the registered sprite.  Guard with a per-binding seen-set so we
  // don't spam fetches for the same weapon (loader cache de-dupes the
  // network hit anyway, but the closure churn isn't free either).
  if (!binding._sprFetching) binding._sprFetching = new Set()
  const key = String(weapon.name).toUpperCase()
  if (binding._sprFetching.has(key)) return 0
  binding._sprFetching.add(key)
  loadWeaponBitmap(weapon.name).then((sprite) => {
    // Pass the TDF color slot through so the renderer can show
    // "Bitmap Projectile #N" on the inspector cards — the only
    // signal in the data that distinguishes one bitmap weapon from
    // another (same sprite slot can be shared across many weapons).
    if (sprite && r.registerWeaponBitmap) r.registerWeaponBitmap(weapon.name, sprite, slot)
    // Leave key in the set — registered sprites win the cache check on
    // next call regardless, and re-fetching on hot-reload is fine.
  }).catch(() => { /* loader returns null on error; nothing to do */ })
  return 0
}

// spawnProjectile emits a TA-style projectile from `anchor` toward
// `target` at the weapon's FBI velocity.  Handles three categories:
//
//   1. beamWeapon  → instant-hit; spawns the laser-beam streak +
//                    plays start sound.  Returns synchronously with
//                    nothing to track.
//   2. ballistic   → solves the launch angle for a parabolic arc
//                    that intersects the target, applies gravity to
//                    the particle so the shell visibly arcs.
//   3. else        → straight-line projectile at velocity vec.
//
// Common to non-beam paths: lifeMs sized to (range / velocity) ×
// arc-factor so the projectile expires roughly at the target.
//
// When opts.smokeTrails (a SmokeTrailManager) is supplied AND the
// chosen visual kind is SFX_PROJECTILE_MISSILE, the trail is
// scheduled inline — saves callers from duplicating the
// "if (result.kind === MISSILE) trails.schedule(...)" dance and
// keeps the missile-vs-bullet decision behind a single classifier.
//
// Returns { kind, lifeMs, velocity, anchor } so callers can chain
// follow-up effects (e.g. the Weapons-panel projectile recorder).
export function spawnProjectile({ binding, weapon, anchor, target, palette, gravity = 80, smokeTrails = null }) {
  if (!binding || !binding.particles || !weapon) return null
  const dx = target[0] - anchor[0]
  const dy = (target.length >= 3 ? target[1] : 0) - anchor[1]
  const dz = target[2] - anchor[2]
  const horiz = Math.hypot(dx, dz)
  if (horiz < 0.001) return null

  // Beam weapons: instant-hit.  Spawn the streak + play sound; no
  // travelling projectile.  The "is this really a beam vs. a D-gun
  // misflagged as beamWeapon" decision now lives in pickProjectileKind
  // (commandFire + huge AoE → DGUN); we just ask the classifier.
  const preKind = pickProjectileKind(weapon)
  if (preKind === SFX_PROJECTILE_LASER) {
    spawnLaserBeam({ binding, weapon, anchor, target, palette })
    playWeaponSound({ binding, weapon, anchor })
    return { kind: SFX_PROJECTILE_LASER, lifeMs: 200, velocity: [dx, dy, dz] }
  }

  const v = +weapon.velocityWU || 200
  let vx, vy, vz
  if (weapon.ballistic) {
    // Solve the launch angle that puts the parabola through the
    // target at the weapon's muzzle velocity.  Same math the unit-
    // editor's _aimAnglesFor uses so the projectile + the turret
    // pitch agree.  Out-of-range falls back to a 45° max-range
    // launch so the shell still flies somewhere reasonable.
    const v2 = v * v
    const disc = v2 * v2 - gravity * (gravity * horiz * horiz + 2 * dy * v2)
    let pitchRad
    if (disc >= 0) {
      pitchRad = Math.atan((v2 - Math.sqrt(disc)) / (gravity * horiz))
    } else {
      pitchRad = Math.PI / 4
    }
    const horizDir = [dx / horiz, dz / horiz]
    const cosP = Math.cos(pitchRad)
    vx = horizDir[0] * v * cosP
    vz = horizDir[1] * v * cosP
    vy = v * Math.sin(pitchRad)
  } else {
    const len = Math.hypot(dx, dy, dz)
    vx = (dx / len) * v
    vy = (dy / len) * v
    vz = (dz / len) * v
  }

  // Lifetime: range / velocity gives the time-of-flight at top speed.
  // Multiply by 1.5 for ballistic arcs (longer path along the arc) so
  // the shell doesn't vanish mid-flight on a long shot.
  const range = +weapon.rangeWU || (v * 3)
  const lifeFactor = weapon.ballistic ? 1.5 : 1.0
  const lifeMs = Math.max(300, (range / v) * 1000 * lifeFactor)

  // Animated-bitmap upgrade: rendertype=4 weapons can render a real
  // fx.gaf sprite strip instead of the synthetic point particle.  We
  // ask the renderer for an already-registered sprite id; on miss it
  // queues an async load so the *next* shot gets the upgrade and
  // this one keeps using the BULLET/SHELL/MISSILE fallback from
  // pickProjectileKind.  See resolveSpriteId above for the slot-
  // gating rules.
  const spriteId = resolveSpriteId(binding, weapon)
  const kind = spriteId > 0 ? SFX_PROJECTILE_SPRITE : preKind
  // Per-shot visual props derived from the weapon's TDF — colour from
  // the palette index, size + lightStrength from the blast radius.
  // emit() honours each opt, falling back to the kind defaults when a
  // field is omitted; we always pass colour so even a flag-only TDF
  // (no `color=`) gets its kind's branded hue rather than the smoke
  // grey default.
  const color = projectileColor(weapon, kind, palette)
  const size = projectileSize(weapon, kind)
  const light = projectileLightStrength(weapon, kind)
  const emitOpts = {
    velocity: [vx, vy, vz],
    gravity: weapon.ballistic ? gravity : 0,
    lifeMs,
    noFade: true,
    color,
    size,
  }
  if (light > 0) emitOpts.lightStrength = light
  if (spriteId > 0) emitOpts.spriteId = spriteId
  binding.particles.emit(kind, anchor, emitOpts)
  playWeaponSound({ binding, weapon, anchor })
  // Remember the weapon on the binding so _onParticleExpire knows what
  // to look up when the projectile lifeMs elapses and the impact fires.
  // Best-effort: shared across every concurrent in-flight shot from this
  // binding, so multi-weapon units use the LAST fired weapon's art for
  // whichever expires next.  Acceptable for the common case.
  binding._lastFiredWeapon = weapon
  // TDF startSmoke=1 — puff of light smoke at the muzzle on each fire.
  // Most cannons + plasma weapons ship this so the discharge has a
  // visible cloud independent of the impact burst at the other end.
  //
  // Size + life + alpha scale with the weapon's blast radius (AoE).
  // The old fixed (size 7, life 600 ms) was tuned for cannon-class
  // weapons but the Brawler / Peewee EMG (areaofeffect=8, burst=4 @
  // 100 ms cadence, startsmoke=1) stacked 4 of those per burst and
  // smoked the screen out of all proportion to a bullet weapon.
  // Reference AoE = 32 wu (a typical Peewee/cannon round); ratio
  // capped + sqrt-eased so the EMG gets a wisp (~size 3.5, life 280
  // ms), a heavy cannon stays at the old visual (~size 8, life 700
  // ms), and a Bertha-class blast still puffs visibly without the
  // sqrt curve runaway.  Alpha modulated too so EMG-class puffs are
  // ~half as opaque as cannon-class.
  if (weapon.startSmoke) {
    const aoe = +weapon.areaOfEffectWU || 32
    const refAoE = 32
    const scale = Math.max(0.4, Math.min(2.5, Math.sqrt(aoe / refAoE)))
    const size  = 3.0 + 5.0 * (scale - 0.4) / (2.5 - 0.4)
    const life  = 200 + 1100 * (scale - 0.4) / (2.5 - 0.4)
    const alpha = 0.18 + 0.32 * (scale - 0.4) / (2.5 - 0.4)
    binding.particles.emit(SFX_SMOKE_WHITE, anchor, {
      size,
      lifeMs: life,
      riseSpeed: 1.4,
      drift: 1.0,
      // Override the kind default colour so the alpha scales — pick
      // up the kind's RGB but use the AoE-scaled alpha.
      color: [0.92, 0.92, 0.96, alpha],
    })
  }
  // Missiles trail smoke along their flight path.  Caller passes a
  // SmokeTrailManager via opts.smokeTrails when it wants this — hosts
  // either hold one per active unit or one shared across every
  // spawned unit's bindings.  No-ops cleanly when the manager isn't
  // supplied or the kind isn't a missile.
  if (smokeTrails && kind === SFX_PROJECTILE_MISSILE) {
    const intervalMs = (+weapon.smokeDelaySec > 0) ? weapon.smokeDelaySec * 1000 : 40
    smokeTrails.schedule(binding, anchor, [vx, vy, vz], weapon.ballistic ? gravity : 0, lifeMs, intervalMs)
  }
  // D-Gun trail — the disintegrator ball drags a hot orange flame
  // behind it in the original game.  We re-use the SmokeTrailManager
  // (it's geometry-only — re-derives puff positions from the launch
  // anchor + velocity) and tell it to emit fire-flash puffs instead
  // of the missile-default white smoke.  Cadence is faster than a
  // missile trail (every 30 ms) so the flame reads as continuous at
  // the D-Gun's slow 200 wu/s flight.
  if (smokeTrails && kind === SFX_PROJECTILE_DGUN) {
    smokeTrails.schedule(binding, anchor, [vx, vy, vz], weapon.ballistic ? gravity : 0, lifeMs, 30, {
      puffKind:  SFX_FIRE_FLASH,
      puffSize:  10,
      puffLife:  350,
      puffRise:  0,
      puffDrift: 0,
      puffColor: [2.0, 0.7, 0.2, 1.0],
    })
  }
  return { kind, lifeMs, velocity: [vx, vy, vz], anchor: [anchor[0], anchor[1], anchor[2]] }
}

// spawnProjectileInFlight re-emits a tracer particle for a shot already mid-air
// — the late-join / Force-Sync case, where the authoritative engine carries an
// in-flight cannon shell or EMG bolt but the joining client never saw the fire
// event that would have spawned its visual.  Unlike spawnProjectile it does not
// derive a launch solution: the caller supplies the engine's current position,
// velocity and remaining flight time, so the cosmetic particle picks the shot up
// exactly where the host left it.  Beam weapons never persist in flight (they
// hit instantly), so a laser kind is a no-op.  No muzzle smoke / fire sound is
// played — those belong to the launch instant, which already happened.
export function spawnProjectileInFlight({ binding, weapon, pos, vel, lifeMs, palette, gravity = 80 }) {
  if (!binding || !binding.particles || !weapon) return null
  const preKind = pickProjectileKind(weapon)
  if (preKind === SFX_PROJECTILE_LASER) return null
  const spriteId = resolveSpriteId(binding, weapon)
  const kind = spriteId > 0 ? SFX_PROJECTILE_SPRITE : preKind
  const color = projectileColor(weapon, kind, palette)
  const size = projectileSize(weapon, kind)
  const light = projectileLightStrength(weapon, kind)
  const emitOpts = {
    velocity: [vel[0], vel[1], vel[2]],
    gravity: weapon.ballistic ? gravity : 0,
    lifeMs: Math.max(100, lifeMs || 0),
    noFade: true,
    color,
    size,
  }
  if (light > 0) emitOpts.lightStrength = light
  if (spriteId > 0) emitOpts.spriteId = spriteId
  binding.particles.emit(kind, pos, emitOpts)
  binding._lastFiredWeapon = weapon
  return { kind, lifeMs: emitOpts.lifeMs }
}

// Re-export the SFX kind ids so consumers that need to special-case
// (e.g. "schedule a smoke trail for missiles") can compare against
// pickProjectileKind's return without importing cob-particles.js
// separately.
export {
  SFX_PROJECTILE_BULLET,
  SFX_PROJECTILE_SHELL,
  SFX_PROJECTILE_PLASMA,
  SFX_PROJECTILE_DGUN,
  SFX_PROJECTILE_LASER,
  SFX_PROJECTILE_MISSILE,
  SFX_FIRE_FLASH,
  SFX_SMOKE_WHITE,
}
