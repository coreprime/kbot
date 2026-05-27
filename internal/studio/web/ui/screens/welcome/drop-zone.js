// drop-zone.js
//
// Welcome-screen drag-and-drop loader.  Lets the user drag a .tnt
// file (+ optional .ota sibling) from their desktop onto the
// welcome modal and load it without going through VFS.
//
// The drop targets are the welcome-options grid; the body is a
// fallback so the page doesn't navigate away when a file misses
// the modal.  Successful uploads route through the openLoadedMap
// host callback which hydrates editor state and switches into the
// editor.

import { $, setStatus, hostCallbacks } from '../../host-context.js'

export function wireWelcomeDropZone() {
  const wel = $('#welcome-dialog')
  if (!wel) return
  const block = (e) => { e.preventDefault(); e.stopPropagation() }
  for (const ev of ['dragenter', 'dragover']) {
    wel.addEventListener(ev, (e) => { block(e); wel.classList.add('drop-hover') })
  }
  for (const ev of ['dragleave', 'drop']) {
    wel.addEventListener(ev, (e) => { block(e); wel.classList.remove('drop-hover') })
  }
  wel.addEventListener('drop', async (e) => {
    const files = Array.from(e.dataTransfer?.files || [])
    if (files.length === 0) return
    let tntFile = null
    let otaFile = null
    for (const f of files) {
      const lower = (f.name || '').toLowerCase()
      if (lower.endsWith('.tnt')) tntFile = f
      else if (lower.endsWith('.ota')) otaFile = f
    }
    if (!tntFile) {
      setStatus('Drop a .tnt file (and optionally a sibling .ota) to load.')
      return
    }
    const form = new FormData()
    form.append('tnt', tntFile)
    if (otaFile) form.append('ota', otaFile)
    try {
      const resp = await fetch('/api/studio/load-upload', { method: 'POST', body: form })
      if (!resp.ok) {
        const text = await resp.text()
        throw new Error(text || `HTTP ${resp.status}`)
      }
      const data = await resp.json()
      $('#welcome-dialog').classList.add('hidden')
      $('#app').classList.remove('hidden')
      await hostCallbacks.openLoadedMap?.(data, null)
      setStatus(`Loaded ${tntFile.name}.`)
    } catch (err) {
      setStatus(`Upload failed: ${err.message}`)
    }
  })
}
