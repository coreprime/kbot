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
	Speed        fixed.Fixed // current locomotion speed (world units/sec)
	Health       fixed.Fixed // 0..100
	Dead         bool
	BuildPercent fixed.Fixed // 0..100
	IsMoving     bool
	Pieces       []PieceState
}

// ProjectileState is one in-flight model projectile (missile/rocket/bomb).
type ProjectileState struct {
	ID      uint32
	Kind    string // 3DO model name the renderer draws the in-flight mesh from
	Pos     fixed.Vec3
	Heading int32
	Pitch   int32

	// Inspection fields — the studio's Projectiles panel plots a launch→aim
	// track and labels each shot by owner/weapon. They are render/debug-only
	// (never hashed), so surfacing them cannot perturb determinism.
	OwnerID  uint32
	TargetID uint32 // 0 when the shot is aimed at a fixed ground point
	Weapon   string
	Mode     string // flight behaviour: straight|dropped|vlaunch|guided|ballistic
	Vel      fixed.Vec3
	Origin   fixed.Vec3
	Target   fixed.Vec3
	Speed    fixed.Fixed
	AgeSec   fixed.Fixed
	LifeSec  fixed.Fixed
	// FromPiece is the emitter piece index the slot's Query script returned at
	// launch. The sim spawns from the unit origin (no geometry); the renderer
	// uses this to offset the in-flight mesh to the real muzzle.
	FromPiece int32
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
	// EvCorpseSpawn fires when a dead unit's Killed script settles its
	// corpse choice: Slot carries the corpsetype (1 = intact corpse,
	// 2 = damaged, 3 = nothing) and SfxType the body heading in TA-angle
	// units. The client resolves the actual wreck feature from unit meta.
	EvCorpseSpawn
)

// Event is a discrete occurrence during a tick. Only the fields meaningful for
// Kind are populated.
type Event struct {
	Kind     EventKind
	UnitID   uint32
	TargetID uint32
	Slot     int
	Anchor   fixed.Vec3
	// Target is the resolved aim point for a fire event — the unit's position
	// when locked on a unit, or the ground point for a force-fire. The renderer
	// needs it to launch a ballistic shot whose model the sim does not fly; for
	// a ground-aimed cannon ball there is no TargetID to look up, so without
	// this the client cannot derive a trajectory.
	Target fixed.Vec3
	// FromPiece is the COB piece index a fire event's shot exits from, as
	// reported by the unit's Query<slot> script. The sim is geometry-agnostic, so
	// it cannot resolve the muzzle's world position itself; it hands the renderer
	// the piece index (into the unit's piece-name table) and lets the client
	// compute the post-animation muzzle position. -1 means the unit has no Query
	// script, so the renderer falls back to the unit anchor. Running the query
	// also advances any per-barrel cycle the script keeps, so multi-barrel
	// weapons alternate their muzzle from shot to shot.
	FromPiece int32
	Weapon    string
	Sound     string
	SfxType   int
}

// CobThread is one live script thread's inspectable state, surfaced to the
// studio's Runtime panel. It is render/debug-only: thread identity and program
// counters never feed the world hash, so reporting them cannot perturb
// determinism.
type CobThread struct {
	ID         int    // stable per-unit thread id, for list keys
	Script     string // entry-point name the thread is executing
	PC         int    // next instruction index within the current script
	Offset     int    // byte offset of that instruction, for the disassembly view
	SleepMs    int    // remaining sleep, 0 when running
	Waiting    bool   // blocked on a piece animation (turn/move) completing
	WaitTurn   bool   // when Waiting, true = turn animation, false = move
	SignalMask int    // signal bits this thread listens for
	// Locals and Stack are the thread's live local variables and operand stack,
	// surfaced to the debugger's variables tray. Debug-only, never hashed.
	Locals []int32
	Stack  []int32
	// BreakpointHit is true when the thread is parked on a breakpoint instruction
	// (the debugger autopauses on it). Cleared by a step / continue / pc edit.
	BreakpointHit bool
}

// CobUnitState is one unit's inspectable COB state — its static variables and
// the threads currently running on it. Debug-only, never hashed.
type CobUnitState struct {
	Static  []int32
	Threads []CobThread
}

// CobAnimSnap is one active (piece,axis) animator carried across a resync. Key
// is piece*3+axis. Only non-idle animators are serialized: an idle animator
// contributes nothing to a piece's pose and is the rest state a freshly built
// unit already holds, so omitting it is lossless. Value/Target/Speed/Decel are
// the raw fixed.Fixed integers (the same scale COB operands use).
type CobAnimSnap struct {
	Key    int   `json:"key"`
	Kind   int   `json:"kind"`
	Value  int64 `json:"value"`
	Target int64 `json:"target,omitempty"`
	Speed  int64 `json:"speed,omitempty"`
	Decel  int64 `json:"decel,omitempty"`
	Done   bool  `json:"done,omitempty"`
}

// CobCallFrame is one saved CALL_SCRIPT context on a thread's call stack.
type CobCallFrame struct {
	ScriptIndex int     `json:"scriptIndex"`
	PC          int     `json:"pc"`
	Locals      []int32 `json:"locals,omitempty"`
}

// CobThreadSnap is one live script thread carried across a resync. ScriptIndex
// is an index into the unit's own program; it is stable because both authority
// and joiner bind the same .cob for a given unit type. A thread blocked on an
// animation carries WaitOn (Waiting=true) naming the animator it polls.
type CobThreadSnap struct {
	ID          int32          `json:"id"`
	ScriptIndex int            `json:"scriptIndex"`
	PC          int            `json:"pc"`
	Stack       []int32        `json:"stack,omitempty"`
	Locals      []int32        `json:"locals,omitempty"`
	SignalMask  int32          `json:"signalMask,omitempty"`
	SleepMs     int64          `json:"sleepMs,omitempty"`
	Waiting     bool           `json:"waiting,omitempty"`
	WaitRot     bool           `json:"waitRot,omitempty"`
	WaitKey     int            `json:"waitKey,omitempty"`
	CallStack   []CobCallFrame `json:"callStack,omitempty"`
	ReturnValue int32          `json:"returnValue,omitempty"`
}

// CobSnapshot is the full live COB VM state for one unit — its static
// variables, active piece animators, piece visibility and running threads —
// transferred across a late join so the joiner's piece poses (turret aim,
// rotation, mid-animation) match the authority exactly instead of being
// re-derived by replaying Create/StartMoving. NextID preserves the monotonic
// thread-id counter so the inspector keeps stable keys.
type CobSnapshot struct {
	Static  []int32         `json:"static,omitempty"`
	Anims   []CobAnimSnap   `json:"anims,omitempty"`
	Hidden  []int           `json:"hidden,omitempty"` // piece indices that are HIDE'd
	Threads []CobThreadSnap `json:"threads,omitempty"`
	NextID  int32           `json:"nextId,omitempty"`
}

// Snapshot is the complete drawable state for one simulation tick plus the
// events that fired during it.
type Snapshot struct {
	Tick   uint64
	Units  []UnitState
	Projos []ProjectileState
	Events []Event
}
