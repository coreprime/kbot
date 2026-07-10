package sandboxverify

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"
)

// Verdict grades one check.
type Verdict string

const (
	// VerdictFaithful — the sampled value matches the spec-derived integer
	// exactly.
	VerdictFaithful Verdict = "faithful"
	// VerdictWrong — the mechanic exists but its value diverges.
	VerdictWrong Verdict = "wrong"
	// VerdictMissing — the mechanic is absent (unsupported order, unbound
	// observable, or a zero effect where the scenario declares zero = absent).
	VerdictMissing Verdict = "missing"
	// VerdictCosmeticGap — divergence the spec classifies as render-only.
	VerdictCosmeticGap Verdict = "cosmetic-gap"
)

// CheckResult is one graded check.
type CheckResult struct {
	Label      string  `json:"label"`
	Observable string  `json:"observable"`
	Unit       string  `json:"unit,omitempty"`
	Side       *int    `json:"side,omitempty"`
	SpecTick   int     `json:"specTick"`
	SimTick    uint64  `json:"simTick"`
	SkewMs     int64   `json:"skewMs"`
	Expect     int64   `json:"expect"`
	Actual     int64   `json:"actual"`
	Delta      int64   `json:"delta"`
	Verdict    Verdict `json:"verdict"`
	Note       string  `json:"note,omitempty"`
	Derivation string  `json:"derivation"`
}

// ScenarioResult is one scenario's graded run.
type ScenarioResult struct {
	Name        string        `json:"name"`
	Game        string        `json:"game"`
	System      string        `json:"system"`
	Description string        `json:"description,omitempty"`
	Spec        string        `json:"spec,omitempty"`
	Error       string        `json:"error,omitempty"`
	Checks      []CheckResult `json:"checks"`
}

// Report is the machine output for one harness invocation.
type Report struct {
	GeneratedAt time.Time        `json:"generatedAt"`
	SpecTickHz  int              `json:"specTickHz"`
	SimTickHz   int              `json:"simTickHz"`
	TARoot      string           `json:"taRoot,omitempty"`
	TAKRoot     string           `json:"takRoot,omitempty"`
	Scenarios   []ScenarioResult `json:"scenarios"`
	Matrix      []MatrixRow      `json:"matrix"`
}

// MatrixRow is one system × game cell of the gap matrix.
type MatrixRow struct {
	System   string `json:"system"`
	Game     string `json:"game"`
	Faithful int    `json:"faithful"`
	Wrong    int    `json:"wrong"`
	Missing  int    `json:"missing"`
	Cosmetic int    `json:"cosmeticGap"`
}

// BuildMatrix folds check verdicts into system × game counts.
func BuildMatrix(scenarios []ScenarioResult) []MatrixRow {
	type key struct{ system, game string }
	cells := map[key]*MatrixRow{}
	for _, s := range scenarios {
		k := key{s.System, s.Game}
		row, ok := cells[k]
		if !ok {
			row = &MatrixRow{System: s.System, Game: s.Game}
			cells[k] = row
		}
		for _, c := range s.Checks {
			switch c.Verdict {
			case VerdictFaithful:
				row.Faithful++
			case VerdictWrong:
				row.Wrong++
			case VerdictMissing:
				row.Missing++
			case VerdictCosmeticGap:
				row.Cosmetic++
			}
		}
	}
	rows := make([]MatrixRow, 0, len(cells))
	for _, r := range cells {
		rows = append(rows, *r)
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].System != rows[j].System {
			return rows[i].System < rows[j].System
		}
		return rows[i].Game < rows[j].Game
	})
	return rows
}

// AnyNonFaithful reports whether any check graded below faithful (the
// --strict exit condition).
func (r *Report) AnyNonFaithful() bool {
	for _, s := range r.Scenarios {
		if s.Error != "" {
			return true
		}
		for _, c := range s.Checks {
			if c.Verdict != VerdictFaithful {
				return true
			}
		}
	}
	return false
}

// WriteJSON writes the machine report.
func (r *Report) WriteJSON(path string) error {
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o644)
}

// RenderTable renders the human report.
func (r *Report) RenderTable() string {
	var b strings.Builder
	for _, s := range r.Scenarios {
		fmt.Fprintf(&b, "%s  [%s/%s]\n", s.Name, s.Game, s.System)
		if s.Spec != "" {
			fmt.Fprintf(&b, "  spec: %s\n", s.Spec)
		}
		if s.Error != "" {
			fmt.Fprintf(&b, "  ERROR: %s\n\n", s.Error)
			continue
		}
		fmt.Fprintf(&b, "  %-12s %-38s %6s %12s %12s %12s  %s\n",
			"verdict", "check", "tick", "expect", "actual", "delta", "note")
		for _, c := range s.Checks {
			label := c.Label
			if label == "" {
				label = c.Observable
			}
			fmt.Fprintf(&b, "  %-12s %-38s %6d %12d %12d %12d  %s\n",
				c.Verdict, truncate(label, 38), c.SpecTick, c.Expect, c.Actual, c.Delta, c.Note)
		}
		fmt.Fprintf(&b, "\n")
	}
	fmt.Fprintf(&b, "Gap matrix (checks by system × game):\n")
	fmt.Fprintf(&b, "  %-12s %-5s %9s %6s %8s %13s\n", "system", "game", "faithful", "wrong", "missing", "cosmetic-gap")
	var tf, tw, tm, tc int
	for _, row := range r.Matrix {
		fmt.Fprintf(&b, "  %-12s %-5s %9d %6d %8d %13d\n",
			row.System, row.Game, row.Faithful, row.Wrong, row.Missing, row.Cosmetic)
		tf += row.Faithful
		tw += row.Wrong
		tm += row.Missing
		tc += row.Cosmetic
	}
	fmt.Fprintf(&b, "  %-12s %-5s %9d %6d %8d %13d\n", "TOTAL", "", tf, tw, tm, tc)
	return b.String()
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}

// grade applies the verdict rules to one sampled check.
func grade(c CheckSpec, actual int64, sampled bool, note string) (Verdict, string) {
	if !sampled {
		return VerdictMissing, note
	}
	if actual == c.Expect {
		return VerdictFaithful, note
	}
	if c.MissingIfZero && actual == 0 && c.Expect != 0 {
		return VerdictMissing, joinNote(note, "mechanic produced no effect")
	}
	if c.Cosmetic {
		return VerdictCosmeticGap, note
	}
	return VerdictWrong, note
}

func joinNote(a, b string) string {
	switch {
	case a == "":
		return b
	case b == "":
		return a
	default:
		return a + "; " + b
	}
}
