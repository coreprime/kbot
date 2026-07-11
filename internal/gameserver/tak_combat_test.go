package gameserver

import (
	"os"
	"testing"

	"github.com/coreprime/kbot-engine/engine/fixed"
	"github.com/coreprime/kbot-engine/engine/frame"
	"github.com/coreprime/kbot-engine/engine/order"
	"github.com/coreprime/kbot-engine/engine/script"
	"github.com/coreprime/kbot-engine/engine/sim"
)

// takBoundSpawn wires the authority's spawn pipeline at a TA:K install —
// the same FBI + inline-weapon + COB path a hosted TA:K match runs.
func takBoundSpawn(t *testing.T, seed uint32) (*script.Runtime, *sim.World) {
	t.Helper()
	root := os.Getenv("TAK_UNPACKED_PATH")
	if root == "" {
		t.Skip("TAK_UNPACKED_PATH not set")
	}
	spawn := FBISpawnFunc(root)
	cob := FBICobSource(root)
	rt := script.NewRuntime(seed)
	programs := map[string]*script.Program{}
	bound := func(name string) (*sim.UnitMeta, sim.Binding) {
		meta, _ := spawn(name)
		if meta == nil {
			return nil, nil
		}
		prog, ok := programs[name]
		if !ok {
			var b []byte
			if cob != nil {
				b, _ = cob(name)
			}
			prog = compileCOB(b)
			programs[name] = prog
		}
		if prog == nil {
			return meta, nil
		}
		return meta, rt.NewUnit(prog, nil)
	}
	return rt, sim.New(sim.Config{Seed: seed, Spawn: bound})
}

// TestTAKRealArcherCombat drives two retail TA:K archers (real FBI with
// inline weapons + v6 COB) through the full authority pipeline — the server
// half of a hosted TA:K match — and requires an actual kill plus the TA:K
// corpse convention on the way out.
func TestTAKRealArcherCombat(t *testing.T) {
	rt, w := takBoundSpawn(t, 19)
	w.ApplyOrder(order.Order{Kind: order.KindSpawn, Name: "araarch", SpawnAt: fixed.Vec2{}, Side: 0})
	w.ApplyOrder(order.Order{Kind: order.KindSpawn, Name: "araarch", SpawnAt: fixed.Vec2{X: fixed.FromInt(60)}, Side: 1})
	w.ApplyOrder(order.Attack([]uint32{1}, 2))

	var fires, hits int
	corpseSlot := -1
	died := -1
	for i := 0; i < 6000 && corpseSlot < 0; i++ {
		w.Step(rt)
		for _, ev := range w.Snapshot().Events {
			switch ev.Kind {
			case frame.EvFire:
				fires++
			case frame.EvHit:
				hits++
			case frame.EvCorpseSpawn:
				corpseSlot = ev.Slot
			}
		}
		if died < 0 && w.UnitByID(2) != nil && w.UnitByID(2).Dead {
			died = i
		}
	}
	t.Logf("fires=%d hits=%d diedAt=%d corpseSlot=%d", fires, hits, died, corpseSlot)
	if died < 0 {
		t.Fatal("defender survived 6000 ticks of authority-side TA:K combat")
	}
	if corpseSlot != 1 {
		t.Fatalf("corpse slot = %d, want 1 (TA:K corpsetype convention)", corpseSlot)
	}
	if fires == 0 || hits == 0 {
		t.Fatalf("combat produced fires=%d hits=%d", fires, hits)
	}
}
