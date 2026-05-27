// settings.js
//
// Imperative open / close wrappers around the React Settings
// dialog (which lives at /ui/dialogs/settings-dialog.js).
//
// Owns DEFAULT_SETTINGS — the shipped defaults the Reset button
// restores into the form.  state.settings is the canonical
// source of truth, persisted via the PrefsStore alongside the
// visibility toggles.  Opening the dialog snapshots current
// values into the form; Apply pushes them back and flushes
// downstream effects (minimap + camera-info panels, View-menu
// flags, canvas re-render, prefs persist).
//
// Cross-module deps via hostCallbacks:
//   - reactUi.openSettingsDialog / closeSettingsDialog
//   - setCameraInfoVisible(visible) — camera-info panel toggle
//   - renderCanvas()                — repaint after Apply
//   - getWorldOptions()             — environment-dropdown options
//                                     (map editor registers this at boot)
//   - setMinimapVisible(visible)    — minimap-panel toggle
//                                     (map editor registers this at boot)
// Plus syncDomFromPrefs + persistPrefs from /ui/common/prefs.js.

import { state, tabs, tabState, clamp, setStatus, hostCallbacks, getReactUi } from '../host-context.js'
import { syncDomFromPrefs, persistPrefs } from '../common/prefs.js'

export const DEFAULT_SETTINGS = {
  zoomStep: 1.25,
  heartbeatIdleMs: 5000,
  heartbeatReconnectMs: 1000,
  defaultEraseSize: 1,
  defaultVoidsSize: 1,
  defaultHmRadius: 4,
  defaultHmStrength: 4,
  // Unit Editor defaults — applied when a new model tab opens.
  unitDefaultEnv: 'greenworld',
  unitDefaultReflections: true,
  unitDefaultBob: true,
  unitDefaultWaterReflections: true,
  unitDefaultSpecular: true,
  unitDefaultGodBeams: true,
}

// openSettingsDialog snapshots the current state into the
// initial form values, then hands the dialog the apply + reset
// callbacks.  Apply pushes back into the host's state.settings +
// flushes downstream effects.
export function openSettingsDialog() {
  const ui = getReactUi()
  if (!ui || typeof ui.openSettingsDialog !== 'function') return
  const s = state.settings || DEFAULT_SETTINGS
  const activeTab = tabState.activeIndex >= 0 ? tabs[tabState.activeIndex] : null
  const defaultTab = activeTab?.type === 'model' ? 'unit'
    : activeTab?.type === 'map' ? 'map'
    : 'general'
  // forceTargetGround lives in localStorage (force-target.js
  // owns it).  Default OFF — the unit viewer's plain canvas
  // click should orbit the camera, not fire the primary weapon
  // at whatever the ground raycast hits.  Mirrors
  // force-target.js's forceTargetEnabled() default.
  let forceTargetGround = false
  try { forceTargetGround = (localStorage.getItem('studio.forceTargetGround') === 'on') } catch { /* ignore */ }
  const envOptions = hostCallbacks.getWorldOptions?.() || []
  const initial = {
    zoomStep:                  s.zoomStep ?? 1.25,
    defaultEraseSize:          s.defaultEraseSize ?? 1,
    defaultVoidsSize:          s.defaultVoidsSize ?? 1,
    defaultHmRadius:           s.defaultHmRadius ?? 4,
    defaultHmStrength:         s.defaultHmStrength ?? 4,
    heartbeatIdleMs:           s.heartbeatIdleMs ?? 5000,
    heartbeatReconnectMs:      s.heartbeatReconnectMs ?? 1000,
    showMinimap:               !!state.showMinimap,
    showCameraInfo:            !!state.showCameraInfo,
    showGridlines:             !!state.showGridlines,
    animateFeatures:           !!state.animateFeatures,
    showVoids:                 !!state.showVoids,
    showContours:              !!state.showContours,
    showBuildable:             !!state.showBuildable,
    showFeatures:              !!state.showFeatures,
    showStartPositions:        !!state.showStartPositions,
    unitDefaultEnv:            s.unitDefaultEnv ?? 'greenworld',
    unitDefaultReflections:    s.unitDefaultReflections !== false,
    unitDefaultBob:            s.unitDefaultBob !== false,
    unitDefaultWaterReflections: s.unitDefaultWaterReflections !== false,
    unitDefaultSpecular:       s.unitDefaultSpecular !== false,
    unitDefaultGodBeams:       s.unitDefaultGodBeams !== false,
    forceTargetGround,
  }
  void ui.openSettingsDialog({
    initial,
    envOptions,
    defaultTab,
    onApply: (v) => {
      const next = { ...DEFAULT_SETTINGS, ...(state.settings || {}) }
      next.zoomStep             = clamp(+v.zoomStep || 1.25, 1.05, 2)
      next.defaultEraseSize     = clamp(Math.round(+v.defaultEraseSize || 1), 1, 16)
      next.defaultVoidsSize     = clamp(Math.round(+v.defaultVoidsSize || 1), 1, 32)
      next.defaultHmRadius      = clamp(Math.round(+v.defaultHmRadius || 4), 1, 32)
      next.defaultHmStrength    = clamp(Math.round(+v.defaultHmStrength || 4), 1, 32)
      next.heartbeatIdleMs      = clamp(Math.round(+v.heartbeatIdleMs || 5000), 500, 60000)
      next.heartbeatReconnectMs = clamp(Math.round(+v.heartbeatReconnectMs || 1000), 200, 10000)
      next.unitDefaultEnv               = v.unitDefaultEnv || 'greenworld'
      next.unitDefaultReflections       = !!v.unitDefaultReflections
      next.unitDefaultBob               = !!v.unitDefaultBob
      next.unitDefaultWaterReflections  = !!v.unitDefaultWaterReflections
      next.unitDefaultSpecular          = !!v.unitDefaultSpecular
      next.unitDefaultGodBeams          = !!v.unitDefaultGodBeams
      state.settings = next
      try { localStorage.setItem('studio.forceTargetGround', v.forceTargetGround ? 'on' : 'off') } catch { /* ignore */ }
      hostCallbacks.setMinimapVisible?.(!!v.showMinimap)
      hostCallbacks.setCameraInfoVisible?.(!!v.showCameraInfo)
      state.showGridlines       = !!v.showGridlines
      state.animateFeatures     = !!v.animateFeatures
      state.showVoids           = !!v.showVoids
      state.showContours        = !!v.showContours
      state.showBuildable       = !!v.showBuildable
      state.showFeatures        = !!v.showFeatures
      state.showStartPositions  = !!v.showStartPositions
      syncDomFromPrefs()
      persistPrefs()
      hostCallbacks.renderCanvas?.()
      setStatus('Settings applied and saved.')
    },
    onReset: () => {
      // Restore SHIPPED defaults into the form (the React
      // component re-seeds its local state from whatever this
      // returns).  Doesn't commit — the user still has to hit
      // Apply.
      state.settings = { ...DEFAULT_SETTINGS }
      return {
        ...initial,
        zoomStep:                  DEFAULT_SETTINGS.zoomStep,
        defaultEraseSize:          DEFAULT_SETTINGS.defaultEraseSize,
        defaultVoidsSize:          DEFAULT_SETTINGS.defaultVoidsSize,
        defaultHmRadius:           DEFAULT_SETTINGS.defaultHmRadius,
        defaultHmStrength:         DEFAULT_SETTINGS.defaultHmStrength,
        heartbeatIdleMs:           DEFAULT_SETTINGS.heartbeatIdleMs,
        heartbeatReconnectMs:      DEFAULT_SETTINGS.heartbeatReconnectMs,
        unitDefaultEnv:            DEFAULT_SETTINGS.unitDefaultEnv,
        unitDefaultReflections:    DEFAULT_SETTINGS.unitDefaultReflections,
        unitDefaultBob:            DEFAULT_SETTINGS.unitDefaultBob,
        unitDefaultWaterReflections: DEFAULT_SETTINGS.unitDefaultWaterReflections,
        unitDefaultSpecular:       DEFAULT_SETTINGS.unitDefaultSpecular,
        unitDefaultGodBeams:       DEFAULT_SETTINGS.unitDefaultGodBeams,
      }
    },
  })
}

export function closeSettingsDialog() {
  const ui = getReactUi()
  if (ui && typeof ui.closeSettingsDialog === 'function') {
    ui.closeSettingsDialog()
  }
}
