// Package sandboxverify wires the sandbox fidelity harness into the CLI:
// `kbot sandbox-verify` runs declarative scenario files against a headless
// sim world built from the real game installs and grades every check
// faithful / wrong / missing / cosmetic-gap against the mechanics specs.
package sandboxverify

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/internal/sandboxverify"
)

// NewCommand builds the sandbox-verify subcommand.
func NewCommand() *cobra.Command {
	var (
		taRoot   string
		takRoot  string
		jsonPath string
		strict   bool
	)
	cmd := &cobra.Command{
		Use:   "sandbox-verify [scenario.yaml|dir ...]",
		Short: "Grade the sandbox sim against the engine mechanics specs",
		Long: `sandbox-verify runs declarative scenario files against a headless sandbox
world built from real game data and grades named observables against
hand-derived expected values from the canonical mechanics specifications.

Each check reports one of:

  faithful      exact integer match with the spec-derived value
  wrong         the mechanic exists but the value diverges
  missing       the mechanic is absent from the sandbox
  cosmetic-gap  divergence the spec classifies as render-only

The sandbox is expected to fail most checks today — the harness is a
measuring instrument, so non-faithful checks do not fail the run unless
--strict is given (the future CI mode).

Scenario tick fields are engine frames (30 Hz, the axis the specs use);
the harness maps them onto the sandbox's own tick rate and reports the
residual time skew per sample.

Asset roots default to the TA_UNPACKED_PATH / TAK_UNPACKED_PATH
environment variables (the flattened installs).`,
		Args: cobra.ArbitraryArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if taRoot == "" {
				taRoot = os.Getenv("TA_UNPACKED_PATH")
			}
			if takRoot == "" {
				takRoot = os.Getenv("TAK_UNPACKED_PATH")
			}
			if len(args) == 0 {
				args = []string{"scenarios/sandbox"}
			}
			var scenarios []*sandboxverify.Scenario
			for _, arg := range args {
				info, err := os.Stat(arg)
				if err != nil {
					return err
				}
				if info.IsDir() {
					batch, err := sandboxverify.LoadDir(arg)
					if err != nil {
						return err
					}
					scenarios = append(scenarios, batch...)
				} else {
					s, err := sandboxverify.Load(arg)
					if err != nil {
						return err
					}
					scenarios = append(scenarios, s)
				}
			}
			if len(scenarios) == 0 {
				return fmt.Errorf("no scenarios found")
			}
			runner := &sandboxverify.Runner{TARoot: taRoot, TAKRoot: takRoot}
			report := runner.Run(scenarios)
			cmd.Print(report.RenderTable())
			if jsonPath != "" {
				if err := report.WriteJSON(jsonPath); err != nil {
					return err
				}
				cmd.Printf("\nJSON report: %s\n", jsonPath)
			}
			if strict && report.AnyNonFaithful() {
				return fmt.Errorf("strict mode: non-faithful checks present")
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&taRoot, "ta-root", "", "flattened TA install (default $TA_UNPACKED_PATH)")
	cmd.Flags().StringVar(&takRoot, "tak-root", "", "flattened TA:K install (default $TAK_UNPACKED_PATH)")
	cmd.Flags().StringVar(&jsonPath, "json", "", "write the machine-readable report to this path")
	cmd.Flags().BoolVar(&strict, "strict", false, "exit non-zero when any check is not faithful")
	return cmd
}
