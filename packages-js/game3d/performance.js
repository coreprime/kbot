// performance.js
//
// Single source of truth for renderer-side performance tunables.  Every
// LOD threshold, hysteresis margin, cull padding, and default-on flag
// the renderer reads lives here so a perf pass can be done by reading
// one file instead of grepping through 3000 lines of WebGL code.
//
// Conventions:
//   * Lengths in WORLD units (wu) — TA standard, ~1 wu ≈ 16 in-game
//     "footprint" cells.  The default unit-editor zoom puts a kbot at
//     ~100 wu from the camera.
//   * Pixel thresholds in CSS PIXELS — the LOD classifier computes a
//     projected screen-space radius and compares.  Independent of the
//     device pixel ratio (we compute against the CSS-pixel canvas
//     height so retina/HiDPI displays don't shift the tiers).
//   * Hysteresis factor is a unitless multiplier applied symmetrically:
//     enter a denser tier at threshold × factor, leave at threshold /
//     factor.
//
// Nothing in this file imports from any other module — it's pure
// numeric constants.  The engine package (web/engine/) never imports
// it; the engine has no LOD or cull knobs of its own.

// ── Frustum culling (Phase 1) ─────────────────────────────────────────

// Default-on for newly constructed renderers.  Each Renderer panel's
// "Frustum cull" toggle flips this at runtime per-viewer.
export const DEFAULT_CULL_ENABLED = true

// Padding (wu) added to every entity's bounding-sphere radius before
// the camera-frustum test.  Absorbs small world-space wobbles that
// the static object-space sphere doesn't capture:
//   * sea-bob heave (~3-5 wu at default amplitude)
//   * walk-cycle bounce
//   * heading rotation around a non-centered pivot
// Conservative; a false-positive "visible" costs at most one draw call.
export const CULL_RADIUS_PADDING_WU = 5

// Particle-pool cull padding (wu).  Particles emitted by a binding
// can drift well outside the unit's own bounds — projectiles, smoke
// trails, ship wakes.  We pad the cull radius generously so an in-
// flight effect still draws while plausibly in-frame.  ~half the
// typical TA weapon range so any projectile whose host unit is just
// outside the camera frustum but could plausibly fire INTO it still
// renders.
export const PARTICLE_CULL_RADIUS_PADDING_WU = 200

// ── Shadow LOD (Phase 2 — first slice) ────────────────────────────────

// Default-on for newly constructed renderers.  Renderer panel's
// "Shadow LOD" toggle flips this at runtime per-viewer.
export const DEFAULT_SHADOW_LOD_ENABLED = true

// Threshold (CSS pixels): below this projected radius an entity skips
// the shadow pass.  Tuned against the default unit-editor framing
// (kbot at ~100 wu fills ~120 px) so:
//   * a unit at < ~500 wu from the camera reads its shadow
//   * a unit at > ~1000 wu drops shadows
//   * the user can fly far enough out to cull 80%+ of casters in a
//     50-unit sandbox without a visible step change at the boundary.
export const SHADOW_LOD_MIN_PX = 20

// Camera distance (wu) past which unit shadows have fully faded out; the
// fade starts at half this. Pairs with the halved SHADOW_LOD_MIN_PX so the
// per-unit LOD gate stops culling shadows before the global fade finishes.
export const SHADOW_ZOOM_FADE_MAX = 3200

// ── LOD hysteresis ────────────────────────────────────────────────────

// Symmetric tier-transition margin.  Enter a denser tier at
// `threshold × factor`, leave at `threshold / factor`.  Wider band =
// less flicker at the boundary, but a slower visual transition when
// the user zooms in/out smoothly.  1.25 = 25% band, chosen to be wide
// enough that an auto-rotating camera doesn't flick units across the
// boundary every revolution but narrow enough that a deliberate zoom
// crosses cleanly.
export const LOD_HYSTERESIS = 1.25

// ── Phase 2 (full) — pixel-radius bounds for LOD tiers ────────────────
// NOTE: not yet referenced by the renderer.  Reserved for the next
// slice that adds the no-shadow / no-specular mid-tier shader path
// plus the flare/muzzle piece-hide.  Listed here so the perf knobs
// stay in one file once they land.
export const TIER_FULL_MIN_PX = 80   // ≥ 80 px → full pipeline
export const TIER_MID_MIN_PX  = 12   // ≥ 12 px → mid path; below → Phase 3 impostor

// PROJECTILE_LOD_MULTIPLIER lets in-flight model projectiles (missiles,
// rockets, bombs) stay at higher detail than their projected size would
// otherwise warrant.  A bomb has a tiny bounding sphere — 4-8 wu vs. a
// kbot's ~15 wu — so by the unit-tier thresholds it drops to the impostor
// dot before it's halfway to its target, which reads as the bomb
// "vanishing" mid-flight.  This multiplier divides the FULL / MID / shadow
// thresholds for projectile entities, so a 3× multiplier keeps the
// projectile in its current tier roughly 3× further out.  Set to 1 to
// treat projectiles like ordinary units; raise for "stay drawn longer".
export const PROJECTILE_LOD_MULTIPLIER = 3

// ── Additive-particle luminance budget ──────────────────────────────────
//
// The particle pass blends ONE/ONE (additive), so N overlapping bright
// sprites are N× brighter — a mass laser barrage used to stack into a
// white sheet that hid the terrain.  The renderer sums each LUMINOUS
// particle's contribution (alpha × size, the additive footprint) and,
// past this budget, scales every luminous particle's alpha by
// budget/load — total additive light saturates at the budget instead of
// growing without bound, and the scene stays readable under any barrage.
// ~1200 ≈ two-and-a-half full-brightness laser beams (40 pulses × size
// 12); a couple of concurrent shots render exactly as before, a barrage
// saturates at that level.  Tuned against the commander-death stress
// harness: 30 beams + deaths per frame must leave terrain + silhouettes
// readable (< 8% of the frame white-saturated).
export const PARTICLE_ADDITIVE_BUDGET = 1200

// Same discipline for the dynamic pulse lights the particles cast on the
// world: total light strength (wu reach) across all slots saturates here —
// createWorld scales every light down proportionally past it.  ~600 ≈ two
// D-gun-class lights or a dozen laser pulses at full strength.
export const PULSE_LIGHT_ENERGY_BUDGET = 600

// Particle kinds that count against (and get scaled by) the budget:
// sparks, muzzle/impact flashes, every projectile family and the nano
// stream.  Smoke's sub-1 colour barely adds; it stays un-governed so
// battle haze never vanishes.
export const LUMINOUS_PARTICLE_KINDS = new Set([3, 4, 16, 200, 201, 202, 203, 204, 205, 206])

// ── Phase 3 — far-unit impostor ──────────────────────────────────────

// Selected far-tier units flicker their impostor sprite on/off so
// the user can spot a selection that's too far away for a full
// model.  Period is the full on-off cycle in milliseconds — wall-
// clock, so unaffected by sim slow-mo.  ~0.8 s gives a visible but
// not seizure-y blink that survives auto-rotate panning.
export const SELECTED_IMPOSTOR_FLICKER_MS = 800

// ── Effect distance LOD ───────────────────────────────────────────────
// Fine surface effects only read up close, so they're switched off past a
// camera-to-unit distance (wu) to save fragment work in busy scenes.  Bump
// + specular drop first (they need near-pixel detail to register at all);
// the running-lights glow survives a bit further since its bright dots +
// halo stay legible at range.  Distance is camera → unit-centre in world
// units — at the default unit-editor framing a kbot sits ~100 wu out, so
// these only bite once a unit is well into the distance.  A short
// smoothstep fade-band (below) avoids a hard pop at the boundary.
export const EFFECT_LOD_SURFACE_MAX_WU = 700        // beyond → no bump / no specular hint
export const EFFECT_LOD_RUNNINGLIGHTS_MAX_WU = 1100 // beyond → no running lights
export const EFFECT_LOD_FADE_WU = 120               // smoothstep fade width before each cutoff

// ── Running-light grouping ───────────────────────────────────────────
// Lamp-atlas (lamp-map.js) colour harmonisation: any two running-light
// sources within this many TEXELS of each other that resolve to a
// DIFFERENT colour are both snapped to the dominant (strongest) source's
// colour, so a cluster of nearby lamps reads as one coherent colour
// instead of a speckle of competing shades.  Raise to harmonise over a
// wider area, drop toward 0 to let neighbouring lamps keep distinct hues.
export const RUNNING_LIGHT_COLOR_MERGE_PX = 4

// Running-light blink timing is quantised into this many HSV-hue buckets
// (in main.frag): every lamp whose hue lands in the same bucket pulses on
// the SAME cycle, so two slightly different shades of blue can't drift a
// little out of phase.  1 = all lamps blink together; more = finer
// per-colour timing.
export const RUNNING_LIGHT_TIMING_BUCKETS = 5

// ── Locomotion pose overlay (model-renderer._updateUnitOrientation) ───

// HOVERCRAFT_WOBBLE_SCALE multiplies the procedural pitch/roll/heave gyration
// applied to hovercraft (Category HOVER) as they idle + drive on their air
// cushion.  1 = the baseline amplitude; raise for a more pronounced wobble,
// drop toward 0 to calm it.  Tune this to taste.
export const HOVERCRAFT_WOBBLE_SCALE = 3

// AIRCRAFT_BANK_SCALE multiplies how hard aircraft roll into their turns (on
// top of the per-unit FBI BankScale).  1 = baseline lean; raise for a more
// dramatic bank.  Tune to taste.
export const AIRCRAFT_BANK_SCALE = 3

// ── Audio dedup ──────────────────────────────────────────────────────

// When a sound stem starts playing the AudioPool refuses to start
// the SAME stem again within this wall-clock window.  Prevents the
// 40-Hz COB tick from spawning N duplicate Audio elements when a
// burst-fire weapon kicks off in the same simulation tick from
// multiple weapons / multiple units.  ~125 ms ≈ 5 TA ticks at the
// default 40 Hz tick rate.
export const AUDIO_DEDUP_WINDOW_MS = 125
