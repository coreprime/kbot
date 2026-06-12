package sim

import (
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/order"
)

func builderMeta() *UnitMeta {
	m := testMeta("builder")
	m.IsBuilder = true
	m.WorkerTime = 200
	m.BuildDistance = fixed.FromInt(60)
	return m
}

func buildWorld() *World {
	spawn := func(name string) (*UnitMeta, Binding) {
		m := testMeta(name)
		m.BuildTime = fixed.FromInt(800) // 800/200 = 4s at the builder's pace
		return m, nil
	}
	return New(Config{Seed: 11, Spawn: spawn})
}

// TestBuildCycleRaisesUnit pins the mobile-builder contract: the builder
// walks into builddistance of the site, the buildee appears at 0% and rises
// to 100% at the buildtime/workertime pace, and only then takes orders.
func TestBuildCycleRaisesUnit(t *testing.T) {
	w := buildWorld()
	bld := w.AddUnit("builder", builderMeta(), nil, fixed.Vec2{}, 0, 0)
	site := fixed.Vec2{X: fixed.FromInt(300)}
	w.ApplyOrder(order.Build(bld, "armpw", site))

	u := w.UnitByID(bld)
	var buildee *Unit
	spawnedAt := -1
	for i := 0; i < 4000; i++ {
		w.Step(nil)
		if buildee == nil && u.buildeeID != 0 {
			buildee = w.UnitByID(u.buildeeID)
			spawnedAt = i
			// The buildee must appear within builddistance of the builder and
			// start at zero percent, inert.
			if d := u.loco.Pos.DistTo(buildee.loco.Pos); d > fixed.FromInt(70) {
				t.Fatalf("buildee spawned out of build range: %v", d.Float())
			}
			if buildee.BuildPercent >= fixed.FromInt(5) {
				t.Fatalf("buildee did not start near 0%%: %v", buildee.BuildPercent.Float())
			}
			// Orders must bounce off an under-construction unit.
			w.ApplyOrder(order.Move([]uint32{buildee.ID}, fixed.Vec2{Z: fixed.FromInt(500)}))
			if buildee.hasMove {
				t.Fatalf("under-construction buildee accepted a move order")
			}
		}
		if buildee != nil && buildee.BuildPercent >= fixed.FromInt(100) {
			break
		}
	}
	if buildee == nil {
		t.Fatalf("buildee never spawned; builder at (%v,%v) state=%d",
			u.loco.Pos.X.Float(), u.loco.Pos.Z.Float(), u.buildState)
	}
	if buildee.BuildPercent < fixed.FromInt(100) {
		t.Fatalf("build never completed: %v%%", buildee.BuildPercent.Float())
	}
	// 4s at 40 Hz = 160 ticks; allow slack but reject instant or runaway.
	doneAt := int(w.Tick())
	dur := doneAt - spawnedAt
	if dur < 100 || dur > 300 {
		t.Fatalf("build pace off: took %d ticks (want ~160)", dur)
	}
	if u.buildState != buildIdle {
		t.Fatalf("builder did not return to idle")
	}
	// Complete unit takes orders again.
	w.ApplyOrder(order.Move([]uint32{buildee.ID}, fixed.Vec2{Z: fixed.FromInt(200)}))
	if !buildee.hasMove {
		t.Fatalf("completed buildee rejected a move order")
	}
}

// TestBuildCancelledByStop pins the abandon path: Stop mid-raise retracts the
// builder's job and leaves the partial buildee inert where it stands.
func TestBuildCancelledByStop(t *testing.T) {
	w := buildWorld()
	bld := w.AddUnit("builder", builderMeta(), nil, fixed.Vec2{}, 0, 0)
	w.ApplyOrder(order.Build(bld, "armpw", fixed.Vec2{X: fixed.FromInt(40)}))
	u := w.UnitByID(bld)
	for i := 0; i < 200 && u.buildState != buildRaising; i++ {
		w.Step(nil)
	}
	if u.buildState != buildRaising {
		t.Fatalf("build never started raising")
	}
	b := w.UnitByID(u.buildeeID)
	w.ApplyOrder(order.Stop([]uint32{bld}))
	if u.buildState != buildIdle {
		t.Fatalf("stop did not cancel the build job")
	}
	pct := b.BuildPercent
	for i := 0; i < 100; i++ {
		w.Step(nil)
	}
	if b.BuildPercent != pct {
		t.Fatalf("abandoned buildee kept rising: %v -> %v", pct.Float(), b.BuildPercent.Float())
	}
}
