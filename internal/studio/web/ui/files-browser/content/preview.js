// preview.js
//
// The Files tab preview pane.  Given a VFS path it fetches the combined
// ?metadata document (identity + layering + describe) and presents it as
// a set of tabs:
//   - Preview : the format's visual / playable / textual representation
//   - Details : the structured describe doc as a collapsible tree
//   - Layers  : which archive layers contribute this path
//   - Hex     : a raw byte dump (always available)
//
// The Preview tab dispatches on the file's extension into the dedicated
// per-format viewers in this directory (image / video / palette / code).

import { htm as html } from '/ui/common/htm-bind.js'
import { useEffect, useState } from 'preact/hooks'
import { Tabs } from './tabs.js'
import { DataTree } from './data-tree.js'
import { HexView } from './hex-view.js'
import { ImageViewer } from './image-viewer.js'
import { VideoPlayer } from './video-player.js'
import { PaletteGrid } from './palette-grid.js'
import { TextFileView, CodeBlock } from './code-view.js'

// extOf returns the lowercased extension (without the dot) of a path.
function extOf(path) {
  const i = path.lastIndexOf('.')
  return i < 0 ? '' : path.slice(i + 1).toLowerCase()
}

const IMAGE_EXTS = new Set(['gaf', 'pcx', 'fnt', 'tnt', 'sct'])
const VIDEO_EXTS = new Set(['smk', 'zrb', 'bik'])
const TEXT_EXTS = new Set(['txt', 'ota', 'tdf', 'fbi', 'gui', 'bos', 'h', 'cfg', 'gam', 'tai'])

// PreviewBody picks the visual representation for the Preview tab.
function PreviewBody({ path, ext, describe }) {
  if (ext === 'pal') return html`<${PaletteGrid} colors=${describe && describe.colors} />`
  if (IMAGE_EXTS.has(ext)) return html`<${ImageViewer} path=${path} ext=${ext} describe=${describe} />`
  if (VIDEO_EXTS.has(ext)) return html`<${VideoPlayer} path=${path} />`
  if (TEXT_EXTS.has(ext)) return html`<${TextFileView} path=${path} />`
  // COB ships disassembly / decompilation in the describe doc — surface
  // those as sub-tabs instead of a flat tree.
  if (ext === 'cob' && describe) {
    const items = [
      describe.disassembly ? { id: 'disasm', label: 'Disassembly', render: () => html`<${CodeBlock} value=${describe.disassembly} />` } : null,
      describe.decompiled ? { id: 'decomp', label: 'Decompiled', render: () => html`<${CodeBlock} value=${describe.decompiled} />` } : null,
    ].filter(Boolean)
    if (items.length) return html`<${Tabs} items=${items} />`
  }
  return html`<${DataTree} data=${describe} />`
}

// LayersView lists the archive layers that contribute the path, most
// specific (winning) layer first.
function LayersView({ layering }) {
  if (!layering || !layering.length) {
    return html`<div class="files-preview-empty">No layering information</div>`
  }
  return html`
    <ol class="files-layers">
      ${layering.map((l) => html`<li class="files-layer">${typeof l === 'string' ? l : (l.source || JSON.stringify(l))}</li>`)}
    </ol>
  `
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
  const describe = meta && meta.describe
  const layering = meta && meta.layering

  const tabs = [
    { id: 'preview', label: 'Preview', render: () => html`<${PreviewBody} path=${path} ext=${ext} describe=${describe} />` },
    { id: 'details', label: 'Details', render: () => html`<${DataTree} data=${describe} />` },
    { id: 'layers', label: 'Layers', render: () => html`<${LayersView} layering=${layering} />` },
    { id: 'hex', label: 'Hex', render: () => html`<${HexView} path=${path} />` },
  ]

  return html`
    <div class="files-preview-pane">
      <header class="files-preview-head">
        <span class="files-preview-name">${meta ? meta.name : path.split('/').pop()}</span>
        ${meta ? html`<span class="files-preview-meta">${meta.size} bytes${meta.source ? ` · ${meta.source}` : ''}</span>` : null}
      </header>
      ${err
        ? html`<div class="files-error">${err}</div>`
        : html`<div class="files-preview-body"><${Tabs} items=${tabs} key=${path} /></div>`}
    </div>
  `
}
