// open-unit-flow.js
//
// Flow controller for the Open Unit dialog: drains the model
// catalogue, opens the React picker, and routes the user's
// selection either into the sandbox spawn-placement loop or into a
// fresh unit-editor tab.
//
// The dialog DOM is owned by /ui/dialogs/open-unit.js (React tree
// in the dialogs-open-unit-mount root); this module is the thin
// host-side glue that ties the catalog cache, the
// __sandboxSpawnPending* globals (set by the side-colour picker
// before opening the dialog), and the destination view together.
//
// Studio.js calls openModelPicker from:
//   - the spawn-picker after the user picks a side
//   - the welcome card / ribbon "Open another model…" button
// and openModelPicker decides which destination to dispatch to.

import { $, hostCallbacks, getReactUi } from '../host-context.js'
import { fetchModels, availableModels, isLoaded as modelsLoaded } from './model-catalog.js'

// Surfaces that were visible at openModelPicker() entry; closeModelPicker
// flips each one back if the user cancels.  Mirrors the open-map flow —
// snapshot/restore rather than switch-on-tab-type, so sandbox tabs (which
// share #model-viewer-dialog with model tabs in .sandbox-mode) restore
// correctly instead of falling through to the welcome screen.
let openUnitPriorSurfaces = null

// openModelPicker — hides whichever editor surface currently has
// focus, makes sure the React UI island has finished its dynamic
// import (cold-boot path), drains the catalogue if it hasn't been
// loaded, and opens the React picker.  The returned promise
// resolves with either {name, sandboxIntent} or null (cancel).
//
// On confirm, two routes:
//   sandbox spawn  → beginPlacement on the active SandboxView
//   open viewer    → host's openModelViewer (pushes a new tab)
export async function openModelPicker() {
  // Snapshot the three top-level surfaces before we hide the front-
  // most ones, so the cancel path can restore the same state without
  // having to enumerate every tab type.
  openUnitPriorSurfaces = {
    welcome:   !$('#welcome-dialog').classList.contains('hidden'),
    viewer:    !$('#model-viewer-dialog').classList.contains('hidden'),
    appEditor: !$('#app').classList.contains('hidden'),
  }
  // The picker is React-managed.  Hide whichever editor surface was
  // on top so the modal isn't fighting another dialog stack for
  // the user's eye, then open the React picker.  The legacy
  // #model-open-dialog static markup is no longer used — React
  // mounts its own dialog DOM on demand.  #app carries the map
  // editor's chrome (ribbon + sidebar + canvas); without hiding it
  // here the map surface bleeds through the picker's translucent
  // backdrop whenever a map tab is the one on screen.  closeModelPicker
  // restores all three surfaces from the entry snapshot above.
  $('#welcome-dialog').classList.add('hidden')
  $('#model-viewer-dialog').classList.add('hidden')
  $('#app')?.classList.add('hidden')
  // Bring the React UI up if it hasn't loaded yet (cold-boot path).
  let ui = getReactUi()
  if (!ui && hostCallbacks.configureReactUi) {
    ui = await hostCallbacks.configureReactUi()
  }
  if (!modelsLoaded()) await fetchModels()
  // The picker spawns into the React tree; await its resolution and
  // route based on the host's pending intent (sandbox spawn vs.
  // open viewer).
  const sandboxIntent = !!window.__sandboxSpawnPending
  const result = ui && typeof ui.openUnitDialog === 'function'
    ? await ui.openUnitDialog({
        items: availableModels(),
        loading: !modelsLoaded(),
        query: '',
        selectedName: null,
        sandboxIntent,
      })
    : null
  if (!result) {
    closeModelPicker()
    return
  }
  // From here on we're on a success path — clear the entry snapshot so
  // a future cancel from a different open can't replay a stale state.
  openUnitPriorSurfaces = null
  if (result.sandboxIntent) {
    // The side-colour picker stashed the chosen team side on the
    // __sandboxSpawnPending* globals before openModelPicker fired;
    // pop those and pass into the SandboxView's placement loop.
    const sb = hostCallbacks.getActiveSandboxView?.()
    if (sb) {
      window.__sandboxSpawnPending = false
      const pendingSide = (window.__sandboxSpawnPendingSide | 0) || 0
      window.__sandboxSpawnPendingSide = 0
      // Spawn happens back in the live sandbox tab — restore both the
      // shared app shell (topbar/tabs/statusbar) we hid for the picker
      // and the viewer overlay the sandbox renders into.
      $('#app')?.classList.remove('hidden')
      $('#model-viewer-dialog')?.classList.remove('hidden')
      void sb.beginPlacement(result.name, { side: pendingSide })
      return
    }
  }
  hostCallbacks.openModelViewer?.(result.name)
}

// closeModelPicker — React owns the dialog DOM, so dismissing is
// "close the open-state signal".  Snapshot/restore via
// openUnitPriorSurfaces means we put back exactly the surfaces that
// were on screen at open time, regardless of the active tab type —
// previously a sandbox tab fell through the model/map switch and
// landed on the welcome screen.
export function closeModelPicker() {
  const ui = getReactUi()
  if (ui && typeof ui.closeUnitDialog === 'function') {
    ui.closeUnitDialog()
  }
  const prior = openUnitPriorSurfaces
  openUnitPriorSurfaces = null
  if (prior) {
    $('#welcome-dialog').classList.toggle('hidden', !prior.welcome)
    $('#model-viewer-dialog').classList.toggle('hidden', !prior.viewer)
    $('#app')?.classList.toggle('hidden', !prior.appEditor)
    return
  }
  // Fallback for a close call with no matching open snapshot (defensive;
  // shouldn't happen in the current flow but keeps the screen non-blank
  // if a future caller invokes closeModelPicker out-of-band).
  const activeTab = hostCallbacks.getActiveTab?.()
  if (activeTab?.type === 'model' || activeTab?.type === 'sandbox') {
    $('#model-viewer-dialog').classList.remove('hidden')
  } else if (activeTab?.type === 'map') {
    $('#app')?.classList.remove('hidden')
  } else {
    $('#welcome-dialog').classList.remove('hidden')
  }
}
