// Locomotion stat wiring: the FBI fields the movement law consumes beyond the
// basic kinematics, split out so both the TA and TA:K parse passes stay thin.
package games

import (
	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/sim"
	"github.com/coreprime/kbot/formats/gamedata/ta"
	"github.com/coreprime/kbot/formats/gamedata/tak"
)

// applyLocoInfo copies the shared locomotion FBI fields onto the stat block:
// the capability flags (canhover/floater/upright), the floater waterline, the
// walk-anim tier thresholds and the movementclass name (resolved later by
// ApplyMovementClass, which needs the game's moveinfo.tdf).
func applyLocoInfo(m *sim.UnitMeta, info *ta.UnitInfo) {
	m.CanHover = info.CanHover == 1
	m.Floater = info.Floater == 1
	m.Upright = info.Upright == 1
	m.WaterLine = fixed.FromFloat(info.WaterLine)
	m.MoveRate1 = fixed.FromFloat(info.MoveRate1)
	m.MoveRate2 = fixed.FromFloat(info.MoveRate2)
	m.MovementClass = info.MovementClass
}

// applyTAKLocoInfo copies the TA:K-only per-unit stat multipliers: the
// in-water and on-road kinematic scales (engine defaults 1.0 / 1.2 apply in
// the sim when the FBI omits them).
func applyTAKLocoInfo(m *sim.UnitMeta, u *tak.Unit) {
	m.WaterMult = fixed.FromFloat(u.Info.WaterMultiplier)
	m.RoadMult = fixed.FromFloat(u.Info.RoadMultiplier)
}
