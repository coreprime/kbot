package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/filesystem"
	"github.com/coreprime/kbot/formats/tdf"
	"github.com/coreprime/kbot/formats/tnt"
	"github.com/coreprime/kbot/internal/maplint"
)

func newTNTLintCommand() *cobra.Command {
	var (
		similarity float64
		otaPath    string
		vfsRoot    string
		qualityOff bool
	)
	cmd := &cobra.Command{
		Use:   "lint <file.tnt>",
		Short: "Report size-reduction opportunities and quality issues in a TNT map",
		Long: `Inspect a TNT file in two passes:

  Tile-pool diagnostics (mirrors ` + "`kbot tnt optimize`" + ` passes):
    duplicate-tiles  byte-identical tile graphics
    similar-tiles    visually-similar tile graphics whose placements share
                     the same heightmap footprint (configured by --similarity;
                     set to 0 to skip)
    unused-tiles     tile graphics that no map cell references

  Map quality (same rules as Studio's Quality Checker):
    dedupTiles               duplicate tile graphics (matches optimize/lint)
    otaFields                lobby-required metadata missing
    startsInBounds           start positions inside the map + not in void
    schemaSlots              every numplayers value covered by some schema
    metalProximity           metal feature within reach of each start
    voidIslands              passable cells unreachable from any start
    heightDiscontinuities    cliff edges that block ground pathing

The sister .ota is auto-discovered from the .tnt's basename; pass
--ota <path> to override.  --vfs <root> mounts a TA install so the
metal-proximity check can identify metal-producing features.  Pass
--no-quality to skip the quality pass entirely (CI / size-only runs).

The map is not modified.  When at least one issue is reported the
exit code is 1 so the command can be used in CI; clean maps exit 0.`,
		Args:          cobra.ExactArgs(1),
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(_ *cobra.Command, args []string) error {
			path := args[0]
			data, err := os.ReadFile(path)
			if err != nil {
				return fmt.Errorf("read tnt: %w", err)
			}
			m, err := tnt.LoadFromReader(bytes.NewReader(data))
			if err != nil {
				return fmt.Errorf("parse tnt: %w", err)
			}

			// Tile-pool diagnostics first — these are about pure
			// storage efficiency and don't need an OTA or VFS.
			opts := tnt.LintOptions{SimilarityPercent: similarity}
			if similarity > 0 {
				pal, palErr := tntPalette()
				if palErr != nil {
					return palErr
				}
				opts.Palette = pal
			}
			diags, err := m.Lint(opts)
			if err != nil {
				return err
			}

			fmt.Fprintf(os.Stderr, "TNT file:        %s\n", path)
			fmt.Fprintf(os.Stderr, "Tile graphics:   %d\n", len(m.Tiles))
			fmt.Fprintf(os.Stderr, "Map size:        %dx%d cells (%dx%d tiles)\n",
				m.AttrW, m.AttrH, m.TileW, m.TileH)

			tilePoolIssues := len(diags)
			if tilePoolIssues == 0 {
				fmt.Fprintln(os.Stderr)
				fmt.Fprintln(os.Stderr, "  ✅  tile-pool: no issues found")
			} else {
				fmt.Fprintln(os.Stderr)
				fmt.Fprintln(os.Stderr, "  Tile-pool diagnostics:")
				totalCount, totalBytes := 0, 0
				for _, d := range diags {
					icon := severityIcon(d.Severity)
					fmt.Fprintf(os.Stderr, "    %s  %-16s %s\n", icon, d.Rule, d.Message)
					totalCount += d.Count
					totalBytes += d.BytesSaved
				}
				fmt.Fprintf(os.Stderr,
					"    %d tile graphic%s (%d bytes) could be removed by `kbot tnt optimize`.\n",
					totalCount, sIfPlural(totalCount), totalBytes)
			}

			// Quality checks (optional but on by default).
			qualityWarnings := 0
			if !qualityOff {
				in, otaSrc, vfsSrc, qErr := buildMaplintInputFromCLI(path, m, otaPath, vfsRoot)
				if qErr != nil {
					return qErr
				}
				qDiags := maplint.Run(in)
				fmt.Fprintln(os.Stderr)
				fmt.Fprintln(os.Stderr, "  Map quality:")
				if otaSrc != "" {
					fmt.Fprintf(os.Stderr, "    .ota source:   %s\n", otaSrc)
				} else {
					fmt.Fprintln(os.Stderr, "    .ota source:   (none — metadata + schema + start checks will skip)")
				}
				if vfsSrc != "" {
					fmt.Fprintf(os.Stderr, "    Feature VFS:   %s\n", vfsSrc)
				} else {
					fmt.Fprintln(os.Stderr, "    Feature VFS:   (none — metal-proximity check will skip)")
				}
				for _, d := range qDiags {
					icon := maplintIcon(d.Severity)
					fmt.Fprintf(os.Stderr, "    %s  %-24s %s\n", icon, d.ID, d.Message)
					if d.Severity != maplint.SeverityOK {
						qualityWarnings++
					}
				}
			}

			fmt.Fprintln(os.Stderr)
			total := tilePoolIssues + qualityWarnings
			if total == 0 {
				return nil
			}
			return fmt.Errorf("lint found %d issue%s", total, sIfPlural(total))
		},
	}
	cmd.Flags().Float64Var(&similarity, "similarity", 1.0,
		"Mean per-channel pixel-difference threshold (% of 255) for the similar-tiles rule; 0 disables")
	cmd.Flags().StringVar(&otaPath, "ota", "",
		"Path to the sister .ota; defaults to <tnt-basename>.ota next to the .tnt")
	cmd.Flags().StringVar(&vfsRoot, "vfs", "",
		"Mount a TA install (or flattened directory) so the metal-proximity check can recognise metal-producing features. Defaults to the active kbot context if any.")
	cmd.Flags().BoolVar(&qualityOff, "no-quality", false,
		"Skip the map-quality pass; only run tile-pool diagnostics")
	return cmd
}

// buildMaplintInputFromCLI gathers the optional inputs the quality
// pass needs.  Returns the assembled Input plus human-readable
// source labels for the OTA and VFS so the CLI can report what it
// found.  A missing .ota or VFS isn't an error — the relevant
// checks just skip themselves.
func buildMaplintInputFromCLI(tntPath string, m *tnt.Map, otaOverride, vfsRoot string) (maplint.Input, string, string, error) {
	in := maplint.Input{Map: m}

	// OTA: explicit > sibling on disk.
	otaPath := otaOverride
	if otaPath == "" {
		otaPath = strings.TrimSuffix(tntPath, filepath.Ext(tntPath)) + ".ota"
	}
	otaSrc := ""
	if data, err := os.ReadFile(otaPath); err == nil {
		ota, parseErr := maplint.ParseOTA(string(data))
		if parseErr != nil {
			return in, "", "", fmt.Errorf("parse %s: %w", otaPath, parseErr)
		}
		if ota != nil {
			in.OTA = ota
			otaSrc = otaPath
		}
	}

	// Feature placements from the TNT itself.  These are the engine's
	// "Feature" table records — we cross-reference their names with
	// the VFS-provided feature registry for the metal-proximity check.
	if data, err := os.ReadFile(tntPath); err == nil {
		features, _ := m.LoadFeatures(bytes.NewReader(data))
		placements := m.GetFeaturePlacements()
		fs := make([]maplint.FeaturePlacement, 0, len(placements))
		for _, p := range placements {
			if p.FeatureIdx < 0 || p.FeatureIdx >= len(features) {
				continue
			}
			name := strings.TrimSpace(features[p.FeatureIdx].Name)
			if name == "" {
				continue
			}
			fs = append(fs, maplint.FeaturePlacement{Name: name, AX: p.AttrX, AY: p.AttrY})
		}
		in.Features = fs
	}

	// Feature registry from a VFS — explicit > active context.
	resolvedRoot := vfsRoot
	if resolvedRoot == "" {
		path, _, _ := resolveVFSPath("")
		resolvedRoot = path
	}
	vfsSrc := ""
	if resolvedRoot != "" {
		vfs, err := filesystem.NewVirtualFileSystem(resolvedRoot, &filesystem.Config{
			Extensions:        []string{".hpi", ".ccx", ".gp3", ".ufo"},
			ExcludeExtensions: []string{".dll", ".exe", ".ico", ".hlp", ".zip", ".msg", ".dat", ".lnk", ".sdb", ".db", ".ds_store"},
			ExcludePrefixes:   []string{"goggame"},
			SkipErrors:        true,
		})
		if err == nil {
			defer func() { _ = vfs.Close() }()
			reg := scanFeatureRegistry(vfs)
			if len(reg) > 0 {
				in.FeatureRegistry = reg
				vfsSrc = resolvedRoot
			}
		}
	}
	return in, otaSrc, vfsSrc, nil
}

// scanFeatureRegistry walks features/*.tdf in the VFS and returns a
// lowercased-feature-name → metal-yield map.  Used by the quality
// pass's metal-proximity check.
func scanFeatureRegistry(vfs *filesystem.VirtualFileSystem) map[string]int {
	out := map[string]int{}
	for _, p := range vfs.List() {
		lower := strings.ToLower(p)
		if !strings.HasPrefix(lower, "features/") || !strings.HasSuffix(lower, ".tdf") {
			continue
		}
		data, err := vfs.ReadFile(p)
		if err != nil {
			continue
		}
		doc, err := tdf.ParseString(string(data))
		if err != nil {
			continue
		}
		for _, s := range doc.Sections() {
			metal := s.Int("metal")
			if metal > 0 {
				out[strings.ToLower(s.Name())] = metal
			}
		}
	}
	return out
}

func severityIcon(s tnt.LintSeverity) string {
	switch s {
	case tnt.LintWarning:
		return "⚠️"
	default:
		return "ℹ️"
	}
}

func maplintIcon(s maplint.Severity) string {
	switch s {
	case maplint.SeverityError:
		return "❌"
	case maplint.SeverityWarning:
		return "⚠️"
	default:
		return "✅"
	}
}

func sIfPlural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}
