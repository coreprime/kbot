// cob-pose.test.js — headless proofs of the engine↔renderer pose contract
// (cob-pose.js): the heading convention, the COB piece-transform conversion
// signs, and by-name packed-piece application. Pure math over Piece/Mat4 —
// no WebGL, runs under plain `node --test`.

import test from 'node:test'
import assert from 'node:assert/strict'

import { Mat4 } from '../mat4.js'
import { Piece } from '../piece.js'
import { Model } from '../model.js'
import {
  TA_ANGLE_TO_RAD,
  headingToRadians,
  enginePieceToPose,
  applyPackedPieces,
} from '../cob-pose.js'

const EPS = 1e-6

// transformDir applies a world matrix's rotation to a direction vector.
function transformDir(m, v) {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
  ]
}

function assertVecClose(got, want, msg) {
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(got[i] - want[i]) < 1e-4, `${msg}: got [${got}], want [${want}]`)
  }
}

// unitMatrix builds the renderer's unit transform for a raw TA heading —
// exactly what createWorld/applyState do with transform.headingRad.
function unitMatrix(taHeading) {
  const m = Mat4.identity(Mat4.create())
  Mat4.rotateY(m, m, headingToRadians(taHeading))
  return m
}

// Loaded models rest nose toward -Z (model-loader's orientation for 3DO
// unit geometry).
const NOSE = [0, 0, -1]

test('heading 0 faces -Z (north) and the compass walks N→W→S→E', () => {
  assertVecClose(transformDir(unitMatrix(0), NOSE), [0, 0, -1], 'heading 0')
  assertVecClose(transformDir(unitMatrix(0x4000), NOSE), [-1, 0, 0], 'heading 0x4000 (west)')
  assertVecClose(transformDir(unitMatrix(0x8000), NOSE), [0, 0, 1], 'heading 0x8000 (south)')
  assertVecClose(transformDir(unitMatrix(0xC000), NOSE), [1, 0, 0], 'heading 0xC000 (east)')
})

test('a unit at heading h faces its movement direction (-sin h, -cos h)', () => {
  for (const h of [0, 1000, 12345, 30000, 47000, 65000]) {
    const rad = h * TA_ANGLE_TO_RAD
    assertVecClose(
      transformDir(unitMatrix(h), NOSE),
      [-Math.sin(rad), 0, -Math.cos(rad)],
      `heading ${h}`,
    )
  }
})

test('headingToRadians wraps negatives and overflow into [0, 2π)', () => {
  assert.ok(Math.abs(headingToRadians(-16384) - headingToRadians(49152)) < EPS)
  assert.ok(Math.abs(headingToRadians(65536) - 0) < EPS)
  assert.ok(headingToRadians(65535) < 2 * Math.PI)
})

// buildTorsoRig assembles a minimal unit: a base piece with a torso child
// whose muzzle points along the rest nose direction, mirroring how a
// turreted unit's aim chain composes.
function buildTorsoRig() {
  const base = new Piece({ name: 'base' })
  const torso = new Piece({ name: 'torso', originY: 10 })
  const muzzle = new Piece({ name: 'muzzle', originZ: -5 })
  base.addChild(torso)
  torso.addChild(muzzle)
  return { base, torso, muzzle }
}

function computeRig(rig, taHeading) {
  const scratch = Mat4.create()
  const unit = unitMatrix(taHeading)
  rig.base.computeWorldMatrix(unit, scratch)
  rig.torso.computeWorldMatrix(rig.base.worldMatrix, scratch)
  rig.muzzle.computeWorldMatrix(rig.torso.worldMatrix, scratch)
}

test('a COB y-axis TURN slews the torso about the vertical axis toward the bearing', () => {
  const rig = buildTorsoRig()
  const h = 12000
  const bearing = 16384 // aim a quarter turn to the side, as AimPrimary would
  const pose = enginePieceToPose(0, 0, 0, 0, bearing, 0)
  rig.torso.rotate = pose.rotate
  computeRig(rig, h)

  // The muzzle must point at the world bearing: total facing h + bearing in
  // TA's (-sin, -cos) parameterization. A sign or axis slip here is the
  // "commander pitches instead of yawing" bug.
  const want = (h + bearing) * TA_ANGLE_TO_RAD
  assertVecClose(
    transformDir(rig.muzzle.worldMatrix, NOSE),
    [-Math.sin(want), 0, -Math.cos(want)],
    'muzzle facing',
  )
  // And the muzzle stays level: no pitch component from a pure yaw.
  const dir = transformDir(rig.muzzle.worldMatrix, NOSE)
  assert.ok(Math.abs(dir[1]) < 1e-4, 'yaw must not pitch the muzzle')
})

test('a COB x-axis TURN by -pitch raises the muzzle (nose-up)', () => {
  const rig = buildTorsoRig()
  const pitch = 4096
  // TA scripts elevate barrels by turning to x-axis (0 - pitch): positive
  // x rotation is nose-DOWN in the game convention.
  const pose = enginePieceToPose(0, 0, 0, -pitch, 0, 0)
  rig.torso.rotate = pose.rotate
  computeRig(rig, 0)
  const dir = transformDir(rig.muzzle.worldMatrix, NOSE)
  assert.ok(dir[1] > 0.05, `muzzle should rise, got y=${dir[1]}`)
  const rad = pitch * TA_ANGLE_TO_RAD
  assertVecClose(dir, [0, Math.sin(rad), -Math.cos(rad)], 'elevated muzzle')
})

test('a COB MOVE along +z carries the piece forward (north at heading 0)', () => {
  const rig = buildTorsoRig()
  // COB axis 2 (z) positive = the unit's facing direction.
  const pose = enginePieceToPose(0, 0, 2, 0, 0, 0)
  rig.torso.move = pose.move
  computeRig(rig, 0)
  const m = rig.torso.worldMatrix
  assertVecClose([m[12], m[13], m[14]], [0, 10, -2], 'torso world position')
})

// packPieces builds an engine-shaped stride-7 Float32 buffer.
function packPieces(entries) {
  const f = new Float32Array(entries.length * 7)
  entries.forEach((e, i) => {
    f.set([e.ox || 0, e.oy || 0, e.oz || 0, e.rx || 0, e.ry || 0, e.rz || 0, e.visible ? 1 : 0], i * 7)
  })
  return new Uint8Array(f.buffer)
}

test('applyPackedPieces addresses pieces by COB name, not hierarchy index', () => {
  // The Samson layout: model hierarchy base→turret→launcher→flares, but the
  // COB piece table lists the flares FIRST. Hiding COB index 0 must hide
  // flare1 — never the base, which is what index-blind application does.
  const base = new Piece({ name: 'base' })
  const turret = new Piece({ name: 'turret' })
  const launcher = new Piece({ name: 'launcher' })
  const flare1 = new Piece({ name: 'flare1' })
  const flare2 = new Piece({ name: 'flare2' })
  base.addChild(turret)
  turret.addChild(launcher)
  launcher.addChild(flare1)
  launcher.addChild(flare2)
  const model = new Model({ name: 'armsam', root: base })

  const cobNames = ['flare1', 'flare2', 'base', 'launcher', 'turret']
  const packed = packPieces([
    { visible: false },              // flare1 hidden
    { visible: false },              // flare2 hidden
    { visible: true },               // base
    { visible: true, ry: 8000 },     // launcher turning
    { visible: true },               // turret
  ])
  applyPackedPieces(model, cobNames, packed)

  assert.equal(base.visible, true, 'base must stay visible')
  assert.equal(turret.visible, true, 'turret must stay visible')
  assert.equal(flare1.visible, false, 'flare1 must be hidden')
  assert.equal(flare2.visible, false, 'flare2 must be hidden')
  assert.ok(Math.abs(launcher.rotate[1] - 8000 * TA_ANGLE_TO_RAD) < EPS, 'launcher yaw lands on the launcher')
  assert.equal(base.rotate[1], 0, 'base must not inherit the launcher turn')
})
