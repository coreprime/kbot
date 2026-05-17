package decompiler

import (
	"fmt"
	"strings"

	scripting "github.com/coreprime/kbot/formats/scripting"
)

// Block represents a control flow block (if, while, or sequence of statements)
type Block struct {
	Type       string      // "if", "while", "sequence"
	Condition  string      // For if/while
	ThenBlock  *Block      // For if/while
	ElseBlock  *Block      // For if (optional)
	Statements []string    // For sequence
	Children   []*Block    // For nested blocks
}

// ControlFlowAnalyzer recursively processes instructions to build control flow structure
type ControlFlowAnalyzer struct {
	instructions []scripting.Instruction
	stack        *exprStack
	paramNames   map[int]string
	signalDef    map[int]string
	globalNames  map[int]string
	decompiler   *Decompiler
}

// NewControlFlowAnalyzer creates a new analyzer
func NewControlFlowAnalyzer(decompiler *Decompiler, instructions []scripting.Instruction, paramNames map[int]string, signalDef map[int]string, globalNames map[int]string) *ControlFlowAnalyzer {
	return &ControlFlowAnalyzer{
		instructions: instructions,
		stack:        newExprStack(),
		paramNames:   paramNames,
		signalDef:    signalDef,
		globalNames:  globalNames,
		decompiler:   decompiler,
	}
}

// ProcessRange processes a range of instructions [start, end) and returns blocks
func (cfa *ControlFlowAnalyzer) ProcessRange(start, end int, indent int) []string {
	var output []string
	i := start
	
	for i < end {
		// Check for RETURN
		if cfa.instructions[i].Opcode == scripting.OP_RETURN {
			// Process return value if on stack
			if !cfa.stack.isEmpty() {
				retval := cfa.stack.pop()
				indentStr := strings.Repeat("\t", indent)
				output = append(output, fmt.Sprintf("%sreturn %s;", indentStr, retval))
			} else {
				indentStr := strings.Repeat("\t", indent)
				output = append(output, indentStr+"return;")
			}
			i++
			continue
		}
		// Check for control flow patterns
		if i+1 < end && cfa.instructions[i+1].Opcode == scripting.OP_JUMP_IF_FALSE {
			// Potential if/while statement
			block, nextI := cfa.processConditional(i, end, indent)
			if block != nil {
				output = append(output, block...)
				i = nextI
				continue
			}
		}
		
		// Regular statement
		stmt := cfa.decompiler.translateInstruction(cfa.instructions[i], cfa.stack, cfa.paramNames, cfa.signalDef, cfa.globalNames)
		if stmt != "" {
			indentStr := strings.Repeat("\t", indent)
			output = append(output, indentStr+stmt)
		}
		i++
	}
	
	return output
}

// processConditional processes an if or while statement starting at index i
// Returns the decompiled lines and the next instruction index to process
func (cfa *ControlFlowAnalyzer) processConditional(i, end int, indent int) ([]string, int) {
	if i+1 >= end {
		return nil, i
	}
	
	// Translate condition instruction
	condInst := cfa.instructions[i]
	stmt := cfa.decompiler.translateInstruction(condInst, cfa.stack, cfa.paramNames, cfa.signalDef, cfa.globalNames)
	_ = stmt // Condition should be on stack
	
	// Get JUMP_IF_FALSE
	jumpIfFalse := cfa.instructions[i+1]
	if jumpIfFalse.Opcode != scripting.OP_JUMP_IF_FALSE {
		return nil, i
	}
	
	// Get condition from stack
	if cfa.stack.isEmpty() {
		return nil, i
	}
	condition := cfa.stack.pop()
	
	// Calculate jump target (operand is absolute word offset)
	targetOffset := uint32(jumpIfFalse.Operand * 4)
	
	// Find the instruction at targetOffset
	elseStart := -1
	for j := i + 2; j < end; j++ {
		if uint32(cfa.instructions[j].Offset) >= targetOffset {
			elseStart = j
			break
		}
	}
	
	if elseStart == -1 {
		elseStart = end // Jump goes past the end
	}
	
	// Look for backward jump (while loop)
	thenEnd := elseStart
	isWhileLoop := false
	conditionOffset := uint32(condInst.Offset)
	
	// Scan for JUMP in the then-block
	for j := i + 2; j < elseStart; j++ {
		if cfa.instructions[j].Opcode == scripting.OP_JUMP {
			jumpTarget := uint32(cfa.instructions[j].Operand * 4)
			if jumpTarget <= conditionOffset {
				// Backward jump - this is a while loop
				isWhileLoop = true
				thenEnd = j // Don't include the JUMP in the body
				break
			}
		}
	}
	
	// Clean condition
	cleanCondition := cleanParentheses(condition)
	
	// Check if this is always-true (should be unwrapped)
	// NEVER treat if (1) as always-true - preserve for byte-perfect roundtrip!
	isAlwaysTrue := false
	
	var output []string
	indentStr := strings.Repeat("\t", indent)
	
	// Emit if/while header (unless it's always-true)
	if !isAlwaysTrue {
		if isWhileLoop {
			output = append(output, fmt.Sprintf("%swhile (%s)", indentStr, cleanCondition))
		} else {
			output = append(output, fmt.Sprintf("%sif (%s)", indentStr, cleanCondition))
		}
		output = append(output, indentStr+"{")
	}
	
	// Recursively process then-block
	bodyIndent := indent + 1
	if isAlwaysTrue {
		bodyIndent = indent // Don't add extra indent for unwrapped blocks
	}
	thenBody := cfa.ProcessRange(i+2, thenEnd, bodyIndent)
	output = append(output, thenBody...)
	
	if !isAlwaysTrue {
		output = append(output, indentStr+"}")
	}
	
	// Check for else block
	nextI := thenEnd
	if isWhileLoop {
		nextI++ // Skip the backward JUMP
	}
	
	return output, nextI
}

// cleanParentheses removes redundant outer parentheses
func cleanParentheses(condition string) string {
	if len(condition) > 2 && condition[0] == '(' && condition[len(condition)-1] == ')' {
		inner := condition[1 : len(condition)-1]
		if !strings.Contains(inner, "&&") && !strings.Contains(inner, "||") {
			return inner
		}
	}
	return condition
}
