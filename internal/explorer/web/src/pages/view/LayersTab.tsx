import { formatSize, type ViewResult, type ViewLayer } from '../../api'

// Normalize layer fields — API may return PascalCase or camelCase.
function layerSource(l: ViewLayer): string { return l.source || l.Source || '' }
function layerSize(l: ViewLayer): number { return l.size ?? l.Size ?? 0 }
function layerPriority(l: ViewLayer): number { return l.priority ?? l.Priority ?? 0 }

export default function LayersTab({
  data,
  activeSource,
  onSwitch,
}: {
  data: ViewResult
  activeSource: string
  onSwitch: (source: string) => void
}) {
  if (!data.layers || data.layers.length === 0) {
    return <div className="empty-state">No layer information available.</div>
  }

  return (
    <div>
      <p style={{ marginBottom: 12, fontSize: 13, color: 'var(--text-secondary)' }}>
        This file exists in {data.layers.length} source(s). Click to switch.
      </p>
      <div className="layer-list">
        {data.layers.map((layer, i) => {
          const src = layerSource(layer)
          const isActive = src === activeSource
          return (
            <div
              key={i}
              className={`layer-item ${isActive ? 'active' : ''}`}
              onClick={() => onSwitch(src)}
            >
              <div>
                <span className="source-name">{src}</span>
                {isActive && (
                  <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--green)' }}>● active</span>
                )}
              </div>
              <div className="layer-meta">
                <span>{formatSize(layerSize(layer))}</span>
                <span>Priority: {layerPriority(layer)}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
