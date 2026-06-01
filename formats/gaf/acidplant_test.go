package gaf

import (
	"testing"

	"github.com/coreprime/kbot/internal/testutil"
)

func TestAcidplant(t *testing.T) {
	path := testutil.UnpackedFile(t, "anims", "acidplant.gaf")
	reader, err := LoadFromFile(path)
	if err != nil {
		t.Fatalf("Failed to open acidplant.gaf: %v", err)
	}
	defer func() { _ = reader.Close() }()

	header := reader.Header()
	t.Logf("Version: 0x%08X", header.Version)
	t.Logf("SequenceCount: %d", header.SequenceCount)

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
