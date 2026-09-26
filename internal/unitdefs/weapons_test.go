package unitdefs

import (
	"reflect"
	"strings"
	"testing"
)

func TestBuildWeaponTableSlotsByID(t *testing.T) {
	a := WeaponFile{Path: "weapons/a.tdf", Data: []byte(`
[LASER] { ID=5; range=300; reloadtime=0.35; }
[CANNON] { ID=7; range=600; }
[NOID] { range=100; }
[BIGID] { ID=300; }
[NEGID] { ID=-1; }
`)}
	b := WeaponFile{Path: "weapons/b.tdf", Data: []byte(`
[CANNON2] { ID=7; range=650; }
[LASER] { ID=9; range=999; }
`)}
	tab := BuildWeaponTable([]WeaponFile{a, b})

	if w := tab.ByID(5); w == nil || w.Key != "LASER" {
		t.Fatalf("slot 5 = %v, want LASER", w)
	}
	// A later file's section with the same ID replaces the earlier one.
	if w := tab.ByID(7); w == nil || w.Key != "CANNON2" {
		t.Fatalf("slot 7 = %v, want CANNON2 (later file wins)", w)
	}
	// Names resolve to the lowest slot holding them, ignoring case.
	w, slot := tab.Find(" laser ")
	if w == nil || slot != 5 || w.Range != 300 {
		t.Fatalf("Find(laser) = %v slot %d, want the slot-5 LASER", w, slot)
	}
	// CANNON lost its slot to CANNON2, so the name no longer resolves.
	if w, slot := tab.Find("CANNON"); w != nil || slot != -1 {
		t.Fatalf("Find(CANNON) = %v slot %d, want none (replaced)", w, slot)
	}
	for _, name := range []string{"NOID", "BIGID", "NEGID", ""} {
		if w, _ := tab.Find(name); w != nil {
			t.Fatalf("Find(%q) = %v, want none (the game skips the section)", name, w)
		}
	}
	joined := strings.Join(tab.Warnings, "\n")
	for _, want := range []string{"NOID", "no ID key", "BIGID", "ID 300 is outside 0..255", "NEGID", "CANNON2", "replaces [CANNON]"} {
		if !strings.Contains(joined, want) {
			t.Errorf("warnings lack %q:\n%s", want, joined)
		}
	}

	var named []string
	for _, w := range tab.Named() {
		named = append(named, w.Key)
	}
	if want := []string{"LASER", "CANNON2"}; !reflect.DeepEqual(named, want) {
		t.Fatalf("Named() = %v, want %v (one per name, slot order)", named, want)
	}
}

func TestBuildWeaponTableRepeatedPathWarnsOnce(t *testing.T) {
	f := WeaponFile{Path: "weapons/a.tdf", Data: []byte(`[X] { ID=1; } [Y] { }`)}
	tab := BuildWeaponTable([]WeaponFile{f, f})
	if w, slot := tab.Find("X"); w == nil || slot != 1 {
		t.Fatalf("Find(X) = %v slot %d", w, slot)
	}
	if len(tab.Warnings) != 1 {
		t.Fatalf("warnings = %q, want only the missing ID once", tab.Warnings)
	}
}

func TestDecodeWeaponFileBadValuesKeepOtherWeapons(t *testing.T) {
	data := []byte(`
[FIRST] { ID=1; weaponacceleration=13O; [DAMAGE] { default=13O; armcom=50; } }
[SECOND] { ID=2; range=200; }
`)
	weapons, warns := DecodeWeaponFile(data)
	if len(warns) != 0 || len(weapons) != 2 {
		t.Fatalf("got %d weapons, warnings %q; want both weapons, no warning", len(weapons), warns)
	}
	if weapons[0].WeaponAcceleration != 13 || weapons[0].Damage["default"] != 13 {
		t.Fatalf("FIRST read as %v / %v, want the number prefix 13", weapons[0].WeaponAcceleration, weapons[0].Damage)
	}
}

func TestDecodeWeaponFileStopsAtUnclosedHeader(t *testing.T) {
	// A header with no ']' anywhere after it: the game cannot read past it.
	// (A later ']' would close it, the name swallowing the text between.)
	data := []byte("[KEEP] { ID=1; }\n[BROKEN { ID=2; }\n")
	weapons, warns := DecodeWeaponFile(data)
	if len(weapons) != 1 || weapons[0].Key != "KEEP" {
		t.Fatalf("weapons = %v, want only KEEP", weapons)
	}
	if len(warns) != 1 || !strings.Contains(warns[0], "skipped") {
		t.Fatalf("warnings = %q, want one saying where the read stopped", warns)
	}
	tab := BuildWeaponTable([]WeaponFile{{Path: "weapons/x.tdf", Data: data}, {Path: "weapons/y.tdf", Data: []byte("[OTHER] { ID=4; }")}})
	if w, _ := tab.Find("OTHER"); w == nil {
		t.Fatalf("a problem in one file dropped another file's weapons")
	}
	if len(tab.Warnings) == 0 || !strings.HasPrefix(tab.Warnings[0], "weapons/x.tdf: ") {
		t.Fatalf("warnings = %q, want the file named", tab.Warnings)
	}
}

func TestResolvedWeaponDefaults(t *testing.T) {
	tab := BuildWeaponTable([]WeaponFile{{Path: "weapons/a.tdf", Data: []byte(`
[BLAST] { ID=1; areaofeffect=64; }
[ZERO] { ID=2; range=0; minbarrelangle=0; }
[SET] { ID=3; range=450; minbarrelangle=-5; }
`)}})
	for _, tc := range []struct {
		name      string
		rng       int
		minBarrel float64
	}{
		{"BLAST", 32767, -11.25},
		{"ZERO", 0, 0},
		{"SET", 450, -5},
	} {
		w, ok := tab.Resolve(tc.name)
		if !ok || w.Range != tc.rng || w.MinBarrelAngle != tc.minBarrel {
			t.Errorf("Resolve(%s) = range %d, minbarrelangle %v (ok=%v); want %d, %v",
				tc.name, w.Range, w.MinBarrelAngle, ok, tc.rng, tc.minBarrel)
		}
	}
	if _, ok := tab.Resolve("NONE"); ok {
		t.Fatalf("Resolve(NONE) found a weapon")
	}
}

func TestDamageTable(t *testing.T) {
	tab := BuildWeaponTable([]WeaponFile{{Path: "weapons/a.tdf", Data: []byte(
		`[CORPYRO_BLAST] { ID=212; [DAMAGE] { default=60; CorPyro=15; big=70000; } }`)}})
	w, _ := tab.Find("CORPYRO_BLAST")
	got := DamageTable(w)
	want := map[string]int{"corpyro": 15, "big": int(int16(70000 & 0xffff))}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("DamageTable = %v, want %v", got, want)
	}
}

func TestReloadTicks(t *testing.T) {
	for sec, want := range map[float64]int{0.35: 10, 3.6: 108, 1: 30, 0.01: 0, 0: 0, 0.39: 11} {
		if got := ReloadTicks(sec); got != want {
			t.Errorf("ReloadTicks(%v) = %d, want %d", sec, got, want)
		}
	}
}

func TestSortLooseNames(t *testing.T) {
	names := []string{"b.tdf", "A_x.tdf", "a.TDF", "Z.tdf", "_c.tdf"}
	SortLooseNames(names)
	// Upper-cased: A.TDF < A_X.TDF < B.TDF < Z.TDF < _C.TDF ('_' sorts after 'Z').
	if want := []string{"a.TDF", "A_x.tdf", "b.tdf", "Z.tdf", "_c.tdf"}; !reflect.DeepEqual(names, want) {
		t.Fatalf("SortLooseNames = %v, want %v", names, want)
	}
}
