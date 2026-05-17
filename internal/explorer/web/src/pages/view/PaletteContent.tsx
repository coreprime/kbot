import { useState, useCallback } from 'react'
import type { ViewResult } from '../../api'

interface PaletteColor {
  index: number
  r: number
  g: number
  b: number
  a: number
  hex: string
}

export default function PaletteContent({ data }: { data: ViewResult }) {
  const colors = (data as Record<string, unknown>).paletteColors as PaletteColor[] | undefined
  const colorCount = (data as Record<string, unknown>).paletteColorCount as number | undefined
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)

  const onEnter = useCallback((i: number) => setHoveredIdx(i), [])
  const onLeave = useCallback(() => setHoveredIdx(null), [])

  if (!colors || colors.length === 0) {
    return <div className="empty-state">No palette data available.</div>
  }

  const hovered = hoveredIdx !== null ? colors[hoveredIdx] : null

  return (
    <div className="palette-viewer">
      {/* Info bar */}
      <div className="palette-info-bar">
        <span className="palette-count">{colorCount || colors.length} colors</span>
        {hovered ? (
          <span className="palette-hover-info">
            <span className="palette-hover-swatch" style={{ background: hovered.hex }} />
            <span className="palette-hover-detail">
              #{hovered.index} — {hovered.hex} — rgb({hovered.r}, {hovered.g}, {hovered.b})
            </span>
          </span>
        ) : (
          <span className="palette-hover-hint">Hover a color to see details</span>
        )}
      </div>

      {/* Color grid — 16×16 */}
      <div className="palette-grid">
        {colors.map((c) => (
          <div
            key={c.index}
            className={`palette-cell ${hoveredIdx === c.index ? 'palette-cell-active' : ''}`}
            style={{ backgroundColor: c.hex }}
            title={`#${c.index} ${c.hex}\nRGB(${c.r}, ${c.g}, ${c.b})`}
            onMouseEnter={() => onEnter(c.index)}
            onMouseLeave={onLeave}
          >
            <span className="palette-cell-idx">{c.index}</span>
          </div>
        ))}
      </div>

      {/* Detail panel for hovered color */}
      {hovered && (
        <div className="palette-detail-card">
          <div className="palette-detail-swatch" style={{ background: hovered.hex }} />
          <div className="palette-detail-fields">
            <div className="palette-detail-row">
              <span className="label">Index</span>
              <span className="value">{hovered.index}</span>
            </div>
            <div className="palette-detail-row">
              <span className="label">Hex</span>
              <span className="value mono">{hovered.hex}</span>
            </div>
            <div className="palette-detail-row">
              <span className="label">RGB</span>
              <span className="value mono">{hovered.r}, {hovered.g}, {hovered.b}</span>
            </div>
            <div className="palette-detail-row">
              <span className="label">Alpha</span>
              <span className="value mono">{hovered.a}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
