package sim

import (
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/order"
)

func factoryMeta() *UnitMeta {
	m := testMeta("factory")
	m.CanMove = false
	m.IsBuilder = true
	setWorkerTime(m, 100)
	m.FootprintX = 6
	m.FootprintZ = 6
	return m
}

func factoryWorld() *World {
	spawn := func(name string) (*UnitMeta, Binding) {
		m := testMeta(name)
		// 400/floor(100/30)=400/3 ticks per unit; buildcostenergy 200 keeps
		// three sequential builds affordable from the 1000-energy opening
		// pool (this factory has no income).
		setBuildStats(m, 400, 200, 20)
		m.FootprintX = 2
		m.FootprintZ = 2
		m.CostMetal = fixed.FromInt(50)
		m.CostEnergy = fixed.FromInt(500)
		return m, nil
	}
	return New(Config{Seed: 41, Spawn: spawn})
}

// TestFactoryProducesWithTerrain is the regression for the recurring "factories
// don't build on real maps" bug. A factory's build order targets the factory's
// OWN position, where canBuildAt rejects the buildee (its footprint overlaps the
// factory itself). That legality probe is gated on w.terrain != nil, so it never
// fired on The Grid (where the bug was invisible) but rejected every factory
// order on a loaded map. The probe must apply only to mobile builders; with
// terrain installed a factory must still queue and produce.
func TestFactoryProducesWithTerrain(t *testing.T) {
	w := factoryWorld()
	w.SetTerrain(testTerrain(60, 60, 0, func(_, _ int) uint8 { return 0 }))
	pos := fixed.Vec2{X: fixed.FromInt(480), Z: fixed.FromInt(480)}
	fac := w.AddUnit("factory", factoryMeta(), nil, pos, 0, 0)
	w.ApplyOrder(order.Build(fac, "tank", pos, 0)) // order targets the factory's own position
	u := w.UnitByID(fac)
	if len(u.prodQueue) != 1 {
		t.Fatalf("factory on terrain refused its build order (queue=%d): canBuildAt rejected the own-position target", len(u.prodQueue))
	}
	produced := false
	for i := 0; i < 40*30 && !produced; i++ {
		w.Step(nil)
		w.ForEachUnit(func(b *Unit) {
			if b.ID != fac && b.BuildPercent >= fixed.FromInt(100) {
				produced = true
			}
		})
	}
	if !produced {
		t.Fatalf("factory on terrain never produced a unit (state=%d queue=%d)", u.buildState, len(u.prodQueue))
	}
}

// TestFactoryProducesQueueInOrder pins the production contract: repeat build
// orders queue (mixed types in click order), each unit raises on the pad at
// the buildtime/workertime pace, rolls off to clear ground on completion,
// and the queue drains to empty.
func TestFactoryProducesQueueInOrder(t *testing.T) {
	w := factoryWorld()
	fac := w.AddUnit("factory", factoryMeta(), nil, fixed.Vec2{}, 0, 0)
	w.ApplyOrder(order.Build(fac, "tank", fixed.Vec2{}, 0))
	w.ApplyOrder(order.Build(fac, "tank", fixed.Vec2{}, 0))
	w.ApplyOrder(order.Build(fac, "jeep", fixed.Vec2{}, 0))

	u := w.UnitByID(fac)
	if len(u.prodQueue) != 3 {
		t.Fatalf("queue should hold 3 entries, got %d", len(u.prodQueue))
	}
	for i := 0; i < 40*60 && (len(u.prodQueue) > 0 || u.buildState != buildIdle); i++ {
		w.Step(nil)
	}
	// All three orders completed: 4 units total (factory + 3), all at 100%.
	names := map[string]int{}
	w.ForEachUnit(func(b *Unit) {
		if b.ID == fac {
			return
		}
		if b.BuildPercent < fixed.FromInt(100) {
			t.Fatalf("unit %s never completed: %v%%", b.Name, b.BuildPercent.Float())
		}
		names[b.Name]++
	})
	if names["tank"] != 2 || names["jeep"] != 1 {
		t.Fatalf("wrong production mix: %v", names)
	}
	if len(u.prodQueue) != 0 || u.buildState != buildIdle {
		t.Fatalf("factory did not return to idle: queue=%d state=%d", len(u.prodQueue), u.buildState)
	}
	// Completed units rolled off: none still inside the factory's body, and
	// once settled no two occupy the same spot.
	for i := 0; i < 40*20; i++ {
		w.Step(nil)
	}
	var spots []fixed.Vec2
	w.ForEachUnit(func(b *Unit) {
		if b.ID == fac {
			return
		}
		if d := b.loco.Pos.DistTo(u.loco.Pos); d < u.Meta.collisionRadius() {
			t.Fatalf("%s never left the pad: dist %v", b.Name, d.Float())
		}
		spots = append(spots, b.loco.Pos)
	})
	for i := 0; i < len(spots); i++ {
		for j := i + 1; j < len(spots); j++ {
			if spots[i].DistTo(spots[j]) < fixed.FromInt(10) {
				t.Fatalf("rolloff stacked two units at the same spot")
			}
		}
	}
	// Resource drain accrued the full buildcost of the run: 3 units at
	// buildcostmetal 20 / buildcostenergy 200 each = 60 metal / 600 energy.
	// The applicator prorates the price linearly over the build, so a full
	// run posts exactly buildcost per axis (small f32 residue only).
	spent := w.resSpent[0]
	if spent.Metal < fixed.FromInt(59) || spent.Metal > fixed.FromInt(61) {
		t.Fatalf("metal drain off: %v (want ~60)", spent.Metal.Float())
	}
	if spent.Energy < fixed.FromInt(595) || spent.Energy > fixed.FromInt(605) {
		t.Fatalf("energy drain off: %v (want ~600)", spent.Energy.Float())
	}
}

// TestFactoryStopClearsQueue pins Stop semantics: the production run is
// abandoned along with the active raise.
func TestFactoryStopClearsQueue(t *testing.T) {
	w := factoryWorld()
	fac := w.AddUnit("factory", factoryMeta(), nil, fixed.Vec2{}, 0, 0)
	for i := 0; i < 4; i++ {
		w.ApplyOrder(order.Build(fac, "tank", fixed.Vec2{}, 0))
	}
	u := w.UnitByID(fac)
	for i := 0; i < 40 && u.buildState != buildRaising; i++ {
		w.Step(nil)
	}
	if u.buildState != buildRaising || len(u.prodQueue) != 3 {
		t.Fatalf("setup: state=%d queue=%d", u.buildState, len(u.prodQueue))
	}
	w.ApplyOrder(order.Stop([]uint32{fac}))
	if len(u.prodQueue) != 0 || u.buildState != buildIdle {
		t.Fatalf("stop did not clear production: queue=%d state=%d", len(u.prodQueue), u.buildState)
	}
}

// TestFactoryRallyOrders pins the initial-order chain: move and patrol
// waypoints ordered on a factory become every produced unit's starting
// queue — the move walks once, the patrol legs loop — while the factory's
// own template never drains.
func TestFactoryRallyOrders(t *testing.T) {
	w := factoryWorld()
	fac := w.AddUnit("factory", factoryMeta(), nil, fixed.Vec2{}, 0, 0)
	rally := fixed.Vec2{X: fixed.FromInt(200)}
	patrolA := fixed.Vec2{X: fixed.FromInt(200), Z: fixed.FromInt(150)}
	w.ApplyOrder(order.Move([]uint32{fac}, rally))
	w.ApplyOrder(order.Patrol([]uint32{fac}, patrolA))
	u := w.UnitByID(fac)
	if len(u.queue) != 2 {
		t.Fatalf("factory rally template should hold 2 entries, got %d", len(u.queue))
	}
	w.ApplyOrder(order.Build(fac, "tank", fixed.Vec2{}, 0))
	var tank *Unit
	for i := 0; i < 40*60 && tank == nil; i++ {
		w.Step(nil)
		w.ForEachUnit(func(b *Unit) {
			if b.Name == "tank" && b.BuildPercent >= fixed.FromInt(100) {
				tank = b
			}
		})
	}
	if tank == nil {
		t.Fatalf("tank never completed")
	}
	if len(tank.queue) != 2 {
		t.Fatalf("tank should inherit the 2-entry rally chain, got %d", len(tank.queue))
	}
	if len(u.queue) != 2 {
		t.Fatalf("factory template drained to %d entries", len(u.queue))
	}
	// The tank walks the chain: it reaches the rally point, then loops the
	// patrol leg indefinitely (curIsPatrol with the leg re-queued).
	reachedRally := false
	for i := 0; i < 40*60; i++ {
		w.Step(nil)
		if tank.loco.Pos.DistTo(rally) < fixed.FromInt(12) {
			reachedRally = true
		}
		if reachedRally && tank.curIsPatrol {
			return
		}
	}
	t.Fatalf("tank never walked the rally chain: reachedRally=%v curIsPatrol=%v pos=(%v,%v)",
		reachedRally, tank.curIsPatrol, tank.loco.Pos.X.Float(), tank.loco.Pos.Z.Float())
}
