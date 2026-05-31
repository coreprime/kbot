package v2

import (
	"bytes"
	"crypto/sha256"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/coreprime/kbot/formats/hpi/common"
)

// TestWriteReadRoundTrip writes a small archive with both compressed and raw
// entries, then reads it back and confirms every payload survives intact.
func TestWriteReadRoundTrip(t *testing.T) {
	cases := []struct {
		path string
		data []byte
	}{
		{"readme.txt", []byte("TA: Kingdoms HPI v2 round trip.")},
		{"units/aramon/swordsman.txt", bytes.Repeat([]byte("ABCD1234"), 4096)},
		{"units/veruna/empty.dat", nil},
		{"scripts/deep/nested/leaf.bin", []byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9}},
	}

	for _, method := range []struct {
		name string
		comp uint8
	}{
		{"zlib", common.CompressionZLib},
		{"none", common.CompressionNone},
	} {
		t.Run(method.name, func(t *testing.T) {
			dir := t.TempDir()
			archive := filepath.Join(dir, "out.hpi")

			w, err := CreateWriter(archive)
			if err != nil {
				t.Fatalf("CreateWriter: %v", err)
			}
			w.CompressionMethod = method.comp
			for _, c := range cases {
				if err := w.AddFileFromBytes(c.path, c.data); err != nil {
					t.Fatalf("AddFileFromBytes(%s): %v", c.path, err)
				}
			}
			if err := w.Close(); err != nil {
				t.Fatalf("Close: %v", err)
			}

			r, err := Open(archive)
			if err != nil {
				t.Fatalf("Open: %v", err)
			}
			defer func() { _ = r.Close() }()

			if got := r.Version(); got != common.VersionV2 {
				t.Fatalf("version = 0x%X, want 0x%X", got, common.VersionV2)
			}

			for _, c := range cases {
				rc, err := r.Open(c.path)
				if err != nil {
					t.Fatalf("Open(%s): %v", c.path, err)
				}
				got, err := io.ReadAll(rc)
				_ = rc.Close()
				if err != nil {
					t.Fatalf("ReadAll(%s): %v", c.path, err)
				}
				want := c.data
				if want == nil {
					want = []byte{}
				}
				if !bytes.Equal(got, want) {
					t.Fatalf("payload mismatch for %s: got %d bytes, want %d", c.path, len(got), len(want))
				}
			}
		})
	}
}

// TestRepackRealArchive extracts every file from a real TA: Kingdoms archive,
// repacks it with our v2 writer, and confirms our reader recovers byte-identical
// payloads. Skips when TAK_PACKED_PATH is unavailable.
func TestRepackRealArchive(t *testing.T) {
	root := os.Getenv("TAK_PACKED_PATH")
	if root == "" {
		t.Skip("TAK_PACKED_PATH not set — skipping TA: Kingdoms repack test")
	}
	src := filepath.Join(root, "data.hpi")
	if _, err := os.Stat(src); err != nil {
		t.Skipf("%s not found: %v", src, err)
	}

	in, err := Open(src)
	if err != nil {
		t.Fatalf("Open(%s): %v", src, err)
	}
	defer func() { _ = in.Close() }()

	type fileData struct {
		path string
		sum  [32]byte
		size int
	}
	var originals []fileData

	dir := t.TempDir()
	out := filepath.Join(dir, "repacked.hpi")
	w, err := CreateWriter(out)
	if err != nil {
		t.Fatalf("CreateWriter: %v", err)
	}

	err = in.Walk(func(e *common.Entry) error {
		if e.IsDir {
			return nil
		}
		rc, err := in.OpenEntry(e)
		if err != nil {
			return err
		}
		data, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			return err
		}
		p := e.FullPath()
		originals = append(originals, fileData{path: p, sum: sha256.Sum256(data), size: len(data)})
		return w.AddFileFromBytes(p, data)
	})
	if err != nil {
		t.Fatalf("walk/extract source: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("Close repacked: %v", err)
	}

	if len(originals) == 0 {
		t.Skip("source archive contained no files")
	}

	rt, err := Open(out)
	if err != nil {
		t.Fatalf("Open repacked: %v", err)
	}
	defer func() { _ = rt.Close() }()

	for _, o := range originals {
		rc, err := rt.Open(o.path)
		if err != nil {
			t.Fatalf("Open(%s) in repacked: %v", o.path, err)
		}
		data, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			t.Fatalf("ReadAll(%s): %v", o.path, err)
		}
		if len(data) != o.size || sha256.Sum256(data) != o.sum {
			t.Fatalf("repacked %s mismatch: got %d bytes (hash %x), want %d bytes (hash %x)",
				o.path, len(data), sha256.Sum256(data), o.size, o.sum)
		}
	}

	t.Logf("repacked and verified %d files from %s", len(originals), src)
}
