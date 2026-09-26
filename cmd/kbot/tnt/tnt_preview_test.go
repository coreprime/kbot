package tnt

import (
	"os"
	"path/filepath"
	"testing"

	hpiv2 "github.com/coreprime/kbot-io/formats/hpi/v2"
	"github.com/coreprime/kbot-io/testutil"
)

// TestPreviewMountsPastBadArchives runs `kbot tnt preview` against a VFS
// root holding a partial download and a TA: Kingdoms archive. The game
// skips both; the preview must too, rather than abort the mount.
func TestPreviewMountsPastBadArchives(t *testing.T) {
	src := testutil.UnpackedFile(t, "maps", "metal heck.tnt")
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	work := t.TempDir()
	tntPath := filepath.Join(work, "metal heck.tnt")
	if err := os.WriteFile(tntPath, data, 0o644); err != nil {
		t.Fatal(err)
	}

	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "broken.hpi"), []byte("HAPI partial download"), 0o644); err != nil {
		t.Fatal(err)
	}
	w, err := hpiv2.CreateWriter(filepath.Join(root, "kingdoms.hpi"))
	if err != nil {
		t.Fatal(err)
	}
	_ = w.AddFileFromBytes("features/x.tdf", []byte("[X]{}"))
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}

	out := filepath.Join(work, "preview.png")
	cmd := newTNTPreviewCommand()
	cmd.SetArgs([]string{tntPath, "--vfs", root, "--target", out})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("preview: %v", err)
	}
	if info, err := os.Stat(out); err != nil || info.Size() == 0 {
		t.Fatalf("no preview written: %v", err)
	}
}
