package compiler

import (
	"encoding/binary"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/coreprime/kbot/formats/scripting"
)

// Compiler compiles BOS source code to scripting.COB bytecode
type Compiler struct {
	source        string
	pieces        map[string]int
	pieceNames    []string
	statics       []string
	staticIndex   map[string]int
	scripts       []*CompiledScript
	scriptIndex   map[string]int
	currentScript *CompiledScript
	localIndex    map[string]int
	paramCount    int

	// COB metadata picked up from optional top-of-file BOS directives.
	// `.version` and `.sound_name "…"` are emitted by
	// `kbot cob decompile` so a TA: Kingdoms v6 .cob round-trips with the
	// right header version and per-COB sound-name table; legacy BOS files
	// without the directives default to TA's v4 layout with no sound
	// names.
	versionOverride int
	soundNames      []string
}

// CompiledScript represents a compiled script
type CompiledScript struct {
	Name   string
	Code   []uint32 // Raw bytecode (opcodes and operands)
	Offset int      // Byte offset in code section
}

// NewCompiler creates a new compiler
func NewCompiler(source string) *Compiler {
	return &Compiler{
		source:      source,
		pieces:      make(map[string]int),
		pieceNames:  []string{},
		statics:     []string{},
		staticIndex: make(map[string]int),
		scripts:     []*CompiledScript{},
		scriptIndex: make(map[string]int),
	}
}

// Compile compiles BOS to scripting.COB
func (c *Compiler) Compile() (*scripting.COB, error) {
	lines := strings.Split(c.source, "\n")

	// Phase 1: Parse declarations
	if err := c.parseDeclarations(lines); err != nil {
		return nil, err
	}

	// Phase 2: Parse and compile functions
	if err := c.compileFunctions(lines); err != nil {
		return nil, err
	}

	// Phase 3: Build scripting.COB structure
	return c.buildCOB(), nil
}

// parseDeclarations extracts piece and static-var declarations, plus the
// optional `.version` / `.extra_header` / `.trailing_data` metadata
// directives the decompiler emits for TA: Kingdoms .cob files.
func (c *Compiler) parseDeclarations(lines []string) error {
	pieceRE := regexp.MustCompile(`^piece\s+(.+);`)
	staticRE := regexp.MustCompile(`^static-var\s+(.+);`)

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "//") {
			continue
		}

		// Metadata directives (lifted from the assembler — see
		// formats/scripting/assembly/assembler.go for the matching
		// surface and rationale).
		if strings.HasPrefix(line, ".") {
			if err := c.parseDirective(line); err != nil {
				return err
			}
			continue
		}

		// Parse pieces (can be comma-separated)
		if m := pieceRE.FindStringSubmatch(line); m != nil {
			pieces := strings.Split(m[1], ",")
			for _, p := range pieces {
				name := strings.TrimSpace(p)
				c.pieces[name] = len(c.pieceNames)
				c.pieceNames = append(c.pieceNames, name)
			}
			continue
		}

		// Parse static vars
		if m := staticRE.FindStringSubmatch(line); m != nil {
			vars := strings.Split(m[1], ",")
			for _, v := range vars {
				v = strings.TrimSpace(v)
				c.staticIndex[v] = len(c.statics)
				c.statics = append(c.statics, v)
			}
			continue
		}
	}

	return nil
}

// parseDirective handles top-of-file BOS directives.
func (c *Compiler) parseDirective(line string) error {
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
		c.versionOverride = v
	case ".sound_name":
		s, err := strconv.Unquote(arg)
		if err != nil {
			return fmt.Errorf("bad .sound_name value %q: %w", arg, err)
		}
		c.soundNames = append(c.soundNames, s)
	case ".statics":
		// Tolerated for symmetry with the assembler form. The actual
		// static count is derived from `static-var` declarations.
	case ".piece":
		// Same — `.piece` is the assembler form; BOS uses `piece a, b;`.
	default:
		return fmt.Errorf("unknown directive: %s", directive)
	}
	return nil
}

// compileFunctions finds and compiles all function definitions
func (c *Compiler) compileFunctions(lines []string) error {
	funcRE := regexp.MustCompile(`^([a-zA-Z_][a-zA-Z0-9_]*)\s*\((.*?)\)\s*$`)

	i := 0
	for i < len(lines) {
		line := strings.TrimSpace(lines[i])

		// Skip declarations, comments, empty
		if line == "" || strings.HasPrefix(line, "//") ||
			strings.HasPrefix(line, "piece ") || strings.HasPrefix(line, "static-var ") {
			i++
			continue
		}

		// Check for function signature
		if m := funcRE.FindStringSubmatch(line); m != nil {
			funcName := m[1]
			paramsStr := m[2]

			// Parse parameters
			params := []string{}
			if paramsStr != "" {
				for _, p := range strings.Split(paramsStr, ",") {
					params = append(params, strings.TrimSpace(p))
				}
			}

			// Expect {
			i++
			if i >= len(lines) || strings.TrimSpace(lines[i]) != "{" {
				return fmt.Errorf("expected '{' after %s()", funcName)
			}

			// Find matching }
			start := i + 1
			depth := 1
			i++
			for i < len(lines) && depth > 0 {
				l := strings.TrimSpace(lines[i])
				switch l {
				case "{":
					depth++
				case "}":
					depth--
				}
				i++
			}
			end := i - 1

			// Compile function
			script, err := c.compileFunction(funcName, params, lines[start:end])
			if err != nil {
				return fmt.Errorf("compiling %s: %w", funcName, err)
			}

			c.scriptIndex[funcName] = len(c.scripts)
			c.scripts = append(c.scripts, script)
			continue
		}

		i++
	}

	return nil
}

// compileFunction compiles a single function body
func (c *Compiler) compileFunction(name string, params []string, bodyLines []string) (*CompiledScript, error) {
	script := &CompiledScript{
		Name: name,
		Code: []uint32{},
	}

	c.currentScript = script
	c.localIndex = make(map[string]int)
	c.paramCount = len(params)

	// Build local variable index (parameters first)
	for i, p := range params {
		c.localIndex[p] = i
	}

	// Parse local var declarations
	varRE := regexp.MustCompile(`^var\s+(.+);`)
	bodyStart := 0
	for idx, line := range bodyLines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "//") {
			bodyStart = idx + 1
			continue
		}

		if m := varRE.FindStringSubmatch(line); m != nil {
			vars := strings.Split(m[1], ",")
			for _, v := range vars {
				v = strings.TrimSpace(v)
				c.localIndex[v] = len(c.localIndex)
			}
			bodyStart = idx + 1
			continue
		}
		break
	}

	// Emit STACK_ALLOC for ALL locals including parameters (matches original TA compiler)
	for i := 0; i < len(c.localIndex); i++ {
		c.emit(scripting.OP_STACK_ALLOC, 0)
	}

	// Compile body
	if err := c.compileBlock(bodyLines[bodyStart:]); err != nil {
		return nil, err
	}

	return script, nil
}

func (c *Compiler) emit(opcode uint32, operand int32) {
	c.currentScript.Code = append(c.currentScript.Code, opcode)

	// Some opcodes don't have operands, but for simplicity we always emit
	if scripting.OpcodeParamCount(opcode) > 0 {
		c.currentScript.Code = append(c.currentScript.Code, uint32(operand))
	}
}

// emit2 emits an opcode with two operands (for opcodes like MOVE_NOW, TURN_NOW)
func (c *Compiler) emit2(opcode uint32, operand1 int32, operand2 int32) {
	c.currentScript.Code = append(c.currentScript.Code, opcode)
	c.currentScript.Code = append(c.currentScript.Code, uint32(operand1))
	c.currentScript.Code = append(c.currentScript.Code, uint32(operand2))
}

// emitPlaceholder emits a jump with placeholder operand, returns index for patching
func (c *Compiler) emitPlaceholder(opcode uint32) int {
	idx := len(c.currentScript.Code)
	c.emit(opcode, 0)
	return idx + 1 // Return operand index
}

// getPieceIndex looks up piece index by symbolic name. As a last resort it
// accepts the synthetic `piece_<N>` placeholders the decompiler emits when
// a referenced index lies past the COB's declared piece-name table — this
// happens in TA: Kingdoms mission COBs where the bytecode references piece
// slots that the script declares no name for.
func (c *Compiler) getPieceIndex(name string) (int, error) {
	if idx, ok := c.pieces[name]; ok {
		return idx, nil
	}
	if strings.HasPrefix(name, "piece_") {
		if idx, err := strconv.Atoi(name[len("piece_"):]); err == nil && idx >= 0 {
			return idx, nil
		}
	}
	return -1, fmt.Errorf("unknown piece: %s", name)
}

// parseAxis converts axis name to index (x-axis=0, y-axis=1, z-axis=2)
func parseAxis(axis string) (int, error) {
	axis = strings.ToLower(strings.TrimSpace(axis))
	switch axis {
	case "x-axis", "x":
		return 0, nil
	case "y-axis", "y":
		return 1, nil
	case "z-axis", "z":
		return 2, nil
	default:
		return -1, fmt.Errorf("invalid axis: %s", axis)
	}
}

// stripAngleBrackets removes < > from expressions like <0> or <1277952>
func stripAngleBrackets(expr string) string {
	expr = strings.TrimSpace(expr)
	if strings.HasPrefix(expr, "<") && strings.HasSuffix(expr, ">") {
		return strings.TrimSpace(expr[1 : len(expr)-1])
	}
	return expr
}

// patchJump patches a jump instruction operand
func (c *Compiler) patchJump(operandIdx int, target int) {
	c.currentScript.Code[operandIdx] = uint32(target)
}

// currentOffset returns current word offset
func (c *Compiler) currentOffset() int {
	return len(c.currentScript.Code)
}

// needsOperand checks if opcode needs an operand

// buildCOB builds the final scripting.COB structure
func (c *Compiler) buildCOB() *scripting.COB {
	// Build script names first
	scriptNames := make([]string, len(c.scripts))
	for i, s := range c.scripts {
		scriptNames[i] = s.Name
	}

	// Build code section
	// First pass: calculate base offsets for each script
	code := []byte{}
	indices := []uint32{}

	for _, script := range c.scripts {
		baseOffset := uint32(len(code) / 4)
		indices = append(indices, baseOffset)

		// Adjust jump operands from script-local to absolute code-section offsets
		for i := 0; i < len(script.Code); i++ {
			opcode := script.Code[i]
			paramCount := scripting.OpcodeParamCount(opcode)
			if (opcode == scripting.OP_JUMP || opcode == scripting.OP_JUMP_IF_FALSE) && i+1 < len(script.Code) {
				// Operand is a script-local word offset — add base to make absolute
				script.Code[i+1] += uint32(baseOffset)
			}
			i += paramCount // Skip operands
		}

		for _, word := range script.Code {
			buf := make([]byte, 4)
			binary.LittleEndian.PutUint32(buf, word)
			code = append(code, buf...)
		}
	}

	// Pick the version: explicit .version directive wins; otherwise
	// preserve TA's historical default of 4. TA: Kingdoms v6 .cob files
	// carry an 8-byte sub-header between the canonical 44-byte header and
	// the code section that the writer reconstructs from the structured
	// fields below.
	version := 4
	if c.versionOverride != 0 {
		version = c.versionOverride
	}
	subHeaderSize := 0
	if version == 6 {
		subHeaderSize = 8
	}

	codeOffset := 44 + subHeaderSize
	scriptCodeIndexOffset := codeOffset + len(code)
	scriptNameOffset := scriptCodeIndexOffset + len(c.scripts)*4
	pieceNameOffset := scriptNameOffset + len(c.scripts)*4
	soundNameOffset := pieceNameOffset + len(c.pieceNames)*4

	return &scripting.COB{
		VersionSignature:   uint32(version),
		NumScripts:         uint32(len(c.scripts)),
		NumPieces:          uint32(len(c.pieceNames)),
		LengthOfScripts:    uint32(len(code) / 4),
		NumberOfStaticVars: uint32(len(c.statics)),
		UKZero:             0,
		// OffsetToNameArray == byte just past the piece-name array
		// (i.e. start of the sound-name offset table for v6, or
		// string-pool start for v4 where there is no sound-name table).
		OffsetToNameArray:             uint32(soundNameOffset),
		Code:                          code,
		ScriptCodeIndices:             indices,
		ScriptNames:                   scriptNames,
		PieceNames:                    c.pieceNames,
		SoundNames:                    c.soundNames,
		OffsetToScriptCode:            uint32(codeOffset),
		OffsetToScriptCodeIndexArray:  uint32(scriptCodeIndexOffset),
		OffsetToScriptNameOffsetArray: uint32(scriptNameOffset),
		OffsetToPieceNameOffsetArray:  uint32(pieceNameOffset),
	}
}

// parseScriptCall splits "ScriptName(param1, param2)" into name and param string.
