package fixed

// Storage-width enforcement. The original engines keep positions, velocities
// and speed scalars in signed 32-bit 16.16 fields: multiply intermediates are
// 64-bit but every stored value truncates back to 32 bits and wraps by two's
// complement. Fixed's int64 backing never wraps on its own, so sim state
// assignments pass through Wrap32 to reproduce the storage contract. Angle
// fields are 16-bit (see WrapAngle in trig.go); WrapAngleFx applies the same
// fold to a fractional TA-angle carried in a Fixed.

// Wrap32 truncates a Q16.16 value to the engines' int32 storage width,
// wrapping by two's complement.
func Wrap32(a Fixed) Fixed { return Fixed(int32(a)) }

// WrapAngleFx folds a fractional TA-angle (Q16.16, 65536 units per circle)
// into the int16 storage convention [-32768.0, 32768.0), preserving the
// fractional part the sandbox accumulates between whole-unit turns.
func WrapAngleFx(a Fixed) Fixed {
	const full = int64(FullCircle) << FracBits
	v := int64(a) & (full - 1)
	if v >= full/2 {
		v -= full
	}
	return Fixed(v)
}
