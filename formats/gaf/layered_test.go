package gaf

import (
	"testing"

	"github.com/coreprime/kbot/internal/testutil"
)

// TestTAKLayeredCursorFrames pins the layered-frame decode path against the
// TA:K cursor GAF, whose every frame is a composite (LayerCount > 0,
// PtrFrameData = pointer table to nested FrameInfos). The old reader
// misparsed the table as inline structs and yielded 3x3 garbage frames.
func TestTAKLayeredCursorFrames(t *testing.T) {
	path := testutil.TAKUnpackedFile(t, "anims", "cursors.gaf")
	reader, err := LoadFromFile(path)
	if err != nil {
		t.Skipf("sample not available: %v", err)
	}
	defer func() { _ = reader.Close() }()

	seqs, err := reader.ReadSequences()
	if err != nil {
		t.Fatalf("ReadSequences: %v", err)
	}
	var attack *Sequence
	for _, s := range seqs {
		if s.Name == "CursorAttack" {
			attack = s
			break
		}
	}
	if attack == nil {
		t.Fatal("CursorAttack sequence not found")
	}
	if len(attack.Frames) != 10 {
		t.Errorf("CursorAttack frames = %d, want 10", len(attack.Frames))
	}
	for i, f := range attack.Frames {
		if f.Width < 16 || f.Height < 16 {
			t.Errorf("frame %d = %dx%d, want a real cursor-sized composite (>=16px)", i, f.Width, f.Height)
		}
		if len(f.Pixels) != int(f.Width)*int(f.Height) {
			t.Errorf("frame %d pixel count %d != %d", i, len(f.Pixels), int(f.Width)*int(f.Height))
		}
		// A decoded cursor must contain visible pixels, not just transparency.
		opaque := 0
		for _, px := range f.Pixels {
			if px != f.TransparencyIndex {
				opaque++
			}
		}
		if opaque == 0 {
			t.Errorf("frame %d decoded fully transparent", i)
		}
	}
}
