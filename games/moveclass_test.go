package games

import (
	"testing"

	"github.com/coreprime/kbot/engine/sim"
)

// moveclassTDF exercises the three class shapes that matter: a tank class
// declaring everything, a hover class omitting its water depth (the engines'
// permissive record default carries it over any water), and a boat class
// omitting maxslope.
const moveclassTDF = `[CLASS0]
	{
	Name=TANKTEST;
	FootprintX=2;
	FootprintZ=2;
	MaxWaterDepth=12;
	MaxSlope=15;
	}
[CLASS1]
	{
	Name=HOVERTEST;
	FootprintX=3;
	FootprintZ=3;
	MaxSlope=12;
	}
[CLASS2]
	{
	Name=BOATTEST;
	FootprintX=4;
	FootprintZ=4;
	MinWaterDepth=3;
	}
`

// TestApplyMovementClass pins the moveinfo override rule (locomotion spec
// §4.1): a resolved class replaces the unitdef's footprint and water/slope
// limits entirely — declared keys verbatim, omitted depth/slope keys at the
// permissive record default — while a classless or unknown name leaves the
// FBI values untouched.
func TestApplyMovementClass(t *testing.T) {
	classes, err := LoadMovementClasses([]byte(moveclassTDF))
	if err != nil {
		t.Fatal(err)
	}

	m := &sim.UnitMeta{MovementClass: "tanktest", FootprintX: 1, FootprintZ: 1,
		MaxSlope: 10, MaxWaterDepth: 99, MinWaterDepth: 7}
	ApplyMovementClass(m, classes)
	if m.FootprintX != 2 || m.FootprintZ != 2 || m.MaxSlope != 15 || m.MaxWaterDepth != 12 {
		t.Fatalf("class fields must replace the FBI's: %+v", m)
	}
	if m.MinWaterDepth != 0 {
		t.Fatalf("an omitted minwaterdepth resets to the record default 0, got %d", m.MinWaterDepth)
	}

	h := &sim.UnitMeta{MovementClass: "HOVERTEST", MaxWaterDepth: 0, MaxSlope: 16}
	ApplyMovementClass(h, classes)
	if h.MaxWaterDepth != permissiveClassDefault {
		t.Fatalf("hover class omits maxwaterdepth -> permissive default, got %d", h.MaxWaterDepth)
	}
	if h.MaxSlope != 12 {
		t.Fatalf("declared maxslope 12 expected, got %d", h.MaxSlope)
	}

	b := &sim.UnitMeta{MovementClass: "BOATTEST", MaxSlope: 10}
	ApplyMovementClass(b, classes)
	if b.MinWaterDepth != 3 || b.MaxSlope != permissiveClassDefault {
		t.Fatalf("boat class: minwaterdepth 3 + permissive maxslope, got %+v", b)
	}

	// Unknown / absent class names leave the meta untouched.
	u := &sim.UnitMeta{MovementClass: "NOSUCH", MaxSlope: 10}
	ApplyMovementClass(u, classes)
	if u.MaxSlope != 10 {
		t.Fatalf("unknown class must not modify the meta, got %+v", u)
	}
}
