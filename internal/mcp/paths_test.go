package mcp

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPathGuard_Permissive(t *testing.T) {
	g, err := NewPathGuard(nil)
	if err != nil {
		t.Fatalf("NewPathGuard(nil): %v", err)
	}
	if !g.Permissive() {
		t.Fatal("expected guard with no roots to be permissive")
	}

	// Any absolute path resolves through unchanged (cleaned).
	got, err := g.Resolve("/tmp/some/path")
	if err != nil {
		t.Fatalf("Resolve absolute: %v", err)
	}
	if got != "/tmp/some/path" {
		t.Fatalf("got %q, want %q", got, "/tmp/some/path")
	}
}

func TestPathGuard_AllowsInsideRoot(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "sub", "file.txt")
	if err := os.MkdirAll(filepath.Dir(inside), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(inside, []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}

	g, err := NewPathGuard([]string{root})
	if err != nil {
		t.Fatalf("NewPathGuard: %v", err)
	}
	if g.Permissive() {
		t.Fatal("guard should not be permissive")
	}

	got, err := g.Resolve(inside)
	if err != nil {
		t.Fatalf("Resolve inside root: %v", err)
	}
	if got != inside {
		t.Fatalf("got %q, want %q", got, inside)
	}
}

func TestPathGuard_RejectsOutsideRoot(t *testing.T) {
	root := t.TempDir()
	other := t.TempDir()
	outside := filepath.Join(other, "evil.txt")

	g, err := NewPathGuard([]string{root})
	if err != nil {
		t.Fatalf("NewPathGuard: %v", err)
	}
	if _, err := g.Resolve(outside); err == nil {
		t.Fatal("expected Resolve to reject path outside root")
	}
}

func TestPathGuard_RejectsTraversal(t *testing.T) {
	root := t.TempDir()
	other := t.TempDir()
	if err := os.WriteFile(filepath.Join(other, "secret.txt"), []byte("nope"), 0o644); err != nil {
		t.Fatal(err)
	}

	g, err := NewPathGuard([]string{root})
	if err != nil {
		t.Fatalf("NewPathGuard: %v", err)
	}

	// ../-style escape from inside the root.
	escape := filepath.Join(root, "..", filepath.Base(other), "secret.txt")
	if _, err := g.Resolve(escape); err == nil {
		t.Fatalf("expected Resolve to reject traversal %q", escape)
	}
}

func TestPathGuard_RejectsSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	target := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(target, []byte("nope"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Plant a symlink inside the root that points outside.
	link := filepath.Join(root, "escape.txt")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}

	g, err := NewPathGuard([]string{root})
	if err != nil {
		t.Fatalf("NewPathGuard: %v", err)
	}
	if _, err := g.Resolve(link); err == nil {
		t.Fatal("expected Resolve to reject symlink escape")
	}
}

func TestPathGuard_AllowsNonexistentOutputUnderRoot(t *testing.T) {
	root := t.TempDir()
	out := filepath.Join(root, "newdir", "newfile.png")

	g, err := NewPathGuard([]string{root})
	if err != nil {
		t.Fatalf("NewPathGuard: %v", err)
	}
	got, err := g.Resolve(out)
	if err != nil {
		t.Fatalf("Resolve nonexistent output: %v", err)
	}
	if got != out {
		t.Fatalf("got %q, want %q", got, out)
	}
}

func TestPathGuard_RelativePathAnchorsToFirstRoot(t *testing.T) {
	root := t.TempDir()
	g, err := NewPathGuard([]string{root})
	if err != nil {
		t.Fatalf("NewPathGuard: %v", err)
	}

	got, err := g.Resolve("foo/bar.cob")
	if err != nil {
		t.Fatalf("Resolve relative: %v", err)
	}
	want := filepath.Join(root, "foo", "bar.cob")
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestPathGuard_EmptyPathErrors(t *testing.T) {
	g, _ := NewPathGuard(nil)
	if _, err := g.Resolve(""); err == nil {
		t.Fatal("expected empty path to error")
	}
}

func TestPathGuard_MultipleRoots(t *testing.T) {
	r1 := t.TempDir()
	r2 := t.TempDir()
	g, err := NewPathGuard([]string{r1, r2})
	if err != nil {
		t.Fatalf("NewPathGuard: %v", err)
	}

	for _, root := range []string{r1, r2} {
		f := filepath.Join(root, "x.txt")
		if err := os.WriteFile(f, []byte("ok"), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := g.Resolve(f); err != nil {
			t.Fatalf("Resolve %q failed: %v", f, err)
		}
	}

	roots := g.Roots()
	if len(roots) != 2 {
		t.Fatalf("expected 2 roots, got %d", len(roots))
	}
}

func TestPathGuard_IgnoresEmptyRoots(t *testing.T) {
	root := t.TempDir()
	g, err := NewPathGuard([]string{"", root, ""})
	if err != nil {
		t.Fatalf("NewPathGuard: %v", err)
	}
	if g.Permissive() {
		t.Fatal("guard with one non-empty root should not be permissive")
	}
	if len(g.Roots()) != 1 {
		t.Fatalf("expected 1 root, got %d", len(g.Roots()))
	}
}

func TestContainedIn(t *testing.T) {
	cases := []struct {
		root, cand string
		want       bool
	}{
		{"/a", "/a", true},
		{"/a", "/a/b", true},
		{"/a", "/a/b/c", true},
		{"/a", "/b", false},
		{"/a", "/", false},
		{"/a", "/ab", false}, // common prefix but not contained
	}
	for _, tc := range cases {
		got := containedIn(tc.root, tc.cand)
		if got != tc.want {
			t.Errorf("containedIn(%q,%q) = %v, want %v", tc.root, tc.cand, got, tc.want)
		}
	}
}
