// tick-rate.js
//
// TA's authoritative simulation clock — exported as a single source of
// truth so callers (engine tick drivers, Step buttons, replay tools)
// import the constant instead of hard-coding 25 / 40 in a dozen places.
//
// TA's engine ticks COB scripts + locomotion at 30 Hz historically; we
// landed on 40 Hz after lining the on-screen aim/fire cadence up with
// the original game's feel.  Sim time is integrated in fixed steps of
// TA_TICK_MS so a "step one frame" debug action and a deterministic
// replay always advance the same amount of game time.
//
// To change the sim cadence, change TA_TICK_HZ here; nothing else needs
// to know.

export const TA_TICK_HZ = 40
export const TA_TICK_MS = 1000 / TA_TICK_HZ   // 25 ms at 40 Hz
