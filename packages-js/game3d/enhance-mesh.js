// enhance-mesh.js
//
// Single source of truth for the "Enhanced Mesh" toggle: when on, the
// ModelLoader requests /api/studio/model/<name>?enhanceMesh=1 and the
// server reconstructs the faces TA's artists deleted as a fill-rate
// optimisation (open box bottoms, hollow shells, missing undersides).
//
// The value is seeded from the page URL (?enhanceMesh=1) so a shared
// link opens straight into the enhanced view; the Graphics Options menu
// can then override it at runtime via setEnhanceMeshEnabled().
//
// Toggling the flag isn't enough on its own — every live renderer has
// already fetched + uploaded the previous geometry.  Rather than have
// each view poll the flag, this module owns a tiny subscriber registry:
// setEnhanceMeshEnabled() notifies on change, and any view that draws
// 3DO geometry (the unit-viewer, every sandbox pane) registers via
// onEnhanceMeshChanged() to reload itself in place.  Keeping the
// fan-out here is what lets both ribbon bridges share one entry point.

let _enabled = false
try {
  _enabled = new URLSearchParams(globalThis.location?.search || '').get('enhanceMesh') === '1'
} catch {
  _enabled = false
}

const _listeners = new Set()

export function enhanceMeshEnabled() {
  return _enabled
}

export function setEnhanceMeshEnabled(on) {
  on = !!on
  if (on === _enabled) return
  _enabled = on
  // Snapshot before iterating so a listener that unsubscribes itself
  // (e.g. a view disposing mid-notify) doesn't mutate the live set.
  for (const cb of [..._listeners]) {
    try { cb(on) } catch { /* one broken view must not stall the rest */ }
  }
}

// onEnhanceMeshChanged registers `cb(enabled)` to run whenever the flag
// flips.  Returns an unsubscribe closure the caller invokes on teardown
// so a disposed view's reload never fires against a dead GL context.
export function onEnhanceMeshChanged(cb) {
  if (typeof cb !== 'function') return () => {}
  _listeners.add(cb)
  return () => _listeners.delete(cb)
}
