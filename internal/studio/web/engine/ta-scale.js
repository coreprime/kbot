// ta-scale.js
// TA's fixed-point scales for angles and distances, shared by the studio
// views that turn COB / 3DO values into degrees, radians and world units.
//
// The browser keeps no COB opcode table: scripts run in the kbot-engine
// wasm build, and the studio's debugger shows the names kbot-io's
// disassembler serves (/api/studio/cob/...). kbot-io's
// scripting.Opcodes() is the one catalogue of what each word does.

// Angles: 65536 units per full turn (COB turn/spin operands, 3DO angles).
export const TA_TURNS_PER_CIRCLE = 65536
// Distances: 65536 units per world unit (COB move operands, 3DO offsets).
export const TA_LINEAR_SCALE = 65536

// angleToRadians converts a TA angle (1/65536 of a full turn) to radians.
export function angleToRadians(taAngle) {
  return (taAngle / TA_TURNS_PER_CIRCLE) * Math.PI * 2
}

// linearToWorld converts a TA fixed-point distance (65536 per world unit)
// to world units.
export function linearToWorld(taLinear) {
  return taLinear / TA_LINEAR_SCALE
}
