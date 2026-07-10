package sandboxverify

import (
	"path/filepath"
	"runtime"
	"testing"
)

func TestSpecToSimTick(t *testing.T) {
	// 30 Hz spec frames onto the sandbox's 40 Hz axis: 3 spec frames = 4
	// sim ticks exactly; intermediate frames round to nearest.
	cases := map[int]uint64{0: 0, 1: 1, 3: 4, 10: 13, 30: 40, 90: 120}
	for spec, want := range cases {
		if got := specToSimTick(spec); got != want {
			t.Errorf("specToSimTick(%d) = %d, want %d", spec, got, want)
		}
	}
	if s := skewMs(30, specToSimTick(30)); s != 0 {
		t.Errorf("1s boundary should have zero skew, got %d", s)
	}
	if s := skewMs(10, specToSimTick(10)); s == 0 {
		t.Errorf("frame 10 cannot align on a 40 Hz axis; want nonzero skew")
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

func TestMulberryDrawCount(t *testing.T) {
	// The draw counter inverts the per-draw state increment; check the
	// modular inverse constant against the generator's step.
	step, inv := mulberryStep, mulberryStepInv
	if step*inv != 1 {
		t.Fatalf("mulberryStepInv is not the inverse of the step")
	}
	var state uint32 = 12345
	var draws uint32 = 7
	after := state + draws*step
	if got := (after - state) * inv; got != draws {
		t.Errorf("recovered %d draws, want %d", got, draws)
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
