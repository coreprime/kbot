// size.js
//
// New-map size picker dialog + the in-editor File → New / File → Open
// entry points that drive it.  Owns:
//
//   - openSizeDialog()           — reveals #size-dialog and focuses
//                                  the name input on the next frame.
//   - closeSizeDialog()          — returns the user to whichever
//                                  surface (welcome modal vs editor)
//                                  they came from.  Cancel keeps the
//                                  existing editor untouched.
//   - startNewMapFromEditor()    — File → New: seeds the size inputs
//                                  with the current map's dimensions
//                                  (keeping "newmap" as the default
//                                  name) and opens the picker.
//   - openExistingMapFromEditor() — File → Open: appends a new tab
//                                  via the open-map picker.
//   - confirmOnEnter(e)          — small Enter-key helper bound to
//                                  the size-dialog inputs that fires
//                                  the size-confirm path.
//
// Cross-module deps reached through hostCallbacks so this module
// doesn't import studio.js:
//   - startEditor()             — the size-dialog Confirm handler
//                                 (still in studio.js this round —
//                                 moves out in a follow-up).  Bound
//                                 to the inputs' Enter key here so
//                                 the wiring lives next to the rest
//                                 of the dialog ownership.
//
// Module-private state:
//   - sizeDialogSource — 'welcome' or 'tabbar'.  Read by
//                        closeSizeDialog to decide whether to restore
//                        the welcome modal or fall back to the
//                        previous editor surface.  Written by the
//                        welcome-modal New button (via setSizeDialogSource)
//                        and by startNewMapFromEditor below.

import { $, state, tabs, tabState, hostCallbacks } from '../../host-context.js'
import { openMapDialog } from '../../pickers/open-map.js'

// Module-private — closeSizeDialog routes back to either the welcome
// modal or the editor surface depending on what triggered the picker.
let sizeDialogSource = 'welcome' // 'welcome' or 'tabbar' — controls where the size dialog routes back to

// setSizeDialogSource lets external callers (the welcome modal New
// button + the tab-bar "+" New Map entry) seed the source before
// opening the dialog so closeSizeDialog can route back correctly.
export function setSizeDialogSource(src) {
  sizeDialogSource = src
}

export function confirmOnEnter(e) {
  if (e.key === 'Enter') hostCallbacks.startEditor?.()
}

// startNewMapFromEditor is the toolbar New button — confirms first
// because it nukes the current canvas, undo history, OTA, everything.
export async function startNewMapFromEditor() {
  // Multi-tab: New simply opens the size dialog and appends a new tab
  // on confirm.  No discard prompt — the existing map stays on its
  // own tab.  Dimensions inherit from the current map (likely the
  // user wants the same size), but the name resets to "newmap" so
  // a previous map's name doesn't shadow what they're about to make.
  sizeDialogSource = 'tabbar'
  const wIn = $('#size-w'); if (wIn) wIn.value = String(state.tileW || 128)
  const hIn = $('#size-h'); if (hIn) hIn.value = String(state.tileH || 128)
  const nIn = $('#size-name'); if (nIn) nIn.value = 'newmap'
  openSizeDialog()
}

// closeSizeDialog returns the user to the surface they came from when
// they cancel the size picker.  Resetting transient state is deferred
// to the actual swap inside startEditor (or openLoadedMap) so a
// cancelled New leaves the existing editor untouched.
export function closeSizeDialog() {
  $('#size-dialog').classList.add('hidden')
  if (sizeDialogSource === 'welcome') {
    $('#welcome-dialog').classList.remove('hidden')
    return
  }
  // Restore the surface that was visible before the size dialog
  // appeared.  When the user came from a model tab via the "+"
  // popup the 3DO viewer was hidden; bring it back.
  const active = tabState.activeIndex >= 0 ? tabs[tabState.activeIndex] : null
  if (active?.type === 'model') {
    $('#model-viewer-dialog').classList.remove('hidden')
  }
}

// openSizeDialog reveals the New-map dialog and focuses the name input
// so the user can immediately type the friendly map name (#38).
export function openSizeDialog() {
  // Same as openMapDialog: hide the 3DO viewer if it's the current
  // surface so the size dialog isn't trapped behind a higher dialog.
  $('#model-viewer-dialog').classList.add('hidden')
  $('#size-dialog').classList.remove('hidden')
  // Defer the focus to the next frame so the browser has shown the
  // dialog before we try to put the caret in the input.
  requestAnimationFrame(() => {
    const nm = $('#size-name')
    if (nm) {
      nm.focus()
      nm.select()
    }
  })
}

// openExistingMapFromEditor confirms then reuses the same picker the
// Welcome modal shows on first boot — the load flow then replaces the
// editor's state in place via openLoadedMap → finishEditorBoot.
export async function openExistingMapFromEditor() {
  // Multi-tab: Open appends a new tab; no need to discard or prompt.
  openMapDialog('tabbar')
}
