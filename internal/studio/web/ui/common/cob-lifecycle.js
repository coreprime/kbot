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
//   activated ↔ deactivated   runCobEntry('Activate' | 'Deactivate')
//
// advanceCobLifecycle handles ONLY the creating → created auto
// transition.  It used to also auto-fire Activate once the build ramp
// hit 100%, but that ran a SECOND script at spawn time — deploying
// e.g. the ARM Construction Vehicle into its build stance with nothing
// to build.  Spawn now runs Create alone; Activate is an explicit user
// action (the Actions panel's runCobEntry, which writes the lifecycle,
// fires the helper scripts — activatescr / OpenYard / deactivatescr /
// CloseYard — plays the audio cue, and runs Activate itself).

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

// advanceCobLifecycle handles the per-tick AUTO transition.
// Idempotent + cheap; safe to call every frame on every unit.
//
//   buildPercent — accepted for call-site compatibility (the unit
//     editor passes mv.cobBuildPercent); no longer consulted now that
//     Activate is user-driven only.
export function advanceCobLifecycle(cobOrBinding, _buildPercent = 100) {
  const binding = bindingOf(cobOrBinding)
  if (!binding || typeof binding.hasScript !== 'function') return
  // creating → created once the Create thread has died.  This is the
  // ONLY auto transition: a freshly-spawned unit runs Create and then
  // sits in 'created' — Activate is an explicit user action so units
  // (e.g. constructors) don't deploy into a working stance on spawn.
  if (binding._lifecycle === 'creating' && !_isScriptRunning(binding, 'Create')) {
    binding._lifecycle = 'created'
  }
}
