package compiler

import (
	"fmt"
	"strings"

	"github.com/coreprime/kbot/formats/scripting"
)

func (c *Compiler) compileStartScript(line string) error {
	line = strings.TrimSuffix(strings.TrimSpace(line), ";")

	// Parse: start-script ScriptName or start-script ScriptName(params...)
	rest := strings.TrimPrefix(line, "start-script ")
	scriptName, paramsStr := parseScriptCall(rest)

	// Look up script index
	scriptIdx, ok := c.scriptIndex[scriptName]
	if !ok {
		return fmt.Errorf("unknown script: %s", scriptName)
	}

	// Parse and push parameters
	paramCount := 0
	if paramsStr != "" {
		params := splitParams(paramsStr)
		for _, p := range params {
			p = strings.TrimSpace(p)
			if p != "" {
				c.compileExpression(p)
				paramCount++
			}
		}
	}

	// Emit START_SCRIPT with script# and param_count
	c.emit2(scripting.OP_START_SCRIPT, int32(scriptIdx), int32(paramCount))
	return nil
}

// compileCallScript compiles call-script statement: call-script ScriptName[(param)];
func (c *Compiler) compileCallScript(line string) error {
	line = strings.TrimSuffix(strings.TrimSpace(line), ";")

	// Parse: call-script ScriptName or call-script ScriptName(params...)
	rest := strings.TrimPrefix(line, "call-script ")
	scriptName, paramsStr := parseScriptCall(rest)

	// Look up script index
	scriptIdx, ok := c.scriptIndex[scriptName]
	if !ok {
		return fmt.Errorf("unknown script: %s", scriptName)
	}

	// Parse and push parameters
	paramCount := 0
	if paramsStr != "" {
		params := splitParams(paramsStr)
		for _, p := range params {
			p = strings.TrimSpace(p)
			if p != "" {
				c.compileExpression(p)
				paramCount++
			}
		}
	}

	// Emit CALL_SCRIPT with script# and param_count
	c.emit2(scripting.OP_CALL_SCRIPT, int32(scriptIdx), int32(paramCount))
	return nil
}

// compileWaitForTurn compiles wait-for-turn statement: wait-for-turn piece around axis;
// compileAttachUnit compiles: attach-unit <uid> to <piece> <flag>;
func (c *Compiler) compileAttachUnit(line string) error {
	line = strings.TrimSuffix(strings.TrimSpace(line), ";")
	// Split on " to " to get uid and rest
	parts := strings.SplitN(strings.TrimPrefix(line, "attach-unit "), " to ", 2)
	if len(parts) != 2 {
		return fmt.Errorf("invalid attach-unit syntax: %s", line)
	}
	uid := strings.TrimSpace(parts[0])
	rest := strings.TrimSpace(parts[1])
	// The last space-separated token is the flag; everything before it is the piece expression
	lastSpace := strings.LastIndex(rest, " ")
	if lastSpace < 0 {
		return fmt.Errorf("invalid attach-unit syntax: %s", line)
	}
	piece := strings.TrimSpace(rest[:lastSpace])
	flag := strings.TrimSpace(rest[lastSpace+1:])

	c.compileExpression(uid)
	c.compileExpression(piece)
	c.compileExpression(flag)
	c.emit(scripting.OP_ATTACH_UNIT, 0)
	return nil
}

// compileDropUnit compiles: drop-unit <uid>;
func (c *Compiler) compileDropUnit(line string) error {
	line = strings.TrimSuffix(strings.TrimSpace(line), ";")
	expr := strings.TrimPrefix(line, "drop-unit ")
	c.compileExpression(expr)
	c.emit(scripting.OP_DROP_UNIT, 0)
	return nil
}
