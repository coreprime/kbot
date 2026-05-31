package hpi

import (
	"os"
	"path/filepath"
	"testing"
)

// TestOpenReaderDetectsV1 confirms OpenReader transparently selects the v1
// reader for a Total Annihilation archive.
func TestOpenReaderDetectsV1(t *testing.T) {
	root := os.Getenv("TA_PACKED_PATH")
	if root == "" {
		t.Skip("TA_PACKED_PATH not set — skipping v1 auto-detect test")
	}
	archive := filepath.Join(root, "totala1.hpi")
	if _, err := os.Stat(archive); err != nil {
		t.Skipf("%s not found: %v", archive, err)
	}

	a, err := OpenReader(archive)
	if err != nil {
		t.Fatalf("OpenReader(%s): %v", archive, err)
	}
	defer func() { _ = a.Close() }()

	if got := a.Version(); got != VersionV1 {
		t.Fatalf("version = 0x%X, want VersionV1 (0x%X)", got, VersionV1)
	}
	if len(a.List()) == 0 {
		t.Fatal("v1 archive listed no files")
	}
}

// TestOpenReaderDetectsV2 confirms OpenReader transparently selects the v2
// reader for a TA: Kingdoms archive.
func TestOpenReaderDetectsV2(t *testing.T) {
	root := os.Getenv("TAK_PACKED_PATH")
	if root == "" {
		t.Skip("TAK_PACKED_PATH not set — skipping v2 auto-detect test")
	}
	archive := filepath.Join(root, "data.hpi")
	if _, err := os.Stat(archive); err != nil {
		t.Skipf("%s not found: %v", archive, err)
	}

	a, err := OpenReader(archive)
	if err != nil {
		t.Fatalf("OpenReader(%s): %v", archive, err)
	}
	defer func() { _ = a.Close() }()

	if got := a.Version(); got != VersionV2 {
		t.Fatalf("version = 0x%X, want VersionV2 (0x%X)", got, VersionV2)
	}
	if len(a.List()) == 0 {
		t.Fatal("v2 archive listed no files")
	}
}
