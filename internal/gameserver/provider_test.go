package gameserver

import (
	"os"
	"path/filepath"
	"testing"
)

// TestFBIProviderGameRules: the native host's units follow the game's rules —
// movement class with the game's defaults, resolved standing orders, weapons
// from the ID table with whole-tick reloads.
func TestFBIProviderGameRules(t *testing.T) {
	root := os.Getenv("TA_UNPACKED_PATH")
	if root == "" {
		t.Skip("TA_UNPACKED_PATH not set")
	}
	spawn := FBISpawnFunc(root)

	com, _ := spawn("armcom")
	if com == nil {
		t.Fatal("armcom did not resolve")
	}
	if com.StandMove != 0 || com.StandFire != 2 {
		t.Errorf("armcom orders %d/%d, want Hold Position (0) / Fire at Will (2)", com.StandMove, com.StandFire)
	}
	if com.MaxWaterDepth != 100 || com.MinWaterDepth != -10000 || com.MaxSlope != 32 || com.FootprintX != 2 {
		t.Errorf("armcom limits depth %d..%d slope %d footprint %d, want TANKDS2's -10000..100, 32, 2",
			com.MinWaterDepth, com.MaxWaterDepth, com.MaxSlope, com.FootprintX)
	}
	if !com.Weapons[0].Present || com.Weapons[0].ReloadTicks <= 0 {
		t.Errorf("armcom weapon1 unresolved: %+v", com.Weapons[0])
	}

	ch, _ := spawn("armch")
	if ch == nil || ch.MaxWaterDepth != 10000 || ch.FootprintX != 3 || ch.StandMove != 1 || ch.StandFire != 2 {
		t.Fatalf("armch = depth %d footprint %d orders %d/%d, want 10000, 3, 1/2",
			ch.MaxWaterDepth, ch.FootprintX, ch.StandMove, ch.StandFire)
	}

	vader, _ := spawn("armvader")
	if vader == nil || vader.StandFire != 0 {
		t.Fatalf("armvader should start on Hold Fire")
	}
}

// TestFBIProviderWeaponTableByID: weapons load from the .tdf files directly in
// weapons/, by ID, the later file winning a shared ID and a section without an
// ID skipped; names resolve to the lowest slot.
func TestFBIProviderWeaponTableByID(t *testing.T) {
	root := t.TempDir()
	write := func(rel, text string) {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("weapons/a.tdf", `[GUN] { ID=3; range=100; reloadtime=1; } [NOID] { range=5; }`)
	write("weapons/B.tdf", `[GUN] { ID=9; range=900; } [GUN2] { ID=3; range=300; reloadtime=0.35; }`)
	write("weapons/sub/c.tdf", `[SUBGUN] { ID=20; range=50; }`)
	write("gamedata/weapons.tdf", `[DOCGUN] { ID=21; range=60; }`)
	write("units/tank.fbi", `[UNITINFO] { UnitName=TANK; MaxVelocity=1; FootprintX=2; FootprintZ=2;
		Weapon1=GUN2; Weapon2=GUN; Weapon3=NOID; }`)

	p := newFBIProvider(root)
	p.mu.Lock()
	defer p.mu.Unlock()
	for name, want := range map[string]bool{"GUN2": true, "GUN": true, "NOID": false, "SUBGUN": false, "DOCGUN": false} {
		if _, ok := p.resolveWeapon(name); ok != want {
			t.Errorf("resolveWeapon(%s) found=%v, want %v", name, ok, want)
		}
	}
	// a.tdf's GUN (ID 3) is replaced by B.tdf's GUN2; B.tdf's GUN sits in 9.
	if w, _ := p.resolveWeapon("GUN"); w.Range != 900 {
		t.Errorf("GUN range %d, want 900 (slot 9)", w.Range)
	}
	m := p.loadUnit("tank")
	if m == nil || !m.Weapons[0].Present || m.Weapons[0].ReloadTicks != 10 {
		t.Fatalf("tank weapon1 = %+v, want GUN2 reloading after 10 ticks", m)
	}
	if m.Weapons[2].Present {
		t.Errorf("a weapon the game skips (no ID) armed the unit")
	}
	// A unit without a movement class or depth keys takes the game's defaults.
	if m.MaxWaterDepth != 10000 || m.MinWaterDepth != -10000 || m.MaxSlope != 255 || m.StandMove != 2 {
		t.Errorf("tank limits %d..%d slope %d move %d, want -10000..10000, 255, 2",
			m.MinWaterDepth, m.MaxWaterDepth, m.MaxSlope, m.StandMove)
	}
}
