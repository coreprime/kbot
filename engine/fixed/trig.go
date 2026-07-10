package fixed

// Angles use Total Annihilation's native unit: a full turn is 65536, matching
// the COB integer angle scale. The engines store orientation angles in 16-bit
// fields and rely on natural two's-complement wraparound; WrapAngle applies
// that storage convention. Sine and cosine come from the shared 512-entry
// amplitude-8192 sine table with the engines' exact index and product
// rounding, so trig results are bit-identical to the originals.
const (
	FullCircle    int32 = 65536
	HalfCircle    int32 = 32768
	QuarterCircle int32 = 16384
)

// WrapAngle folds a TA-angle into the engines' int16 storage convention
// [-32768, 32767] via two's-complement truncation.
func WrapAngle(a int32) int32 { return int32(int16(a)) }

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

// sinEntry reads the table entry for a TA-angle using the engines' rounded
// byte-offset indexing: offset ((a+0x20)>>6)&0x3fe into the int16 table (the
// +0x20 rounds to the nearest of the 512 steps; the mask wraps the circle and
// clears the odd byte). Amplitude is 8192 = 1.0.
func sinEntry(angle int32) int32 {
	off := ((angle + 0x20) >> 6) & 0x3fe
	return int32(sineTable[off>>1])
}

// SinScaled returns sin(angle)*scale with the engines' exact product rounding:
// the amplitude-8192 table entry times the 16.16 scale, +0x1000 half-up, >>13.
// The result is in the same 16.16 domain as scale.
func SinScaled(angle int32, scale Fixed) Fixed {
	return Fixed((int64(sinEntry(angle))*int64(scale) + 0x1000) >> 13)
}

// CosScaled is SinScaled a quarter circle ahead (the engines bias the angle by
// 0x4020 = quarter circle + index rounding, which sinEntry's own +0x20 covers).
func CosScaled(angle int32, scale Fixed) Fixed {
	return SinScaled(angle+QuarterCircle, scale)
}

// SinCos returns the sine and cosine of a TA-angle as Q16.16 values in
// [-One, One], read from the engine sine table (13-bit amplitude widened by
// <<3, so results are quantized to multiples of 8).
func SinCos(angle int32) (sin, cos Fixed) {
	return Sin(angle), Cos(angle)
}

// Sin returns the sine of a TA-angle in Q16.16, table-quantized.
func Sin(angle int32) Fixed { return Fixed(int64(sinEntry(angle)) << 3) }

// Cos returns the cosine of a TA-angle in Q16.16, table-quantized.
func Cos(angle int32) Fixed { return Fixed(int64(sinEntry(angle+QuarterCircle)) << 3) }

// cordicAtan is atan(2^-i) expressed in TA-angle units (65536 = full turn),
// hardcoded so the table is identical on every build target. Computing it at
// init via math.Atan would reintroduce the cross-platform float divergence
// this package exists to avoid.
var cordicAtan = [16]int32{
	8192, 4836, 2556, 1297, 651, 326, 163, 81,
	41, 20, 10, 5, 3, 1, 1, 0,
}

// Atan2 returns the TA-angle of the vector (x, y) measured the way the engine's
// heading convention expects: it mirrors JS Math.atan2(y, x). Pass the
// "sine-side" component as y and the "cosine-side" as x. Heading toward a
// target at delta (dx, dz) is therefore Atan2(dx, dz). The result is in
// [0, 65536). Still CORDIC: the originals compute bearings through x87 fpatan,
// whose exact bit behaviour is an open item (substrate UNKNOWN TA-6), so this
// integer approximation stands until a validated replica exists.
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
