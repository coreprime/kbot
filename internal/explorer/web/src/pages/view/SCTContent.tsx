import { useState, useCallback } from 'react'
import type { ViewResult } from '../../api'
import BrokenPlaceholder from '../../components/BrokenAsset'
import { handleImgError } from '../../components/brokenAssetUtils'
import TileGrid from '../../components/TileGrid'

export function SCTTileMap({ data }: { data: ViewResult }) {
  const d = data as Record<string, unknown>
  const tileMapUrl = d.sctTileMapUrl as string | undefined
  const minimapUrl = d.sctMinimapUrl as string | undefined
  const pw = d.sctPixelWidth as number | undefined
  const ph = d.sctPixelHeight as number | undefined
  const tw = d.sctWidth as number | undefined
  const th = d.sctHeight as number | undefined
  const numTiles = d.sctNumTiles as number | undefined
  const [showGrid, setShowGrid] = useState(true)
  const [hoverTile, setHoverTile] = useState<{ x: number; y: number } | null>(null)

  const handleTileHover = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!tw || !th) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const tileX = Math.floor((x / rect.width) * tw)
    const tileY = Math.floor((y / rect.height) * th)
    if (tileX >= 0 && tileX < tw && tileY >= 0 && tileY < th) {
      setHoverTile({ x: tileX, y: tileY })
    }
  }, [tw, th])

  const handleTileLeave = useCallback(() => setHoverTile(null), [])

  return (
    <div className="sct-viewer">
      <div className="sct-stats">
        {tw != null && th != null && <span>{tw}×{th} tiles</span>}
        {pw != null && ph != null && <span>{pw}×{ph} px</span>}
        {numTiles != null && <span>{numTiles} unique tiles</span>}
        {hoverTile && (
          <span className="sct-tile-info">Tile ({hoverTile.x}, {hoverTile.y})</span>
        )}
      </div>

      <div className="sct-images">
        {tileMapUrl && (
          <div className="sct-main-image">
            <h3 className="section-heading">Tile Map</h3>
            <div
              className="sct-image-wrap sct-gridded"
              onMouseMove={handleTileHover}
              onMouseLeave={handleTileLeave}
            >
              <label className="sct-grid-toggle-float">
                <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} />
                Grid
              </label>
              <img src={tileMapUrl} alt="Tile map" className="sct-img" onError={handleImgError} />
              <BrokenPlaceholder label="Failed to render tile map" style={{ width: 256, height: 256 }} />
              {showGrid && tw && th && (
                <svg className="sct-grid-overlay" viewBox={`0 0 ${tw} ${th}`} preserveAspectRatio="none">
                  {Array.from({ length: tw + 1 }, (_, i) => (
                    <line key={`v${i}`} x1={i} y1={0} x2={i} y2={th} />
                  ))}
                  {Array.from({ length: th + 1 }, (_, i) => (
                    <line key={`h${i}`} x1={0} y1={i} x2={tw} y2={i} />
                  ))}
                  {hoverTile && (
                    <rect x={hoverTile.x} y={hoverTile.y} width={1} height={1} className="sct-grid-hover" />
                  )}
                </svg>
              )}
            </div>
          </div>
        )}

        {minimapUrl && (
          <div className="sct-minimap">
            <h3 className="section-heading">Minimap</h3>
            <div className="sct-image-wrap">
              <img src={minimapUrl} alt="Minimap" className="sct-img sct-minimap-img" onError={handleImgError} />
              <BrokenPlaceholder label="No minimap" style={{ width: 128, height: 128 }} />
            </div>
          </div>
        )}
      </div>

    </div>
  )
}

export function SCTTiles({ data }: { data: ViewResult }) {
  const d = data as Record<string, unknown>
  const numTiles = d.sctNumTiles as number | undefined
  const tileBaseUrl = d.sctTileBaseUrl as string | undefined

  if (!tileBaseUrl || !numTiles) {
    return <div className="empty-state">No tile data available.</div>
  }

  return <TileGrid tileBaseUrl={tileBaseUrl} tileCount={numTiles} />
}

export function SCTHeightMap({ data }: { data: ViewResult }) {
  const d = data as Record<string, unknown>
  const heightMapUrl = d.sctHeightMapUrl as string | undefined
  const hasHeightMap = d.sctHasHeightMap as boolean | undefined
  const tw = d.sctWidth as number | undefined
  const th = d.sctHeight as number | undefined
  const [showGrid, setShowGrid] = useState(true)

  if (!hasHeightMap) {
    return <div className="empty-state">No height data available in this section.</div>
  }

  const hw = tw ? tw * 2 : 0
  const hh = th ? th * 2 : 0

  return (
    <div className="sct-viewer">
      <p className="sct-desc">
        Greyscale height map — brighter pixels are higher elevation.
        Each tile has 4 height samples (2×2 sub-grid).
      </p>
      <div className="sct-main-image">
        <div className="sct-image-wrap sct-gridded">
          <label className="sct-grid-toggle-float">
            <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} />
            Grid
          </label>
          {heightMapUrl && (
            <>
              <img src={heightMapUrl} alt="Height map" className="sct-img sct-heightmap-img" onError={handleImgError} />
              <BrokenPlaceholder label="Failed to render height map" style={{ width: 256, height: 256 }} />
              {showGrid && hw > 0 && hh > 0 && tw && th && (
                <svg className="sct-grid-overlay" viewBox={`0 0 ${hw} ${hh}`} preserveAspectRatio="none">
                  {Array.from({ length: tw + 1 }, (_, i) => (
                    <line key={`tv${i}`} x1={i * 2} y1={0} x2={i * 2} y2={hh} className="sct-grid-tile-line" />
                  ))}
                  {Array.from({ length: th + 1 }, (_, i) => (
                    <line key={`th${i}`} x1={0} y1={i * 2} x2={hw} y2={i * 2} className="sct-grid-tile-line" />
                  ))}
                  {Array.from({ length: hw + 1 }, (_, i) => (
                    <line key={`sv${i}`} x1={i} y1={0} x2={i} y2={hh} className="sct-grid-sub-line" />
                  ))}
                  {Array.from({ length: hh + 1 }, (_, i) => (
                    <line key={`sh${i}`} x1={0} y1={i} x2={hw} y2={i} className="sct-grid-sub-line" />
                  ))}
                </svg>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
