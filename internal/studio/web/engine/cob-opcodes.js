// cob-opcodes.js
// One-source-of-truth for the COB opcode constants the runtime
// switches on.  The numeric values match the Go-side `formats/scripting`
// definitions (TA + TAK).  Kept as plain `export const` so the runtime
// reads as a flat switch without lookups, and so future tooling
// (visual debugger, COB editor) can re-use the same names.

// Animation / piece manipulation
export const OP_MOVE         = 0x10001000
export const OP_TURN         = 0x10002000
export const OP_SPIN         = 0x10003000
export const OP_STOP_SPIN    = 0x10004000
export const OP_SHOW         = 0x10005000
export const OP_HIDE         = 0x10006000
export const OP_CACHE        = 0x10007000
export const OP_DONT_CACHE   = 0x10008000
export const OP_DONT_SHADOW  = 0x1000A000
export const OP_MOVE_NOW     = 0x1000B000
export const OP_TURN_NOW     = 0x1000C000
export const OP_SHADE        = 0x1000D000
export const OP_DONT_SHADE   = 0x1000E000
export const OP_EMIT_SFX     = 0x1000F000

// Wait operations
export const OP_WAIT_FOR_TURN = 0x10011000
export const OP_WAIT_FOR_MOVE = 0x10012000
export const OP_SLEEP         = 0x10013000

// Stack
export const OP_PUSH_IMMEDIATE = 0x10021000
export const OP_PUSH_CONSTANT  = 0x10021001
export const OP_PUSH_LOCAL_VAR = 0x10021002
export const OP_PUSH_STATIC    = 0x10021004
export const OP_CREATE_LOCAL   = 0x10021008
export const OP_STACK_ALLOC    = 0x10022000
export const OP_POP_LOCAL_VAR  = 0x10023002
export const OP_POP_STATIC     = 0x10023004
export const OP_POP_STACK      = 0x10024000

// Arithmetic
export const OP_ADD = 0x10031000
export const OP_SUB = 0x10032000
export const OP_MUL = 0x10033000
export const OP_DIV = 0x10034000
export const OP_MOD = 0x10037000

// Bitwise
export const OP_BITWISE_AND = 0x10035000
export const OP_BITWISE_OR  = 0x10036000
export const OP_BITWISE_XOR = 0x10038000
export const OP_BITWISE_NOT = 0x1003A000

// Special functions
export const OP_RAND           = 0x10041000
export const OP_GET_UNIT_VALUE = 0x10042000
export const OP_GET            = 0x10043000

// Comparison
export const OP_LESS_THAN     = 0x10051000
export const OP_LESS_OR_EQUAL = 0x10052000
export const OP_GREATER_THAN  = 0x10053000
export const OP_GREATER_EQUAL = 0x10054000
export const OP_EQUAL         = 0x10055000
export const OP_NOT_EQUAL     = 0x10056000

// Logical
export const OP_LOGICAL_AND = 0x10057000
export const OP_LOGICAL_OR  = 0x10058000
export const OP_LOGICAL_XOR = 0x10059000
export const OP_LOGICAL_NOT = 0x1005A000

// Control flow
export const OP_START_SCRIPT    = 0x10061000
export const OP_CALL_SCRIPT     = 0x10062000
export const OP_JUMP            = 0x10064000
export const OP_RETURN          = 0x10065000
export const OP_JUMP_IF_FALSE   = 0x10066000
export const OP_SIGNAL          = 0x10067000
export const OP_SET_SIGNAL_MASK = 0x10068000

// Effects
export const OP_EXPLODE    = 0x10071000
export const OP_PLAY_SOUND = 0x10072000

// Set / attach
export const OP_SET_VALUE   = 0x10082000
export const OP_ATTACH_UNIT = 0x10083000
export const OP_DROP_UNIT   = 0x10084000

// COB axis IDs - TA stores per-piece animation state by (piece, axis)
// where axis is X=0 / Y=1 / Z=2.  The runtime's piece-animation
// table is keyed by `piece * 3 + axis` so lookups are constant-time.
export const AXIS_X = 0
export const AXIS_Y = 1
export const AXIS_Z = 2

// Unit-value port IDs used by GET_UNIT_VALUE / SET_VALUE.  TA's
// engine exposes a couple of dozen "ports" the script can poll; we
// emulate the ones units actually consult.  Numeric IDs come from
// the canonical bos compiler output.  Anything not in this list
// surfaces as 0 from the runtime's GET handler.
export const UV_ACTIVATION       = 1
export const UV_STANDINGMOVEORDERS = 2
export const UV_STANDINGFIREORDERS = 3
export const UV_HEALTH           = 4
export const UV_INBUILDSTANCE    = 5
export const UV_BUSY             = 6
export const UV_PIECE_XZ         = 7
export const UV_PIECE_Y          = 8
export const UV_UNIT_XZ          = 9
export const UV_UNIT_Y           = 10
export const UV_UNIT_HEIGHT      = 11
export const UV_XZ_ATAN          = 12
export const UV_XZ_HYPOT         = 13
export const UV_ATAN             = 14
export const UV_HYPOT            = 15
export const UV_GROUND_HEIGHT    = 16
export const UV_BUILD_PERCENT_LEFT = 17
export const UV_YARD_OPEN        = 18
export const UV_BUGGER_OFF       = 19
export const UV_ARMORED          = 20

// TA angular constants.  bos angles use the same 65536 = 360° scale
// as the rest of the COB integer math, so all angle-bearing
// operands are scaled by ANGLE_PER_RADIAN when the runtime renders
// them as JS Math.* radians.
export const TA_TURNS_PER_CIRCLE = 65536
export const TA_LINEAR_SCALE     = 65536 // movement / position units (1 wu = 65536)

// TA's game loop runs at a fixed 40 Hz tick (25 ms per tick).  COB
// sleep values are in MILLISECONDS but the engine only resumes a
// sleeping thread on a tick boundary, so a `sleep 200` deterministically
// waits 8 ticks (200 / 25 = 8) = exactly 5 wake-ups per second.
// Quantising our runtime to the same step makes animations and timed
// sequences (turret restore-after-delay, factory door cadence,
// smoke-unit polling) play at the exact pacing TA gameplay shows
// instead of drifting with the browser's render dt.
// Tick rate lives in its own module (engine/tick-rate.js) so external
// callers can import it without dragging the rest of the opcode table.
// Re-exported here for backward compatibility with the many existing
// imports that already pull it from cob-opcodes.
export { TA_TICK_HZ, TA_TICK_MS } from './tick-rate.js'

// Helper - convert a TA fixed-point angle (units of 1/65536 of a
// full turn) into radians for downstream Math.* / matrix code.
export function angleToRadians(taAngle) {
  return (taAngle / TA_TURNS_PER_CIRCLE) * Math.PI * 2
}
// Helper - convert a TA fixed-point linear value (1 wu = 65536) into
// world-units used by the renderer.
export function linearToWorld(taLinear) {
  return taLinear / TA_LINEAR_SCALE
}
