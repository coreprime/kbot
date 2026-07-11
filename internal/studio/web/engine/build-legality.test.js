// build-legality.test.js
//
// Headless end-to-end gate for the studio's build-placement restriction on a
// sandbox map's resource features (#132). It drives the SAME path the browser
// does: the sandbox's map-feature → sim transform (simFeatureSpecs) feeds the
// freshly built engine.wasm's addFeature, then the wasm canBuildAt probe (the
// one view.js colours the placement ghost from) is queried on and off the
// resource.
//
// What it proves:
//   - A metal deposit pushed as a metalPatch stamps metal into the cell grid,
//     so a metal extractor reads BUILDABLE on the deposit and REFUSED off it,
//     while an ordinary building has no such requirement.
//   - A geothermal vent pushed as a geothermal site reaches the sim: an
//     ordinary building is refused its plot (the vent blocks) and buildable
//     clear of it.
//   - A geothermal plant (yardmap laid in 'G') is gated onto that vent by the
//     wasm meta bridge's Geothermal derivation: refused off the vent, buildable
//     over it, and unblocked by the vent it is founded upon.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { runInThisContext } from 'node:vm'
import { simFeatureSpecs } from '../ui/sandbox/map-features-sim.js'

const WASM_URL = new URL('./engine.wasm', import.meta.url)
const WASM_EXEC_URL = new URL('./wasm_exec.js', import.meta.url)

let enginePromise = null
function loadEngine() {
  if (enginePromise) return enginePromise
  enginePromise = (async () => {
    const shim = await readFile(fileURLToPath(WASM_EXEC_URL), 'utf8')
    globalThis.require = createRequire(import.meta.url)
    runInThisContext(shim)
    const go = new globalThis.Go()
    const bytes = await readFile(fileURLToPath(WASM_URL))
    const { instance } = await WebAssembly.instantiate(bytes, go.importObject)
    const state = { crashed: false }
    go.run(instance).then(() => { state.crashed = true })
    for (let i = 0; i < 500 && !globalThis.KbotEngine; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    assert.ok(globalThis.KbotEngine, 'wasm booted but KbotEngine was never exported')
    return { api: globalThis.KbotEngine, state }
  })()
  return enginePromise
}

const CELL = 16
const centre = (c) => (c + 0.5) * CELL

// The featuredef catalogue the /api/studio/feature-defs endpoint would serve,
// pared to the two resource families the transform acts on.
const DEFS = {
  greenmetal01: { category: 'metal', metal: 90, footprintX: 3, footprintZ: 3, indestructible: true },
  metalvent01: { category: 'steamvents', geothermal: true, footprintX: 3, footprintZ: 3, indestructible: true },
  greentree1: { category: 'trees', footprintX: 1, footprintZ: 1, blocking: true, reclaimable: true },
}

// A metal-extractor buildee (extractsmetal>0) and a plain building, backing the
// canBuildAt resolver the wasm session calls to resolve a build name → meta.
// A geothermal plant carries a yardmap laid in 'G' — the wasm meta bridge
// derives its Geothermal flag from that, the same way the native games meta
// does — so canBuildAt gates it onto a vent.
const RESOLVER = (name) => ({
  mex: { name: 'mex', canMove: false, footprintX: 3, footprintZ: 3, maxSlope: 50, econ: { extractsMetal: 0.001 } },
  hut: { name: 'hut', canMove: false, footprintX: 3, footprintZ: 3, maxSlope: 50 },
  geo: { name: 'geo', canMove: false, footprintX: 3, footprintZ: 3, maxSlope: 50, yardMap: 'GGG GGG GGG' },
}[name] || null)

test('map resource features gate the studio build preview through the wasm path', async () => {
  const { api, state } = await loadEngine()
  const handle = api.create(2, 0, RESOLVER, 0)

  // Flat 48×48 map, no water, no relief — isolate the resource-site rule.
  const w = 48, h = 48
  api.setTerrain(handle, { w, h, cellWU: CELL, heightScale: 0.61, seaLevel: 0, data: new Uint8Array(w * h), voids: null })

  // A metal deposit at cell (20,20), a geothermal vent at (34,34), plus a tree
  // that must be ignored — the exact {name, ax, ay} shape the map JSON carries.
  const placed = [
    { name: 'GreenMetal01', ax: 20, ay: 20 },
    { name: 'MetalVent01', ax: 34, ay: 34 },
    { name: 'GreenTree1', ax: 5, ay: 40 },
  ]
  const specs = simFeatureSpecs(placed, DEFS, CELL)
  assert.equal(specs.length, 2, 'only the deposit + vent are pushed (the tree is decorative)')
  for (const spec of specs) assert.ok(api.addFeature(handle, spec) > 0, `addFeature ${spec.name} returned no id`)
  assert.ok(!state.crashed, 'wasm engine exited while placing features')

  const can = (name, cx, cz) => api.canBuildAt(handle, name, centre(cx), centre(cz))

  // Metal extractor: refused off-metal, allowed where its 3×3 footprint catches
  // the deposit, and the deposit does not block it (it is founded on top).
  assert.equal(can('mex', 8, 8), false, 'extractor off the deposit must read REFUSED')
  assert.equal(can('mex', 20, 20), true, 'extractor on the deposit must read BUILDABLE')
  // Ordinary building carries no metal requirement.
  assert.equal(can('hut', 8, 8), true, 'ordinary building has no metal-site requirement')

  // Geothermal vent reached the sim: an ordinary building is refused its plot
  // (the vent is a solid obstacle) yet buildable clear of it.
  assert.equal(can('hut', 34, 34), false, 'ordinary building must be blocked by the vent feature')
  assert.equal(can('hut', 10, 34), true, 'clear of the vent the plot builds')

  // Geothermal plant: refused clear of the vent, buildable where its footprint
  // catches it, and the vent it is founded over does not block it.
  assert.equal(can('geo', 10, 34), false, 'geothermal plant off the vent must read REFUSED')
  assert.equal(can('geo', 34, 34), true, 'geothermal plant on the vent must read BUILDABLE')

  api.destroy(handle)
})
