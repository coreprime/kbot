package sim

import (
	"bytes"
	"os"
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/order"
	"github.com/coreprime/kbot/engine/script"
	"github.com/coreprime/kbot/formats/scripting"
)

func loadCobUnit(t *testing.T, rt *script.Runtime, file string) *script.Unit {
	t.Helper()
	path := os.Getenv("TA_UNPACKED_PATH") + "/scripts/" + file
	data, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("no cob %s: %v", file, err)
	}
	cob, err := scripting.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("parse %s: %v", file, err)
	}
	prog, err := script.FromCOB(cob)
	if err != nil {
		t.Fatalf("compile %s: %v", file, err)
	}
	return rt.NewUnit(prog, nil)
}

// TestFactoryRealCobProduces drives the real ARMLAB factory COB — the
// Activate/OpenYard/YARD_OPEN gate the studio path actually exercises — to
// prove a queued unit raises and completes, not just the script-less fast path.
func TestFactoryRealCobProduces(t *testing.T) {
	rt := script.NewRuntime(41)

	spawn := func(name string) (*UnitMeta, Binding) {
		m := testMeta(name)
		m.CanMove = true
		setBuildStats(m, 200, 50, 50)
		m.FootprintX = 2
		m.FootprintZ = 2
		m.CostMetal = fixed.FromInt(50)
		m.CostEnergy = fixed.FromInt(50)
		return m, loadCobUnit(t, rt, "ARMPW.cob") // a simple k-bot buildee
	}
	w := New(Config{Seed: 41, Spawn: spawn})

	fm := testMeta("armlab")
	fm.CanMove = false
	fm.IsBuilder = true
	setWorkerTime(fm, 200)
	fm.FootprintX = 6
	fm.FootprintZ = 6
	fac := w.AddUnit("armlab", fm, loadCobUnit(t, rt, "ARMLAB.cob"), fixed.Vec2{}, 0, 0)

	w.ApplyOrder(order.Build(fac, "armpw", fixed.Vec2{}, 0))
	u := w.UnitByID(fac)
	if len(u.prodQueue) != 1 {
		t.Fatalf("expected 1 queued, got %d", len(u.prodQueue))
	}

	produced := 0
	for i := 0; i < 40*30; i++ { // 30s
		w.Step(rt)
		w.ForEachUnit(func(b *Unit) {
			if b.ID != fac && b.BuildPercent >= fixed.FromInt(100) {
				produced++
			}
		})
		if produced > 0 {
			t.Logf("buildee completed at tick %d (%.1fs); facState=%d yardOpen=%d",
				i, float64(i)/40, u.buildState, w.UnitValuePort(fac, cobPortYardOpen))
			return
		}
	}
	t.Fatalf("factory never produced: state=%d queue=%d yardOpen=%d buildee=%v",
		u.buildState, len(u.prodQueue), w.UnitValuePort(fac, cobPortYardOpen), u.buildeeID)
}

// TestFactoryBuildeeRidesPad pins the build-plate parenting: while a real
// ARMLAB raises a unit, StartBuilding spins the pad (QueryBuildInfo piece), so
// the buildee's authoritative heading must advance with the plate. And when it
// completes it must not jump — the position it starts rolling off from is the
// one it held on the last raising tick, not a fresh static site.
func TestFactoryBuildeeRidesPad(t *testing.T) {
	rt := script.NewRuntime(41)
	spawn := func(name string) (*UnitMeta, Binding) {
		m := testMeta(name)
		m.CanMove = true
		setBuildStats(m, 200, 50, 50)
		m.FootprintX = 2
		m.FootprintZ = 2
		m.CostMetal = fixed.FromInt(50)
		m.CostEnergy = fixed.FromInt(50)
		return m, loadCobUnit(t, rt, "ARMPW.cob")
	}
	w := New(Config{Seed: 41, Spawn: spawn})

	fm := testMeta("armlab")
	fm.CanMove = false
	fm.IsBuilder = true
	setWorkerTime(fm, 200)
	fm.FootprintX = 6
	fm.FootprintZ = 6
	// The real ARMLAB yardmap: an openable exit channel down the middle two
	// columns, so a finished unit standing on the pad walks out the open
	// channel instead of being ejected through solid cells.
	fm.Yard = ParseYardMap("yoccoy ooccoo ooccoo ooccoo ooccoo yoccoy", 6, 6)
	fac := w.AddUnit("armlab", fm, loadCobUnit(t, rt, "ARMLAB.cob"), fixed.Vec2{}, 0, 0)
	w.ApplyOrder(order.Build(fac, "armpw", fixed.Vec2{}, 0))
	u := w.UnitByID(fac)

	var headings []int32
	var lastRaisePos fixed.Vec2
	var haveRaisePos bool
	var completed bool
	var rolloffStart fixed.Vec2
	for i := 0; i < 40*30; i++ {
		w.Step(rt)
		b := w.UnitByID(u.buildeeID)
		if b != nil && u.buildState == buildRaising {
			headings = append(headings, b.Heading())
			lastRaisePos = b.loco.Pos
			haveRaisePos = true
		}
		// The first frame after the raise finishes: capture where the finished
		// unit begins its rolloff and compare to the last raising position.
		w.ForEachUnit(func(x *Unit) {
			if x.ID != fac && x.BuildPercent >= fixed.FromInt(100) && !completed {
				completed = true
				rolloffStart = x.loco.Pos
			}
		})
		if completed {
			break
		}
	}
	if !completed {
		t.Fatalf("buildee never completed (state=%d)", u.buildState)
	}
	if !haveRaisePos {
		t.Fatalf("never observed the buildee raising")
	}
	// The pad spun: distinct headings appeared across the raise.
	distinct := map[int32]bool{}
	for _, h := range headings {
		distinct[h] = true
	}
	if len(distinct) < 2 {
		t.Fatalf("buildee heading never changed while raising — pad spin not applied (%d samples)", len(headings))
	}
	// No teleport: the rolloff starts within a hair of the last raising pose,
	// not at a fresh static site far from it.
	if d := rolloffStart.DistTo(lastRaisePos); d > fixed.FromInt(4) {
		t.Fatalf("buildee teleported on completion: %v wu from its last raising pos", d.Float())
	}
}
