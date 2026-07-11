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
//   - TA:Kingdoms sacred sites (featuredef sacredsite>0) → a sacred site (kind
//     3, sacredSite:multiplier). A mana-producing lodestone building (yardmap
//     'S') credits mogriumincome × the stone's sacredsite while its footprint
//     fully covers the stone. The stone lies flush on the ground and is passable
//     (TDF blocking=0), so it is pushed non-blocking — the producer founds
//     directly on top of it, exactly as a metal extractor sits on a deposit.
//
//   - Reclaimable scenery (featuredef reclaimable=1) — trees, reclaim rocks,
//     kelp — enters as a scenery prop (kind 0) carrying its reclaim yield and
//     its FBI blocking flag, so a construction unit can salvage it for
//     metal/energy and clear the plot. The renderer still draws the object from
//     the map's own feature layer; the sim feature is the reclaim/collision
//     surrogate for it.
//
// Non-reclaimable decorative scenery carries no build gate and no reclaim value,
// so it is left out entirely. The transform is pure so it can be unit-tested
// without a wasm world.

// FeatureKind ordinals, matching sim.FeatureKind exported by the wasm bridge.
const KIND_PROP = 0
const KIND_METAL_PATCH = 1
const KIND_SACRED_SITE = 3

// classifyMapFeature decides how (or whether) one placed feature enters the sim,
// given its resolved featuredef and its placed name. Returns 'metal',
// 'geothermal' or null.
//
// A genuine metal deposit — the only thing a metal extractor may be founded on —
// is an INDESTRUCTIBLE, metal-bearing, sprite (no 3DO) resource site. Most are
// filed under category=metal (the archipelago / mars patches), but the green-
// planet deposits are authored under category=rocks with metal- or aquaore-named
// ids (greenaquaore1-3, rockmetal1-4). This mirrors the render layer's rule in
// pack_features.go isMetalDepositFeature so those loose-category deposits are not
// missed. The indestructible gate keeps decorative-but-metal-named scenery out:
// MetalTower* (category=building) and the reclaim rocks are destructible, so they
// stay ordinary scenery and never masquerade as a mex site.
function classifyMapFeature(def, name = '') {
  if (!def) return null
  if (def.geothermal) return 'geothermal'
  // A TA:K sacred site is defined by its sacredsite multiplier, not its
  // category (the upright henge standing-stones share category=mana but carry
  // no multiplier and stay decorative scenery). The multiplier alone is the
  // unambiguous gate.
  if (def.sacredSite > 0 && !def.object) return 'mana'
  if (def.metal > 0) {
    const cat = String(def.category || '').toLowerCase()
    if (cat === 'metal') return 'metal'
    const id = String(def.id || name).toLowerCase()
    if (def.indestructible && !def.object &&
        (id.includes('metal') || id.includes('aquaore'))) {
      return 'metal'
    }
  }
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
    const kindTag = classifyMapFeature(def, f.name)
    // Not a build-gating resource, but a reclaimable prop (a tree, a reclaim
    // rock, kelp): push it as a scenery feature carrying its reclaim yield so a
    // construction unit can salvage it for metal/energy and clear the cell. The
    // sim feature is invisible on its own — the renderer already draws the
    // placed scenery from the map's feature layer — it exists only so reclaim /
    // blocking see the object.
    if (!kindTag) {
      if (!def || !def.reclaimable) continue
      const ax = f.ax | 0
      const ay = f.ay | 0
      specs.push({
        name: f.name,
        x: (ax + 0.5) * cellWU,
        z: (ay + 0.5) * cellWU,
        heading: 0,
        footprintX: def.footprintX | 0,
        footprintZ: def.footprintZ | 0,
        kind: KIND_PROP,
        metal: Math.max(0, Math.round(def.metal || 0)),
        energy: Math.max(0, Math.round(def.energy || 0)),
        // Real TA scenery blocks per its FBI flag (movers path around a tree);
        // honour it so the reclaimable prop occupies its plot exactly as it
        // renders. A reclaimed prop clears the cell.
        blocking: !!def.blocking,
        reclaimable: true,
        indestructible: false,
        featureDead: typeof def.featureDead === 'string' ? def.featureDead : '',
      })
      continue
    }
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
    } else if (kindTag === 'mana') {
      specs.push({
        ...base,
        kind: KIND_SACRED_SITE,
        sacredSite: def.sacredSite,
        // Passable: the lodestone producer founds directly over the stone (the
        // engine reads its sacredsite multiplier from the covered feature), so
        // it must not block its own plot — mirroring the metal-patch push.
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
