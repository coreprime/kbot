// code-view.js
//
// Text-oriented previews.  Two exports:
//   - TextFileView : fetches a file's raw bytes and shows them as
//     monospace text (BOS scripts, OTA/TDF/FBI configs, GUI, etc.).
//   - CodeBlock    : renders an already-loaded string or array-of-lines
//     as preformatted text (used for COB disassembly / decompilation
//     pulled from the describe doc).

import { htm as html } from '/ui/common/htm-bind.js'
import { useEffect, useState } from 'preact/hooks'

// asText normalises a describe value that may be a single string or an
// array of lines into one block of text.
function asText(v) {
  if (Array.isArray(v)) return v.join('\n')
  return v == null ? '' : String(v)
}

export function CodeBlock({ value }) {
  const text = asText(value)
  if (!text) return html`<div class="files-preview-empty">No content</div>`
  return html`<pre class="files-code">${text}</pre>`
}

export function TextFileView({ path }) {
  const [text, setText] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => {
    let alive = true
    setText(null)
    setErr(null)
    fetch(`/api/vfs/${path}`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
      .then((t) => { if (alive) setText(t) })
      .catch((e) => { if (alive) setErr(String(e)) })
    return () => { alive = false }
  }, [path])
  if (err) return html`<div class="files-error">${err}</div>`
  if (text == null) return html`<div class="files-loading">Loading…</div>`
  return html`<pre class="files-code">${text}</pre>`
}
