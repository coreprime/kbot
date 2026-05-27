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
// human-readable.  Default: ON when the key is absent — the gesture is
// the natural way to test weapons in both views (Sandbox: shift-click
// ground, Viewer: plain click), and gating it behind a Settings
// checkbox before it works at all was a discoverability trap.  Users
// who don't want the gesture can opt OUT via Settings → Unit Editor.
const FLAG_KEY = 'studio.forceTargetGround'

export function forceTargetEnabled() {
  try {
    // Key absent → default ON.  Only an explicit "off" disables the
    // gesture so first-time users get working weapons immediately.
    return localStorage.getItem(FLAG_KEY) !== 'off'
  } catch { return true }
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
