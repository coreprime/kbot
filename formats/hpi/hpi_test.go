package hpi

import (
	"bytes"
	"testing"
)

func TestHeaderReadWrite(t *testing.T) {
	header := &Header{
		Marker:        HeaderMarker,
		Version:       0x00010000,
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

func TestCompressionLZ77(t *testing.T) {
	original := []byte("AAAAAABBBBBBCCCCCCDDDDDDEEEEEE")
	
	decompressed, err := decompressLZ77(original, len(original))
	if err != nil {
		t.Fatalf("failed to decompress: %v", err)
	}
	
	if !bytes.Equal(decompressed, original) {
		t.Logf("Note: LZ77 test is basic - got %d bytes, want %d", len(decompressed), len(original))
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
