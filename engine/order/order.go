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

	// Slot is the weapon slot (0..2) for Fire.
	Slot int

	// Spawn parameters.
	Name    string
	SpawnAt fixed.Vec2
	Heading int32
	Side    int
}

// Move builds a move order.
func Move(units []uint32, target fixed.Vec2) Order {
	return Order{Kind: KindMove, UnitIDs: units, Target: target}
}

// Attack builds an attack order.
func Attack(units []uint32, targetUnit uint32) Order {
	return Order{Kind: KindAttack, UnitIDs: units, TargetUnit: targetUnit}
}

// Stop builds a stop order.
func Stop(units []uint32) Order {
	return Order{Kind: KindStop, UnitIDs: units}
}
