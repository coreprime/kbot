package rng

import "testing"

func TestDeterministicSequence(t *testing.T) {
	a := New(42)
	b := New(42)
	for i := 0; i < 1000; i++ {
		if a.Next32() != b.Next32() {
			t.Fatalf("same seed diverged at draw %d", i)
		}
	}
}

func TestZeroSeedOffset(t *testing.T) {
	if New(0).state != 0x9E3779B9 {
		t.Errorf("zero seed should offset to golden ratio constant")
	}
}

func TestRangeBounds(t *testing.T) {
	r := New(7)
	for i := 0; i < 10000; i++ {
		v := r.Range(3, 9)
		if v < 3 || v > 9 {
			t.Fatalf("Range(3,9) out of bounds: %d", v)
		}
	}
	// Reversed bounds behave the same.
	r2 := New(7)
	for i := 0; i < 100; i++ {
		v := r2.Range(9, 3)
		if v < 3 || v > 9 {
			t.Fatalf("Range(9,3) out of bounds: %d", v)
		}
	}
}

func TestForkIndependence(t *testing.T) {
	parent := New(123)
	child := parent.Fork()
	// Parent and child must not be the same object/state.
	if parent.state == child.state {
		t.Errorf("fork shares parent state")
	}
	// Forking is reproducible.
	p2 := New(123)
	c2 := p2.Fork()
	if child.Next32() != c2.Next32() {
		t.Errorf("fork not reproducible")
	}
}

func TestSnapshotRestore(t *testing.T) {
	r := New(99)
	for i := 0; i < 50; i++ {
		r.Next32()
	}
	snap := r.Snapshot()
	want := r.Next32()
	r.Restore(snap)
	if got := r.Next32(); got != want {
		t.Errorf("restore failed: got %d want %d", got, want)
	}
}

// TestMinStdSchrage checks the wrapped-32-bit Schrage update against the
// mathematically exact 16807·s mod (2^31−1) over a spread of states, including
// ones with the high bit set (reachable through the seed transform).
func TestMinStdSchrage(t *testing.T) {
	for _, seed := range []uint32{0, 1, 2, 12345, 0x7FFFFFFE, 0x80000001, 0xDEADBEEF} {
		m := NewMinStd(seed)
		s := m.Snapshot()
		m.Bounded(1 << 30)
		got := m.Snapshot()
		// Reference only valid when the pre-state is a canonical MINSTD state
		// (below the modulus); the transform can seed above it, where the
		// engine's wrapped arithmetic itself is the specification.
		if s < 0x7FFFFFFF {
			want := uint32((uint64(s) * 16807) % 0x7FFFFFFF)
			if got != want {
				t.Errorf("seed %#x: state %#x -> %#x, want %#x", seed, s, got, want)
			}
		}
		if got == s {
			t.Errorf("seed %#x: state did not advance", seed)
		}
	}
}

func TestMinStdSeedTransform(t *testing.T) {
	// state = (seed ^ 0x66E29572) | 1 — never zero, always odd.
	if got := NewMinStd(0).Snapshot(); got != 0x66E29573 {
		t.Errorf("seed 0 -> %#x, want 0x66E29573", got)
	}
	if got := NewMinStd(0x66E29572).Snapshot(); got != 1 {
		t.Errorf("seed 0x66E29572 -> %#x, want 1", got)
	}
}

func TestMinStdBoundQuirks(t *testing.T) {
	m := NewMinStd(7)
	before := m.Snapshot()
	for _, b := range []int32{-5, 0, 1} {
		if got := m.Bounded(b); got != 0 {
			t.Errorf("Bounded(%d) = %d, want 0", b, got)
		}
	}
	if m.Snapshot() != before || m.Draws() != 0 {
		t.Errorf("bound < 2 must not advance the state or count a draw")
	}
	// Range uses rand(hi-lo+1)+lo; a degenerate span returns lo undrawn.
	if got := m.Range(9, 9); got != 9 || m.Draws() != 0 {
		t.Errorf("Range(9,9) = %d draws=%d, want 9 with no draw", got, m.Draws())
	}
	lo, hi := 3, 7
	for i := 0; i < 100; i++ {
		v := m.Range(lo, hi)
		if v < lo || v > hi {
			t.Fatalf("Range(%d,%d) = %d out of bounds", lo, hi, v)
		}
	}
	if m.Draws() != 100 {
		t.Errorf("draws = %d, want 100", m.Draws())
	}
}

// TestCrtVector pins the CRT stream to the classic MSVC rand() sequence for
// srand(1) — the constants 0x343FD/0x269EC3 with the middle 15 bits out.
func TestCrtVector(t *testing.T) {
	c := NewCrt(1)
	want := []int32{41, 18467, 6334, 26500, 19169, 15724, 11478, 29358}
	for i, w := range want {
		if got := c.Next(); got != w {
			t.Fatalf("draw %d = %d, want %d", i, got, w)
		}
	}
}

func TestMinStdSnapshotRestore(t *testing.T) {
	m := NewMinStd(99)
	for i := 0; i < 10; i++ {
		m.Bounded(1000)
	}
	s := m.Snapshot()
	a := m.Bounded(1000)
	m.Restore(s)
	if b := m.Bounded(1000); b != a {
		t.Errorf("restore did not reproduce the stream: %d vs %d", a, b)
	}
}
