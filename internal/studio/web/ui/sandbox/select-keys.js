// select-keys.js
//
// Game-defined selection hotkeys. Both games express "select units of a
// kind" as key → command strings in keys.tdf grammar: TA:Kingdoms ships the
// real file ([CUSTOMKEYS] — "CTRL_R = SelectUnits BALLISTIC;"), while Total
// Annihilation hardcoded the table in its executable, with units
// self-declaring membership through literal CTRL_x Category tokens
// ("Category=ARM KBOT ... CTRL_B"). The studio serves the session VFS's
// keys.tdf via /api/studio/keys; when the game ships none the active game
// adapter's defaultKeys table stands in (the TA adapter mirrors the retail
// hardcoded bindings in the same grammar).
//
// This module owns the table fetch, the keyboard-event → key-token mapping,
// command parsing, and the unit-attribute classifier. The keydown wiring and
// the screen-space variant live in SandboxView (which owns the projection).

import { activeGame } from '../common/game-registry.js'

let _keys = null
let _loading = null

// loadSelectionKeys resolves the active table once per page: the VFS
// keys.tdf when the game ships one, else the adapter's defaults.
export function loadSelectionKeys() {
  if (_keys) return Promise.resolve(_keys)
  if (_loading) return _loading
  _loading = fetch('/api/studio/keys')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((data) => {
      _keys = (data && data.keys) || activeGame().defaultKeys || {}
      return _keys
    })
  return _loading
}

// selectionKeys returns the resolved table, or null until loadSelectionKeys
// settles (callers kick the load on first use and simply miss the first
// keypress in the worst case).
export function selectionKeys() {
  return _keys
}

// keyTokenForEvent maps a DOM keyboard event onto the keys.tdf key-token
// grammar (CTRL_B, CTRLSHIFT_Y, LOWER_M, UPPER_T, plain digits). Meta is
// treated as Ctrl so macOS Cmd gestures land on the same bindings.
export function keyTokenForEvent(e) {
  const k = e.key || ''
  const isLetter = /^[a-z]$/i.test(k)
  const isDigit = /^[0-9]$/.test(k)
  if (!isLetter && !isDigit) return null
  const ctrl = e.ctrlKey || e.metaKey
  if (ctrl && e.altKey) return null
  if (ctrl) {
    return (e.shiftKey ? 'CTRLSHIFT_' : 'CTRL_') + k.toUpperCase()
  }
  if (isDigit) return k
  return (e.shiftKey ? 'UPPER_' : 'LOWER_') + k.toUpperCase()
}

// commandClauses splits a binding's command string into its comma-separated
// clauses, each as { verb, args } ("SelectUnits Monarch, TrackUnit" → two).
export function commandClauses(cmd) {
  return String(cmd || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((clause) => {
      const parts = clause.split(/\s+/)
      return { verb: (parts[0] || '').toLowerCase(), args: parts.slice(1) }
    })
}

// hasWeapon reports whether the meta declares any armed slot.
function hasWeapon(meta) {
  return Array.isArray(meta.weapons) && meta.weapons.some((w) => w && w.name)
}

// unitMatchesToken classifies a unit against a selection token: a literal
// FBI Category membership first (the canonical mechanism in both games),
// then the attribute-derived classes TA:K's table names that aren't plain
// category tokens on every unit.
export function unitMatchesToken(u, token) {
  const t = String(token || '').toUpperCase()
  if (!t) return false
  const meta = u.meta || {}
  const cats = meta.categories || []
  if (cats.includes(t)) return true
  switch (t) {
    case 'BUILDER':
      return !!meta.isBuilder
    case 'FACTORY':
      return !!meta.isBuilder && meta.canMove === false
    case 'FLY':
      return !!meta.isAircraft
    case 'BOAT':
    case 'NAVAL':
      return !!meta.isShip || !!meta.isSub
    case 'ATTACK':
      // Retail TA:K's binding comment: "All units with weapons except the
      // monarch" — losing the king to a careless ctrl+W attack-move ends
      // the match, so the class deliberately leaves it out.
      return hasWeapon(meta) && !cats.includes('MONARCH')
    case 'TROOPS':
      return meta.canMove !== false && hasWeapon(meta) && !meta.isShip && !meta.isSub
    default:
      return false
  }
}
