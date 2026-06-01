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
	for a := int32(0); a < FullCircle; a += 137 {
		sin, cos := SinCos(a)
		rad := AngleToRadians(a)
		if d := math.Abs(sin.Float() - math.Sin(rad)); d > 2e-3 {
			t.Errorf("sin(%d) off by %v", a, d)
		}
		if d := math.Abs(cos.Float() - math.Cos(rad)); d > 2e-3 {
			t.Errorf("cos(%d) off by %v", a, d)
		}
	}
}

func TestAtan2RoundTrip(t *testing.T) {
	// Atan2(sin, cos) should recover the original angle within a small margin.
	for a := int32(0); a < FullCircle; a += 257 {
		sin, cos := SinCos(a)
		got := Atan2(sin, cos)
		diff := ShortestArc(got - a)
		if diff < 0 {
			diff = -diff
		}
		if diff > 8 { // within ~0.05 degrees
			t.Errorf("atan2 round trip angle=%d got=%d diff=%d", a, got, diff)
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
