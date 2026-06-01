package gaf

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/coreprime/kbot/internal/testutil"
)

func TestGAFReader(t *testing.T) {
	path := testutil.UnpackedFile(t, "anims", "ARMACV1.GAF")

	reader, err := LoadFromFile(path)
	if err != nil {
		t.Fatalf("Failed to open GAF: %v", err)
	}
	defer func() { _ = reader.Close() }()

	header := reader.Header()
	t.Logf("Version: 0x%08X", header.Version)
	t.Logf("SequenceCount: %d", header.SequenceCount)

	if header.Version != VersionTA {
		t.Errorf("Expected version 0x%08X, got 0x%08X", VersionTA, header.Version)
	}

	sequences, err := reader.ReadSequences()
	if err != nil {
		t.Fatalf("Failed to read sequences: %v", err)
	}

	t.Logf("Read %d sequences", len(sequences))

	for i, seq := range sequences {
		t.Logf("[%d] %s - %d frames", i, seq.Name, len(seq.Frames))
		if len(seq.Frames) > 0 {
			frame := seq.Frames[0]
			t.Logf("    First frame: %dx%d origin(%d,%d) transp=%d pixels=%d duration=%d",
				frame.Width, frame.Height, frame.OriginX, frame.OriginY,
				frame.TransparencyIndex, len(frame.Pixels), frame.Duration)

			expectedPixels := int(frame.Width) * int(frame.Height)
			if len(frame.Pixels) != expectedPixels {
				t.Errorf("Expected %d pixels, got %d", expectedPixels, len(frame.Pixels))
			}
		}
	}
}

func TestGAFToGIF(t *testing.T) {
	path := testutil.UnpackedFile(t, "anims", "ARMACV1.GAF")

	reader, err := LoadFromFile(path)
	if err != nil {
		t.Fatalf("Failed to open GAF: %v", err)
	}
	defer func() { _ = reader.Close() }()

	sequences, err := reader.ReadSequences()
	if err != nil {
		t.Fatalf("Failed to read sequences: %v", err)
	}

	if len(sequences) == 0 {
		t.Fatal("No sequences found")
	}

	// Load palette from the unpacked game data.
	var palette *Palette
	palPath := testutil.UnpackedFile(t, "palettes", "palette.pal")
	if p, err := LoadPalette(palPath); err == nil {
		palette = p
		t.Logf("Loaded TA palette from %s", palPath)
	}

	seq := sequences[0]
	outputPath := filepath.Join(t.TempDir(), seq.Name+".gif")

	outFile, err := os.Create(outputPath)
	if err != nil {
		t.Fatalf("Failed to create output file: %v", err)
	}
	defer func() { _ = outFile.Close() }()

	if err := seq.WriteGIF(outFile, palette); err != nil {
		t.Fatalf("Failed to write GIF: %v", err)
	}

	info, err := os.Stat(outputPath)
	if err != nil {
		t.Fatalf("Failed to stat output file: %v", err)
	}

	if info.Size() == 0 {
		t.Error("Output GIF file is empty")
	}

	t.Logf("GIF file size: %d bytes", info.Size())
}

func TestPaletteLoading(t *testing.T) {
	palPath := testutil.UnpackedFile(t, "palettes", "palette.pal")

	palette, err := LoadPalette(palPath)
	if err != nil {
		t.Fatalf("Failed to load palette: %v", err)
	}

	if len(palette.Colors) != 256 {
		t.Errorf("Expected 256 colors, got %d", len(palette.Colors))
	}

	if palette.Colors[0].A != 0 {
		t.Errorf("Color 0 should be transparent, got alpha=%d", palette.Colors[0].A)
	}

	for i := 1; i < 256; i++ {
		if palette.Colors[i].A != 255 {
			t.Errorf("Color %d should be opaque, got alpha=%d", i, palette.Colors[i].A)
			break
		}
	}

	t.Logf("Palette: color 0=%v, color 1=%v, color 255=%v",
		palette.Colors[0], palette.Colors[1], palette.Colors[255])
}
