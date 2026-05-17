package mcp

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// makeTestGameData creates a small game-data folder with a couple of files
// at the top level and inside a subdirectory.  Returns the absolute path
// with symlinks resolved so it matches paths returned by the resolver.
func makeTestGameData(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if resolved, err := filepath.EvalSymlinks(root); err == nil {
		root = resolved
	}

	if err := os.MkdirAll(filepath.Join(root, "scripts"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "scripts", "ARMCOM.bos"), []byte("// armcom"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "scripts", "CORCOM.bos"), []byte("// corcom"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "readme.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

func makeResolver(t *testing.T, root string) *Resolver {
	t.Helper()
	guard, err := NewPathGuard([]string{root})
	if err != nil {
		t.Fatalf("NewPathGuard: %v", err)
	}
	reg := NewRegistry()
	t.Cleanup(func() { _ = reg.Close() })
	if _, err := reg.Add("totala=" + root); err != nil {
		t.Fatalf("Registry.Add: %v", err)
	}
	return NewResolver(guard, reg)
}

func TestResolver_AbsolutePath(t *testing.T) {
	root := makeTestGameData(t)
	r := makeResolver(t, root)

	want := filepath.Join(root, "scripts", "ARMCOM.bos")
	rf, err := r.ResolveFile(want, "")
	if err != nil {
		t.Fatalf("ResolveFile abs: %v", err)
	}
	defer func() { _ = rf.Close() }()
	if rf.LocalPath != want {
		t.Errorf("LocalPath: got %q, want %q", rf.LocalPath, want)
	}
	if rf.Source != "disk" {
		t.Errorf("Source: got %q, want disk", rf.Source)
	}
}

func TestResolver_VirtualPath(t *testing.T) {
	root := makeTestGameData(t)
	r := makeResolver(t, root)

	rf, err := r.ResolveFile("scripts/ARMCOM.bos", "")
	if err != nil {
		t.Fatalf("ResolveFile virtual: %v", err)
	}
	defer func() { _ = rf.Close() }()
	if rf.GameData != "totala" {
		t.Errorf("GameData: got %q, want totala", rf.GameData)
	}
	got, _ := os.ReadFile(rf.LocalPath)
	if string(got) != "// armcom" {
		t.Errorf("content: got %q", got)
	}
}

func TestResolver_BareBasename(t *testing.T) {
	root := makeTestGameData(t)
	r := makeResolver(t, root)

	rf, err := r.ResolveFile("ARMCOM.bos", "")
	if err != nil {
		t.Fatalf("ResolveFile bare: %v", err)
	}
	defer func() { _ = rf.Close() }()
	if rf.GameData != "totala" {
		t.Errorf("GameData: got %q, want totala", rf.GameData)
	}
	if rf.LocalPath == "" {
		t.Error("LocalPath empty")
	}
	got, _ := os.ReadFile(rf.LocalPath)
	if string(got) != "// armcom" {
		t.Errorf("content: got %q", got)
	}
}

func TestResolver_BareBasenameNotFound(t *testing.T) {
	root := makeTestGameData(t)
	r := makeResolver(t, root)

	_, err := r.ResolveFile("DOES-NOT-EXIST.bos", "")
	if err == nil {
		t.Fatal("expected error for missing file")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Errorf("error message: %v", err)
	}
}

func TestResolver_RelativeAnchorsToGameData(t *testing.T) {
	root := makeTestGameData(t)
	r := makeResolver(t, root)

	// readme.txt is a top-level physical file — neither a bare basename
	// nor an archive — but joining BasePath finds it.
	rf, err := r.ResolveFile("readme.txt", "")
	if err != nil {
		t.Fatalf("ResolveFile relative: %v", err)
	}
	defer func() { _ = rf.Close() }()
	want := filepath.Join(root, "readme.txt")
	if rf.LocalPath != want {
		t.Errorf("LocalPath: got %q, want %q", rf.LocalPath, want)
	}
}

func TestResolver_RelativeWithoutGameDataErrors(t *testing.T) {
	guard, err := NewPathGuard([]string{t.TempDir()})
	if err != nil {
		t.Fatalf("NewPathGuard: %v", err)
	}
	r := NewResolver(guard, NewRegistry())

	_, err = r.ResolveFile("ARMCOM.bos", "")
	if err == nil {
		t.Fatal("expected error when no game-data configured")
	}
	if !strings.Contains(err.Error(), "game-data") {
		t.Errorf("error should mention game-data, got: %v", err)
	}
}

func TestResolver_NamedGameData(t *testing.T) {
	root := makeTestGameData(t)
	other := makeTestGameData(t)
	guard, err := NewPathGuard([]string{root, other})
	if err != nil {
		t.Fatalf("NewPathGuard: %v", err)
	}
	reg := NewRegistry()
	t.Cleanup(func() { _ = reg.Close() })
	if _, err := reg.Add("totala=" + root); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Add("kingdoms=" + other); err != nil {
		t.Fatal(err)
	}
	r := NewResolver(guard, reg)

	// Default should be totala.
	rf, err := r.ResolveFile("ARMCOM.bos", "")
	if err != nil {
		t.Fatalf("default lookup: %v", err)
	}
	if !strings.HasPrefix(rf.LocalPath, root) {
		t.Errorf("default resolved outside totala: %q", rf.LocalPath)
	}
	_ = rf.Close()

	// Explicit lookup against kingdoms.
	rf, err = r.ResolveFile("ARMCOM.bos", "kingdoms")
	if err != nil {
		t.Fatalf("named lookup: %v", err)
	}
	if !strings.HasPrefix(rf.LocalPath, other) {
		t.Errorf("kingdoms resolved outside other: %q", rf.LocalPath)
	}
	_ = rf.Close()
}

func TestResolver_ResolveDirVirtual(t *testing.T) {
	root := makeTestGameData(t)
	r := makeResolver(t, root)

	rd, err := r.ResolveDir("scripts", "", []string{".bos"})
	if err != nil {
		t.Fatalf("ResolveDir: %v", err)
	}
	defer func() { _ = rd.Close() }()
	if len(rd.Files) != 2 {
		t.Errorf("got %d files, want 2", len(rd.Files))
	}
}

func TestResolver_ResolveOutputAnchors(t *testing.T) {
	root := makeTestGameData(t)
	r := makeResolver(t, root)

	got, err := r.ResolveOutput("out/foo.png", "")
	if err != nil {
		t.Fatalf("ResolveOutput: %v", err)
	}
	want := filepath.Join(root, "out", "foo.png")
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestGameData_FindByBasename(t *testing.T) {
	root := makeTestGameData(t)
	gd, err := NewGameData("totala", root)
	if err != nil {
		t.Fatalf("NewGameData: %v", err)
	}
	defer func() { _ = gd.Close() }()

	hits, err := gd.FindByBasename("ARMCOM.bos")
	if err != nil {
		t.Fatalf("FindByBasename: %v", err)
	}
	if len(hits) != 1 {
		t.Fatalf("got %d hits, want 1", len(hits))
	}
	// Case-insensitive lookup.
	hits, err = gd.FindByBasename("armcom.BOS")
	if err != nil {
		t.Fatalf("FindByBasename case: %v", err)
	}
	if len(hits) != 1 {
		t.Fatalf("case-insensitive: got %d hits, want 1", len(hits))
	}
}

func TestGameData_FindByPatternBasenameGlob(t *testing.T) {
	root := makeTestGameData(t)
	gd, err := NewGameData("totala", root)
	if err != nil {
		t.Fatalf("NewGameData: %v", err)
	}
	defer func() { _ = gd.Close() }()

	hits, err := gd.FindByPattern("*.bos")
	if err != nil {
		t.Fatalf("FindByPattern: %v", err)
	}
	if len(hits) != 2 {
		t.Fatalf("got %d hits, want 2", len(hits))
	}
}
