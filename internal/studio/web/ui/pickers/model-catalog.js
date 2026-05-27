// model-catalog.js
//
// Tiny cache + fetcher for the /api/studio/models catalogue.  The
// Open Unit dialog uses it to populate its grid (items + loading
// flag); openModelViewer reads back the chosen unit's full meta
// (icon path, fbi category, etc) so the new tab carries the same
// metadata the catalogue grid showed.
//
// Module-scoped state is intentional: both call sites need the
// SAME list, and the legacy module-let pattern in studio.js
// (availableModels / modelsLoaded) was the simplest port.  A
// second fetch while one is in flight short-circuits because the
// `loaded` flag flips inside the try and never gets cleared again
// — duplicate concurrent fetches just rewrite the same array.

let _models = []
let _loaded = false

// fetchModels — drain /api/studio/models into the module-local
// catalogue.  Idempotent: subsequent calls re-fetch (in case the
// backend's catalogue grew), but the openers gate on isLoaded() so
// the second call usually doesn't happen.  Errors flip `loaded`
// true with an empty list so the React picker shows an empty grid
// instead of the perpetual "Loading…" placeholder.
export async function fetchModels() {
  try {
    const resp = await fetch('/api/studio/models')
    const data = await resp.json()
    _models = data.models || []
    _loaded = true
  } catch {
    _models = []
    _loaded = true
  }
}

// availableModels — the live catalogue array.  Returned by reference
// so callers walking it with .find() / .map() get the latest data
// after each fetch without re-importing.
export function availableModels() { return _models }

// isLoaded — true after the first fetch (success or failure) has
// settled.  Used by openModelPicker to drive the "Loading…" flag in
// the React dialog AND to gate the auto-fetch on first open.
export function isLoaded() { return _loaded }

// findModelMeta — look up the catalogue entry for `name` (the
// internal unit name, not the FBI Name field).  Returns the catalogue
// object or undefined when not found.
export function findModelMeta(name) {
  return _models.find((m) => m.name === name)
}
