package linter

import "fmt"

// ── UnusedPieceRule ────────────────────────────────────────────────────────

type UnusedPieceRule struct{}

func (r *UnusedPieceRule) Name() string { return "unused-piece" }

func (r *UnusedPieceRule) Check(info *FileInfo) []Diagnostic {
	used := make(map[int]bool)
	for _, si := range info.Scripts {
		for idx := range si.UsedPieces {
			used[idx] = true
		}
	}

	var diags []Diagnostic
	for i, name := range info.COB.PieceNames {
		if name == "" {
			continue
		}
		if !used[i] {
			diags = append(diags, Diagnostic{
				Rule:     r.Name(),
				Severity: Warning,
				Line:     info.PieceDeclLine,
				Message:  fmt.Sprintf("piece '%s' [%d] is declared but never used", name, i),
			})
		}
	}
	return diags
}

// ── UnusedStaticRule ───────────────────────────────────────────────────────

type UnusedStaticRule struct{}

func (r *UnusedStaticRule) Name() string { return "unused-static" }

func (r *UnusedStaticRule) Check(info *FileInfo) []Diagnostic {
	numStatics := int(info.COB.NumberOfStaticVars)
	if numStatics == 0 {
		return nil
	}

	used := make(map[int]bool)
	for _, si := range info.Scripts {
		for idx := range si.UsedStatics {
			used[idx] = true
		}
	}

	var diags []Diagnostic
	for i := 0; i < numStatics; i++ {
		if !used[i] {
			diags = append(diags, Diagnostic{
				Rule:     r.Name(),
				Severity: Warning,
				Line:     info.StaticDeclLine,
				Message:  fmt.Sprintf("static variable [%d] is declared but never used", i),
			})
		}
	}
	return diags
}

// ── AlwaysTrueRule ─────────────────────────────────────────────────────────

type AlwaysTrueRule struct{}

func (r *AlwaysTrueRule) Name() string { return "always-true" }

func (r *AlwaysTrueRule) Check(info *FileInfo) []Diagnostic {
	var diags []Diagnostic
	for _, hit := range info.AlwaysTrueLines {
		diags = append(diags, Diagnostic{
			Rule:     r.Name(),
			Severity: Info,
			Script:   hit.Script,
			Line:     hit.Line,
			Message:  "always-true condition (if/while with constant 1)",
		})
	}
	return diags
}

// ── DeadCodeRule ───────────────────────────────────────────────────────────

type DeadCodeRule struct{}

func (r *DeadCodeRule) Name() string { return "dead-code" }

func (r *DeadCodeRule) Check(info *FileInfo) []Diagnostic {
	var diags []Diagnostic
	for _, hit := range info.DeadCodeLines {
		diags = append(diags, Diagnostic{
			Rule:     r.Name(),
			Severity: Warning,
			Script:   hit.Script,
			Line:     hit.Line,
			Message:  "never-true condition (if/while with constant 0) — dead code",
		})
	}
	return diags
}

// ── LongFunctionRule ───────────────────────────────────────────────────────

type LongFunctionRule struct {
	MaxLines int
}

func (r *LongFunctionRule) Name() string { return "long-function" }

func (r *LongFunctionRule) Check(info *FileInfo) []Diagnostic {
	if r.MaxLines <= 0 {
		r.MaxLines = 100
	}

	var diags []Diagnostic
	for _, si := range info.Scripts {
		if si.LineCount > r.MaxLines {
			diags = append(diags, Diagnostic{
				Rule:     r.Name(),
				Severity: Warning,
				Script:   si.Name,
				Line:     info.ScriptStartLines[si.Name],
				Message:  fmt.Sprintf("function is ~%d lines (threshold: %d)", si.LineCount, r.MaxLines),
			})
		}
	}
	return diags
}

// ── UnusedLocalRule ────────────────────────────────────────────────────────

type UnusedLocalRule struct{}

func (r *UnusedLocalRule) Name() string { return "unused-local" }

func (r *UnusedLocalRule) Check(info *FileInfo) []Diagnostic {
	var diags []Diagnostic
	for _, si := range info.Scripts {
		paramCount := info.ScriptParamCount[si.Name]
		for i := 0; i < si.LocalCount; i++ {
			if i < paramCount {
				continue // skip function parameters — unused params are normal
			}
			if !si.UsedLocals[i] {
				diags = append(diags, Diagnostic{
					Rule:     r.Name(),
					Severity: Warning,
					Script:   si.Name,
					Line:     info.ScriptStartLines[si.Name],
					Message:  fmt.Sprintf("local variable [%d] is allocated but never used", i),
				})
			}
		}
	}
	return diags
}

// ── CyclomaticComplexityRule ────────────────────────────────────────────────

// CyclomaticComplexityRule reports scripts whose cyclomatic complexity
// exceeds a threshold. CC is computed as 1 + the number of conditional
// branch instructions (JUMP_IF_FALSE). Each if/while adds one decision point.
type CyclomaticComplexityRule struct {
	MaxComplexity int
}

func (r *CyclomaticComplexityRule) Name() string { return "high-complexity" }

func (r *CyclomaticComplexityRule) Check(info *FileInfo) []Diagnostic {
	if r.MaxComplexity <= 0 {
		r.MaxComplexity = 15
	}

	var diags []Diagnostic
	for _, si := range info.Scripts {
		if si.CyclomaticComplexity > r.MaxComplexity {
			diags = append(diags, Diagnostic{
				Rule:     r.Name(),
				Severity: Warning,
				Script:   si.Name,
				Line:     info.ScriptStartLines[si.Name],
				Message:  fmt.Sprintf("cyclomatic complexity is %d (threshold: %d)", si.CyclomaticComplexity, r.MaxComplexity),
			})
		}
	}
	return diags
}

// ── InvalidCallRule ────────────────────────────────────────────────────────

type InvalidCallRule struct{}

func (r *InvalidCallRule) Name() string { return "invalid-call" }

func (r *InvalidCallRule) Check(info *FileInfo) []Diagnostic {
	var diags []Diagnostic
	for _, si := range info.Scripts {
		seen := make(map[string]bool)
		for _, call := range si.CalledScripts {
			if call.Name == "" || seen[call.Name] {
				continue
			}
			seen[call.Name] = true
			if !info.ScriptNames[call.Name] {
				diags = append(diags, Diagnostic{
					Rule:     r.Name(),
					Severity: Error,
					Script:   si.Name,
					Line:     info.ScriptStartLines[si.Name],
					Message:  fmt.Sprintf("calls non-existent script '%s'", call.Name),
				})
			}
		}
	}
	return diags
}

// ── SpeedZeroRule ──────────────────────────────────────────────────────────

type SpeedZeroRule struct{}

func (r *SpeedZeroRule) Name() string { return "speed-zero" }

func (r *SpeedZeroRule) Check(info *FileInfo) []Diagnostic {
	var diags []Diagnostic
	for _, hit := range info.SpeedZeroLines {
		diags = append(diags, Diagnostic{
			Rule:     r.Name(),
			Severity: Warning,
			Script:   hit.Script,
			Line:     hit.Line,
			Message:  "move/turn with speed <0> — animation never completes, wait-for-* will hang",
		})
	}
	return diags
}

// ── RawSignalRule ──────────────────────────────────────────────────────────

type RawSignalRule struct{}

func (r *RawSignalRule) Name() string { return "raw-signal" }

func (r *RawSignalRule) Check(info *FileInfo) []Diagnostic {
	// Skip on decompiled COBs — the decompiler intentionally emits raw numbers.
	if info.IsDecompiled {
		return nil
	}
	var diags []Diagnostic
	for _, hit := range info.RawSignalLines {
		diags = append(diags, Diagnostic{
			Rule:     r.Name(),
			Severity: Info,
			Script:   hit.Script,
			Line:     hit.Line,
			Message:  "signal/set-signal-mask uses raw number — consider #define SIG_NAME",
		})
	}
	return diags
}

// ── EmptyFunctionRule ──────────────────────────────────────────────────────

type EmptyFunctionRule struct{}

func (r *EmptyFunctionRule) Name() string { return "empty-function" }

func (r *EmptyFunctionRule) Check(info *FileInfo) []Diagnostic {
	var diags []Diagnostic
	for _, hit := range info.EmptyFuncLines {
		diags = append(diags, Diagnostic{
			Rule:     r.Name(),
			Severity: Info,
			Script:   hit.Script,
			Line:     hit.Line,
			Message:  "function body is only 'return 0' — empty implementation",
		})
	}
	return diags
}

// ── DuplicateAnimationRule ─────────────────────────────────────────────────

type DuplicateAnimationRule struct{}

func (r *DuplicateAnimationRule) Name() string { return "duplicate-animation" }

func (r *DuplicateAnimationRule) Check(info *FileInfo) []Diagnostic {
	var diags []Diagnostic
	for _, hit := range info.DuplicateAnimLines {
		diags = append(diags, Diagnostic{
			Rule:     r.Name(),
			Severity: Warning,
			Script:   hit.Script,
			Line:     hit.Line,
			Message:  "identical sequential animation command — second overwrites first",
		})
	}
	return diags
}

// ── SleepOnlyGuardRule ─────────────────────────────────────────────────────

type SleepOnlyGuardRule struct{}

func (r *SleepOnlyGuardRule) Name() string { return "sleep-only-guard" }

func (r *SleepOnlyGuardRule) Check(info *FileInfo) []Diagnostic {
	var diags []Diagnostic
	for _, hit := range info.SleepOnlyGuards {
		diags = append(diags, Diagnostic{
			Rule:     r.Name(),
			Severity: Info,
			Script:   hit.Script,
			Line:     hit.Line,
			Message:  "conditional block contains only a sleep — possible missing animation code",
		})
	}
	return diags
}

// ── UnnamedGlobalRule ──────────────────────────────────────────────────────

type UnnamedGlobalRule struct{}

func (r *UnnamedGlobalRule) Name() string { return "unnamed-global" }

func (r *UnnamedGlobalRule) Check(info *FileInfo) []Diagnostic {
	// Only applies to BOS source, not decompiled COBs (which always have unnamed globals).
	if info.IsDecompiled {
		return nil
	}
	if !info.UnnamedGlobals {
		return nil
	}
	return []Diagnostic{{
		Rule:     r.Name(),
		Severity: Info,
		Script:   "",
		Line:     info.StaticDeclLine,
		Message:  "static-var uses default global_N naming — consider descriptive names",
	}}
}

// ── DuplicateIfRule ────────────────────────────────────────────────────────

type DuplicateIfRule struct{}

func (r *DuplicateIfRule) Name() string { return "duplicate-if" }

func (r *DuplicateIfRule) Check(info *FileInfo) []Diagnostic {
	var diags []Diagnostic
	for _, hit := range info.DuplicateIfLines {
		diags = append(diags, Diagnostic{
			Rule:     r.Name(),
			Severity: Info,
			Script:   hit.Script,
			Line:     hit.Line,
			Message:  "back-to-back identical if condition — blocks could be merged",
		})
	}
	return diags
}

// ── SignalNeverSignalledRule ───────────────────────────────────────────────

type SignalNeverSignalledRule struct{}

func (r *SignalNeverSignalledRule) Name() string { return "signal-never-signalled" }

func (r *SignalNeverSignalledRule) Check(info *FileInfo) []Diagnostic {
	// Collect which signal IDs are actually signalled.
	signalled := make(map[string]bool)
	for _, e := range info.Graph.Edges {
		if e.Type == "signal" {
			signalled[e.To] = true
		}
	}

	// Check which signal IDs have set-signal-mask but no signal.
	var diags []Diagnostic
	for _, e := range info.Graph.Edges {
		if e.Type == "set-mask" && !signalled[e.To] {
			diags = append(diags, Diagnostic{
				Rule:     r.Name(),
				Severity: Warning,
				Script:   e.Script,
				Line:     e.Line,
				Message:  fmt.Sprintf("set-signal-mask for %s but no function ever signals it", e.To),
			})
		}
	}
	return diags
}

// ── RecursiveCallRule ──────────────────────────────────────────────────────

type RecursiveCallRule struct{}

func (r *RecursiveCallRule) Name() string { return "recursive-call" }

func (r *RecursiveCallRule) Check(info *FileInfo) []Diagnostic {
	// Build adjacency list from call-script edges (synchronous calls only).
	adj := make(map[string][]string)
	edgeLines := make(map[string]map[string]int) // from → to → line
	for _, e := range info.Graph.Edges {
		if e.Type == "call" {
			adj[e.From] = append(adj[e.From], e.To)
			if edgeLines[e.From] == nil {
				edgeLines[e.From] = make(map[string]int)
			}
			if edgeLines[e.From][e.To] == 0 {
				edgeLines[e.From][e.To] = e.Line
			}
		}
	}

	// DFS to find cycles from each function.
	var diags []Diagnostic
	reported := make(map[string]bool)

	for start := range adj {
		visited := make(map[string]bool)
		var stack []string

		var dfs func(node string) bool
		dfs = func(node string) bool {
			if node == start && len(stack) > 0 {
				// Found a cycle back to start.
				if !reported[start] {
					reported[start] = true
					path := append(stack, start)
					line := info.ScriptStartLines[start]
					diags = append(diags, Diagnostic{
						Rule:     r.Name(),
						Severity: Warning,
						Script:   start,
						Line:     line,
						Message:  fmt.Sprintf("recursive call-script cycle: %s", formatPath(path)),
					})
				}
				return true
			}
			if visited[node] {
				return false
			}
			visited[node] = true
			stack = append(stack, node)
			for _, next := range adj[node] {
				dfs(next)
			}
			stack = stack[:len(stack)-1]
			return false
		}

		visited[start] = true
		stack = []string{start}
		for _, next := range adj[start] {
			dfs(next)
		}
	}

	return diags
}

func formatPath(path []string) string {
	result := ""
	for i, p := range path {
		if i > 0 {
			result += " → "
		}
		result += p
	}
	return result
}
