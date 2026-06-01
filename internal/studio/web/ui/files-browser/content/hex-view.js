// hex-view.js
//
// A classic offset / hex / ASCII dump of a file's raw bytes.  Used as
// the universal fallback for formats with no richer preview and offered
// as a tab for every file so the underlying bytes are always reachable.
//
// To stay responsive on large files it fetches the bytes once and caps
// the rendered window; the cap note tells the user when output was
// truncated.

import { htm as html } from '/ui/common/htm-bind.js'
import { useEffect, useState } from 'preact/hooks'
import { rawURL, formatSize } from '../api.js'

const MAX_BYTES = 64 * 1024 // 64 KiB rendered ceiling

function hexByte(b) { return b.toString(16).padStart(2, '0') }

// dumpLines turns a byte array into formatted "offset  hex…  |ascii|"
// rows, 16 bytes per row.
function dumpLines(bytes) {
  const lines = []
  for (let off = 0; off < bytes.length; off += 16) {
    const slice = bytes.subarray(off, off + 16)
    const hex = []
    let ascii = ''
    for (let i = 0; i < 16; i++) {
      if (i < slice.length) {
        const b = slice[i]
        hex.push(hexByte(b))
        ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'
      } else {
        hex.push('  ')
      }
      if (i === 7) hex.push('')
    }
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex.join(' ')}  |${ascii}|`)
  }
  return lines.join('\n')
}

export function HexView({ path, source }) {
  const [state, setState] = useState({ text: null, err: null, truncated: false, total: 0 })
  useEffect(() => {
    let alive = true
    setState({ text: null, err: null, truncated: false, total: 0 })
    fetch(rawURL(path, source))
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
      .then((buf) => {
        if (!alive) return
        const all = new Uint8Array(buf)
        const truncated = all.length > MAX_BYTES
        const view = truncated ? all.subarray(0, MAX_BYTES) : all
        setState({ text: dumpLines(view), err: null, truncated, total: all.length })
      })
      .catch((e) => { if (alive) setState({ text: null, err: String(e), truncated: false, total: 0 }) })
    return () => { alive = false }
  }, [path, source])

  if (state.err) return html`<div class="fx-error">${state.err}</div>`
  if (state.text == null) return html`<div class="fx-loading"><span class="fx-spinner"></span>Loading…</div>`
  return html`
    <div class="fx-hex">
      <pre class="fx-hex-dump">${state.text}</pre>
      ${state.truncated
        ? html`<div class="fx-hex-note">Showing first ${MAX_BYTES / 1024} KiB of ${formatSize(state.total)} — download for the full file.</div>`
        : null}
    </div>
  `
}
