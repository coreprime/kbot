package sim

import (
	"fmt"
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/order"
	"github.com/coreprime/kbot/engine/script"
)

// TestMobileBuilderSequentialStructures drives the real ARM construction kbot
// COB through a queue of several cheap structures placed at spaced sites and
// asserts EVERY one completes. It reproduces (and guards against) the parity
// stall where construction progress was gated on the COB writing INBUILDSTANCE
// back: the arm's RequestState machine strands its re-entrancy latch when a
// StopBuilding thread is superseded before it clears, freezing INBUILDSTANCE at
// 0 so every other queued job never leaves 0%. Economy is oversupplied so a
// stall can only come from the build handshake, never resources.
func TestMobileBuilderSequentialStructures(t *testing.T) {
	rt := script.NewRuntime(7)

	// Buildees are cheap script-driven structures (a real solar collector COB)
	// so completion also runs the ActivateWhenBuilt path.
	spawn := func(name string) (*UnitMeta, Binding) {
		m := testMeta(name)
		m.CanMove = false
		m.IsBuilder = false
		setBuildStats(m, 60, 20, 20)
		m.FootprintX = 2
		m.FootprintZ = 2
		return m, loadCobUnit(t, rt, "ARMSOLAR.cob")
	}
	w := New(Config{Seed: 7, Spawn: spawn, StartMetal: 100000, StartEnergy: 100000})

	bm := testMeta("armck")
	bm.CanMove = true
	bm.IsBuilder = true
	setWorkerTime(bm, 300)
	bm.BuildDistance = fixed.FromInt(80)
	bm.MaxVelocity = fixed.FromFloat(1.5)
	bld := w.AddUnit("armck", bm, loadCobUnit(t, rt, "armck.cob"), fixed.Vec2{}, 0, 0)

	// Four sites spaced out along +X so the builder walks between each and the
	// StartBuilding/StopBuilding transitions fully cycle per job.
	sites := []fixed.Vec2{
		{X: fixed.FromInt(160)},
		{X: fixed.FromInt(320)},
		{X: fixed.FromInt(480)},
		{X: fixed.FromInt(640)},
	}
	names := []string{"armsolar_a", "armsolar_b", "armsolar_c", "armsolar_d"}
	for i, s := range sites {
		w.ApplyOrder(order.BuildQueued(bld, names[i], s, 0))
	}

	completed := map[uint32]bool{}
	const maxTicks = 40 * 90 // 90s ceiling
	for i := 0; i < maxTicks; i++ {
		w.Step(rt)
		w.ForEachUnit(func(b *Unit) {
			if b.ID != bld && b.BuildPercent >= fixed.FromInt(100) {
				completed[b.ID] = true
			}
		})
		u := w.UnitByID(bld)
		if len(completed) >= len(sites) && u.buildState == buildIdle && len(u.queue) == 0 {
			break
		}
	}

	if len(completed) != len(sites) {
		u := w.UnitByID(bld)
		var dump string
		w.ForEachUnit(func(b *Unit) {
			if b.ID == bld {
				return
			}
			dump += fmt.Sprintf("\n  %s pct=%.1f underConstruction=%v",
				b.Name, b.BuildPercent.Float(), b.underConstruction())
		})
		t.Fatalf("only %d/%d structures completed; builderState=%d inBuildStance=%d%s",
			len(completed), len(sites), u.buildState,
			w.UnitValuePort(bld, cobPortInBuildStance), dump)
	}
}
