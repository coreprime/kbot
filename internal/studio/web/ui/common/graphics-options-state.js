// graphics-options-state.js
//
// Single source of truth for the "Graphics Options" menu values shared
// by the unit-editor and sandbox ribbons.  The menu itself
// (/ui/common/graphics-options-menu.js) is presentational; this module
// owns the *persistence* + *renderer application* side so a user's
// chosen effect toggles + shadow settings survive reloads and apply
// uniformly across every rendering pane.
//
//   - getGraphicsOptions()   — the live values (persisted patch merged
//                              over GRAPHICS_DEFAULTS).  Raw menu units
//                              (sliders are 0..100 / 0..200, NOT the
//                              normalised /100 the renderer wants).
//   - persistGraphicsOptions(patch) — merge a raw-value patch into
//                              state.graphicsOptions + debounce-save.
//   - applyGraphicsOptionsToRenderer(r) — push every option through the
//                              renderer's setters (normalising sliders).
//
// Lives in /ui/common/ because BOTH editor sections read + write it;
// the only upward import is host-context (state) + prefs, matching the
// existing prefs.js dependency shape.

import { state } from '../host-context.js'
import { persistPrefs } from './prefs.js'
import { setEnhanceMeshEnabled } from '@kbot/game3d/enhance-mesh'

// GRAPHICS_DEFAULTS — the at-rest values, matching the renderer's own
// constructor defaults so a fresh session paints identically whether
// or not anything has been persisted yet.  Raw menu units.
export const GRAPHICS_DEFAULTS = {
  enhanceMesh:      false,  // reconstruct faces TA deleted (open box bottoms,
                            // hollow shells) so units render solid all round;
                            // changes the geometry fetched, not a shader flag

  lightIntensity:   100,   // 0..200 → 0..2.0× scene exposure (Brightness)
  dynamicLights:    32,    // 0..256  → max simultaneous weapon-SFX point lights
                           // (raw count, NOT a /100 slider — passed straight to
                           // the renderer's setMaxDynamicLights)

  shadows:          true,
  shadowIntensity:  70,    // 0..100  → uShadowStrength 0..1
  selfShadow:       true,

  reflections:      true,
  specular:         true,
  specularLevel:    100,   // 0..200  → 0..2.0× specular sheen strength
  metalSpec:        true,   // Surface Hints: per-material specular inference
  runningLights:    true,   // colour-keyed blinking emissive status lamps
  runningLightsLevel: 100,  // 0..200 → 0..2.0× running-lights glow strength
  bumpMap:          true,   // texture-luminance auto-bump relief on tagged tiles
  bumpLevel:        100,    // 0..200 → 0..2.0× bump relief strength
  godbeams:         true,
  dof:              false,
  dofDistance:      500,   // 100..2000 → 1.0..20.0× onset distance (default 5×)
  dofLevel:         100,   // 0..200    → 0..2.0× max blur radius

  antialias:        false, // FXAA edge smoothing.  Off by default: the
                           // canvas already gets hardware MSAA on the
                           // direct-to-screen path (crisper than FXAA);
                           // FXAA mainly matters once a post-FX forces the
                           // no-MSAA offscreen FBO path.

  cinematic:        false, // ACES tonemap + grade + vignette
  cinematicLevel:   100,   // 0..100    → grade intensity %
  bloom:            false, // bright-pass glow
  bloomLevel:       100,   // 0..200    → 0..2.0× bloom add strength
  lensFlare:        false, // screen-space sun flare
  lensFlareLevel:   100,   // 0..200    → 0..2.0× flare strength

  waterReflections: true,
  waves:            true,
  wavesIntensity:   100,   // 0..200  → 0..2.0×
  bob:              true,
  bobAmount:        100,   // 0..200  → 0..2.0×
  bobSpeed:         100,   // 0..200  → 0..2.0×
}

// getGraphicsOptions — persisted patch merged over the hard defaults.
// Unknown keys in the stored blob are ignored on read by virtue of the
// caller only reading known keys, but the merge keeps any extra keys
// harmlessly.
export function getGraphicsOptions() {
  return { ...GRAPHICS_DEFAULTS, ...(state.graphicsOptions || {}) }
}

// persistGraphicsOptions — merge a raw-value patch (only the known
// graphics keys are taken) into state.graphicsOptions and schedule a
// debounced save through the shared prefs store.
export function persistGraphicsOptions(patch) {
  if (!patch) return
  const next = { ...getGraphicsOptions() }
  for (const k of Object.keys(GRAPHICS_DEFAULTS)) {
    if (k in patch) next[k] = patch[k]
  }
  state.graphicsOptions = next
  persistPrefs()
}

// applyGraphicsOptionsToRenderer — push every persisted option through
// the renderer's setters.  Sliders are normalised (/100) to match the
// values the ribbon bridges pass.  Optional-chained so a renderer that
// predates a given setter (or a lighter observer renderer) is skipped
// gracefully rather than throwing.
export function applyGraphicsOptionsToRenderer(r) {
  if (!r) return
  const g = getGraphicsOptions()
  // enhanceMesh isn't a renderer uniform — it picks which geometry the
  // loader fetches. Only sync it once the user has actually chosen a value
  // so a persisted preference survives reloads without overriding the
  // URL-seeded default (?enhanceMesh=1) on profiles that never toggled it.
  if (state.graphicsOptions && 'enhanceMesh' in state.graphicsOptions) {
    setEnhanceMeshEnabled(!!g.enhanceMesh)
  }
  r.setExposure?.(g.lightIntensity / 100)
  r.setMaxDynamicLights?.(g.dynamicLights)
  r.setShadowsEnabled?.(!!g.shadows)
  r.setShadowStrength?.(g.shadowIntensity / 100)
  r.setSelfShadow?.(!!g.selfShadow)
  r.setReflectionsEnabled?.(!!g.reflections)
  r.setSpecularEnabled?.(!!g.specular)
  r.setSpecularStrength?.(g.specularLevel / 100)
  r.setMetalSpecEnabled?.(!!g.metalSpec)
  r.setRunningLightsEnabled?.(!!g.runningLights)
  r.setRunningLightsStrength?.(g.runningLightsLevel / 100)
  r.setBumpEnabled?.(!!g.bumpMap)
  r.setBumpStrength?.(g.bumpLevel / 100)
  r.setGodBeamsEnabled?.(!!g.godbeams)
  r.setDoFEnabled?.(!!g.dof)
  r.setDoFDistance?.(g.dofDistance / 100)
  r.setDoFLevel?.(g.dofLevel / 100)
  r.setAntialiasEnabled?.(!!g.antialias)
  r.setCinematic?.(!!g.cinematic)
  r.setCinematicStrength?.(g.cinematicLevel / 100)
  r.setBloomEnabled?.(!!g.bloom)
  r.setBloomStrength?.(g.bloomLevel / 100)
  r.setLensFlareEnabled?.(!!g.lensFlare)
  r.setLensFlareStrength?.(g.lensFlareLevel / 100)
  r.setWaterReflectionsEnabled?.(!!g.waterReflections)
  r.setWavesEnabled?.(!!g.waves)
  r.setWavesIntensity?.(g.wavesIntensity / 100)
  r.setBobEnabled?.(!!g.bob)
  r.setBobAmount?.(g.bobAmount / 100)
  r.setBobSpeed?.(g.bobSpeed / 100)
}
