// async.js
//
// useAsync — a tiny data-fetching hook shared by the explorer pages.  It
// runs `fetcher` whenever `deps` change, cancelling the in-flight result
// on unmount/redep so a slow response can't clobber newer state, and
// exposes the familiar { data, loading, error } triple.
//
// Loading / ErrorMsg are the matching placeholder components so every
// page renders the same spinner and error chrome.

import { htm as html } from '@kbot/ui/htm-bind'
import { useEffect, useState } from 'preact/hooks'
import { rawURL } from '../api.js'

export function useAsync(fetcher, deps = []) {
  const [state, setState] = useState({ data: null, loading: true, error: null })

  useEffect(() => {
    let cancelled = false
    setState({ data: null, loading: true, error: null })
    fetcher()
      .then((data) => { if (!cancelled) setState({ data, loading: false, error: null }) })
      .catch((err) => { if (!cancelled) setState({ data: null, loading: false, error: err.message || String(err) }) })
    return () => { cancelled = true }
  }, deps)

  return state
}

// useRawText fetches a file's raw bytes as text (optionally from a
// specific archive layer).  Shared by the text/source/code tabs.
export function useRawText(path, source) {
  return useAsync(() => fetch(rawURL(path, source)).then((r) => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
    return r.text()
  }), [path, source])
}

export function Loading({ label }) {
  return html`<div class="fx-loading"><span class="fx-spinner"></span>${label || 'Loading…'}</div>`
}

export function ErrorMsg({ message }) {
  return html`<div class="fx-error">⚠ ${message || 'Something went wrong.'}</div>`
}
