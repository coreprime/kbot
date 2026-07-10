package fixed

import (
	"math"
	"testing"
)

func TestMulDiv(t *testing.T) {
	a := FromFloat(3.5)
	b := FromFloat(2.0)
	if got := a.Mul(b).Float(); math.Abs(got-7.0) > 1e-4 {
		t.Errorf("3.5*2.0 = %v, want 7.0", got)
	}
	if got := a.Div(b).Float(); math.Abs(got-1.75) > 1e-4 {
		t.Errorf("3.5/2.0 = %v, want 1.75", got)
	}
}

func TestSqrtHypot(t *testing.T) {
	for _, v := range []float64{0, 1, 2, 4, 100, 2500, 0.25} {
		got := FromFloat(v).Sqrt().Float()
		want := math.Sqrt(v)
		if math.Abs(got-want) > 1e-2 {
			t.Errorf("sqrt(%v) = %v, want %v", v, got, want)
		}
	}
	got := Hypot(FromInt(3), FromInt(4)).Float()
	if math.Abs(got-5.0) > 1e-2 {
		t.Errorf("hypot(3,4) = %v, want 5", got)
	}
}

func TestSinCosAccuracy(t *testing.T) {
	// The engine sine table has 512 entries per circle indexed by the
	// asymmetric snap floor((a+32)/128): worst-case angle error is 96 units
	// (2pi*96/65536 rad), so the value error bound is sin of that plus the
	// 1/8192 amplitude quantum.
	const tol = 9.5e-3
	for a := int32(0); a < FullCircle; a += 137 {
		sin, cos := SinCos(a)
		rad := AngleToRadians(a)
		if d := math.Abs(sin.Float() - math.Sin(rad)); d > tol {
			t.Errorf("sin(%d) off by %v", a, d)
		}
		if d := math.Abs(cos.Float() - math.Cos(rad)); d > tol {
			t.Errorf("cos(%d) off by %v", a, d)
		}
	}
}

func TestSineTableAnchors(t *testing.T) {
	// Entries verified against both engines' data-segment dumps (substrate
	// spec: entry 0 = 0, 1 = 101, 64 = 5793, 128 = 8192, 256 = 0, 384 = -8192).
	anchors := map[int]int16{0: 0, 1: 101, 64: 5793, 128: 8192, 256: 0, 384: -8192}
	for i, want := range anchors {
		if got := sineTable[i]; got != want {
			t.Errorf("sineTable[%d] = %d, want %d", i, got, want)
		}
	}
}

func TestSinScaledWorkedExamples(t *testing.T) {
	// TA worked example: heading 0x2000 (45 deg), speed 0x18000 ->
	// (5793*0x18000 + 0x1000) >> 13 = 69516. TA:K: speed 0x1E000 -> 86895.
	if got := SinScaled(0x2000, 0x18000); got != 69516 {
		t.Errorf("SinScaled(0x2000, 0x18000) = %d, want 69516", got)
	}
	if got := SinScaled(0x2000, 0x1E000); got != 86895 {
		t.Errorf("SinScaled(0x2000, 0x1E000) = %d, want 86895", got)
	}
	// Cosine at 45 deg matches sine (entry 192 = entry 64 = 5793).
	if got := CosScaled(0x2000, 0x18000); got != 69516 {
		t.Errorf("CosScaled(0x2000, 0x18000) = %d, want 69516", got)
	}
	// Index rounding: +0x20 pushes an angle just under a half-step onto the
	// next entry; 0x1FE0 rounds to the same entry as 0x2000.
	if SinScaled(0x1FE0, One) != SinScaled(0x2000, One) {
		t.Errorf("index rounding: 0x1FE0 should share entry 64 with 0x2000")
	}
}

func TestWrapWidths(t *testing.T) {
	if got := WrapAngle(0x7F00 + 0x180); got != -0x7F80 {
		t.Errorf("WrapAngle(0x8080) = %d, want %d (int16 wrap)", got, -0x7F80)
	}
	if got := Wrap32(Fixed(1) << 33); got != 0 {
		t.Errorf("Wrap32(2^33) = %d, want 0", got)
	}
	if got := Wrap32(FromInt(3)); got != FromInt(3) {
		t.Errorf("Wrap32 must not disturb in-range values")
	}
	// WrapAngleFx folds the integer part on the int16 boundary, keeping the
	// fraction: 32768.25 -> -32767.75.
	in := FromInt(32768) + Fixed(1<<14)
	want := FromInt(-32768) + Fixed(1<<14)
	if got := WrapAngleFx(in); got != want {
		t.Errorf("WrapAngleFx(32768.25) = %v, want %v", got, want)
	}
}

func TestAtan2RoundTrip(t *testing.T) {
	// Atan2(sin, cos) should recover the angle the sine table actually
	// represented. The engine index rounding maps a to entry floor((a+32)/128)
	// — a deliberately asymmetric snap — so the reference is that quantized
	// step, recovered within the CORDIC atan margin.
	for a := int32(0); a < FullCircle; a += 257 {
		sin, cos := SinCos(a)
		got := Atan2(sin, cos)
		q := ((a + 0x20) >> 7) << 7
		diff := ShortestArc(got - q)
		if diff < 0 {
			diff = -diff
		}
		if diff > 4 {
			t.Errorf("atan2 round trip angle=%d (step %d) got=%d diff=%d", a, q, got, diff)
		}
	}
}

func TestShortestArc(t *testing.T) {
	cases := []struct{ in, want int32 }{
		{0, 0},
		{HalfCircle, HalfCircle},
		{HalfCircle + 1, -(HalfCircle - 1)},
		{FullCircle, 0},
		{-1, -1},
		{FullCircle + 100, 100},
	}
	for _, c := range cases {
		if got := ShortestArc(c.in); got != c.want {
			t.Errorf("ShortestArc(%d) = %d, want %d", c.in, got, c.want)
		}
	}
}

// TestDeterminism guards the property the whole package exists for: identical
// inputs yield identical bits on repeated evaluation (and, by construction of
// using only int64 ops, across build targets).
func TestDeterminism(t *testing.T) {
	for a := int32(-200000); a < 200000; a += 991 {
		s1, c1 := SinCos(a)
		s2, c2 := SinCos(a)
		if s1 != s2 || c1 != c2 {
			t.Fatalf("SinCos(%d) not stable", a)
		}
	}
}
