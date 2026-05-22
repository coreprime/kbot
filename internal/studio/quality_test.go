package studio

import (
	"testing"

	"github.com/coreprime/kbot/formats/tnt"
)

// TestCheckDuplicateTilesDetectsRepeat seeds a tile pool with two
// byte-identical entries and confirms the dedup check flags them as a
// warning with the compressTiles fix id.
func TestCheckDuplicateTilesDetectsRepeat(t *testing.T) {
	tile := make([]byte, 1024)
	for i := range tile {
		tile[i] = 7
	}
	dup := make([]byte, 1024)
	copy(dup, tile)
	other := make([]byte, 1024)
	for i := range other {
		other[i] = 0x40
	}
	m := &tnt.Map{Tiles: [][]byte{tile, dup, other}}

	issue := checkDuplicateTiles(m, nil)
	if issue.Severity != "warning" {
		t.Fatalf("expected warning severity, got %q (%s)", issue.Severity, issue.Message)
	}
	if !issue.CanAutoFix || issue.Fix != "compressTiles" {
		t.Errorf("expected auto-fix compressTiles, got canAutoFix=%v fix=%q", issue.CanAutoFix, issue.Fix)
	}
}

// TestCheckDuplicateTilesUniqueIsOK confirms a unique-tile pool returns
// the green ok severity.
func TestCheckDuplicateTilesUniqueIsOK(t *testing.T) {
	a := make([]byte, 1024)
	b := make([]byte, 1024)
	for i := range b {
		b[i] = 1
	}
	m := &tnt.Map{Tiles: [][]byte{a, b}}
	issue := checkDuplicateTiles(m, nil)
	if issue.Severity != "ok" {
		t.Fatalf("expected ok severity, got %q (%s)", issue.Severity, issue.Message)
	}
}

// TestCheckDuplicateTilesAfterFixIsOK confirms a re-run after the fix
// has been applied short-circuits to ok regardless of pool contents
// (the build with compressTiles fix can't produce duplicates anyway).
func TestCheckDuplicateTilesAfterFixIsOK(t *testing.T) {
	tile := make([]byte, 1024)
	m := &tnt.Map{Tiles: [][]byte{tile, tile}}
	issue := checkDuplicateTiles(m, []string{"compressTiles"})
	if issue.Severity != "ok" {
		t.Fatalf("expected ok after compressTiles applied, got %q", issue.Severity)
	}
}
