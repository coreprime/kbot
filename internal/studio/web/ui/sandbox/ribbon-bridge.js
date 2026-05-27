// ribbon-bridge.js
//
// Mounts the React sandbox-ribbon and wires the host-bridge that
// ferries each ribbon-button click back into the active SandboxView.
// The React tree itself lives in /ui/sandbox/sandbox-ribbon.js; this
// module is the thin glue between that tree and the live scene
// (selection, camera, command-dispatch).
//
// Each bridge callback looks up the active sandbox view via
// `hostCallbacks.getActiveSandboxView()` so it dispatches to whichever
// sandbox tab is foregrounded — there can be more than one open.
//
// Pulled out of studio.js as the second leaf-helper layer of the R44
// sandbox extraction.  No behavioural change.

import { hostCallbacks, getReactUi } from '../host-context.js'
import { confirmDialog } from '../dialogs/confirm.js'
import { openSandboxSpawnPicker, setSandboxPanelVisible } from './spawn-picker.js'

// wireSandboxRibbon — install the host bridge + mount the ribbon's
// React tree.  Idempotent; safe to call before / after the React UI
// module has resolved (the early-return guard bails until the UI
// bridge is up).
export function wireSandboxRibbon() {
  const ui = getReactUi()
  if (!ui) return
  const sb = () => hostCallbacks.getActiveSandboxView?.() || null
  if (typeof ui.configureSandboxRibbonBridge === 'function') {
    ui.configureSandboxRibbonBridge({
      openSpawnPicker: (anchorEl) => openSandboxSpawnPicker(anchorEl),
      setPendingCommand: (cmd) => sb()?.setPendingCommand(cmd),
      stopSelected: () => {
        // Wipe move + attack targets on every selected unit so the
        // sandbox AI driver sees "no command" on the next tick.
        const scene = sb()?.scene
        if (!scene) return
        for (const id of scene.selected) {
          const u = scene.unitById(id)
          if (u) { u.moveTarget = null; u.attackTarget = null }
        }
      },
      selectAll: () => {
        const scene = sb()?.scene
        if (!scene) return
        scene.selectClear()
        for (const u of scene.units()) if (!u.dead) scene.selectAdd(u.id)
      },
      deselectAll: () => sb()?.scene?.selectClear(),
      clearField: async () => {
        // Confirm before wiping the battlefield — the user spent time
        // placing those units and an accidental click is irreversible.
        const scene = sb()?.scene
        if (!scene) return
        const count = [...scene.units()].length
        if (count === 0) return
        const ok = await confirmDialog({
          title: 'Clear Field',
          message: count === 1
            ? 'Remove the unit currently on the battlefield?'
            : `Remove all ${count} units currently on the battlefield?`,
          okLabel: 'Clear Field',
          cancelLabel: 'Cancel',
          okDanger: true,
        })
        if (!ok) return
        const ids = [...scene.units()].map((u) => u.id)
        for (const id of ids) scene.removeUnit(id)
      },
      resetCamera: () => {
        // Restore the default orbit pose the SandboxView starts at —
        // matches the camera's `open()` initialisation in
        // sandbox-view.js so the user gets the same framing they had
        // on first entry.
        const view = sb()
        if (!view || !view.camera) return
        view.camera.target = [0, 10, 0]
        view.camera.distance = 951.5
        view.camera.yaw = 215 * Math.PI / 180
        view.camera.pitch = 28 * Math.PI / 180
      },
      setPanelVisible: (panelId, visible) => setSandboxPanelVisible(panelId, visible),
    })
  }
  if (typeof ui.mountSandboxRibbon === 'function') ui.mountSandboxRibbon()
}
