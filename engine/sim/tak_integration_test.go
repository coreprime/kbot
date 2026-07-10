package sim

import (
	"bytes"
	"os"
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/frame"
	"github.com/coreprime/kbot/engine/order"
	"github.com/coreprime/kbot/engine/script"
	"github.com/coreprime/kbot/formats/scripting"
	"github.com/coreprime/kbot/internal/testutil"
)

// loadTAKBinding parses a retail TA:K v6 COB into a live script unit.
func loadTAKBinding(t *testing.T, rt *script.Runtime, name string) *script.Unit {
	t.Helper()
	path := testutil.TAKUnpackedFile(t, "scripts", name)
	if _, err := os.Stat(path); err != nil {
		t.Skipf("sample not available: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	cob, err := scripting.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("parse cob: %v", err)
	}
	prog, err := script.FromCOB(cob)
	if err != nil {
		t.Fatalf("compile program: %v", err)
	}
	return rt.NewUnit(prog, nil)
}

// TestTAKRetailScriptFires drives a retail TA:K unit script (the Aramon
// knight, COB v6) through the live weapon state machine: the world issues
// AimWeapon(heading, pitch, slot), the script answers through the
// WEAPON_READY port, and the unit must actually fire — proving the whole
// TA:K convention end to end against real game bytecode.
func TestTAKRetailScriptFires(t *testing.T) {
	rt := script.NewRuntime(31)
	bind := loadTAKBinding(t, rt, "araknigh.cob")
	if !bind.HasScript("AimWeapon") || bind.HasScript("AimPrimary") {
		t.Fatal("araknigh.cob does not look like a TA:K-convention script")
	}

	w := New(Config{Seed: 31})
	// Face the defender from the start (bearing 16384): the retail-script
	// handshake is under test, and the TA:K body pivot now turns at the
	// engines' turnrate>>3 per frame (locomotion spec UNKNOWN-14) — slower
	// than the return fire that would otherwise kill the knight mid-pivot.
	atk := w.AddUnit("araknigh", testMeta("araknigh"), bind, fixed.Vec2{}, 16384, 0)
	def := w.AddUnit("def", testMeta("def"), nil, fixed.Vec2{X: fixed.FromInt(80)}, 0, 1)
	w.ApplyOrder(order.Attack([]uint32{atk}, def))

	fired := false
	for i := 0; i < 400; i++ {
		w.Step(rt)
		for _, ev := range w.Snapshot().Events {
			if ev.Kind == frame.EvFire && ev.UnitID == atk {
				fired = true
				break
			}
		}
	}
	if !fired {
		t.Fatal("TA:K unit never fired: the WEAPON_READY handshake did not reach the weapon SM")
	}
	if w.UnitByID(def).Health.Int() >= 100 {
		t.Error("defender took no damage from the TA:K unit's shots")
	}
}

// TestTAKRetailScriptWalkGait proves CURRENT_SPEED publication reaches a
// retail TA:K MoveWatcher loop: once the unit is moving, the script's
// global_0 "is walking" flag flips on (knight scripts gate the gait on
// CURRENT_SPEED > 5).
func TestTAKRetailScriptWalkGait(t *testing.T) {
	rt := script.NewRuntime(33)
	bind := loadTAKBinding(t, rt, "araknigh.cob")

	w := New(Config{Seed: 33})
	id := w.AddUnit("araknigh", testMeta("araknigh"), bind, fixed.Vec2{}, 0, 0)
	w.ApplyOrder(order.Move([]uint32{id}, fixed.Vec2{X: fixed.FromInt(600)}))

	// global_0 is the knight's "moving" flag, set by MoveWatcher's
	// CURRENT_SPEED poll (the loop sleeps 100ms between polls).
	walking := false
	for i := 0; i < 200 && !walking; i++ {
		w.Step(rt)
		if bind.CobState().Static[0] != 0 {
			walking = true
		}
	}
	if !walking {
		t.Fatal("MoveWatcher never saw CURRENT_SPEED > 5 while the unit was moving")
	}
}

// TestBodyAimHoldsFireWhileFacingAway proves a body-aimed unit (TA:K, no
// turret script) holds fire while walking away from its force-fire target and
// only shoots once its body bears on it.
func TestBodyAimHoldsFireWhileFacingAway(t *testing.T) {
	w := New(Config{Seed: 41})
	bind := &takWeaponBinding{
		recordingBinding: recordingBinding{scripts: map[string]bool{
			"AimWeapon": true, "FireWeapon": true,
		}},
		readyAfterAims: 1,
	}
	atk := w.AddUnit("atk", testMeta("atk"), bind, fixed.Vec2{}, 0, 0)
	u := w.units[atk]
	// Force-fire a point behind the unit while it marches the other way.
	u.weapons[0] = weaponSlot{hasTarget: true, targetPt: fixed.Vec3{Z: fixed.FromInt(-100)}, source: "manual"}
	w.ApplyOrder(order.Move([]uint32{atk}, fixed.Vec2{Z: fixed.FromInt(800)}))
	for i := 0; i < 80; i++ {
		w.Step(nil)
		if !u.IsMoving {
			break
		}
		if got := countCalls(bind.starts, "FireWeapon"); got != 0 {
			t.Fatalf("fired %d times while marching away from the target", got)
		}
	}
}

// TestTAKRetailDeathLeavesCorpse drives a retail TA:K unit through the full
// death sequence: ApplyDamage past zero starts Killed (3-arg TA:K form) and
// Dying; the corpse event must not surface until the Dying script signals
// FINISHED_DYING, and the TA:K corpsetype convention (script returns 1 =
// leave the corpse) must map onto the renderer's slot 1.
func TestTAKRetailDeathLeavesCorpse(t *testing.T) {
	rt := script.NewRuntime(35)
	bind := loadTAKBinding(t, rt, "arapal.cob")
	if !bind.HasScript("Dying") || !bind.HasScript("Killed") {
		t.Fatal("arapal.cob does not carry the TA:K death pair")
	}

	w := New(Config{Seed: 35})
	id := w.AddUnit("arapal", testMeta("arapal"), bind, fixed.Vec2{}, 0, 0)
	w.Step(rt) // let Create settle

	w.ApplyDamage(0, id, fixed.FromInt(1000))
	if u := w.UnitByID(id); u == nil || !u.Dead {
		t.Fatal("unit did not die")
	}

	corpseAt, corpseSlot := -1, -1
	finishedAt := -1
	for i := 0; i < 600 && corpseAt < 0; i++ {
		w.Step(rt)
		if finishedAt < 0 && bind.FinishedDying() {
			finishedAt = i
		}
		for _, ev := range w.Snapshot().Events {
			if ev.Kind == frame.EvCorpseSpawn && ev.UnitID == id {
				corpseAt, corpseSlot = i, ev.Slot
			}
		}
	}
	if corpseAt < 0 {
		t.Fatal("death never produced a corpse event")
	}
	if finishedAt < 0 {
		t.Fatal("Dying never signalled FINISHED_DYING")
	}
	if corpseAt < finishedAt {
		t.Fatalf("corpse surfaced at step %d, before FINISHED_DYING at %d", corpseAt, finishedAt)
	}
	if corpseSlot != 1 {
		t.Fatalf("corpse slot = %d, want 1 (TA:K corpsetype 1 = intact corpse)", corpseSlot)
	}
}
