package sim

import (
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/order"
)

// sightMeta is a testMeta with the vision figures set, so the world's fog
// gate actually restricts this unit's side (a zero SightDistance would leave
// the side omniscient).
func sightMeta(name string, sight, radar, sonar int) *UnitMeta {
	m := testMeta(name)
	m.SightDistance = sight
	m.RadarDistance = radar
	m.SonarDistance = sonar
	return m
}

// addVision spawns an armed mobile unit carrying explicit vision figures and
// pins its standing orders.
func addVision(w *World, name string, at fixed.Vec2, side, moveMode, fireMode, sight, radar, sonar int) uint32 {
	id := w.AddUnit(name, sightMeta(name, sight, radar, sonar), nil, at, 0, side)
	w.ApplyOrder(order.Stance([]uint32{id}, moveMode, fireMode))
	return id
}

// TestSightGatesAcquisition is the headline behavioural change: a fire-at-will
// unit does NOT auto-engage an enemy that sits inside its weapon range but
// outside its line of sight, and DOES the moment that enemy comes within
// sightdistance.
func TestSightGatesAcquisition(t *testing.T) {
	w := New(Config{Seed: 71})
	// Sight 100 wu, weapon range 200 wu (testMeta default).
	atk := addVision(w, "atk", fixed.Vec2{}, 0, int(MoveHold), int(FireAtWill), 100, 0, 0)
	// Prey at 150 wu: in weapon range, out of sight.
	prey := addVision(w, "prey", fixed.Vec2{X: fixed.FromInt(150)}, 1, int(MoveHold), int(FireHold), 100, 0, 0)

	for i := 0; i < 400; i++ {
		w.Step(nil)
	}
	if w.UnitByID(atk).hasAttack {
		t.Fatalf("acquired an out-of-sight enemy")
	}
	if w.VisibleToSide(0, prey) {
		t.Fatalf("out-of-sight enemy reported visible")
	}
	if w.UnitByID(prey).Health < fixed.FromInt(100) {
		t.Fatalf("out-of-sight enemy took damage: hp=%v", w.UnitByID(prey).Health.Float())
	}

	// Bring the prey inside sightdistance (80 wu) — now it must be acquired.
	w.UnitByID(prey).loco.Pos.X = fixed.FromInt(80)
	w.Step(nil)
	if !w.VisibleToSide(0, prey) {
		t.Fatalf("in-sight enemy reported invisible")
	}
	for i := 0; i < 1500 && !w.UnitByID(prey).Dead; i++ {
		w.Step(nil)
	}
	if !w.UnitByID(prey).Dead {
		t.Fatalf("in-sight enemy was never engaged")
	}
}

// TestRadarRevealsPositionNotIdentity pins the radar tri-state: an enemy
// inside radar range but outside sight is DETECTED (a blip — position) yet not
// VISIBLE (no identity), and a radar-only contact is never auto-fired on (TA
// gates shoot-the-dot on a Targeting Facility the sandbox does not model).
func TestRadarRevealsPositionNotIdentity(t *testing.T) {
	w := New(Config{Seed: 72})
	// Sight 100, radar 300, weapon range 200.
	atk := addVision(w, "atk", fixed.Vec2{}, 0, int(MoveHold), int(FireAtWill), 100, 300, 0)
	// Prey at 200 wu: outside sight (100), inside radar (300), inside weapon
	// range (200).
	prey := addVision(w, "prey", fixed.Vec2{X: fixed.FromInt(200)}, 1, int(MoveHold), int(FireHold), 0, 0, 0)

	w.Step(nil)
	if w.VisibleToSide(0, prey) {
		t.Fatalf("radar-only contact reported visible (identity leaked)")
	}
	if !w.DetectedBySide(0, prey) {
		t.Fatalf("enemy in radar range not detected")
	}

	for i := 0; i < 400; i++ {
		w.Step(nil)
	}
	if w.UnitByID(atk).hasAttack || w.UnitByID(prey).Health < fixed.FromInt(100) {
		t.Fatalf("auto-fired on a radar-only contact")
	}
}

// TestNoVisionDataStaysOmniscient guards backward compatibility: a side whose
// units carry no sightdistance keeps the pre-vision behaviour (every enemy
// visible), so bare-meta scenarios and unenriched browser units are unchanged.
func TestNoVisionDataStaysOmniscient(t *testing.T) {
	w := New(Config{Seed: 73})
	atk := addStanced(w, "atk", fixed.Vec2{}, 0, int(MoveHold), int(FireAtWill))
	prey := addStanced(w, "prey", fixed.Vec2{X: fixed.FromInt(150)}, 1, int(MoveHold), int(FireHold))
	w.Step(nil)
	if !w.VisibleToSide(0, prey) {
		t.Fatalf("enemy invisible to a side with no vision data")
	}
	for i := 0; i < 1500 && !w.UnitByID(prey).Dead; i++ {
		w.Step(nil)
	}
	if !w.UnitByID(prey).Dead {
		t.Fatalf("omniscient side never engaged in-range enemy")
	}
	_ = atk
}

// TestCloakedNeverVisible pins the cloak interaction: a cloaked enemy sitting
// well inside sightdistance is not in line of sight for anyone, so it is
// neither reported visible nor auto-acquired — until it decloaks.
func TestCloakedNeverVisible(t *testing.T) {
	w := New(Config{Seed: 74})
	atk := addVision(w, "atk", fixed.Vec2{}, 0, int(MoveHold), int(FireAtWill), 300, 0, 0)
	prey := addVision(w, "prey", fixed.Vec2{X: fixed.FromInt(120)}, 1, int(MoveHold), int(FireHold), 0, 0, 0)
	w.UnitByID(prey).cloaked = true

	for i := 0; i < 300; i++ {
		w.Step(nil)
	}
	if w.VisibleToSide(0, prey) {
		t.Fatalf("cloaked enemy reported visible")
	}
	if w.UnitByID(atk).hasAttack {
		t.Fatalf("acquired a cloaked enemy")
	}

	w.UnitByID(prey).cloaked = false
	w.Step(nil)
	if !w.VisibleToSide(0, prey) {
		t.Fatalf("decloaked enemy still invisible")
	}
}

// TestTAKRadarVestigial pins the TA:K difference: TA:K parses radardistance
// but runs no detection layer, so a radar source there produces no blip.
func TestTAKRadarVestigial(t *testing.T) {
	w := New(Config{Seed: 75, Economy: EconomyTAK})
	addVision(w, "atk", fixed.Vec2{}, 0, int(MoveHold), int(FireAtWill), 100, 300, 0)
	prey := addVision(w, "prey", fixed.Vec2{X: fixed.FromInt(200)}, 1, int(MoveHold), int(FireHold), 0, 0, 0)
	w.Step(nil)
	if w.DetectedBySide(0, prey) {
		t.Fatalf("TA:K radar produced a contact (should be vestigial)")
	}
}

// TestFogGridExposed pins the render-lane data: with a map installed the
// snapshot carries a per-side fog grid whose sight and explored layers are set
// in the cell under a sighted unit.
func TestFogGridExposed(t *testing.T) {
	w := New(Config{Seed: 76})
	// A flat 64×64-cell map (16 wu/cell → 1024 wu across → 32 LOS cols/rows).
	w.SetTerrain(&Terrain{
		W: 64, H: 64, CellWU: fixed.FromInt(16), HeightScale: fixed.One,
		SeaLevel: 0, Data: make([]uint8, 64*64),
	})
	at := fixed.Vec2{X: fixed.FromInt(400), Z: fixed.FromInt(400)}
	addVision(w, "eye", at, 0, int(MoveHold), int(FireAtWill), 200, 0, 0)
	w.Step(nil)

	snap := w.Snapshot()
	if snap.Visibility == nil {
		t.Fatalf("no visibility grid exported with a map installed")
	}
	if snap.Visibility.Cols != 32 || snap.Visibility.Rows != 32 {
		t.Fatalf("unexpected grid dims: %dx%d", snap.Visibility.Cols, snap.Visibility.Rows)
	}
	col := at.X.Int() / losCellWU
	row := at.Z.Int() / losCellWU
	idx := row*snap.Visibility.Cols + col
	found := false
	for i := range snap.Visibility.Sides {
		sv := &snap.Visibility.Sides[i]
		if sv.Side != 0 {
			continue
		}
		found = true
		if sv.Sight[idx] == 0 {
			t.Fatalf("sight layer not set under the unit")
		}
		if sv.Explored[idx] == 0 {
			t.Fatalf("explored layer not set under the unit")
		}
	}
	if !found {
		t.Fatalf("side 0 has no fog layer")
	}
}
