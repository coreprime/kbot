// pcx-compat.js
//
// The PCX viewer's game-compatibility badge.  The server's describe
// document carries `gameCompat` — what Total Annihilation 3.1c will do
// with the file (kbot-io's pcx Compat report): whether the game loads it
// at all, and every way it draws the file differently from the standard
// decode the preview shows (BytesPerLine padding, 24-bit data, a missing
// palette marker, ...).  This module turns that into a badge; it has no
// DOM or framework dependencies so it can be unit-tested under node.

// pcxCompatBadge returns { level, label, title } for a describe document,
// or null when the document has no compatibility report.  level is
// 'ok' | 'warn' | 'error'; title lists every issue, one per line.
export function pcxCompatBadge(describe) {
  const c = describe && describe.gameCompat
  if (!c) return null
  const issues = Array.isArray(c.issues) ? c.issues : []
  const title = issues.map((i) => `${i.severity}: ${i.message}`).join('\n')
  if (!c.loads) {
    return { level: 'error', label: 'TA will not load this file', title }
  }
  if (!c.ok || issues.length) {
    const n = issues.length
    return {
      level: 'warn',
      label: `TA draws this differently (${n} issue${n === 1 ? '' : 's'})`,
      title,
    }
  }
  return { level: 'ok', label: 'TA loads this file as shown', title: 'Total Annihilation 3.1c loads this file and draws it as the preview shows.' }
}
