import { useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import type { ViewResult } from '../../api'

interface FeatureInfo {
  index: number
  name: string
  description: string
  category: string
  filename: string
  seqname: string
  footprintX: number
  footprintZ: number
  count: number
  gafUrl: string
}

export default function TNTFeatures({ data }: { data: ViewResult }) {
  const d = data as Record<string, unknown>
  const features = d.tntFeatures as FeatureInfo[] | undefined
  const [filter, setFilter] = useState('')

  const onFilter = useCallback((e: React.ChangeEvent<HTMLInputElement>) => setFilter(e.target.value), [])

  if (!features || features.length === 0) {
    return <div className="empty-state">No features in this map.</div>
  }

  const filtered = filter
    ? features.filter(f =>
        f.name.toLowerCase().includes(filter.toLowerCase()) ||
        f.description.toLowerCase().includes(filter.toLowerCase()) ||
        f.category.toLowerCase().includes(filter.toLowerCase())
      )
    : features

  const totalPlacements = features.reduce((sum, f) => sum + f.count, 0)

  return (
    <div className="tnt-features">
      <div className="tnt-features-header">
        <span className="tnt-features-stats">
          {features.length} types · {totalPlacements} placed
        </span>
        <input
          type="text"
          className="tnt-features-filter"
          placeholder="Filter features..."
          value={filter}
          onChange={onFilter}
        />
      </div>

      <div className="tnt-features-grid">
        {filtered.map(f => (
          <div key={f.index} className="tnt-feature-card">
            <div className="tnt-feature-preview">
              {f.gafUrl ? (
                <img src={f.gafUrl} alt={f.name} className="tnt-feature-img" />
              ) : (
                <span className="tnt-feature-icon">🏗️</span>
              )}
            </div>
            <div className="tnt-feature-info">
              <div className="tnt-feature-name">{f.name}</div>
              {f.description && <div className="tnt-feature-desc">{f.description}</div>}
              <div className="tnt-feature-meta">
                {f.category && <span className="tnt-feature-cat">{f.category}</span>}
                {f.count > 0 && <span className="tnt-feature-count">×{f.count}</span>}
                {f.footprintX > 0 && <span className="tnt-feature-fp">{f.footprintX}×{f.footprintZ}</span>}
              </div>
              <div className="tnt-feature-links">
                {f.filename && (
                  <Link to={`/view/anims/${f.filename.toLowerCase()}.gaf`} className="tnt-feature-link">
                    {f.filename}.gaf
                  </Link>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// Export the feature types for use by the map view overlay.
export type { FeatureInfo }
