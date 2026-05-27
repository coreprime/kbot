// controls-intercept.js
//
// Hijacks the unit-editor's Controls panel button group
// (`#mv-controls-actions .mv-ctrl-action`) when sandbox mode is
// active so each click drives the currently-selected sandbox unit
// instead of the dormant single-unit MvControls singleton.  Move /
// Primary / Secondary / Tertiary arm the sandbox's pending-command
// pipeline (next canvas click commits a target); Stop bypasses
// arming and dispatches sandbox.stop() immediately.
//
// Implementation: capture-phase click listener on the action grid.
// Bails on non-sandbox tabs by reading the dialog's `.sandbox-mode`
// class.  Idempotent via a `dataset.sandboxWired` flag so repeat
// wiring (tab swaps, hot-reload) doesn't pile up handlers.
//
// Pulled out of studio.js as part of the R44 sandbox extraction.
// The active SandboxView is reached through
// `hostCallbacks.getActiveSandboxView()` so the module doesn't
// import studio.js.

import { hostCallbacks } from '../host-context.js'

export function wireSandboxControlsIntercept() {
  const grid = document.getElementById('mv-controls-actions')
  if (!grid || grid.dataset.sandboxWired === '1') return
  grid.dataset.sandboxWired = '1'
  grid.addEventListener('click', (e) => {
    const dlg = document.getElementById('model-viewer-dialog')
    if (!dlg || !dlg.classList.contains('sandbox-mode')) return
    const btn = e.target.closest('.mv-ctrl-action')
    if (!btn) return
    const action = btn.dataset.ctrlAction
    if (!action) return
    e.stopPropagation()
    e.preventDefault()
    const sb = hostCallbacks.getActiveSandboxView?.()
    if (!sb || !sb.scene) return
    if (action === 'stop') {
      // Stop dispatches through SandboxView.stop() → engine.stopUnits.
      // The canonical "drop move + attack + weapon slots + run
      // StopMoving + TargetCleared" entry point lives in the engine
      // now; both the sandbox S-hotkey + #stopSelected and this
      // Controls grid handler converge on one code path so the
      // three can't drift apart again.
      sb.stop()
      return
    }
    // All slots arm the next canvas click — matches the unit
    // editor's Controls panel semantics (you click Primary, then
    // click in the scene to lock the weapon onto that target).
    // setPendingCommand swaps the armed-cursor overlay so the user
    // sees which slot is armed.
    if (action === 'move') sb.setPendingCommand('move')
    else if (action === 'primary' || action === 'secondary' || action === 'tertiary') sb.setPendingCommand(action)
  }, /* capture = */ true)
}
