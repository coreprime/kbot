// Package linter provides static analysis rules for COB/BOS scripts.
package linter

import (
	"fmt"
	"strings"

	"github.com/coreprime/kbot/formats/scripting"
	"github.com/coreprime/kbot/formats/scripting/decompiler"
)

// Severity indicates how serious a diagnostic is.
type Severity int

const (
	Warning Severity = iota
	Error
	Info
)

func (s Severity) String() string {
	switch s {
	case Warning:
		return "warning"
	case Error:
		return "error"
	case Info:
		return "info"
	default:
		return "unknown"
	}
}

// Diagnostic is a single lint finding.
type Diagnostic struct {
	Rule     string   // rule identifier
	Severity Severity
	Script   string   // script name ("" for file-level)
	Message  string
	Line     int      // 1-based line number in the decompiled output (0 = unknown)
}

func (d Diagnostic) String() string {
	loc := d.Script
	if loc == "" {
		loc = "(file)"
	}
	if d.Line > 0 {
		return fmt.Sprintf("[%s] %s:%d: %s", d.Severity, loc, d.Line, d.Message)
	}
	return fmt.Sprintf("[%s] %s: %s", d.Severity, loc, d.Message)
}

// ScriptInfo holds analysis data for a single script.
type ScriptInfo struct {
	Name                 string
	Index                int
	Instructions         []scripting.Instruction
	LineCount            int
	LocalCount           int
	CyclomaticComplexity int
	UsedLocals           map[int]bool
	CalledScripts        []scriptCall
	UsedPieces           map[int]bool
	UsedStatics          map[int]bool
}

type scriptCall struct {
	Name     string
	InstrIdx int
}

// FileInfo holds analysis data for the entire COB file.
type FileInfo struct {
	COB              *scripting.COB
	Scripts          []ScriptInfo
	ScriptNames      map[string]bool
	IsDecompiled     bool           // true when linting decompiled COB output (not raw BOS)
	// Line mappings from decompiled output.
	PieceDeclLine    int            // line of "piece ..." declaration
	StaticDeclLine   int            // line of "static-var ..." declaration
	ScriptStartLines map[string]int // script name → 1-based line
	ScriptParamCount map[string]int // script name → number of parameters (from call sites)
	// Lines where specific patterns occur in the decompiled output.
	AlwaysTrueLines    []decompiledHit // if(1)/while(1) occurrences
	DeadCodeLines      []decompiledHit // if(0)/while(0) occurrences
	SpeedZeroLines     []decompiledHit // move/turn with speed <0>
	EmptyFuncLines     []decompiledHit // functions with only return 0
	SleepOnlyGuards    []decompiledHit // if(x) { sleep N; }
	DuplicateAnimLines []decompiledHit // identical sequential animation commands
	DuplicateIfLines   []decompiledHit // back-to-back identical if conditions
	RawSignalLines     []decompiledHit // signal/set-signal-mask with raw numbers
	UnnamedGlobals     bool            // uses global_N naming
	DecompiledLines    []string        // the full decompiled source lines
	Graph              CallGraph       // call/signal graph
}

type decompiledHit struct {
	Script string
	Line   int
}

// CallGraphEdge represents a relationship between functions/signals.
type CallGraphEdge struct {
	From     string `json:"from"`
	To       string `json:"to"`
	Type     string `json:"type"` // "call", "start", "signal", "set-mask"
	Line     int    `json:"line"`
	Script   string `json:"script"`
}

// CallGraphNode represents a function or signal in the call graph.
type CallGraphNode struct {
	Name string `json:"name"`
	Type string `json:"type"` // "function", "signal"
}

// CallGraph holds the full call/signal graph extracted from source.
type CallGraph struct {
	Nodes []CallGraphNode `json:"nodes"`
	Edges []CallGraphEdge `json:"edges"`
}

// Rule is a lint check that produces zero or more diagnostics.
type Rule interface {
	Name() string
	Check(info *FileInfo) []Diagnostic
}

// Linter runs a set of rules against a COB file.
type Linter struct {
	rules []Rule
}

// New creates a Linter with the default rule set.
func New() *Linter {
	return &Linter{
		rules: []Rule{
			&UnusedPieceRule{},
			&UnusedStaticRule{},
			&AlwaysTrueRule{},
			&DeadCodeRule{},
			&LongFunctionRule{MaxLines: 100},
			&CyclomaticComplexityRule{MaxComplexity: 15},
			&UnusedLocalRule{},
			&InvalidCallRule{},
			&SpeedZeroRule{},
			&EmptyFunctionRule{},
			&DuplicateAnimationRule{},
			&SleepOnlyGuardRule{},
			&DuplicateIfRule{},
			&RawSignalRule{},
			&UnnamedGlobalRule{},
			&SignalNeverSignalledRule{},
			&RecursiveCallRule{},
		},
	}
}

// Lint analyzes a COB file (decompiled) and returns all diagnostics.
func (l *Linter) Lint(cob *scripting.COB) []Diagnostic {
	info := analyze(cob)
	info.IsDecompiled = true

	var diags []Diagnostic
	for _, rule := range l.rules {
		diags = append(diags, rule.Check(info)...)
	}
	return diags
}

// GetCallGraph analyzes a COB file and returns its call graph.
func (l *Linter) GetCallGraph(cob *scripting.COB) *CallGraph {
	info := analyze(cob)
	return &info.Graph
}

// GetCallGraphFromSource analyzes BOS source text and returns its call graph.
func (l *Linter) GetCallGraphFromSource(cob *scripting.COB, sourceText string) *CallGraph {
	info := analyze(cob)
	scanSourcePatterns(info, sourceText)
	return &info.Graph
}

// LintSource analyzes BOS source text (compiled from .bos, not decompiled).
func (l *Linter) LintSource(cob *scripting.COB, sourceText string) []Diagnostic {
	info := analyze(cob)
	info.IsDecompiled = false
	// Re-scan the original source text instead of the decompiled output.
	scanSourcePatterns(info, sourceText)

	var diags []Diagnostic
	for _, rule := range l.rules {
		diags = append(diags, rule.Check(info)...)
	}
	return diags
}

// ── analysis ───────────────────────────────────────────────────────────────

func analyze(cob *scripting.COB) *FileInfo {
	info := &FileInfo{
		COB:              cob,
		ScriptNames:      make(map[string]bool),
		ScriptStartLines: make(map[string]int),
		ScriptParamCount: make(map[string]int),
	}

	for _, name := range cob.ScriptNames {
		if name != "" {
			info.ScriptNames[name] = true
		}
	}

	// Decompile to get the source text and scan it for line mappings.
	buildLineMappings(info, cob)

	// Analyze each script's bytecode for variable/piece usage.
	for i := 0; i < int(cob.NumScripts); i++ {
		name := ""
		if i < len(cob.ScriptNames) {
			name = cob.ScriptNames[i]
		}

		instructions, err := cob.Disassemble(i)
		if err != nil {
			continue
		}

		si := ScriptInfo{
			Name:         name,
			Index:        i,
			Instructions: instructions,
			UsedLocals:   make(map[int]bool),
			UsedPieces:   make(map[int]bool),
			UsedStatics:  make(map[int]bool),
		}

		analyzeScript(&si, cob)
		info.Scripts = append(info.Scripts, si)
	}

	// Determine parameter counts from call sites.
	// CALL_SCRIPT/START_SCRIPT operand2 = param count.
	for _, si := range info.Scripts {
		for _, inst := range si.Instructions {
			if inst.Opcode == scripting.OP_CALL_SCRIPT || inst.Opcode == scripting.OP_START_SCRIPT {
				targetIdx := int(inst.Operand)
				paramCount := int(inst.Operand2)
				if targetIdx >= 0 && targetIdx < len(cob.ScriptNames) {
					name := cob.ScriptNames[targetIdx]
					// Take the maximum seen param count for this function.
					if paramCount > info.ScriptParamCount[name] {
						info.ScriptParamCount[name] = paramCount
					}
				}
			}
		}
	}

	// Also infer from well-known function signatures.
	knownParams := map[string]int{
		"AimPrimary": 2, "AimSecondary": 2, "AimTertiary": 2,
		"AimWeapon1": 2, "AimWeapon2": 2, "AimWeapon3": 2,
		"Killed": 2, "SetMaxReloadTime": 1, "RequestState": 1,
		"setSFXoccupy": 1, "HitByWeapon": 2, "HitByWeaponId": 3,
		"StartBuilding": 2, "QueryBuildInfo": 1,
		"TransportPickup": 1, "TransportDrop": 1,
		"SetDirection": 1, "SetSpeed": 1,
		"TargetCleared": 1, "QueryTransport": 1,
		"BoomCalc": 6, "BoomExtend": 6,
		"FirePrimary": 0, "FireSecondary": 0, "FireTertiary": 0,
	}
	for name, count := range knownParams {
		if info.ScriptNames[name] && info.ScriptParamCount[name] < count {
			info.ScriptParamCount[name] = count
		}
	}

	return info
}

func buildLineMappings(info *FileInfo, cob *scripting.COB) {
	dec := decompiler.NewDecompiler(cob)
	output, err := dec.Decompile()
	if err != nil {
		return
	}
	scanSourcePatterns(info, output)
}

// scanSourcePatterns scans BOS source text for all text-based lint patterns.
func scanSourcePatterns(info *FileInfo, source string) {
	lines := strings.Split(source, "\n")
	info.DecompiledLines = lines
	currentScript := ""
	prevTrimmed := ""
	graphNodeSet := make(map[string]string) // name → type
	var graphEdges []CallGraphEdge
	// Track consecutive identical if conditions by brace depth.
	type ifTracker struct {
		cond  string
		line  int
		depth int
	}
	var ifStack []ifTracker // stack of recent if conditions per depth
	braceDepth := 0

	for lineIdx, line := range lines {
		oneBased := lineIdx + 1
		trimmed := strings.TrimSpace(line)

		// Detect piece and static-var declarations.
		if strings.HasPrefix(trimmed, "piece ") {
			info.PieceDeclLine = oneBased
		}
		if strings.HasPrefix(trimmed, "static-var ") {
			info.StaticDeclLine = oneBased
			// Check for unnamed globals.
			if strings.Contains(trimmed, "global_") {
				info.UnnamedGlobals = true
			}
		}

		// Detect function declarations.
		if idx := strings.Index(trimmed, "("); idx > 0 && !strings.HasPrefix(trimmed, "//") &&
			!strings.HasPrefix(trimmed, "if ") && !strings.HasPrefix(trimmed, "while ") &&
			!strings.HasPrefix(trimmed, "start-script ") && !strings.HasPrefix(trimmed, "call-script ") {
			fnName := trimmed[:idx]
			if isValidIdent(fnName) && info.ScriptNames[fnName] {
				currentScript = fnName
				info.ScriptStartLines[fnName] = oneBased
				graphNodeSet[fnName] = "function"

				// Check for empty function: Name(...)\n{\nreturn 0;\n}
				if lineIdx+3 < len(lines) {
					l1 := strings.TrimSpace(lines[lineIdx+1])
					l2 := strings.TrimSpace(lines[lineIdx+2])
					l3 := strings.TrimSpace(lines[lineIdx+3])
					if l1 == "{" && l2 == "return 0;" && l3 == "}" {
						info.EmptyFuncLines = append(info.EmptyFuncLines, decompiledHit{Script: currentScript, Line: oneBased})
					}
				}
			}
		}

		// Always-true / dead-code conditions.
		if trimmed == "if (1)" || trimmed == "while (1)" {
			info.AlwaysTrueLines = append(info.AlwaysTrueLines, decompiledHit{Script: currentScript, Line: oneBased})
		}
		if trimmed == "if (0)" || trimmed == "while (0)" {
			info.DeadCodeLines = append(info.DeadCodeLines, decompiledHit{Script: currentScript, Line: oneBased})
		}

		// Speed zero: move/turn with speed <0>.
		if (strings.HasPrefix(trimmed, "move ") || strings.HasPrefix(trimmed, "turn ")) &&
			strings.Contains(trimmed, "speed <0>") {
			info.SpeedZeroLines = append(info.SpeedZeroLines, decompiledHit{Script: currentScript, Line: oneBased})
		}

		// Sleep-only guarded block: if (...) { sleep N; }
		if strings.HasPrefix(trimmed, "if (") && lineIdx+3 < len(lines) {
			l1 := strings.TrimSpace(lines[lineIdx+1])
			l2 := strings.TrimSpace(lines[lineIdx+2])
			l3 := strings.TrimSpace(lines[lineIdx+3])
			if l1 == "{" && strings.HasPrefix(l2, "sleep ") && l3 == "}" {
				info.SleepOnlyGuards = append(info.SleepOnlyGuards, decompiledHit{Script: currentScript, Line: oneBased})
			}
		}

		// Duplicate sequential animation: identical move/turn lines back-to-back.
		if (strings.HasPrefix(trimmed, "move ") || strings.HasPrefix(trimmed, "turn ")) &&
			trimmed == prevTrimmed {
			info.DuplicateAnimLines = append(info.DuplicateAnimLines, decompiledHit{Script: currentScript, Line: oneBased})
		}

		// Track brace depth for duplicate-if detection.
		if trimmed == "{" {
			braceDepth++
		}
		if trimmed == "}" {
			braceDepth--
			// When we close a brace, pop any if-tracker at the deeper level.
			for len(ifStack) > 0 && ifStack[len(ifStack)-1].depth > braceDepth {
				ifStack = ifStack[:len(ifStack)-1]
			}
		}

		// Back-to-back identical if conditions at the same brace depth.
		if strings.HasPrefix(trimmed, "if (") && trimmed != "if (1)" && trimmed != "if (0)" {
			// Check if the most recent if at this depth has the same condition.
			if len(ifStack) > 0 {
				top := ifStack[len(ifStack)-1]
				if top.depth == braceDepth && top.cond == trimmed {
					info.DuplicateIfLines = append(info.DuplicateIfLines, decompiledHit{Script: currentScript, Line: oneBased})
				}
			}
			// Push this if onto the stack (replace any at same depth).
			for len(ifStack) > 0 && ifStack[len(ifStack)-1].depth >= braceDepth {
				ifStack = ifStack[:len(ifStack)-1]
			}
			ifStack = append(ifStack, ifTracker{cond: trimmed, line: oneBased, depth: braceDepth})
		}

		// Call graph: call-script / start-script.
		if strings.HasPrefix(trimmed, "call-script ") {
			rest := strings.TrimPrefix(trimmed, "call-script ")
			if idx := strings.Index(rest, "("); idx > 0 {
				target := rest[:idx]
				graphNodeSet[target] = "function"
				graphEdges = append(graphEdges, CallGraphEdge{From: currentScript, To: target, Type: "call", Line: oneBased, Script: currentScript})
			}
		}
		if strings.HasPrefix(trimmed, "start-script ") {
			rest := strings.TrimPrefix(trimmed, "start-script ")
			if idx := strings.Index(rest, "("); idx > 0 {
				target := rest[:idx]
				graphNodeSet[target] = "function"
				graphEdges = append(graphEdges, CallGraphEdge{From: currentScript, To: target, Type: "start", Line: oneBased, Script: currentScript})
			}
		}

		// Call graph: signal / set-signal-mask.
		if strings.HasPrefix(trimmed, "signal ") {
			val := strings.TrimSuffix(strings.TrimPrefix(trimmed, "signal "), ";")
			sigName := "SIG:" + val
			graphNodeSet[sigName] = "signal"
			graphEdges = append(graphEdges, CallGraphEdge{From: currentScript, To: sigName, Type: "signal", Line: oneBased, Script: currentScript})
		}
		if strings.HasPrefix(trimmed, "set-signal-mask ") {
			val := strings.TrimSuffix(strings.TrimPrefix(trimmed, "set-signal-mask "), ";")
			sigName := "SIG:" + val
			graphNodeSet[sigName] = "signal"
			graphEdges = append(graphEdges, CallGraphEdge{From: currentScript, To: sigName, Type: "set-mask", Line: oneBased, Script: currentScript})
		}

		// Raw signal/set-signal-mask with numeric literal.
		if strings.HasPrefix(trimmed, "signal ") && !strings.HasPrefix(trimmed, "signal SIG") {
			// Check if the value after "signal " is a number.
			val := strings.TrimSuffix(strings.TrimPrefix(trimmed, "signal "), ";")
			if len(val) > 0 && val[0] >= '0' && val[0] <= '9' {
				info.RawSignalLines = append(info.RawSignalLines, decompiledHit{Script: currentScript, Line: oneBased})
			}
		}
		if strings.HasPrefix(trimmed, "set-signal-mask ") && !strings.HasPrefix(trimmed, "set-signal-mask SIG") {
			val := strings.TrimSuffix(strings.TrimPrefix(trimmed, "set-signal-mask "), ";")
			if len(val) > 0 && val[0] >= '0' && val[0] <= '9' {
				info.RawSignalLines = append(info.RawSignalLines, decompiledHit{Script: currentScript, Line: oneBased})
			}
		}

		prevTrimmed = trimmed
	}

	// Build call graph — deduplicate edges.
	type edgeKey struct{ from, to, typ string }
	seen := make(map[edgeKey]bool)
	for _, e := range graphEdges {
		k := edgeKey{e.From, e.To, e.Type}
		if !seen[k] {
			seen[k] = true
			info.Graph.Edges = append(info.Graph.Edges, e)
		}
	}
	for name, typ := range graphNodeSet {
		info.Graph.Nodes = append(info.Graph.Nodes, CallGraphNode{Name: name, Type: typ})
	}
}

func isValidIdent(s string) bool {
	if s == "" {
		return false
	}
	for i, ch := range s {
		if i == 0 && !isLetter(ch) {
			return false
		}
		if !isLetter(ch) && !isDigit(ch) {
			return false
		}
	}
	return true
}

func isLetter(ch rune) bool {
	return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch == '_'
}

func isDigit(ch rune) bool {
	return ch >= '0' && ch <= '9'
}

func analyzeScript(si *ScriptInfo, cob *scripting.COB) {
	for _, inst := range si.Instructions {
		switch inst.Opcode {
		case scripting.OP_STACK_ALLOC:
			si.LocalCount++

		case scripting.OP_PUSH_LOCAL_VAR:
			si.UsedLocals[int(inst.Operand)] = true
		case scripting.OP_POP_LOCAL_VAR:
			si.UsedLocals[int(inst.Operand)] = true

		case scripting.OP_PUSH_STATIC:
			si.UsedStatics[int(inst.Operand)] = true
		case scripting.OP_POP_STATIC:
			si.UsedStatics[int(inst.Operand)] = true

		case scripting.OP_CALL_SCRIPT, scripting.OP_START_SCRIPT:
			scriptIdx := int(inst.Operand)
			if scriptIdx >= 0 && scriptIdx < len(cob.ScriptNames) {
				si.CalledScripts = append(si.CalledScripts, scriptCall{
					Name: cob.ScriptNames[scriptIdx],
				})
			}

		case scripting.OP_MOVE, scripting.OP_TURN, scripting.OP_SPIN, scripting.OP_STOP_SPIN,
			scripting.OP_MOVE_NOW, scripting.OP_TURN_NOW,
			scripting.OP_WAIT_FOR_TURN, scripting.OP_WAIT_FOR_MOVE,
			scripting.OP_SHOW, scripting.OP_HIDE,
			scripting.OP_CACHE, scripting.OP_DONT_CACHE, scripting.OP_DONT_SHADE:
			si.UsedPieces[int(inst.Operand)] = true

		case scripting.OP_EXPLODE:
			si.UsedPieces[int(inst.Operand)] = true
		}
	}

	si.LineCount = len(si.Instructions) / 2

	// Cyclomatic complexity: 1 + number of JUMP_IF_FALSE instructions.
	cc := 1
	for _, inst := range si.Instructions {
		if inst.Opcode == scripting.OP_JUMP_IF_FALSE {
			cc++
		}
	}
	si.CyclomaticComplexity = cc
}

// FormatDiagnostics formats diagnostics for human display.
func FormatDiagnostics(diags []Diagnostic) string {
	if len(diags) == 0 {
		return ""
	}

	var sb strings.Builder
	for _, d := range diags {
		icon := "⚠️"
		switch d.Severity {
		case Error:
			icon = "❌"
		case Info:
			icon = "ℹ️"
		}
		loc := d.Script
		if loc == "" {
			loc = "(file)"
		}
		if d.Line > 0 {
			fmt.Fprintf(&sb, "  %s  %-12s %-25s L%-5d %s\n", icon, d.Rule, loc, d.Line, d.Message)
		} else {
			fmt.Fprintf(&sb, "  %s  %-12s %-25s       %s\n", icon, d.Rule, loc, d.Message)
		}
	}
	return sb.String()
}
