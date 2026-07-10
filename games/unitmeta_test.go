package games

import (
	"testing"

	"github.com/coreprime/kbot/formats/gamedata/ta"
)

// TestMetaDerivesResourceSiteFlags pins the FBI-driven placement flags the
// build-legality check reads: extractsmetal>0 makes a unit a metal extractor,
// a yardmap laid in 'G' cells makes it a geothermal plant, and a plain building
// carries neither.
func TestMetaDerivesResourceSiteFlags(t *testing.T) {
	noWeapon := func(string) (ta.Weapon, bool) { return ta.Weapon{}, false }

	mex := &ta.UnitInfo{}
	mex.FootprintX, mex.FootprintZ = 3, 3
	mex.YardMap = "ooooooooo"
	mex.ExtractsMetal = 0.001
	mm := MetaFromUnitInfo("armmex", mex, noWeapon)
	if mm.Econ.ExtractsMetal <= 0 {
		t.Fatalf("extractor should carry a positive ExtractsMetal, got %v", mm.Econ.ExtractsMetal)
	}
	if mm.Geothermal {
		t.Fatalf("a metal extractor is not a geothermal plant")
	}

	geo := &ta.UnitInfo{}
	geo.FootprintX, geo.FootprintZ = 4, 4
	geo.YardMap = "GGGGGGGGGGGGGGGG"
	gm := MetaFromUnitInfo("armgeo", geo, noWeapon)
	if !gm.Geothermal {
		t.Fatalf("a plant with an all-'G' yardmap should be flagged geothermal")
	}
	if gm.Econ.ExtractsMetal > 0 {
		t.Fatalf("a geothermal plant declares no extractsmetal")
	}

	plain := &ta.UnitInfo{}
	plain.FootprintX, plain.FootprintZ = 2, 2
	plain.YardMap = "oooo"
	pm := MetaFromUnitInfo("armsolar", plain, noWeapon)
	if pm.Geothermal || pm.Econ.ExtractsMetal > 0 {
		t.Fatalf("an ordinary building carries no resource-site flag")
	}
}
