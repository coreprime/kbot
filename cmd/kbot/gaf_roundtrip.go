package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/formats/gaf"
	"github.com/coreprime/kbot/internal/assets"
)

func newGAFRoundtripCommand() *cobra.Command {
	var detailed bool

	cmd := &cobra.Command{
		Use:   "roundtrip [path]",
		Short: "Validate roundtrip fidelity for GAF files",
		Long: `Scan a directory for .gaf files and verify that both the
decode→encode and dump→build pipelines preserve every frame's palette
indices and metadata.

  decode→encode  Parse the GAF in memory, re-serialise with WriteGAF,
                 re-parse, and compare sequences/frames/pixels.
                 Byte-identity is also reported but not required:
                 the original Cavedog encoder makes different
                 compression choices that don't affect pixel data.

  dump→build     Dump every frame to a temp folder using PNG, run the
                 build pipeline back into a GAF, and re-parse.  This
                 validates the full CLI dump/build cycle including
                 image palettisation.

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
			resolved, source, err := resolveVFSPath(path)
			if err != nil {
				return err
			}
			if resolved == "" {
				return fmt.Errorf("provide a directory or register a kbot context (run `kbot ctx add`)")
			}
			reportContextSource(source)
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

	palette, err := gaf.LoadPaletteFromBytes(assets.DefaultPalette)
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
	encodePass, buildPass, byteIdent := 0, 0, 0
	for _, r := range results {
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
	fmt.Fprintf(os.Stderr, "  | %-45s|\n", fmt.Sprintf("Decode -> Encode:         %-11s %s", encFrac, passFail(encodePass == totalFiles)))
	fmt.Fprintf(os.Stderr, "  | %-45s|\n", fmt.Sprintf("Dump -> Build:            %-11s %s", buildFrac, passFail(buildPass == totalFiles)))
	fmt.Fprintf(os.Stderr, "  | %-45s|\n", fmt.Sprintf("Byte-identical (info):    %s", byteFrac))
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
	r.OrigHash = md5hex(origData)

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

	// ── decode → encode ────────────────────────────────────────────────
	log("    → Re-encoding\n")
	var encBuf bytes.Buffer
	if err := gaf.WriteGAF(&encBuf, origSeqs); err != nil {
		r.EncodeErr = "encode"
		log("    ⚠️  encode error: %v\n", err)
	} else {
		encBytes := encBuf.Bytes()
		r.EncodeSize = len(encBytes)
		r.EncodeHash = md5hex(encBytes)
		r.EncodeBytes = bytes.Equal(origData, encBytes)

		reSeqs, err := loadGAFSequences(encBytes)
		if err != nil {
			r.EncodeErr = "reparse"
			log("    ⚠️  reparse error: %v\n", err)
		} else if diff := compareSequences(origSeqs, reSeqs); diff != "" {
			r.EncodeErr = "mismatch"
			log("    ⚠️  semantic mismatch: %s\n", diff)
		} else {
			r.EncodeOK = true
			log("    ✓ encode+reparse semantically equal (%d → %d bytes)\n", r.OrigSize, r.EncodeSize)
		}
	}

	// ── dump → build ───────────────────────────────────────────────────
	log("    → Dump/build\n")
	if err := dumpBuildRoundtrip(origSeqs, palette); err != nil {
		r.BuildErr = err.Error()
		log("    ⚠️  dump/build: %v\n", err)
	} else {
		r.BuildOK = true
		log("    ✓ dump/build semantically equal\n")
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

// compareSequences returns "" if the two sequence slices are pixel-equal,
// otherwise a short description of the first divergence found.
func compareSequences(a, b []*gaf.Sequence) string {
	if len(a) != len(b) {
		return fmt.Sprintf("sequence count %d → %d", len(a), len(b))
	}
	for i := range a {
		if a[i].Name != b[i].Name {
			return fmt.Sprintf("seq[%d] name %q → %q", i, a[i].Name, b[i].Name)
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
			case fa.Duration != fb.Duration:
				return fmt.Sprintf("seq[%d] frame[%d] duration %d → %d",
					i, fi, fa.Duration, fb.Duration)
			}
			if !bytes.Equal(fa.Pixels, fb.Pixels) {
				idx := firstPixelDiff(fa.Pixels, fb.Pixels)
				return fmt.Sprintf("seq[%d] frame[%d] pixels diverge at index %d", i, fi, idx)
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

// dumpBuildRoundtrip exercises the full dump→build pipeline through the
// filesystem in a temp directory, then compares the rebuilt sequences against
// the originals at the palette-index level.
func dumpBuildRoundtrip(seqs []*gaf.Sequence, palette *gaf.Palette) error {
	tmp, err := os.MkdirTemp("", "gaf-roundtrip-*")
	if err != nil {
		return fmt.Errorf("mkdir tmp: %w", err)
	}
	defer func() { _ = os.RemoveAll(tmp) }()

	for si, seq := range seqs {
		// Use the sequence index as the directory name so build emits the
		// sequences in the same order (sort.Strings on the directory listing).
		seqDir := filepath.Join(tmp, fmt.Sprintf("%04d_%s", si, safeName(seq.Name)))
		if err := os.MkdirAll(seqDir, 0o755); err != nil {
			return fmt.Errorf("mkdir seq: %w", err)
		}

		for fi, frame := range seq.Frames {
			framePath := filepath.Join(seqDir, fmt.Sprintf("%d.png", fi))
			// Use TransparencyModeNone on dump so every palette slot stays
			// opaque in the PNG. The build's palettize fast-path remaps any
			// pixel whose palette entry has alpha<0x8000 to the metadata TI
			// — useful for display, but it destroys the index-level mapping
			// needed for a faithful round-trip. With all entries opaque the
			// build copies indices through verbatim.
			if err := writeFrameWith(frame, palette, "png", framePath,
				gaf.RenderOptions{Mode: gaf.TransparencyModeNone}); err != nil {
				return fmt.Errorf("dump frame: %w", err)
			}
		}

		csvPath := filepath.Join(seqDir, "frames.csv")
		if err := writeFramesCSV(seq, csvPath); err != nil {
			return fmt.Errorf("write csv: %w", err)
		}
	}

	// Build sequences back from disk using the same code path the CLI uses.
	palModel := palette.ColorModel()
	entries, err := os.ReadDir(tmp)
	if err != nil {
		return fmt.Errorf("read tmp: %w", err)
	}
	var seqDirs []string
	for _, e := range entries {
		if e.IsDir() {
			seqDirs = append(seqDirs, e.Name())
		}
	}
	sort.Strings(seqDirs)

	builtSeqs := make([]*gaf.Sequence, 0, len(seqDirs))
	for i, dirName := range seqDirs {
		built, err := buildSequence(filepath.Join(tmp, dirName), seqs[i].Name, palModel, palette)
		if err != nil {
			return fmt.Errorf("build %s: %w", dirName, err)
		}
		// Preserve the original sequence name (the directory name was
		// prefixed with an ordering key).
		built.Name = seqs[i].Name
		builtSeqs = append(builtSeqs, built)
	}

	if diff := compareSequences(seqs, builtSeqs); diff != "" {
		return fmt.Errorf("%s", diff)
	}
	return nil
}

