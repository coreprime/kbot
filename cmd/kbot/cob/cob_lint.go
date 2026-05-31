package cob

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
	"github.com/coreprime/kbot/formats/scripting"
	"github.com/coreprime/kbot/formats/scripting/linter"
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

When given a directory, all .cob files in it are linted.  When no
argument is given (and --stream is not used), the active kbot context
is linted (see 'kbot ctx').  --ci emits SARIF 2.1.0 JSON on stdout
for ingest by GitHub, GitLab, Harness and other code-scanning UIs.

Rules:
  unused-piece     Piece declared but never used by any animation command
  unused-static    Global variable declared but never read or written
  unused-local     Local variable allocated but never accessed
  always-true      Redundant condition (if/while with constant 1)
  dead-code        Impossible condition (if/while with constant 0)
  long-function    Function exceeds 100 instruction-lines
  invalid-call     call-script/start-script references non-existent function`,
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

		cob, err := scripting.LoadFromReader(bytes.NewReader(data))
		if err != nil {
			if !ciMode {
				fmt.Fprintf(os.Stderr, "  ⚠ %s: parse error: %v\n", filepath.Base(f), err)
			}
			continue
		}

		diags := l.Lint(cob)
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

	cob, err := scripting.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("parse error: %w", err)
	}

	l := linter.New()
	diags := l.Lint(cob)

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

// cobLintRuleCatalogue is the rule list the cob-lint SARIF run
// advertises.  Mirrors the rules listed in the command help text.
func cobLintRuleCatalogue() []cli.SARIFRule {
	return []cli.SARIFRule{
		cli.SARIFShortRule("cob.unused-piece", "Piece declared but never used by any animation command."),
		cli.SARIFShortRule("cob.unused-static", "Global variable declared but never read or written."),
		cli.SARIFShortRule("cob.unused-local", "Local variable allocated but never accessed."),
		cli.SARIFShortRule("cob.always-true", "Redundant condition (if/while with constant 1)."),
		cli.SARIFShortRule("cob.dead-code", "Impossible condition (if/while with constant 0)."),
		cli.SARIFShortRule("cob.long-function", "Function exceeds 100 instruction-lines."),
		cli.SARIFShortRule("cob.invalid-call", "call-script / start-script references a non-existent function."),
	}
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
