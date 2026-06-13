// build-watcher.js
//
// Stops a tab from silently running stale JS after a server redeploy. The
// server exposes /api/build-id — a fingerprint of the embedded web bundle's
// index.html, which names every hashed asset (JS chunks AND the wasm engine),
// so the id shifts on any rebuild. We record it once at boot and poll; when it
// changes the server has restarted with a new build, so we reload to pull it.
//
// This is the fix for the recurring "I rebuilt but it still shows the old
// behaviour" confusion: an open tab now reloads itself within ~12s of a deploy
// (or instantly when the tab regains focus), instead of waiting for the user to
// remember a hard refresh.

let loadedId = null
let stopped = false

async function fetchBuildId() {
  try {
    const r = await fetch('/api/build-id', { cache: 'no-store' })
    if (!r.ok) return null
    const j = await r.json()
    return (j && j.id) || null
  } catch {
    return null
  }
}

async function check() {
  if (stopped) return
  const id = await fetchBuildId()
  if (!id) return
  if (loadedId === null) {
    loadedId = id
    return
  }
  if (id !== loadedId) {
    stopped = true
    // A full navigation tears down the in-memory module graph; the no-store
    // index.html then fetches the current hashed bundle.
    location.reload()
  }
}

// startBuildWatcher records the running build at boot and watches for the
// server moving to a newer one. Idempotent — calling twice is a no-op.
let started = false
export function startBuildWatcher() {
  if (started) return
  started = true
  check()
  setInterval(check, 10000)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) check()
  })
}
