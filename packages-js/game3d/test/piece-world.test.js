// piece-world.test.js — Model.resolvePieceWorld through the full entity
// transform chain (translate · rotateY(heading) · rotateX(pitch) ·
// rotateZ(roll) · scale), the math world.unitPieceWorldPos rides for weapon
// muzzle / nanolathe / build-pad anchors.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Model } from '../model.js'
import { Piece } from '../piece.js'

const EPS = 1e-6
const close = (got, want, msg) => {
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(got[i] - want[i]) < EPS, `${msg}: got [${got}], want [${want}]`)
  }
}

// A base at the origin carrying a turret 10 up, whose muzzle sits 6
// forward of the turret pivot (piece origins are parent-relative).
function turretModel() {
  const base = new Piece({ name: 'base' })
  const turret = new Piece({ name: 'turret', originX: 0, originY: 10, originZ: 0 })
  const muzzle = new Piece({ name: 'muzzle', originX: 0, originY: 0, originZ: 6 })
  base.addChild(turret)
  turret.addChild(muzzle)
  return new Model({ name: 't', root: base, bounds: { min: [-8, 0, -8], max: [8, 14, 8] } })
}

test('piece world position follows unit translation and heading', () => {
  const m = turretModel()
  const muzzle = m.findPiece('muzzle')

  // At rest the muzzle is origin + [0, 10, 6].
  close(m.resolvePieceWorld(muzzle, 100, 20, -50, 0), [100, 30, -44], 'rest pose')

  // Yaw a quarter turn: rotateY(π/2) maps +Z onto +X (column-major GL
  // convention: x' = x·cos + z·sin, z' = −x·sin + z·cos).
  close(m.resolvePieceWorld(muzzle, 100, 20, -50, Math.PI / 2), [106, 30, -50], 'yawed pose')
})

test('piece world position includes the COB piece pose (turret slew)', () => {
  const m = turretModel()
  const turret = m.findPiece('turret')
  const muzzle = m.findPiece('muzzle')

  // Slew the turret a quarter turn about Y: the muzzle's local +Z offset
  // swings onto +X, offset FROM THE UNIT ORIGIN — the proof a queried
  // muzzle lands away from the hull centre.
  turret.rotate[1] = Math.PI / 2
  close(m.resolvePieceWorld(muzzle, 0, 0, 0, 0), [6, 10, 0], 'slewed muzzle')

  // A MOVE offset on the muzzle piece rides on top.
  muzzle.move[1] = 2
  close(m.resolvePieceWorld(muzzle, 0, 0, 0, 0), [6, 12, 0], 'slewed + raised muzzle')
})

test('piece world position applies entity pitch, roll and scale', () => {
  const m = turretModel()
  const muzzle = m.findPiece('muzzle')

  // Pitch π/2 about X: rotateX maps +Z onto −Y and +Y onto +Z (GL
  // column-major: y' = y·cos − z·sin, z' = y·sin + z·cos).
  close(m.resolvePieceWorld(muzzle, 0, 0, 0, 0, Math.PI / 2), [0, -6, 10], 'pitched pose')

  // Roll π/2 about Z: +Y maps onto +X? rotateZ: x' = x·cos − y·sin,
  // y' = x·sin + y·cos → local [0,10,6] → [−10, 0, 6].
  close(m.resolvePieceWorld(muzzle, 0, 0, 0, 0, 0, Math.PI / 2), [-10, 0, 6], 'rolled pose')

  // Uniform scale halves every offset about the entity origin.
  close(m.resolvePieceWorld(muzzle, 10, 0, 0, 0, 0, 0, 0.5), [10, 5, 3], 'scaled pose')
})
