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

// TestTARealPeeweeCombat drives two retail Peewees (real FBI + weapon TDF +
// COB) through the full authority pipeline and requires an actual kill —
// the integration guard that combat works against shipped game data.
func TestTARealPeeweeCombat(t *testing.T) {
	root := os.Getenv("TA_UNPACKED_PATH")
	if root == "" {
		t.Skip("TA_UNPACKED_PATH not set")
	}
	spawn := FBISpawnFunc(root)
	cob := FBICobSource(root)
	rt := script.NewRuntime(7)
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
	w := sim.New(sim.Config{Seed: 7, Spawn: bound})
	w.ApplyOrder(order.Order{Kind: order.KindSpawn, Name: "armpw", SpawnAt: fixed.Vec2{}, Side: 0})
	w.ApplyOrder(order.Order{Kind: order.KindSpawn, Name: "armpw", SpawnAt: fixed.Vec2{X: fixed.FromInt(80)}, Side: 1})
	w.ApplyOrder(order.Attack([]uint32{1}, 2))
	meta, _ := spawn("armpw")
	t.Logf("weapon0: %+v", meta.Weapons[0])
	t.Logf("maxHealth: %v", meta.MaxHealth.Float())
	var died, fires, hits int
	for i := 0; i < 4000; i++ {
		w.Step(rt)
		for _, ev := range w.Snapshot().Events {
			switch ev.Kind {
			case 3: // EvFire
				fires++
			case 4: // EvHit
				hits++
			}
		}
		if w.UnitByID(2) != nil && w.UnitByID(2).Dead {
			died = i
			break
		}
	}
	t.Logf("fires=%d hits=%d", fires, hits)
	def := w.UnitByID(2)
	t.Logf("tick=%d defender health=%v dead=%v", died, def.Health.Float(), def.Dead)
	if !def.Dead {
		t.Fatalf("defender survived 4000 ticks at health %v", def.Health.Float())
	}
}

// TestTARealPeeweeForceFire mirrors the sandbox Controls panel's Primary
// force-fire: a KindFire order at a unit, with the full retail COB running.
func TestTARealPeeweeForceFire(t *testing.T) {
	root := os.Getenv("TA_UNPACKED_PATH")
	if root == "" {
		t.Skip("TA_UNPACKED_PATH not set")
	}
	spawn := FBISpawnFunc(root)
	cob := FBICobSource(root)
	rt := script.NewRuntime(11)
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
	w := sim.New(sim.Config{Seed: 11, Spawn: bound})
	w.ApplyOrder(order.Order{Kind: order.KindSpawn, Name: "armpw", SpawnAt: fixed.Vec2{}, Side: 0})
	w.ApplyOrder(order.Order{Kind: order.KindSpawn, Name: "armpw", SpawnAt: fixed.Vec2{X: fixed.FromInt(35), Z: fixed.FromInt(20)}, Side: 1})
	w.ApplyOrder(order.FireAtUnit(1, 0, 2))
	corpseType := -1
	for i := 0; i < 4200; i++ {
		w.Step(rt)
		for _, ev := range w.Snapshot().Events {
			if ev.Kind == frame.EvCorpseSpawn && ev.UnitID == 2 {
				corpseType = ev.Slot
			}
		}
		if w.UnitByID(2).Dead && corpseType >= 0 {
			break
		}
	}
	def := w.UnitByID(2)
	t.Logf("defender health=%v dead=%v corpseType=%d", def.Health.Float(), def.Dead, corpseType)
	if !def.Dead {
		t.Fatalf("force-fired defender survived at health %v", def.Health.Float())
	}
	// A clean EMG kill (severity ~3%) must leave the intact corpse.
	if corpseType != 1 {
		t.Fatalf("corpseType = %d, want 1 (intact corpse)", corpseType)
	}
}
