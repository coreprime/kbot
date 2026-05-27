// save.js
//
// Save handlers — two flavours:
//   - save()       posts to /api/studio/save and downloads the
//                  packaged HPI archive (the normal user save).
//   - saveLoose()  posts twice to /api/studio/save-loose with
//                  ?which=tnt and ?which=ota, downloading each file
//                  separately.  Useful for the "uncompiled assets"
//                  workflow when a user wants the raw TNT + OTA out
//                  of the editor without HPI packaging.
//
// Both routes share the pre-save dance: build a JSON snapshot, run
// the Quality Checker, fold the user's accepted fix ids back into
// the payload, then ship the result.  On success they flip the
// active map's dirty flag and refresh the tab bar so the unsaved
// dot disappears.
//
// Cross-module deps via hostCallbacks:
//   - renderMapTabs() — clears the unsaved-dot after a successful save

import { state, setStatus, sanitiseFilename, hostCallbacks, activeMap } from '../host-context.js'
import { buildSavePayload } from './save-payload.js'
import { runQualityChecker } from './dialogs/quality-checker.js'

export async function saveLoose() {
  const payload = buildSavePayload()
  const fixes = await runQualityChecker(payload)
  if (!fixes) return false
  payload.fixes = fixes
  setStatus('Building TNT + OTA…')
  for (const which of ['tnt', 'ota']) {
    try {
      const resp = await fetch(`/api/studio/save-loose?which=${which}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!resp.ok) {
        const text = await resp.text()
        throw new Error(text || `HTTP ${resp.status}`)
      }
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${sanitiseFilename(state.name)}.${which}`
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setStatus(`Loose save failed (${which}): ${err.message}`)
      return false
    }
  }
  setStatus('Saved loose .tnt + .ota.')
  const m = activeMap()
  if (m) { m.dirty = false; hostCallbacks.renderMapTabs?.() }
  return true
}

export async function save() {
  const payload = buildSavePayload()
  const fixes = await runQualityChecker(payload)
  if (!fixes) return false
  payload.fixes = fixes
  setStatus('Building HPI archive…')
  try {
    const resp = await fetch('/api/studio/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(text || `HTTP ${resp.status}`)
    }
    const blob = await resp.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${sanitiseFilename(state.name)}.hpi`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    setStatus(`Saved ${a.download}.`)
    const m = activeMap()
    if (m) { m.dirty = false; hostCallbacks.renderMapTabs?.() }
    return true
  } catch (err) {
    setStatus(`Save failed: ${err.message}`)
    return false
  }
}
