// ai-format.js
//
// Labels for the AI profile viewer, following how TA 3.1c reads a profile
// (the describe endpoint resolves the values; see internal/aiprofile):
// a limit of -1 is unlimited and 0 or any other negative value forbids the
// target, a weight multiplies a unit's build priority (clamped to 0-100%),
// and a value is the numeric prefix of the word written ("O" reads as 0).

// limitLabel renders a limit directive or an effective setting.
export function limitLabel(limit) {
  const max = limit.maximum !== undefined ? limit.maximum : limit.limit
  if (max === -1) return '∞ Unlimited'
  if (limit.forbids || limit.forbidden || max <= 0) return 'Disabled'
  return `Max: ${max}`
}

// limitDisabled reports whether a limit forbids its target.
export function limitDisabled(limit) {
  return limitLabel(limit) === 'Disabled'
}

// weightLabel renders a weight multiplier.
export function weightLabel(weight) {
  return `×${weight}`
}

// weightBarPercent is the bar width for a weight: the percentage a unit at
// the default 100% is left with (the game clamps to 0-100).
export function weightBarPercent(weight) {
  if (!(weight > 0)) return 0
  return Math.min(weight * 100, 100)
}

// kindLabel names what a directive's target is.  matchesNone marks a
// category no unit in the install has, so the line does nothing (often a
// misspelt unit name).
export function kindLabel(kind, matchesNone = false) {
  switch (kind) {
    case 'unit': return 'unit'
    case 'category': return matchesNone ? 'category, matches no unit' : 'category'
    case 'all': return 'all units'
    case 'none': return 'no target'
    default: return ''
  }
}

// writtenNote explains a value word the game reads differently from how it
// looks ("O" → 0), or '' when the word is the number itself.
export function writtenNote(raw, value) {
  if (raw === undefined || raw === null) return ''
  if (raw === '') return 'no value: reads as 0'
  const n = Number(raw)
  if (Number.isFinite(n) && n === value) return ''
  return `written “${raw}”`
}
