package script

import (
	"testing"

	"github.com/coreprime/kbot/engine/sim"
	"github.com/coreprime/kbot/formats/scripting"
)

// The VM must plug into the world through sim's structural interfaces without
// sim importing this package. These assertions fail at compile time if the
// method sets ever drift.
var (
	_ sim.Runtime = (*Runtime)(nil)
	_ sim.Binding = (*Unit)(nil)
)

// i0/i1/i2 build instructions with zero/one/two inline operands.
func i0(op uint32) Instruction           { return Instruction{Op: op} }
func i1(op uint32, p1 int32) Instruction { return Instruction{Op: op, P1: p1} }
func i2(op uint32, p1, p2 int32) Instruction {
	return Instruction{Op: op, P1: p1, P2: p2}
}

// prog assembles a Program, tagging each instruction's Offset with its index so
// JUMP operands written as instruction indices resolve through offsetIdx.
func prog(pieceNames []string, numStatic int, scripts ...ScriptSource) *Program {
	for si := range scripts {
		for i := range scripts[si].Insts {
			scripts[si].Insts[i].Offset = uint32(i)
		}
	}
	return NewProgram(pieceNames, numStatic, scripts)
}

func twoPieces() []string { return []string{"base", "turret"} }

// countThreads reports live threads whose script name matches.
func (u *Unit) countScript(name string) int {
	idx, ok := u.prog.ScriptIndex(name)
	if !ok {
		return 0
	}
	n := 0
	for _, t := range u.threads {
		if !t.dead && t.scriptIndex == idx {
			n++
		}
	}
	return n
}

func TestSpinAdvancesPerTick(t *testing.T) {
	p := prog(twoPieces(), 0, ScriptSource{
		Name: "Go",
		Insts: []Instruction{
			i1(scripting.OP_PUSH_IMMEDIATE, 40), // speed = 40 angle-units/sec
			i2(scripting.OP_SPIN, 0, 0),         // piece 0, axis 0
		},
	})
	rt := NewRuntime(1)
	u := rt.NewUnit(p, nil)
	u.Start("Go")

	// Tick 1 runs the script (animator armed) but animators advance *before*
	// threads run, so no rotation has accrued yet.
	rt.Tick(25)
	if got := u.rotValue(0, 0); got != 0 {
		t.Fatalf("after tick 1: rot = %d, want 0", got)
	}
	// Each subsequent tick advances by speed/40 = 1 angle-unit.
	rt.Tick(50)
	if got := u.rotValue(0, 0); got != 1 {
		t.Fatalf("after tick 2: rot = %d, want 1", got)
	}
	rt.Tick(75)
	if got := u.rotValue(0, 0); got != 2 {
		t.Fatalf("after tick 3: rot = %d, want 2", got)
	}
}

func TestTurnReachesTargetThenDone(t *testing.T) {
	// TURN pops target then speed, so push speed first.
	p := prog(twoPieces(), 0, ScriptSource{
		Name: "Aim",
		Insts: []Instruction{
			i1(scripting.OP_PUSH_IMMEDIATE, 40000), // speed -> 1000/tick
			i1(scripting.OP_PUSH_IMMEDIATE, 1000),  // target
			i2(scripting.OP_TURN, 1, 1),            // piece 1, axis 1
		},
	})
	rt := NewRuntime(1)
	u := rt.NewUnit(p, nil)
	u.Start("Aim")

	rt.Tick(25) // arms the turn
	if a := u.rotAnim(1, 1); a == nil || a.done {
		t.Fatalf("turn should be in progress after arming")
	}
	rt.Tick(50) // one step: delta 1000 <= step 1000, snaps to target
	if got := u.rotValue(1, 1); got != 1000 {
		t.Fatalf("turn value = %d, want 1000", got)
	}
	if a := u.rotAnim(1, 1); a == nil || !a.done {
		t.Fatalf("turn should be done after reaching target")
	}
}

func TestSleepDelaysSubsequentOps(t *testing.T) {
	// HIDE immediately, sleep 50ms, then SHOW. The piece stays hidden until the
	// sleep elapses (two 25ms ticks).
	p := prog(twoPieces(), 0, ScriptSource{
		Name: "Blink",
		Insts: []Instruction{
			i1(scripting.OP_HIDE, 0),
			i1(scripting.OP_PUSH_IMMEDIATE, 50),
			i0(scripting.OP_SLEEP),
			i1(scripting.OP_SHOW, 0),
		},
	})
	rt := NewRuntime(1)
	u := rt.NewUnit(p, nil)
	u.Start("Blink")

	rt.Tick(25)
	if u.visible[0] {
		t.Fatalf("after tick 1: piece should be hidden")
	}
	rt.Tick(50)
	if u.visible[0] {
		t.Fatalf("after tick 2: still sleeping, piece should be hidden")
	}
	rt.Tick(75)
	if !u.visible[0] {
		t.Fatalf("after tick 3: sleep elapsed, piece should be shown")
	}
}

// TestCobStateReportsStaticsAndThreads guards the inspector surface the
// studio's Runtime / Script Variables panels read: a unit running a script that
// has set a static var and parked on a SLEEP reports that global's value and a
// live thread carrying the script name + remaining sleep.
func TestCobStateReportsStaticsAndThreads(t *testing.T) {
	p := prog(twoPieces(), 2, ScriptSource{
		Name: "Idle",
		Insts: []Instruction{
			i1(scripting.OP_PUSH_IMMEDIATE, 7),
			i1(scripting.OP_POP_STATIC, 1), // global_1 = 7
			i1(scripting.OP_PUSH_IMMEDIATE, 100000),
			i0(scripting.OP_SLEEP),
		},
	})
	rt := NewRuntime(1)
	u := rt.NewUnit(p, nil)
	u.Start("Idle")
	rt.Tick(25) // runs to the SLEEP and parks

	st := u.CobState()
	if len(st.Static) != 2 {
		t.Fatalf("static count = %d, want 2", len(st.Static))
	}
	if st.Static[1] != 7 {
		t.Fatalf("global_1 = %d, want 7", st.Static[1])
	}
	if len(st.Threads) != 1 {
		t.Fatalf("thread count = %d, want 1", len(st.Threads))
	}
	th := st.Threads[0]
	if th.Script != "Idle" {
		t.Fatalf("thread script = %q, want Idle", th.Script)
	}
	if th.SleepMs <= 0 {
		t.Fatalf("thread sleepMs = %d, want > 0 (parked on SLEEP)", th.SleepMs)
	}
	if th.ID == 0 {
		t.Fatalf("thread id = 0, want a nonzero per-unit id")
	}
}

func TestSignalKillsMaskedThread(t *testing.T) {
	p := prog(twoPieces(), 0,
		ScriptSource{
			Name: "Main",
			Insts: []Instruction{
				i1(scripting.OP_PUSH_IMMEDIATE, 1),
				i0(scripting.OP_SET_SIGNAL_MASK),
				i1(scripting.OP_PUSH_IMMEDIATE, 100000),
				i0(scripting.OP_SLEEP),
			},
		},
		ScriptSource{
			Name: "Killer",
			Insts: []Instruction{
				i1(scripting.OP_PUSH_IMMEDIATE, 1),
				i0(scripting.OP_SIGNAL),
			},
		},
	)
	rt := NewRuntime(1)
	u := rt.NewUnit(p, nil)
	u.Start("Main")

	rt.Tick(25) // Main sets mask=1 and parks on a long sleep
	if u.countScript("Main") != 1 {
		t.Fatalf("Main should be alive and sleeping")
	}
	u.Start("Killer")
	rt.Tick(50) // Killer raises signal 1; Main's mask intersects -> dies
	if u.countScript("Main") != 0 {
		t.Fatalf("Main should have been killed by signal 1")
	}
}

func TestStartScriptSupersedesPriorInstance(t *testing.T) {
	walkIdx, _ := 0, 0
	p := prog(twoPieces(), 0,
		ScriptSource{
			Name: "Walk",
			Insts: []Instruction{
				i1(scripting.OP_PUSH_IMMEDIATE, 100000),
				i0(scripting.OP_SLEEP),
			},
		},
		ScriptSource{
			Name: "Launch",
			Insts: []Instruction{
				i2(scripting.OP_START_SCRIPT, 0, 0), // start Walk with 0 args
			},
		},
	)
	walkIdx, _ = p.ScriptIndex("Walk")
	rt := NewRuntime(1)
	u := rt.NewUnit(p, nil)
	u.Start("Walk")

	rt.Tick(25) // Walk #1 parks on its sleep
	first := u.threads[0]
	if first.scriptIndex != walkIdx {
		t.Fatalf("expected the parked thread to be Walk")
	}

	u.Start("Launch")
	rt.Tick(50) // Launch START_SCRIPTs Walk, superseding Walk #1
	if u.countScript("Walk") != 1 {
		t.Fatalf("expected exactly one live Walk after supersede, got %d", u.countScript("Walk"))
	}
	if u.threads[0] == first {
		t.Fatalf("the superseded Walk thread should have been replaced")
	}
}

func TestRunQueryReturnsFirstLocal(t *testing.T) {
	p := prog(twoPieces(), 0, ScriptSource{
		Name: "QueryPrimary",
		Insts: []Instruction{
			i1(scripting.OP_PUSH_IMMEDIATE, 7),
			i1(scripting.OP_POP_LOCAL_VAR, 0),
			i0(scripting.OP_RETURN),
		},
	})
	rt := NewRuntime(1)
	u := rt.NewUnit(p, nil)

	got, ok := u.RunQuery("QueryPrimary")
	if !ok || got != 7 {
		t.Fatalf("RunQuery = (%d, %v), want (7, true)", got, ok)
	}

	if _, ok := u.RunQuery("Missing"); ok {
		t.Fatalf("RunQuery on unknown script should fail")
	}
}

func TestRunQueryFailsOnYield(t *testing.T) {
	p := prog(twoPieces(), 0, ScriptSource{
		Name: "QuerySlow",
		Insts: []Instruction{
			i1(scripting.OP_PUSH_IMMEDIATE, 25),
			i0(scripting.OP_SLEEP), // a query may not yield
			i1(scripting.OP_PUSH_IMMEDIATE, 3),
			i1(scripting.OP_POP_LOCAL_VAR, 0),
			i0(scripting.OP_RETURN),
		},
	})
	rt := NewRuntime(1)
	u := rt.NewUnit(p, nil)
	if _, ok := u.RunQuery("QuerySlow"); ok {
		t.Fatalf("RunQuery should fail when the script would yield")
	}
}

// TestExportImportCobResumesExactPoses proves the full COB VM transfer used on a
// late join: a unit caught mid-turn, mid-spin and parked on a SLEEP exports its
// live VM state, a fresh unit adopts it (instead of re-running Create), and the
// two stay bit-identical in piece poses as both step forward — including across
// the sleeping thread's wake, where it draws OP_RAND. Restoring the runtime RNG
// is what keeps that post-wake draw identical; without it the joiner's pieces
// would diverge the moment the parked thread resumes.
func TestExportImportCobResumesExactPoses(t *testing.T) {
	build := func() *Program {
		return prog(twoPieces(), 1, ScriptSource{
			Name: "Create",
			Insts: []Instruction{
				i1(scripting.OP_PUSH_IMMEDIATE, 40000), // turn speed
				i1(scripting.OP_PUSH_IMMEDIATE, 3000),  // turn target
				i2(scripting.OP_TURN, 1, 1),            // turret mid-aim
				i1(scripting.OP_PUSH_IMMEDIATE, 100),   // rand lo
				i1(scripting.OP_PUSH_IMMEDIATE, 300),   // rand hi
				i0(scripting.OP_RAND),                  // advance the rng before snapshot
				i2(scripting.OP_SPIN, 0, 0),            // continuous spin at rand speed
				i1(scripting.OP_PUSH_IMMEDIATE, 7),
				i1(scripting.OP_POP_STATIC, 0), // a static to carry
				i1(scripting.OP_PUSH_IMMEDIATE, 100),
				i0(scripting.OP_SLEEP), // park; resumes after the snapshot
				i1(scripting.OP_PUSH_IMMEDIATE, 50),
				i1(scripting.OP_PUSH_IMMEDIATE, 500),
				i0(scripting.OP_RAND),       // post-wake draw — needs the restored rng
				i2(scripting.OP_SPIN, 1, 0), // drive a second piece from it
			},
		})
	}

	const seed = 0xBEEF
	prg := build()
	authRT := NewRuntime(seed)
	au := authRT.NewUnit(prg, nil)
	au.Start("Create")

	// Advance until the turret is mid-turn (not yet at target) and the thread is
	// parked on its sleep — the awkward mid-everything state a join can land on.
	for tick := 1; tick <= 3; tick++ {
		authRT.Tick(int64(tick) * stepMs)
	}
	if a := au.rotAnim(1, 1); a == nil || a.done {
		t.Fatalf("setup: turret turn should still be in progress at snapshot")
	}

	snap := au.ExportCob()
	rng := authRT.SnapshotRng()

	// Rebuild a fresh unit from the same program, as a joiner would, and adopt the
	// authority's VM state + rng instead of replaying Create.
	cliRT := NewRuntime(seed)
	cu := cliRT.NewUnit(prg, nil)
	cu.ImportCob(snap)
	cliRT.RestoreRng(rng)

	assertSamePieces := func(label string) {
		t.Helper()
		pa, pb := au.Pieces(), cu.Pieces()
		if len(pa) != len(pb) {
			t.Fatalf("%s: piece count %d != %d", label, len(pa), len(pb))
		}
		for i := range pa {
			if pa[i] != pb[i] {
				t.Fatalf("%s: piece %d %+v != %+v", label, i, pa[i], pb[i])
			}
		}
	}
	assertSamePieces("immediately after import")

	// Step both forward past the sleep's wake (100ms -> 4 ticks) and well beyond,
	// so the restored rng draw and continued animation are exercised in lockstep.
	for i := 0; i < 20; i++ {
		ms := int64(3+i+1) * stepMs
		authRT.Tick(ms)
		cliRT.Tick(ms)
		assertSamePieces("after step")
	}
}

func TestDeterministicRandomDrivesIdenticalPieces(t *testing.T) {
	// A script whose spin speed comes from OP_RAND: two runtimes seeded
	// identically must evolve bit-identical piece transforms.
	build := func() (*Runtime, *Unit) {
		p := prog(twoPieces(), 0, ScriptSource{
			Name: "Create",
			Insts: []Instruction{
				i1(scripting.OP_PUSH_IMMEDIATE, 40),  // lo
				i1(scripting.OP_PUSH_IMMEDIATE, 400), // hi
				i0(scripting.OP_RAND),                // speed in [40,400]
				i2(scripting.OP_SPIN, 0, 0),
				i1(scripting.OP_PUSH_IMMEDIATE, 80),  // lo
				i1(scripting.OP_PUSH_IMMEDIATE, 800), // hi
				i0(scripting.OP_RAND),                // speed in [80,800]
				i2(scripting.OP_SPIN, 1, 1),
			},
		})
		rt := NewRuntime(0xC0FFEE)
		u := rt.NewUnit(p, nil)
		u.Start("Create")
		return rt, u
	}

	rtA, uA := build()
	rtB, uB := build()
	for tick := 1; tick <= 30; tick++ {
		ms := int64(tick) * stepMs
		rtA.Tick(ms)
		rtB.Tick(ms)
		pa, pb := uA.Pieces(), uB.Pieces()
		if len(pa) != len(pb) {
			t.Fatalf("tick %d: piece count mismatch", tick)
		}
		for i := range pa {
			if pa[i] != pb[i] {
				t.Fatalf("tick %d piece %d: %+v != %+v", tick, i, pa[i], pb[i])
			}
		}
	}
}
