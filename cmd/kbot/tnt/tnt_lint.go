package tnt

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path"
	"strings"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot-io/filesystem"
	"github.com/coreprime/kbot-io/formats/tnt"
	"github.com/coreprime/kbot-io/maplint"
	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
	"github.com/coreprime/kbot/internal/mapmeta"
)

func newTNTLintCommand() *cobra.Command {
	var (
		similarity float64
		otaPath    string
		vfsRoot    string
		qualityOff bool
		ciMode     bool
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

  Map data (how the game reads the map):
    bad-tile-index      tile map cells naming a tile beyond the tile set
                        (the game reads past its tile set there)
    unresolved-feature  cells whose feature word names no entry of the
                        feature table (the game places nothing there)
    interchange-bounds  maps larger than other tools accept
    minimap             no stored minimap, or one too small for the radar

  Map quality (same rules as Studio's Quality Checker):
    dedupTiles               duplicate tile graphics (matches optimize/lint)
    otaFields                lobby-required metadata missing
    startsInBounds           start positions inside the map + not in void
    schemaSlots              every numplayers value covered by the schema
                             the game picks for it (Network 1..4 schemas,
                             read from Schema 0 up to the first gap)
    metalProximity           metal feature within reach of each start
                             (feature metal read as the game stores it)
    voidIslands              passable cells unreachable from any start
    heightDiscontinuities    cliff edges that block ground pathing

By default the command mounts the active kbot context (` + "`kbot ctx`" + `)
as a virtual filesystem so the .tnt argument can be a bare basename
("metal heck.tnt"), a virtual path ("maps/metal heck.tnt"), or a
cwd-relative path ("./local-edit.tnt") — sibling .ota lookup and the
feature registry both inherit that VFS.  Pass --vfs <root> to
override.  --no-quality skips the quality pass for size-only / CI
runs.  --ci emits SARIF 2.1.0 JSON on stdout for ingest by GitHub,
GitLab, Harness and other code-scanning UIs.

The map is not modified.  When at least one issue is reported the
exit code is 1 so the command can be used in CI; clean maps exit 0.`,
		Args:          cobra.ExactArgs(1),
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			arg := args[0]

			// Mount the VFS first — --vfs > active kbot context.
			vfs, vfsLabel, err := openLintVFS(vfsRoot)
			if err != nil {
				return err
			}
			if vfs != nil {
				defer func() { _ = vfs.Close() }()
				if !ciMode {
					cli.ReportContextSource(vfsLabel)
				}
			}

			hit, err := cli.ResolveVFSInput(arg, vfs, ".tnt", []string{"maps/"})
			if err != nil {
				return err
			}
			m, err := tnt.LoadFromReader(bytes.NewReader(hit.Data))
			if err != nil {
				return fmt.Errorf("parse tnt: %w", err)
			}
			if m.IsTAK {
				return fmt.Errorf("TA: Kingdoms maps are texture-mapped and have no tile pool; the lint rules are TA-specific (use 'kbot tnt describe' to inspect)")
			}

			// Tile-pool diagnostics first — pure storage efficiency,
			// no OTA or feature registry required.
			opts := tnt.LintOptions{SimilarityPercent: similarity}
			if similarity > 0 {
				pal, palErr := cli.TNTPalette()
				if palErr != nil {
					return palErr
				}
				opts.Palette = pal
			}
			poolDiags, err := m.Lint(opts)
			if err != nil {
				return err
			}

			// Quality diagnostics (optional but on by default).
			var qualityDiags []maplint.Diagnostic
			var otaSrc string
			if !qualityOff {
				in, srcOTA, _, qErr := buildMaplintInputFromCLI(arg, hit, m, otaPath, vfs)
				if qErr != nil {
					return qErr
				}
				otaSrc = srcOTA
				qualityDiags = maplint.Run(in)
			}

			if ciMode {
				return emitTNTLintSARIF(cmd.OutOrStdout(), hit, poolDiags, qualityDiags)
			}
			return printTNTLintHuman(cmd.ErrOrStderr(), hit, m, poolDiags, qualityDiags, otaSrc, vfsLabel, qualityOff)
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
	cmd.Flags().BoolVar(&ciMode, "ci", false,
		"Emit SARIF 2.1.0 JSON on stdout for ingest by GitHub/GitLab/Harness/etc. (quiet stderr)")
	return cmd
}

// printTNTLintHuman writes the friendly stderr output the interactive
// user sees.  Quality-pass sources are already shown in the header,
// so we don't repeat them in the rule listing.
func printTNTLintHuman(w io.Writer, hit *cli.VFSInputHit, m *tnt.Map, poolDiags []tnt.LintDiagnostic, qualityDiags []maplint.Diagnostic, otaSrc, vfsLabel string, qualityOff bool) error {
	reportf(w, "TNT file:        %s\n", hit.Source)
	reportf(w, "Tile graphics:   %d\n", len(m.Tiles))
	reportf(w, "Map size:        %dx%d cells (%dx%d tiles)\n",
		m.AttrW, m.AttrH, m.TileW, m.TileH)
	if !qualityOff {
		if otaSrc != "" {
			reportf(w, ".ota source:     %s\n", otaSrc)
		} else {
			reportf(w, ".ota source:     (none — metadata + schema + start checks will skip)\n")
		}
		if vfsLabel != "" {
			reportf(w, "Feature VFS:     %s\n", vfsLabel)
		}
	}

	// Tile-pool diagnostics — always render a row per rule with the
	// finding count as the leading column.  The previous ℹ glyph was
	// easily misread as the digit 1, so each row's left column is now
	// the count itself (0 when the rule is clean), making the column
	// self-describing.
	issueCount := 0
	byRule := make(map[string]tnt.LintDiagnostic, len(poolDiags))
	for _, d := range poolDiags {
		byRule[d.Rule] = d
	}
	reportf(w, "\n")
	reportf(w, "  Tile-pool diagnostics:\n")
	totalCount, totalBytes := 0, 0
	for _, r := range tntLintPoolRules {
		if d, ok := byRule[r.id]; ok {
			reportf(w, "    %-3d %-22s %s\n", d.Count, d.Rule, d.Message)
			totalCount += d.Count
			totalBytes += d.BytesSaved
			issueCount++
			continue
		}
		reportf(w, "    %-3d %-22s no %s\n", 0, r.id, r.cleanNoun)
	}
	if totalCount == 0 {
		reportf(w, "    tile pool is clean — nothing for `kbot tnt optimize` to remove.\n")
	} else {
		reportf(w,
			"    %d tile graphic%s (%d bytes) could be removed by `kbot tnt optimize`.\n",
			totalCount, sIfPlural(totalCount), totalBytes)
	}

	// Map-data diagnostics: data the game reads differently from what the
	// map intends (tile indices past the tile set, feature words naming no
	// table entry), maps beyond the interchange bounds and the minimap.
	var dataDiags []tnt.LintDiagnostic
	for _, d := range poolDiags {
		if !isTNTLintPoolRule(d.Rule) {
			dataDiags = append(dataDiags, d)
		}
	}
	reportf(w, "\n")
	reportf(w, "  Map data:\n")
	if len(dataDiags) == 0 {
		reportf(w, "    ✓  tile indices, feature words and minimap read as intended\n")
	}
	for _, d := range dataDiags {
		icon := "ℹ"
		if d.Severity == tnt.LintWarning {
			icon = "⚠"
		}
		reportf(w, "    %s  %-22s %s\n", icon, d.Rule, d.Message)
		issueCount++
	}

	if !qualityOff {
		reportf(w, "\n")
		reportf(w, "  Map quality:\n")
		for _, d := range qualityDiags {
			reportf(w, "    %s  %-22s %s\n", maplintIcon(d.Severity), d.ID, d.Message)
			if d.Severity != maplint.SeverityOK {
				issueCount++
			}
		}
	}

	reportf(w, "\n")
	if issueCount == 0 {
		return nil
	}
	return fmt.Errorf("lint found %d issue%s", issueCount, sIfPlural(issueCount))
}

// isTNTLintPoolRule reports whether a rule is one of the tile-pool rules
// (the ones `kbot tnt optimize` acts on).
func isTNTLintPoolRule(rule string) bool {
	for _, r := range tntLintPoolRules {
		if r.id == rule {
			return true
		}
	}
	return false
}

// emitTNTLintSARIF writes a SARIF 2.1.0 run to stdout.  Stderr stays
// silent in CI mode so build pipes don't capture the human text.
func emitTNTLintSARIF(w io.Writer, hit *cli.VFSInputHit, poolDiags []tnt.LintDiagnostic, qualityDiags []maplint.Diagnostic) error {
	uri := strings.TrimPrefix(hit.Source, "vfs:")
	results := make([]cli.SARIFResult, 0, len(poolDiags)+len(qualityDiags))
	for _, d := range poolDiags {
		results = append(results, cli.SARIFResult{
			RuleID:  "tnt." + d.Rule,
			Level:   sarifLevelForPool(d.Severity),
			Message: cli.SARIFMessage{Text: d.Message},
			Locations: []cli.SARIFLocation{{
				PhysicalLocation: cli.SARIFPhysicalLocation{
					ArtifactLocation: cli.SARIFArtifactLocation{URI: uri},
				},
			}},
		})
	}
	for _, d := range qualityDiags {
		if d.Severity == maplint.SeverityOK {
			continue
		}
		results = append(results, cli.SARIFResult{
			RuleID:  "maplint." + d.ID,
			Level:   sarifLevelForMaplint(d.Severity),
			Message: cli.SARIFMessage{Text: d.Message},
			Locations: []cli.SARIFLocation{{
				PhysicalLocation: cli.SARIFPhysicalLocation{
					ArtifactLocation: cli.SARIFArtifactLocation{URI: uri},
				},
			}},
		})
	}
	if err := cli.WriteSARIF(w, "kbot tnt lint", tntLintRuleCatalogue(), results); err != nil {
		return fmt.Errorf("encode sarif: %w", err)
	}
	if len(results) > 0 {
		return fmt.Errorf("lint found %d issue%s", len(results), sIfPlural(len(results)))
	}
	return nil
}

// openLintVFS mounts the right virtual filesystem for a lint invocation.
func openLintVFS(explicit string) (*filesystem.VirtualFileSystem, string, error) {
	root, source, err := cli.ResolveVFSPath(explicit)
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

// buildMaplintInputFromCLI gathers the optional inputs the quality
// pass needs.  Returns the assembled Input plus human-readable
// source labels for the OTA and VFS.
func buildMaplintInputFromCLI(arg string, hit *cli.VFSInputHit, m *tnt.Map, otaOverride string, vfs *filesystem.VirtualFileSystem) (maplint.Input, string, string, error) {
	in := maplint.Input{Map: m}

	// OTA — explicit override > sibling on the same backing store as the TNT.
	otaBytes, otaSrc := readSiblingOTA(arg, hit, otaOverride, vfs)
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
	features, _ := m.LoadFeatures(bytes.NewReader(hit.Data))
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
			vfsSrc = "mounted"
		}
	}
	return in, otaSrc, vfsSrc, nil
}

// readSiblingOTA returns the bytes + source label of the sister .ota
// for a TNT, applying the same local-then-VFS lookup order via
// cli.ResolveVFSInput.  Returns (nil, "") when no .ota is found.
func readSiblingOTA(arg string, hit *cli.VFSInputHit, otaOverride string, vfs *filesystem.VirtualFileSystem) ([]byte, string) {
	// Explicit --ota wins.  Run it through cli.ResolveVFSInput so virtual
	// paths and relative paths work the same as the .tnt argument.
	if otaOverride != "" {
		if r, err := cli.ResolveVFSInput(otaOverride, vfs, ".ota", []string{"maps/"}); err == nil {
			return r.Data, r.Source
		}
		return nil, ""
	}
	// Derive the sibling path from the resolved source.  When the TNT
	// came from the VFS, prefer the same VFS slot so we don't have to
	// reach back to local disk.
	if hit.VirtualPath != "" {
		otaPath := strings.TrimSuffix(hit.VirtualPath, path.Ext(hit.VirtualPath)) + ".ota"
		if vfs != nil && vfs.Exists(otaPath) && !vfs.IsDir(otaPath) {
			if data, err := vfs.ReadFile(otaPath); err == nil {
				return data, "vfs:" + otaPath
			}
		}
		return nil, ""
	}
	// Local TNT — look for a sibling on disk.
	if hit.Source != "" {
		otaPath := strings.TrimSuffix(hit.Source, filePathExt(hit.Source)) + ".ota"
		if data, err := os.ReadFile(otaPath); err == nil {
			return data, otaPath
		}
	}
	return nil, ""
}

// scanFeatureRegistry returns the metal each feature in the VFS yields,
// keyed by lower-cased name, as the game stores it (see
// mapmeta.FeatureMetal): metal=56.8 is 56, and a name's first definition
// wins.
func scanFeatureRegistry(vfs *filesystem.VirtualFileSystem) map[string]int {
	return mapmeta.FeatureMetal(vfs)
}

// filePathExt returns the extension of a path including the dot.
// Pulled out as its own helper so we can do simple suffix math
// without importing path/filepath everywhere.
func filePathExt(p string) string {
	for i := len(p) - 1; i >= 0; i-- {
		switch p[i] {
		case '.':
			return p[i:]
		case '/', '\\':
			return ""
		}
	}
	return ""
}

// tntLintPoolRules is the canonical order + clean-state label for the
// three tile-pool rules.  The human output renders one row per entry
// here so a fully-clean map still shows `0` against each rule rather
// than collapsing them under a single status pill.
var tntLintPoolRules = []struct {
	id        string
	cleanNoun string
}{
	{"duplicate-tiles", "byte-identical duplicate tile graphics"},
	{"similar-tiles", "visually-similar tile graphics"},
	{"unused-tiles", "unreferenced tile graphics"},
}

// maplintIcon renders a maplint severity as a single-cell character so
// neighbouring rows line up regardless of which severity each uses.
// Emoji + variation selectors would render at different widths in some
// terminals.
func maplintIcon(s maplint.Severity) string {
	switch s {
	case maplint.SeverityError:
		return "✗"
	case maplint.SeverityWarning:
		return "⚠"
	default:
		return "✓"
	}
}

func sIfPlural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// ── SARIF support ──────────────────────────────────────────────────────────

// tntLintRuleCatalogue exports the rule list the SARIF run advertises
// in tool.driver.rules so consumers like GitHub Code Scanning can
// show stable rule descriptions.
func tntLintRuleCatalogue() []cli.SARIFRule {
	return []cli.SARIFRule{
		cli.SARIFShortRule("tnt.duplicate-tiles", "Byte-identical tile graphics found in the TNT pool."),
		cli.SARIFShortRule("tnt.similar-tiles", "Visually-similar tile graphics sharing the same heightmap footprint."),
		cli.SARIFShortRule("tnt.unused-tiles", "Tile graphics referenced by no map cell."),
		cli.SARIFShortRule("tnt.bad-tile-index", "Tile map cells reference tiles beyond the tile set; the game reads past its tile set there."),
		cli.SARIFShortRule("tnt.unresolved-feature", "Cells hold feature words naming no entry of the feature table; the game places nothing there."),
		cli.SARIFShortRule("tnt.interchange-bounds", "The map is larger than other map tools accept."),
		cli.SARIFShortRule("tnt.minimap", "The map stores no minimap, or one too small for the game's radar."),
		cli.SARIFShortRule("maplint.dedupTiles", "Duplicate tile graphics in the TNT pool."),
		cli.SARIFShortRule("maplint.otaFields", "Lobby-required OTA metadata missing."),
		cli.SARIFShortRule("maplint.startsInBounds", "A start position lies outside the map or in a void cell."),
		cli.SARIFShortRule("maplint.schemaSlots", "An advertised numplayers count has no schema with enough StartPos entries."),
		cli.SARIFShortRule("maplint.metalProximity", "A start position has no metal-producing feature within 24 tiles."),
		cli.SARIFShortRule("maplint.voidIslands", "Passable cells are unreachable from any start (≥ 20 cells)."),
		cli.SARIFShortRule("maplint.heightDiscontinuities", "Cliff edges > 32 height units between adjacent cells block ground pathing."),
	}
}

func sarifLevelForPool(s tnt.LintSeverity) string {
	switch s {
	case tnt.LintWarning:
		return "warning"
	default:
		return "note"
	}
}

func sarifLevelForMaplint(s maplint.Severity) string {
	switch s {
	case maplint.SeverityError:
		return "error"
	case maplint.SeverityWarning:
		return "warning"
	default:
		return "none"
	}
}
