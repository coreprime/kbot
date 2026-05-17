package compiler

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/coreprime/kbot/formats/scripting"
)

func (c *Compiler) compileHide(line string) error {
	line = strings.TrimSuffix(strings.TrimSpace(line), ";")

	// Pattern: hide piece
	hideRE := regexp.MustCompile(`^hide\s+(\w+)$`)
	m := hideRE.FindStringSubmatch(line)
	if m == nil {
		return fmt.Errorf("invalid hide syntax: %s", line)
	}

	pieceName := m[1]
	pieceIdx, err := c.getPieceIndex(pieceName)
	if err != nil {
		return err
	}

	// Emit HIDE with piece#
	c.emit(scripting.OP_HIDE, int32(pieceIdx))
	return nil
}

// compileShow compiles show statement: show piece;
func (c *Compiler) compileShow(line string) error {
	line = strings.TrimSuffix(strings.TrimSpace(line), ";")

	// Pattern: show piece
	showRE := regexp.MustCompile(`^show\s+(\w+)$`)
	m := showRE.FindStringSubmatch(line)
	if m == nil {
		return fmt.Errorf("invalid show syntax: %s", line)
	}

	pieceName := m[1]
	pieceIdx, err := c.getPieceIndex(pieceName)
	if err != nil {
		return err
	}

	// Emit SHOW with piece#
	c.emit(scripting.OP_SHOW, int32(pieceIdx))
	return nil
}

func (c *Compiler) compileCache(line string) error {
	line = strings.TrimSuffix(strings.TrimSpace(line), ";")

	cacheRE := regexp.MustCompile(`^cache\s+(\w+)$`)
	m := cacheRE.FindStringSubmatch(line)
	if m == nil {
		return fmt.Errorf("invalid cache syntax: %s", line)
	}

	pieceName := m[1]
	pieceIdx, err := c.getPieceIndex(pieceName)
	if err != nil {
		return err
	}

	c.emit(scripting.OP_CACHE, int32(pieceIdx))
	return nil
}

// compileDontCache compiles dont-cache statement: dont-cache piece;
func (c *Compiler) compileDontCache(line string) error {
	line = strings.TrimSuffix(strings.TrimSpace(line), ";")

	// Pattern: dont-cache piece
	cacheRE := regexp.MustCompile(`^dont-cache\s+(\w+)$`)
	m := cacheRE.FindStringSubmatch(line)
	if m == nil {
		return fmt.Errorf("invalid dont-cache syntax: %s", line)
	}

	pieceName := m[1]
	pieceIdx, err := c.getPieceIndex(pieceName)
	if err != nil {
		return err
	}

	// Emit DONT_CACHE with piece#
	c.emit(scripting.OP_DONT_CACHE, int32(pieceIdx))
	return nil
}

// compileDontShade compiles dont-shade statement: dont-shade piece;
func (c *Compiler) compileDontShade(line string) error {
	line = strings.TrimSuffix(strings.TrimSpace(line), ";")

	// Pattern: dont-shade piece
	shadeRE := regexp.MustCompile(`^dont-shade\s+(\w+)$`)
	m := shadeRE.FindStringSubmatch(line)
	if m == nil {
		return fmt.Errorf("invalid dont-shade syntax: %s", line)
	}

	pieceName := m[1]
	pieceIdx, err := c.getPieceIndex(pieceName)
	if err != nil {
		return err
	}

	// Emit DONT_SHADE with piece#
	c.emit(scripting.OP_DONT_SHADE, int32(pieceIdx))
	return nil
}
