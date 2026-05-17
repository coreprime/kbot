package main

import (
	"encoding/csv"
	"fmt"
	"image"
	"image/color"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/internal/assets"
	"github.com/coreprime/kbot/formats/gaf"
)

func newGAFBuildCommand() *cobra.Command {
	var target string

	cmd := &cobra.Command{
		Use:   "build <folder>",
		Short: "Build a GAF file from a dump folder",
		Long: `Reconstruct a GAF file from a folder tree produced by "kbot gaf dump".

Each sub-folder is treated as a sequence.  Inside each sub-folder the
build command reads:

  frames.csv   Timing/metadata for each frame (required)
  0.png        Frame images (png or gif, numbered from 0)
  1.png
  ...

The images are palettized against the standard TA palette.  The output
is a fully TA-compatible GAF file.

Examples:
  kbot gaf build ./sprites --target units.gaf
  kbot gaf build ./my_gaf                          # writes my_gaf.gaf`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			srcDir := args[0]

			if target == "" {
				target = strings.TrimSuffix(srcDir, string(filepath.Separator)) + ".gaf"
			}

			info, err := os.Stat(srcDir)
			if err != nil || !info.IsDir() {
				return fmt.Errorf("source must be an existing directory: %s", srcDir)
			}

			palette, err := gaf.LoadPaletteFromBytes(assets.DefaultPalette)
			if err != nil {
				return fmt.Errorf("failed to load palette: %w", err)
			}
			palModel := palette.ColorModel()

			// Discover sequence sub-folders (sorted for deterministic order).
			entries, err := os.ReadDir(srcDir)
			if err != nil {
				return fmt.Errorf("failed to read directory: %w", err)
			}

			var seqDirs []string
			for _, e := range entries {
				if e.IsDir() {
					seqDirs = append(seqDirs, e.Name())
				}
			}
			sort.Strings(seqDirs)

			if len(seqDirs) == 0 {
				return fmt.Errorf("no sequence sub-folders found in %s", srcDir)
			}

			// Build each sequence.
			var sequences []*gaf.Sequence
			totalFrames := 0

			for _, dirName := range seqDirs {
				seqPath := filepath.Join(srcDir, dirName)
				seq, err := buildSequence(seqPath, dirName, palModel, palette)
				if err != nil {
					fmt.Fprintf(os.Stderr, "  ⚠ %s: %v\n", dirName, err)
					continue
				}
				sequences = append(sequences, seq)
				totalFrames += len(seq.Frames)
				fmt.Fprintf(os.Stderr, "  ✓ %s — %d frames\n", seq.Name, len(seq.Frames))
			}

			if len(sequences) == 0 {
				return fmt.Errorf("no valid sequences found")
			}

			// Write GAF.
			outFile, err := os.Create(target)
			if err != nil {
				return fmt.Errorf("failed to create output: %w", err)
			}
			defer func() { _ = outFile.Close() }()

			if err := gaf.WriteGAF(outFile, sequences); err != nil {
				return fmt.Errorf("failed to write GAF: %w", err)
			}

			fmt.Fprintf(os.Stderr, "\nBuilt %d sequences, %d frames → %s\n",
				len(sequences), totalFrames, target)
			return nil
		},
	}

	cmd.Flags().StringVar(&target, "target", "", "Output GAF file (default: <folder>.gaf)")

	return cmd
}

// ── sequence builder ───────────────────────────────────────────────────────

type frameMeta struct {
	Index        int
	Width        int
	Height       int
	OriginX      int
	OriginY      int
	Transparency int
	Duration     int // game ticks
}

func buildSequence(dir, name string, palModel color.Palette, palette *gaf.Palette) (*gaf.Sequence, error) {
	// Read frames.csv for timing info.
	csvPath := filepath.Join(dir, "frames.csv")
	metas, err := readFramesCSV(csvPath)
	if err != nil {
		return nil, fmt.Errorf("frames.csv: %w", err)
	}

	if len(metas) == 0 {
		return nil, fmt.Errorf("frames.csv is empty")
	}

	// Load each frame image and palettize.
	frames := make([]*gaf.Frame, 0, len(metas))

	for _, meta := range metas {
		imgPath := findFrameImage(dir, meta.Index)
		if imgPath == "" {
			return nil, fmt.Errorf("frame %d: image file not found", meta.Index)
		}

		img, err := loadImage(imgPath)
		if err != nil {
			return nil, fmt.Errorf("frame %d: %w", meta.Index, err)
		}

		pixels := palettizeImage(img, palModel, uint8(meta.Transparency))

		bounds := img.Bounds()
		frame := &gaf.Frame{
			Width:             uint16(bounds.Dx()),
			Height:            uint16(bounds.Dy()),
			OriginX:           int16(meta.OriginX),
			OriginY:           int16(meta.OriginY),
			TransparencyIndex: uint8(meta.Transparency),
			Duration:          uint32(meta.Duration),
			Pixels:            pixels,
		}

		frames = append(frames, frame)
	}

	return &gaf.Sequence{Name: name, Frames: frames}, nil
}

func readFramesCSV(path string) ([]frameMeta, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()

	r := csv.NewReader(f)
	records, err := r.ReadAll()
	if err != nil {
		return nil, err
	}

	if len(records) < 2 {
		return nil, fmt.Errorf("no data rows")
	}

	// Build column index from header.
	header := records[0]
	col := make(map[string]int)
	for i, h := range header {
		col[strings.TrimSpace(strings.ToLower(h))] = i
	}

	var metas []frameMeta
	for _, row := range records[1:] {
		m := frameMeta{
			Transparency: 9, // TA default
			Duration:     10,
		}
		if i, ok := col["frame"]; ok && i < len(row) {
			m.Index, _ = strconv.Atoi(strings.TrimSpace(row[i]))
		}
		if i, ok := col["width"]; ok && i < len(row) {
			m.Width, _ = strconv.Atoi(strings.TrimSpace(row[i]))
		}
		if i, ok := col["height"]; ok && i < len(row) {
			m.Height, _ = strconv.Atoi(strings.TrimSpace(row[i]))
		}
		if i, ok := col["origin_x"]; ok && i < len(row) {
			m.OriginX, _ = strconv.Atoi(strings.TrimSpace(row[i]))
		}
		if i, ok := col["origin_y"]; ok && i < len(row) {
			m.OriginY, _ = strconv.Atoi(strings.TrimSpace(row[i]))
		}
		if i, ok := col["transparency"]; ok && i < len(row) {
			m.Transparency, _ = strconv.Atoi(strings.TrimSpace(row[i]))
		}
		if i, ok := col["duration_ticks"]; ok && i < len(row) {
			m.Duration, _ = strconv.Atoi(strings.TrimSpace(row[i]))
		}
		metas = append(metas, m)
	}

	sort.Slice(metas, func(i, j int) bool { return metas[i].Index < metas[j].Index })
	return metas, nil
}

func findFrameImage(dir string, index int) string {
	for _, ext := range []string{".png", ".gif", ".bmp", ".jpg", ".jpeg"} {
		p := filepath.Join(dir, fmt.Sprintf("%d%s", index, ext))
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

func loadImage(path string) (image.Image, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()

	// Try PNG first (most common from our dump).
	img, err := png.Decode(f)
	if err == nil {
		return img, nil
	}

	// Fallback to generic decoder.
	if _, seekErr := f.Seek(0, 0); seekErr != nil {
		return nil, seekErr
	}
	img, _, err = image.Decode(f)
	return img, err
}

// palettizeImage converts an image to palette indices.
// Fully transparent pixels → transpIdx.
func palettizeImage(img image.Image, pal color.Palette, transpIdx uint8) []byte {
	bounds := img.Bounds()
	w, h := bounds.Dx(), bounds.Dy()
	pixels := make([]byte, w*h)

	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			c := img.At(bounds.Min.X+x, bounds.Min.Y+y)

			// Check transparency.
			_, _, _, a := c.RGBA()
			if a < 0x8000 {
				pixels[y*w+x] = transpIdx
				continue
			}

			idx := pal.Index(c)
			// Avoid mapping opaque pixels to the transparency index.
			if idx == int(transpIdx) {
				// Find next closest that isn't the transparency index.
				idx = nearestNonTransp(c, pal, transpIdx)
			}
			pixels[y*w+x] = byte(idx)
		}
	}

	return pixels
}

func nearestNonTransp(c color.Color, pal color.Palette, transpIdx uint8) int {
	bestIdx := 0
	bestDist := uint64(1<<63 - 1)
	cr, cg, cb, _ := c.RGBA()

	for i, pc := range pal {
		if i == int(transpIdx) {
			continue
		}
		pr, pg, pb, _ := pc.RGBA()
		dr := int64(cr) - int64(pr)
		dg := int64(cg) - int64(pg)
		db := int64(cb) - int64(pb)
		dist := uint64(dr*dr + dg*dg + db*db)
		if dist < bestDist {
			bestDist = dist
			bestIdx = i
		}
	}
	return bestIdx
}
