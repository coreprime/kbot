package scripting

import "fmt"

// Total Annihilation COB opcode definitions.
// Opcodes are 32-bit little-endian values.

const (
	// Animation commands - object manipulation
	OP_MOVE           = 0x10001000 // Move object (speed & distance from stack, then piece#, axis#)
	OP_TURN           = 0x10002000 // Turn object (speed & direction from stack, then piece#, axis#)
	OP_SPIN           = 0x10003000 // Spin object (speed from stack, then piece#, axis#)
	OP_STOP_SPIN      = 0x10004000 // Stop spin (piece#, axis# after)
	OP_SHOW           = 0x10005000 // Show object (piece# after)
	OP_HIDE           = 0x10006000 // Hide object (piece# after)
	OP_CACHE          = 0x10007000 // Cache object (piece# after)
	OP_DONT_CACHE     = 0x10008000 // Don't cache (piece# after)
	OP_TURN_NOW       = 0x1000C000 // Turn immediately (piece#, axis#, angle after)
	OP_MOVE_NOW       = 0x1000B000 // Move immediately (piece#, axis#, position after)
	OP_SHADE          = 0x1000D000 // Shade object (piece# after)
	OP_DONT_SHADE     = 0x1000E000 // Don't shade (piece# after)
	OP_EMIT_SFX       = 0x1000F000 // Emit SFX (type from stack, then piece#)
	
	// Wait operations
	OP_WAIT_FOR_TURN  = 0x10011000 // Wait for turn (piece#, axis# after)
	OP_WAIT_FOR_MOVE  = 0x10012000 // Wait for move (piece#, axis# after)
	OP_SLEEP          = 0x10013000 // Sleep (time from stack)

	// Stack operations
	OP_PUSH_CONSTANT  = 0x10021001 // Push constant <value>
	OP_PUSH_LOCAL_VAR = 0x10021002 // Push local var <var#>
	OP_PUSH_STATIC    = 0x10021004 // Push static var <var#>
	OP_CREATE_LOCAL   = 0x10021008 // Create local variable
	OP_PUSH_IMMEDIATE = 0x10021000 // Push immediate (value after)
	OP_STACK_ALLOC    = 0x10022000 // Allocate local variable (no param)
	OP_POP_LOCAL_VAR  = 0x10023002 // Pop to local var <var#>
	OP_POP_STATIC     = 0x10023004 // Pop to static var <var#>
	OP_POP_STACK      = 0x10024000 // Pop and discard top of stack

	// Arithmetic operations
	OP_ADD            = 0x10031000 // Add (both from stack)
	OP_SUB            = 0x10032000 // Subtract (both from stack)
	OP_MUL            = 0x10033000 // Multiply (both from stack)
	OP_DIV            = 0x10034000 // Divide (both from stack)
	OP_MOD            = 0x10037000 // Modulo (both from stack)

	// Bitwise operations
	OP_BITWISE_AND    = 0x10035000 // Bitwise AND
	OP_BITWISE_OR     = 0x10036000 // Bitwise OR
	OP_BITWISE_XOR    = 0x10038000 // Bitwise XOR
	OP_BITWISE_NOT    = 0x1003A000 // Bitwise NOT

	// Special functions
	OP_RAND           = 0x10041000 // Random (low & high from stack)
	OP_GET_UNIT_VALUE = 0x10042000 // Get unit value (port# from stack)
	OP_GET            = 0x10043000 // Get value

	// Comparison operations
	OP_LESS_THAN      = 0x10051000 // <  (both from stack)
	OP_LESS_OR_EQUAL  = 0x10052000 // <= (both from stack)
	OP_GREATER_THAN   = 0x10053000 // >  (both from stack)
	OP_GREATER_EQUAL  = 0x10054000 // >= (both from stack)
	OP_EQUAL          = 0x10055000 // == (both from stack)
	OP_NOT_EQUAL      = 0x10056000 // != (both from stack)

	// Logical operations
	OP_LOGICAL_AND    = 0x10057000 // && (both from stack)
	OP_LOGICAL_OR     = 0x10058000 // || (both from stack)
	OP_LOGICAL_XOR    = 0x10059000 // ^^ (both from stack)
	OP_LOGICAL_NOT    = 0x1005A000 // !  (from stack)

	// Control flow
	OP_START_SCRIPT   = 0x10061000 // Start script (params from stack, then script#, param_count)
	OP_CALL_SCRIPT    = 0x10062000 // Call script — actual value found in TA COB files (0x10062000, not 0x10063000 as documented)
	OP_JUMP           = 0x10064000 // Jump <offset>
	OP_RETURN         = 0x10065000 // Return (value from stack)
	OP_JUMP_IF_FALSE  = 0x10066000 // Jump if false (test from stack, <offset>)
	OP_SIGNAL         = 0x10067000 // Signal (signal# from stack)
	OP_SET_SIGNAL_MASK= 0x10068000 // Set signal mask (mask from stack)

	// Special effects
	OP_EXPLODE        = 0x10071000 // Explode (type from stack, then piece#)
	OP_PLAY_SOUND     = 0x10072000 // Play sound (sound# from stack, volume after)

	// Set operations
	OP_SET_VALUE      = 0x10082000 // Set unit value (port# from stack, value from stack)
	OP_ATTACH_UNIT    = 0x10083000 // Attach unit (piece# after)
	OP_DROP_UNIT      = 0x10084000 // Drop unit
)

// OpcodeName returns the mnemonic name for an opcode
func OpcodeName(opcode uint32) string {
	switch opcode {
	// Animation
	case OP_MOVE:
		return "MOVE"
	case OP_TURN:
		return "TURN"
	case OP_SPIN:
		return "SPIN"
	case OP_STOP_SPIN:
		return "STOP_SPIN"
	case OP_SHOW:
		return "SHOW"
	case OP_HIDE:
		return "HIDE"
	case OP_CACHE:
		return "CACHE"
	case OP_DONT_CACHE:
		return "DONT_CACHE"
	case OP_TURN_NOW:
		return "TURN_NOW"
	case OP_MOVE_NOW:
		return "MOVE_NOW"
	case OP_SHADE:
		return "SHADE"
	case OP_DONT_SHADE:
		return "DONT_SHADE"
	case OP_EMIT_SFX:
		return "EMIT_SFX"
	// Wait
	case OP_WAIT_FOR_TURN:
		return "WAIT_FOR_TURN"
	case OP_WAIT_FOR_MOVE:
		return "WAIT_FOR_MOVE"
	case OP_SLEEP:
		return "SLEEP"
	// Stack
	case OP_PUSH_IMMEDIATE:
		return "PUSH_IMM"
	case OP_PUSH_CONSTANT:
		return "PUSH_CONST"
	case OP_PUSH_LOCAL_VAR:
		return "PUSH_LOCAL"
	case OP_PUSH_STATIC:
		return "PUSH_STATIC"
	case OP_CREATE_LOCAL:
		return "CREATE_LOCAL"
	case OP_STACK_ALLOC:
		return "STACK_ALLOC"
	case OP_POP_LOCAL_VAR:
		return "POP_LOCAL"
	case OP_POP_STATIC:
		return "POP_STATIC"
	case OP_POP_STACK:
		return "POP_STACK"
	// Arithmetic
	case OP_ADD:
		return "ADD"
	case OP_SUB:
		return "SUB"
	case OP_MUL:
		return "MUL"
	case OP_DIV:
		return "DIV"
	case OP_MOD:
		return "MOD"
	// Bitwise
	case OP_BITWISE_AND:
		return "BITWISE_AND"
	case OP_BITWISE_OR:
		return "BITWISE_OR"
	case OP_BITWISE_XOR:
		return "BITWISE_XOR"
	case OP_BITWISE_NOT:
		return "BITWISE_NOT"
	// Special
	case OP_RAND:
		return "RAND"
	case OP_GET_UNIT_VALUE:
		return "GET_UNIT_VALUE"
	case OP_GET:
		return "GET"
	// Comparison
	case OP_LESS_THAN:
		return "LESS_THAN"
	case OP_LESS_OR_EQUAL:
		return "LESS_OR_EQUAL"
	case OP_GREATER_THAN:
		return "GREATER_THAN"
	case OP_GREATER_EQUAL:
		return "GREATER_EQUAL"
	case OP_EQUAL:
		return "EQUAL"
	case OP_NOT_EQUAL:
		return "NOT_EQUAL"
	// Logical
	case OP_LOGICAL_AND:
		return "LOGICAL_AND"
	case OP_LOGICAL_OR:
		return "LOGICAL_OR"
	case OP_LOGICAL_XOR:
		return "LOGICAL_XOR"
	case OP_LOGICAL_NOT:
		return "LOGICAL_NOT"
	// Control flow
	case OP_START_SCRIPT:
		return "START_SCRIPT"
	case OP_CALL_SCRIPT:
		return "CALL_SCRIPT"
	case OP_JUMP:
		return "JUMP"
	case OP_RETURN:
		return "RETURN"
	case OP_JUMP_IF_FALSE:
		return "JUMP_IF_FALSE"
	case OP_SIGNAL:
		return "SIGNAL"
	case OP_SET_SIGNAL_MASK:
		return "SET_SIGNAL_MASK"
	// Effects
	case OP_EXPLODE:
		return "EXPLODE"
	case OP_PLAY_SOUND:
		return "PLAY_SOUND"
	// Set operations
	case OP_SET_VALUE:
		return "SET_VALUE"
	case OP_ATTACH_UNIT:
		return "ATTACH_UNIT"
	case OP_DROP_UNIT:
		return "DROP_UNIT"
	default:
		// Try to generate a generic name from opcode structure
		// Format: 0x10CCSSFF where CC=category, SS=subcmd, FF=flags
		category := (opcode >> 16) & 0xFF
		subcmd := (opcode >> 12) & 0xF
		
		switch category {
		case 0x00:
			return fmt.Sprintf("ANIM_%02X", subcmd)
		case 0x02:
			return fmt.Sprintf("STACK_%02X", subcmd)
		case 0x03:
			return fmt.Sprintf("MATH_%02X", subcmd)
		case 0x04:
			return fmt.Sprintf("SPECIAL_%02X", subcmd)
		case 0x05:
			return fmt.Sprintf("COMPARE_%02X", subcmd)
		case 0x06:
			return fmt.Sprintf("CTRL_%02X", subcmd)
		case 0x07:
			return fmt.Sprintf("EFFECT_%02X", subcmd)
		case 0x08:
			return fmt.Sprintf("SET_%02X", subcmd)
		default:
			return fmt.Sprintf("UNKNOWN_0x%08X", opcode)
		}
	}
}

// OpcodeHasInlineParam returns true if the opcode has inline parameters (Post Data)
func OpcodeHasInlineParam(opcode uint32) bool {
	switch opcode {
	// Push/pop with variable/constant parameter
	case OP_PUSH_CONSTANT, OP_PUSH_LOCAL_VAR, OP_PUSH_STATIC,
		OP_POP_LOCAL_VAR, OP_POP_STATIC, OP_PUSH_IMMEDIATE:
		return true
	// Jump with offset parameter
	case OP_JUMP, OP_JUMP_IF_FALSE:
		return true
	// Animation with piece# (and sometimes axis#) parameter
	case OP_MOVE, OP_TURN, OP_SPIN, OP_STOP_SPIN,
		OP_SHOW, OP_HIDE, OP_CACHE, OP_DONT_CACHE, OP_DONT_SHADE,
		OP_EMIT_SFX, OP_EXPLODE, OP_SHADE,
		OP_WAIT_FOR_TURN, OP_WAIT_FOR_MOVE,
		OP_TURN_NOW, OP_MOVE_NOW:
		return true
	// Script calls with script# and param_count
	case OP_START_SCRIPT, OP_CALL_SCRIPT:
		return true
	// Sound with volume parameter
	case OP_PLAY_SOUND:
		return true
	default:
		return false
	}
}

// OpcodeParamCount returns how many DWORDs of parameters follow the opcode
func OpcodeParamCount(opcode uint32) int {
	switch opcode {
	// 1 parameter
	case OP_PUSH_CONSTANT, OP_PUSH_LOCAL_VAR, OP_PUSH_STATIC,
		OP_POP_LOCAL_VAR, OP_POP_STATIC, OP_PUSH_IMMEDIATE,
		OP_JUMP, OP_JUMP_IF_FALSE,
		OP_SHOW, OP_HIDE, OP_CACHE, OP_DONT_CACHE, OP_DONT_SHADE, OP_SHADE,
		OP_EMIT_SFX, OP_EXPLODE, OP_PLAY_SOUND:
		return 1
	// 2 parameters (piece#, axis# for NOW variants OR script#, param_count)
	case OP_WAIT_FOR_TURN, OP_WAIT_FOR_MOVE,
		OP_START_SCRIPT, OP_CALL_SCRIPT,
		OP_TURN_NOW, OP_MOVE_NOW:
		return 2
	// 2 parameters (piece#, axis# as separate words for all animation opcodes)
	case OP_MOVE, OP_TURN, OP_SPIN, OP_STOP_SPIN:
		return 2
	default:
		return 0
	}
}

// DecodePackedOperand extracts components from packed animation opcodes
// Format: [piece_id:8][axis:8][speed_or_value:8][flags:8]
func DecodePackedOperand(operand uint32) (pieceID, axis, value, flags uint8) {
	flags = uint8(operand >> 24)
	value = uint8(operand >> 16)
	axis = uint8(operand >> 8)
	pieceID = uint8(operand)
	return
}

// EncodePackedOperand packs piece, axis, value, flags into a single uint32
func EncodePackedOperand(pieceID, axis, value, flags uint8) uint32 {
	return uint32(flags)<<24 | uint32(value)<<16 | uint32(axis)<<8 | uint32(pieceID)
}

// AxisName converts axis code to string
func AxisName(axis uint8) string {
	switch axis {
	case 0:
		return "x-axis"
	case 1:
		return "y-axis"
	case 2:
		return "z-axis"
	default:
		return fmt.Sprintf("axis_%d", axis)
	}
}

// OpcodeByName returns the opcode value for a given opcode name
func OpcodeByName(name string) (uint32, bool) {
	opcodeMap := map[string]uint32{
		// Animation / movement
		"MOVE":            OP_MOVE,
		"TURN":            OP_TURN,
		"SPIN":            OP_SPIN,
		"STOP_SPIN":       OP_STOP_SPIN,
		"MOVE_NOW":        OP_MOVE_NOW,
		"TURN_NOW":        OP_TURN_NOW,
		"WAIT_FOR_TURN":   OP_WAIT_FOR_TURN,
		"WAIT_FOR_MOVE":   OP_WAIT_FOR_MOVE,

		// Visibility / pieces
		"SHOW":            OP_SHOW,
		"HIDE":            OP_HIDE,
		"CACHE":           OP_CACHE,
		"DONT_CACHE":      OP_DONT_CACHE,
		"SHADE":           OP_SHADE,
		"DONT_SHADE":      OP_DONT_SHADE,
		"DONT_SHADOW":     OP_DONT_SHADE,

		// Effects
		"EMIT_SFX":        OP_EMIT_SFX,
		"EXPLODE":         OP_EXPLODE,
		"PLAY_SOUND":      OP_PLAY_SOUND,

		// Timing
		"SLEEP":           OP_SLEEP,

		// Signals
		"SIGNAL":          OP_SIGNAL,
		"SET_SIGNAL_MASK": OP_SET_SIGNAL_MASK,

		// Script calls
		"START_SCRIPT":    OP_START_SCRIPT,
		"CALL_SCRIPT":     OP_CALL_SCRIPT,
		"RETURN":          OP_RETURN,

		// Units
		"ATTACH_UNIT":     OP_ATTACH_UNIT,
		"DROP_UNIT":       OP_DROP_UNIT,

		// Control flow
		"JUMP":            OP_JUMP,
		"JUMP_IF_FALSE":   OP_JUMP_IF_FALSE,

		// Stack / variables (canonical names from OpcodeName)
		"STACK_ALLOC":     OP_STACK_ALLOC,
		"PUSH_CONST":      OP_PUSH_CONSTANT,
		"PUSH_LOCAL":       OP_PUSH_LOCAL_VAR,
		"POP_LOCAL":        OP_POP_LOCAL_VAR,
		"PUSH_STATIC":     OP_PUSH_STATIC,
		"POP_STATIC":      OP_POP_STATIC,
		// Legacy aliases
		"PUSH_CONSTANT":   OP_PUSH_CONSTANT,
		"PUSH_LOCAL_VAR":  OP_PUSH_LOCAL_VAR,
		"POP_LOCAL_VAR":   OP_POP_LOCAL_VAR,

		// Arithmetic
		"ADD":             OP_ADD,
		"SUB":             OP_SUB,
		"MUL":             OP_MUL,
		"DIV":             OP_DIV,

		// Bitwise
		"BITWISE_AND":     OP_BITWISE_AND,
		"BITWISE_OR":      OP_BITWISE_OR,
		"BITWISE_XOR":     OP_BITWISE_XOR,
		"BITWISE_NOT":     OP_BITWISE_NOT,

		// Logical
		"LOGICAL_AND":     OP_LOGICAL_AND,
		"LOGICAL_OR":      OP_LOGICAL_OR,
		"LOGICAL_NOT":     OP_LOGICAL_NOT,

		// Comparison
		"LESS_THAN":       OP_LESS_THAN,
		"LESS_OR_EQUAL":   OP_LESS_OR_EQUAL,
		"GREATER_THAN":    OP_GREATER_THAN,
		"GREATER_OR_EQUAL": OP_GREATER_EQUAL,
		"GREATER_EQUAL":   OP_GREATER_EQUAL,
		"EQUAL":           OP_EQUAL,
		"NOT_EQUAL":       OP_NOT_EQUAL,

		// Game queries
		"RAND":            OP_RAND,
		"GET":             OP_GET,
		"GET_UNIT_VALUE":  OP_GET_UNIT_VALUE,
		"SET_VALUE":       OP_SET_VALUE,
	}
	
	opcode, ok := opcodeMap[name]
	return opcode, ok
}
