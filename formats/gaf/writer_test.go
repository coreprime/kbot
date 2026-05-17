package gaf

import (
	"bytes"
	"testing"
)

func TestWriteReadRoundtrip(t *testing.T) {
	// Create a simple test sequence
	seq := &Sequence{
		Name: "TestSeq",
		Frames: []*Frame{
			{
				Width: 4, Height: 3,
				OriginX: 0, OriginY: 0,
				TransparencyIndex: 9,
				Duration: 10,
				Pixels: []byte{
					9, 9, 1, 2,
					3, 3, 3, 9,
					5, 6, 9, 9,
				},
			},
		},
	}

	// Write
	var buf bytes.Buffer
	if err := WriteGAF(&buf, []*Sequence{seq}); err != nil {
		t.Fatalf("WriteGAF: %v", err)
	}
	t.Logf("Wrote %d bytes", buf.Len())

	// Read back
	reader, err := LoadFromReader(bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatalf("LoadFromReader: %v", err)
	}

	seqs, err := reader.ReadSequences()
	if err != nil {
		t.Fatalf("ReadSequences: %v", err)
	}

	if len(seqs) != 1 {
		t.Fatalf("expected 1 sequence, got %d", len(seqs))
	}
	if seqs[0].Name != "TestSeq" {
		t.Errorf("name = %q, want TestSeq", seqs[0].Name)
	}
	if len(seqs[0].Frames) != 1 {
		t.Fatalf("expected 1 frame, got %d", len(seqs[0].Frames))
	}

	f := seqs[0].Frames[0]
	if f.Width != 4 || f.Height != 3 {
		t.Errorf("dims = %dx%d, want 4x3", f.Width, f.Height)
	}

	orig := seq.Frames[0].Pixels
	if len(f.Pixels) != len(orig) {
		t.Fatalf("pixel count = %d, want %d", len(f.Pixels), len(orig))
	}
	for i := range orig {
		if f.Pixels[i] != orig[i] {
			t.Errorf("pixel[%d] = %d, want %d", i, f.Pixels[i], orig[i])
		}
	}
}
