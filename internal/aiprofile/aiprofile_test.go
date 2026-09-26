package aiprofile

import (
	"os"
	"strings"
	"testing"

	"github.com/coreprime/kbot-io/filesystem"
	"github.com/coreprime/kbot-io/formats/ai"
)

var testUnits = []ai.Unit{
	{Name: "ARMRAD", Categories: []string{"ARM", "LEVEL1", "SPECIAL"}},
	{Name: "ARMSOLAR", Categories: []string{"ARM", "LEVEL1", "PLANT"}},
	{Name: "CORFORT", Categories: []string{"CORE", "LEVEL1"}},
}

const testProfile = "weight armsolar 0.2\n" +
	"\n" +
	"plan easy\n" +
	"Weight ARM 0.2\n" +
	"Weight ARMRAD 0.25\n" +
	"Weight ARMRAD 4\n" +
	"Limit CORFORT O\n" +
	"Limit ARMSOLAR -2\n" +
	"Limit ARMRAD -1\n" +
	"Limit\tALL\t50\n"

func TestBuildLabelsPreamblePlansAndKinds(t *testing.T) {
	p := Build([]byte(testProfile), testUnits)
	if p.Preamble == nil || len(p.Preamble.Weights) != 1 || p.Preamble.Weights[0].Target != "ARMSOLAR" {
		t.Fatalf("preamble = %+v, want the weight line before the first plan", p.Preamble)
	}
	if len(p.Plans) != 1 || p.Plans[0].Name != "easy" {
		t.Fatalf("plans = %+v", p.Plans)
	}
	kinds := map[string]string{}
	for _, w := range p.Plans[0].Weights {
		kinds[w.Target] = w.Kind
	}
	if kinds["ARM"] != KindCategory || kinds["ARMRAD"] != KindUnit {
		t.Errorf("weight kinds = %v, want ARM a category and ARMRAD a unit", kinds)
	}
	limits := map[string]Limit{}
	for _, l := range p.Plans[0].Limits {
		limits[l.Target] = l
	}
	if l := limits["CORFORT"]; l.Maximum != 0 || !l.Forbids || l.Raw != "O" {
		t.Errorf("Limit CORFORT O = %+v, want 0 (forbidden) written as O", l)
	}
	if l := limits["ARMSOLAR"]; !l.Forbids || l.Unlimited {
		t.Errorf("Limit ARMSOLAR -2 = %+v, want forbidden", l)
	}
	if l := limits["ARMRAD"]; !l.Unlimited || l.Forbids {
		t.Errorf("Limit ARMRAD -1 = %+v, want unlimited", l)
	}
	if l := limits["ALL"]; l.Kind != KindAll || l.Maximum != 50 {
		t.Errorf("tab-separated Limit ALL 50 = %+v", l)
	}
	if len(p.Diagnostics) == 0 {
		t.Error("the non-numeric value O has no diagnostic")
	}
}

func TestBuildEffectiveSettings(t *testing.T) {
	p := Build([]byte(testProfile), testUnits)
	if len(p.Effective) != 3 {
		t.Fatalf("effective = %d difficulties, want 3", len(p.Effective))
	}
	easy := map[string]Setting{}
	for _, s := range p.Effective[0].Units {
		easy[s.Unit] = s
	}
	// ARM 0.2 takes ARMRAD to 20%, the unit line multiplies by 0.25 (5%) and
	// locks it, so the later ARMRAD 4 changes nothing.
	if s := easy["ARMRAD"]; s.WeightPercent != 5 || !s.WeightLocked {
		t.Errorf("ARMRAD on easy = %+v, want 5%% and locked", s)
	}
	if s := easy["CORFORT"]; !s.Forbidden || !s.LimitLocked {
		t.Errorf("CORFORT on easy = %+v, want forbidden and locked", s)
	}
	// The preamble's ARMSOLAR 0.2 is ignored at game start: only ARM 0.2.
	if s := easy["ARMSOLAR"]; s.WeightPercent != 20 {
		t.Errorf("ARMSOLAR on easy = %+v, want 20%% (preamble ignored)", s)
	}
	if n := len(p.Effective[2].Units); n != 0 {
		t.Errorf("hard has %d changed units; the only plan is easy", n)
	}
}

func TestBuildWithoutUnitTable(t *testing.T) {
	p := Build([]byte(testProfile), nil)
	if p.UnitsKnown || p.Effective != nil {
		t.Errorf("UnitsKnown=%v Effective=%v without a unit table", p.UnitsKnown, p.Effective)
	}
	if k := p.Plans[0].Weights[0].Kind; k != "" {
		t.Errorf("kind = %q without a unit table, want unknown", k)
	}
}

func TestLimitLabel(t *testing.T) {
	for max, want := range map[int]string{-1: "unlimited", 0: "disabled", -2: "disabled", -100: "disabled", 4: "max 4"} {
		if got := LimitLabel(max); got != want {
			t.Errorf("LimitLabel(%d) = %q, want %q", max, got, want)
		}
	}
}

// Retail ai/krogoth.txt: the two lines before the first plan are preamble,
// ARM is a category, CORFORT O forbids CORFORT.
func TestRetailKrogothProfile(t *testing.T) {
	root := os.Getenv("TA_UNPACKED_PATH")
	if root == "" {
		t.Skip("TA_UNPACKED_PATH not set")
	}
	vfs, err := filesystem.NewVirtualFileSystem(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = vfs.Close() }()
	data, err := vfs.ReadFile("ai/krogoth.txt")
	if err != nil {
		t.Skip("no ai/krogoth.txt:", err)
	}
	units := Units(vfs)
	if len(units) < 100 {
		t.Fatalf("unit table has %d units", len(units))
	}
	p := Build(data, units)
	if p.Preamble == nil || len(p.Preamble.Weights) != 2 {
		t.Fatalf("preamble = %+v, want CORMAKR and ARMMAKR", p.Preamble)
	}
	var sawCategory, sawCorfort bool
	for _, pl := range p.Plans {
		for _, w := range pl.Weights {
			if w.Target == "ARM" && w.Kind == KindCategory {
				sawCategory = true
			}
		}
		for _, l := range pl.Limits {
			if l.Target == "CORFORT" && strings.EqualFold(l.Raw, "O") && l.Forbids {
				sawCorfort = true
			}
		}
	}
	if !sawCategory || !sawCorfort {
		t.Errorf("ARM as a category: %v; Limit CORFORT O forbids: %v", sawCategory, sawCorfort)
	}
}
