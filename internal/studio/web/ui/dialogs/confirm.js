// confirm.js
//
// Imperative wrapper around the React confirm-dialog component
// (./confirm-dialog.js).  Same API as the legacy studio.js
// confirmDialog — returns Promise<boolean> for the user's choice —
// so every caller (Clear Field, Terminate All Scripts, Cut, future
// destructive actions) keeps working without edits.
//
// Routing
// -------
// When the React UI bridge has loaded, delegate to
// reactUi.confirmDialog.  Before the bridge resolves (early boot,
// headless harness) fall back to native window.confirm so a
// pre-boot click on, say, an Open Map → discard prompt still
// works.  In practice every user-driven confirm fires long after
// the bridge has mounted, so the fallback is belt-and-braces.
//
// Lives in /ui/dialogs/ alongside the React component it talks to;
// the imperative wrapper is the thin glue between subsystem code
// and the React-rendered modal.

import { getReactUi } from '../host-context.js'

export function confirmDialog(opts = {}) {
  const ui = getReactUi()
  if (ui && typeof ui.confirmDialog === 'function') {
    return ui.confirmDialog(opts)
  }
  return Promise.resolve(window.confirm(`${opts.title || 'Confirm'}\n\n${opts.message || ''}`))
}
