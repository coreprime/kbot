package sandboxverify

import (
	"fmt"
	"strings"

	"github.com/coreprime/kbot-engine/engine/fixed"
	"github.com/coreprime/kbot-engine/engine/frame"
	"github.com/coreprime/kbot-engine/engine/sim"
)

// evaluate samples one check's observable at the current (already stepped and
// observed) world state and grades it.
//
// Observables are expressed on the SPEC's axes so expected values come
// straight from the specification formulas:
//
//	unit.pos_x / pos_y / pos_z    raw 16.16 world units
//	unit.dist_from_start          raw 16.16 world units (XZ plane)
//	unit.heading                  TA-angle, normalised [0, 65536)
//	unit.speed                    raw 16.16 world units per 30 Hz frame
//	unit.hp                       absolute hit points (integer)
//	unit.alive                    1 while alive, else 0
//	unit.exists                   1 once the alias is bound to a live unit
//	unit.build_percent            whole percent 0..100
//	unit.fire_count               cumulative fire events for the unit
//	unit.projectile_spawns        cumulative projectile entities the unit launched
//	unit.kills                    veterancy kill counter
//	side.metal / energy / mana    stock, raw 16.16
//	side.*_produced               lifetime gross production, raw 16.16
//	world.projectiles             in-flight projectile count
//	world.rng_draws               cumulative sim-stream (MINSTD) draws since start
func (st *runState) evaluate(sc *Scenario, c CheckSpec, tick uint64) CheckResult {
	res := CheckResult{
		Label:      c.Label,
		Observable: c.Observable,
		Unit:       c.Unit,
		Side:       c.Side,
		SpecTick:   c.At,
		SimTick:    tick,
		SkewMs:     skewMs(c.At, tick),
		Expect:     c.Expect,
		Derivation: c.Derivation,
	}
	if c.RequiresAction != "" {
		if reason, ok := st.unsupported[c.RequiresAction]; ok {
			res.Verdict, res.Note = grade(c, 0, false, reason)
			return res
		}
	}
	actual, ok, note := st.sample(c)
	actual -= c.Baseline
	res.Actual = actual
	res.Delta = actual - c.Expect
	res.Verdict, res.Note = grade(c, actual, ok, note)
	if !ok {
		res.Delta = 0
	}
	return res
}

func (st *runState) sample(c CheckSpec) (int64, bool, string) {
	switch c.Observable {
	case "world.projectiles":
		return int64(len(st.lastSnap.Projos)), true, ""
	case "world.rng_draws":
		return int64(st.rngNow - st.rngStart), true, ""
	case "world.stockpile_cap":
		return int64(st.world.StockpileCap()), true, ""
	}
	if c.Observable == "side.unit_count" {
		if c.Side == nil {
			return 0, false, "side.unit_count needs a side"
		}
		// The Unit field, when set on a side.unit_count check, names the type
		// filter (lower-cased type name) rather than an alias.
		return st.sampleSideCount(*c.Side, strings.ToLower(c.Unit))
	}
	switch c.Observable {
	case "unit.coverage_covers":
		// Args = [x, z] world-unit point the interceptor's square box is
		// tested against (slot 0). Reports 1 when covered, else 0.
		if len(c.Args) != 2 {
			return 0, false, "unit.coverage_covers needs args [x, z]"
		}
		id, ok := st.aliases[c.Unit]
		if !ok {
			return 0, false, fmt.Sprintf("alias %q never bound", c.Unit)
		}
		if st.world.CoverageCovers(id, 0, c.Args[0], c.Args[1]) {
			return 1, true, ""
		}
		return 0, true, ""
	case "unit.resurrect_ticks":
		// Args = [targetBuildTime]; reports the resurrect channel length for
		// the named builder raising a unit of that buildtime.
		if len(c.Args) != 1 {
			return 0, false, "unit.resurrect_ticks needs args [targetBuildTime]"
		}
		id, ok := st.aliases[c.Unit]
		if !ok {
			return 0, false, fmt.Sprintf("alias %q never bound", c.Unit)
		}
		return int64(st.world.ResurrectTicks(id, float64(c.Args[0]))), true, ""
	}
	if c.Side != nil {
		return st.sampleSide(*c.Side, c.Observable)
	}
	if c.Unit != "" {
		return st.sampleUnit(c.Unit, c.Observable)
	}
	return 0, false, fmt.Sprintf("observable %q needs a unit or side", c.Observable)
}

// sampleUnitCount counts the live units on a side, optionally filtered to a
// type name — the observable a capture/conversion scenario reads to see
// ownership flip (the transferred unit respawns under the new side).
func (st *runState) sideUnitCount(side int, typeName string) int64 {
	var n int64
	st.world.ForEachUnit(func(u *sim.Unit) {
		if u.Side != side || u.Dead {
			return
		}
		if typeName != "" && u.Name != typeName {
			return
		}
		n++
	})
	return n
}

func (st *runState) sampleSide(side int, obs string) (int64, bool, string) {
	var rs *frame.ResourceState
	for i := range st.lastSnap.Resources {
		if st.lastSnap.Resources[i].Side == side {
			rs = &st.lastSnap.Resources[i]
			break
		}
	}
	if rs == nil {
		// The side has no economy figures at all (no units ever fielded).
		rs = &frame.ResourceState{Side: side}
	}
	switch obs {
	case "side.metal":
		return int64(rs.MetalStock), true, ""
	case "side.energy":
		return int64(rs.EnergyStock), true, ""
	case "side.mana":
		return int64(rs.ManaStock), true, ""
	case "side.metal_produced":
		return int64(rs.MetalProduced), true, ""
	case "side.energy_produced":
		return int64(rs.EnergyProduced), true, ""
	case "side.mana_produced":
		return int64(rs.ManaProduced), true, ""
	}
	return 0, false, fmt.Sprintf("unknown side observable %q", obs)
}

// sampleSideCount is the side.unit_count path: it reads the live-unit count on
// a side (the CheckSpec's Unit field, when set, names a type filter — the
// unit type whose ownership a capture/conversion moved).
func (st *runState) sampleSideCount(side int, typeName string) (int64, bool, string) {
	return st.sideUnitCount(side, typeName), true, ""
}

func (st *runState) sampleUnit(alias, obs string) (int64, bool, string) {
	id, bound := st.aliases[alias]
	var u *frame.UnitState
	if bound {
		for i := range st.lastSnap.Units {
			if st.lastSnap.Units[i].ID == id {
				u = &st.lastSnap.Units[i]
				break
			}
		}
	}
	if obs == "unit.exists" {
		if u != nil && !u.Dead {
			return 1, true, ""
		}
		return 0, true, ""
	}
	if !bound {
		return 0, false, fmt.Sprintf("alias %q never bound to a unit", alias)
	}
	if obs == "unit.fire_count" {
		return st.fireCounts[id], true, ""
	}
	if obs == "unit.projectile_spawns" {
		return st.projSpawns[id], true, ""
	}
	if obs == "unit.kills" {
		if u := st.world.UnitByID(id); u != nil {
			return int64(u.Kills()), true, ""
		}
		return 0, true, "unit despawned; kill counter gone"
	}
	if obs == "unit.private_mana" {
		// TA:K unit-private pool, truncated to whole mana (the pool the
		// spells and TA:K cloak drain).
		return int64(st.world.PrivateMana(id)), true, ""
	}
	if obs == "unit.cloaked" {
		if st.world.Cloaked(id) {
			return 1, true, ""
		}
		return 0, true, ""
	}
	if obs == "unit.paralyze_ticks" {
		return int64(st.world.ParalyzeTicks(id)), true, ""
	}
	if obs == "unit.side" {
		if s := st.world.SideOf(id); s >= 0 {
			return int64(s), true, ""
		}
		return 0, true, "unit gone"
	}
	if obs == "unit.mind_control_threshold" {
		return int64(st.world.MindControlThreshold(id)), true, ""
	}
	if obs == "unit.alive" {
		if u != nil && !u.Dead {
			return 1, true, ""
		}
		return 0, true, ""
	}
	if u == nil {
		return 0, false, fmt.Sprintf("unit %q (id %d) not in snapshot", alias, id)
	}
	switch obs {
	case "unit.pos_x":
		return int64(u.Pos.X), true, ""
	case "unit.pos_y":
		return int64(u.Pos.Y), true, ""
	case "unit.pos_z":
		return int64(u.Pos.Z), true, ""
	case "unit.dist_from_start":
		start := st.startPos[id]
		d := fixed.Vec2{X: u.Pos.X - start.X, Z: u.Pos.Z - start.Z}
		return int64(d.Len()), true, ""
	case "unit.heading":
		return int64(fixed.NormalizeAngle(u.Heading)), true, ""
	case "unit.speed":
		// Snapshot speed is world units per second; the spec axis is world
		// units per 30 Hz frame.
		return int64(u.Speed.Div(fixed.FromInt(SpecTickHz))), true, ""
	case "unit.hp":
		meta := st.metas[u.Name]
		if meta == nil || meta.MaxHealth <= 0 {
			return int64(u.Health.Int()), true, "no maxdamage; raw percent health"
		}
		hp := u.Health.Mul(meta.MaxHealth).Div(fixed.FromInt(100))
		return int64(hp.Int()), true, ""
	case "unit.build_percent":
		return int64(u.BuildPercent.Int()), true, ""
	}
	return 0, false, fmt.Sprintf("unknown unit observable %q", obs)
}
