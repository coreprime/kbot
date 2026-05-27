// unit-hotkeys.js
//
// Shared "issue an order via the keyboard" keymap used by both
// single-entity and multi-entity host views.  The hosts had identical
// M/A/F/D/S/T handlers wired in their own keydown listeners — same
// modifier gating, same input-field skip, same routing — so the
// keymap lives here once and each host attaches it with its own
// command callbacks.
//
// Keys (no modifier; modifier chords skip so they don't fight
// browser shortcuts):
//   M  → onCommand('move')         Arm Move
//   A  → onCommand('primary')      Arm primary attack
//   F  → onCommand('secondary')    Arm secondary attack
//   D  → onCommand('tertiary')     Arm tertiary attack
//   S  → onStop()                  Halt every selected unit
//   T  → onTrack()                 Toggle camera tracking
//
// The host passes:
//   dialogId   — only fire when this dialog is on-screen.  The hosts
//                pick a dialog id whose visibility is the cross-view
//                "this view is alive" signal.
//   onCommand  — receives one of 'move' | 'primary' | 'secondary' |
//                'tertiary'.  Hosts route this to whichever arming
//                primitive they expose.
//   onStop     — fired on S.
//   onTrack    — fired on T.
//   allowed    — optional () => bool gate.  Hosts use this to skip
//                hotkeys when nothing is selected (so a stray keystroke
//                doesn't arm a cursor with no unit to dispatch to).
//                Hosts that always have a target gate inside the
//                callback (button.disabled check), so their allowed()
//                always returns true.
//
// Returns a detach() closure the caller invokes on view dispose so
// listeners don't pile up across tab switches.

export function attachUnitHotkeys({
  dialogId = 'model-viewer-dialog',
  onCommand = null,
  onStop = null,
  onTrack = null,
  allowed = null,
} = {}) {
  const handler = (e) => {
    if (dialogId) {
      const dlg = document.getElementById(dialogId)
      if (!dlg || dlg.classList.contains('hidden')) return
    }
    // Skip while the user is typing in a form control so M doesn't
    // arm Move while they're editing a unit name in the spawn dialog.
    const t = e.target
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
    if (t && t.isContentEditable) return
    // Skip on modifier chords so Ctrl+S still saves, Cmd+A still
    // selects-all, etc.  R hotkey (auto-rotate) is handled by
    // camera-controls.js — kept there because it's a camera concern,
    // not a unit-orders concern.
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const k = (e.key || '').toLowerCase()
    // Order keys — gated on `allowed()` when supplied so hosts can
    // refuse the keystroke (e.g. no current selection) without
    // engaging the cursor.
    if (k === 'm' || k === 'a' || k === 'f' || k === 'd') {
      if (allowed && !allowed()) return
      e.preventDefault()
      const cmd = (k === 'm') ? 'move'
                : (k === 'a') ? 'primary'
                : (k === 'f') ? 'secondary'
                : /* k === 'd' */ 'tertiary'
      if (typeof onCommand === 'function') onCommand(cmd)
      return
    }
    if (k === 's') {
      if (allowed && !allowed()) return
      e.preventDefault()
      if (typeof onStop === 'function') onStop()
      return
    }
    if (k === 't') {
      e.preventDefault()
      if (typeof onTrack === 'function') onTrack()
      return
    }
  }
  document.addEventListener('keydown', handler)
  return function detach() {
    document.removeEventListener('keydown', handler)
  }
}
