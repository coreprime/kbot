// Package script is the deterministic COB bytecode virtual machine. A unit's
// compiled BOS script drives its piece animation (walking gaits, rotating
// turrets, opening build yards), weapon aim threads and death sequences; without
// it a unit is an inert model. The VM runs identically on the native authority
// and the wasm client because every operation is integer math through
// engine/fixed and the only entropy source is a seeded engine/rng stream, so two
// engines fed the same script and the same tick sequence evolve bit-identically.
//
// The layering mirrors the rest of the engine: a Program is the immutable,
// shared compiled form of one unit type's script (parsed once from a COB), while
// the mutable per-unit state — threads, static variables, piece animators —
// lives on a Unit owned by a Runtime. sim drives the Runtime through the
// sim.Runtime interface and reads piece transforms through sim.Binding; neither
// requires sim to import this package, keeping the dependency arrow pointing in.
package script

import (
	"fmt"
	"strings"

	"github.com/coreprime/kbot/formats/scripting"
)

// Instruction is one decoded COB instruction in VM-ready form: the 32-bit
// opcode plus its (up to two) inline operands and its byte offset within the
// script's code, which JUMP/JUMP_IF_FALSE targets resolve against.
type Instruction struct {
	Op     uint32
	P1, P2 int32
	Offset uint32
}

// ScriptSource is one named entry point's instruction stream, the input to
// NewProgram. FromCOB produces these from a parsed COB; a future in-tree
// assembler could target the same shape.
type ScriptSource struct {
	Name  string
	Insts []Instruction
}

// scriptDef is a compiled script: its instructions plus a jump-target lookup.
type scriptDef struct {
	name  string
	insts []Instruction
	// offsetIdx maps a jump operand to an instruction index. COB jump targets
	// appear in two encodings depending on the build path — the disassembler's
	// raw byte offset and the compiler's DWORD (byte/4) offset — so both keys
	// point at the same instruction and the JUMP handler stays encoding-agnostic.
	offsetIdx map[uint32]int
}

// Program is the immutable compiled form of one unit type's COB. It is shared
// read-only across every unit instance of that type; all mutable execution
// state lives on Unit.
type Program struct {
	scripts      []scriptDef
	scriptByName map[string]int // lower-cased script name -> index
	pieceNames   []string
	numStatic    int
}

// NewProgram assembles a Program from raw script sources. The piece-name list
// sizes the per-unit animator and visibility tables; numStatic sizes the static
// variable array.
func NewProgram(pieceNames []string, numStatic int, scripts []ScriptSource) *Program {
	p := &Program{
		scriptByName: make(map[string]int, len(scripts)),
		pieceNames:   append([]string(nil), pieceNames...),
		numStatic:    numStatic,
	}
	for i, s := range scripts {
		idx := make(map[uint32]int, len(s.Insts)*2)
		for j, in := range s.Insts {
			idx[in.Offset] = j
			idx[in.Offset>>2] = j
		}
		p.scripts = append(p.scripts, scriptDef{
			name:      s.Name,
			insts:     append([]Instruction(nil), s.Insts...),
			offsetIdx: idx,
		})
		p.scriptByName[strings.ToLower(s.Name)] = i
	}
	return p
}

// FromCOB compiles a parsed COB into a Program by disassembling every script.
func FromCOB(c *scripting.COB) (*Program, error) {
	sources := make([]ScriptSource, 0, c.NumScripts)
	for i := 0; i < int(c.NumScripts); i++ {
		raw, err := c.Disassemble(i)
		if err != nil {
			name := ""
			if i < len(c.ScriptNames) {
				name = c.ScriptNames[i]
			}
			return nil, fmt.Errorf("disassemble script %d (%q): %w", i, name, err)
		}
		insts := make([]Instruction, len(raw))
		for j, in := range raw {
			insts[j] = Instruction{Op: in.Opcode, P1: in.Operand, P2: in.Operand2, Offset: in.Offset}
		}
		name := ""
		if i < len(c.ScriptNames) {
			name = c.ScriptNames[i]
		}
		sources = append(sources, ScriptSource{Name: name, Insts: insts})
	}
	return NewProgram(c.PieceNames, int(c.NumberOfStaticVars), sources), nil
}

// ScriptIndex resolves a script name (case-insensitively) to its index.
func (p *Program) ScriptIndex(name string) (int, bool) {
	i, ok := p.scriptByName[strings.ToLower(name)]
	return i, ok
}

// HasScript reports whether the program defines the named entry point.
func (p *Program) HasScript(name string) bool {
	_, ok := p.scriptByName[strings.ToLower(name)]
	return ok
}

// PieceNames returns the program's piece-name list (rest-pose order).
func (p *Program) PieceNames() []string { return p.pieceNames }
