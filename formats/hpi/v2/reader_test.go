package v2

import (
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/coreprime/kbot/formats/hpi/common"
)

// TestOpenAndRead confirms the v2 reader can open a TA: Kingdoms archive and
// successfully extract a file. It opportunistically uses TAK_PACKED_PATH (set in
// .env.local) and skips when the asset is unavailable.
func TestOpenAndRead(t *testing.T) {
	root := os.Getenv("TAK_PACKED_PATH")
	if root == "" {
		t.Skip("TAK_PACKED_PATH not set — skipping TA: Kingdoms HPI v2 test")
	}
	archive := filepath.Join(root, "data.hpi")
	if _, err := os.Stat(archive); err != nil {
		t.Skipf("%s not found: %v", archive, err)
	}

	reader, err := Open(archive)
	if err != nil {
		t.Fatalf("Open(%s): %v", archive, err)
	}
	defer func() { _ = reader.Close() }()

	if got := reader.Version(); got != common.VersionV2 {
		t.Fatalf("version = 0x%X, want 0x%X", got, common.VersionV2)
	}

	var sample *common.Entry
	_ = reader.Walk(func(e *common.Entry) error {
		if sample == nil && !e.IsDir && e.Size > 0 {
			sample = e
		}
		return nil
	})
	if sample == nil {
		t.Fatalf("archive %s contained no readable files", archive)
	}

	rc, err := reader.OpenEntry(sample)
	if err != nil {
		t.Fatalf("OpenEntry(%s): %v", sample.FullPath(), err)
	}
	defer func() { _ = rc.Close() }()

	data, err := io.ReadAll(rc)
	if err != nil {
		t.Fatalf("ReadAll(%s): %v", sample.FullPath(), err)
	}
	if uint32(len(data)) != sample.Size {
		t.Fatalf("decoded %s: got %d bytes, want %d", sample.FullPath(), len(data), sample.Size)
	}
}
