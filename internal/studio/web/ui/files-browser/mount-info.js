// mount-info.js
//
// Pure helpers that word how the server mounted the install: the archive
// discovery mode, each archive's place in the lookup order, and why an
// archive was not mounted.  The Home page and the Layering tab render
// these strings; keeping them free of UI imports lets node --test cover
// them.

// discoveryText explains a discovery mode ("game-order", "all-archives",
// or several joined with "," for a layered context).
export function discoveryText(mode) {
  const modes = String(mode || '').split(',').filter(Boolean)
  if (modes.length === 0) return ''
  if (modes.every((m) => m === 'game-order')) {
    return 'TA 3.1c order: loose files, then rev31.gp3, every *.ccx, every *.ufo and the first ten *.hpi ' +
      '(each group in upper-case name order), then the *.hpi past that limit. The first archive holding a file wins.'
  }
  if (modes.every((m) => m === 'all-archives')) {
    return 'Overlay order: loose files, then every archive by extension and name; a later archive overrides an earlier one.'
  }
  return `Mixed discovery (${modes.join(', ')}): each context directory is ordered by its own mode.`
}

// layerKind and layerMount read the server's layer records, which arrive
// PascalCase (Go struct fields); camelCase is tolerated too.
function layerKind(l) { return l.kind ?? l.Kind ?? '' }
function layerMount(l) { return l.mount ?? l.Mount ?? 0 }
function layerNote(l) { return l.note ?? l.Note ?? '' }

// layerPlacement describes where one layer of a file sits in the mount.
export function layerPlacement(layer) {
  const kind = layerKind(layer)
  if (kind === 'workspace') return 'workspace edit (beats every archive)'
  if (kind === 'loose') return 'loose file (beats every archive)'
  const mount = layerMount(layer)
  if (!mount) return ''
  const note = layerNote(layer)
  return note ? `mount #${mount} · ${note}` : `mount #${mount}`
}

// mountRows normalises the ?stats document's mount order into display
// rows: position, archive name, version tag (only when not v1) and note.
export function mountRows(stats) {
  const list = (stats && stats.mountOrder) || []
  return list.map((m) => ({
    position: m.position,
    name: m.name,
    tag: m.version && m.version !== 'v1' ? m.version : '',
    note: m.note || '',
  }))
}

// skippedRows normalises the ?stats document's skipped archives into
// display rows with a reason in words.
export function skippedRows(stats) {
  const list = (stats && stats.skippedArchives) || []
  return list.map((s) => ({ name: s.name, reason: s.detail || s.reason || 'not mounted' }))
}
