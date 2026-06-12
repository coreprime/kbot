// edit-actions.js
//
// "Edit" routing for files with editor support: a maps/*.tnt opens in the
// map editor, a units/*.fbi (or its sibling 3DO/COB, identified by stem)
// opens in the unit editor. The host callbacks are the same entry points
// the pickers use, so the editors hydrate identically to a dialog open.

import { hostCallbacks, setStatus } from '../host-context.js'

// editKind classifies a VFS path: 'map', 'unit', or null when the studio
// has no editor for it.
export function editKind(path) {
  const p = String(path || '').toLowerCase()
  if (p.startsWith('maps/') && p.endsWith('.tnt')) return 'map'
  if (p.startsWith('units/') && p.endsWith('.fbi')) return 'unit'
  return null
}

// openInEditor fires the right editor tab for the path. Map opens fetch the
// editor's load payload first (the same /api/studio/load the picker uses).
export async function openInEditor(path) {
  const kind = editKind(path)
  if (kind === 'map') {
    setStatus('Opening map editor…')
    try {
      const r = await fetch(`/api/studio/load?path=${encodeURIComponent(path)}`)
      if (!r.ok) throw new Error(await r.text())
      const data = await r.json()
      await hostCallbacks.openLoadedMap?.(data, null)
    } catch (e) {
      setStatus(`Map open failed: ${e?.message || e}`)
    }
    return
  }
  if (kind === 'unit') {
    const stem = path.split('/').pop().replace(/\.fbi$/i, '')
    hostCallbacks.openModelViewer?.(stem)
  }
}
