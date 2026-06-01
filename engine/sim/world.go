// Package sim is the headless, deterministic Total Annihilation simulation
// core. It runs identically on the authoritative server (native build) and in
// the browser (wasm build); given the same seed and the same ordered stream of
// orders it produces bit-identical state, which is what lets a client predict
// ahead of the server and reconcile cleanly.
//
// Nothing here touches the filesystem, the clock, the network, goroutines or
// floats: assets arrive pre-parsed via UnitMeta, time advances in fixed ticks,
// and all math goes through engine/fixed. Unit iteration uses an insertion
// ordered slice rather than a Go map range so traversal order is stable.
package sim

import (
	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/frame"
	"github.com/coreprime/kbot/engine/order"
	"github.com/coreprime/kbot/engine/rng"
)

// Binding is the COB script hook surface the world drives. The script VM
// implements it; until a unit has a script it is nil and the world degrades to
// pure movement/combat. Defining it here (rather than importing the script
// package) keeps the dependency arrow pointing into sim.
type Binding interface {
	HasScript(name string) bool
	Start(name string, args ...int)
	// Pieces returns the current piece transforms for the render snapshot.
	Pieces() []frame.PieceState
}

// weaponSlot is one of a unit's three weapon state machines.
type weaponSlot struct {
	hasTarget  bool
	targetUnit uint32 // 0 = aim at point
	targetPt   fixed.Vec3
	source     string // "attack" or "manual"
	lastFireMs int64
}

// Unit is one live simulated unit.
type Unit struct {
	ID   uint32
	Name string
	Side int
	Meta *UnitMeta

	loco   locoState
	PosY   fixed.Fixed
	Health fixed.Fixed // 0..100

	Dead         bool
	BuildPercent fixed.Fixed

	IsMoving   bool
	hasMove    bool
	moveTarget fixed.Vec2

	hasAttack    bool
	attackTarget uint32

	weapons [3]weaponSlot

	binding Binding
}

// Pos returns the unit's world position.
func (u *Unit) Pos() fixed.Vec3 {
	return fixed.Vec3{X: u.loco.Pos.X, Y: u.PosY, Z: u.loco.Pos.Z}
}

// Heading returns the unit's current heading as a TA-angle.
func (u *Unit) Heading() int32 { return int32(u.loco.Heading.Int()) }

// World holds all simulation state for one match/session.
type World struct {
	units   map[uint32]*Unit
	order   []uint32 // insertion order for deterministic iteration
	nextID  uint32
	rng     *rng.Rng
	tick    uint64
	simMs   int64
	gravity fixed.Fixed
	events  []frame.Event

	// metaProvider resolves a unit type name to its stat block + binding when
	// a Spawn order arrives. Injected so the core stays asset-agnostic.
	spawn SpawnFunc
}

// SpawnFunc builds the meta and (optional) script binding for a unit type.
// Returning a nil binding yields a script-less unit (movement/combat only).
type SpawnFunc func(name string) (*UnitMeta, Binding)

// Config configures a new World.
type Config struct {
	Seed    uint32
	Gravity fixed.Fixed
	Spawn   SpawnFunc
}

// New creates an empty world.
func New(cfg Config) *World {
	g := cfg.Gravity
	if g == 0 {
		g = fixed.FromInt(80)
	}
	return &World{
		units:   make(map[uint32]*Unit),
		nextID:  1,
		rng:     rng.New(cfg.Seed),
		gravity: g,
		spawn:   cfg.Spawn,
	}
}

// Tick returns the current simulation tick number.
func (w *World) Tick() uint64 { return w.tick }

// UnitByID returns a unit or nil.
func (w *World) UnitByID(id uint32) *Unit { return w.units[id] }

// UnitCount returns the number of units currently in the world (live or dead
// until reaped). It is a cheap map length read used for session listings.
func (w *World) UnitCount() int { return len(w.units) }

// ForEachUnit visits every live unit in stable insertion order. Used to build
// authoritative wire snapshots without disturbing the render event buffer.
func (w *World) ForEachUnit(fn func(*Unit)) {
	for _, id := range w.order {
		if u := w.units[id]; u != nil {
			fn(u)
		}
	}
}

// emit records a discrete event for this tick's render snapshot.
func (w *World) emit(e frame.Event) { w.events = append(w.events, e) }

// AddUnit registers a new unit and returns its id.
func (w *World) AddUnit(name string, meta *UnitMeta, binding Binding, at fixed.Vec2, heading int32, side int) uint32 {
	id := w.nextID
	w.nextID++
	u := &Unit{
		ID:           id,
		Name:         name,
		Side:         side,
		Meta:         meta,
		Health:       fixed.FromInt(100),
		BuildPercent: fixed.FromInt(100),
		binding:      binding,
	}
	u.loco.Pos = at
	u.loco.Heading = fixed.FromInt(int(fixed.NormalizeAngle(heading)))
	w.units[id] = u
	w.order = append(w.order, id)
	if binding != nil && binding.HasScript("Create") {
		binding.Start("Create")
	}
	w.emit(frame.Event{Kind: frame.EvSpawn, UnitID: id})
	return id
}

// RestoredUnit carries the full per-unit motion state needed to resume the
// simulation elsewhere — a late-joining client rebuilding its local world from
// an authoritative snapshot. Heading and Speed are the raw fixed-point locostate
// (not the truncated render values), and the move target is included so a unit
// caught mid-move keeps driving identically rather than freezing. Weapon
// cooldowns are not carried, so combat state remains approximate.
type RestoredUnit struct {
	ID         uint32
	Name       string
	Side       int
	Pos        fixed.Vec3
	Heading    fixed.Fixed // raw fractional TA-angle
	Speed      fixed.Fixed
	HasMove    bool
	MoveTarget fixed.Vec2
	Health     fixed.Fixed
	Dead       bool
}

// ExportUnits captures every live unit's full motion state in insertion order,
// for assembling an authoritative snapshot a client can resync from.
func (w *World) ExportUnits() []RestoredUnit {
	out := make([]RestoredUnit, 0, len(w.order))
	for _, id := range w.order {
		u := w.units[id]
		if u == nil {
			continue
		}
		out = append(out, RestoredUnit{
			ID:         u.ID,
			Name:       u.Name,
			Side:       u.Side,
			Pos:        u.Pos(),
			Heading:    u.loco.Heading,
			Speed:      u.loco.Speed,
			HasMove:    u.hasMove,
			MoveTarget: u.moveTarget,
			Health:     u.Health,
			Dead:       u.Dead,
		})
	}
	return out
}

// Restore replaces the world's unit set and resets the tick so a client can
// initialize its local prediction engine to the authority's current state.
// Meta and binding are re-resolved by name through the spawn provider; the
// nextID counter is advanced past every restored id so later spawns stay in
// lockstep with the authority.
func (w *World) Restore(tick uint64, units []RestoredUnit) {
	w.units = make(map[uint32]*Unit, len(units))
	w.order = w.order[:0]
	w.tick = tick
	w.simMs = int64(tick) * TickMs // simMs is derived purely from the tick count
	w.events = nil
	var maxID uint32
	for _, ru := range units {
		var meta *UnitMeta
		var binding Binding
		if w.spawn != nil {
			meta, binding = w.spawn(ru.Name)
		}
		u := &Unit{
			ID:           ru.ID,
			Name:         ru.Name,
			Side:         ru.Side,
			Meta:         meta,
			Health:       ru.Health,
			Dead:         ru.Dead,
			BuildPercent: fixed.FromInt(100),
			hasMove:      ru.HasMove,
			moveTarget:   ru.MoveTarget,
			IsMoving:     ru.HasMove,
			binding:      binding,
		}
		u.loco.Pos = fixed.Vec2{X: ru.Pos.X, Z: ru.Pos.Z}
		u.loco.Heading = ru.Heading
		u.loco.Speed = ru.Speed
		u.PosY = ru.Pos.Y
		w.units[ru.ID] = u
		w.order = append(w.order, ru.ID)
		if ru.ID > maxID {
			maxID = ru.ID
		}
	}
	w.nextID = maxID + 1
}

// RemoveUnit despawns a unit.
func (w *World) RemoveUnit(id uint32) {
	if _, ok := w.units[id]; !ok {
		return
	}
	delete(w.units, id)
	for i, oid := range w.order {
		if oid == id {
			w.order = append(w.order[:i], w.order[i+1:]...)
			break
		}
	}
	w.emit(frame.Event{Kind: frame.EvDespawn, UnitID: id})
}

// ApplyOrder dispatches a player order into the world. This is the single
// mutation entry point the session/network layer calls.
func (w *World) ApplyOrder(o order.Order) {
	switch o.Kind {
	case order.KindMove:
		for _, id := range o.UnitIDs {
			if u := w.units[id]; u != nil && !u.Dead {
				u.hasMove = true
				u.moveTarget = o.Target
			}
		}
	case order.KindAttack:
		for _, id := range o.UnitIDs {
			if u := w.units[id]; u != nil && !u.Dead {
				if t := w.units[o.TargetUnit]; t != nil && !t.Dead && t != u {
					u.hasAttack = true
					u.attackTarget = o.TargetUnit
				}
			}
		}
	case order.KindStop:
		for _, id := range o.UnitIDs {
			w.stopUnit(id)
		}
	case order.KindFire:
		if u := w.units[o.UnitID]; u != nil && !u.Dead && o.Slot >= 0 && o.Slot < 3 {
			s := &u.weapons[o.Slot]
			s.hasTarget = true
			s.source = "manual"
			if o.HasTargetUnit {
				s.targetUnit = o.TargetUnit
			} else {
				s.targetUnit = 0
				s.targetPt = fixed.Vec3{X: o.Target.X, Z: o.Target.Z}
			}
		}
	case order.KindSpawn:
		if w.spawn != nil {
			meta, binding := w.spawn(o.Name)
			if meta != nil {
				w.AddUnit(o.Name, meta, binding, o.SpawnAt, o.Heading, o.Side)
			}
		}
	case order.KindRemove:
		w.RemoveUnit(o.UnitID)
	}
}

func (w *World) stopUnit(id uint32) {
	u := w.units[id]
	if u == nil {
		return
	}
	u.hasMove = false
	u.hasAttack = false
	for i := range u.weapons {
		u.weapons[i] = weaponSlot{}
	}
	if u.binding != nil && u.binding.HasScript("StopMoving") {
		u.binding.Start("StopMoving")
	}
	if u.binding != nil && u.binding.HasScript("TargetCleared") {
		u.binding.Start("TargetCleared", 0)
	}
}

// ApplyDamage subtracts dmg from target HP, emitting hit and (on lethal) death.
func (w *World) ApplyDamage(sourceID, targetID uint32, dmg fixed.Fixed) bool {
	t := w.units[targetID]
	if t == nil || t.Dead {
		return false
	}
	t.Health -= dmg
	w.emit(frame.Event{Kind: frame.EvHit, UnitID: sourceID, TargetID: targetID})
	if t.Health <= 0 {
		t.Health = 0
		t.Dead = true
		anchor := t.Pos()
		anchor.Y += fixed.FromInt(18)
		w.emit(frame.Event{Kind: frame.EvDeath, UnitID: targetID, Anchor: anchor})
		return true
	}
	return false
}
