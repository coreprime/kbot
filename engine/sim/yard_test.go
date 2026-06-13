package sim

import (
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/order"
)

// labYard is the Kbot-lab pattern: solid flanks, a two-cell exit channel
// down the middle that opens with the yard, passable corners.
const labYard = "yoccoy ooccoo ooccoo ooccoo ooccoo yoccoy"

func labMeta() *UnitMeta {
	m := testMeta("lab")
	m.CanMove = false
	m.Weapons[0] = WeaponMeta{}
	m.FootprintX = 6
	m.FootprintZ = 6
	m.Yard = ParseYardMap(labYard, 6, 6)
	return m
}

func TestParseYardMap(t *testing.T) {
	cells := ParseYardMap(labYard, 6, 6)
	if len(cells) != 36 {
		t.Fatalf("got %d cells, want 36", len(cells))
	}
	counts := map[yardCell]int{}
	for _, c := range cells {
		counts[c]++
	}
	// 4 passable corners, 2 openable columns × 6 rows, the rest solid.
	if counts[yardPassable] != 4 || counts[yardOpenable] != 12 || counts[yardSolid] != 20 {
		t.Fatalf("cell mix passable=%d openable=%d solid=%d",
			counts[yardPassable], counts[yardOpenable], counts[yardSolid])
	}
	// Short strings pad with solid; empty yields nil.
	if got := ParseYardMap("oo", 2, 2); len(got) != 4 || got[2] != yardSolid {
		t.Fatalf("short map not padded solid: %v", got)
	}
	if ParseYardMap("", 2, 2) != nil {
		t.Fatalf("empty map should be nil")
	}
}

// TestYardChannelOpensWithYard pins the cell query: the exit channel blocks
// while the yard is closed and clears when it opens; the solid flanks block
// either way.
func TestYardChannelOpensWithYard(t *testing.T) {
	w := New(Config{Seed: 81})
	id := w.AddUnit("lab", labMeta(), nil, fixed.Vec2{}, 0, 0)
	s := w.UnitByID(id)
	r := fixed.FromInt(6)
	channel := fixed.Vec2{}                     // dead centre, on the channel
	flank := fixed.Vec2{X: fixed.FromInt(-24)}  // solid west columns
	corner := fixed.Vec2{X: fixed.FromInt(-44), Z: fixed.FromInt(-44)}
	if !yardCircleOverlaps(s, channel, r) {
		t.Fatalf("closed channel should block")
	}
	if !yardCircleOverlaps(s, flank, r) {
		t.Fatalf("solid flank should block")
	}
	s.yardOpen = true
	if yardCircleOverlaps(s, channel, fixed.FromInt(3)) {
		t.Fatalf("open channel should be passable")
	}
	if !yardCircleOverlaps(s, flank, r) {
		t.Fatalf("solid flank should block even when open")
	}
	// The passable corner cell never blocks a snug body.
	s.yardOpen = false
	if yardCircleOverlaps(s, corner, fixed.One) {
		t.Fatalf("y corner should be passable")
	}
}

// TestYardRotationCollides pins rotation awareness: a 2×6 structure turned
// 90° blocks along world X where its unrotated silhouette would be clear.
func TestYardRotationCollides(t *testing.T) {
	w := New(Config{Seed: 82})
	m := testMeta("wall")
	m.CanMove = false
	m.Weapons[0] = WeaponMeta{}
	m.FootprintX = 2 // 16 wu wide ...
	m.FootprintZ = 6 // ... 48 wu deep
	upright := w.UnitByID(w.AddUnit("wall", m, nil, fixed.Vec2{}, 0, 0))
	turned := w.UnitByID(w.AddUnit("wall", m, nil, fixed.Vec2{X: fixed.FromInt(500)}, 16384, 0))

	// 40 wu out along world X: outside the upright's 16 wu half-width,
	// inside the turned one's 48 wu reach.
	probe := fixed.FromInt(40)
	r := fixed.FromInt(4)
	if yardCircleOverlaps(upright, fixed.Vec2{X: probe}, r) {
		t.Fatalf("upright wall should be clear 20wu out on X")
	}
	at := fixed.Vec2{X: turned.loco.Pos.X + probe, Z: turned.loco.Pos.Z}
	if !yardCircleOverlaps(turned, at, r) {
		t.Fatalf("rotated wall should block 20wu out on X")
	}
	// And the turned structure is now clear along world Z instead.
	at = fixed.Vec2{X: turned.loco.Pos.X, Z: turned.loco.Pos.Z + probe}
	if yardCircleOverlaps(turned, at, r) {
		t.Fatalf("rotated wall should be clear 20wu out on Z")
	}
}

// TestMoverNeverEntersClosedYard is the integration backstop: a kbot ordered
// straight through a closed lab is held out of its solid cells every tick.
func TestMoverNeverEntersClosedYard(t *testing.T) {
	w := New(Config{Seed: 83})
	lab := w.UnitByID(w.AddUnit("lab", labMeta(), nil, fixed.Vec2{}, 0, 0))
	kb := w.AddUnit("kbot", testMeta("kbot"), nil, fixed.Vec2{X: fixed.FromInt(-200)}, 0, 0)
	w.ApplyOrder(order.Stance([]uint32{kb}, order.MoveHold, order.FireHold))
	w.ApplyOrder(order.Move([]uint32{kb}, fixed.Vec2{X: fixed.FromInt(200)}))
	u := w.UnitByID(kb)
	hx, hz := yardHalfExtents(lab.Meta)
	for i := 0; i < 1000; i++ {
		w.Step(nil)
		// The mover's centre must never land in a cell the closed yard
		// blocks (the passable y-corners are legal shortcuts).
		l := yardLocal(lab, u.loco.Pos)
		if l.X.Abs() < hx && l.Z.Abs() < hz {
			cx := (l.X + hx).Div(yardSquareWU).Int()
			cz := (l.Z + hz).Div(yardSquareWU).Int()
			if yardCellBlocks(lab, cx, cz) {
				t.Fatalf("tick %d: mover inside blocked cell (%d,%d) at (%v, %v)",
					i, cx, cz, u.loco.Pos.X.Float(), u.loco.Pos.Z.Float())
			}
		}
	}
}

// TestFactoryYardOpensWhileProducing pins the open/close cycle: the yard
// opens when production starts and closes after the line drains and the
// finished units clear the pad.
func TestFactoryYardOpensWhileProducing(t *testing.T) {
	w := factoryWorld()
	fm := factoryMeta()
	fm.Yard = ParseYardMap(labYard, 6, 6)
	fac := w.AddUnit("factory", fm, nil, fixed.Vec2{}, 0, 0)
	u := w.UnitByID(fac)
	w.Step(nil)
	if u.yardOpen {
		t.Fatalf("idle factory yard should be closed")
	}
	w.ApplyOrder(order.Build(fac, "tank", fixed.Vec2{}, 0))
	w.Step(nil)
	if !u.yardOpen {
		t.Fatalf("producing factory yard should be open")
	}
	for i := 0; i < 40*60 && u.yardOpen; i++ {
		w.Step(nil)
	}
	if u.yardOpen {
		t.Fatalf("yard never closed after the line drained")
	}
}
