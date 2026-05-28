// tab-tick.js
//
// Per-tab rAF loop shared by every editor that needs to drive
// per-frame sim work independently of any one renderer.  Used by:
//
//   - Unit editor — drives binding.tick + MvControls.tick +
//     advanceMvAutoBuild + refreshMvInspectors.  See
//     /ui/unit-editor/tab.js (the loop replaces the primary
//     renderer's onAfterFrame for these jobs so split-pane
//     secondaries don't double-tick the binding).
//   - Sandbox — drives scene.tick + cob-lifecycle advance +
//     refreshMvInspectors.  See /ui/sandbox/tab.js (same logic:
//     scene.tick used to ride the active pane's renderer; with
//     splits we want one canonical advance per frame regardless
//     of pane count).
//   - Map editor — TBD on adoption; the tick callable still works
//     for any per-frame poll the map view wants.
//
// The loop runs only while the tab is active; deactivate stops it
// so the runtime + audio + particles all freeze when the user
// switches to another tab.  Multiple tabs each have their own
// loop; the dispatcher in each editor's activate() stops every
// other tab's loop before starting this one (mirrors how renderer
// .stop() works for backgrounded panes).

// _MAX_DT_MS caps the dtMs passed downstream so a long pause (deep
// tab unhide, dev-tools open) doesn't dump a 5-second chunk into
// the runtime in one go — that would let projectiles teleport past
// targets and weapon reload timers fire all at once on resume.
const _MAX_DT_MS = 100

// startTabTick installs a rAF loop on `tab._tickRaf`.  Idempotent:
// calling on a tab that already has a loop is a no-op.  The
// `tickFn(dtMs)` callback is invoked each frame with the wall-clock
// dt since the previous frame, capped at _MAX_DT_MS.
export function startTabTick(tab, tickFn) {
  if (!tab || tab._tickRaf) return
  if (typeof tickFn !== 'function') return
  let lastT = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()
  const loop = () => {
    if (!tab._tickRaf) return  // stopped between frames
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()
    const raw = now - lastT
    lastT = now
    const dtMs = raw > _MAX_DT_MS ? _MAX_DT_MS : (raw < 0 ? 0 : raw)
    try { tickFn(dtMs) } catch (err) { console.warn('[tab-tick]', err) }
    tab._tickRaf = requestAnimationFrame(loop)
  }
  tab._tickRaf = requestAnimationFrame(loop)
}

// stopTabTick cancels the loop.  Idempotent.  Called on tab
// deactivate + dispose so backgrounded tabs don't burn frames.
export function stopTabTick(tab) {
  if (!tab || !tab._tickRaf) return
  try { cancelAnimationFrame(tab._tickRaf) } catch { /* ignore */ }
  tab._tickRaf = 0
}
