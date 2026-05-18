// Package pal implements reading and writing of Total Annihilation .PAL palette
// files.
//
// A TA palette is a fixed 1024-byte blob: 256 entries of 4 bytes each, laid out
// as R, G, B, A in little-endian order.  The alpha byte is unused by the game
// (always 0 in Cavedog's files) and color index 0 acts as transparent.
//
// The same on-disk layout is also reused for the .ALP shadow-alpha, .LHT light
// and .SHD shadow lookup tables — they are 1024-byte index→index mappings, not
// RGB palettes, so this package treats them as raw byte tables when asked.
package pal

import (
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"os"
)

// EntryCount is the number of color entries in a TA palette (always 256).
const EntryCount = 256

// FileSize is the on-disk size in bytes of a TA palette file (256 × 4).
const FileSize = EntryCount * 4

// Palette is a parsed TA .PAL file.  The Raw slice keeps the original bytes
// so callers that care about the unused alpha byte (or want to round-trip the
// file byte-for-byte) can recover it.
type Palette struct {
	Colors [EntryCount]color.RGBA
	Raw    []byte
}

// LoadFromReader parses a .PAL file from r.
//
// Color index 0 is reported with alpha=0 to match how every other kbot loader
// treats the TA palette (the engine uses index 0 as the transparent sentinel).
// All other entries are returned fully opaque.
func LoadFromReader(r io.Reader) (*Palette, error) {
	raw := make([]byte, FileSize)
	if _, err := io.ReadFull(r, raw); err != nil {
		return nil, fmt.Errorf("read palette: %w", err)
	}
	p := &Palette{Raw: raw}
	for i := 0; i < EntryCount; i++ {
		off := i * 4
		p.Colors[i] = color.RGBA{R: raw[off], G: raw[off+1], B: raw[off+2], A: 255}
	}
	p.Colors[0].A = 0
	return p, nil
}

// LoadFromBytes parses a .PAL file from a byte slice.
func LoadFromBytes(data []byte) (*Palette, error) {
	if len(data) != FileSize {
		return nil, fmt.Errorf("invalid palette size: expected %d bytes, got %d", FileSize, len(data))
	}
	p := &Palette{Raw: append([]byte(nil), data...)}
	for i := 0; i < EntryCount; i++ {
		off := i * 4
		p.Colors[i] = color.RGBA{R: data[off], G: data[off+1], B: data[off+2], A: 255}
	}
	p.Colors[0].A = 0
	return p, nil
}

// LoadFromFile parses a .PAL file at path.
func LoadFromFile(path string) (*Palette, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	return LoadFromReader(f)
}

// Write encodes p back to a .PAL file.  When Raw is set (e.g. for a palette
// loaded with LoadFromReader) the original bytes are emitted verbatim so any
// unused alpha bytes are preserved.  Otherwise the alpha byte for every entry
// is zero — matching Cavedog's files.
func (p *Palette) Write(w io.Writer) error {
	if len(p.Raw) == FileSize {
		_, err := w.Write(p.Raw)
		return err
	}
	buf := make([]byte, FileSize)
	for i := 0; i < EntryCount; i++ {
		off := i * 4
		buf[off] = p.Colors[i].R
		buf[off+1] = p.Colors[i].G
		buf[off+2] = p.Colors[i].B
		// buf[off+3] stays zero — matches Cavedog files.
	}
	_, err := w.Write(buf)
	return err
}

// ColorModel returns the palette as a Go image/color Palette.
func (p *Palette) ColorModel() color.Palette {
	out := make(color.Palette, EntryCount)
	for i := 0; i < EntryCount; i++ {
		out[i] = p.Colors[i]
	}
	return out
}

// RenderSwatch renders the 256 entries as a 16×16 grid of cellSize×cellSize
// squares.  cellSize<=0 defaults to 16 (256×256 image).
func (p *Palette) RenderSwatch(cellSize int) *image.RGBA {
	if cellSize <= 0 {
		cellSize = 16
	}
	const cols = 16
	img := image.NewRGBA(image.Rect(0, 0, cols*cellSize, cols*cellSize))
	for i := 0; i < EntryCount; i++ {
		col := i % cols
		row := i / cols
		c := color.RGBA{p.Colors[i].R, p.Colors[i].G, p.Colors[i].B, 255}
		if i == 0 {
			// Render index 0 with a magenta hatch so callers can see where the
			// transparent sentinel lives.  Keep one solid corner so the actual
			// stored RGB is still visible.
			for y := 0; y < cellSize; y++ {
				for x := 0; x < cellSize; x++ {
					px := col*cellSize + x
					py := row*cellSize + y
					if (x+y)%2 == 0 {
						img.SetRGBA(px, py, color.RGBA{255, 0, 255, 255})
					} else {
						img.SetRGBA(px, py, c)
					}
				}
			}
			continue
		}
		for y := 0; y < cellSize; y++ {
			for x := 0; x < cellSize; x++ {
				img.SetRGBA(col*cellSize+x, row*cellSize+y, c)
			}
		}
	}
	return img
}

// WritePNG encodes an image to PNG.
func WritePNG(w io.Writer, img image.Image) error {
	return png.Encode(w, img)
}

// WriteJASC encodes the palette in the JASC-PAL plain-text format, the de
// facto exchange format used by Paint Shop Pro, GIMP and most palette editors.
// Color count is always 256.
func (p *Palette) WriteJASC(w io.Writer) error {
	header := "JASC-PAL\n0100\n256\n"
	if _, err := io.WriteString(w, header); err != nil {
		return err
	}
	for i := 0; i < EntryCount; i++ {
		if _, err := fmt.Fprintf(w, "%d %d %d\n", p.Colors[i].R, p.Colors[i].G, p.Colors[i].B); err != nil {
			return err
		}
	}
	return nil
}

// WriteGPL encodes the palette in the GIMP Palette (.gpl) text format.
func (p *Palette) WriteGPL(w io.Writer, name string) error {
	if name == "" {
		name = "TA Palette"
	}
	if _, err := fmt.Fprintf(w, "GIMP Palette\nName: %s\nColumns: 16\n#\n", name); err != nil {
		return err
	}
	for i := 0; i < EntryCount; i++ {
		if _, err := fmt.Fprintf(w, "%3d %3d %3d\tIndex %d\n",
			p.Colors[i].R, p.Colors[i].G, p.Colors[i].B, i); err != nil {
			return err
		}
	}
	return nil
}

// LoadLookupFromReader parses a 1024-byte color-index lookup table (.ALP, .LHT
// or .SHD).  These files share the .PAL size but each byte is an index into
// the main palette rather than a color channel.
//
// The returned slice has length FileSize and is the raw file bytes — readers
// that need the table as a 256×4 grid (the canonical ALP/LHT layout) can index
// directly.
func LoadLookupFromReader(r io.Reader) ([]byte, error) {
	buf := make([]byte, FileSize)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, fmt.Errorf("read lookup table: %w", err)
	}
	return buf, nil
}

// LoadLookupFromFile is the file-path equivalent of LoadLookupFromReader.
func LoadLookupFromFile(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	return LoadLookupFromReader(f)
}

// RenderLookupSwatch renders a 1024-byte color-index lookup table as a 256×4
// grid of cellSize×cellSize squares using the given palette for the index→RGB
// mapping.  Returns an RGBA image of size 256*cellSize × 4*cellSize.  Suitable
// for .ALP/.LHT/.SHD which are all 256×4 index tables.
func RenderLookupSwatch(table []byte, palette *Palette, cellSize int) (*image.RGBA, error) {
	if len(table) != FileSize {
		return nil, fmt.Errorf("lookup table must be %d bytes, got %d", FileSize, len(table))
	}
	if cellSize <= 0 {
		cellSize = 4
	}
	img := image.NewRGBA(image.Rect(0, 0, 256*cellSize, 4*cellSize))
	for row := 0; row < 4; row++ {
		for col := 0; col < 256; col++ {
			idx := table[row*256+col]
			c := color.RGBA{palette.Colors[idx].R, palette.Colors[idx].G, palette.Colors[idx].B, 255}
			for y := 0; y < cellSize; y++ {
				for x := 0; x < cellSize; x++ {
					img.SetRGBA(col*cellSize+x, row*cellSize+y, c)
				}
			}
		}
	}
	return img, nil
}

// Histogram returns a summary of how many distinct RGB triples the palette
// contains.  Index 0 is excluded because it is the transparent sentinel.  The
// result is useful when comparing palettes since Cavedog's defaults reserve
// certain ranges for team colors and shadows.
func (p *Palette) Histogram() (unique int, duplicates int) {
	seen := make(map[uint32]int, EntryCount)
	for i := 1; i < EntryCount; i++ {
		c := p.Colors[i]
		key := uint32(c.R)<<16 | uint32(c.G)<<8 | uint32(c.B)
		seen[key]++
	}
	for _, n := range seen {
		if n > 1 {
			duplicates += n - 1
		}
	}
	return len(seen), duplicates
}

// IsLikelyTAPalette returns true if the file's alpha bytes are all zero, which
// is the case for Cavedog-shipped TA palettes (and a common sanity check).
func (p *Palette) IsLikelyTAPalette() bool {
	if len(p.Raw) != FileSize {
		return false
	}
	for i := 0; i < EntryCount; i++ {
		if p.Raw[i*4+3] != 0 {
			return false
		}
	}
	return true
}

// Equals reports whether two palettes have the same RGB values (alpha is
// ignored because color index 0 always carries the transparent override).
func (p *Palette) Equals(other *Palette) bool {
	if other == nil {
		return false
	}
	for i := 0; i < EntryCount; i++ {
		if p.Colors[i].R != other.Colors[i].R ||
			p.Colors[i].G != other.Colors[i].G ||
			p.Colors[i].B != other.Colors[i].B {
			return false
		}
	}
	return true
}

