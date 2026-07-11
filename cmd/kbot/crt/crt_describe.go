package crt

import (
	"fmt"
	"os"
	"sort"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot-io/formats/crt"
)

func newCRTDescribeCommand() *cobra.Command {
	var verbose bool
	cmd := &cobra.Command{
		Use:   "describe <file.crt>",
		Short: "Show a summary of a TA: Kingdoms scenario file",
		Long: `Print the placed-unit table, per-player rule counts and named trigger
regions of a .crt scenario. Multiplayer maps ship an empty stub; campaign
and special maps populate every section.`,
		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			data, err := os.ReadFile(args[0])
			if err != nil {
				return fmt.Errorf("read crt: %w", err)
			}
			f, err := crt.Load(data)
			if err != nil {
				return fmt.Errorf("parse crt: %w", err)
			}

			fmt.Printf("CRT File: %s\n", args[0])
			fmt.Printf("File Size: %d bytes\n\n", len(data))

			fmt.Printf("Summary:\n")
			fmt.Printf("  Units:     %d placed\n", len(f.Units))
			fmt.Printf("  Players:   %d slots, %d rules\n", len(f.Players), f.RuleCount())
			fmt.Printf("  Triggers:  %d regions\n", len(f.Triggers))

			if len(f.Units) > 0 {
				printUnitCounts(f)
			}
			if verbose && len(f.Units) > 0 {
				printUnitDetail(f)
			}
			if len(f.Triggers) > 0 {
				printTriggers(f)
			}
			return nil
		},
	}
	cmd.Flags().BoolVarP(&verbose, "verbose", "v", false, "List every placed unit with its position")
	return cmd
}

func printUnitCounts(f *crt.File) {
	counts := f.UnitCounts()
	type pair struct {
		name  string
		count int
	}
	ps := make([]pair, 0, len(counts))
	for n, c := range counts {
		ps = append(ps, pair{n, c})
	}
	sort.Slice(ps, func(i, j int) bool {
		if ps[i].count != ps[j].count {
			return ps[i].count > ps[j].count
		}
		return ps[i].name < ps[j].name
	})
	fmt.Printf("\nUnit types:\n")
	for _, p := range ps {
		fmt.Printf("  %-24s count=%d\n", p.name, p.count)
	}
}

func printUnitDetail(f *crt.File) {
	fmt.Printf("\nPlacements:\n")
	for i, u := range f.Units {
		name := u.Name
		if name == "" {
			name = "-"
		}
		fmt.Printf("  [%3d] %-20s player=%d pos=(%d,%d,%d) angle=%d hp=%d name=%s\n",
			i, u.Type, u.Player, u.X, u.Y, u.Z, u.Angle, u.HealthPercent, name)
	}
}

func printTriggers(f *crt.File) {
	fmt.Printf("\nTriggers:\n")
	for _, t := range f.Triggers {
		fmt.Printf("  %-24s [L=%d T=%d R=%d B=%d]\n", t.Name, t.Left, t.Top, t.Right, t.Bottom)
	}
}
