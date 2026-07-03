package sim

import (
	"math"
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/script"
)

// pieceIndex resolves a piece name in a unit's COB piece table, failing the
// test when the script doesn't define it (a renamed piece would silently
// invalidate the assertions below).
func pieceIndex(t *testing.T, u *script.Unit, name string) int {
	t.Helper()
	for i, n := range u.PieceNames() {
		if n == name {
			return i
		}
	}
	t.Fatalf("piece %q not in COB piece table %v", name, u.PieceNames())
	return -1
}

// tickRuntime advances a bare script runtime n fixed ticks.
func tickRuntime(rt *script.Runtime, ms *int64, n int) {
	for i := 0; i < n; i++ {
		*ms += 25
		rt.Tick(*ms)
	}
}

// TestCommanderAimSlewsTorsoAboutYaw drives the real Commander COB's
// AimPrimary at a bearing a quarter turn to the side and proves the aim
// animates the torso about the VERTICAL axis (COB axis 1 = y = heading), not
// pitch: the regression this guards had the Commander nodding up and down
// when it should swing left/right. The pitch lands on the arm's x axis with
// the script's own sign convention (positive x tips the nose down, so the
// script turns the arm to (0 - pitch) - 5461).
func TestCommanderAimSlewsTorsoAboutYaw(t *testing.T) {
	rt := script.NewRuntime(1)
	u := loadCobUnit(t, rt, "ARMCOM.cob")
	// Create must have run first: AimPrimary gates on a static the Create
	// script sets (the engine runs Create synchronously at spawn).
	u.StartNow("Create")

	const bearing = 16384 // quarter turn
	u.Start("AimPrimary", bearing, 0)
	var ms int64
	tickRuntime(rt, &ms, 200)

	pieces := u.Pieces()
	torso := pieceIndex(t, u, "torso")
	arm := pieceIndex(t, u, "luparm")

	if got := pieces[torso].Rot[1]; got != bearing {
		t.Fatalf("torso y-axis (yaw) = %d, want %d — the aim heading must land on the vertical axis", got, bearing)
	}
	if got := pieces[torso].Rot[0]; got != 0 {
		t.Fatalf("torso x-axis (pitch) = %d, want 0 — aiming sideways must not pitch the torso", got)
	}
	if got := pieces[torso].Rot[2]; got != 0 {
		t.Fatalf("torso z-axis (roll) = %d, want 0", got)
	}
	// Pitch argument 0: the script rests the aim arm at (0 - 0) - 5461 on x.
	if got := pieces[arm].Rot[0]; got != -5461 {
		t.Fatalf("luparm x-axis = %d, want -5461 (the script's rest elevation)", got)
	}
}

// TestCreateRunsSynchronouslyAtSpawn proves a unit's Create script executes
// during AddUnit, before any tick runs — the Commander's Create hides its
// build-effect pieces, and those must already be invisible on the first
// rendered frame (the regression had fresh spawns showing every muzzle
// flare and nano spray until the first sim step).
func TestCreateRunsSynchronouslyAtSpawn(t *testing.T) {
	rt := script.NewRuntime(2)
	u := loadCobUnit(t, rt, "ARMCOM.cob")
	w := New(Config{Seed: 2})
	w.AddUnit("armcom", testMeta("armcom"), u, fixed.Vec2{}, 0, 0)

	// No w.Step and no rt.Tick: this is the state the first frame renders.
	pieces := u.Pieces()
	for _, name := range []string{"rbigflash", "lfirept", "nanospray"} {
		if pieces[pieceIndex(t, u, name)].Visible {
			t.Fatalf("piece %q visible right after spawn — Create's hide must apply before the first frame", name)
		}
	}
	if !pieces[pieceIndex(t, u, "torso")].Visible {
		t.Fatal("torso hidden after spawn — Create must only hide the pieces it names")
	}
}

// TestSamsonBodyStaysVisible reproduces the vanishing-Samson bug against the
// real ARMSAM COB: its piece table lists the two launcher flares FIRST
// (before base/launcher/turret), so any consumer that applies visibility by
// model-hierarchy index hides the truck's body when the script hides its
// flares. Engine-side the contract is: hide affects exactly the named piece,
// never its children or its table neighbours — the body pieces stay visible
// through spawn, aiming and firing.
func TestSamsonBodyStaysVisible(t *testing.T) {
	rt := script.NewRuntime(3)
	u := loadCobUnit(t, rt, "ARMSAM.cob")
	u.StartNow("Create")
	u.Start("AimPrimary", 8000, 0)
	var ms int64
	body := []int{
		pieceIndex(t, u, "base"),
		pieceIndex(t, u, "launcher"),
		pieceIndex(t, u, "turret"),
	}
	check := func(stage string) {
		t.Helper()
		pieces := u.Pieces()
		for _, idx := range body {
			if !pieces[idx].Visible {
				t.Fatalf("%s: body piece %q became invisible", stage, u.PieceNames()[idx])
			}
		}
	}
	check("after create")
	tickRuntime(rt, &ms, 120)
	check("while aiming")
	u.Start("FirePrimary")
	for i := 0; i < 60; i++ {
		tickRuntime(rt, &ms, 1)
		check("while firing")
	}
	// The flares themselves start hidden (Create hides them) — the guard
	// only holds if the hides actually landed on the flares, not the body.
	if pieces := u.Pieces(); pieces[pieceIndex(t, u, "flare1")].Visible {
		t.Fatal("flare1 visible after Create — its hide landed on the wrong piece")
	}
}

// TestPeeWeeWalkKeepsLimbsAttached runs the real ARMPW walk cycle for 200
// ticks and asserts every piece's scripted offset stays within a
// model-plausible distance of its rest joint. The COB MOVE operand is 16.16
// fixed (65536 = one world unit, the same scale as 3DO piece origins); a
// scale mistake there multiplies leg offsets by tens of thousands and the
// limbs visibly drift off the body — the regression this pins down.
func TestPeeWeeWalkKeepsLimbsAttached(t *testing.T) {
	rt := script.NewRuntime(4)
	u := loadCobUnit(t, rt, "ARMPW.cob")
	u.StartNow("Create")
	u.Start("StartMoving")

	// The PeeWee stands ~14 world units at the pelvis; its walk bobs pieces
	// by fractions of a unit. Anything past a few units means the linear
	// scale is wrong by orders of magnitude.
	const maxOffsetWU = 4.0
	var ms int64
	moved := false
	names := u.PieceNames()
	for tick := 0; tick < 200; tick++ {
		tickRuntime(rt, &ms, 1)
		for i, p := range u.Pieces() {
			for axis, v := range [3]float64{p.Offset.X.Float(), p.Offset.Y.Float(), p.Offset.Z.Float()} {
				if math.Abs(v) > maxOffsetWU {
					t.Fatalf("tick %d: piece %q axis %d offset %.2f wu exceeds %.1f — MOVE linear scale is off",
						tick, names[i], axis, v, maxOffsetWU)
				}
				if v != 0 {
					moved = true
				}
			}
		}
	}
	if !moved {
		t.Fatal("no piece ever moved — the walk cycle never ran, so the bound proved nothing")
	}
}
