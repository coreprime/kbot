package studio

import (
	"path/filepath"
	"testing"
)

// scanInstall builds a TA game directory whose definitions collide the way
// retail data (and mods) do: CarScar05 in cars2.tdf then cars.tdf within
// rev31.gp3, weapon ARMGUN (IDs 10 and 11) and unit ARMFOO in both
// rev31.gp3 and a later .ccx, plus a weapon and a unit in subdirectories,
// which the game does not load. A weapon name resolves to the lowest slot
// holding it, so ARMGUN is the rev31.gp3 definition.
func scanInstall(t *testing.T) *Session {
	t.Helper()
	dir := t.TempDir()
	writeTestArchive(t, filepath.Join(dir, "rev31.gp3"), false,
		[2]string{"features/urban/cars2.tdf", "[CarScar05]\n{\nfilename=cars2;\nseqname=carscar05;\n}\n"},
		[2]string{"features/urban/cars.tdf", "[CarScar05]\n{\nfilename=cars;\nseqname=carscar05;\n}\n"},
		[2]string{"weapons/arm.tdf", "[ARMGUN]\n{\nID=10;\nreloadtime=1;\nrange=100;\n}\n"},
		[2]string{"units/armfoo.fbi", "[UNITINFO]\n{\nUnitName=ARMFOO;\nName=Rev Foo;\nObjectname=armfoo;\n}\n"},
	)
	writeTestArchive(t, filepath.Join(dir, "btdata.ccx"), false,
		[2]string{"weapons/arm2.tdf", "[ARMGUN]\n{\nID=11;\nreloadtime=9;\nrange=900;\n}\n"},
		[2]string{"weapons/sub/deep.tdf", "[DEEPGUN]\n{\nID=12;\nreloadtime=2;\n}\n"},
		[2]string{"units/armfoo2.fbi", "[UNITINFO]\n{\nUnitName=ARMFOO;\nName=Ccx Foo;\nObjectname=armfoo;\n}\n"},
		[2]string{"units/extra/deepunit.fbi", "[UNITINFO]\n{\nUnitName=DEEPUNIT;\nObjectname=deepunit;\n}\n"},
	)
	return openTASession(t, dir)
}

func TestFeatureScanKeepsTheGamesDefinition(t *testing.T) {
	sess := scanInstall(t)
	_, byName := sess.scanFeatures()
	if got := byName["carscar05"].Filename; got != "cars2" {
		t.Errorf("CarScar05 filename = %q, want cars2 (first definition in game order)", got)
	}
	catalog, _ := sess.buildPackFeatureCatalog()
	if _, ok := catalog["carscar05"]; !ok {
		t.Fatalf("pack feature catalogue lacks carscar05")
	}
}

func TestWeaponScansAreTopLevelAndFirstDefinition(t *testing.T) {
	sess := scanInstall(t)
	w := sess.loadWeaponSection("armgun")
	if w == nil || w.Range != 100 {
		t.Errorf("ARMGUN = %+v, want the rev31.gp3 definition (range 100)", w)
	}
	if sess.loadWeaponSection("deepgun") != nil {
		t.Errorf("weapons/sub/deep.tdf is below weapons/ and the game never loads it")
	}
	list := sess.buildWeaponsList()
	if len(list) != 1 || list[0].Name != "ARMGUN" || list[0].RangeWU != 100 {
		t.Errorf("weapons list = %+v", list)
	}
	cat := sess.buildPackWeaponCatalog()
	if _, ok := cat["deepgun"]; ok || len(cat) != 1 {
		t.Errorf("pack weapon catalogue = %v", cat)
	}
}

func TestUnitIndexIsTopLevelAndFirstDefinition(t *testing.T) {
	sess := scanInstall(t)
	_, byID := sess.ensureModelIndex()
	if got := byID["armfoo"].UnitTitle; got != "Rev Foo" {
		t.Errorf("ARMFOO title = %q, want the rev31.gp3 definition", got)
	}
	if e, ok := byID["deepunit"]; ok && e.HasFBI {
		t.Errorf("units/extra/deepunit.fbi is below units/ and the game never loads it")
	}
}
