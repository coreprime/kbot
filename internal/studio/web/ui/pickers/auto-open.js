// auto-open.js
//
// ?initial_map=<name> URL parameter handler.  Skips the Welcome
// dialog and jumps straight into the named map.  Match is
// case-insensitive against either the file name or the OTA
// mission name so URL-friendly slugs like "Metal%20Heck" line up
// with however the catalogue indexes them.
//
// Polls /api/studio/maps for up to ~7.5 seconds while the
// server's map catalogue finishes preloading — the entry we're
// looking for may not be in the partial response delivered
// before /api/studio/maps flips loading=false.
//
// Cross-module deps via hostCallbacks:
//   - openLoadedMap(data, card) — hydrates editor state from the
//     /api/studio/load response.

import { setStatus, hostCallbacks } from '../host-context.js'

export async function maybeAutoOpenFromQuery() {
  let target
  try {
    target = new URLSearchParams(window.location.search).get('initial_map')
  } catch { return }
  if (!target) return false
  const wanted = target.trim().toLowerCase()
  if (!wanted) return false
  try {
    // Poll until the server's map catalogue has finished
    // preloading — the entry we're looking for may not be in the
    // partial response delivered before /api/studio/maps flips
    // loading=false.
    let entries = []
    for (let i = 0; i < 30; i++) {
      const resp = await fetch('/api/studio/maps')
      const data = await resp.json()
      entries = data.maps || []
      const match = pickMapByName(entries, wanted)
      if (match) {
        const loadResp = await fetch('/api/studio/load?path=' + encodeURIComponent(match.path))
        if (!loadResp.ok) throw new Error(await loadResp.text() || `HTTP ${loadResp.status}`)
        const loaded = await loadResp.json()
        await hostCallbacks.openLoadedMap?.(loaded, match)
        return true
      }
      if (!data.loading) break
      await new Promise(r => setTimeout(r, 250))
    }
    setStatus(`initial_map="${target}" not found in this kbot context.`)
    return false
  } catch (err) {
    setStatus(`Failed to auto-open ${target}: ${err.message || err}`)
    return false
  }
}

// pickMapByName matches the wanted slug against either the file
// name or the OTA mission name, with a substring fallback so
// partial names like "metal heck" still match a fuller "Metal
// Heck (Free)" if the catalogue carries the suffix.
function pickMapByName(entries, wanted) {
  for (const m of entries) {
    if ((m.name || '').toLowerCase() === wanted) return m
    if ((m.missionName || '').toLowerCase() === wanted) return m
  }
  for (const m of entries) {
    const hay = `${m.name || ''} ${m.missionName || ''}`.toLowerCase()
    if (hay.includes(wanted)) return m
  }
  return null
}
