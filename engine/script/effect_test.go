package script

import (
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/frame"
	"github.com/coreprime/kbot/engine/sim"
	"github.com/coreprime/kbot/formats/scripting"
)

// TestEffectOpcodesSurfaceAsSnapshotEvents drives a unit whose Create script
// fires the three COB effect opcodes and confirms each surfaces in the render
// snapshot as a discrete event stamped with the unit id and its world anchor.
// These events are the data source the migrated sandbox's particle / audio
// layers consume in place of the in-process JS COB runtime.
func TestEffectOpcodesSurfaceAsSnapshotEvents(t *testing.T) {
	p := prog(twoPieces(), 0, ScriptSource{
		Name: "Create",
		Insts: []Instruction{
			i1(scripting.OP_PUSH_IMMEDIATE, 7), // emit-sfx type 7
			i1(scripting.OP_EMIT_SFX, 1),       // from piece 1
			i1(scripting.OP_PUSH_IMMEDIATE, 3), // explode sfx 3
			i1(scripting.OP_EXPLODE, 0),         // on piece 0
			i1(scripting.OP_PUSH_IMMEDIATE, 12), // sound id 12
			i1(scripting.OP_PLAY_SOUND, 64),     // at volume 64
		},
	})

	rt := NewRuntime(1)
	w := sim.New(sim.Config{Seed: 1})
	binding := rt.NewUnit(p, nil)
	at := fixed.Vec2{X: fixed.FromInt(50), Z: fixed.FromInt(-30)}
	id := w.AddUnit("fx", &sim.UnitMeta{Name: "fx"}, binding, at, 0, 0)

	w.Step(rt)
	snap := w.Snapshot()

	want := map[frame.EventKind]int{
		frame.EvEmitSfx:   7,
		frame.EvExplode:   3,
		frame.EvPlaySound: 12,
	}
	got := map[frame.EventKind]bool{}
	for _, ev := range snap.Events {
		exp, tracked := want[ev.Kind]
		if !tracked {
			continue
		}
		got[ev.Kind] = true
		if ev.SfxType != exp {
			t.Errorf("%v: SfxType = %d, want %d", ev.Kind, ev.SfxType, exp)
		}
		if ev.UnitID != id {
			t.Errorf("%v: UnitID = %d, want %d", ev.Kind, ev.UnitID, id)
		}
		if ev.Anchor.X != at.X || ev.Anchor.Z != at.Z {
			t.Errorf("%v: anchor = (%v,%v), want (%v,%v)",
				ev.Kind, ev.Anchor.X.Float(), ev.Anchor.Z.Float(), at.X.Float(), at.Z.Float())
		}
	}
	for kind := range want {
		if !got[kind] {
			t.Errorf("snapshot never carried a %v event", kind)
		}
	}
}

// TestEffectsDoNotPerturbHash guards that buffering and draining script effects
// stays render-only: two identically seeded runs whose units emit SFX must hash
// identically, since effects feed the snapshot but never the authoritative
// world state.
func TestEffectsDoNotPerturbHash(t *testing.T) {
	run := func() uint64 {
		p := prog(twoPieces(), 0, ScriptSource{
			Name: "Create",
			Insts: []Instruction{
				i1(scripting.OP_PUSH_IMMEDIATE, 7),
				i1(scripting.OP_EMIT_SFX, 1),
			},
		})
		rt := NewRuntime(5)
		w := sim.New(sim.Config{Seed: 5})
		w.AddUnit("fx", &sim.UnitMeta{Name: "fx"}, rt.NewUnit(p, nil), fixed.Vec2{}, 0, 0)
		for i := 0; i < 20; i++ {
			w.Step(rt)
		}
		return w.Hash()
	}
	if h1, h2 := run(), run(); h1 != h2 {
		t.Fatalf("effect emission perturbed the world hash: %x != %x", h1, h2)
	}
}
