// Package fixed provides a deterministic Q16.16 fixed-point number type and
// the trigonometric/root primitives the simulation needs.
//
// The engine compiles to two targets: a native server build and a
// GOOS=js/GOARCH=wasm browser build. For client-side prediction to agree
// with the authoritative server, identical inputs must produce bit-identical
// outputs on both. Go's math package uses architecture-specific assembly for
// sin/cos/sqrt on amd64/arm64 but pure-Go fallbacks on wasm, so the two
// targets can disagree in the low bits. Everything here is integer-only
// (int64 arithmetic and shifts behave identically on every Go target), so the
// simulation never touches a hardware float and stays reproducible.
package fixed

// Fixed is a Q16.16 signed fixed-point value stored in an int64. The wide
// backing integer keeps multiply intermediates from overflowing across the
// coordinate ranges Total Annihilation maps use (positions stay well under
// 2^15 world units).
type Fixed int64

const (
	// FracBits is the number of fractional bits in the Q16.16 layout.
	FracBits = 16
	// One is the fixed-point representation of 1.0.
	One Fixed = 1 << FracBits
	// Half is the fixed-point representation of 0.5.
	Half Fixed = One >> 1
	// Zero is the fixed-point representation of 0.0.
	Zero Fixed = 0
)

// FromInt converts a whole number to fixed-point.
func FromInt(i int) Fixed { return Fixed(i) << FracBits }

// FromFloat converts a float to fixed-point. This is the ONLY bridge from
// non-deterministic floats and must only be used at the system boundary
// (parsing FBI/asset values, decoding orders) — never inside the tick loop.
func FromFloat(f float64) Fixed { return Fixed(f * float64(One)) }

// Float renders a fixed-point value back to float64 for rendering/debug. Never
// feed the result back into the simulation.
func (a Fixed) Float() float64 { return float64(a) / float64(One) }

// Int truncates toward zero to a whole number.
func (a Fixed) Int() int { return int(a >> FracBits) }

// Mul multiplies two fixed-point values.
func (a Fixed) Mul(b Fixed) Fixed { return Fixed((int64(a) * int64(b)) >> FracBits) }

// Div divides a by b. Caller must ensure b != 0.
func (a Fixed) Div(b Fixed) Fixed { return Fixed((int64(a) << FracBits) / int64(b)) }

// Abs returns the absolute value.
func (a Fixed) Abs() Fixed {
	if a < 0 {
		return -a
	}
	return a
}

// Min returns the smaller of a, b.
func Min(a, b Fixed) Fixed {
	if a < b {
		return a
	}
	return b
}

// Max returns the larger of a, b.
func Max(a, b Fixed) Fixed {
	if a > b {
		return a
	}
	return b
}

// Clamp constrains a to the inclusive range [lo, hi].
func Clamp(a, lo, hi Fixed) Fixed {
	if a < lo {
		return lo
	}
	if a > hi {
		return hi
	}
	return a
}

// Sign returns -1, 0 or +1 as a plain int.
func (a Fixed) Sign() int {
	switch {
	case a < 0:
		return -1
	case a > 0:
		return 1
	default:
		return 0
	}
}

// Sqrt returns the non-negative square root using integer Newton iteration.
// Negative inputs return 0. Fully deterministic across targets.
func (a Fixed) Sqrt() Fixed {
	if a <= 0 {
		return 0
	}
	// We want sqrt(a/One)*One = sqrt(a*One). Work on the int64 product
	// a*One and take an integer sqrt; the result is already in Q16.16.
	n := int64(a) << FracBits
	if n < 0 { // overflowed the shift; fall back to a scaled estimate.
		// a is huge; sqrt(a)*One ≈ isqrt(a)<<(FracBits/2) won't be exact but
		// such magnitudes never occur in the sim. Keep it monotone.
		return Fixed(isqrt(int64(a)) << (FracBits / 2))
	}
	return Fixed(isqrt(n))
}

// isqrt is the integer square root (floor) of a non-negative int64.
func isqrt(n int64) int64 {
	if n <= 0 {
		return 0
	}
	// Seed with a power-of-two estimate, then refine with Newton's method.
	x := n
	y := (x + 1) >> 1
	for y < x {
		x = y
		y = (x + n/x) >> 1
	}
	return x
}

// Hypot returns sqrt(x*x + y*y), computed on the raw 64-bit sum of squares so
// no low bits are shed before the root (a Q16.16 pre-shift would truncate and
// read one raw unit short on exact distances — the engines compute move
// distances through the FPU, which keeps them exact at this scale). The
// uint64 sum cannot overflow for any pair of 32-bit-wrapped coordinates.
func Hypot(x, y Fixed) Fixed {
	xx, yy := int64(x), int64(y)
	s := uint64(xx*xx) + uint64(yy*yy)
	return Fixed(usqrt(s))
}

// usqrt is the integer square root (floor) of a uint64.
func usqrt(n uint64) int64 {
	if n == 0 {
		return 0
	}
	x := n
	y := (x + 1) >> 1
	for y < x {
		x = y
		y = (x + n/x) >> 1
	}
	return int64(x)
}
