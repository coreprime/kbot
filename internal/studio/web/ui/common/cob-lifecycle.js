// cob-lifecycle.js
//
// Per-tick lifecycle advancement shared between the unit editor and
// the sandbox.  The Create / Activate / Deactivate scripts a TA unit
// ships with each correspond to a discrete phase the studio tracks
// on the binding:
//
//   unborn        Create script has never run.  Action panel buttons
//                 are disabled; only Create itself is allowed.
//   creating      Create thread is mid-flight.  Same gating as unborn.
//   created       Create finished.  Unit responds to commands.
//   activated     Activate finished — engines on, hatches open, etc.
//   deactivated   Deactivate finished — engines off, hatches closed.
//
// Transitions:
//
//   unborn → creating         runCobEntry('Create')
//   creating → created        Create thread has died (auto)
//   created → activated       build ramp finished AND unit has an
//                             Activate script (auto)
//   activated ↔ deactivated   runCobEntry('Activate' | 'Deactivate')
//
// advanceCobLifecycle handles the two AUTO transitions and is the
// reason a freshly-spawned unit ends up in its idle-on pose without
// the user having to click Activate.  Manual flips still go through
// the unit-editor's runCobEntry — which writes the lifecycle, fires
// the helper scripts (activatescr / OpenYard / deactivatescr /
// CloseYard), plays the audio cue, and runs the Activate script
// itself.

// _bindingOf walks through the wrapCobWithAggregate proxy down to the
// underlying CobBinding so _lifecycle writes persist across refresh
// ticks.  The sandbox rebuilds the proxy each publish, and writes to
// the proxy's own-property bag would vanish the next time the proxy
// is recreated.
//
// Detection: a wrap built by wrapCobWithAggregate has the binding as
// its prototype, and the binding has an OWN `unit` property (set in
// the CobBinding constructor).  A bare CobBinding's prototype is its
// class .prototype which has methods but no own `unit` — so checking
// the prototype for an own `unit` reliably distinguishes wrap from
// binding.  The sandbox stub `{ runtime, unit: null, hasScript: () =>
// false }` also has own `unit`, so the walker returns the stub —
// hasScript() returns false there and advanceCobLifecycle no-ops.
export function bindingOf(cob) {
  if (!cob) return cob
  const proto = Object.getPrototypeOf(cob)
  if (proto && Object.prototype.hasOwnProperty.call(proto, 'unit')) {
    return proto
  }
  return cob
}

function _isScriptRunning(binding, name) {
  if (!binding || !binding.unit || !binding.unit._threads) return false
  const lower = name.toLowerCase()
  for (const t of binding.unit._threads) {
    if (!t.dead && t.script.name.toLowerCase() === lower) return true
  }
  return false
}

// _startActivate fires the Activate-side scripts on the binding.
// Returns true when a transition occurred.  Side-scripts (activatescr,
// OpenYard) match the manual runCobEntry path so the visible animation
// is the same whether Activate ran from a user click or from the
// auto-trigger.  Audio cue is intentionally skipped here — the
// auto-trigger fires from a per-tick walker that may iterate dozens
// of units; playing a "ready for orders" SFX for each at spawn time
// would be cacophonous.  The manual user-driven path (runCobEntry)
// still plays the cue.
function _startActivate(binding) {
  if (!binding || binding._lifecycle === 'activated') return false
  binding._lifecycle = 'activated'
  if (binding.hasScript('activatescr') && !_isScriptRunning(binding, 'activatescr')) {
    try { binding.start('activatescr') } catch { /* ignore */ }
  }
  if (binding.hasScript('OpenYard') && !_isScriptRunning(binding, 'OpenYard')) {
    try { binding.start('OpenYard') } catch { /* ignore */ }
  }
  if (binding.hasScript('Activate')) {
    try { binding.start('Activate') } catch { /* ignore */ }
  }
  return true
}

// advanceCobLifecycle handles the per-tick AUTO transitions.
// Idempotent + cheap; safe to call every frame on every unit.
//
//   buildPercent — 100 (default) for views that don't model a build
//     ramp (sandbox).  The unit editor passes mv.cobBuildPercent so
//     Activate waits until the visual construction phase finishes.
export function advanceCobLifecycle(cobOrBinding, buildPercent = 100) {
  const binding = bindingOf(cobOrBinding)
  if (!binding || typeof binding.hasScript !== 'function') return
  // creating → created once the Create thread has died.  Default
  // (missing _lifecycle) is treated as 'created' so units with no
  // Create script flow straight into the Activate check.
  if (binding._lifecycle === 'creating' && !_isScriptRunning(binding, 'Create')) {
    binding._lifecycle = 'created'
  }
  // created → activated once the build ramp has finished AND the unit
  // has an Activate script.  Skips silently when no Activate is
  // defined.
  const lifecycle = binding._lifecycle || 'created'
  if (lifecycle === 'created'
      && (buildPercent | 0) >= 100
      && binding.hasScript('Activate')) {
    _startActivate(binding)
  }
}
