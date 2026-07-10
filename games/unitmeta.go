// Unit-meta building: the asset bridge that turns a unit's FBI (plus its
// weapon TDF data) into the simulation's fixed-point stat block. Both shipped
// games funnel through the same pipeline — the TA pass resolves Weapon1/2/3
// references through the caller's weapons index, and the TA:K pass fills any
// slots the FBI declares inline — so detection is data-driven: a file's own
// shape decides which passes contribute, and a custom game's units work with
// either convention.
package games

import (
	"fmt"
	"strings"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/sim"
	"github.com/coreprime/kbot/formats/gamedata/ta"
	"github.com/coreprime/kbot/formats/gamedata/tak"
	"github.com/coreprime/kbot/formats/tdf"
)

// WeaponResolver maps an FBI weapon reference (Weapon1/2/3) to its parsed
// weapons/*.tdf section, returning ok=false for an unknown ref.
type WeaponResolver func(ref string) (ta.Weapon, bool)

// UnitMetaFromFBI parses raw FBI bytes and builds the full stat block: the TA
// reference pass first, then the TA:K inline-weapon pass for any slots still
// empty.
func UnitMetaFromFBI(name string, fbi []byte, resolve WeaponResolver) (*sim.UnitMeta, error) {
	var u ta.Unit
	if err := tdf.Unmarshal(fbi, &u); err != nil {
		return nil, err
	}
	m := MetaFromUnitInfo(name, &u.Info, resolve)
	var ku tak.Unit
	if err := tdf.Unmarshal(fbi, &ku); err == nil {
		ApplyTAKWeapons(m, &ku)
		applyTAKLocoInfo(m, &ku)
		applyTAKEcon(m, &ku)
	}
	return m, nil
}

// applyTAKEcon fills the TA:K half of the economy stat block from the unit's
// inline mana fields. buildtime defaults to 100 when unset; buildcost falls
// back to buildtime; the f32 reciprocal is computed once here (the engine
// never re-divides). A TA:K FBI carries no metal/energy prices, so this leaves
// the TA econ group as parsed (zero) and the world's TA:K model reads only
// these fields.
func applyTAKEcon(m *sim.UnitMeta, ku *tak.Unit) {
	if m == nil || ku == nil {
		return
	}
	bt := float32(ku.Info.BuildTime)
	if bt <= 0 {
		bt = 100
	}
	bc := float32(ku.Info.BuildCost)
	if bc <= 0 {
		bc = bt
	}
	m.Econ.BuildTimeF = bt
	m.Econ.BuildCost = bc
	m.Econ.BuildTimeRecip = 1 / bt
	m.Econ.WorkerTimeF = float32(ku.Info.WorkerTime)
	m.Econ.ManaIncome = float32(ku.Info.MogriumIncome)
	m.Econ.ManaStorage = float32(ku.Info.MogriumStorage)
	m.Econ.HealTime = float32(ku.Info.HealTime)
	// The fixed-point HUD price for the mana pool.
	m.CostMana = fixed.FromInt(ku.Info.BuildCost)
}

// MetaFromUnitInfo converts a parsed FBI [UNITINFO] block into the simulation's
// fixed-point stat block. resolveWeapon maps an FBI weapon reference
// (Weapon1/2/3) to its parsed TDF section, returning ok=false for an unknown
// ref. Both asset bridges — the native flattened-tree provider and the studio
// VFS provider — funnel through here so a unit gets identical stats regardless
// of where the bytes were read from.
func MetaFromUnitInfo(name string, info *ta.UnitInfo, resolveWeapon func(ref string) (ta.Weapon, bool)) *sim.UnitMeta {
	m := &sim.UnitMeta{
		Name:              name,
		MaxVelocity:       fixed.FromFloat(info.MaxVelocity),
		TurnRate:          fixed.FromInt(info.TurnRate),
		Accel:             fixed.FromFloat(info.Acceleration),
		BrakeRate:         fixed.FromFloat(info.BrakeRate),
		CanMove:           info.MaxVelocity > 0,
		IsBuilder:         info.Builder == 1,
		OnOffable:         info.OnOffable == 1,
		ActivateWhenBuilt: info.ActivateWhenBuilt == 1,
		MaxHealth:         fixed.FromInt(info.MaxDamage),
		FootprintX:        info.FootprintX,
		FootprintZ:        info.FootprintZ,
	}
	m.Yard = sim.ParseYardMap(info.YardMap, info.FootprintX, info.FootprintZ)
	m.MaxSlope = info.MaxSlope
	m.MaxWaterDepth = info.MaxWaterDepth
	m.MinWaterDepth = info.MinWaterDepth
	applyLocoInfo(m, info)
	tedClass := strings.ToUpper(strings.TrimSpace(info.TEDClass))
	cats := map[string]bool{}
	for _, c := range info.Category {
		cats[strings.ToUpper(strings.TrimSpace(c))] = true
	}
	switch tedClass {
	case "SHIP":
		m.IsShip = true
	case "SUB", "UWMINE", "UWBLDG":
		m.IsSub = true
	case "VTOL", "FIGHTER", "BOMBER", "GUNSHIP", "TRANSPORT", "AIR":
		m.IsAircraft = true
	}
	if info.CanFly == 1 || cats["VTOL"] || cats["AIR"] || cats["FIGHTER"] || cats["BOMBER"] || cats["GUNSHIP"] {
		m.IsAircraft = true
	}
	if cats["SHIP"] && !m.IsSub {
		m.IsShip = true
	}
	if cats["SUB"] || cats["UNDERWATER"] {
		m.IsSub = true
	}
	if cats["HOVER"] && !m.IsAircraft {
		m.IsHovercraft = true
	}
	m.IsHover = info.HoverAttack == 1
	if m.IsAircraft {
		alt := info.CruiseAlt
		if alt <= 0 {
			if m.IsHover {
				alt = 60
			} else {
				alt = 100
			}
		}
		m.CruiseAltitude = fixed.FromFloat(alt)
	}
	for i, ref := range []string{info.Weapon1, info.Weapon2, info.Weapon3} {
		m.Weapons[i] = weaponMetaFromRef(ref, resolveWeapon)
	}
	applyTAEcon(m, info)
	return m
}

// applyTAEcon fills the construction/build-pace fields (used by both the
// fixed-point HUD and the exact float32 economy) and the TA economy stat
// block from an FBI. The float32 Econ group is what the world's TA economy
// law reads; the fixed CostMetal/CostEnergy and BuildTime/WorkerTime figures
// stay for the studio/HUD. A TA:K FBI simply never sets these keys.
func applyTAEcon(m *sim.UnitMeta, info *ta.UnitInfo) {
	// Build-pace figures (fixed-point HUD copies).
	m.BuildTime = fixed.FromInt(info.BuildTime)
	m.WorkerTime = info.WorkerTime
	m.BuildDistance = fixed.FromInt(info.BuildDistance)
	m.CostMetal = fixed.FromFloat(info.BuildCostMetal)
	m.CostEnergy = fixed.FromInt(info.BuildCostEnergy)

	// Exact float32 economy block.
	e := &m.Econ
	e.EnergyMake = float32(info.EnergyMake)
	e.MetalMake = float32(info.MetalMake)
	e.EnergyUse = float32(info.EnergyUse)
	e.ExtractsMetal = float32(info.ExtractsMetal)
	e.MakesMetal = float32(info.MakesMetal)
	// windgenerator/tidalgenerator are not surfaced by the FBI parser; the
	// world's wind system is a later block and tidal defaults apply, so the
	// EconMeta wind/tidal fields stay zero (no scenario exercises them).
	e.EnergyStorage = float32(info.EnergyStorage)
	e.MetalStorage = float32(info.MetalStorage)
	e.BuildTime = int32(info.BuildTime)
	if info.WorkerTime > 0 {
		e.WorkerTime = uint32(info.WorkerTime)
	}
	e.BuildCostEnergy = float32(info.BuildCostEnergy)
	e.BuildCostMetal = float32(info.BuildCostMetal)
}

// ApplyTAKWeapons fills any empty weapon slots from a TA:Kingdoms unit's
// inline [WEAPONn] sections. TA:K FBIs carry the weapon definitions as
// top-level siblings of [UNITINFO] instead of weapons/*.tdf references, so
// the ref-based loop in MetaFromUnitInfo finds nothing for them. Both asset
// bridges (native flattened-tree and studio VFS) call this after the TA pass
// so a unit gets identical stats on the authority and in the browser.
func ApplyTAKWeapons(m *sim.UnitMeta, u *tak.Unit) {
	if m == nil || u == nil {
		return
	}
	for i, sec := range []*tak.Weapon{u.Weapon1, u.Weapon2, u.Weapon3} {
		if sec == nil || m.Weapons[i].Present {
			continue
		}
		name := strings.ToUpper(strings.TrimSpace(sec.Name))
		if name == "" {
			name = fmt.Sprintf("WEAPON%d", i+1)
		}
		// The [DAMAGE] table's default= is the absolute per-shot damage;
		// the other keys are per-category multipliers, so only the default
		// feeds the engine's damage figure. Truncate exactly like the
		// studio's JSON path (damageDefault is an int) so the authority and
		// the browser clients hash identical weapon stats.
		dmg := float64(int(sec.Damage["default"]))
		m.Weapons[i] = sim.WeaponMeta{
			Name:           name,
			Range:          fixed.FromInt(sec.Range),
			ReloadMs:       int(sec.ReloadTime * 1000),
			Burst:          1,
			Damage:         fixed.FromFloat(dmg),
			Present:        true,
			Tolerance:      int32(sec.AimTolerance),
			VelocityWU:     fixed.FromFloat(sec.WeaponVelocity),
			AreaOfEffectWU: fixed.FromInt(sec.AreaOfEffect),
			Ballistic:      strings.EqualFold(strings.TrimSpace(sec.Type), "ballistic"),
		}
	}
}

// weaponMetaFromRef resolves an FBI weapon reference into the engine's per-slot
// stats via the supplied resolver. An empty / NONE / unknown ref yields a zero
// (absent) weapon slot.
func weaponMetaFromRef(ref string, resolveWeapon func(ref string) (ta.Weapon, bool)) sim.WeaponMeta {
	key := strings.ToUpper(strings.TrimSpace(ref))
	if key == "" || key == "NONE" || key == "-" {
		return sim.WeaponMeta{}
	}
	sec, ok := resolveWeapon(key)
	if !ok {
		return sim.WeaponMeta{}
	}
	burst := sec.Burst
	if burst < 1 {
		burst = 1
	}
	return sim.WeaponMeta{
		Name:     key,
		Range:    fixed.FromInt(sec.Range),
		ReloadMs: int(sec.ReloadTime * 1000),
		Burst:    burst,
		Damage:   fixed.FromInt(sec.Damage["default"]),
		Present:  true,

		// Firing arc, in TA-angle units, that gates an aircraft's body before it
		// fires (no rotating turret).
		Tolerance: int32(sec.Tolerance),

		// Projectile flight fields, surfaced from the weapon TDF so a missile /
		// rocket / bomb flies through the projectile subsystem (matching the
		// wasm conversion path in cmd/engine-wasm/convert.go). The TDF turnrate
		// is already in TA-angle units per second.
		Model:           strings.ToLower(strings.TrimSpace(sec.Model)),
		BeamWeapon:      sec.BeamWeapon != 0,
		VelocityWU:      fixed.FromFloat(sec.WeaponVelocity),
		StartVelocityWU: fixed.FromFloat(sec.StartVelocity),
		AccelerationWU:  fixed.FromFloat(sec.WeaponAcceleration),
		TurnRateAng:     int32(sec.TurnRate),
		FlightTimeSec:   fixed.FromFloat(sec.WeaponTimer),
		AreaOfEffectWU:  fixed.FromInt(sec.AreaOfEffect),
		Dropped:         sec.Dropped != 0,
		VLaunch:         sec.VLaunch != 0,
		Tracks:          sec.Tracks != 0,
		SelfProp:        sec.SelfProp != 0,
		Ballistic:       sec.Ballistic != 0,
	}
}
