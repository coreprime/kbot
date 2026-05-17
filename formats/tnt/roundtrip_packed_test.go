package tnt

import (
	"bytes"
	"crypto/sha512"
	"encoding/hex"
	"fmt"
	"image/color"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/coreprime/kbot/filesystem"
	"github.com/coreprime/kbot/formats/gaf"
	"github.com/coreprime/kbot/internal/assets"
	"github.com/coreprime/kbot/testutil"
)

// TestPackedTNTRoundTrip mounts a VFS over TA_PACKED_PATH, walks every .tnt
// file the VFS sees (across HPI/UFO/CCX/GP3 archives and on-disk files),
// unpacks each one into a temp directory, packs it back, and asserts the
// resulting bytes match the original.  This is the canonical "no information
// loss" test for the TNT codec.
func TestPackedTNTRoundTrip(t *testing.T) {
	packedRoot := testutil.PackedPath(t)

	vfs, err := filesystem.NewVirtualFileSystem(packedRoot, &filesystem.Config{
		Extensions: []string{".hpi", ".ccx", ".gp3", ".ufo"},
		SkipErrors: true,
	})
	if err != nil {
		t.Fatalf("mount VFS at %s: %v", packedRoot, err)
	}
	defer func() { _ = vfs.Close() }()

	pal, err := loadDefaultPalette()
	if err != nil {
		t.Fatalf("load palette: %v", err)
	}

	maps := collectTNTPaths(vfs)
	if len(maps) == 0 {
		t.Fatalf("no .tnt files found via VFS at %s", packedRoot)
	}
	t.Logf("discovered %d .tnt files via VFS", len(maps))

	tmpRoot := t.TempDir()
	pass, fail := 0, 0
	var failures []string

	for _, virtPath := range maps {
		t.Run(virtPath, func(t *testing.T) {
			original, err := readVFSFile(vfs, virtPath)
			if err != nil {
				t.Fatalf("read %s from VFS: %v", virtPath, err)
			}

			m, err := LoadFromReader(bytes.NewReader(original))
			if err != nil {
				t.Fatalf("parse %s: %v", virtPath, err)
			}
			features, err := m.LoadFeatures(bytes.NewReader(original))
			if err != nil {
				t.Fatalf("read features from %s: %v", virtPath, err)
			}

			unpackDir := filepath.Join(tmpRoot, "unpack", sanitisePath(virtPath))
			if err := Unpack(m, features, pal, unpackDir); err != nil {
				t.Fatalf("unpack %s: %v", virtPath, err)
			}

			m2, features2, err := Pack(unpackDir)
			if err != nil {
				t.Fatalf("pack %s from %s: %v", virtPath, unpackDir, err)
			}

			var buf bytes.Buffer
			if err := m2.Save(&buf, features2); err != nil {
				t.Fatalf("save %s: %v", virtPath, err)
			}
			repacked := buf.Bytes()

			if !bytes.Equal(original, repacked) {
				origHash := sha512.Sum512(original)
				newHash := sha512.Sum512(repacked)
				firstDiff := firstDifferingByte(original, repacked)
				t.Errorf("%s: round-trip not byte-identical\n  original len=%d sha512=%s\n  repacked len=%d sha512=%s\n  first diff at byte %d",
					virtPath, len(original), hex.EncodeToString(origHash[:8]),
					len(repacked), hex.EncodeToString(newHash[:8]), firstDiff)
				failures = append(failures, fmt.Sprintf("%s (first diff @ %d)", virtPath, firstDiff))
				fail++

				// Drop a copy of the repacked bytes next to the unpack dir for inspection.
				_ = os.WriteFile(filepath.Join(unpackDir, "repacked.tnt"), repacked, 0o644)
				return
			}

			// Cleanup the unpack dir on success to keep tmp small.
			_ = os.RemoveAll(unpackDir)
			pass++
		})
	}

	t.Logf("TNT round-trip: %d pass, %d fail (of %d)", pass, fail, len(maps))
	if fail > 0 && len(failures) <= 20 {
		for _, f := range failures {
			t.Logf("  FAIL: %s", f)
		}
	}
}

// collectTNTPaths returns every virtual path in vfs whose extension is .tnt,
// in stable lexicographic order.
func collectTNTPaths(vfs *filesystem.VirtualFileSystem) []string {
	var out []string
	for _, p := range vfs.List() {
		if strings.EqualFold(filepath.Ext(p), ".tnt") {
			out = append(out, p)
		}
	}
	return out
}

// readVFSFile streams a single virtual file into memory.
func readVFSFile(vfs *filesystem.VirtualFileSystem, path string) ([]byte, error) {
	rc, err := vfs.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rc.Close() }()
	return io.ReadAll(rc)
}

// loadDefaultPalette returns the embedded TA palette in color.Palette form.
func loadDefaultPalette() (color.Palette, error) {
	p, err := gaf.LoadPaletteFromBytes(assets.DefaultPalette)
	if err != nil {
		return nil, err
	}
	return p.ColorModel(), nil
}

func sanitisePath(p string) string {
	r := strings.NewReplacer("/", "_", "\\", "_", ":", "_", " ", "_")
	return r.Replace(p)
}

func firstDifferingByte(a, b []byte) int {
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	for i := 0; i < n; i++ {
		if a[i] != b[i] {
			return i
		}
	}
	if len(a) != len(b) {
		return n
	}
	return -1
}
