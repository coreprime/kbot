package fnt

import (
	"bytes"
	"fmt"
	"os"
	"unicode"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot-io/formats/fnt"
)

func newFNTDescribeCommand() *cobra.Command {
	var listGlyphs bool
	cmd := &cobra.Command{
		Use:   "describe <file.fnt>",
		Short: "Describe a font in detail (height, baseline, glyph coverage)",
		Long: `Describe a TA bitmap font: its height (header byte 0, also the line
height), baseline (byte 2, signed: the rows glyphs extend above the pen),
first character code (byte 3: codes below it have no glyph), glyph widths
and the character codes that have glyphs. Glyphs the game would draw as
garbage (zero width, cut short by the end of the file) are reported.`,
		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			data, err := os.ReadFile(args[0])
			if err != nil {
				return fmt.Errorf("read fnt: %w", err)
			}
			f, err := fnt.LoadFromReader(bytes.NewReader(data))
			if err != nil {
				return fmt.Errorf("parse fnt: %w", err)
			}

			minW, maxW, totalW := 1<<31-1, 0, 0
			ranges := summarizeRanges(f)
			for _, g := range f.Glyphs {
				if g == nil {
					continue
				}
				if g.Width < minW {
					minW = g.Width
				}
				if g.Width > maxW {
					maxW = g.Width
				}
				totalW += g.Width
			}
			meanW := 0.0
			if f.GlyphCount() > 0 {
				meanW = float64(totalW) / float64(f.GlyphCount())
			} else {
				minW = 0
			}

			fmt.Printf("FNT File: %s\n", args[0])
			fmt.Printf("File Size: %d bytes\n\n", len(data))
			fmt.Printf("Height:        %d px\n", f.Height)
			fmt.Printf("Baseline:      %d (glyph rows start this many rows above the pen)\n", f.Baseline)
			fmt.Printf("First char:    0x%02X\n", f.FirstChar)
			fmt.Printf("Glyphs:        %d / 256 defined\n", f.GlyphCount())
			fmt.Printf("Glyph width:   min=%d max=%d mean=%.1f\n", minW, maxW, meanW)
			fmt.Printf("Ranges:        %s\n", ranges)
			for _, w := range f.Warnings {
				fmt.Printf("Warning:       %s\n", w)
			}

			if listGlyphs {
				fmt.Printf("\nDefined glyphs:\n")
				for ch, g := range f.Glyphs {
					if g == nil {
						continue
					}
					label := fmt.Sprintf("0x%02X", ch)
					if r := rune(ch); unicode.IsPrint(r) && ch < 128 {
						label += fmt.Sprintf(" %q", r)
					}
					fmt.Printf("  %s  width=%d\n", label, g.Width)
				}
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&listGlyphs, "list", false, "List every defined glyph with its width")
	return cmd
}

// summarizeRanges returns a comma-separated list of [first-last] glyph code
// ranges, e.g. "0x20-0x7E, 0xA0-0xFF".
func summarizeRanges(f *fnt.Font) string {
	out := ""
	start := -1
	for ch := 0; ch < 256; ch++ {
		if f.Glyphs[ch] != nil {
			if start < 0 {
				start = ch
			}
			continue
		}
		if start >= 0 {
			if out != "" {
				out += ", "
			}
			out += fmt.Sprintf("0x%02X-0x%02X", start, ch-1)
			start = -1
		}
	}
	if start >= 0 {
		if out != "" {
			out += ", "
		}
		out += fmt.Sprintf("0x%02X-0xFF", start)
	}
	if out == "" {
		out = "none"
	}
	return out
}
