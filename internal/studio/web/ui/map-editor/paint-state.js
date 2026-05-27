// paint-state.js
//
// Shared mutable flags driving the paint / erase / heightmap mode
// gestures.  All three modes follow the same coarse shape:
//   - mousedown sets `painting = true`
//   - mouseup commits if `paintedDuringStroke`, else aborts
//   - move/move-with-button stamps + sets `paintedDuringStroke = true`
//
// Each mode used to read+write its own copies of these flags as
// module-level vars in studio.js; centralising them on a plain
// mutable object lets every mode module (modes/paint.js,
// modes/erase.js, modes/heightmap.js — extracted over R40d…R40e)
// import the same object and read/write through `paintState.painting`
// without any per-module setter plumbing.
//
// ES-module `let` exports are read-only on the import side, so
// the indirection through a plain object is required — same
// pattern host-context.js uses for `tabState.activeIndex`.

export const paintState = {
  // True while a paint / erase / heightmap stroke is in flight.
  // Set on mousedown, cleared on mouseup + mode-swap +
  // abortTransientGestureState.
  painting: false,
  // True if at least one stamp landed during this stroke.  Lets
  // mouseup decide whether to commit (≥1 stamp → 'Paint' /
  // 'Erase' / 'Heightmap' transaction) or abort (no stamps → drop
  // the transaction the mousedown opened so undo isn't polluted
  // with empty entries).
  paintedDuringStroke: false,
}

// resetPaintStroke clears both flags atomically.  Used by the
// abort path + mode-swap path; lets callers avoid touching the
// two fields by name.
export function resetPaintStroke() {
  paintState.painting = false
  paintState.paintedDuringStroke = false
}
