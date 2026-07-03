package sim

import (
	"strings"
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/frame"
	"github.com/coreprime/kbot/engine/script"
)

// pieceIndexOf resolves a COB piece-table name to its index, the mapping a
// renderer applies when it turns UnitQueryScriptPiece's result into a model
// piece. -1 when absent.
func pieceIndexOf(b *script.Unit, name string) int32 {
	for i, n := range b.PieceNames() {
		if strings.EqualFold(n, name) {
			return int32(i)
		}
	}
	return -1
}

// TestQueryScriptPieceRealCob proves UnitQueryScriptPiece against retail COBs:
// a factory's QueryBuildInfo names its build pad, QueryNanoPiece cycles the
// nano spray between its two beam emitters, a k-bot's QueryPrimary cycles its
// two muzzle flares, and every missing-script / missing-binding path degrades
// to -1 so callers can fall back to the unit origin.
func TestQueryScriptPieceRealCob(t *testing.T) {
	rt := script.NewRuntime(11)
	lab := loadCobUnit(t, rt, "ARMLAB.cob")
	pw := loadCobUnit(t, rt, "ARMPW.cob")

	w := New(Config{Seed: 11})
	fm := testMeta("armlab")
	fm.CanMove = false
	labID := w.AddUnit("armlab", fm, lab, fixed.Vec2{}, 0, 0)
	pwID := w.AddUnit("armpw", testMeta("armpw"), pw, fixed.Vec2{X: fixed.FromInt(64)}, 0, 0)
	bareID := w.AddUnit("bare", testMeta("bare"), nil, fixed.Vec2{X: fixed.FromInt(128)}, 0, 0)

	// Factory build pad.
	pad := w.UnitQueryScriptPiece(labID, "QueryBuildInfo")
	if want := pieceIndexOf(lab, "pad"); pad != want || pad < 0 {
		t.Fatalf("QueryBuildInfo = %d, want pad index %d", pad, want)
	}

	// Nano spray cycles beam1 / beam2 on successive queries.
	n1 := w.UnitQueryScriptPiece(labID, "QueryNanoPiece")
	n2 := w.UnitQueryScriptPiece(labID, "QueryNanoPiece")
	b1, b2 := pieceIndexOf(lab, "beam1"), pieceIndexOf(lab, "beam2")
	if n1 != b1 || n2 != b2 {
		t.Fatalf("QueryNanoPiece cycle = %d, %d; want %d, %d (beam1, beam2)", n1, n2, b1, b2)
	}

	// Weapon muzzle: the peewee reports its right flare, and its barrel
	// cycle advances in FirePrimary — after a shot the query reports the
	// left flare, so shot visuals alternate muzzles the way the game does.
	rf, lf := pieceIndexOf(pw, "rfire"), pieceIndexOf(pw, "lfire")
	if m := w.UnitQueryScriptPiece(pwID, "QueryPrimary"); m != rf {
		t.Fatalf("QueryPrimary = %d, want rfire index %d", m, rf)
	}
	w.UnitStartScript(pwID, "FirePrimary")
	for i := 0; i < 10; i++ { // FirePrimary sleeps 100ms mid-flash
		w.Step(rt)
	}
	if m := w.UnitQueryScriptPiece(pwID, "QueryPrimary"); m != lf {
		t.Fatalf("QueryPrimary after a shot = %d, want lfire index %d", m, lf)
	}

	// Fallback paths: unknown entry point, script-less unit, missing unit.
	if got := w.UnitQueryScriptPiece(pwID, "QueryTertiary"); got != -1 {
		t.Fatalf("missing script should report -1, got %d", got)
	}
	if got := w.UnitQueryScriptPiece(bareID, "QueryPrimary"); got != -1 {
		t.Fatalf("script-less unit should report -1, got %d", got)
	}
	if got := w.UnitQueryScriptPiece(9999, "QueryPrimary"); got != -1 {
		t.Fatalf("missing unit should report -1, got %d", got)
	}
}

// pieceSig flattens a binding's piece transforms for change detection.
func pieceSig(ps []frame.PieceState) []int64 {
	out := make([]int64, 0, len(ps)*6)
	for _, p := range ps {
		out = append(out,
			int64(p.Offset.X), int64(p.Offset.Y), int64(p.Offset.Z),
			int64(p.Rot[0]), int64(p.Rot[1]), int64(p.Rot[2]))
	}
	return out
}

func sigsEqual(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// TestFactoryActivationAnimatesPinSpawned proves the replay-driver factory
// recipe on a pin-spawned (directly-placed, no production order) retail
// factory: SetUnitActivation(true) runs the COB Activate chain and its
// door/stand pieces keep moving across subsequent ticks; StartBuilding spins
// the build pad continuously while active; StopBuilding + deactivation
// return the model toward its closed pose.
func TestFactoryActivationAnimatesPinSpawned(t *testing.T) {
	rt := script.NewRuntime(23)
	lab := loadCobUnit(t, rt, "ARMLAB.cob")

	w := New(Config{Seed: 23})
	fm := testMeta("armlab")
	fm.CanMove = false
	id := w.AddUnit("armlab", fm, lab, fixed.Vec2{}, 0, 0)

	// Settle Create, then capture the rest pose.
	for i := 0; i < 10; i++ {
		w.Step(rt)
	}
	rest := pieceSig(lab.Pieces())

	if !w.SetUnitActivation(id, true) {
		t.Fatalf("SetUnitActivation(true) reported no script")
	}
	// The open animation runs ~2s of script time; sample mid-flight and at
	// the end so we prove pieces MOVE OVER TICKS, not just snap once.
	for i := 0; i < 20; i++ {
		w.Step(rt)
	}
	mid := pieceSig(lab.Pieces())
	for i := 0; i < 120; i++ {
		w.Step(rt)
	}
	open := pieceSig(lab.Pieces())
	if sigsEqual(rest, mid) {
		t.Fatalf("activation moved nothing by tick 20")
	}
	if sigsEqual(mid, open) {
		t.Fatalf("activation animation did not progress between tick 20 and tick 140")
	}
	if got := w.UnitValuePort(id, 1); got != 1 {
		t.Fatalf("ACTIVATION port should read on, got %d", got)
	}

	// Pad spin while active: StartBuilding spins the pad about y; successive
	// ticks must show the pad's y rotation advancing.
	padIdx := int(w.UnitQueryScriptPiece(id, "QueryBuildInfo"))
	if padIdx < 0 {
		t.Fatalf("QueryBuildInfo failed on an open factory")
	}
	w.UnitStartScript(id, "StartBuilding")
	w.Step(rt)
	r1 := lab.Pieces()[padIdx].Rot[1]
	w.Step(rt)
	r2 := lab.Pieces()[padIdx].Rot[1]
	w.Step(rt)
	r3 := lab.Pieces()[padIdx].Rot[1]
	if r1 == r2 || r2 == r3 {
		t.Fatalf("build pad is not spinning: rot samples %d, %d, %d", r1, r2, r3)
	}

	// Completion: stop the pad, close the factory. The Deactivate entry
	// sleeps 5s before folding, then the close animation runs ~2s.
	w.UnitStartScript(id, "StopBuilding")
	if !w.SetUnitActivation(id, false) {
		t.Fatalf("SetUnitActivation(false) reported no script")
	}
	for i := 0; i < 40*9; i++ {
		w.Step(rt)
	}
	closed := pieceSig(lab.Pieces())
	if sigsEqual(open, closed) {
		t.Fatalf("deactivation did not move the factory back toward rest")
	}
	if got := w.UnitValuePort(id, 1); got != 0 {
		t.Fatalf("ACTIVATION port should read off, got %d", got)
	}
	// Pad spin decelerated to rest: consecutive ticks agree.
	p1 := lab.Pieces()[padIdx].Rot[1]
	w.Step(rt)
	p2 := lab.Pieces()[padIdx].Rot[1]
	if p1 != p2 {
		t.Fatalf("build pad still spinning after StopBuilding: %d -> %d", p1, p2)
	}
}
