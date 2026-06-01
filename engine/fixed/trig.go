package fixed

// Angles use Total Annihilation's native unit: a full turn is 65536, matching
// the COB integer angle scale. Storing headings as int32 TA-angles (rather
// than radians) keeps the whole sim in integers and reproducible.
const (
	FullCircle    int32 = 65536
	HalfCircle    int32 = 32768
	QuarterCircle int32 = 16384
)

// cordicAtan is atan(2^-i) expressed in TA-angle units (65536 = full turn),
// hardcoded so the table is identical on every build target. Computing it at
// init via math.Atan would reintroduce the cross-platform float divergence
// this package exists to avoid.
var cordicAtan = [16]int32{
	8192, 4836, 2556, 1297, 651, 326, 163, 81,
	41, 20, 10, 5, 3, 1, 1, 0,
}

// cordicGain is the CORDIC scaling constant K (~0.60725) in Q16.16, used as the
// initial x so the rotated vector comes out unit-length.
const cordicGain Fixed = 39797

// NormalizeAngle folds any TA-angle into [0, 65536).
func NormalizeAngle(a int32) int32 {
	a %= FullCircle
	if a < 0 {
		a += FullCircle
	}
	return a
}

// ShortestArc maps a TA-angle delta into (-32768, 32768] — the shortest signed
// turn between two headings.
func ShortestArc(a int32) int32 {
	a = a % FullCircle
	if a > HalfCircle {
		a -= FullCircle
	}
	if a <= -HalfCircle {
		a += FullCircle
	}
	return a
}

// cordicRot rotates the unit vector by r (TA-angle in [0, QuarterCircle]) and
// returns (sin, cos) in Q16.16. r must lie in the first quadrant.
func cordicRot(r int32) (sin, cos Fixed) {
	x, y := cordicGain, Fixed(0)
	z := r
	for i := 0; i < 16; i++ {
		dx := x >> uint(i)
		dy := y >> uint(i)
		if z >= 0 {
			x -= dy
			y += dx
			z -= cordicAtan[i]
		} else {
			x += dy
			y -= dx
			z += cordicAtan[i]
		}
	}
	return y, x
}

// SinCos returns the sine and cosine of a TA-angle as Q16.16 values in
// [-One, One]. It reduces to the first quadrant and applies exact symmetry,
// keeping CORDIC inside its convergence range.
func SinCos(angle int32) (sin, cos Fixed) {
	a := NormalizeAngle(angle)
	quad := a / QuarterCircle
	r := a % QuarterCircle
	s, c := cordicRot(r)
	switch quad {
	case 0:
		return s, c
	case 1:
		return c, -s
	case 2:
		return -s, -c
	default:
		return -c, s
	}
}

// Sin returns the sine of a TA-angle in Q16.16.
func Sin(angle int32) Fixed { s, _ := SinCos(angle); return s }

// Cos returns the cosine of a TA-angle in Q16.16.
func Cos(angle int32) Fixed { _, c := SinCos(angle); return c }

// Atan2 returns the TA-angle of the vector (x, y) measured the way the engine's
// heading convention expects: it mirrors JS Math.atan2(y, x). Pass the
// "sine-side" component as y and the "cosine-side" as x. Heading toward a
// target at delta (dx, dz) is therefore Atan2(dx, dz). The result is in
// [0, 65536).
func Atan2(y, x Fixed) int32 {
	if x == 0 && y == 0 {
		return 0
	}
	ax, ay := x.Abs(), y.Abs()
	vx, vy := ax, ay
	var z int32
	for i := 0; i < 16; i++ {
		dx := vx >> uint(i)
		dy := vy >> uint(i)
		if vy > 0 {
			vx += dy
			vy -= dx
			z += cordicAtan[i]
		} else {
			vx -= dy
			vy += dx
			z -= cordicAtan[i]
		}
	}
	// z is atan(|y|/|x|) in the first quadrant; fold by the true signs.
	switch {
	case x >= 0 && y >= 0:
		return NormalizeAngle(z)
	case x < 0 && y >= 0:
		return NormalizeAngle(HalfCircle - z)
	case x < 0 && y < 0:
		return NormalizeAngle(HalfCircle + z)
	default: // x >= 0 && y < 0
		return NormalizeAngle(FullCircle - z)
	}
}

// RadiansToAngle converts a radian float to a TA-angle. Boundary-only helper —
// never call inside the tick loop.
func RadiansToAngle(rad float64) int32 {
	const twoPi = 6.283185307179586
	return NormalizeAngle(int32(rad / twoPi * float64(FullCircle)))
}

// AngleToRadians converts a TA-angle to radians for rendering/debug only.
func AngleToRadians(a int32) float64 {
	const twoPi = 6.283185307179586
	return float64(a) / float64(FullCircle) * twoPi
}
