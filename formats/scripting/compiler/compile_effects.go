package compiler

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/coreprime/kbot/formats/scripting"
)

func (c *Compiler) compileExplode(line string) error {
	line = strings.TrimSuffix(strings.TrimSpace(line), ";")

	// Pattern: explode piece type flags
	explodeRE := regexp.MustCompile(`^explode\s+(\w+)\s+type\s+(.+)$`)
	m := explodeRE.FindStringSubmatch(line)
	if m == nil {
		return fmt.Errorf("invalid explode syntax: %s", line)
	}

	pieceName := m[1]
	typeFlags := m[2]

	pieceIdx, err := c.getPieceIndex(pieceName)
	if err != nil {
		return err
	}

	// Parse type flags (e.g., "BITMAP1 | FIRE" or just a number)
	flagValue := 0
	flags := strings.Split(typeFlags, "|")
	for _, flag := range flags {
		flag = strings.TrimSpace(flag)
		switch strings.ToUpper(flag) {
		case "SHATTER":
			flagValue |= 0x01
		case "EXPLODE_ON_HIT":
			flagValue |= 0x02
		case "FALL":
			flagValue |= 0x04
		case "SMOKE":
			flagValue |= 0x08
		case "FIRE":
			flagValue |= 0x10
		case "BITMAPONLY":
			flagValue |= 0x20
		case "BITMAP1":
			flagValue |= 0x100
		case "BITMAP2":
			flagValue |= 0x200
		case "BITMAP3":
			flagValue |= 0x400
		case "BITMAP4":
			flagValue |= 0x800
		case "BITMAP5":
			flagValue |= 0x1000
		default:
			// Try to parse as a number
			if val, err := strconv.Atoi(flag); err == nil {
				flagValue |= val
			} else {
				// It's an expression, compile it
				c.compileExpression(typeFlags)
				c.emit(scripting.OP_EXPLODE, int32(pieceIdx))
				return nil
			}
		}
	}

	// Push flag value onto stack
	c.emit(scripting.OP_PUSH_CONSTANT, int32(flagValue))

	// Emit EXPLODE with piece#
	c.emit(scripting.OP_EXPLODE, int32(pieceIdx))
	return nil
}

// compileEmitSfx compiles emit-sfx statement: emit-sfx type from piece;
func (c *Compiler) compileEmitSfx(line string) error {
	line = strings.TrimSuffix(strings.TrimSpace(line), ";")

	// Pattern: emit-sfx type from piece
	emitRE := regexp.MustCompile(`^emit-sfx\s+(.+?)\s+from\s+(\w+)$`)
	m := emitRE.FindStringSubmatch(line)
	if m == nil {
		return fmt.Errorf("invalid emit-sfx syntax: %s", line)
	}

	sfxType := m[1]
	pieceName := m[2]

	pieceIdx, err := c.getPieceIndex(pieceName)
	if err != nil {
		return err
	}

	// Push sfx type onto stack
	c.compileExpression(sfxType)

	// Emit EMIT_SFX with piece#
	c.emit(scripting.OP_EMIT_SFX, int32(pieceIdx))
	return nil
}
