package v1

import (
	"bytes"
	"os"
	"testing"

	"github.com/coreprime/kbot/formats/hpi/common"
)

// TestLZ77RoundTripRealFile pulls a real decompressed GAF payload out of a
// shipped TA archive and verifies the LZ77 compressor/decompressor round-trips
// the first 64KB chunk exactly.
func TestLZ77RoundTripRealFile(t *testing.T) {
	path := "../../../../game-assets/total-annihilation/total-annihilation-31c-gog/totala1.hpi"
	if _, err := os.Stat(path); os.IsNotExist(err) {
		t.Skip("totala1.hpi not found")
	}

	r, err := Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() { _ = r.Close() }()

	rc, err := r.Open("anims/FOG.GAF")
	if err != nil {
		t.Fatalf("open FOG.GAF: %v", err)
	}
	var buf bytes.Buffer
	if _, err := buf.ReadFrom(rc); err != nil {
		t.Fatalf("read FOG.GAF: %v", err)
	}
	_ = rc.Close()

	data := buf.Bytes()
	if len(data) < 65536 {
		t.Skipf("FOG.GAF too small (%d bytes) for chunk test", len(data))
	}

	block := data[:65536]
	compressed := common.CompressLZ77(block)
	decompressed, err := common.DecompressLZ77(compressed, len(block))
	if err != nil {
		t.Fatalf("decompress: %v", err)
	}
	if !bytes.Equal(decompressed, block) {
		for i := range block {
			if block[i] != decompressed[i] {
				t.Fatalf("first diff at byte %d: want 0x%02X got 0x%02X", i, block[i], decompressed[i])
			}
		}
	}
	t.Logf("chunk 0: %d -> %d bytes (%.1f%%)", len(block), len(compressed), float64(len(compressed))*100/float64(len(block)))
}
