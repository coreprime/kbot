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
