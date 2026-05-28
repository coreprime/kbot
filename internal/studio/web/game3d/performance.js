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
export const SHADOW_LOD_MIN_PX = 40

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

// ── Phase 3 — far-unit impostor ──────────────────────────────────────

// Selected far-tier units flicker their impostor sprite on/off so
// the user can spot a selection that's too far away for a full
// model.  Period is the full on-off cycle in milliseconds — wall-
// clock, so unaffected by sim slow-mo.  ~0.8 s gives a visible but
// not seizure-y blink that survives auto-rotate panning.
export const SELECTED_IMPOSTOR_FLICKER_MS = 800

// ── Audio dedup ──────────────────────────────────────────────────────

// When a sound stem starts playing the AudioPool refuses to start
// the SAME stem again within this wall-clock window.  Prevents the
// 40-Hz COB tick from spawning N duplicate Audio elements when a
// burst-fire weapon kicks off in the same simulation tick from
// multiple weapons / multiple units.  ~125 ms ≈ 5 TA ticks at the
// default 40 Hz tick rate.
export const AUDIO_DEDUP_WINDOW_MS = 125
