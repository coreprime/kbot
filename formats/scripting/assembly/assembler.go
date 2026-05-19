package assembly

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"strconv"
	"strings"

	"github.com/coreprime/kbot/formats/scripting"
)

// Assembler converts assembly listings back to COB bytecode.
type Assembler struct {
	version    int
	numStatics int
	pieceNames []string
	soundNames []string // TA: Kingdoms per-COB sound-name table
	scripts    []*assembledScript
}

type assembledScript struct {
	Name         string
	Instructions []scripting.Instruction
}

// NewAssembler creates a new assembler.
func NewAssembler() *Assembler {
	return &Assembler{version: 4}
}

// Assemble parses an assembly listing and produces a COB.
//
// The listing uses structured directives for metadata:
//
//	.version 4
//	.statics 4
//	.piece base
//	.piece turret
//
//	.script Create
//	0000  PUSH_CONST           0
//	0004  RETURN
//
// Comments (lines starting with ; or //) are ignored.
func (a *Assembler) Assemble(text string) (*scripting.COB, error) {
	scanner := bufio.NewScanner(strings.NewReader(text))

	var cur *assembledScript

	for scanner.Scan() {
		line := scanner.Text()

		// Strip box-drawing decoration (annotated format).
		line = strings.NewReplacer(
			"╔", "", "╚", "", "║", "",
			"│", "", "┌", "", "└", "",
			"├", "", "─", "", "═", "",
			"→", "", "↑", "", "▼", "",
		).Replace(line)
		line = strings.TrimSpace(line)

		// Skip blank lines and comments.
		if line == "" || strings.HasPrefix(line, ";") || strings.HasPrefix(line, "//") {
			continue
		}

		// --- directives -----------------------------------------------
		if strings.HasPrefix(line, ".") {
			if err := a.parseDirective(line); err != nil {
				return nil, err
			}
			// A .script directive starts a new script block.
			if strings.HasPrefix(line, ".script ") {
				name := strings.TrimSpace(strings.TrimPrefix(line, ".script"))
				cur = &assembledScript{Name: name}
				a.scripts = append(a.scripts, cur)
			}
			continue
		}

		// --- instruction line -----------------------------------------
		if cur == nil {
			continue // no active script yet
		}

		inst, err := a.parseInstruction(line)
		if err != nil {
			return nil, err
		}
		if inst != nil {
			cur.Instructions = append(cur.Instructions, *inst)
		}
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scan error: %w", err)
	}

	if len(a.scripts) == 0 {
		return nil, fmt.Errorf("no .script directives found in assembly listing")
	}

	return a.buildCOB(), nil
}

// parseDirective handles .version, .statics, .piece, .script.
func (a *Assembler) parseDirective(line string) error {
	parts := strings.SplitN(line, " ", 2)
	directive := parts[0]
	arg := ""
	if len(parts) > 1 {
		arg = strings.TrimSpace(parts[1])
	}

	switch directive {
	case ".version":
		v, err := strconv.Atoi(arg)
		if err != nil {
			return fmt.Errorf("bad .version value %q: %w", arg, err)
		}
		a.version = v

	case ".statics":
		v, err := strconv.Atoi(arg)
		if err != nil {
			return fmt.Errorf("bad .statics value %q: %w", arg, err)
		}
		a.numStatics = v

	case ".sound_name":
		// TA: Kingdoms per-COB sound-name table. The argument is a
		// Go-syntax quoted string (matches what the disassembler emits
		// via `%q`); the writer rebuilds the v6 sub-header and offset
		// table from these on round-trip.
		s, err := strconv.Unquote(arg)
		if err != nil {
			return fmt.Errorf("bad .sound_name value %q: %w", arg, err)
		}
		a.soundNames = append(a.soundNames, s)

	case ".piece":
		if arg == "" {
			return fmt.Errorf(".piece requires a name")
		}
		a.pieceNames = append(a.pieceNames, arg)

	case ".script":
		// Handled by the caller after parseDirective returns.

	default:
		return fmt.Errorf("unknown directive: %s", directive)
	}

	return nil
}

// parseInstruction parses a single instruction line from either format.
//
// Plain:     0008  PUSH_CONST           1
// Annotated: 0008: PUSH_CONST                1  → 0x007C  (0x10066000)
func (a *Assembler) parseInstruction(line string) (*scripting.Instruction, error) {
	// Find the hex offset at the start (with or without trailing colon).
	// Minimum valid: "0000  OPCODE"
	if len(line) < 6 {
		return nil, nil // too short, skip
	}

	// Extract offset: the leading run of hex digits, optionally followed by
	// ':'. The disassembler uses %04X (zero-padded to four digits, but with
	// no upper bound) so files larger than 64 KiB — common in TA: Kingdoms
	// missions — produce 5+ digit offsets that we must parse fully.
	offsetEnd := 0
	for offsetEnd < len(line) && isHexDigit(line[offsetEnd]) {
		offsetEnd++
	}
	if offsetEnd == 0 {
		return nil, nil // line doesn't start with hex digits
	}
	offsetStr := line[:offsetEnd]
	if offsetEnd < len(line) && line[offsetEnd] == ':' {
		offsetEnd++ // consume the optional ':' separator
	}
	offset, err := strconv.ParseUint(offsetStr, 16, 32)
	if err != nil {
		return nil, nil // not an instruction line
	}

	// Remainder after offset and whitespace.
	rest := strings.TrimSpace(line[offsetEnd:])
	if rest == "" {
		return nil, nil
	}

	// Extract opcode name (uppercase + underscores).
	spaceIdx := strings.IndexByte(rest, ' ')
	var opName, operands string
	if spaceIdx < 0 {
		opName = rest
	} else {
		opName = rest[:spaceIdx]
		operands = strings.TrimSpace(rest[spaceIdx+1:])
	}

	opcode, ok := scripting.OpcodeByName(opName)
	if !ok {
		return nil, fmt.Errorf("unknown opcode %q at 0x%04X", opName, offset)
	}

	// Strip trailing annotations before parsing operands:
	//   (0x10021001)    — opcode hex hint
	//   ; -> 0x0300     — plain jump comment
	//   → 0x007C        — annotated jump arrow
	//   ↑ 0x02D8        — annotated loop arrow
	for _, sep := range []string{"(0x", ";", "→", "↑"} {
		if idx := strings.Index(operands, sep); idx >= 0 {
			operands = strings.TrimSpace(operands[:idx])
		}
	}
	// Residual "0xNNNN" after stripped arrow.
	if idx := strings.Index(operands, " 0x"); idx >= 0 {
		operands = strings.TrimSpace(operands[:idx])
	}

	var op1, op2 int32
	if operands != "" {
		fields := strings.Split(operands, ",")
		if len(fields) >= 1 && strings.TrimSpace(fields[0]) != "" {
			op1, err = parseOperand(strings.TrimSpace(fields[0]))
			if err != nil {
				return nil, fmt.Errorf("bad operand %q at 0x%04X: %w", fields[0], offset, err)
			}
		}
		if len(fields) >= 2 && strings.TrimSpace(fields[1]) != "" {
			op2, err = parseOperand(strings.TrimSpace(fields[1]))
			if err != nil {
				return nil, fmt.Errorf("bad operand2 %q at 0x%04X: %w", fields[1], offset, err)
			}
		}
	}

	return &scripting.Instruction{
		Offset:   uint32(offset),
		Opcode:   opcode,
		Operand:  op1,
		Operand2: op2,
	}, nil
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func parseOperand(s string) (int32, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, nil
	}
	if strings.HasPrefix(s, "0x") || strings.HasPrefix(s, "0X") {
		v, err := strconv.ParseInt(s[2:], 16, 32)
		return int32(v), err
	}
	v, err := strconv.ParseInt(s, 10, 32)
	return int32(v), err
}

func (a *Assembler) buildCOB() *scripting.COB {
	var code []byte
	indices := make([]uint32, len(a.scripts))
	names := make([]string, len(a.scripts))

	for i, s := range a.scripts {
		names[i] = s.Name
		indices[i] = uint32(len(code) / 4)

		for _, inst := range s.Instructions {
			code = appendU32(code, inst.Opcode)
			pc := scripting.OpcodeParamCount(inst.Opcode)
			if pc >= 1 {
				code = appendU32(code, uint32(inst.Operand))
			}
			if pc >= 2 {
				code = appendU32(code, uint32(inst.Operand2))
			}
		}
	}

	numScripts := uint32(len(a.scripts))
	numPieces := uint32(len(a.pieceNames))
	codeSize := uint32(len(code))
	headerSize := uint32(44)
	subHeaderSize := uint32(0)
	if a.version == 6 {
		subHeaderSize = 8
	}

	codeOffset := headerSize + subHeaderSize
	scriptCodeIdxOff := codeOffset + codeSize
	scriptNameOff := scriptCodeIdxOff + numScripts*4
	pieceNameOff := scriptNameOff + numScripts*4
	soundNameOff := pieceNameOff + numPieces*4

	return &scripting.COB{
		VersionSignature:              uint32(a.version),
		NumScripts:                    numScripts,
		NumPieces:                     numPieces,
		LengthOfScripts:               codeSize / 4,
		NumberOfStaticVars:            uint32(a.numStatics),
		Code:                          code,
		ScriptCodeIndices:             indices,
		ScriptNames:                   names,
		PieceNames:                    a.pieceNames,
		SoundNames:                    a.soundNames,
		OffsetToScriptCode:            codeOffset,
		OffsetToScriptCodeIndexArray:  scriptCodeIdxOff,
		OffsetToScriptNameOffsetArray: scriptNameOff,
		OffsetToPieceNameOffsetArray:  pieceNameOff,
		// OffsetToNameArray == byte just past the piece-name array
		// (i.e. the sound-name offset table for v6, or string-pool start
		// for v4).
		OffsetToNameArray: soundNameOff,
	}
}

func appendU32(buf []byte, v uint32) []byte {
	b := make([]byte, 4)
	binary.LittleEndian.PutUint32(b, v)
	return append(buf, b...)
}

func isHexDigit(c byte) bool {
	return (c >= '0' && c <= '9') ||
		(c >= 'a' && c <= 'f') ||
		(c >= 'A' && c <= 'F')
}
