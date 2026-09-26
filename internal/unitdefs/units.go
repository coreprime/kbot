package unitdefs

import (
	"github.com/coreprime/kbot-engine/engine/fixed"
	"github.com/coreprime/kbot-engine/engine/sim"
	"github.com/coreprime/kbot-io/formats/gamedata/ta"
	"github.com/coreprime/kbot-io/formats/tdf"
)

// LoadMoveClasses decodes gamedata/moveinfo.tdf. Every section is returned;
// the game reads only [CLASS0]..[CLASS31], which ta.UnitInfo.Movement and
// ta.FindMovementClass apply.
func LoadMoveClasses(data []byte) ([]ta.MovementClass, error) {
	var classes []ta.MovementClass
	if err := tdf.Unmarshal(data, &classes); err != nil {
		return nil, err
	}
	return classes, nil
}

// StandingOrders returns the move and fire orders a unit starts with, as the
// game resolves them: 2 (Roam, Fire at Will) when the key is missing,
// otherwise the value's low two bits, so an explicit 0 is Hold Position or
// Hold Fire.
func StandingOrders(info *ta.UnitInfo) (move, fire int) {
	return info.EffectiveStandingMoveOrder(), info.EffectiveStandingFireOrder()
}

// ApplyToSimMeta brings a sim stat block built by the games meta builders in
// line with the game's rules for the unit's [UNITINFO]:
//
//   - footprint, water depths and maximum slope come from the unit's
//     movement class when it names one of [CLASS0]..[CLASS31] (keys the class
//     leaves out take the game's defaults), else from the unit's own keys
//     with the same defaults; the yard grid, the splash box and a default
//     wreck follow the resolved footprint;
//   - the standing orders are the resolved ones (see StandingOrders);
//   - the economy keeps TA's separate metal figures as the game reads them:
//     makesmetal a whole number, the storages fractional;
//   - weapons the resolver finds reload after whole ticks, reloadtime*30
//     truncated (see ReloadTicks).
//
// classes is the decoded moveinfo.tdf (nil when the game has none) and
// resolve the weapon resolver the meta was built with (nil to leave the
// reload ticks alone).
func ApplyToSimMeta(m *sim.UnitMeta, info *ta.UnitInfo, classes []ta.MovementClass, resolve func(ref string) (ta.Weapon, bool)) {
	if m == nil || info == nil {
		return
	}
	lim, _ := info.Movement(classes)
	m.FootprintX, m.FootprintZ = lim.FootprintX, lim.FootprintZ
	m.MaxWaterDepth = lim.MaxWaterDepth
	m.MinWaterDepth = lim.MinWaterDepth
	m.MaxSlope = lim.MaxSlope
	m.Yard = sim.ParseYardMap(info.YardMap, m.FootprintX, m.FootprintZ)
	if m.CombatBoxSet {
		m.CombatBoxHalfX = fixed.FromInt(m.FootprintX * 4)
		m.CombatBoxHalfZ = fixed.FromInt(m.FootprintZ * 4)
	}
	if m.Wreck != nil && m.Wreck.Name == m.Name+"_dead" {
		m.Wreck.FootprintX, m.Wreck.FootprintZ = m.FootprintX, m.FootprintZ
	}
	move, fire := StandingOrders(info)
	m.StandMove, m.StandFire = uint8(move), uint8(fire)
	m.Econ.MakesMetal = float32(info.EffectiveMakesMetal())
	m.Econ.EnergyStorage = float32(info.EffectiveEnergyStorage())
	m.Econ.MetalStorage = float32(info.EffectiveMetalStorage())
	if resolve == nil {
		return
	}
	for i, ref := range []string{info.Weapon1, info.Weapon2, info.Weapon3} {
		if i >= len(m.Weapons) || !m.Weapons[i].Present {
			continue
		}
		if w, ok := resolve(ref); ok {
			m.Weapons[i].ReloadTicks = ReloadTicks(w.ReloadTime)
		}
	}
}
