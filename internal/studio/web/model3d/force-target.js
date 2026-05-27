// force-target.js
//
// Shared opt-in policy for the "force-target the ground with the
// selected weapon" gesture.  Both the multi-unit Sandbox and the
// single-unit Unit Viewer surface this gesture, but with different
// modifier requirements:
//
//   - Sandbox requires Shift to disambiguate from "no-op left-click
//     on empty ground" (which preserves selection — see task #236).
//   - Unit Viewer does NOT require Shift: there's only one unit on
//     stage and clicking the ground unambiguously means "fire the
//     primary weapon at that point".
//
// This module owns the persisted opt-in flag (localStorage) and the
// shouldForceTarget() policy both views call.  The actual fire path
// lives at each call site — the Sandbox routes through the GameEngine
// (setWeaponTarget point target), the Viewer routes through the
// MvControls SM's per-slot `targets` field (which the existing
// _updateWeapon loop picks up next tick).  Unifying those two fire
// paths into a single engine-based pipeline is the deeper refactor
// (task #244); this module is the policy layer that lets us ship the
// gesture without that refactor blocking it.

// Persisted flag key.  Plain "on" / "off" so the localStorage UI is
// human-readable.  Default: OFF when the key is absent.  A plain
// canvas click in the unit viewer used to default to "fire primary at
// the clicked ground point", which surprised users who'd just loaded
// a unit (e.g. ARMBATs tries to shoot itself from a stray click on
// the model).  Off-by-default keeps clicks as pure orbit-camera until
// the user explicitly arms a slot from the Actions panel; opting IN
// via Settings → Unit Editor restores the legacy fast-fire gesture.
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
// requireShift = true  → Sandbox: only fires on Shift+click
// requireShift = false → Viewer:  fires on plain click
export function shouldForceTarget({ shiftKey, requireShift }) {
  if (!forceTargetEnabled()) return false
  if (requireShift) return !!shiftKey
  return true
}
