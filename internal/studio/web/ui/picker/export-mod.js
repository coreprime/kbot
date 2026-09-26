// export-mod.js
//
// Pure helpers behind the picker's Export mod dialog: the archive formats
// offered per game, the export URLs, and the wording of the server's
// preflight check (where the archive would rank in TA 3.1c's mount order
// and which files the game would read from elsewhere).  Free of UI
// imports so node --test covers them.

// exportFormats lists the archive extensions offered for a workspace's
// game, the recommended one first.
export function exportFormats(game) {
  if (game === 'takingdoms') {
    return [{ value: 'hpi', label: '.hpi (TA: Kingdoms archive)' }]
  }
  return [
    { value: 'ufo', label: '.ufo: ranks above every .hpi, no count limit (recommended)' },
    { value: 'ccx', label: '.ccx: ranks above every .ufo' },
    { value: 'hpi', label: '.hpi: mounted only while fewer than ten *.hpi sort before it' },
  ]
}

// slugify matches the server's file-name slug (lower-case letters and
// digits, runs of anything else as '-').
export function slugify(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'ws'
}

// exportURL builds the hub export URL for a workspace folder.
export function exportURL(dir, { ext, name, preflight } = {}) {
  const q = [`dir=${encodeURIComponent(dir)}`]
  if (ext) q.push(`ext=${encodeURIComponent(ext)}`)
  if (name) q.push(`name=${encodeURIComponent(name)}`)
  if (preflight) q.push('preflight=1')
  return `/api/hub/export?${q.join('&')}`
}

// preflightLines turns a preflight report into display lines, each
// { tone: 'ok' | 'warn' | 'error' | 'info', text }.
export function preflightLines(check) {
  if (!check) return []
  const out = []
  if (check.checked) {
    if (!check.mounted) {
      out.push({ tone: 'error', text: `TA 3.1c would not mount ${check.archive}.` })
    } else {
      const after = (check.outrankedBy || [])
      const tail = after.length === 0
        ? ' It outranks every other archive.'
        : ` ${after.length} archive${after.length === 1 ? '' : 's'} rank above it: ${summariseNames(after, 6)}.`
      out.push({ tone: 'ok', text: `TA 3.1c would mount ${check.archive} at position ${check.position} of ${check.of}.${tail}` })
    }
  }
  for (const n of check.notes || []) out.push({ tone: check.checked ? 'warn' : 'info', text: n })
  return out
}

// shadowedRows lists the exported files another source provides first,
// capped at limit rows plus a count of the rest.
export function shadowedRows(check, limit = 20) {
  const list = (check && check.shadowed) || []
  const rows = list.slice(0, limit).map((s) => ({ path: s.path, by: (s.by || []).join(', ') }))
  return { rows, more: Math.max(0, list.length - limit) }
}

function summariseNames(names, limit) {
  if (names.length <= limit) return names.join(', ')
  return `${names.slice(0, limit).join(', ')} and ${names.length - limit} more`
}
