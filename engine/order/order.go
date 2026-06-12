// Package order defines the player commands a client submits to the
// simulation. Orders are the only thing that crosses the wire in steady state:
// the server stamps each one with an execution tick and broadcasts it, and
// every engine instance (server and predicting clients) applies the identical
// order at the identical tick, so they stay in lockstep.
package order

import "github.com/coreprime/kbot/engine/fixed"

// Kind enumerates the order variants. Stored as an explicit value so orders
// serialize as plain data rather than a Go interface.
type Kind uint8

const (
	KindNone Kind = iota
	// Move sends UnitIDs toward Target on the ground plane.
	KindMove
	// Attack orders UnitIDs to engage TargetUnit.
	KindAttack
	// Stop clears all orders on UnitIDs.
	KindStop
	// Fire points a single unit's weapon Slot at a target (unit or point).
	KindFire
	// Spawn creates a new unit (sandbox authoring / scenario setup).
	KindSpawn
	// Remove despawns a unit.
	KindRemove
	// Build sends a mobile builder (UnitID) to construct unit type Name at
	// ground point Target: walk into builddistance, then gradually raise the
	// buildee's build percentage until it is complete and commandable.
	KindBuild
	// Patrol appends a patrol waypoint to UnitIDs' queues. Consecutive
	// patrol entries loop: a completed leg re-queues itself at the tail, so
	// the unit cycles its patrol route until ordered otherwise.
	KindPatrol
	// Stance sets UnitIDs' standing orders: MoveMode (0 hold position,
	// 1 maneuver, 2 roam) and FireMode (0 hold fire, 1 return fire,
	// 2 fire at will).
	KindStance
)

// Standing-order values carried by a Stance order.
const (
	MoveHold     = 0
	MoveManeuver = 1
	MoveRoam     = 2

	FireHold   = 0
	FireReturn = 1
	FireAtWill = 2
)

// Order is a tagged command. Only the fields relevant to Kind are populated;
// the flat layout keeps it trivially serializable for the wire protocol.
type Order struct {
	Kind Kind

	// UnitIDs is the set of units a Move/Attack/Stop applies to.
	UnitIDs []uint32

	// UnitID is the single subject for Fire/Remove.
	UnitID uint32

	// Target is the destination for Move, or the aim point for a Fire whose
	// HasTargetUnit is false.
	Target fixed.Vec2

	// TargetUnit is the subject of Attack, or the Fire target when
	// HasTargetUnit is true.
	TargetUnit uint32

	// HasTargetUnit distinguishes a Fire aimed at a unit from one aimed at a
	// ground point.
	HasTargetUnit bool

	// Queued appends a Move/Attack to each unit's order queue (the shift-click
	// gesture) instead of replacing the current order. The queued order runs
	// when its predecessor completes — a move on arrival, an attack when the
	// target dies. A non-queued order replaces both the current order and the
	// whole queue.
	Queued bool

	// Slot is the weapon slot (0..2) for Fire.
	Slot int

	// Spawn parameters.
	Name    string
	SpawnAt fixed.Vec2
	Heading int32
	Side    int

	// Standing orders for Stance (always both set; see Move/Fire constants).
	MoveMode int
	FireMode int
}

// Move builds a move order.
func Move(units []uint32, target fixed.Vec2) Order {
	return Order{Kind: KindMove, UnitIDs: units, Target: target}
}

// MoveQueued builds a move order appended to each unit's queue (shift-click).
func MoveQueued(units []uint32, target fixed.Vec2) Order {
	return Order{Kind: KindMove, UnitIDs: units, Target: target, Queued: true}
}

// Attack builds an attack order.
func Attack(units []uint32, targetUnit uint32) Order {
	return Order{Kind: KindAttack, UnitIDs: units, TargetUnit: targetUnit}
}

// AttackQueued builds an attack order appended to each unit's queue.
func AttackQueued(units []uint32, targetUnit uint32) Order {
	return Order{Kind: KindAttack, UnitIDs: units, TargetUnit: targetUnit, Queued: true}
}

// Stop builds a stop order.
func Stop(units []uint32) Order {
	return Order{Kind: KindStop, UnitIDs: units}
}

// Build sends one mobile builder to construct unit type name at a ground point.
func Build(builder uint32, name string, target fixed.Vec2) Order {
	return Order{Kind: KindBuild, UnitID: builder, Name: name, Target: target}
}

// Patrol appends a patrol waypoint to each unit's queue.
func Patrol(units []uint32, target fixed.Vec2) Order {
	return Order{Kind: KindPatrol, UnitIDs: units, Target: target}
}

// Stance sets the units' standing move and fire orders.
func Stance(units []uint32, moveMode, fireMode int) Order {
	return Order{Kind: KindStance, UnitIDs: units, MoveMode: moveMode, FireMode: fireMode}
}

// FireAtUnit points one unit's weapon slot at a target unit (manual force-fire
// on a specific enemy, distinct from a standing Attack order).
func FireAtUnit(unit uint32, slot int, targetUnit uint32) Order {
	return Order{Kind: KindFire, UnitID: unit, Slot: slot, HasTargetUnit: true, TargetUnit: targetUnit}
}

// FireAtPoint points one unit's weapon slot at a ground point (shift-to-ground
// force-fire). Only X/Z matter; the target elevation is the ground plane.
func FireAtPoint(unit uint32, slot int, target fixed.Vec2) Order {
	return Order{Kind: KindFire, UnitID: unit, Slot: slot, HasTargetUnit: false, Target: target}
}
