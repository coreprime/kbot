import { useState, useCallback, useMemo } from 'react'
import { useLocation, Link } from 'react-router-dom'
import { browse, pngURL, apngURL, pcxURL, zrbThumbURL, videoURL, sctMinimapURL, tntMinimapURL, type BrowseEntry } from '../api'
import { useAsync } from '../hooks'
import { Loading, ErrorMsg } from '../components/Loading'
import BrokenPlaceholder from '../components/BrokenAsset'
import { handleImgError } from '../components/brokenAssetUtils'
import Breadcrumbs from '../components/Breadcrumbs'

type ViewMode = 'list' | 'icons'
type SortKey = 'name' | 'size' | 'type'
type SortDir = 'asc' | 'desc'

export default function Browse() {
  const location = useLocation()
  const browsePath = location.pathname.replace(/^\/browse\/?/, '') || ''
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  const { data, loading, error } = useAsync(() => browse(browsePath), [browsePath])

  const handleSort = useCallback((key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }, [sortKey])

  const sorted = useMemo(() => {
    if (!data) return { dirs: [] as BrowseEntry[], files: [] as BrowseEntry[] }
    const dirs = data.entries.filter(e => e.isDir)
    const files = [...data.entries.filter(e => !e.isDir)]

    files.sort((a, b) => {
      let cmp = 0
      switch (sortKey) {
        case 'name':
          cmp = a.name.localeCompare(b.name)
          break
        case 'size':
          cmp = parseSize(a.size) - parseSize(b.size)
          break
        case 'type':
          cmp = fileExt(a.name).localeCompare(fileExt(b.name))
          break
      }
      return sortDir === 'desc' ? -cmp : cmp
    })

    return { dirs, files }
  }, [data, sortKey, sortDir])

  if (loading) return <Loading />
  if (error) return <ErrorMsg message={error} />
  if (!data) return null

  return (
    <div>
      <Breadcrumbs
        crumbs={data.breadcrumbs || []}
        linkPrefix="/browse"
        current={browsePath ? data.dirName : undefined}
      />

      <div className="browse-toolbar">
        <div className="dir-summary">
          <span>📁 {data.subdirCount} folders</span>
          <span>📄 {data.fileCount} files</span>
          <span>💾 {data.totalSize}</span>
        </div>
        <div className="view-toggle">
          <button
            className={`toggle-btn ${viewMode === 'list' ? 'active' : ''}`}
            onClick={() => setViewMode('list')}
            title="List view"
          >☰</button>
          <button
            className={`toggle-btn ${viewMode === 'icons' ? 'active' : ''}`}
            onClick={() => setViewMode('icons')}
            title="Icon view"
          >⊞</button>
        </div>
      </div>

      {viewMode === 'list'
        ? <ListView dirs={sorted.dirs} files={sorted.files} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
        : <IconView dirs={sorted.dirs} files={sorted.files} />
      }
    </div>
  )
}

// ── List View ──────────────────────────────────────────────────────────────

function SortHeader({ label, field, sortKey, sortDir, onSort }: {
  label: string; field: SortKey; sortKey: SortKey; sortDir: SortDir; onSort: (k: SortKey) => void
}) {
  const arrow = sortKey === field ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''
  return (
    <th className="sortable-th" onClick={() => onSort(field)}>
      {label}{arrow}
    </th>
  )
}

function ListView({ dirs, files, sortKey, sortDir, onSort }: {
  dirs: BrowseEntry[]; files: BrowseEntry[]; sortKey: SortKey; sortDir: SortDir; onSort: (k: SortKey) => void
}) {
  return (
    <div className="card">
      <table className="dir-table">
        <thead>
          <tr>
            <SortHeader label="Name" field="name" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortHeader label="Size" field="size" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortHeader label="Type" field="type" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          {dirs.map(entry => (
            <tr key={entry.path}>
              <td>
                <div className="name-cell">
                  <span className="icon">📁</span>
                  <Link to={`/browse/${entry.path}`}>{entry.name}</Link>
                </div>
              </td>
              <td className="size-cell">{entry.dirSize}</td>
              <td className="meta-cell">{dirStats(entry.dirFolders, entry.dirFiles)}</td>
            </tr>
          ))}
          {files.map(entry => (
            <FileRow key={entry.path} entry={entry} />
          ))}
          {dirs.length === 0 && files.length === 0 && (
            <tr><td colSpan={3}><div className="empty-state"><div className="icon">📭</div><div>Empty directory</div></div></td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function FileRow({ entry }: { entry: BrowseEntry }) {
  const [hover, setHover] = useState(false)
  const ext = fileExt(entry.name).toLowerCase()
  const hasPreview = ext === 'gaf' || ext === 'pcx' || ext === 'smk' || ext === 'zrb' || ext === 'sct' || ext === 'tnt'
  const isVideo = ext === 'smk' || ext === 'zrb'

  let previewSrc: string | undefined
  if (ext === 'gaf') {
    previewSrc = hover ? apngURL(entry.path, 0) : pngURL(entry.path, 0, 0)
  } else if (ext === 'pcx') {
    previewSrc = pcxURL(entry.path)
  } else if (isVideo) {
    previewSrc = zrbThumbURL(entry.path)
  } else if (ext === 'sct') {
    previewSrc = sctMinimapURL(entry.path)
  } else if (ext === 'tnt') {
    previewSrc = tntMinimapURL(entry.path)
  }

  return (
    <tr
      onMouseEnter={() => hasPreview && setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <td>
        <div className="name-cell">
          <span className="icon">{fileIcon(entry.name)}</span>
          <Link to={`/view/${entry.path}`} className="name-link-wrap">
            {entry.name}
            {hover && hasPreview && (
              <span className="list-preview-tooltip">
                {isVideo ? (
                  <video src={videoURL(entry.path)} autoPlay loop muted className="list-preview-video" />
                ) : previewSrc ? (
                  <>
                    <img src={previewSrc} alt={entry.name} onError={handleImgError} />
                    <BrokenPlaceholder label="Broken asset" style={{ width: 120, height: 80 }} />
                  </>
                ) : null}
              </span>
            )}
          </Link>
        </div>
      </td>
      <td className="size-cell">{entry.size}</td>
      <td className="meta-cell">{fileExt(entry.name)}</td>
    </tr>
  )
}

// ── Icon View ──────────────────────────────────────────────────────────────

function IconView({ dirs, files }: { dirs: BrowseEntry[]; files: BrowseEntry[] }) {
  return (
    <div className="icon-grid">
      {dirs.map(entry => (
        <Link key={entry.path} to={`/browse/${entry.path}`} className="icon-card">
          <div className="icon-thumb icon-thumb-dir">📁</div>
          <div className="icon-label" title={entry.name}>{entry.name}</div>
        </Link>
      ))}
      {files.map(entry => (
        <FileIconCard key={entry.path} entry={entry} />
      ))}
      {dirs.length === 0 && files.length === 0 && (
        <div className="empty-state" style={{ gridColumn: '1 / -1' }}>
          <div className="icon">📭</div><div>Empty directory</div>
        </div>
      )}
    </div>
  )
}

function FileIconCard({ entry }: { entry: BrowseEntry }) {
  const [hovering, setHovering] = useState(false)
  const ext = fileExt(entry.name).toLowerCase()

  const hasPreview = ext === 'gaf' || ext === 'pcx' || ext === 'smk' || ext === 'zrb' || ext === 'sct' || ext === 'tnt'
  const hasAnimation = ext === 'gaf' || ext === 'smk' || ext === 'zrb'

  let thumbSrc: string | undefined
  let animSrc: string | undefined

  if (ext === 'gaf') {
    thumbSrc = pngURL(entry.path, 0, 0)
    animSrc = apngURL(entry.path, 0)
  } else if (ext === 'pcx') {
    thumbSrc = pcxURL(entry.path)
  } else if (ext === 'smk' || ext === 'zrb') {
    thumbSrc = zrbThumbURL(entry.path)
    animSrc = zrbThumbURL(entry.path)
  } else if (ext === 'sct') {
    thumbSrc = sctMinimapURL(entry.path)
  } else if (ext === 'tnt') {
    thumbSrc = tntMinimapURL(entry.path)
  }

  return (
    <Link
      to={`/view/${entry.path}`}
      className="icon-card"
      onMouseEnter={() => hasAnimation && setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <div className="icon-thumb">
        {hovering && animSrc && ext === 'gaf' ? (
          <img src={animSrc} alt={entry.name} className="icon-img" onError={handleImgError} />
        ) : hasPreview && thumbSrc ? (
          <img src={thumbSrc} alt={entry.name} className="icon-img" onError={handleImgError} />
        ) : (
          <span className="icon-emoji">{fileIcon(entry.name)}</span>
        )}
        <BrokenPlaceholder label="Broken" style={{ width: 64, height: 64 }} />
      </div>
      <div className="icon-label" title={entry.name}>{entry.name}</div>
      {entry.size && <div className="icon-size">{entry.size}</div>}
    </Link>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────

function dirStats(folders: number, files: number): string {
  const parts: string[] = []
  if (folders > 0) parts.push(`${folders} folder${folders !== 1 ? 's' : ''}`)
  if (files > 0) parts.push(`${files} file${files !== 1 ? 's' : ''}`)
  return parts.join(', ')
}

function fileExt(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot === -1) return ''
  return name.substring(dot + 1).toUpperCase()
}

function fileIcon(name: string): string {
  const ext = fileExt(name).toLowerCase()
  switch (ext) {
    case 'gaf': return '🎨'
    case 'pcx': return '🖼️'
    case 'bmp': return '🖼️'
    case 'wav': return '🔊'
    case 'mp3': return '🎵'
    case 'fnt': return '🔤'
    case 'pal': return '🎨'
    case 'smk': case 'zrb': return '🎬'
    case 'cob': return '⚙️'
    case 'bos': case 'h': return '📝'
    case 'tdf': case 'fbi': case 'gui': case 'ota': return '📋'
    case '3do': return '🎮'
    case 'sct': return '🗺️'
    case 'tnt': return '🗺️'
    default: return '📄'
  }
}

function parseSize(s: string): number {
  if (!s) return 0
  const match = s.match(/^([\d.]+)\s*(\w+)?$/)
  if (!match) return 0
  const val = parseFloat(match[1])
  const unit = (match[2] || 'B').toUpperCase()
  switch (unit) {
    case 'KB': return val * 1024
    case 'MB': return val * 1024 * 1024
    case 'GB': return val * 1024 * 1024 * 1024
    default: return val
  }
}
