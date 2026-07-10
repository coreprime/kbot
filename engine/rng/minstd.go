package rng

// MinStd is the Park–Miller MINSTD generator both target engines use for
// every sim-affecting draw: state' = 16807·state mod (2^31−1), computed with
// Schrage's decomposition in wrapping 32-bit arithmetic exactly as the
// engines do, including their two quirks — a bound below 2 returns 0 without
// advancing the state, and the reduction to a bound is a plain (biased)
// modulo. Draws counts state advances so a harness can measure consumption
// between two observations.
type MinStd struct {
	state uint32
	draws uint64
}

// minStdSeedMask is the transform both engines apply to the raw seed before
// storing it: xor with a fixed mask, then force the low bit so the state is
// never zero.
const minStdSeedMask uint32 = 0x66E29572

// NewMinStd seeds a MINSTD stream with the engines' seed transform
// (seed ^ mask) | 1. The originals feed a per-machine performance-counter
// value here once per game session; the sandbox supplies a deterministic
// seed so lockstep peers draw identically.
func NewMinStd(seed uint32) *MinStd {
	return &MinStd{state: (seed ^ minStdSeedMask) | 1}
}

// Bounded advances the generator and reduces the draw modulo bound. A bound
// below 2 returns 0 without touching the state — callers relying on draw
// ordering must preserve that quirk, so it lives here.
func (m *MinStd) Bounded(bound int32) int32 {
	if bound < 2 {
		return 0
	}
	s := m.state
	// Schrage: 16807·s − (s/127773)·(2^31−1), all wrapping mod 2^32.
	s = s*16807 + (s/127773)*0x80000001
	if int32(s) < 1 {
		s += 0x7FFFFFFF
	}
	m.state = s
	m.draws++
	return int32(s % uint32(bound))
}

// Range returns an integer in [lo, hi] using the COB RAND convention
// rand(hi−lo+1)+lo. A degenerate span (hi <= lo) returns lo without a draw,
// matching the engine's bound<2 short-circuit.
func (m *MinStd) Range(lo, hi int) int {
	span := hi - lo + 1
	if span < 2 {
		return lo
	}
	return lo + int(m.Bounded(int32(span)))
}

// Snapshot returns the raw state word for replay/resync checkpointing.
func (m *MinStd) Snapshot() uint32 { return m.state }

// Restore sets the state from a prior Snapshot. The draw counter is a local
// measurement aid, not part of the stream, so it is left untouched.
func (m *MinStd) Restore(s uint32) { m.state = s }

// Draws reports how many state advances this stream has made.
func (m *MinStd) Draws() uint64 { return m.draws }

// Crt is the engines' second stream: the classic MSVC C-runtime LCG
// (state·0x343FD + 0x269EC3, output the middle 15 bits). Mostly cosmetic in
// the originals, but a handful of sim-affecting systems (weather, wind
// scheduling, TA:K hit rolls) draw from it, so a faithful sim must model it
// separately from the MINSTD stream.
type Crt struct {
	state uint32
}

// NewCrt seeds the CRT stream directly (srand semantics — no transform).
func NewCrt(seed uint32) *Crt { return &Crt{state: seed} }

// Next advances the LCG and returns the 15-bit draw in [0, 0x7FFF].
func (c *Crt) Next() int32 {
	c.state = c.state*0x343FD + 0x269EC3
	return int32((c.state >> 16) & 0x7FFF)
}

// Snapshot returns the raw state word.
func (c *Crt) Snapshot() uint32 { return c.state }

// Restore sets the state from a prior Snapshot.
func (c *Crt) Restore(s uint32) { c.state = s }
