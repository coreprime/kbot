package sim

import (
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/order"
)

func builderMeta() *UnitMeta {
	m := testMeta("builder")
	m.IsBuilder = true
	m.WorkerTime = 200
	m.BuildDistance = fixed.FromInt(60)
	return m
}

func buildWorld() *World {
	spawn := func(name string) (*UnitMeta, Binding) {
		m := testMeta(name)
		m.BuildTime = fixed.FromInt(800) // 800/200 = 4s at the builder's pace
		return m, nil
	}
	return New(Config{Seed: 11, Spawn: spawn})
}

// TestCanBuildAtRejectsOverlap pins that a building footprint can't be placed
// over an existing structure's footprint, while a clear plot still passes.
func TestCanBuildAtRejectsOverlap(t *testing.T) {
	w := New(Config{Seed: 31})
	w.SetTerrain(testTerrain(40, 40, 0, func(_, _ int) uint8 { return 0 }))
	// A standing 4×4 structure centred near (320,320).
	struc := footMeta("keep", 4, false)
	w.AddUnit("keep", struc, nil, fixed.Vec2{X: fixed.FromInt(320), Z: fixed.FromInt(320)}, 0, 0)
	probe := footMeta("hut", 4, false)
	// Dead-centre overlap, and a one-cell nudge that still overlaps, are
	// rejected; a plot a couple of footprints away is allowed.
	if w.canBuildAt(probe, fixed.Vec2{X: fixed.FromInt(320), Z: fixed.FromInt(320)}) {
		t.Fatalf("expected overlap at the structure centre to be rejected")
	}
	if w.canBuildAt(probe, fixed.Vec2{X: fixed.FromInt(340), Z: fixed.FromInt(320)}) {
		t.Fatalf("expected a partial footprint overlap to be rejected")
	}
	if !w.canBuildAt(probe, fixed.Vec2{X: fixed.FromInt(460), Z: fixed.FromInt(320)}) {
		t.Fatalf("expected a clear plot clear of the structure to be allowed")
	}
}

// TestCanBuildAtUnderwaterStructure pins the water-fit rule for a structure
// that declares MinWaterDepth (an underwater storage / mex): it may only be
// founded where the sea is deep enough, and is rejected on land — the mirror
// of a land building's MaxWaterDepth ceiling. Regression for the bug where
// such a unit (MaxWaterDepth defaulting to 0) read as land-only.
func TestCanBuildAtUnderwaterStructure(t *testing.T) {
	w := New(Config{Seed: 7})
	// Sea level 40: the left half is seabed at height 0 (depth 40), the right
	// half is dry land at height 60.
	w.SetTerrain(testTerrain(40, 40, 40, func(cx, _ int) uint8 {
		if cx < 20 {
			return 0
		}
		return 60
	}))
	uw := footMeta("uwms", 4, false)
	uw.MinWaterDepth = 31
	uw.MaxSlope = 50
	deep := fixed.Vec2{X: fixed.FromInt(8 * 16), Z: fixed.FromInt(20 * 16)}
	land := fixed.Vec2{X: fixed.FromInt(32 * 16), Z: fixed.FromInt(20 * 16)}
	if !w.canBuildAt(uw, deep) {
		t.Fatalf("underwater storage should be buildable in deep water")
	}
	if w.canBuildAt(uw, land) {
		t.Fatalf("underwater storage should be rejected on dry land")
	}
}

// TestBuildCycleRaisesUnit pins the mobile-builder contract: the builder
// walks into builddistance of the site, the buildee appears at 0% and rises
// to 100% at the buildtime/workertime pace, and only then takes orders.
func TestBuildCycleRaisesUnit(t *testing.T) {
	w := buildWorld()
	bld := w.AddUnit("builder", builderMeta(), nil, fixed.Vec2{}, 0, 0)
	site := fixed.Vec2{X: fixed.FromInt(300)}
	w.ApplyOrder(order.Build(bld, "armpw", site, 0))

	u := w.UnitByID(bld)
	var buildee *Unit
	spawnedAt := -1
	for i := 0; i < 4000; i++ {
		w.Step(nil)
		if buildee == nil && u.buildeeID != 0 {
			buildee = w.UnitByID(u.buildeeID)
			spawnedAt = i
			// The buildee must appear within builddistance of the builder and
			// start at zero percent, inert.
			if d := u.loco.Pos.DistTo(buildee.loco.Pos); d > fixed.FromInt(70) {
				t.Fatalf("buildee spawned out of build range: %v", d.Float())
			}
			if buildee.BuildPercent >= fixed.FromInt(5) {
				t.Fatalf("buildee did not start near 0%%: %v", buildee.BuildPercent.Float())
			}
			// Orders must bounce off an under-construction unit.
			w.ApplyOrder(order.Move([]uint32{buildee.ID}, fixed.Vec2{Z: fixed.FromInt(500)}))
			if buildee.hasMove {
				t.Fatalf("under-construction buildee accepted a move order")
			}
		}
		if buildee != nil && buildee.BuildPercent >= fixed.FromInt(100) {
			break
		}
	}
	if buildee == nil {
		t.Fatalf("buildee never spawned; builder at (%v,%v) state=%d",
			u.loco.Pos.X.Float(), u.loco.Pos.Z.Float(), u.buildState)
	}
	if buildee.BuildPercent < fixed.FromInt(100) {
		t.Fatalf("build never completed: %v%%", buildee.BuildPercent.Float())
	}
	// 4s at 40 Hz = 160 ticks; allow slack but reject instant or runaway.
	doneAt := int(w.Tick())
	dur := doneAt - spawnedAt
	if dur < 100 || dur > 300 {
		t.Fatalf("build pace off: took %d ticks (want ~160)", dur)
	}
	if u.buildState != buildIdle {
		t.Fatalf("builder did not return to idle")
	}
	// Complete unit takes orders again.
	w.ApplyOrder(order.Move([]uint32{buildee.ID}, fixed.Vec2{Z: fixed.FromInt(200)}))
	if !buildee.hasMove {
		t.Fatalf("completed buildee rejected a move order")
	}
}

// TestBuildCancelledByStop pins the abandon path: Stop mid-raise retracts the
// builder's job and leaves the partial buildee inert where it stands.
func TestBuildCancelledByStop(t *testing.T) {
	w := buildWorld()
	bld := w.AddUnit("builder", builderMeta(), nil, fixed.Vec2{}, 0, 0)
	w.ApplyOrder(order.Build(bld, "armpw", fixed.Vec2{X: fixed.FromInt(40)}, 0))
	u := w.UnitByID(bld)
	for i := 0; i < 200 && u.buildState != buildRaising; i++ {
		w.Step(nil)
	}
	if u.buildState != buildRaising {
		t.Fatalf("build never started raising")
	}
	b := w.UnitByID(u.buildeeID)
	w.ApplyOrder(order.Stop([]uint32{bld}))
	if u.buildState != buildIdle {
		t.Fatalf("stop did not cancel the build job")
	}
	// Abandoned, the frame must decay (half build pace) — never keep
	// rising — and once it falls to zero it collapses entirely.
	pct := b.BuildPercent
	for i := 0; i < 100; i++ {
		w.Step(nil)
	}
	if b.BuildPercent > pct {
		t.Fatalf("abandoned buildee kept rising: %v -> %v", pct.Float(), b.BuildPercent.Float())
	}
	if !b.Dead && b.BuildPercent >= pct {
		t.Fatalf("abandoned buildee did not decay: %v -> %v", pct.Float(), b.BuildPercent.Float())
	}
	for i := 0; i < 20000 && !b.Dead; i++ {
		w.Step(nil)
	}
	if !b.Dead {
		t.Fatalf("fully decayed frame never collapsed (at %v%%)", b.BuildPercent.Float())
	}
}

// TestQueuedBuildChain pins the shift-queued base plan: a mobile builder
// given one immediate and two queued Build orders raises all three in
// order, pulling the next site off its queue as each completes.
func TestQueuedBuildChain(t *testing.T) {
	w := buildWorld()
	bld := w.AddUnit("builder", builderMeta(), nil, fixed.Vec2{}, 0, 0)
	w.ApplyOrder(order.Build(bld, "solar", fixed.Vec2{X: fixed.FromInt(200)}, 0))
	w.ApplyOrder(order.BuildQueued(bld, "solar", fixed.Vec2{X: fixed.FromInt(320)}, 0))
	w.ApplyOrder(order.BuildQueued(bld, "solar", fixed.Vec2{X: fixed.FromInt(440)}, 0))

	u := w.UnitByID(bld)
	if len(u.queue) != 2 {
		t.Fatalf("queued builds did not defer: queue len %d", len(u.queue))
	}
	done := 0
	for i := 0; i < 30000 && done < 3; i++ {
		w.Step(nil)
		done = 0
		for _, id := range w.order {
			if o := w.units[id]; o != nil && o.Name == "solar" && !o.underConstruction() {
				done++
			}
		}
	}
	if done != 3 {
		t.Fatalf("queued build chain stalled: %d of 3 finished", done)
	}
}

// TestRepairResumesAbandonedFrame pins the repair gesture: a builder ordered
// at an existing under-construction frame walks back and finishes IT (no
// duplicate buildee), beating the abandonment decay.
func TestRepairResumesAbandonedFrame(t *testing.T) {
	w := buildWorld()
	bld := w.AddUnit("builder", builderMeta(), nil, fixed.Vec2{}, 0, 0)
	w.ApplyOrder(order.Build(bld, "solar", fixed.Vec2{X: fixed.FromInt(60)}, 0))
	u := w.UnitByID(bld)
	for i := 0; i < 600 && u.buildeeID == 0; i++ {
		w.Step(nil)
	}
	b := w.UnitByID(u.buildeeID)
	if b == nil {
		t.Fatal("build never started")
	}
	for i := 0; i < 200 && b.BuildPercent < fixed.FromInt(30); i++ {
		w.Step(nil)
	}
	w.ApplyOrder(order.Stop([]uint32{bld}))
	for i := 0; i < 100; i++ {
		w.Step(nil) // decay a little
	}
	pct := b.BuildPercent
	if pct >= fixed.FromInt(30) {
		t.Fatalf("abandoned frame did not decay (at %v%%)", pct.Float())
	}
	w.ApplyOrder(order.Repair(bld, b.ID))
	for i := 0; i < 6000 && b.underConstruction(); i++ {
		w.Step(nil)
	}
	if b.Dead || b.underConstruction() {
		t.Fatalf("repair never completed the frame: dead=%v pct=%v", b.Dead, b.BuildPercent.Float())
	}
	if u.buildeeID != 0 && u.buildeeID != b.ID {
		t.Fatalf("repair spawned a different buildee (%d)", u.buildeeID)
	}
}

// TestSlopeScalePerTerrain pins the game-aware slope scale: a GROUND2-class
// unit (MaxSlope 30) must climb a ~25-byte/cell step on a TA:K-scale heightmap
// (SlopeScalePct 100 → effective 30) — the Athri-Cay island-edge case — yet
// the same step is refused on a TA-scale grid (40 → effective 12).
func TestSlopeScalePerTerrain(t *testing.T) {
	// A 25-unit step up at cell x=10.
	mk := func(scale int) *Terrain {
		tr := testTerrain(40, 40, 0, func(cx, _ int) uint8 {
			if cx >= 10 {
				return 25
			}
			return 0
		})
		tr.SlopeScalePct = scale
		return tr
	}
	m := footMeta("araking", 2, true)
	m.MaxSlope = 30
	from := fixed.Vec2{X: fixed.FromInt(9*16 + 8), Z: fixed.FromInt(20 * 16)}
	to := fixed.Vec2{X: fixed.FromInt(10*16 + 8), Z: fixed.FromInt(20 * 16)}

	w := New(Config{Seed: 1})
	w.SetTerrain(mk(100))
	if !w.canTraverse(m, from, to) {
		t.Fatalf("TA:K scale (100): MaxSlope-30 unit should climb a 25-byte step")
	}
	w.SetTerrain(mk(40))
	if w.canTraverse(m, from, to) {
		t.Fatalf("TA scale (40): a 25-byte step exceeds the 12-effective limit, should be refused")
	}
}
