package sandboxverify

import (
	"path/filepath"
	"runtime"
	"testing"

	"github.com/coreprime/kbot-engine/engine/rng"
)

func TestSpecToSimTick(t *testing.T) {
	// The sandbox ticks on the engines' 30 Hz axis, so spec frames map 1:1
	// onto sim ticks with zero cadence skew at every sample point.
	for _, spec := range []int{0, 1, 3, 10, 30, 90, 900} {
		if got := specToSimTick(spec); got != uint64(spec) {
			t.Errorf("specToSimTick(%d) = %d, want %d", spec, got, spec)
		}
		if s := skewMs(spec, specToSimTick(spec)); s != 0 {
			t.Errorf("frame %d skew = %dms, want 0 on the aligned axis", spec, s)
		}
	}
}

func TestGradeRules(t *testing.T) {
	base := CheckSpec{Expect: 100}
	if v, _ := grade(base, 100, true, ""); v != VerdictFaithful {
		t.Errorf("exact match should be faithful, got %s", v)
	}
	if v, _ := grade(base, 90, true, ""); v != VerdictWrong {
		t.Errorf("divergent value should be wrong, got %s", v)
	}
	if v, _ := grade(base, 0, false, "no such order"); v != VerdictMissing {
		t.Errorf("unsampled check should be missing, got %s", v)
	}
	mz := CheckSpec{Expect: 100, MissingIfZero: true}
	if v, _ := grade(mz, 0, true, ""); v != VerdictMissing {
		t.Errorf("zero effect with missing_if_zero should be missing, got %s", v)
	}
	if v, _ := grade(mz, 40, true, ""); v != VerdictWrong {
		t.Errorf("nonzero divergence stays wrong even with missing_if_zero, got %s", v)
	}
	cos := CheckSpec{Expect: 100, Cosmetic: true}
	if v, _ := grade(cos, 90, true, ""); v != VerdictCosmeticGap {
		t.Errorf("cosmetic mismatch should be cosmetic-gap, got %s", v)
	}
}

func TestRngDrawCount(t *testing.T) {
	// The rng_draws observable reads the MINSTD stream's own advance counter;
	// a bound below 2 must not register as a draw (the engines' short-circuit
	// skips the state update entirely).
	m := rng.NewMinStd(1)
	m.Bounded(100)
	m.Bounded(1) // no advance
	m.Bounded(65536)
	if got := m.Draws(); got != 2 {
		t.Errorf("draw counter = %d, want 2 (bound<2 must not count)", got)
	}
}

func TestSeedScenariosParse(t *testing.T) {
	_, self, _, _ := runtime.Caller(0)
	dir := filepath.Join(filepath.Dir(self), "..", "..", "scenarios", "sandbox")
	scenarios, err := LoadDir(dir)
	if err != nil {
		t.Fatalf("loading seed scenarios: %v", err)
	}
	if len(scenarios) == 0 {
		t.Fatal("no seed scenarios found")
	}
	for _, s := range scenarios {
		for i, c := range s.Checks {
			if c.Derivation == "" {
				t.Errorf("%s check %d has no derivation", s.Name, i)
			}
		}
	}
}

func TestBuildMatrix(t *testing.T) {
	rows := BuildMatrix([]ScenarioResult{
		{System: "locomotion", Game: "ta", Checks: []CheckResult{
			{Verdict: VerdictFaithful}, {Verdict: VerdictWrong}, {Verdict: VerdictWrong},
		}},
		{System: "locomotion", Game: "ta", Checks: []CheckResult{{Verdict: VerdictMissing}}},
		{System: "combat", Game: "tak", Checks: []CheckResult{{Verdict: VerdictCosmeticGap}}},
	})
	if len(rows) != 2 {
		t.Fatalf("want 2 matrix rows, got %d", len(rows))
	}
	if rows[0].System != "combat" || rows[0].Cosmetic != 1 {
		t.Errorf("combat/tak row wrong: %+v", rows[0])
	}
	if rows[1].Faithful != 1 || rows[1].Wrong != 2 || rows[1].Missing != 1 {
		t.Errorf("locomotion/ta row wrong: %+v", rows[1])
	}
}
