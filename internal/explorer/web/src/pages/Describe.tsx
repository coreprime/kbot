import { useLocation, Link } from 'react-router-dom'
import { useAsync } from '../hooks'
import { describe } from '../api'
import { Loading, ErrorMsg } from '../components/Loading'
import Breadcrumbs from '../components/Breadcrumbs'
import MetadataTree from '../components/MetadataTree'

export default function Describe() {
  const location = useLocation()
  const filePath = location.pathname.replace(/^\/describe\/?/, '') || ''

  const { data, loading, error } = useAsync(() => describe(filePath), [filePath])

  if (loading) return <Loading />
  if (error) return <ErrorMsg message={error} />
  if (!data) return null

  // Build breadcrumbs from path
  const parts = filePath.split('/').filter(Boolean)
  const fileName = parts[parts.length - 1] || filePath
  const crumbs = parts.slice(0, -1).map((name, i) => ({
    name,
    path: parts.slice(0, i + 1).join('/'),
  }))

  // Separate nested objects from scalar fields
  const nested: Record<string, unknown> = {}

  for (const [key, val] of Object.entries(data)) {
    if (typeof val === 'object' && val !== null) {
      nested[key] = val
    }
  }

  return (
    <div>
      <Breadcrumbs crumbs={crumbs} linkPrefix="/browse" current={fileName} />

      <div className="view-header">
        <h1>
          🔍 {fileName}
          {data.format && <span className="format-badge">{data.format}</span>}
        </h1>
        <div className="view-header-actions">
          <Link to={`/view/${filePath}`} className="download-btn">
            👁 View File
          </Link>
        </div>
      </div>

      {/* Top-level info */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="info-grid">
          <span className="label">Path</span>
          <span className="value">{data.path}</span>
          <span className="label">Size</span>
          <span className="value">{data.size}</span>
          <span className="label">Source</span>
          <span className="value">{data.source}</span>
          <span className="label">Format</span>
          <span className="value">{data.format || 'Unknown'}</span>
        </div>
      </div>

      {/* Nested metadata sections */}
      {Object.keys(nested).length > 0 && (
        <div className="card">
          <MetadataTree data={nested} defaultOpen={true} />
        </div>
      )}
    </div>
  )
}
