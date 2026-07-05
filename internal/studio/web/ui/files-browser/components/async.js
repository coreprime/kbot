// async.js
//
// useRawText fetches a file's raw bytes as text (optionally from a
// specific archive layer).  Shared by the text/source/code tabs.  The
// generic fetch hook + placeholder chrome it builds on now live in
// @coreprime/kbot-ui/async; this module just binds it to the VFS raw-bytes URL.

import { useAsync } from '@coreprime/kbot-ui/async'
import { rawURL } from '../api.js'

export function useRawText(path, source) {
  return useAsync(() => fetch(rawURL(path, source)).then((r) => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
    return r.text()
  }), [path, source])
}
