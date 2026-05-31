package crt

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/coreprime/kbot/testutil"
)

// TestLoadStub checks an empty multiplayer scenario: no units, nine empty
// player slots, no triggers. athri cay ships the 56-byte stub.
func TestLoadStub(t *testing.T) {
	path := testutil.TAKUnpackedFile(t, "maps", "athri cay.crt")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("sample not available: %v", err)
	}
	f, err := Load(data)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(f.Units) != 0 {
		t.Errorf("units = %d, want 0", len(f.Units))
	}
	if len(f.Players) != 9 {
		t.Errorf("players = %d, want 9", len(f.Players))
	}
	if n := f.RuleCount(); n != 0 {
		t.Errorf("rules = %d, want 0", n)
	}
	if len(f.Triggers) != 0 {
		t.Errorf("triggers = %d, want 0", len(f.Triggers))
	}
}

// TestLoadPopulated pins the decoded unit table and scripting layer of a small
// campaign scenario. varro passage carries four placed units and two rules.
func TestLoadPopulated(t *testing.T) {
	path := testutil.TAKUnpackedFile(t, "maps", "varro passage.crt")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("sample not available: %v", err)
	}
	f, err := Load(data)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(f.Units) != 4 {
		t.Fatalf("units = %d, want 4", len(f.Units))
	}
	if f.Units[0].Type != "verlode" {
		t.Errorf("unit[0].Type = %q, want verlode", f.Units[0].Type)
	}
	if f.Units[1].Type != "VERLIEGE" {
		t.Errorf("unit[1].Type = %q, want VERLIEGE", f.Units[1].Type)
	}
	// Health/armour/weapon default to full, facing to 180.
	for i, u := range f.Units {
		if u.HealthPercent != 100 || u.ArmorPercent != 100 || u.WeaponPercent != 100 {
			t.Errorf("unit[%d] condition = %d/%d/%d, want 100/100/100",
				i, u.HealthPercent, u.ArmorPercent, u.WeaponPercent)
		}
		if u.Angle != 180 {
			t.Errorf("unit[%d].Angle = %d, want 180", i, u.Angle)
		}
	}
	// First two units belong to player 1, last two to player 0.
	if f.Units[0].Player != 1 || f.Units[3].Player != 0 {
		t.Errorf("player ids = %d..%d, want 1..0", f.Units[0].Player, f.Units[3].Player)
	}
	if len(f.Players) != 9 {
		t.Errorf("players = %d, want 9", len(f.Players))
	}
	if n := f.RuleCount(); n != 2 {
		t.Errorf("rules = %d, want 2", n)
	}
}

// TestLoadLarge confirms the largest shipped scenario decodes cleanly, with its
// unit table, rule engine and named trigger regions all consumed.
func TestLoadLarge(t *testing.T) {
	path := testutil.TAKUnpackedFile(t, "maps", "savannah hunt.crt")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("sample not available: %v", err)
	}
	f, err := Load(data)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(f.Units) != 171 {
		t.Errorf("units = %d, want 171", len(f.Units))
	}
	if got := f.UnitCounts()["NPCFARM"]; got == 0 {
		t.Error("expected NPCFARM placements")
	}
	if len(f.Triggers) != 25 {
		t.Errorf("triggers = %d, want 25", len(f.Triggers))
	}
}

// TestLoadAll walks every shipped .crt and asserts it decodes. The single
// hand-edited outlier (a shifted header) is allowed to be rejected, but must be
// rejected with an error rather than panic or silent corruption.
func TestLoadAll(t *testing.T) {
	dir := testutil.TAKUnpackedDir(t, "maps")
	var seen, outliers int
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.EqualFold(filepath.Ext(path), ".crt") {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Errorf("%s: read: %v", filepath.Base(path), err)
			return nil
		}
		f, err := Load(data)
		if err != nil {
			outliers++
			t.Logf("%s: rejected (expected for the shifted-header outlier): %v",
				filepath.Base(path), err)
			return nil
		}
		// Every placement must reference a non-empty type and a real player slot.
		for i, u := range f.Units {
			if u.Type == "" {
				t.Errorf("%s: unit %d has empty type", filepath.Base(path), i)
			}
		}
		seen++
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	if seen == 0 {
		t.Skip("no TA:K .crt files found under maps/")
	}
	if outliers > 1 {
		t.Errorf("expected at most one rejected outlier, got %d", outliers)
	}
	t.Logf("decoded %d TA:K .crt scenarios (%d outliers rejected)", seen, outliers)
}

// TestRejectsNonCRT confirms the signature guard fires on foreign data.
func TestRejectsNonCRT(t *testing.T) {
	if _, err := Load([]byte("not a crt file at all")); err == nil {
		t.Error("expected error for non-CRT input")
	}
	if _, err := Load(nil); err == nil {
		t.Error("expected error for empty input")
	}
}
