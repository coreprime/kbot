package cob

import (
	"fmt"
	"io"

	"github.com/coreprime/kbot-io/formats/scripting"
	"github.com/coreprime/kbot-io/formats/scripting/linter"
)

// taCompatFindings runs kbot-io's TA 3.1c compatibility rules over a COB and
// returns one "<script>: <message> [<rule>]" line per finding: TA: Kingdoms
// instructions, words the game does not run, PUSH/POP flags it faults on,
// GET with fewer than five pending values, other stack underflows and more
// than the game's 32 stack slots. A COB that declares the TA: Kingdoms
// version (6) is not checked and yields nothing.
func taCompatFindings(cob *scripting.COB) []string {
	diags := linter.NewWithRules(linter.TACompatRules()...).Lint(cob)
	out := make([]string, 0, len(diags))
	for _, d := range diags {
		where := d.Script
		if where == "" {
			where = "(file)"
		}
		out = append(out, fmt.Sprintf("%s: %s [%s]", where, d.Message, d.Rule))
	}
	return out
}

// reportWarnings prints each warning to w as "warning: ..." and, when strict
// is set and there is at least one, returns an error so the command fails.
func reportWarnings(w io.Writer, warnings []string, strict bool) error {
	for _, msg := range warnings {
		_, _ = fmt.Fprintf(w, "warning: %s\n", msg)
	}
	if strict && len(warnings) > 0 {
		return fmt.Errorf("%d warning%s (--strict)", len(warnings), plural(len(warnings)))
	}
	return nil
}
