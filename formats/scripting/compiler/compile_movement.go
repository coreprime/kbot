package compiler

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/coreprime/kbot/formats/scripting"
)

func (c *Compiler) compileMove(line string) error {
	line = strings.TrimSuffix(strings.TrimSpace(line), ";")

	// Check for "now" variant: move building1 to x-axis <0> now
	nowRE := regexp.MustCompile(`^move\s+(\w+)\s+to\s+([\w-]+)\s+(.+)\s+now$`)
	if m := nowRE.FindStringSubmatch(line); m != nil {
		pieceName := m[1]
		axisName := m[2]
		value := stripAngleBrackets(m[3])

		pieceIdx, err := c.getPieceIndex(pieceName)
		if err != nil {
			return err
		}
		axisIdx, err := parseAxis(axisName)
		if err != nil {
			return err
		}

		// Push value onto stack
		c.compileExpression(value)
		// Emit MOVE_NOW with piece# and axis# as separate operands
		c.emit2(scripting.OP_MOVE_NOW, int32(pieceIdx), int32(axisIdx))
		return nil
	}

	// Speed variant: move building1 to x-axis <1277952> speed <speed>
	speedRE := regexp.MustCompile(`^move\s+(\w+)\s+to\s+([\w-]+)\s+(.+?)\s+speed\s+(.+)$`)
	if m := speedRE.FindStringSubmatch(line); m != nil {
		pieceName := m[1]
		axisName := m[2]
		distance := stripAngleBrackets(m[3])
		speed := stripAngleBrackets(m[4])

		pieceIdx, err := c.getPieceIndex(pieceName)
		if err != nil {
			return err
		}
		axisIdx, err := parseAxis(axisName)
		if err != nil {
			return err
		}

		// Push speed first, then distance (stack is LIFO)
		c.compileExpression(speed)
		c.compileExpression(distance)

		// Emit MOVE with piece# and axis# as separate post-data words
		c.emit2(scripting.OP_MOVE, int32(pieceIdx), int32(axisIdx))
		return nil
	}

	return fmt.Errorf("invalid move syntax: %s", line)
}

// compileTurn compiles turn statement: turn piece to axis <angle> [now|speed];
func (c *Compiler) compileTurn(line string) error {
	line = strings.TrimSuffix(strings.TrimSpace(line), ";")

	// Check for "now" variant: turn piece to x-axis <90> now
	nowRE := regexp.MustCompile(`^turn\s+(\w+)\s+to\s+([\w-]+)\s+(.+)\s+now$`)
	if m := nowRE.FindStringSubmatch(line); m != nil {
		pieceName := m[1]
		axisName := m[2]
		angle := stripAngleBrackets(m[3])

		pieceIdx, err := c.getPieceIndex(pieceName)
		if err != nil {
			return err
		}
		axisIdx, err := parseAxis(axisName)
		if err != nil {
			return err
		}

		// Push angle onto stack
		c.compileExpression(angle)
		// Emit TURN_NOW with piece# and axis# as separate operands
		c.emit2(scripting.OP_TURN_NOW, int32(pieceIdx), int32(axisIdx))
		return nil
	}

	// Speed variant: turn piece to x-axis <90> speed <10>
	speedRE := regexp.MustCompile(`^turn\s+(\w+)\s+to\s+([\w-]+)\s+(.+?)(?:\s+speed\s+(.+))?$`)
	if m := speedRE.FindStringSubmatch(line); m != nil {
		pieceName := m[1]
		axisName := m[2]
		angle := stripAngleBrackets(m[3])
		speed := m[4]
		if speed != "" {
			speed = stripAngleBrackets(speed)
		}

		pieceIdx, err := c.getPieceIndex(pieceName)
		if err != nil {
			return err
		}
		axisIdx, err := parseAxis(axisName)
		if err != nil {
			return err
		}

		// Stack order: speed pushed first (deeper), then angle (top)
		if speed != "" {
			c.compileExpression(speed)
		} else {
			c.emit(scripting.OP_PUSH_CONSTANT, 0)
		}
		c.compileExpression(angle)

		// Emit TURN with piece# and axis# as separate post-data words
		c.emit2(scripting.OP_TURN, int32(pieceIdx), int32(axisIdx))
		return nil
	}

	return fmt.Errorf("invalid turn syntax: %s", line)
}

// compileSpin compiles spin statement: spin piece around axis speed <speed> accelerate <accel>;
func (c *Compiler) compileSpin(line string) error {
	line = strings.TrimSuffix(strings.TrimSpace(line), ";")

	// Pattern: spin piece around axis speed <speed> [accelerate <accel>]
	spinRE := regexp.MustCompile(`^spin\s+(\w+)\s+around\s+([\w-]+)\s+speed\s+(.+?)(?:\s+accelerate\s+(.+))?$`)
	m := spinRE.FindStringSubmatch(line)
	if m == nil {
		return fmt.Errorf("invalid spin syntax: %s", line)
	}

	pieceName := m[1]
	axisName := m[2]
	speed := stripAngleBrackets(m[3])
	accel := "0"
	if m[4] != "" {
		accel = stripAngleBrackets(m[4])
	}

	pieceIdx, err := c.getPieceIndex(pieceName)
	if err != nil {
		return err
	}
	axisIdx, err := parseAxis(axisName)
	if err != nil {
		return err
	}

	// Stack order: accelerate pushed first, then speed (LIFO)
	c.compileExpression(accel)
	c.compileExpression(speed)

	// Emit SPIN with piece# and axis# as separate post-data words
	c.emit2(scripting.OP_SPIN, int32(pieceIdx), int32(axisIdx))
	return nil
}

// compileStopSpin compiles stop-spin statement: stop-spin piece around axis decelerate <value>;
func (c *Compiler) compileStopSpin(line string) error {
	line = strings.TrimSuffix(strings.TrimSpace(line), ";")

	// Pattern: stop-spin piece around axis [decelerate <value>]
	stopSpinRE := regexp.MustCompile(`^stop-spin\s+(\w+)\s+around\s+([\w-]+)(?:\s+decelerate\s+(.+))?$`)
	m := stopSpinRE.FindStringSubmatch(line)
	if m == nil {
		return fmt.Errorf("invalid stop-spin syntax: %s", line)
	}

	pieceName := m[1]
	axisName := m[2]
	decel := "0"
	if m[3] != "" {
		decel = stripAngleBrackets(m[3])
	}

	pieceIdx, err := c.getPieceIndex(pieceName)
	if err != nil {
		return err
	}
	axisIdx, err := parseAxis(axisName)
	if err != nil {
		return err
	}

	// Push deceleration value onto stack
	c.compileExpression(decel)

	// Emit STOP_SPIN with piece# and axis# as separate post-data words
	c.emit2(scripting.OP_STOP_SPIN, int32(pieceIdx), int32(axisIdx))
	return nil
}
