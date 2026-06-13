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
import { splitActivePane, closeActivePane, canCloseActivePane } from '@kbot/ui/split-host'
import { setEnhanceMeshEnabled } from '@kbot/game3d/enhance-mesh'

// wireSandboxRibbon — install the host bridge + mount the ribbon's
// React tree.  Idempotent; safe to call before / after the React UI
// module has resolved (the early-return guard bails until the UI
// bridge is up).
export function wireSandboxRibbon() {
  const ui = getReactUi()
  if (!ui) return
  const sb = () => hostCallbacks.getActiveSandboxView?.() || null
  // Graphics Options apply scene-wide: a sandbox tab can host N panes
  // (one renderer each, all observing the same shared scene), so a
  // toggle has to reach every pane's renderer — not just the focused
  // one — or split panes would drift out of sync.  Walk tab.panes when
  // present, falling back to the single active view otherwise.
  const eachRenderer = (fn) => {
    const tab = hostCallbacks.getActiveTab?.()
    const seen = new Set()
    if (tab && tab.panes && tab.panes.size > 0) {
      for (const v of tab.panes.values()) {
        if (v && v.renderer && !seen.has(v.renderer)) {
          seen.add(v.renderer)
          try { fn(v.renderer) } catch { /* ignore */ }
        }
      }
    }
    if (seen.size === 0) {
      const v = sb()
      if (v && v.renderer) { try { fn(v.renderer) } catch { /* ignore */ } }
    }
  }
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
      // Classic Camera — the original TA framing: a fixed 45-degree
      // look-down at the current target, keeping yaw + distance.
      classicCamera: () => {
        const view = sb()
        if (!view || !view.camera) return
        view.camera.pitch = 45 * Math.PI / 180
      },
      // Contour-line overlay over a loaded battlefield's terrain.
      setContours: (on) => {
        const view = sb()
        if (view && view.renderer) view.renderer.contoursEnabled = !!on
      },
      getContours: () => {
        const view = sb()
        return !!(view && view.renderer && view.renderer.contoursEnabled)
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
      // Pane layout — drive the active sandbox tab's split tree from
      // the View menu.  Resolve the live tab each time (the active tab
      // can change between clicks) and delegate to the generic split
      // API, which reuses the tab's wrapped adapter so the active-view
      // alias updates on focus reseat.
      splitActive: (orient) => {
        const tab = hostCallbacks.getActiveTab?.()
        if (tab) splitActivePane(tab, orient)
      },
      closeActive: () => {
        const tab = hostCallbacks.getActiveTab?.()
        if (tab) closeActivePane(tab)
      },
      canClose: () => {
        const tab = hostCallbacks.getActiveTab?.()
        return tab ? canCloseActivePane(tab) : false
      },
      setPanelVisible: (panelId, visible) => setSandboxPanelVisible(panelId, visible),

      // Geometry — sets the shared flag so units spawned from here load with
      // reconstructed faces.  Units already on the field keep their current
      // mesh until respawned (a live geometry swap of a commanded unit isn't
      // worth the churn); the unit viewer reloads in place.
      setEnhanceMesh:       (on) => setEnhanceMeshEnabled(!!on),

      // Graphics Options — broadcast to every pane's renderer so the
      // toggle/slider takes effect across the whole battlefield.
      setLightIntensity:    (v)  => eachRenderer((r) => r.setExposure?.(v)),
      setMaxDynamicLights:  (v)  => eachRenderer((r) => r.setMaxDynamicLights?.(v)),
      setShadows:           (on) => eachRenderer((r) => r.setShadowsEnabled?.(!!on)),
      setShadowIntensity:   (v)  => eachRenderer((r) => r.setShadowStrength?.(v)),
      setSelfShadow:        (on) => eachRenderer((r) => r.setSelfShadow?.(!!on)),
      setReflections:       (on) => eachRenderer((r) => r.setReflectionsEnabled?.(!!on)),
      setSpecular:          (on) => eachRenderer((r) => r.setSpecularEnabled?.(!!on)),
      setSpecularStrength:  (v)  => eachRenderer((r) => r.setSpecularStrength?.(v)),
      setMetalSpec:         (on) => eachRenderer((r) => r.setMetalSpecEnabled?.(!!on)),
      setRunningLights:     (on) => eachRenderer((r) => r.setRunningLightsEnabled?.(!!on)),
      setRunningLightsStrength: (v) => eachRenderer((r) => r.setRunningLightsStrength?.(v)),
      setBumpMap:           (on) => eachRenderer((r) => r.setBumpEnabled?.(!!on)),
      setBumpStrength:      (v)  => eachRenderer((r) => r.setBumpStrength?.(v)),
      setGodBeams:          (on) => eachRenderer((r) => r.setGodBeamsEnabled?.(!!on)),
      setDoF:               (on) => eachRenderer((r) => r.setDoFEnabled?.(!!on)),
      setDoFDistance:       (v)  => eachRenderer((r) => r.setDoFDistance?.(v)),
      setDoFLevel:          (v)  => eachRenderer((r) => r.setDoFLevel?.(v)),
      setAntialias:         (on) => eachRenderer((r) => r.setAntialiasEnabled?.(!!on)),
      setCinematic:         (on) => eachRenderer((r) => r.setCinematic?.(!!on)),
      setCinematicStrength: (v)  => eachRenderer((r) => r.setCinematicStrength?.(v)),
      setBloom:             (on) => eachRenderer((r) => r.setBloomEnabled?.(!!on)),
      setBloomStrength:     (v)  => eachRenderer((r) => r.setBloomStrength?.(v)),
      setLensFlare:         (on) => eachRenderer((r) => r.setLensFlareEnabled?.(!!on)),
      setLensFlareStrength: (v)  => eachRenderer((r) => r.setLensFlareStrength?.(v)),
      setWaterReflections:  (on) => eachRenderer((r) => r.setWaterReflectionsEnabled?.(!!on)),
      setWaves:             (on) => eachRenderer((r) => r.setWavesEnabled?.(!!on)),
      setWavesIntensity:    (v)  => eachRenderer((r) => r.setWavesIntensity?.(v)),
      setBob:               (on) => eachRenderer((r) => r.setBobEnabled?.(!!on)),
      setBobAmount:         (v)  => eachRenderer((r) => r.setBobAmount?.(v)),
      setBobSpeed:          (v)  => eachRenderer((r) => r.setBobSpeed?.(v)),
    })
  }
  if (typeof ui.mountSandboxRibbon === 'function') ui.mountSandboxRibbon()
}
