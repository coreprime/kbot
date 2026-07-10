package sim

import "github.com/coreprime/kbot/engine/fixed"

// UnitStateOverride is an authoritative single-unit state write, the hook a
// replay driver uses to pin a unit to decoded wire truth each tick. Each field
// group is gated by its Has* flag so a wire record that carries only a subset
// (position but no health, say) leaves the rest of the unit untouched. This is
// deliberately distinct from Restore — which rebuilds the whole world — and
// from the COB unit-value ports, which feed script reads rather than sim state.
type UnitStateOverride struct {
	// Pos is the unit's world position (raw fixed-point, all three axes).
	HasPos bool
	Pos    fixed.Vec3
	// Heading is the raw fractional TA-angle locomotion heading.
	HasHeading bool
	Heading    fixed.Fixed
	// Speed is the scalar locomotion velocity in world units per second,
	// applied along the heading by the next Step.
	HasSpeed bool
	Speed    fixed.Fixed
	// Health is the unit's hit points on the sim's 0..100 scale.
	HasHealth bool
	Health    fixed.Fixed
	// BuildPercent is construction progress on the 0..100 scale. A value
	// below 100 leaves the unit inert (the under-construction gate), so a
	// replay shows a frame being raised exactly as the wire reports it.
	HasBuildPercent bool
	BuildPercent    fixed.Fixed
	// Moving pins the unit's motion flag to the wire's in-motion truth. The
	// pin persists across ticks until the next Moving override: a pinned-
	// moving unit coasts along its heading at the injected Speed and keeps
	// its walk/drive animation running (the StartMoving/StopMoving COB
	// transitions fire exactly as the flag flips), while a pinned-stopped
	// unit holds still with its gait wound down. Without the pin an order-
	// less unit reads idle every tick, so wire-driven motion could never
	// animate.
	HasMoving bool
	Moving    bool
}

// Motion-pin states. None is the default for every unit the simulation
// itself drives; a replay's first Moving override flips the unit to driver-
// owned motion for the rest of its life (or until a world Restore drops it).
const (
	motionPinNone uint8 = iota
	motionPinStopped
	motionPinMoving
)

// SetUnitState authoritatively overwrites one live unit's pose/state. The unit
// must already exist — creation stays on the AddUnit/Spawn path, which carries
// the meta and script binding an override cannot — and a missing id returns
// false. No game logic runs on the write: health is set verbatim (a zero does
// not trigger death or its blast; the driver conveys deaths through its own
// events), and the next Step evolves the unit from the injected state exactly
// as if the simulation had produced it.
func (w *World) SetUnitState(id uint32, ov UnitStateOverride) bool {
	u := w.units[id]
	if u == nil {
		return false
	}
	if ov.HasPos {
		u.loco.Pos = fixed.Vec2{X: ov.Pos.X, Z: ov.Pos.Z}
		u.PosY = ov.Pos.Y
		// Re-anchor the stall detector so the teleport does not read as a
		// wedged move and trigger avoidance detours.
		u.progressPos = u.loco.Pos
		u.stallTicks = 0
	}
	if ov.HasHeading {
		u.loco.Heading = ov.Heading
	}
	if ov.HasSpeed {
		// The wire carries wu/sec; the sim's speed scalar is wu/frame.
		u.loco.Speed = ov.Speed.Div(fxTickHz)
	}
	if ov.HasHealth {
		u.Health = ov.Health
	}
	if ov.HasBuildPercent {
		// A wire-reported completion runs the same activation the
		// construction path performs, so a structure that finishes raising
		// in a replay visibly opens (an ActivateWhenBuilt solar unfolds)
		// instead of staying in its buildee pose.
		completed := u.BuildPercent < fixed.FromInt(100) && ov.BuildPercent >= fixed.FromInt(100)
		u.BuildPercent = ov.BuildPercent
		u.syncRemFromPercent()
		if completed && u.Meta != nil && u.Meta.OnOffable && u.Meta.ActivateWhenBuilt {
			w.setActivation(u, true)
		}
	}
	if ov.HasMoving {
		if ov.Moving {
			u.motionPin = motionPinMoving
		} else {
			u.motionPin = motionPinStopped
		}
	}
	return true
}
