// cob-pose.js — the ONE place the engine↔renderer pose conventions live.
//
// Total Annihilation's conventions, which this renderer reproduces exactly:
//
//   World axes    +X = east, +Y = up, +Z = south (map row/pixel Y grows
//                 southward and is rendered as +Z, so a map reads the same
//                 as its minimap).
//
//   Heading       uint16 binary angle, 65536 per full turn (TA_FULL_CIRCLE).
//                 Heading 0 faces NORTH (−Z, decreasing z); a unit at
//                 heading h moves along (−sin, −cos) of h·TA_ANGLE_TO_RAD,
//                 so 0x4000 faces WEST (−X), 0x8000 SOUTH (+Z), 0xC000
//                 EAST (+X).
//
//   Models        3DO geometry rests nose toward −Z after loading, so
//                 Mat4.rotateY(headingToRadians(h)) points the nose along
//                 the movement direction — a raw game/wire heading feeds
//                 the transform with NO offset and NO sign fix-up.
//
//   Piece axes    COB TURN/SPIN/MOVE axis 0 = X (pitch: positive script
//                 angles tip the nose DOWN), 1 = Y (yaw: positive turns the
//                 same way as an increasing heading), 2 = Z (roll). Angles
//                 are TA angle units; MOVE offsets are world units (the
//                 engine divides COB's 16.16 fixed-point linears out).
//
// Everything the engine hands across the wasm boundary — snapshot unit
// `heading`/`headingRad`, projectile `heading`, the packed piece transforms —
// already speaks these conventions, so a driver (studio sandbox, replayer,
// lobby) converts NOTHING: feed wire headings through headingToRadians and
// packed pieces through applyPackedPieces / enginePieceToPose.

/** TA's angular unit: one full turn. */
export const TA_FULL_CIRCLE = 65536

/** TA angle units → radians (2π / 65536). */
export const TA_ANGLE_TO_RAD = (2 * Math.PI) / TA_FULL_CIRCLE

/**
 * headingToRadians converts a raw TA heading (uint16 binary angle, wire or
 * engine snapshot form) into the radians game3d's unit transforms take
 * (`transform.headingRad`, `applyState` unit `heading`, `addUnit` heading).
 *
 * The convention (proven against the original engine and real recordings):
 * heading 0 faces −Z (north); increasing headings turn north → west →
 * south → east. The renderer applies the result as Mat4.rotateY and models
 * rest nose-toward−Z, so a unit at wire heading h renders nose-first along
 * its (−sin h, −cos h) movement direction.
 *
 * @param {number} taHeading  TA angle units; any integer, wraps mod 65536.
 * @returns {number} radians in [0, 2π)
 */
export function headingToRadians(taHeading) {
  const wrapped = ((taHeading % TA_FULL_CIRCLE) + TA_FULL_CIRCLE) % TA_FULL_CIRCLE
  return wrapped * TA_ANGLE_TO_RAD
}

/**
 * enginePieceToPose maps one piece's engine-side COB transform onto the
 * renderer's piece channels (Piece.move / Piece.rotate, see piece.js).
 *
 * The engine reports MOVE offsets in world units on COB axes and TURN/SPIN
 * rotations in TA angle units. The renderer's piece-local frame differs from
 * the COB frame by the model loader's X-flip (3DO's authoring orientation →
 * GL), which conjugates the transforms: the Z offset and the X rotation
 * change sign, everything else passes through. These signs are fixed by TA's
 * transform pipeline — change them and turrets slew away from their targets
 * and walk cycles detach at the hips.
 *
 * @param {number} ox  MOVE offset, COB x axis (world units)
 * @param {number} oy  MOVE offset, COB y axis
 * @param {number} oz  MOVE offset, COB z axis
 * @param {number} rx  TURN/SPIN angle, COB x axis (TA angle units)
 * @param {number} ry  COB y axis
 * @param {number} rz  COB z axis
 * @returns {{move: [number,number,number], rotate: [number,number,number]}}
 *   move in world units, rotate in radians, both in renderer piece channels.
 */
export function enginePieceToPose(ox, oy, oz, rx, ry, rz) {
  return {
    move: [ox, oy, -oz],
    rotate: [-rx * TA_ANGLE_TO_RAD, ry * TA_ANGLE_TO_RAD, rz * TA_ANGLE_TO_RAD],
  }
}

/**
 * unpackEnginePieces decodes an engine snapshot's packed piece transforms
 * (`piecesPacked`: Float32 stride-7 — ox, oy, oz world-unit offsets, rx, ry,
 * rz TA-angle rotations, visible flag — indexed by COB PIECE TABLE order)
 * into renderer piece states via enginePieceToPose.
 *
 * The index order is the COB script's piece table, which is NOT the model's
 * flat DFS order (the Samson's COB lists its flares before its base), so the
 * result must be applied to pieces BY NAME — pair it with the unit type's
 * COB piece-name table (engine `unitPieceNames`, or a pack's cob JSON).
 *
 * @param {Uint8Array|Float32Array|null|undefined} packed
 * @returns {Array<{move:[number,number,number], rotate:[number,number,number], visible: boolean}>|null}
 */
export function unpackEnginePieces(packed) {
  if (!packed || !packed.byteLength) return null
  const f = packed instanceof Float32Array
    ? packed
    : new Float32Array(packed.buffer, packed.byteOffset, packed.byteLength >> 2)
  const n = (f.length / 7) | 0
  const out = new Array(n)
  for (let i = 0; i < n; i++) {
    const o = i * 7
    const pose = enginePieceToPose(f[o], f[o + 1], f[o + 2], f[o + 3], f[o + 4], f[o + 5])
    out[i] = { move: pose.move, rotate: pose.rotate, visible: f[o + 6] !== 0 }
  }
  return out
}

/**
 * lerpPackedPieces interpolates between two engine packed piece buffers
 * (stride-7 Float32: ox, oy, oz world-unit offsets, rx, ry, rz TA-angle
 * rotations, visible flag) by alpha ∈ [0, 1] — the tool a replay driver
 * uses to sample COB piece poses BETWEEN engine ticks so walk gaits and
 * turret slews render smoothly at any output frame rate.
 *
 * Offsets lerp linearly.  Rotations take the wrap-aware SHORTEST ARC in
 * TA-angle space (65536 per turn), so a spinning radar crossing the wrap
 * seam eases straight through it instead of whipping the long way round.
 * Visibility is a hard switch from the `next` buffer (hide/show is an
 * instant script action, not a fade).
 *
 * The result feeds applyState's `piecesPacked` unchanged; positions and
 * headings interpolated the same way (linear + shortest-arc) pair with it
 * — applyState renders externally-lerped values as-is.
 *
 * Buffer-length mismatches (a piece table swap mid-seek) fall back to the
 * `next` buffer so the caller never renders a half-blended wrong table.
 *
 * @param {Uint8Array|Float32Array|null|undefined} prevPacked
 * @param {Uint8Array|Float32Array|null|undefined} nextPacked
 * @param {number} alpha  Blend fraction, clamped to [0, 1].
 * @param {Float32Array} [out]  Optional destination (avoids allocation
 *   when its length matches); a fresh Float32Array otherwise.
 * @returns {Float32Array|null}  Stride-7 blended buffer, or null when
 *   nextPacked is empty.
 */
export function lerpPackedPieces(prevPacked, nextPacked, alpha, out = null) {
  const next = _packedFloats(nextPacked)
  if (!next) return null
  const prev = _packedFloats(prevPacked)
  if (!prev || prev.length !== next.length) {
    const copy = out && out.length === next.length ? out : new Float32Array(next.length)
    copy.set(next)
    return copy
  }
  let a = +alpha
  if (!(a >= 0)) a = 0
  else if (a > 1) a = 1
  const dst = out && out.length === next.length ? out : new Float32Array(next.length)
  const n = (next.length / 7) | 0
  const HALF = TA_FULL_CIRCLE / 2
  for (let i = 0; i < n; i++) {
    const o = i * 7
    dst[o] = prev[o] + (next[o] - prev[o]) * a
    dst[o + 1] = prev[o + 1] + (next[o + 1] - prev[o + 1]) * a
    dst[o + 2] = prev[o + 2] + (next[o + 2] - prev[o + 2]) * a
    for (let c = 3; c <= 5; c++) {
      let d = (next[o + c] - prev[o + c]) % TA_FULL_CIRCLE
      if (d > HALF) d -= TA_FULL_CIRCLE
      else if (d < -HALF) d += TA_FULL_CIRCLE
      dst[o + c] = prev[o + c] + d * a
    }
    dst[o + 6] = next[o + 6]
  }
  return dst
}

// _packedFloats views a packed piece buffer as Float32 (shared with
// unpackEnginePieces' input handling).
function _packedFloats(packed) {
  if (!packed || !packed.byteLength) return null
  return packed instanceof Float32Array
    ? packed
    : new Float32Array(packed.buffer, packed.byteOffset, packed.byteLength >> 2)
}

/**
 * applyPackedPieces poses one model instance from an engine snapshot's
 * packed piece transforms, addressing pieces BY NAME through the unit type's
 * COB piece table (hide/show and animation land on the piece the script
 * meant, regardless of the model's own hierarchy order).
 *
 * @param {import('./model.js').Model} model  A per-unit model clone.
 * @param {string[]} pieceNames  COB piece table, index-aligned with packed.
 * @param {Uint8Array|Float32Array} packed  Engine stride-7 piece buffer.
 * @param {Map<string, Object>} [cache]  Optional name→Piece lookup cache the
 *   caller keeps per model clone to skip the findPiece walk per frame.
 */
export function applyPackedPieces(model, pieceNames, packed, cache = null) {
  const poses = unpackEnginePieces(packed)
  if (!poses || !model || !Array.isArray(pieceNames)) return
  const n = Math.min(poses.length, pieceNames.length)
  for (let i = 0; i < n; i++) {
    const name = pieceNames[i]
    if (!name) continue
    let piece
    if (cache) {
      piece = cache.get(name)
      if (piece === undefined) {
        piece = model.findPiece ? model.findPiece(name) : model.root.findByName(name)
        cache.set(name, piece || null)
      }
    } else {
      piece = model.findPiece ? model.findPiece(name) : model.root.findByName(name)
    }
    if (!piece) continue
    const p = poses[i]
    piece.move[0] = p.move[0]
    piece.move[1] = p.move[1]
    piece.move[2] = p.move[2]
    piece.rotate[0] = p.rotate[0]
    piece.rotate[1] = p.rotate[1]
    piece.rotate[2] = p.rotate[2]
    piece.visible = p.visible
  }
}
