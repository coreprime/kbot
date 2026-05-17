import { useState, useCallback } from 'react'
import type { ViewResult } from '../../api'

interface LHTRow {
  colorIdx: number
  srcColor: string
  levels: string[]
}

interface ALPCell {
  srcIdx: number
  dstIdx: number
  result: number
  color: string
}

export default function ColorTableContent({ data }: { data: ViewResult }) {
  const d = data as Record<string, unknown>
  const tableType = d.tableType as string
  const description = d.tableDescription as string
  const tableWidth = d.tableWidth as number
  const tableHeight = d.tableHeight as number

  return (
    <div className="color-table-viewer">
      <div className="color-table-header">
        <div className="color-table-dims">{tableHeight} × {tableWidth}</div>
        <p className="color-table-desc">{description}</p>
      </div>

      {tableType === 'alpha' && <AlphaPreview data={data} />}
      {(tableType === 'lighting' || tableType === 'shadow') && <GradientTable data={data} />}
    </div>
  )
}

function AlphaPreview({ data }: { data: ViewResult }) {
  const d = data as Record<string, unknown>
  const preview = d.tablePreview as ALPCell[] | undefined
  const [hovered, setHovered] = useState<ALPCell | null>(null)

  const onEnter = useCallback((c: ALPCell) => setHovered(c), [])
  const onLeave = useCallback(() => setHovered(null), [])

  if (!preview) return <div className="empty-state">No preview data.</div>

  return (
    <div>
      <h3 className="section-heading">Sampled Preview (16×16)</h3>
      <div className="color-table-info-bar">
        {hovered ? (
          <span>
            <span className="ct-swatch" style={{ background: hovered.color }} />
            src={hovered.srcIdx} × dst={hovered.dstIdx} → index {hovered.result}
          </span>
        ) : (
          <span className="palette-hover-hint">Hover a cell to see the blend mapping</span>
        )}
      </div>
      <div className="alp-grid">
        {preview.map((c, i) => (
          <div
            key={i}
            className="alp-cell"
            style={{ backgroundColor: c.color || '#000' }}
            onMouseEnter={() => onEnter(c)}
            onMouseLeave={onLeave}
          />
        ))}
      </div>
    </div>
  )
}

function GradientTable({ data }: { data: ViewResult }) {
  const d = data as Record<string, unknown>
  const rows = d.tableRows as LHTRow[] | undefined
  const tableType = d.tableType as string
  const [hovered, setHovered] = useState<{ row: number; col: number; color: string } | null>(null)

  if (!rows || rows.length === 0) return <div className="empty-state">No table data.</div>

  const levelLabel = tableType === 'lighting' ? 'Brightness' : 'Shadow'

  return (
    <div>
      <h3 className="section-heading">
        Color Gradients (sampled — every 8th palette entry)
      </h3>
      <div className="color-table-info-bar">
        {hovered ? (
          <span>
            <span className="ct-swatch" style={{ background: hovered.color }} />
            Color #{hovered.row} at {levelLabel.toLowerCase()} level {hovered.col}
          </span>
        ) : (
          <span className="palette-hover-hint">Hover to see details</span>
        )}
      </div>
      <div className="gradient-table">
        <div className="gradient-header">
          <div className="gradient-label-cell">Color</div>
          {Array.from({ length: 32 }, (_, i) => (
            <div key={i} className="gradient-level-header">{i}</div>
          ))}
        </div>
        {rows.map((row) => (
          <div key={row.colorIdx} className="gradient-row">
            <div className="gradient-label-cell">
              <span className="ct-swatch" style={{ background: row.srcColor || '#000' }} />
              <span className="gradient-idx">#{row.colorIdx}</span>
            </div>
            {row.levels.map((color, lv) => (
              <div
                key={lv}
                className="gradient-cell"
                style={{ backgroundColor: color || '#000' }}
                onMouseEnter={() => setHovered({ row: row.colorIdx, col: lv, color: color || '#000' })}
                onMouseLeave={() => setHovered(null)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
