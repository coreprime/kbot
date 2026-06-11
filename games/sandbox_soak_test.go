package games_test

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/order"
	"github.com/coreprime/kbot/engine/script"
	"github.com/coreprime/kbot/engine/sim"
	"github.com/coreprime/kbot/formats/gamedata/ta"
	"github.com/coreprime/kbot/formats/scripting"
	"github.com/coreprime/kbot/games"
)

// loadTAKUnit builds a (meta, binding) pair for a retail TA:K unit exactly
// the way the sandbox authority does: meta from the FBI's inline weapons,
// binding from the retail COB.
func loadTAKUnit(t *testing.T, rt *script.Runtime, root, name string) (*sim.UnitMeta, *script.Unit) {
	t.Helper()
	fbi, err := os.ReadFile(filepath.Join(root, "units", name+".fbi"))
	if err != nil {
		t.Skipf("unit %s: %v", name, err)
	}
	meta, err := games.UnitMetaFromFBI(name, fbi, func(string) (ta.Weapon, bool) { return ta.Weapon{}, false })
	if err != nil {
		t.Fatalf("%s meta: %v", name, err)
	}
	data, err := os.ReadFile(filepath.Join(root, "scripts", name+".cob"))
	if err != nil {
		t.Skipf("cob %s: %v", name, err)
	}
	cob, err := scripting.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("%s cob: %v", name, err)
	}
	prog, err := script.FromCOB(cob)
	if err != nil {
		t.Fatalf("%s prog: %v", name, err)
	}
	return meta, rt.NewUnit(prog, nil)
}

// TestTAKSandboxSoak replays a long sandbox-shaped session against retail
// TA:K units while polling every per-tick surface the browser polls
// (Snapshot for renderState, UnitCob for the Runtime panel) — the goal is to
// catch the panic that killed the wasm engine (exit code 2) in a session mix
// of melee combat, ranged force-fire, moves, and deaths.
func TestTAKSandboxSoak(t *testing.T) {
	root := os.Getenv("TAK_UNPACKED_PATH")
	if root == "" {
		t.Skip("set TAK_UNPACKED_PATH")
	}
	rt := script.NewRuntime(99)
	w := sim.New(sim.Config{Seed: 99})

	spawn := func(name string, x, z int, side int) uint32 {
		meta, bind := loadTAKUnit(t, rt, root, name)
		return w.AddUnit(name, meta, bind, fixed.Vec2{X: fixed.FromInt(x), Z: fixed.FromInt(z)}, 0, side)
	}
	k1 := spawn("arapal", 25, -19, 0)
	k2 := spawn("arapal", -31, 19, 1)
	a1 := spawn("araarch", 17, -14, 0)
	a2 := spawn("araarch", -57, 16, 1)

	poll := func() {
		w.Snapshot()
		for _, id := range []uint32{k1, k2, a1, a2} {
			w.UnitCob(id)
		}
	}
	run := func(n int) {
		for i := 0; i < n; i++ {
			w.Step(rt)
			poll()
		}
	}

	// Knights brawl while archers force-fire at a point, then everyone
	// moves, then attacks cross over — the first crash session's mix.
	w.ApplyOrder(order.Attack([]uint32{k1}, k2))
	w.ApplyOrder(order.Attack([]uint32{k2}, k1))
	w.ApplyOrder(order.FireAtPoint(a1, 0, fixed.Vec2{X: fixed.FromInt(-52), Z: fixed.FromInt(45)}))
	w.ApplyOrder(order.FireAtPoint(a2, 0, fixed.Vec2{X: fixed.FromInt(-52), Z: fixed.FromInt(45)}))
	run(900)
	w.ApplyOrder(order.Move([]uint32{a1, a2}, fixed.Vec2{X: fixed.FromInt(-20), Z: fixed.FromInt(30)}))
	run(600)
	w.ApplyOrder(order.Attack([]uint32{a1}, a2))
	w.ApplyOrder(order.Attack([]uint32{a2}, a1))
	run(3000)

	alive := 0
	for _, id := range []uint32{k1, k2, a1, a2} {
		if u := w.UnitByID(id); u != nil && !u.Dead {
			alive++
		}
	}
	t.Logf("soak done: %d/4 still alive after the brawl", alive)
	if alive == 4 {
		t.Error("nobody died in 4500 ticks of mutual combat — combat is not resolving")
	}
}
