package compiler

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/coreprime/kbot/formats/scripting"
)

// TA: Kingdoms statement-level intrinsics.
//
// Syntax:
//
//	dont-shadow(<piece>);                  // disables shadowing for a piece
//	Mission-Command(<sound-name>, <args>); // runs an engine command, dropping result
//
// The math intrinsics __tak_math_09 / __tak_math_0b live inside
// expressions and are handled by compileExpression; see expression.go.
//
// The keyword forms (`dont-shadow`, `Mission-Command`) match Scriptor's
// canonical TAK BOS dialect, so .bos files produced by `kbot cob decompile`
// open in third-party TAK tooling without further edits.

// compileDontShadow handles "dont-shadow(<piece>);"
func (c *Compiler) compileDontShadow(line string) error {
	args, err := stripCallTAK(line, "dont-shadow")
	if err != nil {
		return err
	}
	parts := splitParams(args)
	if len(parts) != 1 {
		return fmt.Errorf("dont-shadow expects 1 argument (piece), got %d", len(parts))
	}
	pieceIdx, err := c.getPieceIndex(strings.TrimSpace(parts[0]))
	if err != nil {
		return err
	}
	c.emit(scripting.OP_DONT_SHADOW, int32(pieceIdx))
	return nil
}

// compileMissionCommandStatement handles a discarded Mission-Command(...) call.
// The call always returns a value; when used as a statement we follow with
// POP_STACK to drop it (matching the original Cavedog bytecode).
func (c *Compiler) compileMissionCommandStatement(line string) error {
	if err := c.compileMissionCommandExpr(strings.TrimSuffix(strings.TrimSpace(line), ";")); err != nil {
		return err
	}
	c.emit(scripting.OP_POP_STACK, 0)
	return nil
}

// compileMissionCommandExpr emits the bytecode for a `Mission-Command(name, args...)`
// expression — push each arg, then emit OP_MISSION_COMMAND with inline
// (soundNameIndex, argCount). The caller is responsible for either consuming
// the result (via assignment / POP_*) or wrapping in
// compileMissionCommandStatement to drop it.
func (c *Compiler) compileMissionCommandExpr(expr string) error {
	args, err := stripCallTAK(expr, "Mission-Command")
	if err != nil {
		return err
	}
	parts := splitParams(args)
	if len(parts) < 1 {
		return fmt.Errorf("Mission-Command requires at least the sound-name argument")
	}
	cmd := strings.TrimSpace(parts[0])
	cmdIdx, err := c.takSoundNameIndex(cmd)
	if err != nil {
		return err
	}
	stackArgs := parts[1:]
	for _, a := range stackArgs {
		c.compileExpression(strings.TrimSpace(a))
	}
	c.emit2(scripting.OP_MISSION_COMMAND, int32(cmdIdx), int32(len(stackArgs)))
	return nil
}

// takSoundNameIndex resolves a `Mission-Command` first-argument token to the
// matching entry in the COB's sound-name table. Accepts either a Go-syntax
// quoted string (the canonical form `kbot cob decompile` emits) or a
// `sound_<N>` placeholder for indices the decompiler couldn't resolve.
func (c *Compiler) takSoundNameIndex(s string) (int, error) {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, `"`) || strings.HasPrefix(s, "`") {
		unq, err := strconv.Unquote(s)
		if err != nil {
			return 0, fmt.Errorf("bad sound-name literal %q: %w", s, err)
		}
		for i, cs := range c.soundNames {
			if cs == unq {
				return i, nil
			}
		}
		return 0, fmt.Errorf("sound name %q not declared (add a `.sound_name %q` directive)", unq, unq)
	}
	if strings.HasPrefix(s, "sound_") {
		idx, err := strconv.Atoi(s[len("sound_"):])
		if err == nil && idx >= 0 {
			return idx, nil
		}
	}
	return 0, fmt.Errorf("Mission-Command sound name must be a quoted string or sound_<N>, got %q", s)
}

// stripCallTAK extracts the argument list from "name(args);".
func stripCallTAK(line, name string) (string, error) {
	line = strings.TrimSuffix(strings.TrimSpace(line), ";")
	prefix := name + "("
	if !strings.HasPrefix(line, prefix) || !strings.HasSuffix(line, ")") {
		return "", fmt.Errorf("expected %s(...) call, got: %s", name, line)
	}
	return line[len(prefix) : len(line)-1], nil
}
