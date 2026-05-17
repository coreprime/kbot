package assembly

import (
	"fmt"
	"strings"

	"github.com/coreprime/kbot/formats/scripting"
)

// Format controls the output style of disassembly.
type Format int

const (
	// Plain produces a clean, minimal listing — one instruction per line,
	// no box-drawing, no flow arrows, no hex opcodes.
	Plain Format = iota
	// Annotated produces the rich view with Unicode box-drawing,
	// flow-control arrows, jump target annotations, and hex opcodes.
	Annotated
)

// Disassembler creates a bytecode view for a single script.
type Disassembler struct {
	instructions []scripting.Instruction
	name         string
	codeOffset   uint32
}

// NewDisassembler creates a new disassembly view.
func NewDisassembler(instructions []scripting.Instruction, name string, codeOffset uint32) *Disassembler {
	return &Disassembler{
		instructions: instructions,
		name:         name,
		codeOffset:   codeOffset,
	}
}

// jumpInfo stores information about a jump instruction
type jumpInfo struct {
	fromIdx    int    // Instruction index
	fromOffset uint32 // Byte offset
	toOffset   uint32 // Target byte offset
	toIdx      int    // Target instruction index
	isBackward bool   // True if backward jump (while loop)
	opcode     uint32 // JUMP or JUMP_IF_FALSE
}

// Render produces disassembly output using the given format.
func (dv *Disassembler) Render(format Format) string {
	switch format {
	case Annotated:
		return dv.renderAnnotated()
	default:
		return dv.renderPlain()
	}
}

// renderPlain produces a clean, minimal assembly listing.
//
// Example output:
//
//	; Script: SmokeUnit (0x00B2, 70 instructions)
//	0000  STACK_ALLOC         0
//	0004  STACK_ALLOC         0
//	0008  PUSH_CONST          17
//	0010  GET_UNIT_VALUE      0
//	0014  JUMP_IF_FALSE       192       ; -> 0x0300
//	001C  PUSH_CONST          400
//	0024  SLEEP               0
//	0028  JUMP                182       ; -> 0x02D8 (loop)
func (dv *Disassembler) renderPlain() string {
	var sb strings.Builder

	fmt.Fprintf(&sb, ".script %s\n", dv.name)

	jumps := dv.analyzeJumps()

	for i, inst := range dv.instructions {
		opname := scripting.OpcodeName(inst.Opcode)
		paramCount := scripting.OpcodeParamCount(inst.Opcode)

		// Base: offset + opcode + first operand (if any)
		if paramCount >= 2 {
			fmt.Fprintf(&sb, "%04X  %-20s %d, %d",
				inst.Offset, opname, inst.Operand, inst.Operand2)
		} else if paramCount == 1 {
			fmt.Fprintf(&sb, "%04X  %-20s %d",
				inst.Offset, opname, inst.Operand)
		} else {
			fmt.Fprintf(&sb, "%04X  %s",
				inst.Offset, opname)
		}

		// Trailing comment for jumps
		if inst.Opcode == scripting.OP_JUMP || inst.Opcode == scripting.OP_JUMP_IF_FALSE {
			target := uint32(inst.Operand) * 4
			tag := ""
			if dv.isBackwardJump(i, jumps) {
				tag = " (loop)"
			}
			fmt.Fprintf(&sb, "       ; -> 0x%04X%s", target, tag)
		}

		sb.WriteByte('\n')
	}

	return sb.String()
}

// renderAnnotated produces the rich view with box-drawing, flow arrows, and hex opcodes.
func (dv *Disassembler) renderAnnotated() string {
	var sb strings.Builder
	
	// Script directive + decorated header
	fmt.Fprintf(&sb, ".script %s\n", dv.name)
	sb.WriteString("╔════════════════════════════════════════════════════════════════════\n")
	
	// Analyze all jumps
	jumps := dv.analyzeJumps()
	
	// Build jump visualization map
	flowChars := dv.buildFlowChars(jumps)
	
	// Render each instruction with flow control visualization
	for i, inst := range dv.instructions {
		// Get flow control characters for this line
		flowPrefix := flowChars[i]
		
		// Format instruction
		opname := scripting.OpcodeName(inst.Opcode)
		paramCount := scripting.OpcodeParamCount(inst.Opcode)
		var instrLine string
		switch {
		case paramCount >= 2:
			instrLine = fmt.Sprintf("%04X: %-18s %d, %d", inst.Offset, opname, inst.Operand, inst.Operand2)
		case paramCount == 1:
			instrLine = fmt.Sprintf("%04X: %-18s %8d", inst.Offset, opname, inst.Operand)
		default:
			instrLine = fmt.Sprintf("%04X: %s", inst.Offset, opname)
		}
		
		// Add jump annotation if this is a jump
		if inst.Opcode == scripting.OP_JUMP || inst.Opcode == scripting.OP_JUMP_IF_FALSE {
			target := uint32(inst.Operand) * 4
			jumpType := "→"
			if dv.isBackwardJump(i, jumps) {
				jumpType = "↑"
			}
			instrLine += fmt.Sprintf("  %s 0x%04X", jumpType, target)
		}
		
		// Add hex representation
		instrLine += fmt.Sprintf("  (0x%08X)", inst.Opcode)
		
		// Combine flow prefix and instruction
		fmt.Fprintf(&sb, "║ %s %s\n", flowPrefix, instrLine)
	}
	
	sb.WriteString("╚════════════════════════════════════════════════════════════════════\n")
	
	return sb.String()
}

// analyzeJumps finds all jump instructions and their targets
func (dv *Disassembler) analyzeJumps() []jumpInfo {
	var jumps []jumpInfo
	
	for i, inst := range dv.instructions {
		if inst.Opcode == scripting.OP_JUMP || inst.Opcode == scripting.OP_JUMP_IF_FALSE {
			targetOffset := uint32(inst.Operand) * 4
			targetIdx := dv.findInstructionIndex(targetOffset)
			
			if targetIdx != -1 {
				jumps = append(jumps, jumpInfo{
					fromIdx:    i,
					fromOffset: inst.Offset,
					toOffset:   targetOffset,
					toIdx:      targetIdx,
					isBackward: targetIdx <= i,
					opcode:     inst.Opcode,
				})
			}
		}
	}
	
	return jumps
}

// buildFlowChars creates flow control visualization for each line
func (dv *Disassembler) buildFlowChars(jumps []jumpInfo) []string {
	flowChars := make([]string, len(dv.instructions))
	
	// Initialize all lines with base spacing
	for i := range flowChars {
		flowChars[i] = "      " // 6 chars for flow control
	}
	
	// Draw jump arrows
	for jumpIdx, jump := range jumps {
		column := jumpIdx % 3 // Use columns 0, 1, 2 for different jumps
		
		if jump.isBackward {
			// Backward jump (while loop)
			// Draw from jump back to target
			for i := jump.toIdx; i <= jump.fromIdx; i++ {
				chars := []rune(flowChars[i])
				
				switch i {
				case jump.toIdx:
					// Top of loop
					chars[column*2] = '┌'
				case jump.fromIdx:
					// Jump instruction
					chars[column*2] = '└'
					chars[column*2+1] = '↑'
				default:
					// Middle of loop
					chars[column*2] = '│'
				}
				
				flowChars[i] = string(chars)
			}
		} else {
			// Forward jump (if/else)
			// Draw from jump to target
			minIdx := jump.fromIdx
			maxIdx := jump.toIdx
			
			for i := minIdx; i <= maxIdx && i < len(flowChars); i++ {
				chars := []rune(flowChars[i])
				
				if i == jump.fromIdx {
					// Jump instruction
					if jump.opcode == scripting.OP_JUMP_IF_FALSE {
						chars[column*2] = '├'
					} else {
						chars[column*2] = '┬'
					}
					chars[column*2+1] = '→'
				} else if i == jump.toIdx {
					// Target
					chars[column*2] = '└'
				} else if i < jump.toIdx {
					// Middle
					chars[column*2] = '│'
				}
				
				flowChars[i] = string(chars)
			}
		}
	}
	
	return flowChars
}

// findInstructionIndex finds the instruction at the given byte offset
func (dv *Disassembler) findInstructionIndex(offset uint32) int {
	for i, inst := range dv.instructions {
		if inst.Offset == offset {
			return i
		}
	}
	return -1
}

// isBackwardJump checks if the instruction at index i is a backward jump
func (dv *Disassembler) isBackwardJump(i int, jumps []jumpInfo) bool {
	for _, jump := range jumps {
		if jump.fromIdx == i && jump.isBackward {
			return true
		}
	}
	return false
}
