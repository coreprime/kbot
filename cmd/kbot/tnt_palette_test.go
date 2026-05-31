package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/coreprime/kbot/internal/assets"
)

// TestTAKKingdomPalettesLoad confirms every embedded TA: Kingdoms palette is a
// well-formed 256-colour palette and resolves through the helper.
func TestTAKKingdomPalettesLoad(t *testing.T) {
	for _, k := range []string{"aramon", "taros", "veruna", "zhon", "creon"} {
		raw, ok := assets.TAKPalettes[k]
		if !ok {
			t.Errorf("missing embedded palette for kingdom %q", k)
			continue
		}
		if len(raw) != 1024 {
			t.Errorf("%s palette is %d bytes, want 1024", k, len(raw))
		}
		pal, err := takKingdomPalette(k)
		if err != nil {
			t.Errorf("takKingdomPalette(%q): %v", k, err)
			continue
		}
		if len(pal) != 256 {
			t.Errorf("%s palette has %d colours, want 256", k, len(pal))
		}
	}
}

// TestTAKKingdomPaletteRejectsUnknown guards the error path for a bad name.
func TestTAKKingdomPaletteRejectsUnknown(t *testing.T) {
	if _, err := takKingdomPalette("gondor"); err == nil {
		t.Error("expected error for unknown kingdom, got nil")
	}
	// Case and surrounding whitespace must not matter.
	if _, err := takKingdomPalette("  Veruna "); err != nil {
		t.Errorf("expected case/space-insensitive match, got %v", err)
	}
}

// TestTAKKingdomForTNT checks the sibling-.ota kingdom lookup, including the
// empty-string fallback when no .ota is present.
func TestTAKKingdomForTNT(t *testing.T) {
	dir := t.TempDir()
	tntPath := filepath.Join(dir, "demo.tnt")
	if err := os.WriteFile(tntPath, []byte("stub"), 0o644); err != nil {
		t.Fatal(err)
	}

	// No sibling .ota yet -> empty string.
	if got := takKingdomForTNT(tntPath); got != "" {
		t.Errorf("kingdom without .ota = %q, want empty", got)
	}

	ota := "[GlobalHeader]\n{\n    kingdom=Taros;\n}\n"
	if err := os.WriteFile(filepath.Join(dir, "demo.ota"), []byte(ota), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := takKingdomForTNT(tntPath); got != "taros" {
		t.Errorf("kingdom from .ota = %q, want \"taros\"", got)
	}
}
