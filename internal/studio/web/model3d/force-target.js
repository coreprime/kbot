// force-target.js
//
// Shared opt-in policy for the "force-target the ground with the
// selected weapon" gesture.  Multi-entity and single-entity hosts
// surface this gesture, but with different modifier requirements:
//
//   - Multi-entity hosts require Shift to disambiguate from "no-op
//     left-click on empty ground" (which preserves selection).
//   - Single-entity hosts do NOT require Shift: there's only one unit
//     on stage and clicking the ground unambiguously means "fire the
//     primary weapon at that point".
//
// This module owns the persisted opt-in flag (localStorage) and the
// shouldForceTarget() policy callers consult.  The actual fire path
// lives at each call site — multi-entity hosts route through the
// GameEngine (setWeaponTarget point target), single-entity hosts may
// route through their own per-slot targets field that the engine's
// weapon loop picks up next tick.

// Persisted flag key.  Plain "on" / "off" so the localStorage UI is
// human-readable.  Default: OFF when the key is absent.  A plain
// canvas click previously defaulted to "fire primary at the clicked
// ground point", which surprised users who'd just loaded a unit
// (e.g. ARMBATs tries to shoot itself from a stray click on the
// model).  Off-by-default keeps clicks as pure orbit-camera until
// the user explicitly arms a slot from the Actions panel; opting IN
// via the host's settings restores the legacy fast-fire gesture.
const FLAG_KEY = 'studio.forceTargetGround'

export function forceTargetEnabled() {
  try {
    // Key absent → default OFF.  Only an explicit "on" enables the
    // gesture so a fresh-loaded unit doesn't fire at the first click.
    return localStorage.getItem(FLAG_KEY) === 'on'
  } catch { return false }
}

export function setForceTargetEnabled(on) {
  try { localStorage.setItem(FLAG_KEY, on ? 'on' : 'off') } catch { /* ignore */ }
}

// shouldForceTarget — given the modifier state of the click + the
// host view's "require Shift" policy, decide whether this click
// should fire the force-target-ground gesture.  Always returns false
// when the opt-in flag is off, so callers don't have to repeat the
// flag check at every site.
//
// requireShift = true  → multi-entity hosts: only fires on Shift+click
// requireShift = false → single-entity hosts: fires on plain click
export function shouldForceTarget({ shiftKey, requireShift }) {
  if (!forceTargetEnabled()) return false
  if (requireShift) return !!shiftKey
  return true
}
