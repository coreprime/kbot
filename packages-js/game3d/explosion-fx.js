// explosion-fx.js — polygonal 3D explosions with a hard readability budget.
//
// Replaces the old additive point-sprite bursts with real geometry: an
// expanding emissive fireball polyhedron, flying shard tetrahedra and a
// ground shockwave ring, all rebuilt into ONE interleaved triangle buffer
// per frame (renderer setExplosionTris) and drawn additively so the
// cinematic preset's bloom lifts them.
//
// READABILITY IS A CORRECTNESS REQUIREMENT here, not a style choice: the
// commander-death stress test (dozens of concurrent impacts) previously
// washed the whole lower screen white.  Three disciplines bound the output:
//
//  1. Per-hit effects are SMALL and SHORT.  A small-arms impact is a
//     ~300 ms flash of radius well under the blast diameter; only genuine
//     detonations (unit deaths, D-gun, nukes) get the big, long ladder
//     tiers.
//  2. Overlapping impacts COALESCE.  Spawns hash into COALESCE_BUCKET_WU
//     buckets; once a bucket holds MAX_PER_BUCKET live effects a further
//     hit REFRESHES the strongest one (restarting its flash) instead of
//     stacking a new emitter.  A global MAX_CONCURRENT cap backs that up:
//     when full, a new spawn replaces the oldest weaker record or is
//     dropped.  Ten attackers hammering one unit read as rapid re-flashes
//     + smoke, never as accumulating brightness.
//  3. LUMINANCE SOFT-CLIP.  Every record's vertex alpha is scaled by a
//     global dimming term that falls as the live count climbs
//     (1/sqrt(live/BUDGET_FREE_COUNT)), so total additive contribution
//     saturates instead of growing without bound — terrain and unit
//     silhouettes stay visible under the heaviest barrage.
//
// Deterministic: geometry derives from a per-spawn seed (position + spawn
// ordinal), and all motion is stepped by the caller's fx-clock dtMs — no
// Date.now / rAF anywhere.

import { mulberry32 } from './map-features.js'

// ── Tunables (see the discipline rationale above) ────────────────────────

// Global live-record ceiling.  24 concurrent explosions is already "the
// whole screen is a battle"; past it new small hits recycle old records.
export const MAX_CONCURRENT = 24

// Spatial coalescing: at most this many live records per bucket…
export const MAX_PER_BUCKET = 2
// …where a bucket is this many world units square (about one large unit's
// footprint plus its immediate surroundings).
export const COALESCE_BUCKET_WU = 48

// Live-count knee for the luminance soft-clip: at or below this many live
// records every effect renders at full brightness; above it the global
// alpha scale falls as sqrt(BUDGET_FREE_COUNT / live).
export const BUDGET_FREE_COUNT = 8

// How many of the strongest live records feed scene lights.
export const MAX_LIGHTS = 5

// ── Mushroom-cloud shape (mushroom tier only) ────────────────────────────
// The cap is a fan of MUSHROOM_CAP_LOBES billowing lobes; the stem is a
// tapered column rising from the ground flash to the cap.  Heights/radii are
// multiples of the record's fireball radius so the whole cloud scales with
// the death-weapon AoE that picked the tier.
export const MUSHROOM_CAP_LOBES = 10
export const MUSHROOM_STEM_RISE = 3.4   // final cap height, × fireball rMax
export const MUSHROOM_CAP_RADIUS = 1.5  // cap radius, × fireball rMax
export const MUSHROOM_STEM_RADIUS = 0.4 // stem half-width, × fireball rMax

// ── Size ladder ──────────────────────────────────────────────────────────
//
// Tier picks from the weapon's areaOfEffect (blast DIAMETER, wu) and the
// death severity.  Radii are deliberately far below the raw AoE — the AoE
// is a damage circle, not a fireball size.
const TIERS = {
  //           lifeMs  r0   r1(xAoE) rMax shards ring light  peak
  small:  { life: 300,  r0: 1.5, rk: 0.18, rMax: 10, shards: 5,  ring: false, light: 28,  peak: [1.5, 0.85, 0.35] },
  medium: { life: 520,  r0: 2.5, rk: 0.22, rMax: 22, shards: 9,  ring: true,  light: 60,  peak: [1.7, 0.80, 0.30] },
  large:  { life: 850,  r0: 4.0, rk: 0.26, rMax: 44, shards: 14, ring: true,  light: 110, peak: [1.9, 0.75, 0.28] },
  huge:   { life: 1400, r0: 6.0, rk: 0.30, rMax: 90, shards: 22, ring: true,  light: 190, peak: [2.1, 0.80, 0.30] },
  // Mushroom cloud: a commander / big-AoE catastrophic death.  This tier is
  // NOT just a bigger fireball — _build renders a distinct rising stem +
  // billowing cap + ground flash + a wide shockwave ring (see rec.mushroom).
  // Its `light`/`peak` still obey the luminance budget (the global soft-clip
  // and MAX_LIGHTS cap apply), so a single hero blast lights the field
  // without washing it: the cap is the same as `huge`, the shape is what
  // differs.  rMax is the fireball head; the stem/cap scale off MUSHROOM_*.
  mushroom: { life: 2200, r0: 8.0, rk: 0.34, rMax: 120, shards: 26, ring: true, light: 210, peak: [2.2, 0.82, 0.32], mushroom: true },
  // Water splash: white/foam ladder — a ring + upward spray shards, no
  // fireball glow to bloom out.
  splash: { life: 620,  r0: 2.0, rk: 0.20, rMax: 26, shards: 8,  ring: true,  light: 0,   peak: [0.85, 0.95, 1.05] },
}

// MUSHROOM_AOE_THRESHOLD — a DEATH explosion whose weapon AoE (blast diameter,
// world units) is at or above this renders the mushroom-cloud tier instead of
// `huge`.  Calibrated from the packed FBI death weapons: the Arm/Core
// commander COMMANDER_BLAST is AoE 950; the biggest ordinary unit death
// (BIG_UNITEX) is 110 and heavy weapon AoEs sit well under 480, so only true
// commander-class / nuke-class deaths cross it.  Impacts (non-death) never
// take this tier — an in-flight nuke still detonates as `huge`.
export const MUSHROOM_AOE_THRESHOLD = 480

// tierFor classifies a spawn.  Deaths climb one rung (a dying unit is a
// real detonation); a commander-class death (AoE ≥ MUSHROOM_AOE_THRESHOLD)
// becomes the mushroom cloud; severity ≥ 100 (self-destruct / commander)
// tops the ordinary ladder out at `huge`.
export function tierFor({ aoe = 16, kind = 'impact', severity = 0 } = {}) {
  if (kind === 'splash') return 'splash'
  if (kind === 'death' && aoe >= MUSHROOM_AOE_THRESHOLD) return 'mushroom'
  let t
  if (aoe < 24) t = 'small'
  else if (aoe < 96) t = 'medium'
  else if (aoe < 240) t = 'large'
  else t = 'huge'
  if (kind === 'death') {
    if (severity >= 100 || t === 'large') t = 'huge'
    else if (t === 'small') t = 'medium'
    else if (t === 'medium') t = 'large'
  }
  return t
}

const TIER_RANK = { small: 0, splash: 0, medium: 1, large: 2, huge: 3, mushroom: 4 }

// easeOutCubic — fireball expansion: fast fill, slow settle.
const easeOut = (t) => 1 - Math.pow(1 - t, 3)

export class ExplosionManager {
  constructor() {
    this._live = []
    this._spawnCount = 0
    // Growable interleaved output buffer (pos3 + rgba4).
    this._out = new Float32Array(4096 * 7)
    this._outVerts = 0
  }

  get liveCount() { return this._live.length }

  _bucketKey(x, z) {
    return `${Math.floor(x / COALESCE_BUCKET_WU)},${Math.floor(z / COALESCE_BUCKET_WU)}`
  }

  // spawn registers one detonation at pos ([x,y,z]).  Opts:
  //   aoe       — the weapon's blast diameter (wu); drives the tier ladder.
  //   kind      — 'impact' | 'death' | 'splash'.
  //   severity  — death severity (unitDeath's ladder input).
  // Returns the live record, the record it refreshed instead, or null when
  // the budget dropped the spawn entirely.
  spawn(pos, { aoe = 16, kind = 'impact', severity = 0 } = {}) {
    const tierName = tierFor({ aoe, kind, severity })
    const tier = TIERS[tierName]
    const rank = TIER_RANK[tierName]
    const bucket = this._bucketKey(pos[0], pos[2])

    // Coalesce: a saturated bucket refreshes its strongest record rather
    // than stacking another emitter.
    const inBucket = this._live.filter((r) => r.bucket === bucket)
    if (inBucket.length >= MAX_PER_BUCKET) {
      let best = inBucket[0]
      for (const r of inBucket) if (r.rank > best.rank) best = r
      if (rank > best.rank) {
        // A genuinely bigger detonation upgrades the record in place.
        this._init(best, pos, tierName, tier, rank, bucket)
      } else {
        // Same-or-smaller: re-trigger the flash, keep the budget flat.
        best.ageMs = Math.min(best.ageMs, best.lifeMs * 0.25)
      }
      return best
    }

    // Global ceiling: replace the oldest strictly-weaker record, else drop.
    if (this._live.length >= MAX_CONCURRENT) {
      let victim = null
      for (const r of this._live) {
        if (r.rank < rank && (!victim || r.ageMs > victim.ageMs)) victim = r
      }
      if (!victim) return null
      this._init(victim, pos, tierName, tier, rank, bucket)
      return victim
    }

    const rec = {}
    this._init(rec, pos, tierName, tier, rank, bucket)
    this._live.push(rec)
    return rec
  }

  _init(rec, pos, tierName, tier, rank, bucket) {
    this._spawnCount++
    const seed = ((Math.abs(pos[0] * 73856093) ^ Math.abs(pos[2] * 19349663) ^ (this._spawnCount * 83492791)) >>> 0) || 1
    const rng = mulberry32(seed)
    rec.tier = tierName
    rec.rank = rank
    rec.bucket = bucket
    rec.x = pos[0]; rec.y = pos[1]; rec.z = pos[2]
    rec.ageMs = 0
    rec.lifeMs = tier.life
    rec.rMax = Math.min(tier.rMax, tier.r0 + tier.rk * 999)
    rec.tierDef = tier
    // Shard directions + spins, fixed at spawn (deterministic flight).
    const shards = []
    for (let i = 0; i < tier.shards; i++) {
      const az = rng() * Math.PI * 2
      const el = (tierName === 'splash' ? 0.55 : 0.15) + rng() * 0.75
      const sp = (0.6 + rng() * 0.8)
      shards.push({
        dx: Math.cos(az) * Math.cos(el) * sp,
        dy: Math.sin(el) * sp,
        dz: Math.sin(az) * Math.cos(el) * sp,
        size: 0.5 + rng(),
        spin: rng() * Math.PI * 2,
        spinRate: (rng() * 2 - 1) * 9,
      })
    }
    rec.shards = shards
    rec.fireJitter = []
    for (let i = 0; i < 6; i++) rec.fireJitter.push(0.75 + rng() * 0.5)
    rec.ringPhase = rng() * Math.PI * 2
    // Mushroom-cloud shape data (only the mushroom tier reads it): per-lobe
    // billow radii for the cap and a phase so the cap rolls, all fixed at
    // spawn for deterministic playback.
    rec.mushroom = !!tier.mushroom
    if (rec.mushroom) {
      rec.capBillow = []
      for (let i = 0; i < MUSHROOM_CAP_LOBES; i++) rec.capBillow.push(0.8 + rng() * 0.6)
      rec.stemPhase = rng() * Math.PI * 2
      rec.groundY = pos[1]
    }
  }

  // step ages the records by fx-clock dtMs and rebuilds the triangle
  // buffer.  Call once per world step; read tris()/vertCount() after.
  step(dtMs, { aoeOf = null } = {}) {
    void aoeOf
    if (dtMs > 0) {
      let w = 0
      for (const r of this._live) {
        r.ageMs += dtMs
        if (r.ageMs < r.lifeMs) this._live[w++] = r
      }
      this._live.length = w
    }
    this._build()
  }

  tris() { return this._out }
  vertCount() { return this._outVerts }

  // lights returns the strongest live records as scene lights, capped at
  // MAX_LIGHTS and pre-dimmed by the global budget so a barrage doesn't
  // floodlight the field either.
  lights() {
    const dim = this._globalDim()
    const recs = this._live
      .filter((r) => r.tierDef.light > 0)
      .sort((a, b) => b.rank - a.rank || a.ageMs - b.ageMs)
      .slice(0, MAX_LIGHTS)
    const out = []
    for (const r of recs) {
      const t = r.ageMs / r.lifeMs
      const fade = Math.max(0, 1 - t * 1.4)
      if (fade <= 0) continue
      const p = r.tierDef.peak
      out.push({
        pos: [r.x, r.y, r.z],
        color: [p[0], p[1], p[2]],
        strength: r.tierDef.light * fade * dim,
      })
    }
    return out
  }

  // _globalDim — luminance soft-clip term (discipline 3).
  _globalDim() {
    const n = this._live.length
    if (n <= BUDGET_FREE_COUNT) return 1
    return Math.sqrt(BUDGET_FREE_COUNT / n)
  }

  _ensure(verts) {
    const need = verts * 7
    if (need <= this._out.length) return
    let cap = this._out.length
    while (cap < need) cap *= 2
    const next = new Float32Array(cap)
    next.set(this._out.subarray(0, this._outVerts * 7))
    this._out = next
  }

  _pushTri(ax, ay, az, bx, by, bz, cx, cy, cz, r, g, b, a) {
    this._ensure(this._outVerts + 3)
    let o = this._outVerts * 7
    const d = this._out
    d[o++] = ax; d[o++] = ay; d[o++] = az; d[o++] = r; d[o++] = g; d[o++] = b; d[o++] = a
    d[o++] = bx; d[o++] = by; d[o++] = bz; d[o++] = r; d[o++] = g; d[o++] = b; d[o++] = a
    d[o++] = cx; d[o++] = cy; d[o++] = cz; d[o++] = r; d[o++] = g; d[o++] = b; d[o] = a
    this._outVerts += 3
  }

  // _buildMushroom renders the mushroom-cloud tier's distinct shape at
  // normalised age `t` (0..1): a bright ground flash, a tapered rising stem,
  // and a billowing cap that expands and lifts as it ages.  `r` is the
  // fireball head radius (already eased), `cr/cg/cb` the age-cooled colour,
  // `alpha` the fade × budget-dim term.  All geometry scales off `r`, so a
  // bigger death-weapon AoE (higher tier rMax) grows the whole cloud.
  _buildMushroom(rec, t, r, cr, cg, cb, alpha) {
    const gy = rec.groundY != null ? rec.groundY : rec.y
    // Stem grows to full height over the first ~60% of life, then holds.
    const rise = Math.min(1, t / 0.6)
    const stemH = rec.rMax * MUSHROOM_STEM_RISE * rise
    const capY = gy + stemH
    const stemR = rec.rMax * MUSHROOM_STEM_RADIUS
    // Ground flash: a bright squashed dome at the base (hottest, fades fast).
    const flashA = alpha * Math.max(0, 1 - t * 2.2)
    if (flashA > 0.001) {
      const fr = r * 1.3
      const fy = gy + fr * 0.4
      const SEG = 10
      for (let i = 0; i < SEG; i++) {
        const a0 = rec.ringPhase + (i / SEG) * Math.PI * 2
        const a1 = rec.ringPhase + ((i + 1) / SEG) * Math.PI * 2
        const x0 = rec.x + Math.cos(a0) * fr, z0 = rec.z + Math.sin(a0) * fr
        const x1 = rec.x + Math.cos(a1) * fr, z1 = rec.z + Math.sin(a1) * fr
        this._pushTri(x0, gy, z0, x1, gy, z1, rec.x, fy, rec.z, cr * 1.3, cg * 1.2, cb, flashA)
      }
    }
    // Stem: a tapered column from the flash up to the cap, a ring of quads.
    const SEG = 8
    for (let i = 0; i < SEG; i++) {
      const a0 = rec.stemPhase + (i / SEG) * Math.PI * 2
      const a1 = rec.stemPhase + ((i + 1) / SEG) * Math.PI * 2
      // Waist pinches slightly toward the top (classic mushroom stem).
      const rb = stemR * 1.1, rt = stemR * 0.7
      const bx0 = rec.x + Math.cos(a0) * rb, bz0 = rec.z + Math.sin(a0) * rb
      const bx1 = rec.x + Math.cos(a1) * rb, bz1 = rec.z + Math.sin(a1) * rb
      const tx0 = rec.x + Math.cos(a0) * rt, tz0 = rec.z + Math.sin(a0) * rt
      const tx1 = rec.x + Math.cos(a1) * rt, tz1 = rec.z + Math.sin(a1) * rt
      this._pushTri(bx0, gy, bz0, bx1, gy, bz1, tx1, capY, tz1, cr * 0.9, cg * 0.8, cb * 0.7, alpha * 0.8)
      this._pushTri(bx0, gy, bz0, tx1, capY, tz1, tx0, capY, tz0, cr * 0.9, cg * 0.8, cb * 0.7, alpha * 0.8)
    }
    // Cap: a billowing lobed dome that widens and lifts as it rolls over.
    const capR = rec.rMax * MUSHROOM_CAP_RADIUS * (0.5 + 0.5 * rise)
    const capTop = capY + capR * 0.7
    const capBase = capY - capR * 0.35
    const cb0 = rec.capBillow
    for (let i = 0; i < MUSHROOM_CAP_LOBES; i++) {
      const a0 = rec.ringPhase + (i / MUSHROOM_CAP_LOBES) * Math.PI * 2
      const a1 = rec.ringPhase + ((i + 1) / MUSHROOM_CAP_LOBES) * Math.PI * 2
      const r0 = capR * cb0[i % MUSHROOM_CAP_LOBES]
      const r1 = capR * cb0[(i + 1) % MUSHROOM_CAP_LOBES]
      const x0 = rec.x + Math.cos(a0) * r0, z0 = rec.z + Math.sin(a0) * r0
      const x1 = rec.x + Math.cos(a1) * r1, z1 = rec.z + Math.sin(a1) * r1
      // Rounded top and a rolled-under lower lip (the mushroom's curl).
      this._pushTri(x0, capY, z0, x1, capY, z1, rec.x, capTop, rec.z, cr, cg, cb, alpha)
      this._pushTri(x1, capY, z1, x0, capY, z0, rec.x, capBase, rec.z, cr * 0.6, cg * 0.6, cb * 0.6, alpha * 0.75)
    }
  }

  _build() {
    this._outVerts = 0
    const dim = this._globalDim()
    for (const rec of this._live) {
      const t = Math.min(1, rec.ageMs / rec.lifeMs)
      const tier = rec.tierDef
      const peak = tier.peak
      const splash = rec.tier === 'splash'
      // Fireball radius: fast expansion, then hold while fading.
      const r = Math.min(tier.r0 + (rec.rMax - tier.r0) * easeOut(Math.min(1, t * 1.6)), rec.rMax)
      const fade = Math.pow(1 - t, 1.4)
      const alpha = fade * dim
      // Colour cools with age: white-orange core → deep red embers.
      const cool = 1 - t * 0.7
      const cr = peak[0] * cool, cg = peak[1] * cool * (1 - t * 0.4), cb = peak[2] * cool * (1 - t * 0.5)

      // ── Fireball / mushroom cloud.
      if (rec.mushroom) {
        this._buildMushroom(rec, t, r, cr, cg, cb, alpha)
      } else if (!splash) {
        // A 6-lobed jittered octahedron fan (8 side faces × top/bottom read
        // as a molten polyhedron under additive blend).
        const jr = rec.fireJitter
        const yTop = rec.y + r * jr[4] * 0.9
        const yBot = rec.y - r * jr[5] * 0.55
        for (let i = 0; i < 6; i++) {
          const a0 = rec.ringPhase + (i / 6) * Math.PI * 2
          const a1 = rec.ringPhase + ((i + 1) / 6) * Math.PI * 2
          const r0 = r * jr[i % 6]
          const r1 = r * jr[(i + 1) % 6]
          const x0 = rec.x + Math.cos(a0) * r0, z0 = rec.z + Math.sin(a0) * r0
          const x1 = rec.x + Math.cos(a1) * r1, z1 = rec.z + Math.sin(a1) * r1
          this._pushTri(x0, rec.y, z0, x1, rec.y, z1, rec.x, yTop, rec.z, cr, cg, cb, alpha)
          this._pushTri(x1, rec.y, z1, x0, rec.y, z0, rec.x, yBot, rec.z, cr * 0.7, cg * 0.7, cb * 0.7, alpha * 0.8)
        }
      }

      // ── Shards: small emissive tetra-fans flying ballistic arcs.
      const sec = rec.ageMs / 1000
      const shardSpeed = rec.rMax * (splash ? 2.2 : 2.8)
      const grav = splash ? 130 : 90
      for (const s of rec.shards) {
        const px = rec.x + s.dx * shardSpeed * sec
        const py = rec.y + s.dy * shardSpeed * sec - 0.5 * grav * sec * sec
        const pz = rec.z + s.dz * shardSpeed * sec
        if (py < rec.y - rec.rMax) continue
        const sz = s.size * (splash ? 1.4 : 1.0) * Math.max(0.6, r * 0.14)
        const ang = s.spin + s.spinRate * sec
        const ca = Math.cos(ang) * sz, sa = Math.sin(ang) * sz
        const sr = splash ? peak[0] : cr * 1.1
        const sg = splash ? peak[1] : cg * 1.1
        const sb = splash ? peak[2] : cb
        this._pushTri(px - ca, py - sz * 0.6, pz - sa, px + ca, py - sz * 0.6, pz + sa, px, py + sz, pz, sr, sg, sb, alpha)
      }

      // ── Shockwave ring: a thin expanding ground annulus.
      if (tier.ring) {
        const ringR = rec.rMax * (0.6 + 2.2 * easeOut(t))
        const ringW = Math.max(0.8, rec.rMax * 0.14) * (1 - t * 0.5)
        const ringA = alpha * (splash ? 0.5 : 0.35) * (1 - t)
        const ry = rec.y + 0.6
        const rr2 = splash ? peak[0] : peak[0] * 0.9
        const rg2 = splash ? peak[1] : peak[1] * 0.8
        const rb2 = splash ? peak[2] : peak[2] * 0.6
        const SEG = 14
        for (let i = 0; i < SEG; i++) {
          const a0 = rec.ringPhase + (i / SEG) * Math.PI * 2
          const a1 = rec.ringPhase + ((i + 1) / SEG) * Math.PI * 2
          const ix0 = rec.x + Math.cos(a0) * (ringR - ringW), iz0 = rec.z + Math.sin(a0) * (ringR - ringW)
          const ox0 = rec.x + Math.cos(a0) * (ringR + ringW), oz0 = rec.z + Math.sin(a0) * (ringR + ringW)
          const ix1 = rec.x + Math.cos(a1) * (ringR - ringW), iz1 = rec.z + Math.sin(a1) * (ringR - ringW)
          const ox1 = rec.x + Math.cos(a1) * (ringR + ringW), oz1 = rec.z + Math.sin(a1) * (ringR + ringW)
          this._pushTri(ix0, ry, iz0, ox0, ry, oz0, ox1, ry, oz1, rr2, rg2, rb2, ringA)
          this._pushTri(ix0, ry, iz0, ox1, ry, oz1, ix1, ry, iz1, rr2, rg2, rb2, ringA)
        }
      }
    }
  }

  clear() {
    this._live.length = 0
    this._outVerts = 0
  }
}
