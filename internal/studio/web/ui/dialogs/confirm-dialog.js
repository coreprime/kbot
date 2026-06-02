// confirm-dialog.js
//
// React-rendered replacement for the in-app confirm modal.  Mounts a
// single hidden modal into the document, then exposes an imperative
// `confirmDialog({...})` that returns a Promise<boolean> for the
// user's choice.  Drop-in API match for the legacy studio.js
// confirmDialog so every caller (Clear Field, Terminate All Scripts,
// any future destructive action) keeps working without edits.
//
// Why React for a single modal:
//   - The chrome (dialog → card → title + message + Cancel/OK + danger
//     accent on the primary button) is now in ONE place instead of
//     scattered between studio.js's mutator + index.html's static
//     markup.  Future styling tweaks land in one file.
//   - Keyboard handling (Esc → cancel, Enter → confirm) attaches +
//     detaches with the open state instead of leaking listeners on
//     stuck-open dialogs.
//   - Sets the pattern other modals (Open Unit, Settings, Resize)
//     will follow as the migration progresses.

import { render } from 'preact'
import { signal } from '@preact/signals'
import { useEffect } from 'preact/hooks'
import { htm as html } from '@kbot/ui/htm-bind'

// _request — single signal carrying the current open request, or null
// when no dialog is showing.  The shape is { title, message, okLabel,
// cancelLabel, okDanger, resolve } — `resolve` is the per-call promise
// callback we fire when the user picks a button.  Signal-driven so the
// component re-renders the moment confirmDialog() is called.
const _request = signal(null)

// _mountIfNeeded brings up the React tree lazily on first
// confirmDialog() call.  The mount root sits at the end of <body>
// so the modal stacks above everything in the editor (no z-index
// fight with floating panels).  Idempotent — re-renders into the
// same root on subsequent calls.
let _mountedRoot = null
function _mountIfNeeded() {
  if (_mountedRoot) return
  _mountedRoot = document.createElement('div')
  _mountedRoot.id = 'confirm-dialog-mount'
  // display:contents — the mount node itself shouldn't introduce
  // layout; the dialog inside is position:fixed and owns its own
  // backdrop / centering.
  _mountedRoot.style.cssText = 'display:contents'
  document.body.appendChild(_mountedRoot)
  render(html`<${ConfirmDialog} />`, _mountedRoot)
}

// confirmDialog — the public API.  Same signature + same return type
// as the legacy function so callers ('await confirmDialog({...})')
// don't change.  When two dialogs race we resolve the prior one as
// cancelled before showing the new request — simpler than queueing
// and matches the legacy "only one dialog visible" contract.
export function confirmDialog({
  title = 'Confirm',
  message = '',
  okLabel = 'OK',
  cancelLabel = 'Cancel',
  okDanger = false,
} = {}) {
  _mountIfNeeded()
  return new Promise((resolve) => {
    const prev = _request.value
    if (prev && typeof prev.resolve === 'function') prev.resolve(false)
    _request.value = { title, message, okLabel, cancelLabel, okDanger, resolve }
  })
}

// ConfirmDialog — the visible component.  Renders nothing when no
// request is in flight (returns null).  When a request lands the modal
// fades in, autofocuses the OK button, and listens for Esc/Enter on
// the document so the user can dismiss without touching the mouse.
function ConfirmDialog() {
  const req = _request.value
  const finish = (result) => {
    const cur = _request.value
    if (!cur) return
    cur.resolve(result)
    _request.value = null
  }
  // Keyboard handling — bound while a dialog is showing, removed on
  // dismiss.  Capture phase so we beat any panel-level Esc listener
  // that would also close its own thing (we want the dialog dismissed
  // first; the editor below stays where it was).
  useEffect(() => {
    if (!req) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false) }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true) }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [req])
  if (!req) return null
  // No fixed IDs on the elements (vs the legacy static markup) — the
  // dialog is keyed by its singleton signal, not by element id, so
  // there's no reason for global IDs to collide with other UI.
  return html`
    <div class="dialog mv-confirm-dialog">
      <div class="dialog-card dialog-card-narrow">
        <h1>${req.title}</h1>
        <p class="dialog-sub">${req.message}</p>
        <div class="dialog-actions">
          <button class="btn"
                  onClick=${() => finish(false)}>${req.cancelLabel}</button>
          <button class=${req.okDanger ? 'btn primary danger' : 'btn primary'}
                  ref=${(el) => el && el.focus()}
                  onClick=${() => finish(true)}>${req.okLabel}</button>
        </div>
      </div>
    </div>
  `
}
