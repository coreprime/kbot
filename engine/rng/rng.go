// Package rng holds the deterministic PRNGs the simulation draws from.
//
// MinStd (minstd.go) is the authoritative sim stream — the Park–Miller
// generator both target engines use, with their exact seed transform and
// reduction quirks — and Crt models their second, C-runtime stream. Rng
// below is the legacy Mulberry32 generator kept for non-sim consumers.
//
// Determinism is the point — given the same seed and the same sequence of
// draws, the server and a wasm client produce identical results, which is what
// lets client-side prediction agree with the authoritative simulation.
package rng

// Rng holds a single uint32 of Mulberry32 state.
type Rng struct {
	state uint32
}

// New constructs an Rng from a seed. A zero seed degenerates to a fixed point
// at zero, so it is offset to the golden-ratio constant, matching the JS port.
func New(seed uint32) *Rng {
	if seed == 0 {
		seed = 0x9E3779B9
	}
	return &Rng{state: seed}
}

// Next32 advances the generator and returns a raw uint32. Every other helper
// sits on top of this.
func (r *Rng) Next32() uint32 {
	t := r.state + 0x6D2B79F5
	r.state = t
	t = (t ^ (t >> 15)) * (t | 1)
	t ^= t + (t^(t>>7))*(t|61)
	return t ^ (t >> 14)
}

// Float returns a value in [0, 1), the integer-free analogue of Math.random.
func (r *Rng) Float() float64 {
	return float64(r.Next32()) * 2.3283064365386963e-10
}

// Range returns a uniform integer in [lo, hi] inclusive, matching the COB
// rand(lo, hi) semantics. The bounds may be given in either order.
func (r *Rng) Range(lo, hi int) int {
	a, b := lo, hi
	if a > b {
		a, b = b, a
	}
	span := uint32(b - a + 1)
	return a + int(r.Next32()%span)
}

// Fork derives an independent child stream from this generator's next draw, so
// adding or removing one consumer does not perturb every other consumer's
// sequence.
func (r *Rng) Fork() *Rng {
	return New(r.Next32())
}

// Snapshot returns the current state for replay checkpointing.
func (r *Rng) Snapshot() uint32 { return r.state }

// Restore sets the state from a prior Snapshot.
func (r *Rng) Restore(s uint32) { r.state = s }
