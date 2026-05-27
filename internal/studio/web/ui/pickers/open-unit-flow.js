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
  // The picker is React-managed.  Hide whichever editor surface was
  // on top so the modal isn't fighting another dialog stack for
  // the user's eye, then open the React picker.  The legacy
  // #model-open-dialog static markup is no longer used — React
  // mounts its own dialog DOM on demand.
  $('#welcome-dialog').classList.add('hidden')
  $('#model-viewer-dialog').classList.add('hidden')
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
  if (result.sandboxIntent) {
    // The side-colour picker stashed the chosen team side on the
    // __sandboxSpawnPending* globals before openModelPicker fired;
    // pop those and pass into the SandboxView's placement loop.
    const sb = hostCallbacks.getActiveSandboxView?.()
    if (sb) {
      window.__sandboxSpawnPending = false
      const pendingSide = (window.__sandboxSpawnPendingSide | 0) || 0
      window.__sandboxSpawnPendingSide = 0
      $('#model-viewer-dialog')?.classList.remove('hidden')
      void sb.beginPlacement(result.name, { side: pendingSide })
      return
    }
  }
  hostCallbacks.openModelViewer?.(result.name)
}

// closeModelPicker — React owns the dialog DOM, so dismissing is
// "close the open-state signal".  When the user cancelled via Esc /
// Cancel the React dialog has already cleared itself, so this is
// mainly the post-confirm cleanup path: restore whichever editor
// surface was on top before the picker opened.
export function closeModelPicker() {
  const ui = getReactUi()
  if (ui && typeof ui.closeUnitDialog === 'function') {
    ui.closeUnitDialog()
  }
  const activeTab = hostCallbacks.getActiveTab?.()
  if (activeTab?.type === 'model') {
    $('#model-viewer-dialog').classList.remove('hidden')
  } else if (activeTab?.type === 'map') {
    $('#app')?.classList.remove('hidden')
  } else {
    $('#welcome-dialog').classList.remove('hidden')
  }
}
