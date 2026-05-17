package compiler

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/coreprime/kbot/formats/scripting"
)

func (c *Compiler) compileSignal(line string) error {
	line = strings.TrimSuffix(strings.TrimSpace(line), ";")

	// Pattern: signal value
	signalRE := regexp.MustCompile(`^signal\s+(.+)$`)
	m := signalRE.FindStringSubmatch(line)
	if m == nil {
		return fmt.Errorf("invalid signal syntax: %s", line)
	}

	value := m[1]

	// Push value onto stack
	c.compileExpression(value)

	// Emit SIGNAL
	c.emit(scripting.OP_SIGNAL, 0)
	return nil
}

// compileSetSignalMask compiles set-signal-mask statement: set-signal-mask value;
func (c *Compiler) compileSetSignalMask(line string) error {
	line = strings.TrimSuffix(strings.TrimSpace(line), ";")

	// Pattern: set-signal-mask value
	maskRE := regexp.MustCompile(`^set-signal-mask\s+(.+)$`)
	m := maskRE.FindStringSubmatch(line)
	if m == nil {
		return fmt.Errorf("invalid set-signal-mask syntax: %s", line)
	}

	value := m[1]

	// Push value onto stack
	c.compileExpression(value)

	// Emit SET_SIGNAL_MASK
	c.emit(scripting.OP_SET_SIGNAL_MASK, 0)
	return nil
}
