import { useState, useCallback } from 'react'
import { useLocation, useNavigate, Link } from 'react-router-dom'
import { view, rawURL, parentDir, type LintLineInfo } from '../../api'
import { useAsync } from '../../hooks'
import { Loading, ErrorMsg } from '../../components/Loading'
import Breadcrumbs from '../../components/Breadcrumbs'
import { buildTabs, isCOB, isTNT, isSCT } from './helpers'
import InfoTab from './InfoTab'
import ContentTab from './ContentTab'
import { DecompiledTab, DisassemblyTab } from './CobContent'
import RawTextTab from './RawTextTab'
import { SCTTiles, SCTHeightMap } from './SCTContent'
import { TNTTiles, TNTHeightMap } from './TNTContent'
import TNTFeatures from './TNTFeatures'
import CallGraph from './CallGraph'
import BinaryTab from './BinaryTab'
import LintTab from './LintTab'
import DescribeTab from './DescribeTab'
import MetadataTab from './MetadataTab'
import LayersTab from './LayersTab'

function tabFromHash(hash: string): string | null {
  const h = hash.replace(/^#/, '')
  return h || null
}

export default function View() {
  const location = useLocation()
  const navigate = useNavigate()
  const filePath = location.pathname.replace(/^\/view\/?/, '') || ''
  const [activeSource, setActiveSource] = useState<string | undefined>(undefined)
  const [highlightLine, setHighlightLine] = useState<number | null>(null)

  const hashTab = tabFromHash(location.hash)

  const switchTab = useCallback((id: string) => {
    navigate({ hash: id }, { replace: true })
  }, [navigate])

  const handleJumpToLine = useCallback((line: number, tab: string) => {
    setHighlightLine(line)
    switchTab(tab)
    // Scroll to line after tab renders.
    setTimeout(() => {
      const el = document.querySelector(`[data-line="${line}"]`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    }, 100)
  }, [switchTab])

  const { data, loading, error } = useAsync(
    () => view(filePath, activeSource),
    [filePath, activeSource]
  )

  if (loading) return <Loading />
  if (error) return <ErrorMsg message={error} />
  if (!data) return null

  const fmt = (data.format || '').toLowerCase()
  const tabs = buildTabs(data)
  const defaultTab = tabs[0]?.id || 'content'
  const currentTab = (hashTab && tabs.find(t => t.id === hashTab)) ? hashTab : defaultTab

  // Collect lint diagnostics per line for code view annotations.
  const lintResults = (data as Record<string, unknown>).lintResults as Array<{ line: number; severity: string; rule: string; message: string }> | undefined
  const lintLineMap = new Map<number, LintLineInfo[]>()
  if (lintResults) {
    for (const d of lintResults) {
      if (d.line > 0) {
        const existing = lintLineMap.get(d.line) || []
        existing.push({ rule: d.rule, severity: d.severity, message: d.message })
        lintLineMap.set(d.line, existing)
      }
    }
  }

  return (
    <div>
      <Breadcrumbs
        crumbs={data.breadcrumbs || []}
        linkPrefix="/browse"
        current={data.fileName}
      />

      <div style={{ marginBottom: 8 }}>
        <Link to={`/browse/${parentDir(filePath)}`} className="back-link">
          ← Back to folder
        </Link>
      </div>

      <div className="view-header">
        <h1>
          {data.fileName}
          {data.format && <span className="format-badge">{data.format}</span>}
        </h1>
        <a href={rawURL(filePath)} className="download-btn" download>
          ⬇ Download
        </a>
      </div>

      <div className="tabs">
        {tabs.map(tab => (
          <button
            key={tab.id}
            className={`tab-btn ${currentTab === tab.id ? 'active' : ''}`}
            onClick={() => { switchTab(tab.id); setHighlightLine(null) }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="card">
        {currentTab === 'content' && <ContentTab data={data} filePath={filePath} lintLines={lintLineMap} highlightLine={highlightLine} />}
        {currentTab === 'info' && <InfoTab data={data} />}
        {currentTab === 'metadata' && <MetadataTab data={data} filePath={filePath} />}
        {currentTab === 'decompiled' && isCOB(fmt) && <DecompiledTab data={data} lintLines={lintLineMap} highlightLine={highlightLine} />}
        {currentTab === 'disassembly' && isCOB(fmt) && <DisassemblyTab data={data} />}
        {currentTab === 'text' && <RawTextTab data={data} />}
        {currentTab === 'features' && isTNT(fmt) && <TNTFeatures data={data} />}
        {currentTab === 'tiles' && isTNT(fmt) && <TNTTiles data={data} />}
        {currentTab === 'tiles' && isSCT(fmt) && <SCTTiles data={data} />}
        {currentTab === 'heightmap' && !isTNT(fmt) && <SCTHeightMap data={data} />}
        {currentTab === 'heightmap' && isTNT(fmt) && <TNTHeightMap data={data} />}
        {currentTab === 'callgraph' && <CallGraph data={data} />}
        {currentTab === 'lint' && <LintTab data={data} onJumpToLine={handleJumpToLine} />}
        {currentTab === 'binary' && <BinaryTab data={data} filePath={filePath} />}
        {currentTab === 'describe' && <DescribeTab filePath={filePath} />}
        {currentTab === 'layers' && (
          <LayersTab
            data={data}
            activeSource={activeSource || data.source}
            onSwitch={setActiveSource}
          />
        )}
      </div>
    </div>
  )
}


