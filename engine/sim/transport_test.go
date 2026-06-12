package sim

import (
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/order"
)

// transportMeta builds an air-transport stat block (Atlas-shaped when slots
// is 1, Bear-shaped on the ground plane when air is false).
func transportMeta(name string, slots int, air bool) *UnitMeta {
	m := testMeta(name)
	m.Weapons[0] = WeaponMeta{}
	m.TransportSlots = slots
	m.IsAircraft = air
	if air {
		m.IsHover = true
		m.CruiseAltitude = fixed.FromInt(60)
	}
	return m
}

// passiveMeta is unarmed cargo that never auto-engages.
func passiveCargo(w *World, name string, at fixed.Vec2, side int) uint32 {
	m := testMeta(name)
	m.Weapons[0] = WeaponMeta{}
	id := w.AddUnit(name, m, nil, at, 0, side)
	w.ApplyOrder(order.Stance([]uint32{id}, order.MoveHold, order.FireHold))
	return id
}

// TestTransportSingleLift pins the Atlas cycle: the transport flies to its
// cargo, attaches it, carries it (cargo rides the carrier's position, inert
// to orders), and an Unload sets it down at the drop point.
func TestTransportSingleLift(t *testing.T) {
	w := New(Config{Seed: 71})
	tr := w.AddUnit("atlas", transportMeta("atlas", 1, true), nil, fixed.Vec2{}, 0, 0)
	cargo := passiveCargo(w, "peewee", fixed.Vec2{X: fixed.FromInt(300)}, 0)

	w.ApplyOrder(order.Load([]uint32{tr}, cargo))
	for i := 0; i < 800 && w.UnitByID(cargo).carriedBy == 0; i++ {
		w.Step(nil)
	}
	cu := w.UnitByID(cargo)
	if cu.carriedBy != tr {
		t.Fatalf("cargo never attached: carriedBy=%d", cu.carriedBy)
	}
	if got := w.UnitByID(tr).carrying; len(got) != 1 || got[0] != cargo {
		t.Fatalf("transport carrying=%v, want [%d]", got, cargo)
	}

	// A carried unit ignores orders and rides the carrier.
	w.ApplyOrder(order.Move([]uint32{cargo}, fixed.Vec2{X: fixed.FromInt(900)}))
	drop := fixed.Vec2{X: fixed.FromInt(600), Z: fixed.FromInt(200)}
	w.ApplyOrder(order.Unload([]uint32{tr}, drop))
	for i := 0; i < 1200 && w.UnitByID(cargo).carriedBy != 0; i++ {
		w.Step(nil)
		if c := w.UnitByID(cargo); c.carriedBy != 0 {
			if d := c.loco.Pos.DistTo(w.UnitByID(tr).loco.Pos); d > fixed.FromInt(2) {
				t.Fatalf("carried cargo strayed %v wu from carrier", d.Float())
			}
		}
	}
	cu = w.UnitByID(cargo)
	if cu.carriedBy != 0 {
		t.Fatalf("cargo never set down")
	}
	if d := cu.loco.Pos.DistTo(drop); d > fixed.FromInt(120) {
		t.Fatalf("cargo dropped %v wu from the drop point", d.Float())
	}
	if cu.PosY != 0 {
		t.Fatalf("dropped cargo still airborne: y=%v", cu.PosY.Float())
	}
}

// TestTransportMultiLoad pins the Bear cycle: repeated Load orders queue
// pickups, the transport collects each in turn up to its slot count, and a
// single Unload fans every passenger onto clear ground at the drop site.
func TestTransportMultiLoad(t *testing.T) {
	w := New(Config{Seed: 72})
	tr := w.AddUnit("bear", transportMeta("bear", 6, false), nil, fixed.Vec2{}, 0, 0)
	var cargo []uint32
	for i := 0; i < 3; i++ {
		cargo = append(cargo, passiveCargo(w, "rider",
			fixed.Vec2{X: fixed.FromInt(200 + 80*i), Z: fixed.FromInt(40 * i)}, 0))
	}
	for _, id := range cargo {
		w.ApplyOrder(order.Load([]uint32{tr}, id))
	}
	loaded := func() int {
		return len(w.UnitByID(tr).carrying)
	}
	for i := 0; i < 3000 && loaded() < 3; i++ {
		w.Step(nil)
	}
	if loaded() != 3 {
		t.Fatalf("transport loaded %d of 3", loaded())
	}

	drop := fixed.Vec2{X: fixed.FromInt(700), Z: fixed.FromInt(300)}
	w.ApplyOrder(order.Unload([]uint32{tr}, drop))
	for i := 0; i < 2000 && loaded() > 0; i++ {
		w.Step(nil)
	}
	if loaded() != 0 {
		t.Fatalf("transport still holds %d passengers after unload", loaded())
	}
	for _, id := range cargo {
		c := w.UnitByID(id)
		if c.carriedBy != 0 {
			t.Fatalf("passenger %d still marked carried", id)
		}
		if d := c.loco.Pos.DistTo(drop); d > fixed.FromInt(160) {
			t.Fatalf("passenger %d dropped %v wu from the site", id, d.Float())
		}
	}
}

// TestTransportSlotCap pins the capacity gate: a single-slot transport
// refuses a second pickup outright.
func TestTransportSlotCap(t *testing.T) {
	w := New(Config{Seed: 73})
	tr := w.AddUnit("atlas", transportMeta("atlas", 1, true), nil, fixed.Vec2{}, 0, 0)
	a := passiveCargo(w, "a", fixed.Vec2{X: fixed.FromInt(100)}, 0)
	b := passiveCargo(w, "b", fixed.Vec2{X: fixed.FromInt(160)}, 0)
	w.ApplyOrder(order.Load([]uint32{tr}, a))
	w.ApplyOrder(order.Load([]uint32{tr}, b))
	for i := 0; i < 1500; i++ {
		w.Step(nil)
	}
	if got := len(w.UnitByID(tr).carrying); got != 1 {
		t.Fatalf("single-slot transport carries %d", got)
	}
	if w.UnitByID(b).carriedBy != 0 {
		t.Fatalf("over-capacity pickup attached")
	}
}

// TestCarriedUnitUntargetable pins passenger immunity: damage routed at a
// carried unit is rejected, and auto-acquisition skips it.
func TestCarriedUnitUntargetable(t *testing.T) {
	w := New(Config{Seed: 74})
	tr := w.AddUnit("atlas", transportMeta("atlas", 1, true), nil, fixed.Vec2{}, 0, 0)
	cargo := passiveCargo(w, "peewee", fixed.Vec2{X: fixed.FromInt(60)}, 0)
	w.ApplyOrder(order.Load([]uint32{tr}, cargo))
	for i := 0; i < 800 && w.UnitByID(cargo).carriedBy == 0; i++ {
		w.Step(nil)
	}
	if w.UnitByID(cargo).carriedBy == 0 {
		t.Fatalf("cargo never attached")
	}
	if w.ApplyDamage(0, cargo, fixed.FromInt(50)) {
		t.Fatalf("damage landed on carried cargo")
	}
	if hp := w.UnitByID(cargo).Health; hp != fixed.FromInt(100) {
		t.Fatalf("carried cargo lost health: %v", hp.Float())
	}
}
