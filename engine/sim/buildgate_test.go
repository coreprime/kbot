package sim

import (
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/order"
)

// portedBinding is a recordingBinding that also exposes the COB unit-value
// port surface, so tests can play the script side of the build-readiness
// handshake (YARD_OPEN, INBUILDSTANCE).
type portedBinding struct {
	recordingBinding
	ports map[int]int32
}

func (b *portedBinding) SetUnitValuePort(port int, v int32) {
	if b.ports == nil {
		b.ports = map[int]int32{}
	}
	b.ports[port] = v
}
func (b *portedBinding) UnitValuePort(port int) int32 { return b.ports[port] }

// TestFactoryActivateGatesPad pins the door handshake: a factory with an
// Activate script starts it when production begins, holds the pad until the
// script reports YARD_OPEN, then raises the buildee; Deactivate runs when
// the line drains.
func TestFactoryActivateGatesPad(t *testing.T) {
	w := factoryWorld()
	bind := &portedBinding{recordingBinding: recordingBinding{
		scripts: map[string]bool{"Activate": true, "Deactivate": true},
	}}
	fac := w.AddUnit("factory", factoryMeta(), bind, fixed.Vec2{}, 0, 0)
	w.ApplyOrder(order.Build(fac, "tank", fixed.Vec2{}))
	u := w.UnitByID(fac)

	w.Step(nil)
	if countCalls(bind.starts, "Activate") != 1 {
		t.Fatalf("Activate not started when production began")
	}
	if u.buildState != buildOpening {
		t.Fatalf("factory should wait in buildOpening, state=%d", u.buildState)
	}
	// Doors still closed: the pad must not raise.
	for i := 0; i < 10; i++ {
		w.Step(nil)
	}
	if u.buildState != buildOpening {
		t.Fatalf("pad raised before YARD_OPEN, state=%d", u.buildState)
	}
	// Script finishes the door cycle.
	bind.SetUnitValuePort(cobPortYardOpen, 1)
	w.Step(nil)
	if u.buildState != buildRaising {
		t.Fatalf("pad did not raise after YARD_OPEN, state=%d", u.buildState)
	}
	bind.SetUnitValuePort(cobPortYardOpen, 0)
	for i := 0; i < 40*60 && u.buildState != buildIdle; i++ {
		w.Step(nil)
	}
	if countCalls(bind.starts, "Deactivate") != 1 {
		t.Fatalf("Deactivate not started when the line drained (calls=%d)",
			countCalls(bind.starts, "Deactivate"))
	}
}

// TestFactoryGateGraceTimeout pins the wedge guard: a script that never
// reports YARD_OPEN delays the pad only for the grace window.
func TestFactoryGateGraceTimeout(t *testing.T) {
	w := factoryWorld()
	bind := &portedBinding{recordingBinding: recordingBinding{
		scripts: map[string]bool{"Activate": true},
	}}
	fac := w.AddUnit("factory", factoryMeta(), bind, fixed.Vec2{}, 0, 0)
	w.ApplyOrder(order.Build(fac, "tank", fixed.Vec2{}))
	u := w.UnitByID(fac)
	for i := 0; i < TickHz*4 && u.buildState != buildRaising; i++ {
		w.Step(nil)
	}
	if u.buildState != buildRaising {
		t.Fatalf("grace deadline never released the pad, state=%d", u.buildState)
	}
}

// TestBuilderWaitsForBuildStance pins the nano-arm handshake: a mobile
// builder with a StartBuilding script makes no progress until the script
// sets INBUILDSTANCE.
func TestBuilderWaitsForBuildStance(t *testing.T) {
	spawn := func(name string) (*UnitMeta, Binding) {
		m := testMeta(name)
		m.BuildTime = fixed.FromInt(100)
		return m, nil
	}
	w := New(Config{Seed: 91, Spawn: spawn})
	bind := &portedBinding{recordingBinding: recordingBinding{
		scripts: map[string]bool{"StartBuilding": true},
	}}
	bm := testMeta("builder")
	bm.IsBuilder = true
	bm.WorkerTime = 100
	bm.BuildDistance = fixed.FromInt(60)
	bld := w.AddUnit("builder", bm, bind, fixed.Vec2{}, 0, 0)
	w.ApplyOrder(order.Build(bld, "hut", fixed.Vec2{X: fixed.FromInt(40)}))
	u := w.UnitByID(bld)
	for i := 0; i < 60 && u.buildState != buildRaising; i++ {
		w.Step(nil)
	}
	if u.buildState != buildRaising {
		t.Fatalf("builder never reached its site, state=%d", u.buildState)
	}
	if countCalls(bind.starts, "StartBuilding") != 1 {
		t.Fatalf("StartBuilding not driven")
	}
	b := w.UnitByID(u.buildeeID)
	pct := b.BuildPercent
	for i := 0; i < 10; i++ {
		w.Step(nil)
	}
	if b.BuildPercent != pct {
		t.Fatalf("build progressed before INBUILDSTANCE: %v -> %v",
			pct.Float(), b.BuildPercent.Float())
	}
	bind.SetUnitValuePort(cobPortInBuildStance, 1)
	for i := 0; i < 10; i++ {
		w.Step(nil)
	}
	if b.BuildPercent <= pct {
		t.Fatalf("build did not progress after INBUILDSTANCE")
	}
}
