package session_test

import (
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/script"
	"github.com/coreprime/kbot/engine/session"
	"github.com/coreprime/kbot/engine/sim"
	"github.com/coreprime/kbot/formats/scripting"
)

// spinProgram compiles a one-piece program whose Create entry point spins piece
// 0 about its first axis forever. AddUnit auto-starts "Create", so a unit bound
// to this program animates with no orders — the minimal signal that the script
// VM is driving piece transforms through the session.
func spinProgram() *script.Program {
	return script.NewProgram([]string{"body"}, 0, []script.ScriptSource{{
		Name: "Create",
		Insts: []script.Instruction{
			{Op: scripting.OP_PUSH_IMMEDIATE, P1: 40, Offset: 0}, // 40 angle-units/sec
			{Op: scripting.OP_SPIN, P1: 0, P2: 0, Offset: 1},     // piece 0, axis 0
		},
	}})
}

// spinnerWorld builds a world holding a single script-bound spinner and the
// session that drives it. The runtime is returned so callers can confirm the
// session, not the test, advances script time.
func spinnerWorld(seed uint32) *session.Session {
	rt := script.NewRuntime(seed)
	w := sim.New(sim.Config{Seed: seed})
	binding := rt.NewUnit(spinProgram(), nil)
	w.AddUnit("spinner", &sim.UnitMeta{Name: "spinner"}, binding, fixed.Vec2{}, 0, 0)
	return session.New(session.Config{World: w, Runtime: rt})
}

// TestCOBSeamAnimatesPieces is the Phase 0b guard: a script binding handed to a
// session must produce advancing piece rotations in the render snapshot, with no
// orders and no manual runtime ticking. This is the seam the wasm bridge wires.
func TestCOBSeamAnimatesPieces(t *testing.T) {
	s := spinnerWorld(1)

	// The Create thread arms the spin animator on tick 1, but animators advance
	// before threads run, so no rotation has accrued after the first step.
	snap := s.Step()
	if len(snap.Units) != 1 {
		t.Fatalf("units = %d, want 1", len(snap.Units))
	}
	if got := len(snap.Units[0].Pieces); got != 1 {
		t.Fatalf("pieces = %d, want 1", got)
	}
	if got := snap.Units[0].Pieces[0].Rot[0]; got != 0 {
		t.Fatalf("rot after step 1 = %d, want 0", got)
	}
	if !snap.Units[0].Pieces[0].Visible {
		t.Fatal("piece should default visible")
	}

	// Each subsequent step advances the rotation by speed/40 = 1 angle-unit, so
	// the snapshot reflects script-driven animation accrued through the session.
	var prev int32
	for i := 2; i <= 6; i++ {
		snap = s.Step()
		got := snap.Units[0].Pieces[0].Rot[0]
		if got <= prev && i > 2 {
			t.Fatalf("rot not advancing: step %d gave %d, prev %d", i, got, prev)
		}
		prev = got
	}
	if prev == 0 {
		t.Fatal("rotation never advanced through the session")
	}
}

// TestCOBSeamDeterministic guards the lockstep property at the seam: two
// identically seeded sessions must produce bit-identical piece transforms after
// the same number of steps, so a client predicting locally stays in step with a
// server running the same script. The world hash intentionally omits script
// state, so determinism is asserted on the piece poses directly.
func TestCOBSeamDeterministic(t *testing.T) {
	a := spinnerWorld(7)
	b := spinnerWorld(7)
	for i := 0; i < 50; i++ {
		sa := a.Step()
		sb := b.Step()
		ra := sa.Units[0].Pieces[0].Rot
		rb := sb.Units[0].Pieces[0].Rot
		if ra != rb {
			t.Fatalf("step %d diverged: %v != %v", i, ra, rb)
		}
	}
}
