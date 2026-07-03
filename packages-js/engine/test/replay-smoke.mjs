// Replay-surface smoke test for the packaged engine: stepTo() and
// setUnitState() are callable through the public loader, seek to the exact
// tick, pin a unit to an injected pose, and stay deterministic across
// sessions. Runs under plain Node (`node test/replay-smoke.mjs`); builds the
// wasm payload first if it is missing.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (!existsSync(path.join(pkgDir, 'wasm', 'engine.wasm'))) {
  execFileSync('node', [path.join(pkgDir, 'scripts', 'build-wasm.mjs')], { stdio: 'inherit' })
}

const { loadEngine } = await import('../index.js')
const engine = await loadEngine()

const meta = {
  name: 'probe',
  canMove: true,
  maxVelocity: 1.5,
  acceleration: 0.5,
  brakeRate: 1,
  turnRate: 800,
  maxDamage: 100,
}

// A fixed script drives two sessions to prove stepTo lands identically.
function runScript() {
  const session = engine.createSession({ seed: 42 })
  const id = session.addUnit(meta, 100, 100, 0, 1)
  session.submitMove([id], 100, 400)
  const snap = session.stepTo(120)
  return { session, id, snap }
}

const a = runScript()
const b = runScript()
assert.equal(a.snap.tick, 120, `stepTo(120) landed on tick ${a.snap.tick}`)
assert.equal(a.session.tick(), 120)
assert.equal(a.session.hash(), b.session.hash(), 'stepTo is not deterministic across sessions')
b.session.destroy()

const { session, id } = a
const moved = a.snap.units.find((u) => u.id === id)
assert.ok(moved && Math.hypot(moved.x - 100, moved.z - 100) > 10, 'unit did not move under stepTo')

// Backwards targets are a no-op: the world stays at its current tick.
const back = session.stepTo(60)
assert.equal(back.tick, 120, `stepTo(60) rewound to tick ${back.tick}`)

// Clear the standing move order so the coast check below measures the pinned
// velocity, not the move order re-accelerating the unit toward its target.
session.submitStop([id])
session.stepTo(session.tick() + 1)

// Authoritative override: the injected pose lands exactly (to fixed-point
// float precision) in the next render state without stepping.
const pin = { pos: { x: 250, y: 0, z: 300 }, heading: Math.PI / 2, vel: 1.2, hp: 80, build: 100 }
assert.equal(session.setUnitState(id, pin), true, 'setUnitState failed for a live unit')
assert.equal(session.setUnitState(999999, pin), false, 'setUnitState accepted a missing unit')

const pinned = session.renderState().units.find((u) => u.id === id)
assert.ok(pinned, 'unit missing after setUnitState')
assert.ok(Math.abs(pinned.x - 250) < 1e-4 && Math.abs(pinned.z - 300) < 1e-4, `pos not applied: ${pinned.x},${pinned.z}`)
assert.ok(Math.abs(pinned.headingRad - Math.PI / 2) < 1e-3, `heading not applied: ${pinned.headingRad}`)
assert.ok(Math.abs(pinned.speed - 1.2) < 1e-4, `vel not applied: ${pinned.speed}`)
assert.ok(Math.abs(pinned.health - 80) < 1e-4, `hp not applied: ${pinned.health}`)

// With no orders, further ticks keep the unit within vel·dt of the pin
// (the sim runs at 40 Hz, so dt = 25ms per tick).
const n = 20
const after = session.stepTo(session.tick() + n).units.find((u) => u.id === id)
const drift = Math.hypot(after.x - 250, after.z - 300)
assert.ok(drift <= (pin.vel * n) / 40 + 1e-3, `unit drifted ${drift} WU from the injected pose`)

// Motion pin: `moving: true` latches IsMoving with no order (the walk-cycle
// driver), coasts along the heading at the pinned vel, and `moving: false`
// releases it. The unit has no COB here, so this asserts the sim-side flag
// and coast only; the script transitions are covered by the Go sim tests.
// Heading follows the game convention: 0 faces -Z (north), so the coast
// DECREASES z — a raw recorded heading drives the sim with no offset.
session.setUnitState(id, { pos: { x: 400, y: 0, z: 400 }, heading: 0, vel: 2, moving: true })
const pinnedMoving = session.stepTo(session.tick() + 10).units.find((u) => u.id === id)
assert.equal(pinnedMoving.isMoving, true, 'motion pin did not latch isMoving')
assert.ok(
  Math.abs(pinnedMoving.z - (400 - (2 * 10) / 40)) < 1e-3,
  `pinned unit did not coast along heading (0 = north / -Z): z=${pinnedMoving.z}`,
)
session.setUnitState(id, { moving: false })
const pinnedStopped = session.stepTo(session.tick() + 2).units.find((u) => u.id === id)
assert.equal(pinnedStopped.isMoving, false, 'motion pin did not release')
assert.equal(pinnedStopped.speed, 0, 'pinned-stopped unit kept speed')

// Script surface: a script-less unit lists no entry points and plays no
// weapon fire (drivers fall back to tracers); the calls must not throw.
assert.deepEqual(session.scriptNames(id), [], 'script-less unit listed COB entry points')
assert.equal(session.playWeaponFire(id, 0, 500, 0, 500), false, 'script-less unit claimed weapon-fire playback')
session.startScript(id, 'Create')
session.restartScript(id, 'Create')
session.killThreadsByName(id, 'Create')

// Packed-snapshot parity: renderStatePacked() must reproduce renderState()'s
// unit fields (f32 rounding allowed) — the replay driver's fast path.
{
  const classic = session.renderState()
  const packed = session.renderStatePacked()
  assert.equal(packed.tick, classic.tick, 'packed tick differs')
  assert.equal(packed.units.length, classic.units.length, 'packed unit count differs')
  const close = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-3, `packed ${what}: ${a} vs ${b}`)
  for (let i = 0; i < classic.units.length; i++) {
    const c = classic.units[i], p = packed.units[i]
    assert.equal(p.id, c.id)
    assert.equal(p.name, c.name)
    assert.equal(p.side, c.side)
    assert.equal(p.dead, c.dead)
    assert.equal(p.isMoving, c.isMoving)
    close(p.x, c.x, 'x'); close(p.y, c.y, 'y'); close(p.z, c.z, 'z')
    close(p.headingRad, c.headingRad, 'headingRad')
    close(p.health, c.health, 'health')
    close(p.buildPercent, c.buildPercent, 'buildPercent')
    const cp = c.piecesPacked, pp = p.piecesPacked
    if (cp == null) {
      assert.equal(pp, null, 'packed pieces where classic has none')
    } else {
      const cf = new Float32Array(cp.buffer, cp.byteOffset, cp.byteLength >> 2)
      assert.equal(pp.length, cf.length, 'piece float count differs')
      for (let j = 0; j < cf.length; j++) close(pp[j], cf[j], `piece[${j}]`)
    }
  }
  // stepPacked advances the sim exactly like step().
  const before = session.tick()
  const s1 = session.stepPacked()
  assert.equal(s1.tick, before + 1, 'stepPacked did not advance one tick')
}

console.log(`OK: stepTo+setUnitState+motionPin+packedParity verified; world hash ${session.hash()} at tick ${session.tick()}`)
session.destroy()
// The parked wasm runtime keeps the event loop alive; exit explicitly.
process.exit(0)
