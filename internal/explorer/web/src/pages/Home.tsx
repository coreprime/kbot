import { Link } from 'react-router-dom'
import { getStats, formatSize } from '../api'
import { useAsync } from '../hooks'
import { Loading, ErrorMsg } from '../components/Loading'
import SearchBox from '../components/SearchBox'

export default function Home() {
  const { data: stats, loading, error } = useAsync(() => getStats(), [])

  if (loading) return <Loading />
  if (error) return <ErrorMsg message={error} />
  if (!stats) return null

  return (
    <div>
      <div className="home-hero">
        <h1>🤖 KBot Explorer</h1>
        <p>
          Browse the complete file-systems for Total
          Annihilation &amp; TA: Kingdoms, including any mod content.
        </p>

        <SearchBox autoFocus />

        <div className="home-actions">
          <Link to="/browse" className="btn-primary">
            📁 Browse Files
          </Link>
        </div>
      </div>

      <div className="card-grid">
        <div className="card stat-card">
          <div className="stat-value">{stats.archives.toLocaleString()}</div>
          <div className="stat-label">Archives Loaded</div>
        </div>
        <div className="card stat-card">
          <div className="stat-value">{stats.totalFiles.toLocaleString()}</div>
          <div className="stat-label">Total Files</div>
        </div>
        <div className="card stat-card">
          <div className="stat-value">{stats.directories.toLocaleString()}</div>
          <div className="stat-label">Directories</div>
        </div>
        <div className="card stat-card">
          <div className="stat-value">{formatSize(stats.unpackedSize)}</div>
          <div className="stat-label">Unpacked Size</div>
        </div>
        <div className="card stat-card">
          <div className="stat-value">{formatSize(stats.packedSize)}</div>
          <div className="stat-label">Packed Size</div>
        </div>
        <div className="card stat-card">
          <div className="stat-value">{stats.compressionRatio.toFixed(1)}%</div>
          <div className="stat-label">Compression</div>
        </div>
      </div>

      <div className="card">
        <div className="info-grid">
          <span className="label">Base Path</span>
          <span className="value">{stats.basePath}</span>
          <span className="label">Supported Formats</span>
          <span className="value">HPI, UFO, CCX, GP3</span>
        </div>
      </div>
    </div>
  )
}
