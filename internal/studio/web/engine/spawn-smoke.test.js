// spawn-smoke.test.js
//
// Headless spawn gate for the studio's in-browser sim. It loads the freshly
// built engine.wasm through the same two files the studio's wasm-source.js
// loads at runtime (wasm_exec.js + engine.wasm, siblings of this file), creates
// a session per game, spawns a realistic unit, drives it for a couple of
// seconds of sim time, and asserts the module never died.
//
// The bug this guards against: an engine/sim change that shifts the JS<->wasm
// contract makes the module panic on the first spawn and the Go runtime prints
// "Go program has already exited" as every subsequent call touches a dead VM.
// Catching that here turns a silent in-browser spawn crash into a CI failure.
//
// One session is a TA world (metal/energy economy) and one a TA:K world (single
// mana pool) so both economy laws are exercised through the create() bridge.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { runInThisContext } from 'node:vm'

const WASM_URL = new URL('./engine.wasm', import.meta.url)
const WASM_EXEC_URL = new URL('./wasm_exec.js', import.meta.url)

// EconomyModel ordinals, matching sim.EconomyModel (0 = TA, 1 = TA:K).
const ECON_TA = 0
const ECON_TAK = 1

// loadEngine boots the wasm module once and returns the KbotEngine global.
// wasm_exec.js is Go's own loader shim: a classic script that defines
// globalThis.Go by mutating globalThis, so we evaluate it in this realm rather
// than import it as a module (it has no exports). A dead module surfaces as
// go.run() resolving — the engine otherwise parks in select{} forever — so we
// latch that into `crashed` for the assertions.
let enginePromise = null
function loadEngine() {
  if (enginePromise) return enginePromise
  enginePromise = (async () => {
    const shim = await readFile(fileURLToPath(WASM_EXEC_URL), 'utf8')
    // wasm_exec.js references require/module in some Node code paths; give it
    // this file's require so the classic script evaluates cleanly.
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

// A TA unit meta mirroring /api/studio/unit's shape for a light kbot: it can
// move, has one weapon, and carries the econ/combat/specials fields the bridge
// now threads through so a browser spawn exercises the full stat block.
function taUnitMeta() {
  return {
    name: 'armpw',
    canMove: true,
    maxVelocity: 1.2,
    turnRate: 1200,
    acceleration: 0.08,
    brakeRate: 0.12,
    maxDamage: 240,
    footprintX: 2,
    footprintZ: 2,
    costMetal: 55,
    costEnergy: 490,
    buildTime: 1900,
    workerTime: 0,
    objectName: 'armpw',
    econ: {
      buildTime: 1900,
      buildCostMetal: 55,
      buildCostEnergy: 490,
      energyStorage: 0,
      metalStorage: 0,
    },
    weapons: [
      {
        name: 'ARM_LASER',
        rangeWU: 220,
        reloadSec: 0.4,
        burst: 1,
        damageDefault: 22,
        velocityWU: 420,
        areaOfEffectWU: 8,
        turret: true,
        reloadTicks: 12,
      },
      { name: '' },
      { name: '' },
    ],
  }
}

// A TA:K unit meta: a swordsman-style melee unit with a mana pool and the
// single-mana economy fields.
function takUnitMeta() {
  return {
    name: 'swordsman',
    canMove: true,
    maxVelocity: 1.1,
    turnRate: 900,
    acceleration: 0.1,
    brakeRate: 0.14,
    maxDamage: 180,
    footprintX: 1,
    footprintZ: 1,
    costMana: 60,
    damageCategory: 'infantry',
    experiencePoints: 666,
    maxMana: 100,
    manaRechargeTick: 0.5,
    econ: {
      buildCost: 60,
      buildTimeF: 60,
      manaIncome: 0,
      manaStorage: 0,
    },
    weapons: [
      {
        name: 'SWORD',
        rangeWU: 24,
        reloadSec: 1.0,
        burst: 1,
        damageDefault: 40,
        areaOfEffectWU: 0,
        melee: true,
        reloadTicks: 30,
      },
      { name: '' },
      { name: '' },
    ],
  }
}

// spawnAndDrive is the shared body: create a session for the given economy,
// spawn the unit at the origin, order it across the field, step ~120 ticks
// (~4 s of sim time), and return what the world reported plus whether the
// module ever died. It asserts nothing itself so each game's test can phrase
// its own failure messages.
async function spawnAndDrive(econModel, meta) {
  const { api, state } = await loadEngine()
  const handle = api.create(1, 0, undefined, econModel)
  const id = api.addUnit(handle, meta, 0, 0, 0, 1)
  assert.ok(id > 0, 'addUnit returned no unit id')

  // Order it to a distant point and step. Record its first and last snapshot
  // position so we can prove it actually advanced under the move order.
  api.submitMove(handle, [id], 400, 0, false)
  let first = null
  let last = null
  let resources = null
  for (let t = 0; t < 120; t++) {
    const snap = api.step(handle)
    assert.ok(snap && Array.isArray(snap.units), `step ${t} returned no snapshot`)
    assert.ok(!state.crashed, `wasm engine exited during step ${t} (spawn crash)`)
    const u = snap.units.find((x) => x.id === id)
    assert.ok(u, `spawned unit vanished from the snapshot at tick ${t}`)
    if (!first) first = u
    last = u
    if (snap.resources) resources = snap.resources
  }
  api.destroy(handle)
  return { first, last, resources, crashed: state.crashed }
}

// dist2D is the planar distance between two snapshot units.
function dist2D(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

test('TA unit spawns, survives 120 ticks, and moves when ordered', async () => {
  const { first, last, resources, crashed } = await spawnAndDrive(ECON_TA, taUnitMeta())
  assert.ok(!crashed, 'the wasm engine exited (Go program has already exited)')
  assert.ok(dist2D(first, last) > 1, 'the ordered TA unit never advanced')
  // The per-side resource block feeds the sandbox economy HUD; the metal/energy
  // fields must be present under the TA economy (the resources-hud.js contract).
  assert.ok(Array.isArray(resources) && resources.length > 0, 'no per-side resources reported')
  assert.ok('metalStock' in resources[0] && 'energyStock' in resources[0], 'TA resource block missing metal/energy fields')
})

test('TA:K unit spawns, survives 120 ticks, and moves when ordered', async () => {
  const { first, last, resources, crashed } = await spawnAndDrive(ECON_TAK, takUnitMeta())
  assert.ok(!crashed, 'the wasm engine exited (Go program has already exited)')
  assert.ok(dist2D(first, last) > 1, 'the ordered TA:K unit never advanced')
  // Under the TA:K economy the single mana pool must be reported.
  assert.ok(Array.isArray(resources) && resources.length > 0, 'no per-side resources reported')
  assert.ok('manaStock' in resources[0], 'TA:K resource block missing mana field')
})

// A cheap script-less structure the construction kbot raises. Low cost so the
// default 1000/1000 opening stock covers two in a row without stalling.
function structureMeta(name) {
  return {
    name,
    canMove: false,
    isBuilder: false,
    maxDamage: 120,
    footprintX: 2,
    footprintZ: 2,
    costMetal: 20,
    costEnergy: 20,
    buildTime: 60,
    objectName: name,
    econ: {
      buildTime: 60,
      buildCostMetal: 20,
      buildCostEnergy: 20,
      energyStorage: 0,
      metalStorage: 0,
    },
    weapons: [{ name: '' }, { name: '' }, { name: '' }],
  }
}

// A mobile ARM construction kbot meta carrying its real armck.cob so the studio
// build handshake (StartBuilding / the arm's RequestState machine) runs exactly
// as it does in-browser. cob is the raw COB byte array, the same field the
// studio's /api/studio/unit attaches.
function builderMeta(cob) {
  return {
    name: 'armck',
    canMove: true,
    isBuilder: true,
    maxVelocity: 1.5,
    turnRate: 1200,
    acceleration: 0.1,
    brakeRate: 0.2,
    maxDamage: 240,
    footprintX: 2,
    footprintZ: 2,
    workerTime: 300,
    buildDistance: 80,
    objectName: 'armck',
    econ: { workerTime: 300, econWorkerTime: 300, workerTimeF: 300 },
    weapons: [{ name: '' }, { name: '' }, { name: '' }],
    cob,
  }
}

// Two structures built in a row by one mobile construction kbot must BOTH
// complete. This is the exact studio symptom the sequential-build parity bug
// produced: the arm's INBUILDSTANCE latch stranded on alternate jobs, leaving
// every other structure frozen at 0% as a permanent nanoframe. Requires the
// flattened TA install (TA_UNPACKED_PATH) for the real armck.cob; skipped when
// it is absent so the smoke still runs in a bare CI checkout.
test('one construction kbot builds two structures in a row, both complete', async () => {
  const taRoot = globalThis.process?.env?.TA_UNPACKED_PATH
  const cobPath = taRoot ? path.join(taRoot, 'scripts', 'armck.cob') : null
  if (!cobPath || !existsSync(cobPath)) {
    console.log('skipping sequential-build smoke: TA_UNPACKED_PATH/scripts/armck.cob not found')
    return
  }
  const cob = new Uint8Array(await readFile(cobPath))

  const { api, state } = await loadEngine()
  // The spawn resolver backs the queued Build orders' buildees (script-less
  // structures), keyed by the name the build order carries.
  const resolver = (name) => structureMeta(name)
  const handle = api.create(2, 0, resolver, ECON_TA)

  const builder = api.addUnit(handle, builderMeta(cob), 0, 0, 0, 1)
  assert.ok(builder > 0, 'construction kbot failed to spawn')

  // Queue two structures at spaced sites so the builder walks between them and
  // the StartBuilding/StopBuilding cycle fully turns over per job.
  api.submitBuild(handle, builder, 'smoke_solar_a', 160, 0, true)
  api.submitBuild(handle, builder, 'smoke_solar_b', 320, 0, true)

  const complete = new Set()
  for (let t = 0; t < 40 * 60; t++) {
    const snap = api.step(handle)
    assert.ok(snap && Array.isArray(snap.units), `step ${t} returned no snapshot`)
    assert.ok(!state.crashed, `wasm engine exited during step ${t}`)
    for (const u of snap.units) {
      if (u.id !== builder && u.buildPercent >= 100) complete.add(u.id)
    }
    if (complete.size >= 2) break
  }
  api.destroy(handle)
  assert.equal(complete.size, 2, 'both queued structures must reach 100% (sequential-build parity)')
})
