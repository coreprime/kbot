package common

import (
	"bytes"
	"math/rand"
	"testing"
)

func TestHeaderReadWrite(t *testing.T) {
	header := &Header{
		Marker:        HeaderMarker,
		Version:       VersionV1,
		DirectorySize: 1024,
		DecryptKey:    0x5A,
		Offset:        512,
	}

	var buf bytes.Buffer
	if err := header.WriteHeader(&buf); err != nil {
		t.Fatalf("failed to write header: %v", err)
	}

	read, err := ReadHeader(&buf)
	if err != nil {
		t.Fatalf("failed to read header: %v", err)
	}

	if read.Marker != header.Marker {
		t.Errorf("marker mismatch: got %X, want %X", read.Marker, header.Marker)
	}
	if read.Version != header.Version {
		t.Errorf("version mismatch: got %X, want %X", read.Version, header.Version)
	}
}

func TestEntryPath(t *testing.T) {
	root := &Entry{Name: ""}
	dir1 := &Entry{Name: "units", Parent: root}
	dir2 := &Entry{Name: "arm", Parent: dir1}
	file := &Entry{Name: "armcom.fbi", Parent: dir2}

	expected := "units/arm/armcom.fbi"
	if path := file.FullPath(); path != expected {
		t.Errorf("path mismatch: got %q, want %q", path, expected)
	}
}

func TestEntryWalk(t *testing.T) {
	root := &Entry{
		Name:  "",
		IsDir: true,
		Children: []*Entry{
			{Name: "file1.txt", IsDir: false},
			{
				Name:  "dir1",
				IsDir: true,
				Children: []*Entry{
					{Name: "file2.txt", IsDir: false},
				},
			},
		},
	}

	for _, child := range root.Children {
		child.Parent = root
		if child.IsDir {
			for _, subchild := range child.Children {
				subchild.Parent = child
			}
		}
	}

	count := 0
	_ = root.Walk(func(e *Entry) error {
		count++
		return nil
	})

	expected := 4 // root + file1 + dir1 + file2
	if count != expected {
		t.Errorf("walk count mismatch: got %d, want %d", count, expected)
	}
}

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
			compressed := CompressLZ77(tt.data)
			decompressed, err := DecompressLZ77(compressed, len(tt.data))
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

	compressed := CompressLZ77(data)
	decompressed, err := DecompressLZ77(compressed, len(data))
	if err != nil {
		t.Fatalf("decompress error: %v", err)
	}
	if !bytes.Equal(decompressed, data) {
		t.Fatalf("round-trip mismatch on random data")
	}
}

func TestLZ77RoundTripRepeating(t *testing.T) {
	data := bytes.Repeat([]byte("The quick brown fox jumps over the lazy dog. "), 200)

	compressed := CompressLZ77(data)
	decompressed, err := DecompressLZ77(compressed, len(data))
	if err != nil {
		t.Fatalf("decompress error: %v", err)
	}
	if !bytes.Equal(decompressed, data) {
		t.Fatalf("round-trip mismatch on repeating data")
	}
	t.Logf("compressed %d -> %d bytes (%.1f%%)", len(data), len(compressed), float64(len(compressed))*100/float64(len(data)))
}

func TestChunkEncodeDecodeBuffer(t *testing.T) {
	data := []byte("the quick brown fox")
	original := append([]byte(nil), data...)
	EncodeChunkBuffer(data)
	DecodeChunkBuffer(data)
	if !bytes.Equal(data, original) {
		t.Fatalf("chunk transform not reciprocal: got %v, want %v", data, original)
	}
}

func TestEncryptDecryptReciprocal(t *testing.T) {
	data := []byte("encrypted region bytes")
	original := append([]byte(nil), data...)
	key := TransformHeaderKey(DefaultHeaderKey)
	EncryptInPlace(key, 20, data)
	if bytes.Equal(data, original) {
		t.Fatal("encryption left data unchanged")
	}
	DecryptBuffer(key, 20, data)
	if !bytes.Equal(data, original) {
		t.Fatalf("decrypt did not invert encrypt: got %v, want %v", data, original)
	}
}
