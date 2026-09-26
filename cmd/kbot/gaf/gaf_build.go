package gaf

import (
	"bytes"
	"encoding/csv"
	"errors"
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

	"github.com/coreprime/kbot-io/formats/gaf"
	"github.com/coreprime/kbot-io/palettes"
)

func newGAFBuildCommand() *cobra.Command {
	var (
		target      string
		palettePath string
		storage     string
	)

	cmd := &cobra.Command{
		Use:   "build <folder>",
		Short: "Build a GAF file from a dump folder",
		Long: `Reconstruct a GAF file from a folder tree produced by "kbot gaf dump".

Each sub-folder is treated as a sequence.  Inside each sub-folder the
build command reads:

  frames.csv    Size, origin, key, duration, storage and +11 byte of
                each frame (required; a header-only file is an empty
                sequence)
  sequence.csv  Position, exact name, loop word and +4 word of the
                sequence (optional)
  0.png         Frame images (png or gif, numbered from 0); a frame
  1.png         whose frames.csv width or height is 0 needs none
  ...

A sub-folder with neither frames.csv nor sequence.csv is skipped with a
warning. Any other sub-folder that cannot be built stops the build, so a
sequence is never silently left out.

The images are palettized against the standard TA palette by default.
Pass --palette <file.pal> to palettize against a custom 1024-byte TA
.PAL file instead.  Transparent pixels become the frame's key (the
transparency column).

What the game needs is kept:
  - Each sequence keeps its loop word from sequence.csv.  A sequence
    without one loops, as every stock sequence does; the game plays a
    sequence whose loop byte is 0 once and then stops.
  - Each frame keeps its storage from frames.csv.  Frames without one
    are compressed, except in textures/*.gaf and anims/vismasks.gaf,
    which the game reads as plain pixel arrays: every frame written to
    such a path is raw.  --storage raw|compressed overrides this.
  - Composite (layered) frames are written as flat frames.

Examples:
  kbot gaf build ./sprites --target units.gaf
  kbot gaf build ./my_gaf                          # writes my_gaf.gaf
  kbot gaf build ./armtex --target textures/armtex.gaf
  kbot gaf build ./sprites --palette PALETTE.PAL`,
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

			palette, err := loadBuildPalette(palettePath)
			if err != nil {
				return err
			}

			policy, err := parseStoragePolicy(storage, target)
			if err != nil {
				return err
			}

			sequences, err := buildSequences(srcDir, palette, policy, func(dir string, seq *gaf.Sequence, err error) {
				if err != nil {
					fmt.Fprintf(os.Stderr, "  ⚠ %s: %v\n", dir, err)
					return
				}
				fmt.Fprintf(os.Stderr, "  ✓ %s — %d frames\n", seq.Name, len(seq.Frames))
			})
			if err != nil {
				return err
			}
			for _, note := range policy.notes() {
				fmt.Fprintf(os.Stderr, "  ⚠ %s\n", note)
			}

			var buf bytes.Buffer
			if err := gaf.WriteGAFWith(&buf, sequences, policy.writeOptions()); err != nil {
				return fmt.Errorf("failed to write GAF: %w", err)
			}
			if err := os.WriteFile(target, buf.Bytes(), 0o644); err != nil {
				return fmt.Errorf("failed to write output: %w", err)
			}

			totalFrames := 0
			for _, seq := range sequences {
				totalFrames += len(seq.Frames)
			}
			fmt.Fprintf(os.Stderr, "\nBuilt %d sequences, %d frames → %s\n",
				len(sequences), totalFrames, target)
			return nil
		},
	}

	cmd.Flags().StringVar(&target, "target", "", "Output GAF file (default: <folder>.gaf)")
	cmd.Flags().StringVar(&palettePath, "palette", "", "Path to a custom 1024-byte TA .PAL file (default: embedded TA palette)")
	cmd.Flags().StringVar(&storage, "storage", "auto",
		"Frame storage: auto (frames.csv, else raw for textures/*.gaf and anims/vismasks.gaf and compressed elsewhere), raw or compressed")

	return cmd
}

// storagePolicy decides how built frames are stored.
type storagePolicy struct {
	// force, when not StorageDefault, overrides every frame's storage.
	force gaf.FrameStorage
	// pathNeeds is the storage the output path requires (StorageRaw for
	// archives the game reads as plain pixel arrays).
	pathNeeds gaf.FrameStorage
	target    string
	// overridden counts frames whose frames.csv storage was replaced.
	overridden int
}

// parseStoragePolicy reads the --storage flag for an output path.
func parseStoragePolicy(flag, target string) (*storagePolicy, error) {
	p := &storagePolicy{pathNeeds: gaf.StorageForPath(target), target: target}
	switch strings.ToLower(strings.TrimSpace(flag)) {
	case "", "auto":
		if p.pathNeeds == gaf.StorageRaw {
			p.force = gaf.StorageRaw
		}
	case "raw":
		p.force = gaf.StorageRaw
	case "compressed":
		p.force = gaf.StorageCompressed
	default:
		return nil, fmt.Errorf("--storage must be auto, raw or compressed, got %q", flag)
	}
	return p, nil
}

// apply sets a frame's storage from its frames.csv value and the policy.
func (p *storagePolicy) apply(f *gaf.Frame, fromCSV gaf.FrameStorage) {
	f.Storage = fromCSV
	if p.force != gaf.StorageDefault {
		if fromCSV != gaf.StorageDefault && fromCSV != p.force {
			p.overridden++
		}
		f.Storage = p.force
	}
}

// writeOptions returns the writer options for the policy: frames without a
// storage of their own are compressed unless the path needs raw frames.
func (p *storagePolicy) writeOptions() gaf.WriteOptions {
	return gaf.WriteOptions{DefaultStorage: p.pathNeeds, FlattenLayers: true}
}

// notes explains storage choices the user may not expect.
func (p *storagePolicy) notes() []string {
	var out []string
	if p.overridden > 0 {
		out = append(out, fmt.Sprintf("%d frame(s) written %s instead of the storage in frames.csv", p.overridden, p.force))
	}
	if p.pathNeeds == gaf.StorageRaw && p.force == gaf.StorageCompressed {
		out = append(out, fmt.Sprintf("%s is read by the game as plain pixel arrays; its frames must be raw", p.target))
	}
	return out
}

// loadBuildPalette resolves the palette used to palettize input frames.
// An empty path means use the embedded default TA palette.
func loadBuildPalette(path string) (*gaf.Palette, error) {
	if path == "" {
		palette, err := gaf.LoadPaletteFromBytes(palettes.DefaultPalette)
		if err != nil {
			return nil, fmt.Errorf("failed to load default palette: %w", err)
		}
		return palette, nil
	}

	palette, err := gaf.LoadPalette(path)
	if err != nil {
		return nil, fmt.Errorf("failed to load palette %s: %w", path, err)
	}
	return palette, nil
}

// ── sequence builder ───────────────────────────────────────────────────────

type frameMeta struct {
	Index        int
	Width        int // -1 when frames.csv does not give it
	Height       int // -1 when frames.csv does not give it
	OriginX      int
	OriginY      int
	Transparency int
	Duration     int // game ticks
	Storage      gaf.FrameStorage
	Blend        int // frame header byte +11
}

// sequenceMeta is a dump folder's sequence.csv.
type sequenceMeta struct {
	Index     int
	HasIndex  bool
	Name      string
	HasName   bool
	LoopFlags uint16
	HasLoop   bool
	Unknown4  uint32
}

// seqDirEntry is one sequence folder waiting to be built.
type seqDirEntry struct {
	dir  string
	meta sequenceMeta
}

// errNotSequenceFolder is reported for a sub-folder that holds neither
// frames.csv nor sequence.csv; the build skips it.
var errNotSequenceFolder = errors.New("not a sequence folder (no " + framesCSVName + " or " + sequenceCSVName + "), skipped")

// buildSequences builds every sequence sub-folder of srcDir. Folders are
// ordered by the index in their sequence.csv, then by name. A folder with
// neither frames.csv nor sequence.csv is skipped; any other folder that
// fails to build fails the whole build. report, when set, is called for
// each folder with the built sequence, or with errNotSequenceFolder for a
// skipped folder.
func buildSequences(srcDir string, palette *gaf.Palette, policy *storagePolicy, report func(dir string, seq *gaf.Sequence, err error)) ([]*gaf.Sequence, error) {
	entries, err := os.ReadDir(srcDir)
	if err != nil {
		return nil, fmt.Errorf("failed to read directory: %w", err)
	}

	var dirs []seqDirEntry
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if !fileExists(filepath.Join(srcDir, e.Name(), framesCSVName)) &&
			!fileExists(filepath.Join(srcDir, e.Name(), sequenceCSVName)) {
			if report != nil {
				report(e.Name(), nil, errNotSequenceFolder)
			}
			continue
		}
		meta, err := readSequenceCSV(filepath.Join(srcDir, e.Name(), sequenceCSVName))
		if err != nil {
			return nil, fmt.Errorf("%s/%s: %w", e.Name(), sequenceCSVName, err)
		}
		dirs = append(dirs, seqDirEntry{dir: e.Name(), meta: meta})
	}
	if len(dirs) == 0 {
		return nil, fmt.Errorf("no sequence sub-folders found in %s", srcDir)
	}
	sort.SliceStable(dirs, func(i, j int) bool {
		a, b := dirs[i].meta, dirs[j].meta
		if a.HasIndex != b.HasIndex {
			return a.HasIndex
		}
		if a.HasIndex && a.Index != b.Index {
			return a.Index < b.Index
		}
		return dirs[i].dir < dirs[j].dir
	})

	palModel := palette.ColorModel()
	var sequences []*gaf.Sequence
	for _, d := range dirs {
		name := d.dir
		if d.meta.HasName {
			name = d.meta.Name
		}
		seq, err := buildSequence(filepath.Join(srcDir, d.dir), name, palModel, policy)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", d.dir, err)
		}
		// Every stock sequence loops; a sequence whose loop byte is 0 plays
		// once in the game and then stops.
		seq.SetLoops(true)
		if d.meta.HasLoop {
			seq.LoopFlags = d.meta.LoopFlags
		}
		seq.Unknown4 = d.meta.Unknown4
		if report != nil {
			report(d.dir, seq, nil)
		}
		sequences = append(sequences, seq)
	}
	if len(sequences) == 0 {
		return nil, fmt.Errorf("no valid sequences found")
	}
	return sequences, nil
}

func buildSequence(dir, name string, palModel color.Palette, policy *storagePolicy) (*gaf.Sequence, error) {
	// Read frames.csv for timing info.
	csvPath := filepath.Join(dir, framesCSVName)
	metas, err := readFramesCSV(csvPath)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", framesCSVName, err)
	}

	if len(metas) == 0 {
		// Header-only frames.csv → empty sequence.
		return &gaf.Sequence{Name: name}, nil
	}

	// Load each frame image and palettize.
	frames := make([]*gaf.Frame, 0, len(metas))

	for _, meta := range metas {
		if meta.Transparency < 0 || meta.Transparency > 255 {
			return nil, fmt.Errorf("frame %d: transparency %d is not a palette index", meta.Index, meta.Transparency)
		}
		if meta.Blend < 0 || meta.Blend > 255 {
			return nil, fmt.Errorf("frame %d: blend %d is not a byte", meta.Index, meta.Blend)
		}
		if meta.Duration < 0 || meta.Duration > gaf.MaxDuration {
			return nil, fmt.Errorf("frame %d: duration %d is outside 0..%d ticks", meta.Index, meta.Duration, gaf.MaxDuration)
		}

		key := uint8(meta.Transparency)
		frame := &gaf.Frame{
			OriginX:           int16(meta.OriginX),
			OriginY:           int16(meta.OriginY),
			TransparencyIndex: key,
			Duration:          uint32(meta.Duration),
			Blend:             uint8(meta.Blend),
		}
		var opaque []bool
		if meta.Width == 0 || meta.Height == 0 {
			// A frame with no pixels: no image can hold it, so frames.csv
			// alone describes it.
			if meta.Width < 0 || meta.Width > 0xFFFF || meta.Height < 0 || meta.Height > 0xFFFF {
				return nil, fmt.Errorf("frame %d: size %dx%d is outside 0..65535", meta.Index, meta.Width, meta.Height)
			}
			frame.Width, frame.Height = uint16(meta.Width), uint16(meta.Height)
		} else {
			imgPath := findFrameImage(dir, meta.Index)
			if imgPath == "" {
				return nil, fmt.Errorf("frame %d: image file not found", meta.Index)
			}
			img, err := loadImage(imgPath)
			if err != nil {
				return nil, fmt.Errorf("frame %d: %w", meta.Index, err)
			}
			bounds := img.Bounds()
			if bounds.Dx() > 0xFFFF || bounds.Dy() > 0xFFFF {
				return nil, fmt.Errorf("frame %d: image %dx%d is larger than a GAF frame can be", meta.Index, bounds.Dx(), bounds.Dy())
			}
			frame.Width, frame.Height = uint16(bounds.Dx()), uint16(bounds.Dy())
			frame.Pixels, opaque = palettizeImage(img, palModel, key)
		}
		policy.apply(frame, meta.Storage)
		// A pixel equal to the key is drawn only by a compressed frame, and
		// only when the writer knows it is opaque.
		if opaque != nil && frame.Storage != gaf.StorageRaw {
			frame.Opaque = opaque
		}

		frames = append(frames, frame)
	}

	return &gaf.Sequence{Name: name, Frames: frames}, nil
}

func readFramesCSV(path string) ([]frameMeta, error) {
	records, err := readCSV(path)
	if err != nil {
		return nil, err
	}

	if len(records) == 0 {
		return nil, fmt.Errorf("missing header row")
	}
	if len(records) == 1 {
		// Header-only: a legitimately empty sequence (e.g. a placeholder
		// sequence that ships with TA's anims/*.gaf files).
		return nil, nil
	}

	col := csvColumns(records[0])
	var metas []frameMeta
	for n, row := range records[1:] {
		m := frameMeta{
			// Width and height come from the image unless frames.csv
			// gives 0, which marks a frame with no pixels.
			Width:        -1,
			Height:       -1,
			Transparency: 9, // TA default
			Duration:     10,
		}
		get := func(name string) (string, bool) {
			if i, ok := col[name]; ok && i < len(row) {
				return strings.TrimSpace(row[i]), true
			}
			return "", false
		}
		ints := []struct {
			name string
			dst  *int
		}{
			{"frame", &m.Index}, {"width", &m.Width}, {"height", &m.Height},
			{"origin_x", &m.OriginX}, {"origin_y", &m.OriginY},
			{"transparency", &m.Transparency}, {"duration_ticks", &m.Duration},
			{"blend", &m.Blend},
		}
		for _, c := range ints {
			v, ok := get(c.name)
			if !ok || v == "" {
				continue
			}
			x, err := strconv.Atoi(v)
			if err != nil {
				return nil, fmt.Errorf("row %d: %s: %w", n+2, c.name, err)
			}
			*c.dst = x
		}
		if v, ok := get("storage"); ok {
			s, err := gaf.ParseFrameStorage(v)
			if err != nil {
				return nil, fmt.Errorf("row %d: %w", n+2, err)
			}
			m.Storage = s
		}
		metas = append(metas, m)
	}

	sort.Slice(metas, func(i, j int) bool { return metas[i].Index < metas[j].Index })
	return metas, nil
}

// readSequenceCSV reads a dump folder's sequence.csv. A missing file gives a
// zero sequenceMeta: the folder name is the sequence name and it loops.
func readSequenceCSV(path string) (sequenceMeta, error) {
	var m sequenceMeta
	records, err := readCSV(path)
	if errors.Is(err, os.ErrNotExist) {
		return m, nil
	}
	if err != nil {
		return m, err
	}
	if len(records) < 2 {
		return m, nil
	}
	col := csvColumns(records[0])
	row := records[1]
	get := func(name string) (string, bool) {
		if i, ok := col[name]; ok && i < len(row) {
			return row[i], true
		}
		return "", false
	}
	if v, ok := get("index"); ok && strings.TrimSpace(v) != "" {
		x, err := strconv.Atoi(strings.TrimSpace(v))
		if err != nil {
			return m, fmt.Errorf("index: %w", err)
		}
		m.Index, m.HasIndex = x, true
	}
	if v, ok := get("name"); ok {
		if len(v) > gaf.MaxNameLength {
			return m, fmt.Errorf("name %q is longer than %d bytes", v, gaf.MaxNameLength)
		}
		m.Name, m.HasName = v, true
	}
	if v, ok := get("loop_flags"); ok && strings.TrimSpace(v) != "" {
		x, err := strconv.ParseUint(strings.TrimSpace(v), 0, 16)
		if err != nil {
			return m, fmt.Errorf("loop_flags: %w", err)
		}
		m.LoopFlags, m.HasLoop = uint16(x), true
	}
	if v, ok := get("unknown4"); ok && strings.TrimSpace(v) != "" {
		x, err := strconv.ParseUint(strings.TrimSpace(v), 0, 32)
		if err != nil {
			return m, fmt.Errorf("unknown4: %w", err)
		}
		m.Unknown4 = uint32(x)
	}
	return m, nil
}

func readCSV(path string) ([][]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	r := csv.NewReader(f)
	r.FieldsPerRecord = -1
	return r.ReadAll()
}

// csvColumns maps lower-cased header names to their column index.
func csvColumns(header []string) map[string]int {
	col := make(map[string]int, len(header))
	for i, h := range header {
		col[strings.TrimSpace(strings.ToLower(h))] = i
	}
	return col
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
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

// palettizeImage converts an image to palette indices. Transparent pixels
// (alpha below half) become transpIdx.
//
// When the source image is already a *image.Paletted whose palette has the
// same RGB values as the target palette (e.g. dumped by "kbot gaf dump"),
// indices are copied directly — this avoids Euclidean nearest-colour lookup
// returning a different slot when the palette contains duplicate colours.
// A dumped compressed frame can draw pixels whose value equals its key
// (the dump then marks another index transparent); such pixels keep the key
// value, and the returned opaque mask says which pixels are drawn. The mask
// is nil when every opaque pixel differs from transpIdx.
func palettizeImage(img image.Image, pal color.Palette, transpIdx uint8) ([]byte, []bool) {
	bounds := img.Bounds()
	w, h := bounds.Dx(), bounds.Dy()

	if pix, ok := paletteIndexFastPath(img, pal); ok {
		// The source paletted image's indices are authoritative.  We still
		// need to make sure any pixel whose palette entry is fully
		// transparent ends up on the configured transparency index.
		out := make([]byte, len(pix))
		srcPal := img.(*image.Paletted).Palette
		opaque := make([]bool, len(pix))
		keyDrawn := false
		for i, idx := range pix {
			if int(idx) < len(srcPal) {
				if _, _, _, a := srcPal[idx].RGBA(); a < 0x8000 {
					out[i] = transpIdx
					continue
				}
			}
			out[i] = idx
			opaque[i] = true
			if idx == transpIdx {
				keyDrawn = true
			}
		}
		if !keyDrawn {
			opaque = nil
		}
		return out, opaque
	}

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

	return pixels, nil
}

// paletteIndexFastPath returns the source image's raw palette indices when
// the image is a *image.Paletted and its palette's RGB values match the
// target palette slot-for-slot.
//
// Slots whose alpha is zero in either palette are skipped during the RGB
// comparison: Go's png decoder returns tRNS-marked entries as
// color.NRGBA{r,g,b,0}, whose .RGBA() premultiplies away the RGB.  Those
// entries are still positionally meaningful in Pix.
func paletteIndexFastPath(img image.Image, target color.Palette) ([]byte, bool) {
	pImg, ok := img.(*image.Paletted)
	if !ok || len(pImg.Palette) != len(target) {
		return nil, false
	}
	for i, c := range pImg.Palette {
		sr, sg, sb, sa := c.RGBA()
		tr, tg, tb, ta := target[i].RGBA()
		if sa == 0 || ta == 0 {
			continue
		}
		if sr != tr || sg != tg || sb != tb {
			return nil, false
		}
	}
	bounds := pImg.Bounds()
	w, h := bounds.Dx(), bounds.Dy()
	out := make([]byte, w*h)
	for y := 0; y < h; y++ {
		row := pImg.Pix[y*pImg.Stride : y*pImg.Stride+w]
		copy(out[y*w:(y+1)*w], row)
	}
	return out, true
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
