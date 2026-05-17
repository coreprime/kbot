package compiler

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/coreprime/kbot/formats/scripting"
)

func (c *Compiler) compileWaitForTurn(line string) error {
	line = strings.TrimSuffix(strings.TrimSpace(line), ";")

	// Pattern: wait-for-turn piece around axis
	waitRE := regexp.MustCompile(`^wait-for-turn\s+(\w+)\s+around\s+([\w-]+)$`)
	m := waitRE.FindStringSubmatch(line)
	if m == nil {
		return fmt.Errorf("invalid wait-for-turn syntax: %s", line)
	}

	pieceName := m[1]
	axisName := m[2]

	pieceIdx, err := c.getPieceIndex(pieceName)
	if err != nil {
		return err
	}
	axisIdx, err := parseAxis(axisName)
	if err != nil {
		return err
	}

	// Emit WAIT_FOR_TURN with piece# and axis#
	c.emit2(scripting.OP_WAIT_FOR_TURN, int32(pieceIdx), int32(axisIdx))
	return nil
}

// compileWaitForMove compiles wait-for-move statement: wait-for-move piece along axis;
func (c *Compiler) compileWaitForMove(line string) error {
	line = strings.TrimSuffix(strings.TrimSpace(line), ";")

	// Pattern: wait-for-move piece along axis
	waitRE := regexp.MustCompile(`^wait-for-move\s+(\w+)\s+along\s+([\w-]+)$`)
	m := waitRE.FindStringSubmatch(line)
	if m == nil {
		return fmt.Errorf("invalid wait-for-move syntax: %s", line)
	}

	pieceName := m[1]
	axisName := m[2]

	pieceIdx, err := c.getPieceIndex(pieceName)
	if err != nil {
		return err
	}
	axisIdx, err := parseAxis(axisName)
	if err != nil {
		return err
	}

	// Emit WAIT_FOR_MOVE with piece# and axis#
	c.emit2(scripting.OP_WAIT_FOR_MOVE, int32(pieceIdx), int32(axisIdx))
	return nil
}

func (c *Compiler) compileSleep(line string) error {
	line = strings.TrimSuffix(strings.TrimSpace(line), ";")
	expr := strings.TrimSpace(strings.TrimPrefix(line, "sleep"))
	c.compileExpression(expr)
	c.emit(scripting.OP_SLEEP, 0)
	return nil
}
