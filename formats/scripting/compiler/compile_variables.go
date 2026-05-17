package compiler

import (
	"fmt"
	"strings"

	"github.com/coreprime/kbot/formats/scripting"
)

func (c *Compiler) compileSet(line string) error {
	// Pattern: set PORT to VALUE;
	line = strings.TrimSuffix(strings.TrimSpace(line), ";")
	parts := strings.Split(strings.TrimPrefix(line, "set "), " to ")
	if len(parts) != 2 {
		return fmt.Errorf("invalid set syntax: %s", line)
	}

	port := strings.TrimSpace(parts[0])
	value := strings.TrimSpace(parts[1])

	// Original TA bytecode pushes port first, then value
	c.compileExpression(port)
	c.compileExpression(value)

	c.emit(scripting.OP_SET_VALUE, 0)
	return nil
}

// compileAssignment compiles variable assignment (e.g. "x = 1" or "x=1").
func (c *Compiler) compileAssignment(line string) error {
	line = strings.TrimSuffix(strings.TrimSpace(line), ";")

	// Find the assignment operator: split on " = " first, then bare "=".
	// Avoid splitting on "==", "!=", "<=", ">=".
	varName, expr, ok := splitAssignment(line)
	if !ok {
		return fmt.Errorf("invalid assignment: %s", line)
	}

	c.compileExpression(expr)

	if idx, ok := c.localIndex[varName]; ok {
		c.emit(scripting.OP_POP_LOCAL_VAR, int32(idx))
	} else if idx, ok := c.staticIndex[varName]; ok {
		c.emit(scripting.OP_POP_STATIC, int32(idx))
	} else {
		return fmt.Errorf("undefined variable: %s", varName)
	}

	return nil
}

// splitAssignment splits "var = expr" or "var=expr", avoiding "==" etc.
func splitAssignment(line string) (varName, expr string, ok bool) {
	// Try " = " first (canonical).
	if parts := strings.SplitN(line, " = ", 2); len(parts) == 2 {
		return strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1]), true
	}

	// Find bare "=" that isn't part of "==", "!=", "<=", ">=".
	for i := 0; i < len(line); i++ {
		if line[i] != '=' {
			continue
		}
		// Skip "==" (preceded or followed by '=')
		if i+1 < len(line) && line[i+1] == '=' {
			i++ // skip "=="
			continue
		}
		if i > 0 && (line[i-1] == '!' || line[i-1] == '<' || line[i-1] == '>') {
			continue
		}
		lhs := strings.TrimSpace(line[:i])
		rhs := strings.TrimSpace(line[i+1:])
		if lhs != "" && rhs != "" {
			return lhs, rhs, true
		}
	}
	return "", "", false
}

// containsAssignment checks if a line is a variable assignment.
func containsAssignment(line string) bool {
	_, _, ok := splitAssignment(strings.TrimSuffix(strings.TrimSpace(line), ";"))
	return ok
}
