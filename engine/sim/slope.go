package sim

// SlopeSpeedPct is the shared engine slope-speed table: both games cap a
// ground unit's speed by the same 11-entry percent lookup, indexed by the
// unit's pitch band. The centre entry is flat ground (100%); positive bands
// (uphill) fall off faster than negative ones (downhill), so the table is
// deliberately asymmetric.
//
// The ground integrator caps every mover's speed through it each frame,
// indexed by the pitch the terrain ground-follow measures (terrain.go).
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

// takSlopeFactorFx holds TA:K's 16.16 slope factors: the engine converts each
// percent through one ×0.01 float multiply of (pct<<16) with truncation
// toward zero, so the factors are trunc(pct·65536/100) — a slightly coarser
// rounding than TA's single /100 (visible only off the 100% bands). Values,
// band −5..+5: 25→16384, 55→36044, 70→45875, 85→55705, 100→65536, 100→65536,
// 75→49152, 50→32768, 25→16384, 20→13107, 15→9830.
var takSlopeFactorFx = [11]int32{16384, 36044, 45875, 55705, 65536, 65536, 49152, 32768, 16384, 13107, 9830}

// takSlopeFactor returns TA:K's truncated 16.16 speed factor for a unit
// pitch, with the same band = pitch >> 11 clamp as SlopeSpeedFactor.
func takSlopeFactor(pitch int32) int32 {
	band := pitch >> 11
	if band < -5 {
		band = -5
	}
	if band > 5 {
		band = 5
	}
	return takSlopeFactorFx[band+5]
}
