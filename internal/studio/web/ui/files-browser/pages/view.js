// view.js
//
// The tabbed file viewer.  It fetches the combined metadata document
// (identity + layering + structured describe) once, decides the file's
// "kind" from the describe format and extension, and builds a tailored
// tab set — map/heightmap/features for TNT, decompiled/disassembly/call
// graph/lint for COB, sequences for GAF, and so on — falling back to a
// metadata + hex pair for anything unrecognised.  Picking a layer in the
// Layering tab re-renders the visual tabs from that archive source.

import { htm as html } from '@kbot/ui/htm-bind'
import { useState, useCallback, useMemo, useEffect, useRef } from 'preact/hooks'
import { metadata, rawURL, renderURL, extOf, deleteFile, parentDir } from '../api.js'
import { confirmDialog } from '@kbot/ui/confirm-dialog'
import { editKind, openInEditor } from '../edit-actions.js'
import { useRawText } from '../components/async.js'
import { useAsync, Loading, ErrorMsg } from '@kbot/ui/async'
import { HexView } from '@kbot/ui/hex-view'
import { InfoTab } from '../viewers/info.js'
import { TextTab } from '../viewers/text.js'
import { GafViewer } from '../viewers/gaf.js'
import { PaletteViewer } from '../viewers/palette.js'
import { PcxViewer, NativeImageViewer, FontViewer } from '../viewers/image.js'
import { VideoTab, AudioTab } from '../viewers/media.js'
import { AiViewer } from '../viewers/ai.js'
import { SectionsViewer } from '../viewers/sections.js'
import { TntMapTab, TntHeightMapTab, TntBuildMapTab, TntFeaturesTab } from '../viewers/tnt.js'
import { SctMapTab, SctHeightMapTab } from '../viewers/sct.js'
import { LayersTab } from '../viewers/layers.js'
import { CobInfoTab, CobDecompiledTab, CobDisassemblyTab } from '../viewers/cob.js'
import { BosHighlighter } from '../viewers/highlight.js'
import { CallGraph } from '../viewers/callgraph.js'
import { LintTab } from '../viewers/lint.js'

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg'])
const AUDIO_EXTS = new Set(['wav', 'mp3'])
const VIDEO_EXTS = new Set(['smk', 'zrb', 'bik'])

// resolveKind maps the describe format string (plus the extension for the
// formats with no describer) onto a single dispatch key.
function resolveKind(format, ext) {
  const f = (format || '').toLowerCase()
  if (f.includes('gaf')) return 'gaf'
  if (f.includes('pcx')) return 'pcx'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (f.includes('font')) return 'font'
  if (f === 'palette') return 'palette'
  if (f.includes('sct')) return 'sct'
  if (f.includes('tnt')) return 'tnt'
  if (f.includes('ai profile')) return 'ai'
  if (f.includes('cob')) return 'cob'
  if (f.includes('bos')) return 'bos'
  return 'generic'
}

// buildTabs returns the ordered tab descriptors for a file's kind.
function buildTabs(kind, describe, layers, ext) {
  const tabs = []
  const hasSections = Array.isArray(describe.sections) && describe.sections.length > 0
  const isText = ['tdf', 'fbi', 'gui', 'ota', 'txt', 'cfg', 'bos', 'h', 'htm', 'html'].includes(ext)

  switch (kind) {
    case 'gaf': tabs.push({ id: 'content', label: '🎞 Sequences' }); break
    case 'pcx': case 'image': tabs.push({ id: 'content', label: '🖼 Image' }); break
    case 'font': tabs.push({ id: 'content', label: '🔤 Font' }); break
    case 'palette': tabs.push({ id: 'content', label: '🎨 Palette' }); break
    case 'audio': tabs.push({ id: 'content', label: '🔊 Player' }); break
    case 'video': tabs.push({ id: 'content', label: '🎬 Viewer' }); break
    case 'ai':
      tabs.push({ id: 'content', label: '🤖 AI Profile' })
      break
    case 'tnt':
      tabs.push({ id: 'content', label: '🗺️ Map' }, { id: 'features', label: '🏗️ Features' },
        { id: 'heightmap', label: '⛰️ Height Map' }, { id: 'buildmap', label: '🧱 Buildable' })
      break
    case 'sct':
      tabs.push({ id: 'content', label: '🗺️ Section' }, { id: 'heightmap', label: '⛰️ Height Map' })
      break
    case 'cob':
      if (describe.decompiled) tabs.push({ id: 'decompiled', label: '📝 Decompiled' })
      if (describe.disassembly) tabs.push({ id: 'disassembly', label: '🔧 Disassembly' })
      tabs.push({ id: 'cobinfo', label: '📦 Scripts & Pieces' })
      if (describe.callGraphNodes) tabs.push({ id: 'callgraph', label: '🔗 Calls & Signals' })
      tabs.push({ id: 'lint', label: `🔍 Lint${describe.lintResults && describe.lintResults.length ? ` (${describe.lintResults.length})` : ''}` })
      break
    case 'bos':
      tabs.push({ id: 'content', label: '💻 Code' })
      if (describe.callGraphNodes) tabs.push({ id: 'callgraph', label: '🔗 Calls & Signals' })
      if (describe.lintResults || describe.lintError) {
        const n = describe.lintResults ? describe.lintResults.length : 0
        tabs.push({ id: 'lint', label: `🔍 Lint${n > 0 ? ` (${n})` : ''}` })
      }
      break
    default:
      if (hasSections) tabs.push({ id: 'content', label: '📑 Sections' })
      else if (isText) tabs.push({ id: 'content', label: '📄 Text' })
  }

  // A raw-text tab for the structured text formats.
  if ((hasSections || kind === 'ai') && isText) tabs.push({ id: 'text', label: '📄 Text' })

  // Universal tabs: metadata, then binary, then layering.
  tabs.push({ id: 'metadata', label: '📋 Metadata' })
  tabs.push({ id: 'binary', label: '🔢 Binary' })
  if (layers && layers.length > 0) tabs.push({ id: 'layers', label: `📚 Layering (${layers.length})` })
  return tabs
}

// BosCodeTab fetches the raw source for a .bos/.h file and renders it
// through the folding syntax highlighter.
function BosCodeTab({ path, source, lintLines, highlightLine, onOpenFile }) {
  const { data, loading, error } = useRawText(path, source)
  if (loading) return html`<${Loading} />`
  if (error) return html`<${ErrorMsg} message=${error} />`
  return html`<${BosHighlighter} code=${data || ''} basePath=${path} lintLines=${lintLines} highlightLine=${highlightLine} onOpenFile=${onOpenFile} />`
}

// swapExt returns the download filename with its extension replaced by
// `ext` (e.g. logos.zrb + 'mp4' → logos.mp4), so a transcoded/rendered
// download lands with a sensible name.
function swapExt(name, ext) {
  const b = name || 'file'
  const i = b.lastIndexOf('.')
  return `${i > 0 ? b.slice(0, i) : b}.${ext}`
}

// extraFormats lists the rendered download variants offered for a kind,
// alongside the original bytes — PNG/GIF for PCX images, MP4 for video.
function extraFormats(kind, path, name, src) {
  switch (kind) {
    case 'pcx': case 'image':
      return [
        { label: 'PNG', filename: swapExt(name, 'png'), href: renderURL(path, { format: 'png', source: src }) },
        { label: 'GIF', filename: swapExt(name, 'gif'), href: renderURL(path, { format: 'gif', source: src }) },
      ]
    case 'video':
      return [
        { label: 'MP4', filename: swapExt(name, 'mp4'), href: renderURL(path, { format: 'mp4', source: src }) },
      ]
    default:
      return []
  }
}

// DownloadMenu renders the original-bytes download as a primary button;
// when a kind offers rendered variants it grows a caret revealing them.
function DownloadMenu({ name, origHref, extras }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  if (!extras.length) {
    return html`<a class="fx-dl-btn" download=${name} href=${origHref}>⬇ Download</a>`
  }

  return html`
    <div class=${'fx-dl-menu' + (open ? ' open' : '')} ref=${ref}>
      <a class="fx-dl-btn fx-dl-main" download=${name} href=${origHref}>⬇ Download</a>
      <button type="button" class="fx-dl-caret" title="More formats" onClick=${() => setOpen((o) => !o)}>▾</button>
      ${open ? html`
        <div class="fx-dl-pop">
          <a class="fx-dl-item" download=${name} href=${origHref} onClick=${() => setOpen(false)}>Original (${extOf(name).toUpperCase()})</a>
          ${extras.map((x) => html`
            <a class="fx-dl-item" key=${x.label} download=${x.filename} href=${x.href} onClick=${() => setOpen(false)}>${x.label}</a>`)}
        </div>` : null}
    </div>
  `
}

export function ViewPage({ path, source: initialSource, onOpenFile, onOpenDir }) {
  const [activeSource, setActiveSource] = useState(initialSource || '')
  const [tab, setTab] = useState(null)
  const [highlightLine, setHighlightLine] = useState(null)
  const { data: meta, loading, error } = useAsync(() => metadata(path, activeSource), [path, activeSource])

  const handleJumpToLine = useCallback((line, toTab) => {
    setHighlightLine(line)
    setTab(toTab)
    setTimeout(() => {
      const el = document.querySelector(`[data-line="${line}"]`)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 80)
  }, [])

  const ext = extOf(path)
  const describe = (meta && meta.describe) || {}
  const layers = (meta && meta.layering) || []
  const kind = resolveKind(describe.format, ext)
  const tabs = useMemo(() => buildTabs(kind, describe, layers, ext), [kind, describe, layers, ext])

  const lintLines = useMemo(() => {
    const m = new Map()
    for (const d of describe.lintResults || []) {
      if (d.line > 0) { const list = m.get(d.line) || []; list.push({ rule: d.rule, severity: d.severity, message: d.message }); m.set(d.line, list) }
    }
    return m
  }, [describe])

  if (loading) return html`<${Loading} />`
  if (error) return html`<${ErrorMsg} message=${error} />`
  if (!meta) return null

  const current = (tab && tabs.find((t) => t.id === tab)) ? tab : (tabs[0] && tabs[0].id)
  const src = activeSource

  const renderTab = (id) => {
    switch (id) {
      case 'content':
        switch (kind) {
          case 'gaf': return html`<${GafViewer} path=${path} describe=${describe} source=${src} />`
          case 'pcx': return html`<${PcxViewer} path=${path} describe=${describe} source=${src} />`
          case 'image': return html`<${NativeImageViewer} path=${path} source=${src} />`
          case 'font': return html`<${FontViewer} path=${path} describe=${describe} source=${src} />`
          case 'palette': return html`<${PaletteViewer} describe=${describe} />`
          case 'audio': return html`<${AudioTab} path=${path} source=${src} />`
          case 'video': return html`<${VideoTab} path=${path} source=${src} describe=${describe} />`
          case 'ai': return html`<${AiViewer} describe=${describe} />`
          case 'tnt': return html`<${TntMapTab} path=${path} describe=${describe} source=${src} />`
          case 'sct': return html`<${SctMapTab} path=${path} describe=${describe} source=${src} />`
          case 'bos': return html`<${BosCodeTab} path=${path} source=${src} lintLines=${lintLines} highlightLine=${highlightLine} onOpenFile=${onOpenFile} />`
          default:
            if (Array.isArray(describe.sections) && describe.sections.length) return html`<${SectionsViewer} sections=${describe.sections} />`
            return html`<${TextTab} path=${path} source=${src} />`
        }
      case 'features': return html`<${TntFeaturesTab} path=${path} describe=${describe} />`
      case 'heightmap': return kind === 'tnt'
        ? html`<${TntHeightMapTab} path=${path} describe=${describe} source=${src} />`
        : html`<${SctHeightMapTab} path=${path} describe=${describe} source=${src} />`
      case 'buildmap': return html`<${TntBuildMapTab} path=${path} describe=${describe} source=${src} />`
      case 'decompiled': return html`<${CobDecompiledTab} describe=${describe} lintLines=${lintLines} highlightLine=${highlightLine} />`
      case 'disassembly': return html`<${CobDisassemblyTab} describe=${describe} />`
      case 'cobinfo': return html`<${CobInfoTab} describe=${describe} />`
      case 'callgraph': return html`<${CallGraph} nodes=${describe.callGraphNodes} edges=${describe.callGraphEdges} />`
      case 'lint': return html`<${LintTab} describe=${describe} format=${describe.format} onJumpToLine=${handleJumpToLine} />`
      case 'text': return html`<${TextTab} path=${path} source=${src} />`
      case 'metadata': return html`<${InfoTab} meta=${meta} />`
      case 'binary': return html`<${HexView} src=${rawURL(path, src)} />`
      case 'layers': return html`<${LayersTab} layers=${layers} activeSource=${src || meta.source} onSwitch=${setActiveSource} />`
      default: return null
    }
  }

  return html`
    <div class="fx-view">
      <div class="fx-view-bar">
        <div class="fx-view-title">
          <h1 class="fx-view-name">${meta.name}</h1>
          ${describe.format ? html`<span class="fx-format-badge">${describe.format}</span>` : null}
          ${src ? html`<span class="fx-source-badge">📚 ${src}</span>` : null}
        </div>
        <div class="fx-view-actions">
          ${editKind(path) ? html`
            <button type="button" class="fx-dl-btn fx-edit-btn"
                    title=${editKind(path) === 'map' ? 'Edit in the map editor' : 'Open in the unit editor'}
                    onClick=${() => openInEditor(path)}>✏️ Edit</button>` : null}
          <${DownloadMenu} name=${meta.name} origHref=${rawURL(path, src)}
                           extras=${extraFormats(kind, path, meta.name, src)} />
          ${meta.deletable ? html`
            <button type="button" class="fx-dl-btn fx-del-btn"
                    title=${meta.revertsToBase
                      ? 'Delete the workspace copy — the base version underneath shows through again'
                      : 'Delete this workspace file'}
                    onClick=${async () => {
                      const ok = await confirmDialog({
                        title: 'Delete file',
                        message: meta.revertsToBase
                          ? `Delete the workspace copy of "${path}"? The base version underneath will show through again.`
                          : `Delete "${path}"? This permanently removes the workspace file.`,
                        okLabel: 'Delete',
                        okDanger: true,
                      })
                      if (!ok) return
                      try {
                        await deleteFile(path)
                        onOpenDir?.(parentDir(path))
                      } catch (e) {
                        await confirmDialog({ title: 'Delete failed', message: String(e?.message || e), okLabel: 'OK' })
                      }
                    }}>🗑 Delete</button>` : null}
        </div>
      </div>
      <div class="fx-tabs">
        ${tabs.map((t) => html`
          <button type="button" key=${t.id} class=${'fx-tab' + (current === t.id ? ' active' : '')}
                  onClick=${() => { setTab(t.id); setHighlightLine(null) }}>${t.label}</button>`)}
      </div>
      <div class="fx-tab-body">${renderTab(current)}</div>
    </div>
  `
}
