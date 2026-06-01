// preview.js
//
// The Files tab preview pane.  Given a VFS path it fetches the combined
// ?metadata document (identity + layering + describe) and dispatches to
// a representation appropriate for the file's extension: a rendered
// image, a transcoded video, raw text, or a structured describe view.
//
// Stage 7 keeps each branch inline and minimal.  Stage 8 replaces the
// inline branches with dedicated components under this directory
// (image-viewer, video-player, data-tree, hex-view) and adds the
// per-format controls (palette / transparency / view / sequence).

import { htm as html } from '/ui/common/htm-bind.js'
import { useEffect, useState } from 'preact/hooks'

// extOf returns the lowercased extension (without the dot) of a path.
function extOf(path) {
  const i = path.lastIndexOf('.')
  return i < 0 ? '' : path.slice(i + 1).toLowerCase()
}

// IMAGE_EXTS map to the render query that turns each format into a PNG/
// APNG the browser can show in an <img>.
const IMAGE_RENDER = {
  gaf: 'sequence=0&frame=-1&format=apng',
  pcx: 'format=png',
  pal: 'format=png',
  fnt: 'format=png',
  tnt: 'view=minimap',
  sct: 'view=minimap',
}
const VIDEO_EXTS = new Set(['smk', 'zrb', 'bik'])
const TEXT_EXTS = new Set(['txt', 'ota', 'tdf', 'fbi', 'gui', 'bos', 'cob', 'h', 'cfg', 'gam', 'tai'])

function previewURL(path, query) {
  return `/api/vfs/${path}?${query}`
}

// DescribeView renders the structured describe document as indented
// JSON.  It's the catch-all when no richer representation fits.
function DescribeView({ describe }) {
  if (!describe || Object.keys(describe).length === 0) {
    return html`<div class="files-preview-empty">No structured description available</div>`
  }
  return html`<pre class="files-describe">${JSON.stringify(describe, null, 2)}</pre>`
}

// TextView fetches the raw bytes and shows them as plain text.
function TextView({ path }) {
  const [text, setText] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => {
    let alive = true
    fetch(`/api/vfs/${path}`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))))
      .then((t) => { if (alive) setText(t) })
      .catch((e) => { if (alive) setErr(String(e)) })
    return () => { alive = false }
  }, [path])
  if (err) return html`<div class="files-error">${err}</div>`
  if (text == null) return html`<div class="files-loading">Loading…</div>`
  return html`<pre class="files-text">${text}</pre>`
}

export function FilePreview({ path }) {
  const [meta, setMeta] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    let alive = true
    setMeta(null)
    setErr(null)
    fetch(`/api/vfs/${path}?metadata`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
      .then((m) => { if (alive) setMeta(m) })
      .catch((e) => { if (alive) setErr(String(e)) })
    return () => { alive = false }
  }, [path])

  const ext = extOf(path)

  let body
  if (IMAGE_RENDER[ext]) {
    body = html`<div class="files-image-wrap"><img class="files-image"
                  src=${previewURL(path, IMAGE_RENDER[ext])} alt=${path} /></div>`
  } else if (VIDEO_EXTS.has(ext)) {
    body = html`<video class="files-video" controls
                  src=${previewURL(path, 'format=mp4')}></video>`
  } else if (TEXT_EXTS.has(ext)) {
    body = html`<${TextView} path=${path} />`
  } else {
    body = html`<${DescribeView} describe=${meta && meta.describe} />`
  }

  return html`
    <div class="files-preview-pane">
      <header class="files-preview-head">
        <span class="files-preview-name">${meta ? meta.name : path.split('/').pop()}</span>
        ${meta ? html`<span class="files-preview-meta">${meta.size} bytes${meta.source ? ` · ${meta.source}` : ''}</span>` : null}
      </header>
      ${err ? html`<div class="files-error">${err}</div>` : html`<div class="files-preview-body">${body}</div>`}
    </div>
  `
}
