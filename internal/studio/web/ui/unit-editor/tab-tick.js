// tab-tick.js
//
// Per-tab rAF loop for the unit editor.  Owns the timing pump that
// drives everything that has to happen once per visible frame:
//
//   - binding.tick(dtMs) — advances CobRuntime + per-piece _sync +
//     particle/audio rate updates.  Used to be driven by the
//     primary renderer's draw loop via setCobBinding's default
//     driveTick:true path.  Moved here for Stage B of the split
//     refactor: with N panes the renderer-driven path multiplied
//     the runtime; consolidating to one tab-owned loop keeps the
//     sim canonical regardless of pane count.
//   - mvControls.tick(dtMs) — viewer-side aim / weapon / smoke
//     trail / projectile state.  Engine.tick inside still passes
//     skipRuntime:true because we advanced the binding (= runtime)
//     above.
//   - advanceMvAutoBuild(dtMs) — the build-ramp animation hook.
//   - refreshMvInspectors(dtMs) — pushes per-tick signals into the
//     React panels; gated on this tab being the active one so a
//     backgrounded viewer doesn't keep shoving updates into the
//     inspector tree.
//
// The loop runs only while the tab is active; deactivate stops it
// so the runtime + audio + particles all freeze when the user
// switches to another tab.  Multiple unit-editor tabs each have
// their own loop; the dispatcher in activateModelTab stops every
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
    try { tickFn(dtMs) } catch (err) { console.warn('[unit-editor:tab-tick]', err) }
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
