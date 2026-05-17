package hpi

import (
	"bytes"
	"math/rand"
	"os"
	"testing"
)

func TestLZ77RoundTrip(t *testing.T) {
	tests := []struct {
		name string
		data []byte
	}{
		{"empty", nil},
		{"single byte", []byte{0x42}},
		{"short string", []byte("hello world")},
		{"repeated", bytes.Repeat([]byte{0xAA}, 256)},
		{"pattern", bytes.Repeat([]byte("ABCD"), 100)},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if len(tt.data) == 0 {
				return
			}
			compressed := compressLZ77(tt.data)
			decompressed, err := decompressLZ77(compressed, len(tt.data))
			if err != nil {
				t.Fatalf("decompress error: %v", err)
			}
			if !bytes.Equal(decompressed, tt.data) {
				t.Fatalf("round-trip mismatch: got %d bytes, want %d bytes", len(decompressed), len(tt.data))
			}
		})
	}
}

func TestLZ77RoundTripLargeRandom(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	data := make([]byte, 65536)
	rng.Read(data)

	compressed := compressLZ77(data)
	decompressed, err := decompressLZ77(compressed, len(data))
	if err != nil {
		t.Fatalf("decompress error: %v", err)
	}
	if !bytes.Equal(decompressed, data) {
		t.Fatalf("round-trip mismatch on random data")
	}
}

func TestLZ77RoundTripRepeating(t *testing.T) {
	// Data with lots of repeating patterns should compress well.
	data := bytes.Repeat([]byte("The quick brown fox jumps over the lazy dog. "), 200)

	compressed := compressLZ77(data)
	decompressed, err := decompressLZ77(compressed, len(data))
	if err != nil {
		t.Fatalf("decompress error: %v", err)
	}
	if !bytes.Equal(decompressed, data) {
		t.Fatalf("round-trip mismatch on repeating data")
	}
	t.Logf("compressed %d -> %d bytes (%.1f%%)", len(data), len(compressed), float64(len(compressed))*100/float64(len(data)))
}

func TestLZ77RoundTripRealFile(t *testing.T) {
	path := "../../../game-assets/total-annihilation/total-annihilation-31c-gog/totala1.hpi"
	if _, err := os.Stat(path); os.IsNotExist(err) {
		t.Skip("totala1.hpi not found")
	}

	r, err := OpenReader(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() { _ = r.Close() }()

	// Read FOG.GAF decompressed data
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
	t.Logf("FOG.GAF: %d bytes", len(data))

	// Compress first chunk (65536 bytes)
	block := data[:65536]
	compressed := compressLZ77(block)
	decompressed, err := decompressLZ77(compressed, len(block))
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
