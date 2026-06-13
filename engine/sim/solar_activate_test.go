package sim

import (
	"bytes"
	"os"
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/script"
	"github.com/coreprime/kbot/formats/scripting"
)

func loadSolar(t *testing.T, rt *script.Runtime) *script.Unit {
	t.Helper()
	path := os.Getenv("TA_UNPACKED_PATH") + "/scripts/ARMSOLAR.cob"
	data, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("no solar cob: %v", err)
	}
	cob, err := scripting.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	prog, err := script.FromCOB(cob)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	return rt.NewUnit(prog, nil)
}

// dishOpen reports whether the four solar dishes have tilted up off their
// folded rest pose — the visible "on" state. The COB turns dish1/2 about x and
// dish3/4 about z to ±16384.
func dishOpen(b *script.Unit) bool {
	ps := b.Pieces()
	if len(ps) < 5 {
		return false
	}
	return ps[1].Rot[0] != 0 && ps[2].Rot[0] != 0 && ps[3].Rot[2] != 0 && ps[4].Rot[2] != 0
}

func solarMeta() *UnitMeta {
	m := testMeta("armsolar")
	m.CanMove = false
	m.OnOffable = true
	m.ActivateWhenBuilt = true
	return m
}

// TestSolarAutoOpensOnPlacement proves a directly-placed ActivateWhenBuilt
// structure unfolds and reads "on" immediately (InitOnOff), and that the
// activation toggle round-trips: the dishes fold back and the ACTIVATION port
// follows so the studio pill can't desync.
func TestSolarAutoOpensOnPlacement(t *testing.T) {
	rt := script.NewRuntime(7)
	bind := loadSolar(t, rt)

	w := New(Config{Seed: 7})
	id := w.AddUnit("armsolar", solarMeta(), bind, fixed.Vec2{}, 0, 0)
	w.InitOnOff(id) // mirrors the wasm direct-placement entry point

	for i := 0; i < 200; i++ {
		w.Step(rt)
	}
	if !dishOpen(bind) {
		t.Fatalf("placed solar did not auto-open: pieces=%v", bind.Pieces())
	}
	if got := w.UnitValuePort(id, 1); got != 1 {
		t.Fatalf("ACTIVATION should read on after auto-open, got %d", got)
	}

	// Toggle off — the structure folds and the port follows so the pill tracks.
	w.setActivation(w.units[id], false)
	for i := 0; i < 200; i++ {
		w.Step(rt)
	}
	if dishOpen(bind) {
		t.Fatalf("deactivated solar still open: pieces=%v", bind.Pieces())
	}
	if got := w.UnitValuePort(id, 1); got != 0 {
		t.Fatalf("ACTIVATION should read off after deactivate, got %d", got)
	}

	// Toggle back on — folds open again, port back to 1.
	w.setActivation(w.units[id], true)
	for i := 0; i < 200; i++ {
		w.Step(rt)
	}
	if !dishOpen(bind) {
		t.Fatalf("reactivated solar did not reopen: pieces=%v", bind.Pieces())
	}
	if got := w.UnitValuePort(id, 1); got != 1 {
		t.Fatalf("ACTIVATION should read on after reactivate, got %d", got)
	}
}
