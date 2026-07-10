package sim

// SlopeSpeedPct is the shared engine slope-speed table: both games cap a
// ground unit's speed by the same 11-entry percent lookup, indexed by the
// unit's pitch band. The centre entry is flat ground (100%); positive bands
// (uphill) fall off faster than negative ones (downhill), so the table is
// deliberately asymmetric.
//
// This is substrate data — the locomotion pass consumes it once unit pitch is
// modelled (the sandbox does not yet track per-unit pitch, so nothing indexes
// it in anger today).
var SlopeSpeedPct = [11]int32{25, 55, 70, 85, 100, 100, 75, 50, 25, 20, 15}

// SlopeSpeedFactor returns the percent speed cap for a unit pitch (int16
// TA-angle): band = pitch >> 11 (arithmetic, sign preserved), clamped to
// [-5, +5], centred into the table.
func SlopeSpeedFactor(pitch int32) int32 {
	band := pitch >> 11
	if band < -5 {
		band = -5
	}
	if band > 5 {
		band = 5
	}
	return SlopeSpeedPct[band+5]
}
