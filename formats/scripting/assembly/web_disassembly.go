package assembly

import (
	"encoding/json"
	"fmt"

	"github.com/coreprime/kbot/formats/scripting"
)

// WebDisassemblyScript represents a single script for web visualization
type WebDisassemblyScript struct {
	Index        int                    `json:"index"`
	Name         string                 `json:"name"`
	Offset       uint32                 `json:"offset"`
	Instructions []WebInstruction       `json:"instructions"`
	Jumps        []WebJump              `json:"jumps"`
}

// WebInstruction represents a single instruction for web display
type WebInstruction struct {
	Index       int    `json:"index"`
	Offset      uint32 `json:"offset"`
	Opcode      string `json:"opcode"`
	OpcodeHex   string `json:"opcodeHex"`
	Operand     int32  `json:"operand"`
	OperandHex  string `json:"operandHex"`
	Description string `json:"description"`
}

// WebJump represents a jump instruction for visualization
type WebJump struct {
	FromIndex  int    `json:"fromIndex"`
	FromOffset uint32 `json:"fromOffset"`
	ToIndex    int    `json:"toIndex"`
	ToOffset   uint32 `json:"toOffset"`
	IsBackward bool   `json:"isBackward"`
	Type       string `json:"type"` // "JUMP" or "JUMP_IF_FALSE"
}

// WebDisassemblyData represents the complete disassembly for web visualization
type WebDisassemblyData struct {
	Header  WebDisassemblyHeader   `json:"header"`
	Scripts []WebDisassemblyScript `json:"scripts"`
}

// WebDisassemblyHeader contains file-level metadata
type WebDisassemblyHeader struct {
	Version      uint32   `json:"version"`
	ScriptCount  uint32   `json:"scriptCount"`
	PieceCount   uint32   `json:"pieceCount"`
	CodeLength   int      `json:"codeLength"`
	PieceNames   []string `json:"pieceNames"`
	StaticVars   []string `json:"staticVars"`
	StaticCount  uint32   `json:"staticCount"`
}

// GenerateWebDisassembly creates structured disassembly data for web visualization.
// It accepts a *scripting.COB directly to avoid circular dependencies.
func GenerateWebDisassembly(cob *scripting.COB) (string, error) {
	// Detect Demo() function for unitviewer inference
	globalNames := make(map[int]string)
	for i := 0; i < int(cob.NumScripts); i++ {
		scriptName := "Demo"
		if i < len(cob.ScriptNames) && cob.ScriptNames[i] != "" {
			scriptName = cob.ScriptNames[i]
		}
		
		if scriptName == "Demo" {
			instructions, err := cob.Disassemble(i)
			if err == nil && len(instructions) >= 2 {
				if instructions[0].Opcode == scripting.OP_PUSH_CONSTANT && 
				   instructions[1].Opcode == scripting.OP_POP_STATIC {
					globalNames[int(instructions[1].Operand)] = "unitviewer"
				}
			}
		}
	}
	
	// Generate header with file metadata
	staticVars := []string{}
	for i := 0; i < int(cob.NumberOfStaticVars); i++ {
		varName := fmt.Sprintf("global_%d", i)
		// Check if this is unitviewer
		if name, ok := globalNames[i]; ok {
			varName = name
		}
		staticVars = append(staticVars, varName)
	}
	
	header := WebDisassemblyHeader{
		Version:     cob.VersionSignature,
		ScriptCount: cob.NumScripts,
		PieceCount:  cob.NumPieces,
		CodeLength:  len(cob.Code),
		PieceNames:  cob.PieceNames,
		StaticVars:  staticVars,
		StaticCount: cob.NumberOfStaticVars,
	}
	
	scripts := []WebDisassemblyScript{}
	
	for i := 0; i < int(cob.NumScripts); i++ {
		scriptName := fmt.Sprintf("script_%d", i)
		if i < len(cob.ScriptNames) && cob.ScriptNames[i] != "" {
			scriptName = cob.ScriptNames[i]
		}
		
		instructions, err := cob.Disassemble(i)
		if err != nil {
			continue
		}
		
		// Convert instructions
		webInsts := make([]WebInstruction, len(instructions))
		for j, inst := range instructions {
			webInsts[j] = WebInstruction{
				Index:       j,
				Offset:      inst.Offset,
				Opcode:      scripting.OpcodeName(inst.Opcode),
				OpcodeHex:   fmt.Sprintf("0x%08X", inst.Opcode),
				Operand:     inst.Operand,
				OperandHex:  fmt.Sprintf("0x%X", uint32(inst.Operand)&0xFFFFFF),
				Description: getInstructionDescription(cob, inst),
			}
		}
		
		// Analyze jumps
		jumps := analyzeJumpsForWeb(instructions)
		
		scripts = append(scripts, WebDisassemblyScript{
			Index:        i,
			Name:         scriptName,
			Offset:       cob.ScriptCodeIndices[i],
			Instructions: webInsts,
			Jumps:        jumps,
		})
	}
	
	// Convert to JSON
	data := WebDisassemblyData{
		Header:  header,
		Scripts: scripts,
	}
	
	jsonData, err := json.Marshal(data)
	if err != nil {
		return "", fmt.Errorf("failed to marshal JSON: %w", err)
	}
	
	return string(jsonData), nil
}

// analyzeJumpsForWeb finds all jumps and their targets
func analyzeJumpsForWeb(instructions []scripting.Instruction) []WebJump {
	var jumps []WebJump
	
	for i, inst := range instructions {
		if inst.Opcode == scripting.OP_JUMP || inst.Opcode == scripting.OP_JUMP_IF_FALSE {
			targetOffset := uint32(inst.Operand) * 4
			targetIdx := findInstructionIndex(instructions, targetOffset)
			
			if targetIdx != -1 {
				jumpType := "JUMP"
				if inst.Opcode == scripting.OP_JUMP_IF_FALSE {
					jumpType = "JUMP_IF_FALSE"
				}
				
				jumps = append(jumps, WebJump{
					FromIndex:  i,
					FromOffset: inst.Offset,
					ToIndex:    targetIdx,
					ToOffset:   targetOffset,
					IsBackward: targetIdx <= i,
					Type:       jumpType,
				})
			}
		}
	}
	
	return jumps
}

// getInstructionDescription provides a human-readable description
func getInstructionDescription(cob *scripting.COB, inst scripting.Instruction) string {
	switch inst.Opcode {
	case scripting.OP_JUMP:
		return fmt.Sprintf("→ 0x%04X", uint32(inst.Operand)*4)
	case scripting.OP_JUMP_IF_FALSE:
		return fmt.Sprintf("→ 0x%04X if false", uint32(inst.Operand)*4)
	case scripting.OP_PUSH_CONSTANT:
		return fmt.Sprintf("Push constant %d", inst.Operand)
	case scripting.OP_PUSH_STATIC:
		return fmt.Sprintf("Push global_%d", inst.Operand)
	case scripting.OP_POP_STATIC:
		return fmt.Sprintf("Pop to global_%d", inst.Operand)
	case scripting.OP_PUSH_LOCAL_VAR:
		return fmt.Sprintf("Push local_%d", inst.Operand)
	case scripting.OP_POP_LOCAL_VAR:
		return fmt.Sprintf("Pop to local_%d", inst.Operand)
	case scripting.OP_GET_UNIT_VALUE:
		return "Get unit value from port on stack"
	case scripting.OP_SET_VALUE:
		return "Set unit value to port on stack"
	case scripting.OP_MOVE:
		return fmt.Sprintf("Move piece %d", inst.Operand)
	case scripting.OP_TURN:
		return fmt.Sprintf("Turn piece %d", inst.Operand)
	case scripting.OP_SPIN:
		return fmt.Sprintf("Spin piece %d", inst.Operand)
	case scripting.OP_STOP_SPIN:
		return fmt.Sprintf("Stop spin piece %d", inst.Operand)
	case scripting.OP_SHOW:
		return fmt.Sprintf("Show piece %d", inst.Operand)
	case scripting.OP_HIDE:
		return fmt.Sprintf("Hide piece %d", inst.Operand)
	case scripting.OP_EXPLODE:
		return fmt.Sprintf("Explode piece %d", inst.Operand)
	case scripting.OP_EMIT_SFX:
		return fmt.Sprintf("Emit SFX from piece %d", inst.Operand)
	case scripting.OP_SLEEP:
		return "Sleep (duration on stack)"
	case scripting.OP_RETURN:
		return "Return from function"
	case scripting.OP_CALL_SCRIPT:
		return fmt.Sprintf("Call script %d", inst.Operand)
	case scripting.OP_START_SCRIPT:
		return fmt.Sprintf("Start script %d", inst.Operand)
	default:
		return ""
	}
}

// findInstructionIndex helper
func findInstructionIndex(instructions []scripting.Instruction, offset uint32) int {
	for i, inst := range instructions {
		if inst.Offset == offset {
			return i
		}
	}
	return -1
}
