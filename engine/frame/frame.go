// Package frame defines the render snapshot the local engine instance hands to
// the renderer each visual frame. This is the layer that keeps "rendering
// unaffected": it mirrors the data the existing WebGL renderer already reads
// from the JS engine (unit poses, piece transforms, in-flight projectiles) and
// the discrete events its particle/audio systems react to.
//
// A render snapshot is produced locally and never travels over the network —
// piece animation is re-derived by each client's own engine from the command
// stream. Only the higher-level wire messages cross the wire.
package frame

import "github.com/coreprime/kbot/engine/fixed"

// PieceState is one 3DO piece's local transform, the output of the COB script
// binding. The renderer applies it on top of the piece's rest pose.
type PieceState struct {
	Offset  fixed.Vec3 // local translation from MOVE
	Rot     [3]int32   // local rotation per axis (TA-angles) from TURN/SPIN
	Visible bool       // HIDE/SHOW state
}

// UnitState is everything the renderer needs to draw one unit.
type UnitState struct {
	ID           uint32
	Name         string
	Side         int
	Pos          fixed.Vec3
	Heading      int32
	Health       fixed.Fixed // 0..100
	Dead         bool
	BuildPercent fixed.Fixed // 0..100
	IsMoving     bool
	Pieces       []PieceState
}

// ProjectileState is one in-flight model projectile (missile/rocket/bomb).
type ProjectileState struct {
	ID      uint32
	Kind    string
	Pos     fixed.Vec3
	Heading int32
	Pitch   int32
}

// EventKind enumerates the discrete events the renderer's effects layer reacts
// to. These mirror the JS engine's event bus exactly.
type EventKind uint8

const (
	EvNone EventKind = iota
	EvSpawn
	EvDespawn
	EvFire
	EvHit
	EvDeath
	EvMoveStart
	EvMoveStop
	EvProjectileSpawn
	EvProjectileHit
	EvEmitSfx
	EvPlaySound
	EvExplode
)

// Event is a discrete occurrence during a tick. Only the fields meaningful for
// Kind are populated.
type Event struct {
	Kind     EventKind
	UnitID   uint32
	TargetID uint32
	Slot     int
	Anchor   fixed.Vec3
	Weapon   string
	Sound    string
	SfxType  int
}

// Snapshot is the complete drawable state for one simulation tick plus the
// events that fired during it.
type Snapshot struct {
	Tick   uint64
	Units  []UnitState
	Projos []ProjectileState
	Events []Event
}
