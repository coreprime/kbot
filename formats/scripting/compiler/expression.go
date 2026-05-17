package compiler

import (
	"strconv"
	"strings"

	"github.com/coreprime/kbot/formats/scripting"
)

func (c *Compiler) compileExpression(expr string) {
	expr = strings.TrimSpace(expr)

	// Strip outer parentheses if they wrap the entire expression
	if len(expr) > 2 && expr[0] == '(' && expr[len(expr)-1] == ')' {
		// Check that these parens are balanced (not just "(a) + (b)")
		depth := 0
		balanced := true
		for i, ch := range expr {
			switch ch {
			case '(':
				depth++
			case ')':
				depth--
			}
			if depth == 0 && i < len(expr)-1 {
				balanced = false
				break
			}
		}
		if balanced {
			c.compileExpression(expr[1 : len(expr)-1])
			return
		}
	}

	// Binary operators — check in precedence order (lowest first so they bind loosest)
	// Split on the LAST occurrence at depth 0 for left-associativity
	if op, left, right, ok := splitBinaryOp(expr, " || "); ok {
		c.compileExpression(left)
		c.compileExpression(right)
		_ = op
		c.emit(scripting.OP_LOGICAL_OR, 0)
		return
	}
	if op, left, right, ok := splitBinaryOp(expr, " && "); ok {
		c.compileExpression(left)
		c.compileExpression(right)
		_ = op
		c.emit(scripting.OP_LOGICAL_AND, 0)
		return
	}
	if _, left, right, ok := splitBinaryOp(expr, " | "); ok {
		c.compileExpression(left)
		c.compileExpression(right)
		c.emit(scripting.OP_BITWISE_OR, 0)
		return
	}
	if _, left, right, ok := splitBinaryOp(expr, " == "); ok {
		c.compileExpression(left)
		c.compileExpression(right)
		c.emit(scripting.OP_EQUAL, 0)
		return
	}
	if _, left, right, ok := splitBinaryOp(expr, " != "); ok {
		c.compileExpression(left)
		c.compileExpression(right)
		c.emit(scripting.OP_NOT_EQUAL, 0)
		return
	}
	if _, left, right, ok := splitBinaryOp(expr, " <= "); ok {
		c.compileExpression(left)
		c.compileExpression(right)
		c.emit(scripting.OP_LESS_OR_EQUAL, 0)
		return
	}
	if _, left, right, ok := splitBinaryOp(expr, " >= "); ok {
		c.compileExpression(left)
		c.compileExpression(right)
		c.emit(scripting.OP_GREATER_EQUAL, 0)
		return
	}
	if _, left, right, ok := splitBinaryOp(expr, " < "); ok {
		c.compileExpression(left)
		c.compileExpression(right)
		c.emit(scripting.OP_LESS_THAN, 0)
		return
	}
	if _, left, right, ok := splitBinaryOp(expr, " > "); ok {
		c.compileExpression(left)
		c.compileExpression(right)
		c.emit(scripting.OP_GREATER_THAN, 0)
		return
	}
	if _, left, right, ok := splitBinaryOp(expr, " + "); ok {
		c.compileExpression(left)
		c.compileExpression(right)
		c.emit(scripting.OP_ADD, 0)
		return
	}
	if _, left, right, ok := splitBinaryOp(expr, " - "); ok {
		c.compileExpression(left)
		c.compileExpression(right)
		c.emit(scripting.OP_SUB, 0)
		return
	}
	if _, left, right, ok := splitBinaryOp(expr, " * "); ok {
		c.compileExpression(left)
		c.compileExpression(right)
		c.emit(scripting.OP_MUL, 0)
		return
	}
	if _, left, right, ok := splitBinaryOp(expr, " / "); ok {
		c.compileExpression(left)
		c.compileExpression(right)
		c.emit(scripting.OP_DIV, 0)
		return
	}
	if _, left, right, ok := splitBinaryOp(expr, " % "); ok {
		c.compileExpression(left)
		c.compileExpression(right)
		c.emit(scripting.OP_MOD, 0)
		return
	}

	// Check for prefix operators
	if strings.HasPrefix(expr, "!") {
		c.compileExpression(strings.TrimSpace(expr[1:]))
		c.emit(scripting.OP_LOGICAL_NOT, 0)
		return
	}

	// Check for get(...) calls (scripting.OP_GET - complex game value query)
	if strings.HasPrefix(expr, "get(") && strings.HasSuffix(expr, ")") {
		inner := expr[4 : len(expr)-1]
		params := splitParams(inner)
		if len(params) == 5 {
			// get(port, unitid, x, y, z) — push in order: port, unitid, x, y, z
			for _, p := range params {
				c.compileExpression(p)
			}
			c.emit(scripting.OP_GET, 0)
			return
		} else if len(params) == 1 {
			// Legacy get(N) — single constant
			c.compileExpression(params[0])
			c.emit(scripting.OP_GET, 0)
			return
		}
	}

	// Check for get PORT calls (scripting.OP_GET_UNIT_VALUE)
	if strings.HasPrefix(expr, "get ") {
		port := strings.TrimSpace(strings.TrimPrefix(expr, "get"))
		c.compileExpression(port)
		c.emit(scripting.OP_GET_UNIT_VALUE, 0)
		return
	}

	// Check for rand calls
	if strings.HasPrefix(expr, "rand(") {
		inner := expr[5 : len(expr)-1] // strip "rand(" and ")"
		parts := strings.SplitN(inner, ",", 2)
		if len(parts) == 2 {
			c.compileExpression(strings.TrimSpace(parts[0]))
			c.compileExpression(strings.TrimSpace(parts[1]))
			c.emit(scripting.OP_RAND, 0)
			return
		}
	}

	// Check for variable reference
	if idx, ok := c.localIndex[expr]; ok {
		c.emit(scripting.OP_PUSH_LOCAL_VAR, int32(idx))
		return
	}

	if idx, ok := c.staticIndex[expr]; ok {
		c.emit(scripting.OP_PUSH_STATIC, int32(idx))
		return
	}

	// Check for port names
	if portNum := c.getPortNumber(expr); portNum >= 0 {
		c.emit(scripting.OP_PUSH_CONSTANT, int32(portNum))
		return
	}

	// Must be a constant
	if val, err := strconv.Atoi(expr); err == nil {
		c.emit(scripting.OP_PUSH_CONSTANT, int32(val))
		return
	}

	// Try negative numbers
	if strings.HasPrefix(expr, "-") {
		if val, err := strconv.Atoi(expr); err == nil {
			c.emit(scripting.OP_PUSH_CONSTANT, int32(val))
			return
		}
	}

	// Built-in boolean constants.
	switch strings.ToUpper(expr) {
	case "TRUE":
		c.emit(scripting.OP_PUSH_CONSTANT, 1)
		return
	case "FALSE":
		c.emit(scripting.OP_PUSH_CONSTANT, 0)
		return
	}

	// Unknown — emit 0.
	c.emit(scripting.OP_PUSH_CONSTANT, 0)
}

// splitBinaryOp finds a binary operator at parenthesis depth 0, splitting from the right
// (for left-associativity). Returns the operator, left side, right side, and success.
func splitBinaryOp(expr, op string) (string, string, string, bool) {
	if len(expr) < len(op) {
		return "", "", "", false
	}
	depth := 0
	startPos := len(expr) - len(op)
	// Pre-scan trailing characters that the backward scan won't see
	for i := len(expr) - 1; i > startPos; i-- {
		switch expr[i] {
		case ')':
			depth++
		case '(':
			depth--
		}
	}
	// Scan from right to left to find the rightmost occurrence at depth 0
	for i := startPos; i >= 0; i-- {
		ch := expr[i]
		// We're scanning backwards, so ) increases depth and ( decreases
		switch ch {
		case ')':
			depth++
		case '(':
			depth--
		}
		if depth == 0 && expr[i:i+len(op)] == op {
			left := strings.TrimSpace(expr[:i])
			right := strings.TrimSpace(expr[i+len(op):])
			if left != "" && right != "" {
				return op, left, right, true
			}
		}
	}
	return "", "", "", false
}

// getPortNumber returns the port number for a port name
func (c *Compiler) getPortNumber(name string) int {
	ports := map[string]int{
		"ACTIVATION":         1,
		"STANDINGMOVEORDERS": 2,
		"HEALTH":             4,
		"INBUILDSTANCE":      5,
		"BUSY":               6,
		"PIECE_XZ":           7,
		"PIECE_Y":            8,
		"UNIT_XZ":            9,
		"UNIT_Y":             10,
		"UNIT_HEIGHT":        11,
		"XZ_ATAN":            12,
		"XZ_HYPOT":           13,
		"ATAN":               14,
		"HYPOT":              15,
		"GROUND_HEIGHT":      16,
		"BUILD_PERCENT_LEFT": 17,
		"YARD_OPEN":          18,
		"BUGGER_OFF":         19,
		"ARMORED":            20,
	}

	if num, ok := ports[name]; ok {
		return num
	}
	return -1
}

// emit emits an instruction
func parseScriptCall(s string) (name, params string) {
	idx := strings.IndexByte(s, '(')
	if idx < 0 {
		return s, ""
	}
	name = s[:idx]
	// Find matching close paren from the end
	inner := s[idx+1:]
	if len(inner) > 0 && inner[len(inner)-1] == ')' {
		inner = inner[:len(inner)-1]
	}
	return name, strings.TrimSpace(inner)
}

// splitParams splits a comma-separated parameter list respecting parenthesis nesting.
func splitParams(s string) []string {
	if s == "" {
		return nil
	}
	var parts []string
	depth := 0
	start := 0
	for i, ch := range s {
		switch ch {
		case '(':
			depth++
		case ')':
			depth--
		case ',':
			if depth == 0 {
				parts = append(parts, strings.TrimSpace(s[start:i]))
				start = i + 1
			}
		}
	}
	parts = append(parts, strings.TrimSpace(s[start:]))
	return parts
}
