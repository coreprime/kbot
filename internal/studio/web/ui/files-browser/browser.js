// browser.js
//
// The Files tab's top-level Preact component: a two-pane VFS explorer.
// The left pane is a breadcrumb + directory listing backed by the
// /api/vfs/<folder>/ listing endpoint (lazy — one fetch per folder the
// user opens); the right pane previews the selected file.
//
// Stage 7 keeps the preview deliberately thin (it dispatches to the
// shared preview component in ./content/preview.js); the rich
// per-format viewers and the cache-warming indicator are layered on in
// Stage 8.  This module owns navigation + selection state only.

import { htm as html } from '/ui/common/htm-bind.js'
import { useEffect, useState } from 'preact/hooks'
import { FilePreview } from './content/preview.js'
import { WarmIndicator } from './content/warm-indicator.js'

// fetchJSON GETs a URL and parses JSON, throwing on a non-2xx so the
// caller's catch can surface a readable error in the pane.
async function fetchJSON(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

// dirURL builds the listing URL for a folder.  The trailing slash is
// what the API uses to distinguish "list this directory" from "serve
// this file", and the root listing is the bare /api/vfs/.
function dirURL(dir) {
  return dir ? `/api/vfs/${dir}/` : '/api/vfs/'
}

// Breadcrumb renders the path segments of the current directory as
// clickable crumbs so the user can jump back up the tree in one click.
function Breadcrumb({ dir, onNavigate }) {
  const parts = dir ? dir.split('/') : []
  return html`
    <nav class="files-crumbs">
      <button type="button" class="files-crumb" onClick=${() => onNavigate('')}>root</button>
      ${parts.map((part, i) => {
        const target = parts.slice(0, i + 1).join('/')
        return html`
          <span class="files-crumb-sep">/</span>
          <button type="button" class="files-crumb" onClick=${() => onNavigate(target)}>${part}</button>
        `
      })}
    </nav>
  `
}

// formatSize renders a byte count in a compact, human-friendly unit.
function formatSize(n) {
  if (!n) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let u = 0
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++ }
  return `${v >= 10 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`
}

// Listing renders one directory's children: folders first, then files,
// each row a button that either descends (folder) or selects (file).
function Listing({ entries, selected, onOpenDir, onSelectFile }) {
  if (!entries.length) {
    return html`<div class="files-empty">empty folder</div>`
  }
  return html`
    <ul class="files-list">
      ${entries.map((e) => {
        const isDir = e.type === 'directory'
        const cls = [
          'files-row',
          isDir ? 'is-dir' : 'is-file',
          !isDir && e.path === selected ? 'selected' : '',
        ].filter(Boolean).join(' ')
        return html`
          <li>
            <button type="button" class=${cls}
                    onClick=${() => (isDir ? onOpenDir(e.path) : onSelectFile(e.path))}>
              <span class="files-row-icon">${isDir ? '📁' : '📄'}</span>
              <span class="files-row-name">${e.name}</span>
              ${!isDir ? html`<span class="files-row-size">${formatSize(e.size)}</span>` : null}
            </button>
          </li>
        `
      })}
    </ul>
  `
}

export function FilesBrowser() {
  const [dir, setDir] = useState('')
  const [listing, setListing] = useState({ entries: [] })
  const [listErr, setListErr] = useState(null)
  const [selected, setSelected] = useState(null)

  useEffect(() => {
    let alive = true
    setListErr(null)
    fetchJSON(dirURL(dir))
      .then((data) => { if (alive) setListing(data) })
      .catch((err) => { if (alive) { setListing({ entries: [] }); setListErr(String(err)) } })
    return () => { alive = false }
  }, [dir])

  const openDir = (path) => { setDir(path); setSelected(null) }

  return html`
    <div class="files-browser">
      <aside class="files-tree">
        <${Breadcrumb} dir=${dir} onNavigate=${openDir} />
        ${listErr
          ? html`<div class="files-error">${listErr}</div>`
          : html`<${Listing} entries=${listing.entries || []} selected=${selected}
                             onOpenDir=${openDir} onSelectFile=${setSelected} />`}
        <${WarmIndicator} />
      </aside>
      <section class="files-preview">
        ${selected
          ? html`<${FilePreview} path=${selected} key=${selected} />`
          : html`<div class="files-preview-empty">Select a file to preview</div>`}
      </section>
    </div>
  `
}
