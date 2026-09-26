package documentor

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// writeInstall lays out a small flattened TA install under a temp directory.
func writeInstall(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for name, body := range files {
		p := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func fbi(unitName string, extra string) string {
	return "[UNITINFO]\n{\n\tUnitName=" + unitName + ";\n\tSide=ARM;\n" + extra + "}\n"
}

func testInstall(t *testing.T) string {
	many := ""
	for i := 1; i <= 35; i++ {
		many += "\t\tcanbuild" + strconv.Itoa(i) + "=ARMPW;\n"
	}
	return writeInstall(t, map[string]string{
		"units/armcom.fbi":  fbi("ARMCOM", "\tBuilder=1;\n\tWeapon1=arm_gun;\n\tWeapon2=NOSUCHWEAPON;\n"),
		"units/armlab.fbi":  fbi("ARMLAB", "\tBuilder=1;\n"),
		"units/armpw.fbi":   fbi("ARMPW", "\tWeapon1=OLD_GUN;\n"),
		"units/armflea.fbi": fbi("ARMFLEA", ""),
		// Comments are blanked and a value runs to the next ';'.
		"units/corplas.fbi": "[UNITINFO]\n{\n\tUnitName=CORPLAS;\n\tSide=CORE;\n\tName=Immolator; //c\n" +
			"\tBuildCostMetal=321;  //C  llt=268\n\tBuildCostEnergy=1790;  /* was 2608 */\n\tMaxDamage=842;  //C  llt=710\n}\n",

		"weapons/weapons.tdf": "[Arm_Gun]\n{\n\tID=5;\n\tname=Gun;\n\t[DAMAGE]\n\t{\n\t\tdefault=13O;\n\t}\n}\n" +
			"[OLD_GUN]\n{\n\tID=6;\n\tname=Old;\n\trange=100;\n}\n" +
			"[NOID]\n{\n\tname=No ID;\n}\n" +
			"/*[COMMENTED]\n{\n\tID=9;\n}*/\n",
		"weapons/zz_more.tdf": "[NEW_GUN]\n{\n\tID=6;\n\tname=New;\n}\n",
		// Not a weapon source.
		"gamedata/weapons.tdf": "[GHOST]\n{\n\tID=7;\n\tname=Ghost;\n}\n",

		"gamedata/sidedata.tdf": "[CANBUILD]\n{\n" +
			"\t[ARMCOM]\n\t{\n\t\tcanbuild1=ARMLAB;\n\t\tcanbuild2=NOSUCHUNIT;\n\t\tcanbuild3=ARMPW;\n\t\tcanbuild5=ARMFLEA;\n\t}\n" +
			"\t[ARMLAB]\n\t{\n" + many + "\t}\n" +
			"\t[ARMPW]\n\t{\n\t\tcanbuild1=ARMLAB;\n\t}\n" +
			"}\n",

		"download/a.tdf": "[ENTRY0]\n{\n\tUNITMENU=ARMCOM;\n\tMENU=2;\n\tBUTTON=1;\n\tUNITNAME=ARMFLEA;\n}\n" +
			"[E2]\n{\n\tUNITMENU=NOBODY;\n\tMENU=2;\n\tBUTTON=2;\n\tUNITNAME=ARMFLEA;\n}\n" +
			"[E3]\n{\n\tUNITMENU=ARMCOM;\n\tMENU=2;\n\tBUTTON=3;\n\tUNITNAME=GHOSTUNIT;\n}\n" +
			"[E4]\n{\n\tUNITMENU=ARMPW;\n\tMENU=2;\n\tBUTTON=4;\n\tUNITNAME=ARMFLEA;\n}\n" +
			"[E5]\n{\n\tUNITMENU=ARMLAB;\n\tMENU=7;\n\tBUTTON=0;\n\tUNITNAME=ARMFLEA;\n}\n" +
			"[E6]\n{\n\tUNITMENU=ARMCOM;\n\tMENU=3;\n\tBUTTON=0;\n\tUNITNAME=CORPLAS;\n}\n",
	})
}

func TestExtractReadsUnitsWithTheGameGrammar(t *testing.T) {
	ds, err := Extract(testInstall(t), GameTotalA)
	if err != nil {
		t.Fatal(err)
	}
	u := ds.UnitByKey["CORPLAS"]
	if u.Name != "Immolator" || u.BuildMetal != "321" || u.BuildEnergy != "1790" || u.MaxDamage != "842" {
		t.Errorf("CORPLAS = name %q, cost %q / %q, hp %q; want Immolator, 321 / 1790, 842",
			u.Name, u.BuildMetal, u.BuildEnergy, u.MaxDamage)
	}
	if !ds.UnitByKey["ARMCOM"].Builder || ds.UnitByKey["ARMPW"].Builder {
		t.Error("Builder flag not read")
	}
}

func TestExtractWeaponsFollowTheGameTable(t *testing.T) {
	ds, err := Extract(testInstall(t), GameTotalA)
	if err != nil {
		t.Fatal(err)
	}
	byKey := map[string]Weapon{}
	for _, w := range ds.Weapons {
		byKey[strings.ToUpper(w.NameKey)] = w
	}
	for _, gone := range []string{"GHOST", "OLD_GUN", "NOID", "COMMENTED"} {
		if _, ok := byKey[gone]; ok {
			t.Errorf("weapon %s is listed; the game does not load it", gone)
		}
	}
	gun := byKey["ARM_GUN"]
	if gun.ID != "5" || gun.DefaultDamage != "13" || gun.Range != "32767" {
		t.Errorf("ARM_GUN = id %q damage %q range %q; want 5, 13 (13O read as a prefix), 32767 (no range key)",
			gun.ID, gun.DefaultDamage, gun.Range)
	}
	if byKey["NEW_GUN"].ID != "6" {
		t.Errorf("NEW_GUN = %+v, want slot 6 (it replaces OLD_GUN)", byKey["NEW_GUN"])
	}
	if ds.WeaponRefs["ARM_GUN"] != "ARM_GUN" {
		t.Errorf("ARMCOM's arm_gun resolves to %q", ds.WeaponRefs["ARM_GUN"])
	}
	for _, unresolved := range []string{"NOSUCHWEAPON", "OLD_GUN"} {
		if _, ok := ds.WeaponRefs[unresolved]; ok {
			t.Errorf("%s resolved; no loaded weapon has that name", unresolved)
		}
	}
	notes := strings.Join(ds.WeaponNotes, "\n")
	if !strings.Contains(notes, "NOID") || !strings.Contains(notes, "OLD_GUN") {
		t.Errorf("weapon notes lack the skipped and replaced sections:\n%s", notes)
	}
}

func TestExtractBuildListsFollowTheGameRules(t *testing.T) {
	ds, err := Extract(testInstall(t), GameTotalA)
	if err != nil {
		t.Fatal(err)
	}
	// NOSUCHUNIT is skipped and the list stops at the gap before canbuild5.
	if got := strings.Join(ds.Build.CanBuild["ARMCOM"], ","); got != "ARMLAB,ARMPW" {
		t.Errorf("ARMCOM CANBUILD = %s, want ARMLAB,ARMPW", got)
	}
	if n := len(ds.Build.CanBuild["ARMLAB"]); n != 30 {
		t.Errorf("ARMLAB CANBUILD has %d entries, want the game's 30", n)
	}
	if _, ok := ds.Build.CanBuild["ARMPW"]; ok {
		t.Error("ARMPW has no Builder=1 but got a build list")
	}

	var entries []string
	for _, e := range ds.Build.MenuEntries {
		entries = append(entries, e.Builder+">"+e.Unit)
	}
	// ENTRY0 counts although it is not named MENUENTRY; E2-E4 name no
	// unit, no unit or a non-builder; E5 would be ARMLAB's 31st unit and
	// fits; E6 is the sixth section and is never read.
	if got := strings.Join(entries, " "); got != "ARMCOM>ARMFLEA ARMLAB>ARMFLEA" {
		t.Errorf("download entries = %s, want ARMCOM>ARMFLEA ARMLAB>ARMFLEA", got)
	}
	notes := strings.Join(ds.Build.Notes, "\n")
	for _, want := range []string{"ARMPW has no Builder=1", "NOSUCHUNIT names no unit", "no canbuild4",
		"the game keeps the first 30", "NOBODY", "GHOSTUNIT", "reads only the first 5"} {
		if !strings.Contains(notes, want) {
			t.Errorf("build notes lack %q:\n%s", want, notes)
		}
	}
}

func TestGenerateWritesTheGameView(t *testing.T) {
	target := t.TempDir()
	if err := Generate(Options{Game: GameTotalA, Source: testInstall(t), Target: target, SkipPortraits: true}); err != nil {
		t.Fatal(err)
	}
	read := func(name string) string {
		b, err := os.ReadFile(filepath.Join(target, name))
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	units := read("ta-units.md")
	if strings.Contains(units, "//c") || !strings.Contains(units, "| Immolator |") {
		t.Error("ta-units.md shows comment text in CORPLAS's row")
	}
	weapons := read("ta-weapons.md")
	if strings.Contains(weapons, "GHOST") || !strings.Contains(weapons, "## Sections the game does not load") {
		t.Error("ta-weapons.md lists gamedata/weapons.tdf or lacks the not-loaded section")
	}
	build := read("ta-buildtree.md")
	if !strings.Contains(build, "### Entries the game leaves out") {
		t.Error("ta-buildtree.md lacks the left-out entries")
	}
}
