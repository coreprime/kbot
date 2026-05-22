package main

import (
	"bytes"
	"fmt"
	"os"
	"path"
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

By default the command mounts the active kbot context (` + "`kbot ctx`" + `)
as a virtual filesystem so the .tnt argument can be a bare basename
("metal heck.tnt") or a virtual path ("maps/metal heck.tnt") that
lives inside an HPI archive — sibling .ota lookup and the feature
registry both inherit that VFS.  Pass an absolute path or --vfs
<root> to override.  --no-quality skips the quality pass for
size-only / CI runs.

The map is not modified.  When at least one issue is reported the
exit code is 1 so the command can be used in CI; clean maps exit 0.`,
		Args:          cobra.ExactArgs(1),
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(_ *cobra.Command, args []string) error {
			arg := args[0]

			// Mount the VFS first.  --vfs > active kbot context > nil.
			vfs, vfsLabel, err := openLintVFS(vfsRoot)
			if err != nil {
				return err
			}
			if vfs != nil {
				defer func() { _ = vfs.Close() }()
				reportContextSource(vfsLabel)
			}

			// Resolve the .tnt: local file first, fall back to VFS.
			tntBytes, tntSource, err := readLintInput(arg, vfs)
			if err != nil {
				return err
			}

			m, err := tnt.LoadFromReader(bytes.NewReader(tntBytes))
			if err != nil {
				return fmt.Errorf("parse tnt: %w", err)
			}

			// Tile-pool diagnostics first — pure storage efficiency,
			// no OTA or feature registry required.
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

			fmt.Fprintf(os.Stderr, "TNT file:        %s\n", tntSource)
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

			qualityWarnings := 0
			if !qualityOff {
				in, otaSrc, vfsSrc, qErr := buildMaplintInputFromCLI(arg, tntSource, m, tntBytes, otaPath, vfs, vfsLabel)
				if qErr != nil {
					return qErr
				}
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
				for _, d := range maplint.Run(in) {
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
		"Path to the sister .ota (local or virtual); defaults to <tnt-basename>.ota next to the .tnt")
	cmd.Flags().StringVar(&vfsRoot, "vfs", "",
		"Mount a TA install (or flattened directory) for .tnt / .ota / feature-registry lookups. Defaults to the active kbot context.")
	cmd.Flags().BoolVar(&qualityOff, "no-quality", false,
		"Skip the map-quality pass; only run tile-pool diagnostics")
	return cmd
}

// openLintVFS mounts the right virtual filesystem for a lint invocation.
// Returns nil VFS (and empty label) when neither an explicit --vfs nor
// an active kbot context is configured — the command then only runs
// against local disk.
func openLintVFS(explicit string) (*filesystem.VirtualFileSystem, string, error) {
	root, source, err := resolveVFSPath(explicit)
	if err != nil {
		return nil, "", err
	}
	if root == "" {
		return nil, "", nil
	}
	vfs, err := filesystem.NewVirtualFileSystem(root, &filesystem.Config{
		Extensions:        []string{".hpi", ".ccx", ".gp3", ".ufo"},
		ExcludeExtensions: []string{".dll", ".exe", ".ico", ".hlp", ".zip", ".msg", ".dat", ".lnk", ".sdb", ".db", ".ds_store"},
		ExcludePrefixes:   []string{"goggame"},
		SkipErrors:        true,
	})
	if err != nil {
		return nil, "", fmt.Errorf("mount vfs at %s: %w", root, err)
	}
	return vfs, source, nil
}

// readLintInput returns the bytes of the .tnt the user asked for,
// plus a human-readable source label.  Resolution order: local disk
// (absolute or relative), then virtual-path lookup against the
// mounted VFS, then bare-basename search under maps/ of the VFS.
func readLintInput(arg string, vfs *filesystem.VirtualFileSystem) ([]byte, string, error) {
	// 1. Local disk first — keeps the common "I edited this map
	// outside the install" workflow snappy.
	if info, statErr := os.Stat(arg); statErr == nil && !info.IsDir() {
		data, err := os.ReadFile(arg)
		if err != nil {
			return nil, "", fmt.Errorf("read tnt: %w", err)
		}
		return data, arg, nil
	}
	if vfs == nil {
		return nil, "", fmt.Errorf("read tnt: %q is not a local file and no VFS is mounted (try `kbot ctx add` or pass --vfs)", arg)
	}
	// 2. Exact virtual path.
	if vfs.Exists(arg) && !vfs.IsDir(arg) {
		data, err := vfs.ReadFile(arg)
		if err != nil {
			return nil, "", fmt.Errorf("read tnt from vfs: %w", err)
		}
		return data, "vfs:" + arg, nil
	}
	// 3. Bare basename — search maps/ for a single match.
	if !strings.ContainsAny(arg, "/\\") {
		candidate := "maps/" + strings.ToLower(arg)
		if vfs.Exists(candidate) && !vfs.IsDir(candidate) {
			data, err := vfs.ReadFile(candidate)
			if err != nil {
				return nil, "", fmt.Errorf("read tnt from vfs: %w", err)
			}
			return data, "vfs:" + candidate, nil
		}
		// Walk the VFS once looking for any maps/*.tnt with this basename.
		target := strings.ToLower(arg)
		var hits []string
		for _, p := range vfs.List() {
			lower := strings.ToLower(p)
			if !strings.HasPrefix(lower, "maps/") || !strings.HasSuffix(lower, ".tnt") {
				continue
			}
			if path.Base(lower) == target {
				hits = append(hits, p)
			}
		}
		if len(hits) == 1 {
			data, err := vfs.ReadFile(hits[0])
			if err != nil {
				return nil, "", fmt.Errorf("read tnt from vfs: %w", err)
			}
			return data, "vfs:" + hits[0], nil
		}
		if len(hits) > 1 {
			return nil, "", fmt.Errorf("read tnt: %q matches %d maps in the vfs (%s) — pass a fuller path",
				arg, len(hits), strings.Join(hits, ", "))
		}
	}
	return nil, "", fmt.Errorf("read tnt: %q not found locally or in the mounted vfs", arg)
}

// readSiblingOTA returns the bytes + source label of the sister .ota
// for a TNT, applying the same local-then-VFS lookup order.  Returns
// ("", "", nil) when no .ota is found — that's not an error.
func readSiblingOTA(tntArg, override string, vfs *filesystem.VirtualFileSystem, tntSource string) ([]byte, string) {
	// Explicit --ota wins.
	if override != "" {
		if data, err := os.ReadFile(override); err == nil {
			return data, override
		}
		if vfs != nil && vfs.Exists(override) {
			if data, err := vfs.ReadFile(override); err == nil {
				return data, "vfs:" + override
			}
		}
		return nil, ""
	}
	// Derive the sibling path from the resolved source.  When the TNT
	// came from the VFS, prefer the same VFS slot so we don't have to
	// reach back to local disk.
	if strings.HasPrefix(tntSource, "vfs:") {
		virt := strings.TrimPrefix(tntSource, "vfs:")
		otaPath := strings.TrimSuffix(virt, path.Ext(virt)) + ".ota"
		if vfs != nil && vfs.Exists(otaPath) {
			if data, err := vfs.ReadFile(otaPath); err == nil {
				return data, "vfs:" + otaPath
			}
		}
		return nil, ""
	}
	// Local TNT — look for a sibling on disk.
	otaPath := strings.TrimSuffix(tntArg, filepath.Ext(tntArg)) + ".ota"
	if data, err := os.ReadFile(otaPath); err == nil {
		return data, otaPath
	}
	return nil, ""
}

// buildMaplintInputFromCLI gathers the optional inputs the quality
// pass needs.  Returns the assembled Input plus human-readable
// source labels for the OTA and VFS so the CLI can report what it
// found.  tntSource is the label readLintInput returned, used to
// drive sibling-OTA lookup against the same backing store.
func buildMaplintInputFromCLI(arg, tntSource string, m *tnt.Map, tntBytes []byte, otaOverride string, vfs *filesystem.VirtualFileSystem, vfsLabel string) (maplint.Input, string, string, error) {
	in := maplint.Input{Map: m}

	otaBytes, otaSrc := readSiblingOTA(arg, otaOverride, vfs, tntSource)
	if otaBytes != nil {
		ota, parseErr := maplint.ParseOTA(string(otaBytes))
		if parseErr != nil {
			return in, "", "", fmt.Errorf("parse ota: %w", parseErr)
		}
		if ota != nil {
			in.OTA = ota
		}
	}

	// Feature placements baked into the TNT.
	features, _ := m.LoadFeatures(bytes.NewReader(tntBytes))
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

	// Feature registry comes straight from the mounted VFS.
	vfsSrc := ""
	if vfs != nil {
		if reg := scanFeatureRegistry(vfs); len(reg) > 0 {
			in.FeatureRegistry = reg
			vfsSrc = vfsLabel
		}
	}
	return in, otaSrc, vfsSrc, nil
}

// scanFeatureRegistry walks features/*.tdf in the VFS and returns a
// lowercased-feature-name → metal-yield map.
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
