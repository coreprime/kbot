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
