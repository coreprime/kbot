// help.js
//
// Imperative wrappers around the static #help-dialog markup —
// the user opens it from the Help button on the ribbon and from
// the F1 keyboard shortcut.  Closes on Escape (handled by the
// global handler that calls closeHelpDialog) and the Close button
// (wired in studio.js's wireDeveloperDialog).
//
// The tab strip inside the dialog is also static — its wiring
// stays with the rest of the dialog-button setup in studio.js for
// now.  Only the imperative show / hide pair lives here.

import { $ } from '../host-context.js'

export function openHelpDialog() {
  const dlg = $('#help-dialog')
  if (!dlg) return
  dlg.classList.remove('hidden')
  // Focus the Close button so Enter / Space dismiss matches
  // Escape.
  $('#help-close')?.focus()
}

export function closeHelpDialog() {
  $('#help-dialog')?.classList.add('hidden')
}
