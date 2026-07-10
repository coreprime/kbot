package studio

import "testing"

// TestStartPosWorldScale pins the per-game OTA StartPos → world-unit scaling.
// TA starts are already map-pixels (identity at the default pxPerWU); TA:K
// starts are DataUnit cells and must scale by the cell size, otherwise a
// leader on a TA:K water map spawns near the corner in deep water and cannot
// move (the "Elsin stuck on Athri Cay" bug).
func TestStartPosWorldScale(t *testing.T) {
	if got := startPosWorldScale(false); got != 1.0 {
		t.Fatalf("TA start scale = %v, want 1.0 (map-pixels are world units)", got)
	}
	if got := startPosWorldScale(true); got != sandboxCellWU {
		t.Fatalf("TA:K start scale = %v, want %v (DataUnit → world units)", got, sandboxCellWU)
	}

	// Athri Cay's StartPos1 is DataUnit cell (143, 333); at sea level 58 that
	// cell's height is dry land. Scaled to world units it lands mid-map on the
	// land shelf; treated as raw pixels it would sit at world (143, 333) — cell
	// (8, 20), which is open water on that map.
	const cell = 143.0
	if world := cell * startPosWorldScale(true); world != cell*sandboxCellWU {
		t.Fatalf("TA:K start world X = %v, want %v", world, cell*sandboxCellWU)
	}
}
