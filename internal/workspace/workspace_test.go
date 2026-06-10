package workspace

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/coreprime/kbot/filesystem"
	"github.com/coreprime/kbot/internal/kbotctx"
)

func writeDisk(t *testing.T, dir, rel, content string) {
	t.Helper()
	full := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", rel, err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", rel, err)
	}
}

func TestManifestRoundTrip(t *testing.T) {
	dir := t.TempDir()
	base := kbotctx.Context{Path: t.TempDir(), Game: kbotctx.GameTotalA}
	m := New(dir, "My Mod", base, "ta")
	m.Mod = Mod{Title: "My Mod", Author: "me", Version: "0.1.0"}

	if m.Export.Format != ExportHPIv1 {
		t.Errorf("export format = %q, want %q", m.Export.Format, ExportHPIv1)
	}
	if err := m.Save(); err != nil {
		t.Fatalf("Save: %v", err)
	}

	loaded, err := Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if loaded.Name != "My Mod" || loaded.Base != "ta" || loaded.Game != kbotctx.GameTotalA {
		t.Errorf("unexpected manifest: %+v", loaded)
	}
	if loaded.Mod.Author != "me" || loaded.Mod.Version != "0.1.0" {
		t.Errorf("mod metadata lost: %+v", loaded.Mod)
	}
	if loaded.Dir() != dir {
		t.Errorf("Dir() = %q, want %q", loaded.Dir(), dir)
	}
}

func TestExportFormatByGame(t *testing.T) {
	if got := DefaultExportFormat(kbotctx.GameTAKingdoms); got != ExportHPIv2 {
		t.Errorf("takingdoms => %q, want %q", got, ExportHPIv2)
	}
	if got := DefaultExportFormat(kbotctx.GameTotalA); got != ExportHPIv1 {
		t.Errorf("totala => %q, want %q", got, ExportHPIv1)
	}
}

func TestLoadRequiresFields(t *testing.T) {
	dir := t.TempDir()
	// Manifest missing base.
	if err := os.WriteFile(filepath.Join(dir, ManifestName), []byte("name: x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(dir); err == nil {
		t.Error("expected error loading manifest without base")
	}
}

func TestResolveSourcesChainOrder(t *testing.T) {
	cfg := &kbotctx.Config{Contexts: map[string]kbotctx.Context{}}
	baseDir := t.TempDir()
	modDir := t.TempDir()
	if err := cfg.Add("base", kbotctx.Context{Path: baseDir, Game: kbotctx.GameTotalA}, false); err != nil {
		t.Fatal(err)
	}
	if err := cfg.Add("mod", kbotctx.Context{Path: modDir, Game: kbotctx.GameTotalA, Parent: "base"}, false); err != nil {
		t.Fatal(err)
	}

	work := t.TempDir()
	m := New(work, "ws", cfg.Contexts["mod"], "mod")

	sources, err := m.ResolveSources(cfg)
	if err != nil {
		t.Fatalf("ResolveSources: %v", err)
	}
	if len(sources) != 3 {
		t.Fatalf("expected 3 sources, got %d: %+v", len(sources), sources)
	}
	// Top: writable work folder.
	if !sources[0].Writable || sources[0].Path != work || sources[0].Kind != filesystem.SourceLooseDir {
		t.Errorf("top source = %+v, want writable work folder", sources[0])
	}
	// Then mod context, then base context.
	if sources[1].Path != modDir || sources[2].Path != baseDir {
		t.Errorf("chain order wrong: %q then %q, want %q then %q",
			sources[1].Path, sources[2].Path, modDir, baseDir)
	}
}

func TestOpenVFSLayersAcrossChain(t *testing.T) {
	cfg := &kbotctx.Config{Contexts: map[string]kbotctx.Context{}}
	baseDir := t.TempDir()
	modDir := t.TempDir()
	writeDisk(t, baseDir, "units/armcom.fbi", "base-armcom")
	writeDisk(t, baseDir, "units/shared.fbi", "base-shared")
	writeDisk(t, modDir, "units/shared.fbi", "mod-shared") // mod overrides base

	if err := cfg.Add("base", kbotctx.Context{Path: baseDir, Game: kbotctx.GameTotalA}, false); err != nil {
		t.Fatal(err)
	}
	if err := cfg.Add("mod", kbotctx.Context{Path: modDir, Game: kbotctx.GameTotalA, Parent: "base"}, false); err != nil {
		t.Fatal(err)
	}

	work := t.TempDir()
	m := New(work, "ws", cfg.Contexts["mod"], "mod")

	vfs, err := m.OpenVFS(cfg, &filesystem.Config{})
	if err != nil {
		t.Fatalf("OpenVFS: %v", err)
	}
	defer func() { _ = vfs.Close() }()

	// Resolves from base.
	if got, _ := vfs.ReadFile("units/armcom.fbi"); string(got) != "base-armcom" {
		t.Errorf("armcom = %q, want base-armcom", string(got))
	}
	// Mod overrides base.
	if got, _ := vfs.ReadFile("units/shared.fbi"); string(got) != "mod-shared" {
		t.Errorf("shared = %q, want mod-shared", string(got))
	}
	// A workspace edit overrides everything below.
	if err := vfs.WriteFile("units/shared.fbi", []byte("ws-shared")); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if got, _ := vfs.ReadFile("units/shared.fbi"); string(got) != "ws-shared" {
		t.Errorf("after edit = %q, want ws-shared", string(got))
	}
	// The edit lands in the work folder, not the contexts.
	if _, err := os.Stat(filepath.Join(work, "units", "shared.fbi")); err != nil {
		t.Errorf("edit not in work folder: %v", err)
	}
}

func TestRememberWorkspaceIndex(t *testing.T) {
	cfg := &kbotctx.Config{}
	work := t.TempDir()
	m := New(work, "ws", kbotctx.Context{Game: kbotctx.GameTotalA}, "base")
	if err := cfg.RememberWorkspace(m.Ref()); err != nil {
		t.Fatalf("RememberWorkspace: %v", err)
	}
	if len(cfg.Workspaces) != 1 || cfg.Workspaces[0].Name != "ws" {
		t.Fatalf("recents index wrong: %+v", cfg.Workspaces)
	}
	// Re-remembering the same path de-duplicates.
	if err := cfg.RememberWorkspace(m.Ref()); err != nil {
		t.Fatal(err)
	}
	if len(cfg.Workspaces) != 1 {
		t.Errorf("expected dedup, got %d entries", len(cfg.Workspaces))
	}
	cfg.ForgetWorkspace(work)
	if len(cfg.Workspaces) != 0 {
		t.Errorf("expected empty after forget, got %d", len(cfg.Workspaces))
	}
}
