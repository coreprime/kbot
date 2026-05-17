package mcp

import (
	"strings"
	"testing"
)

func TestRegistry_AddDefaultAndNamed(t *testing.T) {
	r := NewRegistry()
	defer func() { _ = r.Close() }()

	root := t.TempDir()
	gd, err := r.Add("totala=" + root)
	if err != nil {
		t.Fatalf("Add named: %v", err)
	}
	if gd.Name != "totala" {
		t.Fatalf("name: got %q, want %q", gd.Name, "totala")
	}

	other := t.TempDir()
	gd2, err := r.Add(other)
	if err != nil {
		t.Fatalf("Add unnamed: %v", err)
	}
	if gd2.Name == "totala" {
		t.Fatalf("derived name should differ from existing")
	}

	def := r.Default()
	if def == nil || def.Name != "totala" {
		t.Fatalf("default should be first-added (got %v)", def)
	}

	got, err := r.Get("")
	if err != nil || got.Name != "totala" {
		t.Fatalf("Get(\"\") should return default, got %v / err %v", got, err)
	}

	got, err = r.Get("totala")
	if err != nil || got.Name != "totala" {
		t.Fatalf("Get named failed: %v / %v", got, err)
	}

	if _, err := r.Get("unknown"); err == nil {
		t.Fatal("Get unknown should error")
	}
}

func TestRegistry_RejectsDuplicateName(t *testing.T) {
	r := NewRegistry()
	defer func() { _ = r.Close() }()

	root := t.TempDir()
	if _, err := r.Add("totala=" + root); err != nil {
		t.Fatalf("first add: %v", err)
	}
	if _, err := r.Add("totala=" + t.TempDir()); err == nil {
		t.Fatal("duplicate name should error")
	}
}

func TestRegistry_RejectsBadPath(t *testing.T) {
	r := NewRegistry()
	defer func() { _ = r.Close() }()

	if _, err := r.Add("totala=/path/that/does/not/exist/anywhere"); err == nil {
		t.Fatal("nonexistent path should error")
	}
}

func TestSplitGameDataSpec(t *testing.T) {
	cases := []struct {
		spec       string
		wantName   string
		wantPath   string
	}{
		{"foo=/bar", "foo", "/bar"},
		{"/bar", "", "/bar"},
		{" foo = /bar ", "foo", "/bar"},
		{"=", "", ""},
	}
	for _, tc := range cases {
		name, path := splitGameDataSpec(tc.spec)
		if name != tc.wantName || path != tc.wantPath {
			t.Errorf("split(%q) = (%q,%q), want (%q,%q)",
				tc.spec, name, path, tc.wantName, tc.wantPath)
		}
	}
}

func TestDefaultGameDataName(t *testing.T) {
	cases := map[string]string{
		"/games/totala":             "totala",
		"/games/total-annihilation": "total-annihilation",
		"/":                         "default",
	}
	for in, want := range cases {
		got := defaultGameDataName(in)
		if got != want {
			t.Errorf("defaultGameDataName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRegistry_EmptyDefaultWhenNoneAdded(t *testing.T) {
	r := NewRegistry()
	defer func() { _ = r.Close() }()
	if def := r.Default(); def != nil {
		t.Fatalf("expected nil default, got %v", def)
	}
	got, err := r.Get("")
	if err != nil {
		t.Fatalf("Get(\"\") on empty registry: %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil from Get(\"\") on empty registry, got %v", got)
	}
}

func TestRegistry_GetUnknownListsNames(t *testing.T) {
	r := NewRegistry()
	defer func() { _ = r.Close() }()

	root := t.TempDir()
	if _, err := r.Add("totala=" + root); err != nil {
		t.Fatalf("Add: %v", err)
	}
	_, err := r.Get("missing")
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "totala") {
		t.Errorf("error should list known names, got: %v", err)
	}
}
