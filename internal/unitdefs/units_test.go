package unitdefs

import (
	"testing"

	"github.com/coreprime/kbot-engine/engine/fixed"
	"github.com/coreprime/kbot-engine/engine/sim"
	"github.com/coreprime/kbot-io/formats/gamedata/ta"
	"github.com/coreprime/kbot-io/formats/tdf"
)

const testMoveInfo = `
[CLASS0] { Name=TANKDS2; FootprintX=2; FootprintZ=2; MaxWaterDepth=100; MaxSlope=32; }
[CLASS1] { Name=TANKHOVER3; FootprintX=3; FootprintZ=3; MaxSlope=12; BadSlope=12; MaxWaterSlope=255; BadWaterSlope=255; }
[CLASS2] { Name=STEEP; FootprintX=2; FootprintZ=2; MaxSlope=80; MaxWaterSlope=40; }
[HOVERXL] { Name=HOVERXL; FootprintX=9; FootprintZ=9; MaxWaterDepth=5; }
[CLASS40] { Name=FAR; FootprintX=7; FootprintZ=7; }
`

func decodeUnit(t *testing.T, fbi string) *ta.UnitInfo {
	t.Helper()
	var u ta.Unit
	if err := tdf.Unmarshal([]byte(fbi), &u); err != nil {
		t.Fatalf("decode FBI: %v", err)
	}
	return &u.Info
}

func moveClasses(t *testing.T) []ta.MovementClass {
	t.Helper()
	classes, err := LoadMoveClasses([]byte(testMoveInfo))
	if err != nil {
		t.Fatalf("LoadMoveClasses: %v", err)
	}
	return classes
}

func TestStandingOrders(t *testing.T) {
	for _, tc := range []struct {
		fbi        string
		move, fire int
	}{
		{`[UNITINFO] { UnitName=A; }`, 2, 2},
		{`[UNITINFO] { UnitName=A; StandingMoveOrder=0; StandingFireOrder=2; }`, 0, 2},
		{`[UNITINFO] { UnitName=A; StandingMoveOrder=1; StandingFireOrder=0; }`, 1, 0},
		{`[UNITINFO] { UnitName=A; StandingMoveOrder=5; StandingFireOrder=7; }`, 1, 3},
	} {
		move, fire := StandingOrders(decodeUnit(t, tc.fbi))
		if move != tc.move || fire != tc.fire {
			t.Errorf("%s: orders %d/%d, want %d/%d", tc.fbi, move, fire, tc.move, tc.fire)
		}
	}
}

func TestApplyToSimMetaMovement(t *testing.T) {
	classes := moveClasses(t)
	for _, tc := range []struct {
		name                 string
		fbi                  string
		fx, fz               int
		maxDepth, minDepth   int
		maxSlope             int
		standMove, standFire uint8
	}{
		{
			// The class replaces the FBI's own keys: the commander climbs
			// TANKDS2's 32, not its own 20, and wades to 100.
			name: "commander",
			fbi: `[UNITINFO] { UnitName=ARMCOM; FootprintX=2; FootprintZ=2; MaxWaterDepth=35; MaxSlope=20;
				MovementClass=TANKDS2; StandingMoveOrder=0; StandingFireOrder=2; YardMap=oooo; }`,
			fx: 2, fz: 2, maxDepth: 100, minDepth: -10000, maxSlope: 32, standMove: 0, standFire: 2,
		},
		{
			// A hovercraft class has no MaxWaterDepth: the game's 10000, not the
			// FBI's MaxWaterDepth=0.
			name: "hovercraft",
			fbi: `[UNITINFO] { UnitName=ARMCH; FootprintX=2; FootprintZ=2; MaxWaterDepth=0;
				MovementClass=tankhover3; StandingMoveOrder=1; }`,
			fx: 3, fz: 3, maxDepth: 10000, minDepth: -10000, maxSlope: 12, standMove: 1, standFire: 2,
		},
		{
			// Max slope is capped by the max water slope.
			name: "steep", fbi: `[UNITINFO] { UnitName=S; MovementClass=STEEP; }`,
			fx: 2, fz: 2, maxDepth: 10000, minDepth: -10000, maxSlope: 40, standMove: 2, standFire: 2,
		},
		{
			// Only [CLASS0]..[CLASS31] are classes: HOVERXL and CLASS40 are never
			// found, so the unit reads its own keys with the game's defaults.
			name: "unreachable class", fbi: `[UNITINFO] { UnitName=H; MovementClass=HOVERXL; FootprintX=4; FootprintZ=4; }`,
			fx: 4, fz: 4, maxDepth: 10000, minDepth: -10000, maxSlope: 255, standMove: 2, standFire: 2,
		},
		{
			name: "past slot 31", fbi: `[UNITINFO] { UnitName=F; MovementClass=FAR; FootprintX=1; FootprintZ=1; }`,
			fx: 1, fz: 1, maxDepth: 10000, minDepth: -10000, maxSlope: 255, standMove: 2, standFire: 2,
		},
		{
			// No class: an explicit 0 stays 0 (the Solar Collector stays on land).
			name: "solar", fbi: `[UNITINFO] { UnitName=ARMSOLAR; FootprintX=5; FootprintZ=5; MaxWaterDepth=0; MaxSlope=10; }`,
			fx: 5, fz: 5, maxDepth: 0, minDepth: -10000, maxSlope: 10, standMove: 2, standFire: 2,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			info := decodeUnit(t, tc.fbi)
			m := &sim.UnitMeta{Name: "u", FootprintX: 99, FootprintZ: 99, MaxWaterDepth: 1, MaxSlope: 1,
				CombatBoxSet: true, Wreck: &sim.FeatureMeta{Name: "u_dead", FootprintX: 99, FootprintZ: 99}}
			ApplyToSimMeta(m, info, classes, nil)
			if m.FootprintX != tc.fx || m.FootprintZ != tc.fz {
				t.Errorf("footprint %dx%d, want %dx%d", m.FootprintX, m.FootprintZ, tc.fx, tc.fz)
			}
			if m.MaxWaterDepth != tc.maxDepth || m.MinWaterDepth != tc.minDepth || m.MaxSlope != tc.maxSlope {
				t.Errorf("depth %d..%d slope %d, want %d..%d slope %d",
					m.MinWaterDepth, m.MaxWaterDepth, m.MaxSlope, tc.minDepth, tc.maxDepth, tc.maxSlope)
			}
			if m.StandMove != tc.standMove || m.StandFire != tc.standFire {
				t.Errorf("standing orders %d/%d, want %d/%d", m.StandMove, m.StandFire, tc.standMove, tc.standFire)
			}
			if m.CombatBoxHalfX != fixed.FromInt(tc.fx*4) || m.CombatBoxHalfZ != fixed.FromInt(tc.fz*4) {
				t.Errorf("splash box follows the FBI footprint, want the resolved one")
			}
			if m.Wreck.FootprintX != tc.fx || m.Wreck.FootprintZ != tc.fz {
				t.Errorf("default wreck footprint %dx%d, want %dx%d", m.Wreck.FootprintX, m.Wreck.FootprintZ, tc.fx, tc.fz)
			}
		})
	}
}

func TestApplyToSimMetaYardAndNamedWreck(t *testing.T) {
	info := decodeUnit(t, `[UNITINFO] { UnitName=ARMCOM; FootprintX=1; FootprintZ=1; MovementClass=TANKDS2; YardMap=oyyo; }`)
	m := &sim.UnitMeta{Name: "armcom", Wreck: &sim.FeatureMeta{Name: "armcom_heap", FootprintX: 3, FootprintZ: 3}}
	m.Yard = sim.ParseYardMap(info.YardMap, 1, 1)
	ApplyToSimMeta(m, info, moveClasses(t), nil)
	if want := sim.ParseYardMap("oyyo", 2, 2); len(m.Yard) != len(want) {
		t.Fatalf("yard has %d cells, want the %d of the resolved 2x2 footprint", len(m.Yard), len(want))
	}
	if m.Wreck.FootprintX != 3 {
		t.Fatalf("a named corpse feature keeps its own footprint")
	}
}

func TestApplyToSimMetaEconomyAndReload(t *testing.T) {
	info := decodeUnit(t, `[UNITINFO] { UnitName=MAKER; MakesMetal=1.9; MetalStorage=12.5; EnergyStorage=0.5;
		Weapon1=LASER; Weapon2=GONE; }`)
	tab := BuildWeaponTable([]WeaponFile{{Path: "weapons/a.tdf", Data: []byte(`[LASER] { ID=5; reloadtime=0.35; }`)}})
	m := &sim.UnitMeta{Name: "maker"}
	m.Weapons[0] = sim.WeaponMeta{Name: "LASER", Present: true, ReloadTicks: 11}
	m.Weapons[1] = sim.WeaponMeta{Name: "GONE", Present: true, ReloadTicks: 4}
	ApplyToSimMeta(m, info, nil, tab.Resolve)
	if m.Econ.MakesMetal != 1 {
		t.Errorf("makesmetal %v, want the whole 1 the game keeps", m.Econ.MakesMetal)
	}
	if m.Econ.MetalStorage != 12.5 || m.Econ.EnergyStorage != 0.5 {
		t.Errorf("storage %v/%v, want the fractions 12.5/0.5", m.Econ.MetalStorage, m.Econ.EnergyStorage)
	}
	if m.Weapons[0].ReloadTicks != 10 {
		t.Errorf("reload %d ticks, want 10 (0.35*30 truncated)", m.Weapons[0].ReloadTicks)
	}
	if m.Weapons[1].ReloadTicks != 4 {
		t.Errorf("an unresolved weapon's ticks changed to %d", m.Weapons[1].ReloadTicks)
	}
}
