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
import { isTakMapActive } from './tak-edit.js'

// withWarnings appends the server's save warnings (such as an .ota kept
// unchanged because it could not be read) to a status message.
function withWarnings(msg, warnings) {
  return warnings && warnings.length ? `${msg} Note: ${warnings.join('; ')}.` : msg
}

// qualityFixes runs the TA quality checker, which lints the tile-pool build
// pipeline. TA:K maps skip it — their terrain never goes through that
// pipeline (stamps write the 0x4000 TNT server-side) and the checker's rules
// assume tile stamps.
async function qualityFixes(payload) {
  if (isTakMapActive()) return []
  return runQualityChecker(payload)
}

export async function saveLoose() {
  const payload = buildSavePayload()
  const fixes = await qualityFixes(payload)
  if (!fixes) return false
  payload.fixes = fixes
  setStatus('Building TNT + OTA…')
  const warnings = []
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
      const warning = resp.headers.get('X-Kbot-Warning')
      if (warning) warnings.push(warning)
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
  setStatus(withWarnings('Saved loose .tnt + .ota.', [...new Set(warnings)]))
  const m = activeMap()
  if (m) { m.dirty = false; hostCallbacks.renderMapTabs?.() }
  return true
}

export async function save() {
  const payload = buildSavePayload()
  const fixes = await qualityFixes(payload)
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
    // Writable workspaces answer with a JSON receipt — the map's changed
    // files were written into the workspace VFS, nothing to download.
    // Read-only contexts stream the packaged HPI as before.
    const ctype = resp.headers.get('Content-Type') || ''
    if (ctype.includes('application/json')) {
      const receipt = await resp.json()
      const files = (receipt.saved || []).join(', ')
      setStatus(withWarnings(files ? `Saved ${files} to the workspace.` : 'Saved to the workspace.', receipt.warnings))
    } else {
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${sanitiseFilename(state.name)}.hpi`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      const warning = resp.headers.get('X-Kbot-Warning')
      setStatus(withWarnings(`Saved ${a.download}.`, warning ? [warning] : []))
    }
    const m = activeMap()
    if (m) { m.dirty = false; hostCallbacks.renderMapTabs?.() }
    return true
  } catch (err) {
    setStatus(`Save failed: ${err.message}`)
    return false
  }
}
