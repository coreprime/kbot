package main

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/coreprime/kbot/internal/kbotctx"
)

// registerDummyContext puts an isolated $HOME under t.TempDir and
// installs a single "dummy" custom context pointing at the in-repo
// testdata/dummy-vfs fixture.  It returns the absolute fixture path.
func registerDummyContext(t *testing.T) string {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv(kbotctx.EnvVar, "") // ignore any inherited override

	fixture, err := filepath.Abs(filepath.Join("testdata", "dummy-vfs"))
	if err != nil {
		t.Fatalf("resolve fixture path: %v", err)
	}

	cfg, err := kbotctx.Load()
	if err != nil {
		t.Fatalf("load empty config: %v", err)
	}
	if err := cfg.Add("dummy", kbotctx.Context{
		Path:    fixture,
		Game:    kbotctx.GameCustom,
		Version: "test",
	}, false); err != nil {
		t.Fatalf("add dummy context: %v", err)
	}
	if err := cfg.Use("dummy"); err != nil {
		t.Fatalf("use dummy context: %v", err)
	}
	if err := cfg.Save(); err != nil {
		t.Fatalf("save config: %v", err)
	}
	return fixture
}

// TestResolveVFSPathPicksUpActiveContext is the integration check the
// user asked for: register a custom context against an in-repo
// testdata folder, mark it active, and verify the shared CLI helper
// resolves to it when no explicit path is supplied.
func TestResolveVFSPathPicksUpActiveContext(t *testing.T) {
	fixture := registerDummyContext(t)

	resolved, source, err := resolveVFSPath("")
	if err != nil {
		t.Fatalf("resolveVFSPath: %v", err)
	}
	if resolved != fixture {
		t.Fatalf("resolved=%q, want %q", resolved, fixture)
	}
	if !strings.Contains(source, "dummy") {
		t.Fatalf("source=%q should reference alias %q", source, "dummy")
	}
}

// TestResolveVFSPathExplicitWins guards against a regression where the
// context silently overrides an explicit user argument.
func TestResolveVFSPathExplicitWins(t *testing.T) {
	_ = registerDummyContext(t)

	resolved, source, err := resolveVFSPath("/some/explicit/path")
	if err != nil {
		t.Fatalf("resolveVFSPath: %v", err)
	}
	if resolved != "/some/explicit/path" {
		t.Fatalf("resolved=%q, want explicit path", resolved)
	}
	if source != "flag" {
		t.Fatalf("source=%q, want %q", source, "flag")
	}
}

// TestResolveVFSPathEnvOverride exercises the KBOT_CONTEXT env path.
func TestResolveVFSPathEnvOverride(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv(kbotctx.EnvVar, "")

	fixture, err := filepath.Abs(filepath.Join("testdata", "dummy-vfs"))
	if err != nil {
		t.Fatalf("resolve fixture path: %v", err)
	}

	cfg, err := kbotctx.Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if err := cfg.Add("a", kbotctx.Context{Path: t.TempDir(), Game: kbotctx.GameCustom}, false); err != nil {
		t.Fatalf("add a: %v", err)
	}
	if err := cfg.Add("dummy", kbotctx.Context{Path: fixture, Game: kbotctx.GameCustom}, false); err != nil {
		t.Fatalf("add dummy: %v", err)
	}
	if err := cfg.Use("a"); err != nil {
		t.Fatalf("use a: %v", err)
	}
	if err := cfg.Save(); err != nil {
		t.Fatalf("save: %v", err)
	}

	// Without env, persisted current ("a") wins.
	resolved, source, err := resolveVFSPath("")
	if err != nil {
		t.Fatalf("resolveVFSPath: %v", err)
	}
	if resolved == fixture {
		t.Fatalf("expected current context to win without env override")
	}
	if !strings.Contains(source, "\"a\"") {
		t.Fatalf("source=%q should reference alias %q", source, "a")
	}

	// With env, override wins.
	t.Setenv(kbotctx.EnvVar, "dummy")
	resolved, source, err = resolveVFSPath("")
	if err != nil {
		t.Fatalf("resolveVFSPath with env: %v", err)
	}
	if resolved != fixture {
		t.Fatalf("expected env override to select fixture, got %q", resolved)
	}
	if !strings.Contains(source, kbotctx.EnvVar) {
		t.Fatalf("source=%q should mention %s", source, kbotctx.EnvVar)
	}
}

// TestResolveVFSPathUnknownEnv asserts a clear error when KBOT_CONTEXT
// names a context that doesn't exist.
func TestResolveVFSPathUnknownEnv(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv(kbotctx.EnvVar, "nope")

	_, _, err := resolveVFSPath("")
	if err == nil {
		t.Fatalf("expected error for unknown KBOT_CONTEXT")
	}
	if !strings.Contains(err.Error(), kbotctx.EnvVar) {
		t.Fatalf("error %q should mention %s", err, kbotctx.EnvVar)
	}
}
