// Headless proof that the published engine package works outside the repo:
// load the wasm engine, create a session, add a mobile unit, order it to
// move, step the sim, and assert the unit actually travelled.

import assert from 'node:assert/strict'
import { loadEngine } from '@coreprime/kbot-engine'

const engine = await loadEngine()
const session = engine.createSession({ seed: 7 })

const meta = {
  name: 'probe',
  canMove: true,
  maxVelocity: 1.5,
  acceleration: 0.5,
  brakeRate: 1,
  turnRate: 800,
  maxDamage: 100,
}

const id = session.addUnit(meta, 100, 100, 0, 1)
assert.ok(id > 0, `addUnit returned ${id}`)

const before = session.renderState().units.find((u) => u.id === id)
assert.ok(before, 'unit missing from initial snapshot')

const execTick = session.submitMove([id], 100, 400)
assert.ok(execTick >= 0, `submitMove returned ${execTick}`)

let snapshot = null
for (let i = 0; i < 300; i++) snapshot = session.step()

const after = snapshot.units.find((u) => u.id === id)
assert.ok(after, 'unit missing from final snapshot')

const travelled = Math.hypot(after.x - before.x, after.z - before.z)
assert.ok(travelled > 10, `unit barely moved: ${travelled.toFixed(3)} WU`)
assert.equal(snapshot.tick, session.tick())

console.log(
  `OK: unit ${id} travelled ${travelled.toFixed(1)} WU ` +
    `(${before.x.toFixed(1)},${before.z.toFixed(1)}) -> (${after.x.toFixed(1)},${after.z.toFixed(1)}) ` +
    `over ${snapshot.tick} ticks; world hash ${session.hash()}`,
)

session.destroy()
// The parked wasm runtime keeps the event loop alive; exit explicitly.
process.exit(0)
