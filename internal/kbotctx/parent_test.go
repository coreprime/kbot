package kbotctx

import (
	"strings"
	"testing"
)

// addCtx is a test helper that registers a context with the given game/parent.
func addCtx(t *testing.T, cfg *Config, alias, game, parent string) {
	t.Helper()
	if err := cfg.Add(alias, Context{Path: t.TempDir(), Game: game, Parent: parent}, false); err != nil {
		t.Fatalf("Add(%s): %v", alias, err)
	}
}

func TestResolveChainOrder(t *testing.T) {
	cfg := tempConfig(t)
	addCtx(t, cfg, "base", GameTotalA, "")
	addCtx(t, cfg, "expansion", GameTotalA, "base")
	addCtx(t, cfg, "mod", GameTotalA, "expansion")

	chain, err := cfg.ResolveChain("mod")
	if err != nil {
		t.Fatalf("ResolveChain: %v", err)
	}
	want := []string{"mod", "expansion", "base"}
	if strings.Join(chain, ">") != strings.Join(want, ">") {
		t.Errorf("chain = %v, want %v", chain, want)
	}
}

func TestAddRejectsMissingParent(t *testing.T) {
	cfg := tempConfig(t)
	err := cfg.Add("mod", Context{Path: t.TempDir(), Game: GameTotalA, Parent: "ghost"}, false)
	if err == nil {
		t.Fatal("expected error adding context with missing parent")
	}
	if _, exists := cfg.Contexts["mod"]; exists {
		t.Error("context should not be registered when its parent is missing")
	}
}

func TestSetParentDetectsCycle(t *testing.T) {
	cfg := tempConfig(t)
	addCtx(t, cfg, "a", GameTotalA, "")
	addCtx(t, cfg, "b", GameTotalA, "a")

	// a -> b would close the loop a -> b -> a.
	if err := cfg.SetParent("a", "b"); err == nil {
		t.Fatal("expected cycle to be rejected")
	}
	// a's parent must be unchanged after the rejected SetParent.
	if cfg.Contexts["a"].Parent != "" {
		t.Errorf("a.Parent = %q, want empty after rejected SetParent", cfg.Contexts["a"].Parent)
	}
}

func TestChainRejectsMixedGames(t *testing.T) {
	cfg := tempConfig(t)
	addCtx(t, cfg, "ta", GameTotalA, "")
	err := cfg.Add("tak-mod", Context{Path: t.TempDir(), Game: GameTAKingdoms, Parent: "ta"}, false)
	if err == nil {
		t.Fatal("expected error layering takingdoms on top of totala")
	}
}

func TestChainAllowsCustom(t *testing.T) {
	cfg := tempConfig(t)
	addCtx(t, cfg, "ta", GameTotalA, "")
	addCtx(t, cfg, "tweak", GameCustom, "ta")
	if _, err := cfg.ResolveChain("tweak"); err != nil {
		t.Errorf("custom on top of totala should be allowed: %v", err)
	}
}

func TestDeleteRejectsParentWithChildren(t *testing.T) {
	cfg := tempConfig(t)
	addCtx(t, cfg, "base", GameTotalA, "")
	addCtx(t, cfg, "mod", GameTotalA, "base")

	if err := cfg.Delete("base"); err == nil {
		t.Fatal("expected error deleting a context that is still a parent")
	}
	if _, exists := cfg.Contexts["base"]; !exists {
		t.Error("base should remain after rejected delete")
	}

	// Clearing the child relationship first allows the delete.
	if err := cfg.SetParent("mod", ""); err != nil {
		t.Fatalf("SetParent clear: %v", err)
	}
	if err := cfg.Delete("base"); err != nil {
		t.Errorf("delete after reparent: %v", err)
	}
}

func TestParentSurvivesSaveReload(t *testing.T) {
	cfg := tempConfig(t)
	addCtx(t, cfg, "base", GameTotalA, "")
	addCtx(t, cfg, "mod", GameTotalA, "base")
	if err := cfg.Save(); err != nil {
		t.Fatalf("Save: %v", err)
	}
	reload, err := loadFrom(cfg.Path())
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if got := reload.Contexts["mod"].Parent; got != "base" {
		t.Errorf("reloaded mod.Parent = %q, want base", got)
	}
}
