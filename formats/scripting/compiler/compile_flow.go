package compiler

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/coreprime/kbot/formats/scripting"
)

func (c *Compiler) compileBlock(lines []string) error {
	i := 0
	for i < len(lines) {
		line := strings.TrimSpace(lines[i])

		if line == "" || strings.HasPrefix(line, "//") {
			i++
			continue
		}

		// Check statement type
		switch {
		case strings.HasPrefix(line, "return"):
			c.compileReturn(line)

		case strings.HasPrefix(line, "sleep "):
			if err := c.compileSleep(line); err != nil {
				return err
			}

		case strings.HasPrefix(line, "set "):
			if err := c.compileSet(line); err != nil {
				return err
			}

		case strings.HasPrefix(line, "move "):
			if err := c.compileMove(line); err != nil {
				return err
			}

		case strings.HasPrefix(line, "turn "):
			if err := c.compileTurn(line); err != nil {
				return err
			}

		case strings.HasPrefix(line, "spin "):
			if err := c.compileSpin(line); err != nil {
				return err
			}

		case strings.HasPrefix(line, "stop-spin "):
			if err := c.compileStopSpin(line); err != nil {
				return err
			}

		case strings.HasPrefix(line, "hide "):
			if err := c.compileHide(line); err != nil {
				return err
			}

		case strings.HasPrefix(line, "show "):
			if err := c.compileShow(line); err != nil {
				return err
			}

		case strings.HasPrefix(line, "explode "):
			if err := c.compileExplode(line); err != nil {
				return err
			}

		case strings.HasPrefix(line, "emit-sfx "):
			if err := c.compileEmitSfx(line); err != nil {
				return err
			}

		case strings.HasPrefix(line, "cache "):
			if err := c.compileCache(line); err != nil {
				return err
			}

		case strings.HasPrefix(line, "dont-cache "):
			if err := c.compileDontCache(line); err != nil {
				return err
			}

		case strings.HasPrefix(line, "dont-shade "):
			if err := c.compileDontShade(line); err != nil {
				return err
			}

		case strings.HasPrefix(line, "signal "):
			if err := c.compileSignal(line); err != nil {
				return err
			}

		case strings.HasPrefix(line, "set-signal-mask "):
			if err := c.compileSetSignalMask(line); err != nil {
				return err
			}

		case strings.HasPrefix(line, "start-script "):
			if err := c.compileStartScript(line); err != nil {
				return err
			}

		case strings.HasPrefix(line, "call-script "):
			if err := c.compileCallScript(line); err != nil {
				return err
			}

		case strings.HasPrefix(line, "wait-for-turn "):
			if err := c.compileWaitForTurn(line); err != nil {
				return err
			}

		case strings.HasPrefix(line, "attach-unit "):
			if err := c.compileAttachUnit(line); err != nil {
				return err
			}

		case strings.HasPrefix(line, "drop-unit "):
			if err := c.compileDropUnit(line); err != nil {
				return err
			}

		case strings.HasPrefix(line, "wait-for-move "):
			if err := c.compileWaitForMove(line); err != nil {
				return err
			}

		case strings.HasPrefix(line, "while "):
			consumed, err := c.compileWhile(lines[i:])
			if err != nil {
				return err
			}
			i += consumed
			continue

		case strings.HasPrefix(line, "if "):
			consumed, err := c.compileIf(lines[i:])
			if err != nil {
				return err
			}
			i += consumed
			continue

		case containsAssignment(line):
			if err := c.compileAssignment(line); err != nil {
				return err
			}

		default:
			return fmt.Errorf("unknown statement: %s", line)
		}

		i++
	}

	return nil
}

func (c *Compiler) compileReturn(line string) {
	line = strings.TrimSuffix(strings.TrimSpace(line), ";")

	if line == "return" {
		c.emit(scripting.OP_RETURN, 0)
		return
	}

	// Parse return value
	valStr := strings.TrimSpace(strings.TrimPrefix(line, "return"))
	c.compileExpression(valStr)
	c.emit(scripting.OP_RETURN, 0)
}

func (c *Compiler) compileWhile(lines []string) (int, error) {
	// Extract condition
	firstLine := strings.TrimSpace(lines[0])
	condRE := regexp.MustCompile(`^while\s+\((.+)\)\s*$`)
	m := condRE.FindStringSubmatch(firstLine)
	if m == nil {
		return 0, fmt.Errorf("invalid while syntax: %s", firstLine)
	}
	condition := m[1]

	// Find body (between { and })
	if len(lines) < 2 || strings.TrimSpace(lines[1]) != "{" {
		return 0, fmt.Errorf("expected '{' after while")
	}

	depth := 1
	end := 2
	for end < len(lines) && depth > 0 {
		l := strings.TrimSpace(lines[end])
		switch l {
		case "{":
			depth++
		case "}":
			depth--
		}
		end++
	}

	bodyLines := lines[2 : end-1]

	// Compile: loop_start: condition, JUMP_IF_FALSE exit, body, JUMP loop_start
	loopStart := c.currentOffset()

	c.compileExpression(condition)
	jumpExit := c.emitPlaceholder(scripting.OP_JUMP_IF_FALSE)

	if err := c.compileBlock(bodyLines); err != nil {
		return 0, err
	}

	c.emit(scripting.OP_JUMP, int32(loopStart))
	c.patchJump(jumpExit, c.currentOffset())

	return end, nil
}

// compileIf compiles if statement
func (c *Compiler) compileIf(lines []string) (int, error) {
	// Extract condition
	firstLine := strings.TrimSpace(lines[0])
	condRE := regexp.MustCompile(`^if\s+\((.+)\)\s*$`)
	m := condRE.FindStringSubmatch(firstLine)
	if m == nil {
		return 0, fmt.Errorf("invalid if syntax: %s", firstLine)
	}
	condition := m[1]

	// Find then block
	if len(lines) < 2 || strings.TrimSpace(lines[1]) != "{" {
		return 0, fmt.Errorf("expected '{' after if")
	}

	depth := 1
	end := 2
	for end < len(lines) && depth > 0 {
		l := strings.TrimSpace(lines[end])
		switch l {
		case "{":
			depth++
		case "}":
			depth--
		}
		end++
	}

	thenLines := lines[2 : end-1]

	// Compile: condition, JUMP_IF_FALSE else/end, then_body, (JUMP end), else_body
	c.compileExpression(condition)
	jumpElse := c.emitPlaceholder(scripting.OP_JUMP_IF_FALSE)

	if err := c.compileBlock(thenLines); err != nil {
		return 0, err
	}

	// Check for else
	if end < len(lines) && strings.TrimSpace(lines[end]) == "else" {
		jumpEnd := c.emitPlaceholder(scripting.OP_JUMP)
		c.patchJump(jumpElse, c.currentOffset())

		// Find else body
		if end+1 >= len(lines) || strings.TrimSpace(lines[end+1]) != "{" {
			return 0, fmt.Errorf("expected '{' after else")
		}

		depth = 1
		elseStart := end + 2
		elseEnd := elseStart
		for elseEnd < len(lines) && depth > 0 {
			l := strings.TrimSpace(lines[elseEnd])
			switch l {
			case "{":
				depth++
			case "}":
				depth--
			}
			elseEnd++
		}

		elseLines := lines[elseStart : elseEnd-1]
		if err := c.compileBlock(elseLines); err != nil {
			return 0, err
		}
		c.patchJump(jumpEnd, c.currentOffset())

		return elseEnd, nil
	}

	c.patchJump(jumpElse, c.currentOffset())
	return end, nil
}
