import { useState, useCallback } from 'react'

interface Props {
  tileBaseUrl: string
  tileCount: number
  label?: string
}

export default function TileGrid({ tileBaseUrl, tileCount, label }: Props) {
  const [hovered, setHovered] = useState<number | null>(null)

  const onEnter = useCallback((i: number) => setHovered(i), [])
  const onLeave = useCallback(() => setHovered(null), [])

  if (tileCount === 0) return null

  // Limit display to first 512 tiles to avoid overwhelming the browser.
  const maxDisplay = Math.min(tileCount, 512)
  const truncated = tileCount > maxDisplay

  return (
    <div className="tile-grid-section">
      <h3 className="section-heading">
        {label || 'Unique Tiles'} ({tileCount})
      </h3>
      {hovered !== null && (
        <div className="tile-grid-info">
          Tile #{hovered}
        </div>
      )}
      <div className="tile-grid">
        {Array.from({ length: maxDisplay }, (_, i) => (
          <div
            key={i}
            className={`tile-grid-cell ${hovered === i ? 'tile-grid-cell-active' : ''}`}
            onMouseEnter={() => onEnter(i)}
            onMouseLeave={onLeave}
          >
            <img
              src={`${tileBaseUrl}/${i}`}
              alt={`Tile ${i}`}
              className="tile-grid-img"
              loading="lazy"
            />
            {hovered === i && (
              <div className="tile-grid-expanded">
                <img
                  src={`${tileBaseUrl}/${i}`}
                  alt={`Tile ${i} expanded`}
                  className="tile-grid-expanded-img"
                />
                <div className="tile-grid-expanded-label">#{i}</div>
              </div>
            )}
          </div>
        ))}
      </div>
      {truncated && (
        <p className="tile-grid-truncated">
          Showing {maxDisplay} of {tileCount} tiles
        </p>
      )}
    </div>
  )
}
