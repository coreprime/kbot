package mcp

import (
	"testing"

	"github.com/coreprime/kbot/internal/kbotctx"
)

// TestContextsFromConfig converts an in-memory kbot config into MCP
// ContextSpecs and asserts the active alias is marked Current while
// the remaining aliases are emitted in alphabetical order so the
// server reports a stable listing across runs.
func TestContextsFromConfig(t *testing.T) {
	cfg := &kbotctx.Config{
		Current: "ta-gog",
		Contexts: map[string]kbotctx.Context{
			"ta-gog":   {Path: "/games/ta", Game: kbotctx.GameTotalA, Version: "3.1c"},
			"kingdoms": {Path: "/games/tak", Game: kbotctx.GameTAKingdoms},
			"sandbox":  {Path: "/games/sandbox", Game: kbotctx.GameCustom},
		},
	}

	specs := contextsFromConfig(cfg, "ta-gog")
	if len(specs) != 3 {
		t.Fatalf("len = %d, want 3", len(specs))
	}

	// Slice order is alphabetical; only the Current flag identifies the
	// active alias.  The MCP layer reorders Current to the front.
	wantOrder := []string{"kingdoms", "sandbox", "ta-gog"}
	for i, s := range specs {
		if s.Alias != wantOrder[i] {
			t.Errorf("specs[%d].Alias = %q, want %q", i, s.Alias, wantOrder[i])
		}
	}

	var current int
	for _, s := range specs {
		if s.Current {
			current++
			if s.Alias != "ta-gog" {
				t.Errorf("Current set on %q, want ta-gog", s.Alias)
			}
		}
	}
	if current != 1 {
		t.Errorf("expected exactly 1 Current, got %d", current)
	}

	for _, s := range specs {
		if s.Alias == "ta-gog" && (s.Game != "totala" || s.Version != "3.1c") {
			t.Errorf("metadata not copied: %+v", s)
		}
	}
}

func TestContextsFromConfig_Empty(t *testing.T) {
	if got := contextsFromConfig(nil, ""); got != nil {
		t.Fatalf("nil cfg should produce nil, got %+v", got)
	}
	cfg := &kbotctx.Config{Contexts: map[string]kbotctx.Context{}}
	if got := contextsFromConfig(cfg, ""); got != nil {
		t.Fatalf("empty cfg should produce nil, got %+v", got)
	}
}

func TestContextsFromConfig_EnvOverridesCurrent(t *testing.T) {
	cfg := &kbotctx.Config{
		Current: "a",
		Contexts: map[string]kbotctx.Context{
			"a": {Path: "/x", Game: kbotctx.GameTotalA},
			"b": {Path: "/y", Game: kbotctx.GameTotalA},
		},
	}
	specs := contextsFromConfig(cfg, "b")
	var currentAlias string
	for _, s := range specs {
		if s.Current {
			currentAlias = s.Alias
		}
	}
	if currentAlias != "b" {
		t.Fatalf("active should follow env-resolved alias, got %q", currentAlias)
	}
}
