package cob

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot-io/formats/scripting"
	"github.com/coreprime/kbot-io/formats/scripting/linter"
	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
)

func newCobLintCommand() *cobra.Command {
	var (
		stream  bool
		quiet   bool
		verbose bool
		ciMode  bool
	)

	cmd := &cobra.Command{
		Use:   "lint [file.cob|directory]",
		Short: "Lint COB files for common issues",
		Long: `Run static analysis on COB bytecode files to detect potential issues
such as unused pieces, dead code, invalid script calls, and more.

Every COB that does not declare the TA: Kingdoms version (6) is also
checked against what TA 3.1c runs (the ta-* rules below, all errors):
the game faults on TA: Kingdoms instructions, on words it does not run
and on PUSH/POP flags it does not accept, and corrupts the script's
stack beyond 32 slots. A file that does not load is reported as a
malformed-cob error.

When given a directory, all .cob files in it are linted.  When no
argument is given (and --stream is not used), the active kbot context
is linted (see 'kbot ctx').  --ci emits SARIF 2.1.0 JSON on stdout
for ingest by GitHub, GitLab, Harness and other code-scanning UIs.

Rules:
` + cobLintRulesHelp(),
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if stream {
				return lintStream(quiet, verbose, ciMode)
			}
			path := ""
			if len(args) > 0 {
				path = args[0]
			}
			resolved, source, err := cli.ResolveVFSPath(path)
			if err != nil {
				return err
			}
			if resolved == "" {
				return fmt.Errorf("provide a .cob file, directory, --stream, or register a kbot context (run `kbot ctx add`)")
			}
			if !ciMode {
				cli.ReportContextSource(source)
			}
			return lintPath(resolved, quiet, verbose, ciMode)
		},
	}

	cmd.Flags().BoolVar(&stream, "stream", false, "Read COB from stdin")
	cmd.Flags().BoolVarP(&quiet, "quiet", "q", false, "Only show summary counts")
	cmd.Flags().BoolVarP(&verbose, "verbose", "v", false, "Show files with zero issues")
	cmd.Flags().BoolVar(&ciMode, "ci", false, "Emit SARIF 2.1.0 JSON on stdout for ingest by GitHub/GitLab/Harness/etc. (quiet stderr)")

	return cmd
}

func lintPath(path string, quiet, verbose, ciMode bool) error {
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("cannot access %s: %w", path, err)
	}

	var files []string
	if info.IsDir() {
		entries, err := os.ReadDir(path)
		if err != nil {
			return fmt.Errorf("cannot read directory: %w", err)
		}
		for _, e := range entries {
			if !e.IsDir() && strings.EqualFold(filepath.Ext(e.Name()), ".cob") {
				files = append(files, filepath.Join(path, e.Name()))
			}
		}
		sort.Strings(files)
		if len(files) == 0 {
			return fmt.Errorf("no .cob files found in %s", path)
		}
	} else {
		files = []string{path}
	}

	l := linter.New()
	totalFiles := 0
	totalDiags := 0
	totalByRule := make(map[string]int)
	hasErrors := false
	// SARIF collector — accumulated when --ci is on so we can emit a
	// single JSON document covering every file the linter scanned.
	var sarifResults []cli.SARIFResult

	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			if !ciMode {
				fmt.Fprintf(os.Stderr, "  ⚠ %s: %v\n", filepath.Base(f), err)
			}
			continue
		}

		diags := lintCOBBytes(l, data)
		totalFiles++
		totalDiags += len(diags)

		for _, d := range diags {
			totalByRule[d.Rule]++
			if d.Severity == linter.Error {
				hasErrors = true
			}
			if ciMode {
				sarifResults = append(sarifResults, cobDiagnosticToSARIF(f, d))
			}
		}

		if !quiet && !ciMode {
			if len(diags) > 0 {
				fmt.Fprintf(os.Stderr, "\n  %s  (%d issue%s)\n", filepath.Base(f), len(diags), plural(len(diags)))
				fmt.Fprint(os.Stderr, linter.FormatDiagnostics(diags))
			} else if verbose {
				fmt.Fprintf(os.Stderr, "  ✅  %s\n", filepath.Base(f))
			}
		}
	}

	if ciMode {
		if err := cli.WriteSARIF(os.Stdout, "kbot cob lint", cobLintRuleCatalogue(), sarifResults); err != nil {
			return fmt.Errorf("encode sarif: %w", err)
		}
		if hasErrors {
			return fmt.Errorf("lint found errors")
		}
		return nil
	}

	// Summary
	fmt.Fprintln(os.Stderr)
	if totalDiags == 0 {
		fmt.Fprintf(os.Stderr, "  ✅  %d file%s linted — no issues found\n\n", totalFiles, plural(totalFiles))
	} else {
		fmt.Fprintf(os.Stderr, "  %d file%s linted, %d issue%s found:\n",
			totalFiles, plural(totalFiles), totalDiags, plural(totalDiags))

		// Sort rules by count descending.
		type rc struct {
			rule  string
			count int
		}
		var sorted []rc
		for r, c := range totalByRule {
			sorted = append(sorted, rc{r, c})
		}
		sort.Slice(sorted, func(i, j int) bool { return sorted[i].count > sorted[j].count })

		for _, rc := range sorted {
			fmt.Fprintf(os.Stderr, "    %-20s %d\n", rc.rule, rc.count)
		}
		fmt.Fprintln(os.Stderr)
	}

	if hasErrors {
		return fmt.Errorf("lint found errors")
	}
	return nil
}

func lintStream(quiet, verbose, ciMode bool) error {
	data, err := cli.ReadInput(nil, true)
	if err != nil {
		return err
	}

	diags := lintCOBBytes(linter.New(), data)

	if ciMode {
		var results []cli.SARIFResult
		for _, d := range diags {
			results = append(results, cobDiagnosticToSARIF("<stdin>", d))
		}
		if err := cli.WriteSARIF(os.Stdout, "kbot cob lint", cobLintRuleCatalogue(), results); err != nil {
			return fmt.Errorf("encode sarif: %w", err)
		}
		for _, d := range diags {
			if d.Severity == linter.Error {
				return fmt.Errorf("lint found errors")
			}
		}
		return nil
	}

	if !quiet {
		if len(diags) > 0 {
			fmt.Fprint(os.Stderr, linter.FormatDiagnostics(diags))
		}
	}
	_ = verbose

	if len(diags) == 0 {
		fmt.Fprintf(os.Stderr, "  ✅  no issues found\n")
	} else {
		fmt.Fprintf(os.Stderr, "\n  %d issue%s found\n", len(diags), plural(len(diags)))
	}

	for _, d := range diags {
		if d.Severity == linter.Error {
			return fmt.Errorf("lint found errors")
		}
	}
	return nil
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// cobLintRule describes one rule of linter.DefaultRules for the help text
// and the SARIF rule catalogue.
type cobLintRule struct {
	name, summary string
}

// cobLintRules lists every rule 'kbot cob lint' runs, in the order the help
// text shows them. TestCobLintRulesCoverDefaultRules keeps it in step with
// kbot-io's linter.DefaultRules.
var cobLintRules = []cobLintRule{
	{"unused-piece", "Piece declared but never used by any animation command."},
	{"unused-static", "Global variable declared but never read or written."},
	{"unused-local", "Local variable allocated but never accessed."},
	{"always-true", "Redundant condition (if/while with constant 1)."},
	{"dead-code", "Impossible condition (if/while with constant 0)."},
	{"long-function", "Function exceeds 100 instruction-lines."},
	{"high-complexity", "Function's cyclomatic complexity exceeds 15."},
	{"invalid-call", "call-script / start-script references a non-existent function."},
	{"speed-zero", "move/turn with speed <0>; the animation never completes."},
	{"empty-function", "Function body is only return 0."},
	{"duplicate-animation", "Two identical animation commands back to back."},
	{"sleep-only-guard", "if block that contains nothing but sleep."},
	{"duplicate-if", "Two if statements with the same condition in a row."},
	{"raw-signal", "signal / set-signal-mask with a raw number instead of a named constant."},
	{"unnamed-global", "Statics still named global_N."},
	{"signal-never-signalled", "Script masks a signal no script sends."},
	{"recursive-call", "call-script cycle."},
	{"duplicate-function", "Two scripts share a name; the game only calls the first."},
	{"malformed-cob", "File does not load, a script's code is truncated, or the reader tolerated damaged tables."},
	{"ta-kingdoms-opcode", "TA: Kingdoms instruction (PLAY_SOUND, MISSION_COMMAND, TAK_MATH_*) in a TA script; TA faults on it."},
	{"ta-unknown-opcode", "Opcode word no game runs; the script faults there."},
	{"ta-push-flags", "PUSH/POP flag the game faults on (PUSH takes 1, 2 or 4; POP takes 2 or 4)."},
	{"ta-stack-limit", "More than the game's 32 stack slots (locals plus pending values)."},
	{"ta-get-arguments", "GET with fewer than 5 pending values; it takes the rest from the function's locals."},
	{"ta-stack-underflow", "Instruction pops more values than are pending, or paths join with different stack depths."},
	{"ta-discard-call", "DISCARD_CALL (0x10063000) with more than 4 arguments; the game's buffer holds 4."},
}

// cobLintRulesHelp renders cobLintRules as the help text's rule table.
func cobLintRulesHelp() string {
	var b strings.Builder
	for _, r := range cobLintRules {
		fmt.Fprintf(&b, "  %-23s %s\n", r.name, r.summary)
	}
	return strings.TrimRight(b.String(), "\n")
}

// cobLintRuleCatalogue is the rule list the cob-lint SARIF run
// advertises: every rule in cobLintRules, prefixed "cob.".
func cobLintRuleCatalogue() []cli.SARIFRule {
	out := make([]cli.SARIFRule, 0, len(cobLintRules))
	for _, r := range cobLintRules {
		out = append(out, cli.SARIFShortRule("cob."+r.name, r.summary))
	}
	return out
}

// lintCOBBytes loads a COB and lints it with l. A file that does not load
// yields a single malformed-cob error instead of being skipped, so a
// directory run and its SARIF output account for it.
func lintCOBBytes(l *linter.Linter, data []byte) []linter.Diagnostic {
	cob, err := scripting.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return []linter.Diagnostic{{
			Rule:     "malformed-cob",
			Severity: linter.Error,
			Message:  fmt.Sprintf("the file does not load: %v", err),
		}}
	}
	return l.Lint(cob)
}

// cobDiagnosticToSARIF converts a single linter diagnostic to a
// SARIF result.  When the linter knows the originating line in the
// decompiled output it lands in physicalLocation.region.startLine
// — close enough for code-scanning UIs to surface the issue inline.
func cobDiagnosticToSARIF(filePath string, d linter.Diagnostic) cli.SARIFResult {
	level := "warning"
	if d.Severity == linter.Error {
		level = "error"
	}
	loc := cli.SARIFLocation{
		PhysicalLocation: cli.SARIFPhysicalLocation{
			ArtifactLocation: cli.SARIFArtifactLocation{URI: filePath},
		},
	}
	if d.Line > 0 {
		loc.PhysicalLocation.Region = &cli.SARIFRegion{StartLine: d.Line}
	}
	msg := d.Message
	if d.Script != "" {
		msg = d.Script + ": " + msg
	}
	return cli.SARIFResult{
		RuleID:    "cob." + d.Rule,
		Level:     level,
		Message:   cli.SARIFMessage{Text: msg},
		Locations: []cli.SARIFLocation{loc},
	}
}
