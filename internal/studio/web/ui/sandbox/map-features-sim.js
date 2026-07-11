// map-features-sim.js
//
// Turns a sandbox map's placed scenery (the {name, ax, ay} list the
// /api/studio/sandbox-map JSON carries) into the sim-side addFeature specs the
// wasm engine needs so the build-placement legality probe (canBuildAt) can see
// map resources. Only the two resource families that GATE building are pushed:
//
//   - Metal deposits (featuredef category=metal, metal>0) → a metalPatch (kind
//     1). The engine stamps the deposit's metal into the terrain cell grid so a
//     metal extractor founded on it passes its "footprint overlaps metal" rule.
//     Pushed non-blocking: unlike a rock or vent, a deposit is passable and an
//     extractor is founded directly on top of it, so it must not occupy its plot.
//   - Geothermal vents (featuredef geothermal=1) → a geothermal site (kind 0,
//     geothermal:true). A geothermal plant may be founded only where its
//     footprint overlaps such a vent; the vent stays indestructible/blocking so
//     an ordinary building is still refused the plot (the plant it powers is
//     exempt inside the engine).
//
// Trees, rocks and other scenery are deliberately left out: they carry no build
// gate and pushing them would turn the sandbox's decorative props into sim
// obstacles. The transform is pure so it can be unit-tested without a wasm world.

// FeatureKind ordinals, matching sim.FeatureKind exported by the wasm bridge.
const KIND_PROP = 0
const KIND_METAL_PATCH = 1

// classifyMapFeature decides how (or whether) one placed feature enters the sim,
// given its resolved featuredef. Returns 'metal', 'geothermal' or null.
function classifyMapFeature(def) {
  if (!def) return null
  if (def.geothermal) return 'geothermal'
  // A real metal deposit is authored category=metal with a metal yield; a rock
  // that merely reclaims to some metal (category=rocks) is not a build site.
  if (def.metal > 0 && String(def.category || '').toLowerCase() === 'metal') return 'metal'
  return null
}

// simFeatureSpecs maps the placed-feature list to addFeature specs. `defs` is
// the /api/studio/feature-defs catalogue keyed by lower-case feature id; cellWU
// is the world units per attribute cell (16). Each feature's world position is
// its cell centre, matching the renderer's surrogate placement so the visual
// deposit and its sim metal cell coincide.
export function simFeatureSpecs(features, defs = {}, cellWU = 16) {
  const specs = []
  if (!Array.isArray(features)) return specs
  for (const f of features) {
    if (!f || typeof f.name !== 'string') continue
    const def = defs[f.name.toLowerCase()]
    const kindTag = classifyMapFeature(def)
    if (!kindTag) continue
    const ax = f.ax | 0
    const ay = f.ay | 0
    const base = {
      name: f.name,
      x: (ax + 0.5) * cellWU,
      z: (ay + 0.5) * cellWU,
      heading: 0,
      footprintX: def.footprintX | 0,
      footprintZ: def.footprintZ | 0,
    }
    if (kindTag === 'metal') {
      specs.push({
        ...base,
        kind: KIND_METAL_PATCH,
        metal: Math.round(def.metal),
        // Passable: the extractor sits on the deposit, so it must not block.
        blocking: false,
        indestructible: false,
      })
    } else {
      specs.push({
        ...base,
        kind: KIND_PROP,
        geothermal: true,
        // The vent stays a solid obstacle for ordinary buildings; the engine
        // exempts the geothermal plant it powers.
        blocking: !!def.blocking,
        indestructible: def.indestructible !== false,
      })
    }
  }
  return specs
}
