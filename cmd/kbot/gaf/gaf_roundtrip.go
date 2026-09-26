package gaf

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot-io/formats/gaf"
	"github.com/coreprime/kbot-io/palettes"
	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
)

func newGAFRoundtripCommand() *cobra.Command {
	var detailed bool

	cmd := &cobra.Command{
		Use:   "roundtrip [path]",
		Short: "Validate roundtrip fidelity for GAF files",
		Long: `Scan a directory for .gaf files and verify that both the
decode→encode and dump→build pipelines keep what the game reads.

  decode→encode  Parse the GAF in memory, re-serialise with WriteGAF,
                 re-parse, and compare.  The header fields the game
                 reads are compared straight from the bytes of both
                 files: each sequence's loop word (+2) and +4 word,
                 and each frame's size, origin, key, storage (raw or
                 compressed), layer count (+10), +11 byte and duration
                 (low 16 bits).  Every frame's pixels and the pixels
                 it draws are compared too.  Byte-identity is reported
                 but not required: the original Cavedog encoder makes
                 different compression choices that don't affect what
                 is drawn.

  dump→build     Dump every sequence to a temp folder exactly as
                 "kbot gaf dump" does by default (PNG, frames.csv,
                 sequence.csv), build it back as "kbot gaf build"
                 does, and compare the same fields and pixels.  The
                 dump stores each frame as one image, so composite
                 (layered) frames come back flattened; their layer
                 count is not compared, and the number of flattened
                 frames is reported.

When <path> is omitted, the active kbot context is scanned (see
'kbot ctx').

Each file is tested entirely in memory.  Use --detailed to see
step-by-step output for every file.`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			path := ""
			if len(args) > 0 {
				path = args[0]
			}
			resolved, source, err := cli.ResolveVFSPath(path)
			if err != nil {
				return err
			}
			if resolved == "" {
				return fmt.Errorf("provide a directory or register a kbot context (run `kbot ctx add`)")
			}
			cli.ReportContextSource(source)
			return runGAFRoundtrip(resolved, detailed)
		},
	}

	cmd.Flags().BoolVarP(&detailed, "detailed", "d", false, "Show step-by-step output for every file")

	return cmd
}

// ── result ─────────────────────────────────────────────────────────────────

type gafRoundtripResult struct {
	File     string
	OrigHash string
	OrigSize int

	EncodeSize  int
	EncodeHash  string
	EncodeBytes bool // byte-identical to original (informational only)
	EncodeOK    bool // semantic equality after reparse
	EncodeErr   string

	BuildOK  bool
	BuildErr string
	// Flattened counts the composite frames the dump/build leg wrote as
	// simple frames (informational).
	Flattened int
}

// ── runner ─────────────────────────────────────────────────────────────────

func runGAFRoundtrip(root string, detailed bool) error {
	var gafFiles []string
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if !info.IsDir() && strings.EqualFold(filepath.Ext(path), ".gaf") {
			gafFiles = append(gafFiles, path)
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("failed to scan %s: %w", root, err)
	}

	sort.Strings(gafFiles)

	if len(gafFiles) == 0 {
		return fmt.Errorf("no .gaf files found in %s", root)
	}

	fmt.Fprintf(os.Stderr, "\n  %s Scanning %s — %d file(s)\n\n",
		"🔍", root, len(gafFiles))

	palette, err := gaf.LoadPaletteFromBytes(palettes.DefaultPalette)
	if err != nil {
		return fmt.Errorf("failed to load default palette: %w", err)
	}

	results := make([]gafRoundtripResult, 0, len(gafFiles))

	for _, path := range gafFiles {
		r := testOneGAF(path, palette, detailed)
		results = append(results, r)

		if !detailed {
			icon := "✅"
			if !r.EncodeOK || !r.BuildOK {
				icon = "❌"
			}
			status := ""
			if !r.EncodeOK {
				status += " encode"
				if r.EncodeErr != "" {
					status += "(" + r.EncodeErr + ")"
				}
			}
			if !r.BuildOK {
				status += " build"
				if r.BuildErr != "" {
					status += "(" + r.BuildErr + ")"
				}
			}
			if status == "" {
				fmt.Fprintf(os.Stderr, "  %s %s\n", icon, filepath.Base(path))
			} else {
				fmt.Fprintf(os.Stderr, "  %s %s —%s\n", icon, filepath.Base(path), status)
			}
		}
	}

	// ── summary ────────────────────────────────────────────────────────
	totalFiles := len(results)
	encodePass, buildPass, byteIdent, flattened := 0, 0, 0, 0
	for _, r := range results {
		flattened += r.Flattened
		if r.EncodeOK {
			encodePass++
		}
		if r.BuildOK {
			buildPass++
		}
		if r.EncodeBytes {
			byteIdent++
		}
	}

	allPass := encodePass == totalFiles && buildPass == totalFiles

	encFrac := fmt.Sprintf("%d / %d", encodePass, totalFiles)
	buildFrac := fmt.Sprintf("%d / %d", buildPass, totalFiles)
	byteFrac := fmt.Sprintf("%d / %d", byteIdent, totalFiles)

	fmt.Fprintln(os.Stderr)
	fmt.Fprintln(os.Stderr, "  +----------------------------------------------+")
	fmt.Fprintf(os.Stderr, "  | %-45s|\n", fmt.Sprintf("Files scanned:            %d", totalFiles))
	fmt.Fprintf(os.Stderr, "  | %-45s|\n", fmt.Sprintf("Decode -> Encode:         %-11s %s", encFrac, cli.PassFail(encodePass == totalFiles)))
	fmt.Fprintf(os.Stderr, "  | %-45s|\n", fmt.Sprintf("Dump -> Build:            %-11s %s", buildFrac, cli.PassFail(buildPass == totalFiles)))
	fmt.Fprintf(os.Stderr, "  | %-45s|\n", fmt.Sprintf("Byte-identical (info):    %s", byteFrac))
	fmt.Fprintf(os.Stderr, "  | %-45s|\n", fmt.Sprintf("Flattened by build (info): %d frames", flattened))
	if allPass {
		fmt.Fprintln(os.Stderr, "  |                                              |")
		fmt.Fprintf(os.Stderr, "  | %-45s|\n", "All roundtrips passed!")
	}
	fmt.Fprintln(os.Stderr, "  +----------------------------------------------+")
	fmt.Fprintln(os.Stderr)

	if !allPass {
		return fmt.Errorf("%d encode + %d build failures",
			totalFiles-encodePass, totalFiles-buildPass)
	}
	return nil
}

// ── per-file test ──────────────────────────────────────────────────────────

func testOneGAF(path string, palette *gaf.Palette, detailed bool) gafRoundtripResult {
	name := filepath.Base(path)
	r := gafRoundtripResult{File: name}

	log := func(format string, a ...any) {
		if detailed {
			fmt.Fprintf(os.Stderr, format, a...)
		}
	}

	origData, err := os.ReadFile(path)
	if err != nil {
		r.EncodeErr = "read"
		r.BuildErr = "read"
		log("  %s\n    ⚠️  read error: %v\n", name, err)
		return r
	}
	r.OrigSize = len(origData)
	r.OrigHash = cli.MD5Hex(origData)

	// Zero-byte GAFs ship with some installs (Cavedog quirk — TA: Kingdoms'
	// data.hpi carries an empty anims/zonlogo.gaf). They aren't valid GAFs,
	// so report a clean pass: there's nothing to lose fidelity on.
	if len(origData) == 0 {
		r.EncodeOK = true
		r.BuildOK = true
		r.EncodeBytes = true
		log("  %s\n    ✓ zero-byte GAF — skipping (no content to round-trip)\n", name)
		return r
	}

	origSeqs, err := loadGAFSequences(origData)
	if err != nil {
		r.EncodeErr = "parse"
		r.BuildErr = "parse"
		log("  %s\n    ⚠️  parse error: %v\n", name, err)
		return r
	}

	if detailed {
		fmt.Fprintf(os.Stderr, "  %s\n", name)
	}

	origRaw, err := readRawFields(origData)
	if err != nil {
		r.EncodeErr = "raw headers"
		r.BuildErr = "raw headers"
		log("    ⚠️  header walk: %v\n", err)
		return r
	}

	// ── decode → encode ────────────────────────────────────────────────
	log("    → Re-encoding\n")
	var encBuf bytes.Buffer
	if err := gaf.WriteGAF(&encBuf, origSeqs); err != nil {
		r.EncodeErr = "encode"
		log("    ⚠️  encode error: %v\n", err)
	} else {
		encBytes := encBuf.Bytes()
		r.EncodeSize = len(encBytes)
		r.EncodeHash = cli.MD5Hex(encBytes)
		r.EncodeBytes = bytes.Equal(origData, encBytes)

		if diff := compareEncoded(origSeqs, origRaw, encBytes, rawCompareOptions{}); diff != "" {
			r.EncodeErr = "mismatch"
			log("    ⚠️  mismatch: %s\n", diff)
		} else {
			r.EncodeOK = true
			log("    ✓ encode+reparse keeps headers and pixels (%d → %d bytes)\n", r.OrigSize, r.EncodeSize)
		}
	}

	// ── dump → build ───────────────────────────────────────────────────
	log("    → Dump/build\n")
	r.Flattened = countComposites(origRaw)
	if err := dumpBuildRoundtrip(origSeqs, origRaw, palette, path); err != nil {
		r.BuildErr = err.Error()
		log("    ⚠️  dump/build: %v\n", err)
	} else {
		r.BuildOK = true
		if r.Flattened > 0 {
			log("    ✓ dump/build keeps headers and pixels (%d composite frame(s) flattened)\n", r.Flattened)
		} else {
			log("    ✓ dump/build keeps headers and pixels\n")
		}
	}

	if detailed {
		log("    ─────────────────────────────────\n")
		log("    Original MD5  %s  (%d bytes)\n", r.OrigHash, r.OrigSize)
		if r.EncodeHash != "" {
			log("    Encoded  MD5  %s  (%d bytes, byte-identical=%v)\n",
				r.EncodeHash, r.EncodeSize, r.EncodeBytes)
		}

		icon := "✅"
		if !r.EncodeOK || !r.BuildOK {
			icon = "❌"
		}
		parts := []string{}
		if r.EncodeOK {
			parts = append(parts, "encode ✓")
		} else {
			parts = append(parts, "encode ✗")
		}
		if r.BuildOK {
			parts = append(parts, "build ✓")
		} else {
			parts = append(parts, "build ✗")
		}
		log("    %s  %s\n\n", icon, strings.Join(parts, "  "))
	}

	return r
}

// ── helpers ────────────────────────────────────────────────────────────────

func loadGAFSequences(data []byte) ([]*gaf.Sequence, error) {
	reader, err := gaf.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	return reader.ReadSequences()
}

// compareEncoded re-parses encoded and compares it with the original: the
// raw header fields first, then every frame's pixels and coverage.
func compareEncoded(orig []*gaf.Sequence, origRaw []rawSequence, encoded []byte, opts rawCompareOptions) string {
	encRaw, err := readRawFields(encoded)
	if err != nil {
		return "header walk: " + err.Error()
	}
	if diff := compareRawFields(origRaw, encRaw, opts); diff != "" {
		return diff
	}
	reSeqs, err := loadGAFSequences(encoded)
	if err != nil {
		return "reparse: " + err.Error()
	}
	return compareSequences(orig, reSeqs)
}

// compareSequences returns "" if the two sequence slices draw the same
// pixels, otherwise a short description of the first divergence found.
// Each frame's pixel values and the pixels the game draws (see
// Frame.PixelOpaque) must match.
func compareSequences(a, b []*gaf.Sequence) string {
	if len(a) != len(b) {
		return fmt.Sprintf("sequence count %d → %d", len(a), len(b))
	}
	for i := range a {
		if a[i].Name != b[i].Name {
			return fmt.Sprintf("seq[%d] name %q → %q", i, a[i].Name, b[i].Name)
		}
		if a[i].LoopFlags != b[i].LoopFlags {
			return fmt.Sprintf("seq[%d] loop word 0x%04X → 0x%04X", i, a[i].LoopFlags, b[i].LoopFlags)
		}
		if len(a[i].Frames) != len(b[i].Frames) {
			return fmt.Sprintf("seq[%d] frame count %d → %d", i, len(a[i].Frames), len(b[i].Frames))
		}
		for fi := range a[i].Frames {
			fa, fb := a[i].Frames[fi], b[i].Frames[fi]
			switch {
			case fa.Width != fb.Width || fa.Height != fb.Height:
				return fmt.Sprintf("seq[%d] frame[%d] dims %dx%d → %dx%d",
					i, fi, fa.Width, fa.Height, fb.Width, fb.Height)
			case fa.OriginX != fb.OriginX || fa.OriginY != fb.OriginY:
				return fmt.Sprintf("seq[%d] frame[%d] origin (%d,%d) → (%d,%d)",
					i, fi, fa.OriginX, fa.OriginY, fb.OriginX, fb.OriginY)
			case fa.TransparencyIndex != fb.TransparencyIndex:
				return fmt.Sprintf("seq[%d] frame[%d] transp %d → %d",
					i, fi, fa.TransparencyIndex, fb.TransparencyIndex)
			case fa.DisplayTicks() != fb.DisplayTicks() || uint16(fa.Duration) != uint16(fb.Duration):
				return fmt.Sprintf("seq[%d] frame[%d] duration %d → %d",
					i, fi, fa.Duration, fb.Duration)
			}
			if !bytes.Equal(fa.Pixels, fb.Pixels) {
				idx := firstPixelDiff(fa.Pixels, fb.Pixels)
				return fmt.Sprintf("seq[%d] frame[%d] pixels diverge at index %d", i, fi, idx)
			}
			for p := range fa.Pixels {
				if fa.PixelOpaque(p) != fb.PixelOpaque(p) {
					return fmt.Sprintf("seq[%d] frame[%d] pixel %d drawn=%v → %v", i, fi, p, fa.PixelOpaque(p), fb.PixelOpaque(p))
				}
			}
		}
	}
	return ""
}

func firstPixelDiff(a, b []byte) int {
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	for i := 0; i < n; i++ {
		if a[i] != b[i] {
			return i
		}
	}
	return n
}

// dumpBuildRoundtrip runs the CLI's dump and build code with their default
// flags through a temp directory, then compares the rebuilt file with the
// original. gafPath is the source file's path, which decides the default
// frame storage exactly as the build's --target would.
func dumpBuildRoundtrip(seqs []*gaf.Sequence, origRaw []rawSequence, palette *gaf.Palette, gafPath string) error {
	tmp, err := os.MkdirTemp("", "gaf-roundtrip-*")
	if err != nil {
		return fmt.Errorf("mkdir tmp: %w", err)
	}
	defer func() { _ = os.RemoveAll(tmp) }()

	// The animated previews are not read back by the build, so skip them.
	if _, err := dumpSequences(seqs, palette, tmp, dumpOptions{Format: "png"}); err != nil {
		return fmt.Errorf("dump: %w", err)
	}

	policy, err := parseStoragePolicy("auto", gafPath)
	if err != nil {
		return err
	}
	var buildErr error
	built, err := buildSequences(tmp, palette, policy, func(dir string, _ *gaf.Sequence, err error) {
		if err != nil && buildErr == nil {
			buildErr = fmt.Errorf("build %s: %w", dir, err)
		}
	})
	if buildErr != nil {
		return buildErr
	}
	if err != nil {
		return fmt.Errorf("build: %w", err)
	}

	var buf bytes.Buffer
	if err := gaf.WriteGAFWith(&buf, built, policy.writeOptions()); err != nil {
		return fmt.Errorf("write: %w", err)
	}
	if diff := compareEncoded(seqs, origRaw, buf.Bytes(), rawCompareOptions{Flattened: true}); diff != "" {
		return fmt.Errorf("%s", diff)
	}
	return nil
}
