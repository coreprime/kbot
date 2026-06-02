// browse.js
//
// Full-page directory browser with two layouts: a sortable table (Name /
// Size / Type, folders pinned first) and an icon grid with live preview
// thumbnails.  Image-bearing files render an actual thumbnail (GAF first
// frame, PCX, TNT/SCT minimap, video poster); GAF animates on hover.
//
// The listing comes from one /api/vfs/<dir>/ request, which already
// carries breadcrumbs, per-directory roll-up counts, and folder totals.

import { htm as html } from '@kbot/ui/htm-bind'
import { useCallback, useMemo, useState } from 'preact/hooks'
import {
  browse, formatSize, extOf, baseName, rawURL,
  gafPngURL, gafApngURL, pcxURL, mapViewURL, videoThumbURL, videoURL,
} from '../api.js'
import { useAsync, Loading, ErrorMsg } from '@kbot/ui/async'
import { fileIcon, fileKind } from '@kbot/ui/file-icons'

const PREVIEW_EXTS = new Set(['gaf', 'pcx', 'tnt', 'sct', 'smk', 'zrb', 'bik'])

// thumbFor returns { still, anim } preview URLs for an entry, or null
// when the format has no visual thumbnail.
function thumbFor(path, ext) {
  switch (ext) {
    case 'gaf': return { still: gafPngURL(path, 0, 0), anim: gafApngURL(path, 0) }
    case 'pcx': return { still: pcxURL(path), anim: null }
    case 'tnt': return { still: mapViewURL(path, 'minimap'), anim: null }
    case 'sct': return { still: mapViewURL(path, 'minimap'), anim: null }
    case 'smk': case 'zrb': case 'bik': return { still: videoThumbURL(path), anim: null }
    default: return null
  }
}

// hideBroken collapses an <img>/<video> that failed to render so a
// missing thumbnail falls back to the emoji glyph instead of a broken
// image chrome.
function hideBroken(e) { e.target.style.display = 'none' }

function dirStats(folders, files) {
  const parts = []
  if (folders > 0) parts.push(`${folders} folder${folders !== 1 ? 's' : ''}`)
  if (files > 0) parts.push(`${files} file${files !== 1 ? 's' : ''}`)
  return parts.join(', ') || '—'
}

// ── table view ──────────────────────────────────────────────────────

function SortHeader({ label, field, sortKey, sortDir, onSort }) {
  const arrow = sortKey === field ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''
  return html`<th class="fx-th-sort" onClick=${() => onSort(field)}>${label}${arrow}</th>`
}

function FileRow({ entry, onOpenFile }) {
  const [hover, setHover] = useState(false)
  const ext = extOf(entry.name)
  const thumb = PREVIEW_EXTS.has(ext) ? thumbFor(entry.path, ext) : null
  const isVideo = ext === 'smk' || ext === 'zrb' || ext === 'bik'
  const src = thumb && hover && thumb.anim ? thumb.anim : (thumb && thumb.still)

  return html`
    <tr onMouseEnter=${() => thumb && setHover(true)} onMouseLeave=${() => setHover(false)}>
      <td>
        <div class=${'fx-name-cell ' + fileKind(entry.name)}>
          <span class="fx-row-ico">${fileIcon(entry.name)}</span>
          <button type="button" class="fx-name-link" onClick=${() => onOpenFile(entry.path)}>${entry.name}</button>
          ${hover && thumb ? html`
            <span class="fx-row-tip">
              ${isVideo
                ? html`<video src=${videoURL(entry.path)} autoplay loop muted class="fx-row-tip-media" onError=${hideBroken}></video>`
                : html`<img src=${src} alt=${entry.name} class="fx-row-tip-media" onError=${hideBroken} />`}
            </span>` : null}
        </div>
      </td>
      <td class="fx-size-cell">${formatSize(entry.size)}</td>
      <td class="fx-type-cell">${ext ? ext.toUpperCase() : '—'}</td>
      <td class="fx-source-cell">${entry.source ? html`<span class="fx-layer-chip" title=${`Effective layer: ${entry.source}`}>${entry.source}</span>` : ''}</td>
      <td class="fx-actions-cell">
        <a class="fx-row-action" download=${baseName(entry.path)} href=${rawURL(entry.path)} title="Download" onClick=${(e) => e.stopPropagation()}>⬇</a>
      </td>
    </tr>
  `
}

function TableView({ dirs, files, sortKey, sortDir, onSort, onOpenDir, onOpenFile }) {
  return html`
    <div class="fx-card">
      <table class="fx-dir-table">
        <thead>
          <tr>
            <${SortHeader} label="Name" field="name" sortKey=${sortKey} sortDir=${sortDir} onSort=${onSort} />
            <${SortHeader} label="Size" field="size" sortKey=${sortKey} sortDir=${sortDir} onSort=${onSort} />
            <${SortHeader} label="Type" field="type" sortKey=${sortKey} sortDir=${sortDir} onSort=${onSort} />
            <th class="fx-th-source">Layer</th>
            <th class="fx-th-actions">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${dirs.map((e) => html`
            <tr key=${e.path}>
              <td>
                <div class="fx-name-cell dir">
                  <span class="fx-row-ico">📁</span>
                  <button type="button" class="fx-name-link" onClick=${() => onOpenDir(e.path)}>${e.name}</button>
                </div>
              </td>
              <td class="fx-size-cell">${formatSize(e.dirSize)}</td>
              <td class="fx-type-cell">${dirStats(e.dirFolders, e.dirFiles)}</td>
              <td class="fx-source-cell"></td>
              <td class="fx-actions-cell"></td>
            </tr>
          `)}
          ${files.map((e) => html`<${FileRow} key=${e.path} entry=${e} onOpenFile=${onOpenFile} />`)}
          ${dirs.length === 0 && files.length === 0
            ? html`<tr><td colspan="5"><div class="fx-empty">📭 Empty directory</div></td></tr>`
            : null}
        </tbody>
      </table>
    </div>
  `
}

// ── icon view ───────────────────────────────────────────────────────

function FileIconCard({ entry, onOpenFile }) {
  const [hover, setHover] = useState(false)
  const ext = extOf(entry.name)
  const thumb = PREVIEW_EXTS.has(ext) ? thumbFor(entry.path, ext) : null
  const src = thumb && hover && thumb.anim ? thumb.anim : (thumb && thumb.still)
  return html`
    <div class=${'fx-icon-card ' + fileKind(entry.name)}
         onMouseEnter=${() => thumb && thumb.anim && setHover(true)}
         onMouseLeave=${() => setHover(false)}>
      <button type="button" class="fx-icon-open-area" onClick=${() => onOpenFile(entry.path)} title=${entry.name}>
        <div class="fx-icon-thumb">
          ${thumb && src
            ? html`<img src=${src} alt=${entry.name} class="fx-icon-img" onError=${hideBroken} />`
            : html`<span class="fx-icon-emoji">${fileIcon(entry.name)}</span>`}
        </div>
        <div class="fx-icon-label" title=${entry.name}>${entry.name}</div>
      </button>
      <div class="fx-icon-foot">
        <span class="fx-icon-size">${entry.size ? formatSize(entry.size) : ''}</span>
        <span class="fx-icon-actions">
          <a class="fx-icon-action" download=${baseName(entry.path)} href=${rawURL(entry.path)} title="Download">⬇</a>
          <button type="button" class="fx-icon-action" onClick=${() => onOpenFile(entry.path)} title="Open">→</button>
        </span>
      </div>
    </div>
  `
}

function IconView({ dirs, files, onOpenDir, onOpenFile }) {
  if (dirs.length === 0 && files.length === 0) return html`<div class="fx-empty">📭 Empty directory</div>`
  return html`
    <div class="fx-icon-grid">
      ${dirs.map((e) => html`
        <button type="button" class="fx-icon-card dir" onClick=${() => onOpenDir(e.path)} key=${e.path}>
          <div class="fx-icon-thumb"><span class="fx-icon-emoji">📁</span></div>
          <div class="fx-icon-label" title=${e.name}>${e.name}</div>
          <div class="fx-icon-size">${dirStats(e.dirFolders, e.dirFiles)}</div>
        </button>
      `)}
      ${files.map((e) => html`<${FileIconCard} key=${e.path} entry=${e} onOpenFile=${onOpenFile} />`)}
    </div>
  `
}

// The list/icon layout choice is a global preference, remembered across
// folders and reloads via localStorage.
const MODE_KEY = 'fx-browse-mode'
function loadMode() {
  try { const m = localStorage.getItem(MODE_KEY); if (m === 'list' || m === 'icons') return m } catch { /* storage unavailable */ }
  return 'list'
}
function saveMode(m) {
  try { localStorage.setItem(MODE_KEY, m) } catch { /* storage unavailable */ }
}

export function BrowsePage({ dir, onOpenDir, onOpenFile }) {
  const [mode, setModeState] = useState(loadMode)
  const setMode = useCallback((m) => { saveMode(m); setModeState(m) }, [])
  const [sortKey, setSortKey] = useState('name')
  const [sortDir, setSortDir] = useState('asc')
  const { data, loading, error } = useAsync(() => browse(dir), [dir])

  const onSort = useCallback((key) => {
    setSortKey((prev) => {
      if (prev === key) { setSortDir((d) => (d === 'asc' ? 'desc' : 'asc')); return prev }
      setSortDir('asc'); return key
    })
  }, [])

  const { dirs, files } = useMemo(() => {
    if (!data) return { dirs: [], files: [] }
    const entries = data.entries || []
    const d = entries.filter((e) => e.type === 'directory')
    const f = [...entries.filter((e) => e.type !== 'directory')]
    f.sort((a, b) => {
      let cmp = 0
      if (sortKey === 'name') cmp = a.name.localeCompare(b.name)
      else if (sortKey === 'size') cmp = (a.size || 0) - (b.size || 0)
      else if (sortKey === 'type') cmp = extOf(a.name).localeCompare(extOf(b.name))
      return sortDir === 'desc' ? -cmp : cmp
    })
    return { dirs: d, files: f }
  }, [data, sortKey, sortDir])

  if (loading) return html`<${Loading} />`
  if (error) return html`<${ErrorMsg} message=${error} />`
  if (!data) return null

  return html`
    <div class="fx-browse">
      <div class="fx-browse-toolbar">
        <div class="fx-dir-summary">
          <span>📁 ${data.subdirCount} folders</span>
          <span>📄 ${data.fileCount} files</span>
          <span>💾 ${formatSize(data.totalSize)}</span>
        </div>
        <div class="fx-view-toggle">
          <button type="button" class=${'fx-toggle' + (mode === 'list' ? ' active' : '')} title="List view" onClick=${() => setMode('list')}>☰</button>
          <button type="button" class=${'fx-toggle' + (mode === 'icons' ? ' active' : '')} title="Icon view" onClick=${() => setMode('icons')}>⊞</button>
        </div>
      </div>
      ${mode === 'list'
        ? html`<${TableView} dirs=${dirs} files=${files} sortKey=${sortKey} sortDir=${sortDir}
                            onSort=${onSort} onOpenDir=${onOpenDir} onOpenFile=${onOpenFile} />`
        : html`<${IconView} dirs=${dirs} files=${files} onOpenDir=${onOpenDir} onOpenFile=${onOpenFile} />`}
    </div>
  `
}
