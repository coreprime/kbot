package filesystem

import (
	"os"
	"path/filepath"
	"testing"
)

// writeDisk is a test helper that writes a file (creating parent dirs) under dir.
func writeDisk(t *testing.T, dir, rel, content string) {
	t.Helper()
	full := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatalf("mkdir for %s: %v", rel, err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", rel, err)
	}
}

// newOverlay builds a VFS with a writable work folder on top of a read-only base
// context directory.
func newOverlay(t *testing.T) (vfs *VirtualFileSystem, base, work string) {
	t.Helper()
	base = t.TempDir()
	work = t.TempDir()
	vfs, err := NewLayered([]Source{
		{Kind: SourceLooseDir, Path: work, Writable: true, Label: "Workspace"},
		{Kind: SourceContextDir, Path: base},
	}, &Config{Extensions: []string{".hpi"}})
	if err != nil {
		t.Fatalf("NewLayered: %v", err)
	}
	t.Cleanup(func() { _ = vfs.Close() })
	return vfs, base, work
}

func TestLayeredPrecedence(t *testing.T) {
	base := t.TempDir()
	work := t.TempDir()
	writeDisk(t, base, "units/armcom.fbi", "base")
	writeDisk(t, base, "units/corecom.fbi", "base-only")
	writeDisk(t, work, "units/armcom.fbi", "override")
	writeDisk(t, work, "units/new.fbi", "work-only")

	vfs, err := NewLayered([]Source{
		{Kind: SourceLooseDir, Path: work, Writable: true},
		{Kind: SourceContextDir, Path: base},
	}, &Config{})
	if err != nil {
		t.Fatalf("NewLayered: %v", err)
	}
	defer func() { _ = vfs.Close() }()

	cases := map[string]string{
		"units/armcom.fbi":  "override",  // work wins over base
		"units/corecom.fbi": "base-only", // resolves from base
		"units/new.fbi":     "work-only", // only in work
	}
	for path, want := range cases {
		data, err := vfs.ReadFile(path)
		if err != nil {
			t.Errorf("ReadFile(%s): %v", path, err)
			continue
		}
		if string(data) != want {
			t.Errorf("ReadFile(%s) = %q, want %q", path, string(data), want)
		}
	}
}

func TestLayeredGetFileLayers(t *testing.T) {
	base := t.TempDir()
	work := t.TempDir()
	writeDisk(t, base, "units/armcom.fbi", "base")
	writeDisk(t, work, "units/armcom.fbi", "override")

	vfs, err := NewLayered([]Source{
		{Kind: SourceLooseDir, Path: work, Writable: true, Label: "Workspace"},
		{Kind: SourceContextDir, Path: base},
	}, &Config{})
	if err != nil {
		t.Fatalf("NewLayered: %v", err)
	}
	defer func() { _ = vfs.Close() }()

	layers := vfs.GetFileLayers("units/armcom.fbi")
	if len(layers) != 2 {
		t.Fatalf("expected 2 layers, got %d: %+v", len(layers), layers)
	}
	if layers[0].Priority != 0 || layers[0].Source != "Workspace" {
		t.Errorf("top layer = %+v, want Workspace at priority 0", layers[0])
	}
	if layers[1].Source != physicalSource {
		t.Errorf("bottom layer source = %q, want %q", layers[1].Source, physicalSource)
	}
}

func TestWriteFileCopyOnWriteOverride(t *testing.T) {
	base := t.TempDir()
	work := t.TempDir()
	writeDisk(t, base, "units/armcom.fbi", "base")

	vfs, err := NewLayered([]Source{
		{Kind: SourceLooseDir, Path: work, Writable: true},
		{Kind: SourceContextDir, Path: base},
	}, &Config{})
	if err != nil {
		t.Fatalf("NewLayered: %v", err)
	}
	defer func() { _ = vfs.Close() }()

	if vfs.IsLocal("units/armcom.fbi") {
		t.Fatal("file should not be local before edit")
	}
	if err := vfs.EnsureLocal("units/armcom.fbi"); err != nil {
		t.Fatalf("EnsureLocal: %v", err)
	}
	if !vfs.IsLocal("units/armcom.fbi") {
		t.Fatal("file should be local after EnsureLocal")
	}
	if err := vfs.WriteFile("units/armcom.fbi", []byte("edited")); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if data, _ := vfs.ReadFile("units/armcom.fbi"); string(data) != "edited" {
		t.Errorf("after edit = %q, want %q", string(data), "edited")
	}
	// The override must physically live in the work folder, not the base.
	if _, err := os.Stat(filepath.Join(work, "units", "armcom.fbi")); err != nil {
		t.Errorf("override not written to work folder: %v", err)
	}
	if data, _ := os.ReadFile(filepath.Join(base, "units", "armcom.fbi")); string(data) != "base" {
		t.Errorf("base file was modified: %q", string(data))
	}
}

func TestRemoveRevertsOverrideToBase(t *testing.T) {
	base := t.TempDir()
	work := t.TempDir()
	writeDisk(t, base, "units/armcom.fbi", "base")

	vfs, err := NewLayered([]Source{
		{Kind: SourceLooseDir, Path: work, Writable: true},
		{Kind: SourceContextDir, Path: base},
	}, &Config{})
	if err != nil {
		t.Fatalf("NewLayered: %v", err)
	}
	defer func() { _ = vfs.Close() }()

	if err := vfs.WriteFile("units/armcom.fbi", []byte("override")); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if got, _ := vfs.ReadFile("units/armcom.fbi"); string(got) != "override" {
		t.Fatalf("setup override failed: %q", string(got))
	}

	if err := vfs.Remove("units/armcom.fbi"); err != nil {
		t.Fatalf("Remove override: %v", err)
	}
	// Reverts to base, not gone.
	if !vfs.Exists("units/armcom.fbi") {
		t.Fatal("file should still exist (reverted to base) after removing override")
	}
	if got, _ := vfs.ReadFile("units/armcom.fbi"); string(got) != "base" {
		t.Errorf("after revert = %q, want %q", string(got), "base")
	}
	if vfs.IsLocal("units/armcom.fbi") {
		t.Error("file should no longer be local after revert")
	}
}

func TestRemoveLocalOnlyFile(t *testing.T) {
	vfs, _, _ := newOverlay(t)
	if err := vfs.WriteFile("units/new.fbi", []byte("x")); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := vfs.Remove("units/new.fbi"); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if vfs.Exists("units/new.fbi") {
		t.Error("local-only file should be gone after remove")
	}
}

func TestRemoveBaseFileRejected(t *testing.T) {
	base := t.TempDir()
	work := t.TempDir()
	writeDisk(t, base, "units/armcom.fbi", "base")

	vfs, err := NewLayered([]Source{
		{Kind: SourceLooseDir, Path: work, Writable: true},
		{Kind: SourceContextDir, Path: base},
	}, &Config{})
	if err != nil {
		t.Fatalf("NewLayered: %v", err)
	}
	defer func() { _ = vfs.Close() }()

	if err := vfs.Remove("units/armcom.fbi"); err == nil {
		t.Error("expected error removing a base-only file, got nil")
	}
	if !vfs.Exists("units/armcom.fbi") {
		t.Error("base file should still exist after rejected remove")
	}
}

func TestReadOnlyRejectsWrites(t *testing.T) {
	base := t.TempDir()
	writeDisk(t, base, "units/armcom.fbi", "base")

	vfs, err := NewLayered([]Source{
		{Kind: SourceContextDir, Path: base},
	}, &Config{})
	if err != nil {
		t.Fatalf("NewLayered: %v", err)
	}
	defer func() { _ = vfs.Close() }()

	if err := vfs.WriteFile("units/new.fbi", []byte("x")); err == nil {
		t.Error("expected WriteFile to fail on read-only VFS")
	}
	if err := vfs.Remove("units/armcom.fbi"); err == nil {
		t.Error("expected Remove to fail on read-only VFS")
	}
	if err := vfs.EnsureLocal("units/armcom.fbi"); err == nil {
		t.Error("expected EnsureLocal to fail on read-only VFS")
	}
	if vfs.IsLocal("units/armcom.fbi") {
		t.Error("read-only VFS should report nothing as local")
	}
}

func TestWritableSourceMustBeTop(t *testing.T) {
	base := t.TempDir()
	work := t.TempDir()
	_, err := NewLayered([]Source{
		{Kind: SourceContextDir, Path: base},
		{Kind: SourceLooseDir, Path: work, Writable: true},
	}, &Config{})
	if err == nil {
		t.Error("expected error when writable source is not the top layer")
	}
}
