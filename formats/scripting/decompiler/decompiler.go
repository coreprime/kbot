package decompiler

import (
	"fmt"
	"strconv"
	"strings"

	scripting "github.com/coreprime/kbot/formats/scripting"
	"github.com/coreprime/kbot/formats/scripting/assembly"
	"github.com/coreprime/kbot/formats/scripting/parser"
)

// Decompiler converts COB bytecode to BOS source or disassembly
type Decompiler struct {
	cob *scripting.COB
}

// NewDecompiler creates a new decompiler
func NewDecompiler(cob *scripting.COB) *Decompiler {
	return &Decompiler{cob: cob}
}

// Decompile converts COB bytecode to valid BOS source code
func (d *Decompiler) Decompile() (string, error) {
	var sb strings.Builder

	// Header comment
	sb.WriteString("// Decompiled from COB bytecode\n")
	sb.WriteString("// Some details may differ from original source\n\n")

	// COB metadata directives the compiler honors for round-trip fidelity.
	// `.version` is always emitted so TA: Kingdoms COBs (`v6`) survive a
	// decompile/compile cycle without falling back to the v4 default.
	// `.sound_name "..."` emits the TAK-only per-COB sound-name table; the
	// writer rebuilds the v6 sub-header + offset table from those entries.
	fmt.Fprintf(&sb, ".version %d\n", d.cob.VersionSignature)
	for _, s := range d.cob.SoundNames {
		fmt.Fprintf(&sb, ".sound_name %q\n", s)
	}
	sb.WriteByte('\n')

	// Piece declarations
	if len(d.cob.PieceNames) > 0 {
		sb.WriteString("piece ")
		for i, piece := range d.cob.PieceNames {
			if i > 0 {
				sb.WriteString(", ")
			}
			sb.WriteString(piece)
		}
		sb.WriteString(";\n\n")
	}
	
	// Detect Demo() function for unitviewer inference (must be BEFORE static-var declaration)
	globalNames := make(map[int]string)
	for i := 0; i < int(d.cob.NumScripts); i++ {
		scriptName := ""
		if i < len(d.cob.ScriptNames) {
			scriptName = d.cob.ScriptNames[i]
		}
		if scriptName == "Demo" {
			instructions, err := d.cob.Disassemble(i)
			if err == nil && len(instructions) >= 2 {
				// Pattern: PUSH_CONST value + POP_STATIC index [+ optional PUSH_CONST 0 + RETURN]
				// The function sets a global variable (usually to 1) and returns
				if instructions[0].Opcode == scripting.OP_PUSH_CONSTANT &&
					instructions[1].Opcode == scripting.OP_POP_STATIC {
					// This is the unitviewer pattern!
					globalNames[int(instructions[1].Operand)] = "unitviewer"
				}
			}
			break // Only one Demo() function
		}
	}
	
	// Static variables
	if d.cob.NumberOfStaticVars > 0 {
		sb.WriteString("static-var")
		for i := uint32(0); i < d.cob.NumberOfStaticVars; i++ {
			if i > 0 {
				sb.WriteString(",")
			}
			// Use inferred name if available, otherwise global_N
			if name, ok := globalNames[int(i)]; ok {
				fmt.Fprintf(&sb, " %s", name)
			} else {
				fmt.Fprintf(&sb, " global_%d", i)
			}
		}
		sb.WriteString(";\n\n")
	}
	
	// No signal define generation — preserve raw numeric values for roundtrip fidelity
	globalSignalDefines := make(map[int]string) // empty — no substitution
	
	// Decompile each script
	for i := 0; i < int(d.cob.NumScripts); i++ {
		scriptName := fmt.Sprintf("script_%d", i)
		if i < len(d.cob.ScriptNames) && d.cob.ScriptNames[i] != "" {
			scriptName = d.cob.ScriptNames[i]
		}
		
		script, err := d.decompileScript(i, scriptName, globalSignalDefines, globalNames)
		if err != nil {
			return "", fmt.Errorf("failed to decompile script %d (%s): %w", i, scriptName, err)
		}
		
		sb.WriteString(script)
		sb.WriteString("\n")
	}
	
	return sb.String(), nil
}

// Disassemble produces a human-readable bytecode listing.
// Pass assembly.Plain for a clean listing or assembly.Annotated for the
// rich view with flow-control arrows and hex opcodes.
func (d *Decompiler) Disassemble(format assembly.Format) (string, error) {
	var sb strings.Builder

	// Structured header — parsed by the assembler for roundtrip.
	fmt.Fprintf(&sb, ".version %d\n", d.cob.VersionSignature)
	fmt.Fprintf(&sb, ".statics %d\n", d.cob.NumberOfStaticVars)

	// TA: Kingdoms v6 COBs carry a per-file sound-name table referenced
	// from the bytecode by index. Emit each entry as a `.sound_name`
	// directive; the assembler rebuilds the v6 sub-header and offset
	// table from these on round-trip.
	for _, s := range d.cob.SoundNames {
		fmt.Fprintf(&sb, ".sound_name %q\n", s)
	}

	for _, piece := range d.cob.PieceNames {
		fmt.Fprintf(&sb, ".piece %s\n", piece)
	}

	sb.WriteByte('\n')

	// Disassemble each script
	for i := 0; i < int(d.cob.NumScripts); i++ {
		scriptName := fmt.Sprintf("script_%d", i)
		if i < len(d.cob.ScriptNames) && d.cob.ScriptNames[i] != "" {
			scriptName = d.cob.ScriptNames[i]
		}

		script, err := d.disassembleScript(i, scriptName, format)
		if err != nil {
			return "", fmt.Errorf("failed to disassemble script %d (%s): %w", i, scriptName, err)
		}

		sb.WriteString(script)
		sb.WriteByte('\n')
	}

	return sb.String(), nil
}

// decompileScript converts a single script to valid BOS source
func (d *Decompiler) decompileScript(index int, name string, signalDefines map[int]string, globalNames map[int]string) (string, error) {
	if index >= len(d.cob.ScriptCodeIndices) {
		return "", fmt.Errorf("invalid script index %d", index)
	}
	
	instructions, err := d.cob.Disassemble(index)
	if err != nil {
		return "", err
	}
	
	var sb strings.Builder
	
	// Detect parameters: if function starts with STACK_ALLOC, analyze local var usage
	detectedParamCount := 0
	if len(instructions) > 0 && instructions[0].Opcode == scripting.OP_STACK_ALLOC {
		// Heuristic: scan through instructions to find locals that are READ before WRITE
		// For now, simple approach: count PUSH_LOCAL operations before first POP_LOCAL
		localReads := make(map[int32]bool)
		for _, inst := range instructions {
			if inst.Opcode == scripting.OP_PUSH_LOCAL_VAR {
				localReads[inst.Operand] = true
			} else if inst.Opcode == scripting.OP_POP_LOCAL_VAR {
				// Stop at first write
				break
			}
		}
		// Parameters are the lowest-numbered locals that are read
		for i := int32(0); i < 10; i++ { // Max 10 params (reasonable limit)
			if localReads[i] {
				detectedParamCount++
			} else {
				break // Params are contiguous from 0
			}
		}
	}
	
	// Count STACK_ALLOC operations first — these are the canonical signal
	// from Cavedog's compiler that a local slot is being reserved.
	// TA emits them all up-front; TA: Kingdoms sometimes interleaves
	// SIGNAL/SET_SIGNAL_MASK before the STACK_ALLOCs and also adds an
	// epilogue STACK_ALLOC right before RETURN, so we walk the full
	// instruction list rather than only the prefix run.
	stackAllocCount := 0
	for i, in := range instructions {
		if in.Opcode != scripting.OP_STACK_ALLOC {
			continue
		}
		// Skip the TAK epilogue marker — a STACK_ALLOC immediately
		// followed by RETURN, which is a return-shape pattern rather
		// than a real local-variable allocation.
		if i+1 < len(instructions) && instructions[i+1].Opcode == scripting.OP_RETURN {
			continue
		}
		stackAllocCount++
	}
	// As a defensive lower bound, also count the highest local-variable
	// index touched. This rescues functions where Cavedog's compiler
	// omitted a STACK_ALLOC for a slot we can plainly see being used.
	maxLocal := -1
	for _, in := range instructions {
		switch in.Opcode {
		case scripting.OP_PUSH_LOCAL_VAR, scripting.OP_POP_LOCAL_VAR, scripting.OP_CREATE_LOCAL:
			if int(in.Operand) > maxLocal {
				maxLocal = int(in.Operand)
			}
		}
	}
	if maxLocal+1 > stackAllocCount {
		stackAllocCount = maxLocal + 1
	}
	
	// Check if we have a well-known signature with more parameters
	// (handles output parameters that aren't read)
	// But never exceed the actual STACK_ALLOC count from bytecode
	paramCount := detectedParamCount
	if sig := parser.GetFunctionSignature(name); sig != nil && len(sig.ParamNames) > paramCount {
		paramCount = len(sig.ParamNames)
	}
	if paramCount > stackAllocCount {
		paramCount = stackAllocCount
	}
	
	// Build parameter name map
	paramNames := make(map[int]string) // local index -> param name
	
	// Function signature with parameters
	// Check for well-known function signatures first
	if paramCount > 0 {
		params := make([]string, paramCount)
		
		// Try to get well-known parameter names
		if sig := parser.GetFunctionSignature(name); sig != nil && len(sig.ParamNames) >= paramCount {
			// Use well-known names
			for i := 0; i < paramCount; i++ {
				params[i] = sig.ParamNames[i]
				paramNames[i] = sig.ParamNames[i]
			}
		} else {
			// Fall back to local_N names
			for i := 0; i < paramCount; i++ {
				params[i] = fmt.Sprintf("local_%d", i)
				paramNames[i] = params[i]
			}
		}
		
		fmt.Fprintf(&sb, "%s(%s)\n{\n", name, strings.Join(params, ", "))
	} else {
		fmt.Fprintf(&sb, "%s()\n{\n", name)
	}
	
	// Emit local variable declarations for non-parameter locals
	if stackAllocCount > paramCount {
		var localVars []string
		for i := paramCount; i < stackAllocCount; i++ {
			localVars = append(localVars, fmt.Sprintf("local_%d", i))
		}
		sb.WriteString("\tvar ")
		sb.WriteString(strings.Join(localVars, ", "))
		sb.WriteString(";\n\n")
	}
	
	// Use recursive control flow analyzer for better nested structure handling
	analyzer := NewControlFlowAnalyzer(d, instructions, paramNames, signalDefines, globalNames)
	body := analyzer.ProcessRange(0, len(instructions), 1)

	for _, line := range body {
		sb.WriteString(line)
		sb.WriteString("\n")
	}
	
	sb.WriteString("}\n")
	return sb.String(), nil
	
	// OLD CODE BELOW - KEEPING FOR REFERENCE
	/*
	stack := newExprStack()
	hasReturn := false
	skip := make(map[int]bool) // Track which instructions to skip (already in if block)
	

	
	for i := 0; i < len(instructions); i++ {
		if skip[i] {
			continue
		}
		
		inst := instructions[i]
		if inst.Opcode == scripting.OP_RETURN {
			hasReturn = true
		}
		
		// Check for if statement pattern: instruction + JUMP_IF_FALSE
		if i+1 < len(instructions) && instructions[i+1].Opcode == scripting.OP_JUMP_IF_FALSE {
			// We have a potential if statement!
			// Save condition instruction for while loop detection
			conditionInst := inst
			
			// First translate current instruction (might push condition to stack)
			d.translateInstruction(inst, stack, paramNames, signalDefines, globalNames)
			
			// Pop condition from stack
			if stack.isEmpty() {
				// No condition on stack, not a valid if pattern - treat as regular instruction
				// Already translated, just continue
				continue
			}
			
			condition := stack.pop() // Get the condition expression
			
			// Next instruction is JUMP_IF_FALSE
			jumpInst := instructions[i+1]
			i++ // Skip the JUMP_IF_FALSE in next iteration
			// Jump operands are ABSOLUTE WORD OFFSETS within Code section
			targetOffset := uint32(jumpInst.Operand) * 4
			
			// Find where jump lands (start of else block or after if)
			elseStart := -1
			for j := i + 1; j < len(instructions); j++ {
				if instructions[j].Offset >= targetOffset {
					elseStart = j
					break
				}
			}
			
			// If elseStart == -1, the jump goes past end of script (implicit return)
			// This means: if (cond) { ... return; } with no else
			// Set elseStart to end of instructions for boundary checking
			if elseStart == -1 {
				elseStart = len(instructions)
			}
			
			// Find end of then block (return or jump or else start)
			thenEnd := elseStart
			isWhileLoop := false
			for j := i + 1; j < elseStart; j++ {
				if instructions[j].Opcode == scripting.OP_RETURN {
					thenEnd = j + 1
					break
				}
				if instructions[j].Opcode == scripting.OP_JUMP {
					// Check if backward jump (while loop)
					// Jump operands are ABSOLUTE WORD OFFSETS within Code section
					jumpTarget := uint32(instructions[j].Operand) * 4
					conditionOffset := conditionInst.Offset
					
					// Backward jump? Check if target is before current instruction
					isBackwardJump := jumpTarget < instructions[j].Offset
					
					// For while loop: backward jump that goes to condition or before
					if isBackwardJump && jumpTarget <= conditionOffset {
						// Backward jump - this is a while loop!
						isWhileLoop = true
						thenEnd = j  // Don't include the JUMP in the body
						break
					} else {
						// Forward jump - might be end of if block, keep looking for backward jump
						if !isWhileLoop {
							// Haven't found while yet, this might be end of if block
							thenEnd = j + 1
						}
						// Don't break - keep looking for backward jump
					}
				}
			}
			
			// Check if this is an always-true condition (if (1))
			// These are unconditional blocks that should be simplified
			isAlwaysTrue := !isWhileLoop && condition == "1"
			
			// Strip redundant outer parentheses from condition
			// E.g., "(severity <= 25)" -> "severity <= 25"
			cleanCondition := condition
			if len(cleanCondition) > 2 && cleanCondition[0] == '(' && cleanCondition[len(cleanCondition)-1] == ')' {
				// Check if these are the OUTER parentheses (not part of a complex expression)
				// Simple heuristic: if there's no operator at the same nesting level, strip them
				inner := cleanCondition[1 : len(cleanCondition)-1]
				if !strings.Contains(inner, "&&") && !strings.Contains(inner, "||") {
					cleanCondition = inner
				}
			}
			
			// Generate if or while statement (skip wrapper for always-true)
			if !isAlwaysTrue {
				if isWhileLoop {
					sb.WriteString(fmt.Sprintf("\twhile (%s)\n", cleanCondition))
				} else {
					sb.WriteString(fmt.Sprintf("\tif (%s)\n", cleanCondition))
				}
				sb.WriteString("\t{\n")
			}
			
			// Emit then block
			// Process instructions, but DON'T skip control flow patterns - they need recursive processing
			for j := i + 1; j < thenEnd; j++ {
				// Check if this is start of a nested control flow pattern
				isNestedControlFlow := j+1 < len(instructions) && instructions[j+1].Opcode == scripting.OP_JUMP_IF_FALSE
				
				if isNestedControlFlow {
					// Don't mark as skip - let main loop process this as nested if/while
					// But we need to handle it here with proper indentation
					// For now, skip it and let outer loop handle
					continue
				}
				
				skip[j] = true
				thenInst := instructions[j]
				if thenInst.Opcode == scripting.OP_RETURN {
					hasReturn = true
				}
				stmt := d.translateInstruction(thenInst, stack, paramNames, signalDefines, globalNames)
				if stmt != "" {
					// Adjust indentation based on whether we have a wrapper block
					if isAlwaysTrue {
						sb.WriteString("\t")  // Normal indent
					} else {
						sb.WriteString("\t\t")  // Double indent inside block
					}
					sb.WriteString(stmt)
					sb.WriteString("\n")
				}
			}
			
			// Close block if we opened one
			if !isAlwaysTrue {
				sb.WriteString("\t}\n")
			}
			
			// While loops don't have else blocks
			if isWhileLoop {
				i = thenEnd // Skip to after while body (JUMP not included in thenEnd)
				continue
			}
			
			// Check if there's an else block (only for if statements)
			// If then ended with RETURN, there's no else (just exits function)
			// If then ended with JUMP, there might be else content (need to check jump target)
			hasElse := thenEnd < elseStart && instructions[thenEnd-1].Opcode == scripting.OP_JUMP
			
			// But if then ended with JUMP, check if the jump target is past the else start
			// If so, there's real else content. If jump goes to elseStart, there's no else.
			if hasElse && thenEnd > 0 && thenEnd <= len(instructions) && instructions[thenEnd-1].Opcode == scripting.OP_JUMP {
				// Calculate where the JUMP goes (absolute word offset)
				jumpTarget := uint32(instructions[thenEnd-1].Operand) * 4
				
				
				// If jump goes directly to else start or beyond, there's no else content
				// (but if elseStart is past end, hasElse is already correctly false)
				if elseStart < len(instructions) && jumpTarget >= instructions[elseStart].Offset {
					hasElse = false
				} else if elseStart >= len(instructions) {
					// Jump goes past end of script - no else block
					hasElse = false
				}
			}
			
			if hasElse {
				// There's an else block
				
				// Find end of else (return or next if or end)
				elseEnd := len(instructions)
				for j := elseStart; j < len(instructions); j++ {
					if instructions[j].Opcode == scripting.OP_RETURN {
						elseEnd = j + 1
						break
					}
					// Check for another if statement (else if)
					if j+1 < len(instructions) && instructions[j+1].Opcode == scripting.OP_JUMP_IF_FALSE {
						elseEnd = j
						break
					}
				}
				
				sb.WriteString("\telse\n\t{\n")
				
				for j := elseStart; j < elseEnd; j++ {
					skip[j] = true
					elseInst := instructions[j]
					if elseInst.Opcode == scripting.OP_RETURN {
						hasReturn = true
					}
					stmt := d.translateInstruction(elseInst, stack, paramNames, signalDefines, globalNames)
					if stmt != "" {
						sb.WriteString("\t\t")
						sb.WriteString(stmt)
						sb.WriteString("\n")
					}
				}
				
				sb.WriteString("\t}\n")
				
				i = elseEnd - 1 // Skip to end of else block
			} else {
				i = thenEnd - 1 // Skip to end of then block
			}
			
			continue
		}
		
		// Regular instruction
		stmt := d.translateInstruction(inst, stack, paramNames, signalDefines, globalNames)
		if stmt != "" {
			sb.WriteString("\t")
			sb.WriteString(stmt)
			sb.WriteString("\n")
		}
	}
	
	// Only add return if function doesn't already have one
	if !hasReturn {
		sb.WriteString("\treturn;\n")
	}
	
	sb.WriteString("}\n")
	return sb.String(), nil
	*/
}

// DisassembleScript produces bytecode listing for a specific named script.
func (d *Decompiler) DisassembleScript(name string, format assembly.Format) (string, error) {
	// Find script by name
	scriptIndex := -1
	scriptName := ""
	for i := 0; i < int(d.cob.NumScripts); i++ {
		if i < len(d.cob.ScriptNames) && d.cob.ScriptNames[i] != "" {
			if d.cob.ScriptNames[i] == name {
				scriptIndex = i
				scriptName = d.cob.ScriptNames[i]
				break
			}
		}
	}
	
	if scriptIndex == -1 {
		return "", fmt.Errorf("script '%s' not found", name)
	}
	
	return d.disassembleScript(scriptIndex, scriptName, format)
}

// disassembleScript produces bytecode listing for a single script.
func (d *Decompiler) disassembleScript(index int, name string, format assembly.Format) (string, error) {
	instructions, err := d.cob.Disassemble(index)
	if err != nil {
		return "", err
	}

	view := assembly.NewDisassembler(instructions, name, d.cob.ScriptCodeIndices[index])
	return view.Render(format), nil
}

// translateInstruction converts a single instruction to BOS statement
// paramNames maps local variable indices to parameter names
func (d *Decompiler) translateInstruction(inst scripting.Instruction, stack *exprStack, paramNames map[int]string, signalDefines map[int]string, globalNames map[int]string) string {
	switch inst.Opcode {
	// Stack operations
	case scripting.OP_PUSH_CONSTANT: // 0x10
		stack.push(fmt.Sprintf("%d", inst.Operand))
		return ""
		
	case scripting.OP_PUSH_LOCAL_VAR: // 0x11
		// Check if this local has a parameter name
		localName := fmt.Sprintf("local_%d", inst.Operand)
		if name, ok := paramNames[int(inst.Operand)]; ok {
			localName = name
		}
		stack.push(localName)
		return ""
		
	case scripting.OP_GET_UNIT_VALUE: // Get value from port
		// Port number should be on stack
		if !stack.isEmpty() {
			port := stack.pop()
			// Look up port name if it's a constant
			portName := getPortName(port)
			stack.push(fmt.Sprintf("get %s", portName))
		}
		return ""
	
	case scripting.OP_SET_VALUE: // Set value to port
		// Stack has: [port, value]
		if !stack.isEmpty() {
			value := stack.pop()
			if !stack.isEmpty() {
				port := stack.pop()
				portName := getPortName(port)
				return fmt.Sprintf("set %s to %s;", portName, value)
			}
		}
		return ""
	
	case scripting.OP_PUSH_STATIC: // 0x12
		globalName := fmt.Sprintf("global_%d", inst.Operand)
		if name, ok := globalNames[int(inst.Operand)]; ok {
			globalName = name
		}
		stack.push(globalName)
		return ""
		
	case scripting.OP_POP_LOCAL_VAR: // 0x14
		// Check if this local has a parameter name
		localName := fmt.Sprintf("local_%d", inst.Operand)
		if name, ok := paramNames[int(inst.Operand)]; ok {
			localName = name
		}
		if val := stack.pop(); val != "" {
			return fmt.Sprintf("%s = %s;", localName, val)
		}
		
	case scripting.OP_POP_STATIC: // 0x15
		if val := stack.pop(); val != "" {
			globalName := fmt.Sprintf("global_%d", inst.Operand)
			if name, ok := globalNames[int(inst.Operand)]; ok {
				globalName = name
			}
			return fmt.Sprintf("%s = %s;", globalName, val)
		}
	
	case scripting.OP_RAND: // 0x19
		// rand(low, high) - pops two values
		if high := stack.pop(); high != "" {
			if low := stack.pop(); low != "" {
				stack.push(fmt.Sprintf("rand(%s, %s)", low, high))
			}
		}
		return ""
	
	case scripting.OP_GET: // 0x10043000
		// get(port, unitid, x, y, z) — complex game value query
		// Consumes 5 stack values: z (top), y, x, unitid, port (deepest)
		z := stack.pop()
		y := stack.pop()
		x := stack.pop()
		uid := stack.pop()
		port := stack.pop()
		stack.push(fmt.Sprintf("get(%s, %s, %s, %s, %s)", port, uid, x, y, z))
		return ""
		
	// Arithmetic operations
	case scripting.OP_ADD: // 0x20
		if b := stack.pop(); b != "" {
			if a := stack.pop(); a != "" {
				stack.push(fmt.Sprintf("(%s + %s)", a, b))
			}
		}
		return ""
		
	case scripting.OP_SUB: // 0x21
		if b := stack.pop(); b != "" {
			if a := stack.pop(); a != "" {
				stack.push(fmt.Sprintf("(%s - %s)", a, b))
			}
		}
		return ""
		
	case scripting.OP_MUL: // 0x22
		if b := stack.pop(); b != "" {
			if a := stack.pop(); a != "" {
				stack.push(fmt.Sprintf("(%s * %s)", a, b))
			}
		}
		return ""
		
	case scripting.OP_DIV: // 0x23
		if b := stack.pop(); b != "" {
			if a := stack.pop(); a != "" {
				stack.push(fmt.Sprintf("(%s / %s)", a, b))
			}
		}
		return ""
	
	case scripting.OP_MOD: // 0x24
		if b := stack.pop(); b != "" {
			if a := stack.pop(); a != "" {
				stack.push(fmt.Sprintf("(%s %% %s)", a, b))
			}
		}
		return ""
	
	// Bitwise operations
	case scripting.OP_BITWISE_AND: // 0x28
		if b := stack.pop(); b != "" {
			if a := stack.pop(); a != "" {
				stack.push(fmt.Sprintf("(%s & %s)", a, b))
			}
		}
		return ""
	
	case scripting.OP_BITWISE_OR: // 0x29
		if b := stack.pop(); b != "" {
			if a := stack.pop(); a != "" {
				stack.push(fmt.Sprintf("(%s | %s)", a, b))
			}
		}
		return ""
	
	// play-sound consumes the sound id from the stack and pushes a return
	// value; the BOS form is `play-sound <id> volume <vol>;`. Volume is
	// inline. The pushed result is dropped via the POP_STACK that
	// follows in the bytecode.
	case scripting.OP_PLAY_SOUND:
		soundID := stack.pop()
		if soundID == "" {
			soundID = "0"
		}
		stack.push(fmt.Sprintf("play-sound(%s, %d)", soundID, inst.Operand))
		return ""

	// POP_STACK discards the top of the stack. When the popped expression
	// has side effects (a Mission-Command call, a START_SCRIPT spawn) we
	// need to emit it as a stand-alone statement; otherwise the
	// decompile→compile round-trip silently drops the call. Pure values
	// (literal constants, locals) can still be discarded silently.
	case scripting.OP_POP_STACK:
		v := stack.pop()
		if v == "" {
			return ""
		}
		if expressionHasSideEffect(v) {
			return v + ";"
		}
		return ""

	// TA: Kingdoms stack-neutral math intrinsics. We wrap the top of the
	// symbolic stack so a `local = 3 * 2 ; TAK_MATH_09 ; POP_LOCAL` site
	// decompiles to `local = __tak_math_09(3 * 2);` — round-tripping back
	// through the compiler reinstates the opcode at the same offset.
	case scripting.OP_TAK_MATH_09:
		if v := stack.pop(); v != "" {
			stack.push(fmt.Sprintf("__tak_math_09(%s)", v))
		}
		return ""
	case scripting.OP_TAK_MATH_0B:
		if v := stack.pop(); v != "" {
			stack.push(fmt.Sprintf("__tak_math_0b(%s)", v))
		}
		return ""

	// TA: Kingdoms DONT_SHADOW — disables shadow casting for one piece.
	case scripting.OP_DONT_SHADOW:
		pieceIdx := int(inst.Operand)
		pieceName := fmt.Sprintf("piece_%d", pieceIdx)
		if pieceIdx >= 0 && pieceIdx < len(d.cob.PieceNames) {
			pieceName = d.cob.PieceNames[pieceIdx]
		}
		return fmt.Sprintf("dont-shadow(%s);", pieceName)

	// TA: Kingdoms MISSION_COMMAND. Two inline DWORDs encode
	// (soundNameIndex, stackArgCount); the engine pops the named number
	// of values off the stack, runs the command stored at that index in
	// the COB's sound-name table, and pushes a single result back. The
	// result is consumed by whichever POP_* opcode follows — either
	// POP_STATIC/POP_LOCAL when the BOS assigns it or POP_STACK when it
	// discards. We render it as `Mission-Command(...)` to match
	// Scriptor's canonical TAK BOS keyword.
	case scripting.OP_MISSION_COMMAND:
		cmdIdx := int(inst.Operand)
		argCount := int(inst.Operand2)
		// Collect the stack arguments (popped most-recent first).
		args := make([]string, argCount)
		for i := argCount - 1; i >= 0; i-- {
			args[i] = stack.pop()
		}
		cmd := fmt.Sprintf("sound_%d", cmdIdx)
		if cmdIdx >= 0 && cmdIdx < len(d.cob.SoundNames) {
			cmd = fmt.Sprintf("%q", d.cob.SoundNames[cmdIdx])
		}
		expr := fmt.Sprintf("Mission-Command(%s, %s)", cmd, strings.Join(args, ", "))
		if argCount == 0 {
			expr = fmt.Sprintf("Mission-Command(%s)", cmd)
		}
		stack.push(expr)
		return ""

	case scripting.OP_BITWISE_NOT: // 0x2B
		if val := stack.pop(); val != "" {
			stack.push(fmt.Sprintf("~%s", val))
		}
		return ""
		
	// Comparison operations
	case scripting.OP_LESS_THAN: // 0x64
		if b := stack.pop(); b != "" {
			if a := stack.pop(); a != "" {
				stack.push(fmt.Sprintf("(%s < %s)", a, b))
			}
		}
		return ""
	
	case scripting.OP_LESS_OR_EQUAL: // 0x65
		if b := stack.pop(); b != "" {
			if a := stack.pop(); a != "" {
				stack.push(fmt.Sprintf("(%s <= %s)", a, b))
			}
		}
		return ""
	
	case scripting.OP_GREATER_THAN: // 0x66
		if b := stack.pop(); b != "" {
			if a := stack.pop(); a != "" {
				stack.push(fmt.Sprintf("(%s > %s)", a, b))
			}
		}
		return ""
	
	case scripting.OP_GREATER_EQUAL: // 0x67
		if b := stack.pop(); b != "" {
			if a := stack.pop(); a != "" {
				stack.push(fmt.Sprintf("(%s >= %s)", a, b))
			}
		}
		return ""
	
	case scripting.OP_EQUAL: // 0x68
		if b := stack.pop(); b != "" {
			if a := stack.pop(); a != "" {
				stack.push(fmt.Sprintf("(%s == %s)", a, b))
			}
		}
		return ""
	
	case scripting.OP_NOT_EQUAL: // 0x69
		if b := stack.pop(); b != "" {
			if a := stack.pop(); a != "" {
				stack.push(fmt.Sprintf("(%s != %s)", a, b))
			}
		}
		return ""
	
	// Logical operations
	case scripting.OP_LOGICAL_AND: // 0x70
		if b := stack.pop(); b != "" {
			if a := stack.pop(); a != "" {
				stack.push(fmt.Sprintf("(%s && %s)", a, b))
			}
		}
		return ""
	
	case scripting.OP_LOGICAL_OR: // 0x71
		if b := stack.pop(); b != "" {
			if a := stack.pop(); a != "" {
				stack.push(fmt.Sprintf("(%s || %s)", a, b))
			}
		}
		return ""
	
	case scripting.OP_LOGICAL_NOT: // 0x73
		if val := stack.pop(); val != "" {
			stack.push(fmt.Sprintf("!%s", val))
		}
		return ""
		
	// Animation/control operations
	case scripting.OP_MOVE: // 0x10001000
		// Format: move <piece> to <axis>-axis <distance> speed <speed>;
		// Stack (before): speed (pushed first), distance (pushed second)
		// Post Data: piece#, axis#
		pieceID := int(inst.Operand)
		axisID := int(inst.Operand2)
		
		pieceName := fmt.Sprintf("piece_%d", pieceID)
		if pieceID >= 0 && pieceID < len(d.cob.PieceNames) {
			pieceName = d.cob.PieceNames[pieceID]
		}
		
		axisName := "unknown"
		if axisID >= 0 && axisID <= 2 {
			axisName = []string{"x", "y", "z"}[axisID]
		}
		
		// Pop TWO values: distance (top), then speed (deeper)
		distance := stack.pop()
		if distance == "" {
			distance = "0"
		}
		speed := stack.pop()
		if speed == "" {
			speed = "0"
		}
		
		return fmt.Sprintf("move %s to %s-axis <%s> speed <%s>;", pieceName, axisName, distance, speed)
	
	case scripting.OP_MOVE_NOW: // 0x1000B000
		// Move immediately (no speed parameter)
		// Stack (before): <position>
		// Post Data: piece#, axis#
		
		position := stack.pop()
		pieceID := inst.Operand
		axisID := inst.Operand2
		
		pieceName := fmt.Sprintf("piece_%d", pieceID)
		if int(pieceID) >= 0 && int(pieceID) < len(d.cob.PieceNames) {
			pieceName = d.cob.PieceNames[int(pieceID)]
		}
		
		axisName := "unknown"
		if axisID >= 0 && axisID <= 2 {
			axisName = []string{"x", "y", "z"}[axisID]
		}
		
		return fmt.Sprintf("move %s to %s-axis <%s> now;", pieceName, axisName, position)
	
	case scripting.OP_TURN_NOW: // 0x1000C000
		// Turn immediately (no speed parameter)
		// Stack (before): <angle>
		// Post Data: piece#, axis#
		
		angle := stack.pop()
		pieceID := inst.Operand
		axisID := inst.Operand2
		
		pieceName := fmt.Sprintf("piece_%d", pieceID)
		if int(pieceID) >= 0 && int(pieceID) < len(d.cob.PieceNames) {
			pieceName = d.cob.PieceNames[int(pieceID)]
		}
		
		axisName := "unknown"
		if axisID >= 0 && axisID <= 2 {
			axisName = []string{"x", "y", "z"}[axisID]
		}
		
		return fmt.Sprintf("turn %s to %s-axis <%s> now;", pieceName, axisName, angle)
	
	case scripting.OP_TURN: // 0x10002000
		// TA COB format: turn <piece> to <axis>-axis <angle> speed <speed>
		// Stack (before): <speed>, <direction/angle>
		// Post Data: piece#, axis#
		
		// Pop from stack (in reverse order - speed first, then angle)
		direction := stack.pop() // angle/direction (was pushed second)
		speed := stack.pop()     // speed (was pushed first, so deeper)
		
		// Get piece# and axis# from Post Data parameters
		pieceID := inst.Operand
		axisID := inst.Operand2
		
		// Resolve piece name
		pieceName := fmt.Sprintf("piece_%d", pieceID)
		if int(pieceID) >= 0 && int(pieceID) < len(d.cob.PieceNames) {
			pieceName = d.cob.PieceNames[int(pieceID)]
		}
		
		// Resolve axis name (0=x, 1=y, 2=z)
		axisName := "unknown"
		if axisID >= 0 && axisID <= 2 {
			axisName = []string{"x", "y", "z"}[axisID]
		}
		
		return fmt.Sprintf("turn %s to %s-axis <%s> speed <%s>;",
			pieceName, axisName, direction, speed)
	
	case scripting.OP_SPIN: // 0x10003000
		// Format: spin <piece> around <axis>-axis speed <speed>;
		// Post Data: piece#, axis# (two separate words, same as MOVE/TURN)
		// Stack (before): accel (pushed first), speed (pushed second)
		pieceID := int(inst.Operand)
		axisID := int(inst.Operand2)

		pieceName := fmt.Sprintf("piece_%d", pieceID)
		if pieceID >= 0 && pieceID < len(d.cob.PieceNames) {
			pieceName = d.cob.PieceNames[pieceID]
		}
		axisName := "x"
		switch axisID {
		case 1:
			axisName = "y"
		case 2:
			axisName = "z"
		}

		// Two values on stack: accel was pushed first (deeper), speed was pushed second (top)
		speedRaw := stack.pop()
		accelRaw := stack.pop()

		return fmt.Sprintf("spin %s around %s-axis speed <%s> accelerate <%s>;", pieceName, axisName, speedRaw, accelRaw)
	
	case scripting.OP_SHOW: // 0x10005000
		// Format: show <piece>;
		// Post Data: piece#
		pieceIdx := int(inst.Operand)
		pieceName := fmt.Sprintf("piece_%d", pieceIdx)
		if pieceIdx >= 0 && pieceIdx < len(d.cob.PieceNames) {
			pieceName = d.cob.PieceNames[pieceIdx]
		}
		return fmt.Sprintf("show %s;", pieceName)
	
	case scripting.OP_HIDE: // 0x10006000
		// Format: hide <piece>;
		// Post Data: piece#
		pieceIdx := int(inst.Operand)
		pieceName := fmt.Sprintf("piece_%d", pieceIdx)
		if pieceIdx >= 0 && pieceIdx < len(d.cob.PieceNames) {
			pieceName = d.cob.PieceNames[pieceIdx]
		}
		return fmt.Sprintf("hide %s;", pieceName)
	
	case scripting.OP_CACHE: // 0x10007000
		// Format: cache <piece>;
		pieceIdx := int(inst.Operand)
		pieceName := fmt.Sprintf("piece_%d", pieceIdx)
		if pieceIdx >= 0 && pieceIdx < len(d.cob.PieceNames) {
			pieceName = d.cob.PieceNames[pieceIdx]
		}
		return fmt.Sprintf("cache %s;", pieceName)

	case scripting.OP_DONT_CACHE: // 0x10008000
		// Format: dont-cache <piece>;
		pieceIdx := int(inst.Operand)
		pieceName := fmt.Sprintf("piece_%d", pieceIdx)
		if pieceIdx >= 0 && pieceIdx < len(d.cob.PieceNames) {
			pieceName = d.cob.PieceNames[pieceIdx]
		}
		return fmt.Sprintf("dont-cache %s;", pieceName)
	
	case scripting.OP_DONT_SHADE: // 0x1000F000
		// Format: dont-shade <piece>;
		pieceIdx := int(inst.Operand)
		pieceName := fmt.Sprintf("piece_%d", pieceIdx)
		if pieceIdx >= 0 && pieceIdx < len(d.cob.PieceNames) {
			pieceName = d.cob.PieceNames[pieceIdx]
		}
		return fmt.Sprintf("dont-shade %s;", pieceName)
	
	case scripting.OP_STOP_SPIN: // 0x10004000
		// Format: stop-spin <piece> around <axis>-axis;
		// Post Data: piece#, axis# (two separate words)
		// Stack (before): deceleration value (popped but not emitted if zero)
		pieceID := int(inst.Operand)
		axisID := int(inst.Operand2)

		pieceName := fmt.Sprintf("piece_%d", pieceID)
		if pieceID >= 0 && pieceID < len(d.cob.PieceNames) {
			pieceName = d.cob.PieceNames[pieceID]
		}
		axisName := "x"
		switch axisID {
		case 1:
			axisName = "y"
		case 2:
			axisName = "z"
		}

		// Deceleration value is on the stack
		decelRaw := stack.pop()

		return fmt.Sprintf("stop-spin %s around %s-axis decelerate <%s>;", pieceName, axisName, decelRaw)
	
	case scripting.OP_EMIT_SFX: // 0x1000F000
		// Format: emit-sfx <type> from <piece>;
		// Stack: type (popped)
		// Operand: piece#
		
		if !stack.isEmpty() {
			sfxType := stack.pop()
			pieceIdx := int(inst.Operand)
			
			pieceName := fmt.Sprintf("piece_%d", pieceIdx)
			if pieceIdx >= 0 && pieceIdx < len(d.cob.PieceNames) {
				pieceName = d.cob.PieceNames[pieceIdx]
			}
			
			return fmt.Sprintf("emit-sfx %s from %s;", sfxType, pieceName)
		}
		return ""
	
	case scripting.OP_EXPLODE: // 0x10071000
		// Format: explode <piece> type <flags>;
		// Stack: type flags (popped)
		// Post Data: piece# (in Operand)
		
		typeExpr := stack.pop() // Get type from stack (e.g., "256", "(256 | 1)")
		pieceIdx := int(inst.Operand)
		
		pieceName := fmt.Sprintf("piece_%d", pieceIdx)
		if pieceIdx >= 0 && pieceIdx < len(d.cob.PieceNames) {
			pieceName = d.cob.PieceNames[pieceIdx]
		}
		
		// Try to decode numeric type flags for readability
		if typeNum, err := strconv.Atoi(typeExpr); err == nil {
			var flagNames []string
			if typeNum & 0x01 != 0 { flagNames = append(flagNames, "SHATTER") }
			if typeNum & 0x02 != 0 { flagNames = append(flagNames, "EXPLODE_ON_HIT") }
			if typeNum & 0x04 != 0 { flagNames = append(flagNames, "FALL") }
			if typeNum & 0x08 != 0 { flagNames = append(flagNames, "SMOKE") }
			if typeNum & 0x10 != 0 { flagNames = append(flagNames, "FIRE") }
		if typeNum & 0x20 != 0 { flagNames = append(flagNames, "BITMAPONLY") }
			if typeNum & 0x100 != 0 { flagNames = append(flagNames, "BITMAP1") }
			if typeNum & 0x200 != 0 { flagNames = append(flagNames, "BITMAP2") }
			if typeNum & 0x400 != 0 { flagNames = append(flagNames, "BITMAP3") }
			if typeNum & 0x800 != 0 { flagNames = append(flagNames, "BITMAP4") }
			if typeNum & 0x1000 != 0 { flagNames = append(flagNames, "BITMAP5") }
			
			if len(flagNames) > 1 {
				flags := strings.Join(flagNames, " | ")
				return fmt.Sprintf("explode %s type %s;", pieceName, flags)
			} else if len(flagNames) == 1 {
				return fmt.Sprintf("explode %s type %s;", pieceName, flagNames[0])
			}
			// No known flag bits set — fall through to the raw-expression
			// form so we don't panic on (e.g.) TAK scripts using
			// `explode <piece> type 0;` or yet-unmapped flag bits.
		}

		// If not a simple number or no flags decoded, use the expression as-is
		return fmt.Sprintf("explode %s type %s;", pieceName, typeExpr)
	
	case scripting.OP_SIGNAL: // 0x67
		if val := stack.pop(); val != "" {
			// Check if this is a known signal constant
			if intVal, err := strconv.Atoi(val); err == nil {
				if defineName, ok := signalDefines[intVal]; ok {
					val = defineName
				}
			}
			return fmt.Sprintf("signal %s;", val)
		}
		
	case scripting.OP_SET_SIGNAL_MASK: // 0x68
		if val := stack.pop(); val != "" {
			// Check if this is a known signal constant
			if intVal, err := strconv.Atoi(val); err == nil {
				if defineName, ok := signalDefines[intVal]; ok {
					val = defineName
				}
			}
			return fmt.Sprintf("set-signal-mask %s;", val)
		}
	
	case scripting.OP_SLEEP: // 0x10013000
		if duration := stack.pop(); duration != "" {
			return fmt.Sprintf("sleep %s;", duration)
		}
	
	case scripting.OP_WAIT_FOR_TURN: // 0x10011000
		// Wait for piece to finish turning on axis
		// Post Data: piece#, axis#
		pieceID := inst.Operand
		axisID := inst.Operand2
		
		pieceName := fmt.Sprintf("piece_%d", pieceID)
		if int(pieceID) >= 0 && int(pieceID) < len(d.cob.PieceNames) {
			pieceName = d.cob.PieceNames[int(pieceID)]
		}
		
		axisName := "unknown"
		if axisID >= 0 && axisID <= 2 {
			axisName = []string{"x", "y", "z"}[axisID]
		}
		
		return fmt.Sprintf("wait-for-turn %s around %s-axis;", pieceName, axisName)
	
	case scripting.OP_WAIT_FOR_MOVE: // 0x10012000
		// Wait for piece to finish moving along axis
		// Post Data: piece#, axis#
		pieceID := inst.Operand
		axisID := inst.Operand2
		
		pieceName := fmt.Sprintf("piece_%d", pieceID)
		if int(pieceID) >= 0 && int(pieceID) < len(d.cob.PieceNames) {
			pieceName = d.cob.PieceNames[int(pieceID)]
		}
		
		axisName := "unknown"
		if axisID >= 0 && axisID <= 2 {
			axisName = []string{"x", "y", "z"}[axisID]
		}
		
		return fmt.Sprintf("wait-for-move %s along %s-axis;", pieceName, axisName)
		
	// Control flow
	case scripting.OP_CALL_SCRIPT: // 0x10062000
		scriptName := fmt.Sprintf("script_%d", inst.Operand)
		if int(inst.Operand) >= 0 && int(inst.Operand) < len(d.cob.ScriptNames) && d.cob.ScriptNames[inst.Operand] != "" {
			scriptName = d.cob.ScriptNames[inst.Operand]
		}
		// Operand2 is param count — pop that many args off the stack
		paramCount := int(inst.Operand2)
		params := popNReverse(stack, paramCount)
		return fmt.Sprintf("call-script %s(%s);", scriptName, strings.Join(params, ", "))

	case scripting.OP_START_SCRIPT: // 0x10061000
		scriptName := fmt.Sprintf("script_%d", inst.Operand)
		if int(inst.Operand) >= 0 && int(inst.Operand) < len(d.cob.ScriptNames) && d.cob.ScriptNames[inst.Operand] != "" {
			scriptName = d.cob.ScriptNames[inst.Operand]
		}
		// Operand2 is param count — pop that many args off the stack
		paramCount := int(inst.Operand2)
		params := popNReverse(stack, paramCount)
		return fmt.Sprintf("start-script %s(%s);", scriptName, strings.Join(params, ", "))
		
	case scripting.OP_ATTACH_UNIT: // 0x10083000
		// attach-unit <unitid> to <piece> <flag>
		// Stack: flag (top), piece, unitid (deepest)
		flag := stack.pop()
		piece := stack.pop()
		uid := stack.pop()
		return fmt.Sprintf("attach-unit %s to %s %s;", uid, piece, flag)
	
	case scripting.OP_DROP_UNIT: // 0x10084000
		// drop-unit <unitid>
		uid := stack.pop()
		return fmt.Sprintf("drop-unit %s;", uid)
	
	case scripting.OP_RETURN: // 0x86
		if val := stack.pop(); val != "" {
			return fmt.Sprintf("return %s;", val)
		}
		return "return;"
		
	case scripting.OP_JUMP: // 0x82
		// Control flow - can't easily reconstruct without CFG analysis
		return ""
		
	case scripting.OP_JUMP_IF_FALSE: // 0x83
		stack.pop() // Pop condition (will be reconstructed in if statement)
		return ""
		
	default:
		// Unknown/unimplemented opcode — skip silently.
		return ""
	}
	
	return ""
}

// exprStack is a simple stack for managing expression building
type exprStack struct {
	items []string
}

func newExprStack() *exprStack {
	return &exprStack{items: make([]string, 0, 16)}
}

func (s *exprStack) push(item string) {
	s.items = append(s.items, item)
}

func (s *exprStack) pop() string {
	if len(s.items) == 0 {
		return ""
	}
	item := s.items[len(s.items)-1]
	s.items = s.items[:len(s.items)-1]
	return item
}

func (s *exprStack) isEmpty() bool {
	return len(s.items) == 0
}

// expressionHasSideEffect reports whether an expression on the symbolic
// stack carries side effects we'd silently lose if POP_STACK drops it.
// This is intentionally a string check rather than tracking expression
// kinds through the stack — the symbol stack is already a string-builder,
// and intrinsic / call expressions are easy to recognise by their leading
// token.
func expressionHasSideEffect(expr string) bool {
	if strings.HasPrefix(expr, "Mission-Command(") {
		return true
	}
	if strings.HasPrefix(expr, "play-sound(") {
		return true
	}
	return false
}

// popNReverse pops n items from the stack and returns them in push order (oldest first).
// Parameters are pushed left-to-right, so the last-pushed is on top; reversing restores
// the original call order for the output string.
func popNReverse(stack *exprStack, n int) []string {
	items := make([]string, n)
	for i := n - 1; i >= 0; i-- {
		items[i] = stack.pop()
	}
	return items
}

// getPortName returns the symbolic name for a GET_UNIT_VALUE port number.
// Ports 1–20 are shared with TA; ports 21+ are TAK additions taken from
// Scriptor's [UNITVLAUES] table — present in retail TAK .cob files but
// inert under the TA engine.
func getPortName(port string) string {
	portMap := map[string]string{
		"1":  "ACTIVATION",
		"2":  "STANDINGMOVEORDERS",
		"3":  "STANDINGFIREORDERS",
		"4":  "HEALTH",
		"5":  "INBUILDSTANCE",
		"6":  "BUSY",
		"7":  "PIECE_XZ",
		"8":  "PIECE_Y",
		"9":  "UNIT_XZ",
		"10": "UNIT_Y",
		"11": "UNIT_HEIGHT",
		"12": "XZ_ATAN",
		"13": "XZ_HYPOT",
		"14": "ATAN",
		"15": "HYPOT",
		"16": "GROUND_HEIGHT",
		"17": "BUILD_PERCENT_LEFT",
		"18": "YARD_OPEN",
		"19": "BUGGER_OFF",
		"20": "ARMORED",
		// TA: Kingdoms additions.
		"21": "WEAPON_AIM_ABORTED",
		"22": "WEAPON_READY",
		"23": "WEAPON_LAUNCH_NOW",
		"26": "FINISHED_DYING",
		"27": "ORIENTATION",
		"28": "IN_WATER",
		"29": "CURRENT_SPEED",
		"31": "MAGIC_DEATH",
		"32": "VETERAN_LEVEL",
		"34": "ON_ROAD",
	}

	if name, ok := portMap[port]; ok {
		return name
	}
	return port // Return numeric port if unknown
}
