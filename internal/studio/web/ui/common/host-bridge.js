// host-bridge.js
//
// Injection point for host-supplied behaviour the React panels need
// but shouldn't import directly from studio.js (would pull the whole
// 17 kLoC namespace into the Preact island).  studio.js calls
// `configureHostBridge({...})` once at boot with the concrete
// implementations; components import `hostBridge` and call through.
//
// Defaults are all no-ops so the module is safe to import in
// isolation (tests / playgrounds) without a configured host.

const _noopBridge = {
  // Camera + tracking — wired up by the host so the React Renderer
  // panel's Tracking / Auto-Rotate checkboxes can call into the
  // active view (sandbox or unit editor) without knowing which one.
  setTracking:   (_on) => {},
  setAutoRotate: (_on) => {},
  // COB script lifecycle — Actions panel uses these to enumerate +
  // launch entry points and to grey out buttons whose script has a
  // live thread.
  runCobEntry:        (_cob, _name) => {},
  isCobScriptRunning: (_cob, _name) => false,
  // Controls panel "Create Unit" pre-Create banner — fires the
  // unit's Create script + kicks off the build-progress animation.
  // Implementation lives in studio.js (it manipulates the model
  // viewer's cob + _autoBuild fields the React tree doesn't see).
  runControlsCreate: () => {},
  // Runtime panel — playback rate + Pause/Step/Stop All controls.
  // Concrete bodies live in studio.js (single source of truth for
  // both the COB-menu Playback slider + the Runtime overlay slider
  // is mvSetSimulationSpeed; pause / step / stop helpers similarly).
  setSimSpeed:           (_rate) => {},
  toggleRuntimePaused:   () => {},
  stepRuntime:           () => {},
  stopAllThreads:        () => {},
  // Per-unit Reset (Runtime panel's unit group header).  The host
  // routes to modelViewer.resetState() when the unit IS the
  // currently-loaded one, otherwise to the runtime-side reset that
  // strips threads + animators + vars.
  resetUnit:             (_unit, _cob) => {},
  // Thread-row click — opens the (still-vanilla) debugger modal.
  // Living behind the bridge means the React panel doesn't import
  // the modal's many-hundred-line code-view module at all.
  openThreadCodeModal:   (_cob, _thread) => {},
  // Network panel "Force Sync" — re-pull the full authoritative snapshot,
  // discarding local work. Routes to the active join scene's forceSync().
  forceSync:             () => {},
}

// Single live bridge object — overwritten by configureHostBridge.
// Exported as `hostBridge` so consumers see the LATEST callbacks
// even if configure runs after import (the consumer reads through
// the binding each call, not a captured reference).
export const hostBridge = { ..._noopBridge }

export function configureHostBridge(impl) {
  Object.assign(hostBridge, _noopBridge, impl)
}
