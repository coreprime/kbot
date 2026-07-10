package sandboxverify

import (
	"fmt"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/frame"
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
//	side.metal / energy / mana    stock, raw 16.16
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
	}
	if c.Side != nil {
		return st.sampleSide(*c.Side, c.Observable)
	}
	if c.Unit != "" {
		return st.sampleUnit(c.Unit, c.Observable)
	}
	return 0, false, fmt.Sprintf("observable %q needs a unit or side", c.Observable)
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
	}
	return 0, false, fmt.Sprintf("unknown side observable %q", obs)
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
