// inspector-store.js
//
// Signals-backed "context" for everything the live inspector panels
// need to render their bodies.  The host (studio.js's
// refreshMvInspectors) calls publishInspectorState({...}) once per
// throttled tick; the React panels subscribe via direct .value reads
// and Preact re-renders only the panels whose dependencies actually
// changed.  This is the "useContext" surface for the migration —
// every Preact panel imports from here instead of reaching across
// into studio.js's globals.
//
// Keeping the state in signals (not a single object) lets components
// subscribe to just what they need.  A panel that only cares about
// sandboxActive (e.g. for the Multiple-Units empty-state branch)
// re-renders only when sandboxActive changes — not every tick the
// host publishes a fresh mv reference.

import { signal } from '@preact/signals'

// mv — the inspector proxy.  Whatever shape the active view's
// getInspectorMv() returns (cob / camera / renderer / cobPorts /
// _focusedUnitId etc.).  Null between views or before the first
// publish.
export const mv = signal(null)

// sandboxActive — true while #model-viewer-dialog has the sandbox-
// mode class.  Drives the per-panel empty-state messages + the
// Controls panel's per-button gating.
export const sandboxActive = signal(false)

// sandboxSelSize — number of currently-selected sandbox units.
// 0 = empty, 1 = single (so per-unit panels show their content),
// 2+ = multi (panels that don't make sense for groups show their
// "multiple units selected" empty state).  Always 0 in viewer mode.
export const sandboxSelSize = signal(0)

// runtimeTick — monotonic counter the host increments on every
// throttled refresh tick.  Components that read NON-signal live
// values (e.g. mv.renderer.getFPS(), audio entry.audio.currentTime)
// subscribe by reading this signal once in their body; the read
// makes the component re-render every tick so the freshly-sampled
// values reach the DOM.  Cheap because the signal value is just an
// integer that changes once per 250 ms publish.
export const runtimeTick = signal(0)

// actionsIncludePrivate — Actions panel filter toggle.  Persisted by
// the host via the existing state.mvActionsIncludePrivate field so
// React + legacy code can share one source of truth during the
// migration window.
export const actionsIncludePrivate = signal(false)

// controlsDevSectionVisible — Developer Controls dropdown toggle.
// True = show the developer port editors (Active / Health / Build
// stance / Build % / Armoured) at the bottom of the Controls panel;
// false = hide just that section while keeping Move/Fire orders +
// the action grid visible.  Sandbox-only effect (the unit editor
// always shows the dev rows).
export const controlsDevSectionVisible = signal(true)

// publishInspectorState — host calls this once per refresh tick
// with the freshly computed state.  Equality checks per field so a
// no-op publish (same mv, same flags) doesn't churn any subscriber.
// Signals dedupe automatically when the new value === old, but we
// still want to avoid building a new mv object every tick when the
// data hasn't changed — that's the host's responsibility, not ours.
export function publishInspectorState(next) {
  if (next.mv !== undefined && next.mv !== mv.value) mv.value = next.mv
  if (next.sandboxActive !== undefined && next.sandboxActive !== sandboxActive.value) {
    sandboxActive.value = !!next.sandboxActive
  }
  if (next.sandboxSelSize !== undefined && next.sandboxSelSize !== sandboxSelSize.value) {
    sandboxSelSize.value = next.sandboxSelSize | 0
  }
  bumpRuntimeTick()
}

// bumpRuntimeTick — increment runtimeTick without re-publishing the
// whole inspector state.  Use from hosts that just changed something
// the React panels read off mutable non-signal data (e.g. flipping
// rt.paused via the Pause button) and want the React tree to re-read
// it RIGHT NOW instead of waiting for the next throttled publish.
// Without this nudge the Pause/Resume label sits stale for up to one
// publish interval (~250 ms) after a click, which feels laggy.  Plain
// `+ 1` would overflow eventually; modulo keeps the value sane while
// still always being different from the previous tick.
export function bumpRuntimeTick() {
  runtimeTick.value = (runtimeTick.value + 1) & 0x7fffffff
}

// setActionsIncludePrivate — host bridge to persist the toggle.
// Components mutate via this so the persistence layer + signal stay
// in lockstep without each component knowing about the prefs.
let _persistActionsIncludePrivate = (_on) => {}
export function configureActionsIncludePrivate(loadFn, saveFn) {
  actionsIncludePrivate.value = !!loadFn()
  _persistActionsIncludePrivate = saveFn
}
export function setActionsIncludePrivate(on) {
  const v = !!on
  if (actionsIncludePrivate.value !== v) {
    actionsIncludePrivate.value = v
    _persistActionsIncludePrivate(v)
  }
}

// Mirror configurator + setter for the Controls developer-section
// toggle.  Shape mirrors actionsIncludePrivate so the host wires
// both through configureUi-style persistence callbacks.
let _persistControlsDevSectionVisible = (_on) => {}
export function configureControlsDevSectionVisible(loadFn, saveFn) {
  controlsDevSectionVisible.value = !!loadFn()
  _persistControlsDevSectionVisible = saveFn
}
export function setControlsDevSectionVisible(on) {
  const v = !!on
  if (controlsDevSectionVisible.value !== v) {
    controlsDevSectionVisible.value = v
    _persistControlsDevSectionVisible(v)
  }
}
