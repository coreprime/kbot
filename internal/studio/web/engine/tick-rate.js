// tick-rate.js
//
// TA's authoritative simulation clock — exported as a single source of
// truth so callers (engine tick drivers, Step buttons, replay tools)
// import the constant instead of hard-coding the rate in a dozen places.
//
// Both original engines run their simulation at a nominal 30 Hz (scaled by
// game speed), and the Go sim now ticks on that same axis (sim.TickHz).
// Sim time is integrated in fixed steps of TA_TICK_MS so a "step one frame"
// debug action and a deterministic replay always advance the same amount of
// game time.
//
// To change the sim cadence, change TA_TICK_HZ here; nothing else needs
// to know.

export const TA_TICK_HZ = 30
export const TA_TICK_MS = 1000 / TA_TICK_HZ   // 33.33 ms at 30 Hz
