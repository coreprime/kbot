package kbotctx

import (
	"os"
	"path/filepath"
	"testing"
)

func tempConfig(t *testing.T) *Config {
	t.Helper()
	dir := t.TempDir()
	cfg, err := loadFrom(filepath.Join(dir, ConfigFileName))
	if err != nil {
		t.Fatalf("loadFrom: %v", err)
	}
	return cfg
}

func TestAddAndSaveRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ConfigFileName)
	cfg, err := loadFrom(path)
	if err != nil {
		t.Fatalf("loadFrom empty: %v", err)
	}

	if err := cfg.Add("totala", Context{Path: dir, Game: GameTotalA, Version: "3.1c"}, false); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if cfg.Current != "totala" {
		t.Fatalf("first added context should become current, got %q", cfg.Current)
	}
	if err := cfg.Save(); err != nil {
		t.Fatalf("Save: %v", err)
	}

	reload, err := loadFrom(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if got := reload.Contexts["totala"]; got.Game != GameTotalA || got.Version != "3.1c" {
		t.Fatalf("unexpected context after reload: %+v", got)
	}
}

func TestAddRejectsBadInputs(t *testing.T) {
	cfg := tempConfig(t)
	cases := []struct {
		name string
		fn   func() error
	}{
		{"empty alias", func() error { return cfg.Add("", Context{Path: "/x", Game: GameTotalA}, false) }},
		{"alias with slash", func() error { return cfg.Add("a/b", Context{Path: "/x", Game: GameTotalA}, false) }},
		{"alias with space", func() error { return cfg.Add("a b", Context{Path: "/x", Game: GameTotalA}, false) }},
		{"missing game", func() error { return cfg.Add("x", Context{Path: "/x"}, false) }},
		{"unknown game", func() error { return cfg.Add("x", Context{Path: "/x", Game: "doom"}, false) }},
		{"missing path", func() error { return cfg.Add("x", Context{Game: GameTotalA}, false) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.fn(); err == nil {
				t.Fatalf("expected error")
			}
		})
	}
}

func TestAddRejectsDuplicateUnlessReplace(t *testing.T) {
	cfg := tempConfig(t)
	if err := cfg.Add("a", Context{Path: "/x", Game: GameTotalA}, false); err != nil {
		t.Fatalf("first add: %v", err)
	}
	if err := cfg.Add("a", Context{Path: "/y", Game: GameTotalA}, false); err == nil {
		t.Fatalf("expected duplicate error")
	}
	if err := cfg.Add("a", Context{Path: "/y", Game: GameTotalA}, true); err != nil {
		t.Fatalf("replace add: %v", err)
	}
	if got := cfg.Contexts["a"]; !filepath.IsAbs(got.Path) {
		t.Fatalf("path should be absolute, got %q", got.Path)
	}
}

func TestUseAndDelete(t *testing.T) {
	cfg := tempConfig(t)
	if err := cfg.Add("a", Context{Path: "/x", Game: GameTotalA}, false); err != nil {
		t.Fatalf("add a: %v", err)
	}
	if err := cfg.Add("b", Context{Path: "/y", Game: GameTAKingdoms}, false); err != nil {
		t.Fatalf("add b: %v", err)
	}
	if err := cfg.Use("missing"); err == nil {
		t.Fatalf("expected error on Use(missing)")
	}
	if err := cfg.Use("b"); err != nil {
		t.Fatalf("Use b: %v", err)
	}
	if cfg.Current != "b" {
		t.Fatalf("Current should be b, got %q", cfg.Current)
	}
	if err := cfg.Delete("b"); err != nil {
		t.Fatalf("delete b: %v", err)
	}
	if cfg.Current != "" {
		t.Fatalf("deleting current should clear Current, got %q", cfg.Current)
	}
	if err := cfg.Delete("b"); err == nil {
		t.Fatalf("expected error deleting missing")
	}
}

func TestActiveEnvOverrides(t *testing.T) {
	cfg := tempConfig(t)
	_ = cfg.Add("a", Context{Path: "/x", Game: GameTotalA}, false)
	_ = cfg.Add("b", Context{Path: "/y", Game: GameTAKingdoms}, false)
	_ = cfg.Use("a")

	t.Setenv(EnvVar, "")
	alias, _, source, ok := cfg.Active()
	if !ok || alias != "a" || source != "config" {
		t.Fatalf("expected (a, config, true), got (%q, %q, %v)", alias, source, ok)
	}

	t.Setenv(EnvVar, "b")
	alias, ctx, source, ok := cfg.Active()
	if !ok || alias != "b" || source != "env" {
		t.Fatalf("env override failed: (%q, %q, %v)", alias, source, ok)
	}
	if ctx.Game != GameTAKingdoms {
		t.Fatalf("unexpected ctx returned: %+v", ctx)
	}

	t.Setenv(EnvVar, "nope")
	alias, _, source, ok = cfg.Active()
	if ok {
		t.Fatalf("expected ok=false when env names missing context")
	}
	if alias != "nope" || source != "env" {
		t.Fatalf("expected env source surfaced even on miss, got (%q, %q)", alias, source)
	}
}

func TestLoadMissingFile(t *testing.T) {
	dir := t.TempDir()
	cfg, err := loadFrom(filepath.Join(dir, ConfigFileName))
	if err != nil {
		t.Fatalf("loadFrom: %v", err)
	}
	if len(cfg.Contexts) != 0 {
		t.Fatalf("expected empty config, got %+v", cfg.Contexts)
	}
}

func TestLoadCorruptFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, ConfigFileName)
	if err := os.WriteFile(p, []byte("{not json"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := loadFrom(p); err == nil {
		t.Fatalf("expected parse error")
	}
}
