import { useState, useCallback, useRef, useEffect } from 'react'
import type { ViewResult } from '../../api'
import BrokenPlaceholder from '../../components/BrokenAsset'
import { handleImgError } from '../../components/brokenAssetUtils'
import TileGrid from '../../components/TileGrid'

export function TNTMapView({ data }: { data: ViewResult }) {
  const d = data as Record<string, unknown>
  const tileMapUrl = d.tntTileMapUrl as string | undefined
  const minimapUrl = d.tntMinimapUrl as string | undefined
  const tileW = d.tntTileW as number || 1
  const tileH = d.tntTileH as number || 1
  const pixelW = tileW * 32
  const pixelH = tileH * 32

  const startPositions = d.tntStartPositions as Array<{ number: number; pctX: number; pctY: number }> | undefined
  const features = d.tntFeatures as Array<{ index: number; name: string; description: string; category: string; filename: string; seqname: string; gafUrl: string }> | undefined
  const placements = d.tntPlacements as Array<{ featureIdx: number; pixelX: number; pixelY: number }> | undefined
  const [showFeatures, setShowFeatures] = useState(true)
  const [hoveredFeature, setHoveredFeature] = useState<{ name: string; desc: string; x: number; y: number } | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [panX, setPanX] = useState(0)
  const [panY, setPanY] = useState(0)
  const [showGrid, setShowGrid] = useState(false)
  const [hoverTile, setHoverTile] = useState<{ x: number; y: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const lastPos = useRef({ x: 0, y: 0 })
  const [imgLoaded, setImgLoaded] = useState(false)
  const [viewSize, setViewSize] = useState({ w: 800, h: 500 })

  // Track container size.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const obs = new ResizeObserver(entries => {
      for (const e of entries) {
        setViewSize({ w: e.contentRect.width, h: e.contentRect.height })
      }
    })
    obs.observe(el)
    setViewSize({ w: el.clientWidth, h: el.clientHeight })
    return () => obs.disconnect()
  }, [])

  // Fit the map into the viewport on first load.
  const fittedRef = useRef(false)
  useEffect(() => {
    if (!imgLoaded || viewSize.w === 0 || fittedRef.current) return
    fittedRef.current = true
    const fitZoom = Math.min(viewSize.w / pixelW, viewSize.h / pixelH, 1)
    setZoom(fitZoom)
    setPanX((viewSize.w - pixelW * fitZoom) / 2)
    setPanY((viewSize.h - pixelH * fitZoom) / 2)
  }, [imgLoaded, pixelW, pixelH, viewSize.w, viewSize.h])

  // Wheel zoom centered on cursor.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const factor = e.deltaY > 0 ? 0.9 : 1.1
      const newZoom = Math.max(0.1, Math.min(8, zoom * factor))
      // Keep the point under the cursor fixed.
      setPanX(mx - (mx - panX) * (newZoom / zoom))
      setPanY(my - (my - panY) * (newZoom / zoom))
      setZoom(newZoom)
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [zoom, panX, panY])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    setDragging(true)
    lastPos.current = { x: e.clientX, y: e.clientY }
  }, [])

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    // Tile hover info.
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const mapX = (mx - panX) / zoom
      const mapY = (my - panY) / zoom
      const tx = Math.floor(mapX / 32)
      const ty = Math.floor(mapY / 32)
      if (tx >= 0 && tx < tileW && ty >= 0 && ty < tileH) {
        setHoverTile({ x: tx, y: ty })
      } else {
        setHoverTile(null)
      }
    }
    if (!dragging) return
    const dx = e.clientX - lastPos.current.x
    const dy = e.clientY - lastPos.current.y
    lastPos.current = { x: e.clientX, y: e.clientY }
    setPanX(prev => prev + dx)
    setPanY(prev => prev + dy)
  }, [dragging, panX, panY, zoom, tileW, tileH])

  const onMouseUp = useCallback(() => setDragging(false), [])

  // Minimap click → jump.
  const onMinimapClick = useCallback((e: React.MouseEvent<HTMLImageElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const mx = (e.clientX - rect.left) / rect.width
    const my = (e.clientY - rect.top) / rect.height
    setPanX(viewSize.w / 2 - mx * pixelW * zoom)
    setPanY(viewSize.h / 2 - my * pixelH * zoom)
  }, [zoom, pixelW, pixelH, viewSize.w, viewSize.h])

  // Minimap viewport indicator — computed from state, no ref access.
  let vpRect: { left: string; top: string; width: string; height: string } | null = null
  if (imgLoaded && viewSize.w > 0) {
    const vpLeft = (-panX / zoom) / pixelW * 100
    const vpTop = (-panY / zoom) / pixelH * 100
    const vpWidth = (viewSize.w / zoom) / pixelW * 100
    const vpHeight = (viewSize.h / zoom) / pixelH * 100
    vpRect = {
      left: `${Math.max(0, vpLeft)}%`,
      top: `${Math.max(0, vpTop)}%`,
      width: `${Math.min(100, vpWidth)}%`,
      height: `${Math.min(100, vpHeight)}%`,
    }
  }

  return (
    <div className="tnt-map-viewer">
      <div className="tnt-map-toolbar">
        <span className="tnt-map-info">{tileW}×{tileH} tiles · {Math.round(zoom * 100)}%</span>
        {hoverTile && (
          <span className="tnt-map-hover">
            Tile ({hoverTile.x}, {hoverTile.y})
          </span>
        )}
        <label className="sct-grid-toggle-float" style={{ position: 'static', background: 'var(--bg-secondary)' }}>
          <input type="checkbox" checked={showGrid} onChange={e => setShowGrid(e.target.checked)} />
          Grid
        </label>
        {placements && placements.length > 0 && (
          <label className="sct-grid-toggle-float" style={{ position: 'static', background: 'var(--bg-secondary)' }}>
            <input type="checkbox" checked={showFeatures} onChange={e => setShowFeatures(e.target.checked)} />
            Features ({placements.length})
          </label>
        )}
      </div>

      <div
        ref={containerRef}
        className="tnt-map-viewport"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onContextMenu={e => e.preventDefault()}
      >
        {tileMapUrl && (
          <div
            className="tnt-map-canvas"
            style={{
              transform: `translate(${panX}px, ${panY}px) scale(${zoom})`,
              transformOrigin: '0 0',
              width: pixelW,
              height: pixelH,
            }}
          >
            <img
              src={tileMapUrl}
              alt="Map"
              className="tnt-map-img"
              onLoad={() => setImgLoaded(true)}
              onError={handleImgError}
              draggable={false}
            />
            <BrokenPlaceholder label="Failed to load map" style={{ width: 256, height: 256 }} />
            {showGrid && zoom >= 0.5 && (
              <svg className="tnt-map-grid" viewBox={`0 0 ${tileW} ${tileH}`} preserveAspectRatio="none">
                {Array.from({ length: tileW + 1 }, (_, i) => (
                  <line key={`v${i}`} x1={i} y1={0} x2={i} y2={tileH} />
                ))}
                {Array.from({ length: tileH + 1 }, (_, i) => (
                  <line key={`h${i}`} x1={0} y1={i} x2={tileW} y2={i} />
                ))}
                {hoverTile && (
                  <rect x={hoverTile.x} y={hoverTile.y} width={1} height={1} className="sct-grid-hover" />
                )}
              </svg>
            )}
            {/* Feature overlays */}
            {showFeatures && features && placements && placements.map((p, i) => {
              const feat = features[p.featureIdx]
              if (!feat) return null
              return (
                <div
                  key={i}
                  className="tnt-feature-marker"
                  style={{ left: p.pixelX, top: p.pixelY }}
                  onMouseEnter={() => setHoveredFeature({ name: feat.name, desc: feat.description, x: p.pixelX, y: p.pixelY })}
                  onMouseLeave={() => setHoveredFeature(null)}
                >
                  {feat.gafUrl ? (
                    <img src={feat.gafUrl} alt={feat.name} className="tnt-feature-marker-img" />
                  ) : (
                    <span className="tnt-feature-marker-dot" />
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* Feature tooltip — outside the scaled canvas so it stays at normal size */}
        {hoveredFeature && (
          <div className="tnt-feature-tooltip" style={{
            left: panX + hoveredFeature.x * zoom + 20,
            top: panY + hoveredFeature.y * zoom - 10,
          }}>
            <div className="tnt-feature-tooltip-name">{hoveredFeature.name}</div>
            {hoveredFeature.desc && <div className="tnt-feature-tooltip-desc">{hoveredFeature.desc}</div>}
            <div className="tnt-feature-tooltip-pos">({hoveredFeature.x}, {hoveredFeature.y})</div>
          </div>
        )}

        {/* Minimap overlay */}
        {minimapUrl && (
          <div className="tnt-map-minimap-overlay">
            <img
              src={minimapUrl}
              alt="Minimap"
              className="tnt-map-minimap-img"
              onClick={onMinimapClick}
              draggable={false}
            />
            {vpRect && (
              <div className="tnt-map-minimap-vp" style={vpRect} />
            )}
            {startPositions && startPositions.map(sp => (
              <div
                key={sp.number}
                className="tnt-start-marker"
                style={{ left: `${sp.pctX}%`, top: `${sp.pctY}%` }}
                title={`Start Position ${sp.number}`}
              >
                {sp.number}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export function TNTTiles({ data }: { data: ViewResult }) {
  const d = data as Record<string, unknown>
  const numTiles = d.tntNumTiles as number | undefined
  const tileBaseUrl = d.tntTileBaseUrl as string | undefined

  if (!tileBaseUrl || !numTiles) {
    return <div className="empty-state">No tile data available.</div>
  }

  return <TileGrid tileBaseUrl={tileBaseUrl} tileCount={numTiles} />
}

export function TNTHeightMap({ data }: { data: ViewResult }) {
  const d = data as Record<string, unknown>
  const heightMapUrl = d.tntHeightMapUrl as string | undefined
  const minimapUrl = d.tntMinimapUrl as string | undefined
  const tileW = d.tntTileW as number || 1
  const tileH = d.tntTileH as number || 1
  // Height map is at attribute resolution: 2× tile dimensions.
  const imgW = tileW * 2
  const imgH = tileH * 2

  const containerRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [panX, setPanX] = useState(0)
  const [panY, setPanY] = useState(0)
  const [dragging, setDragging] = useState(false)
  const lastPos = useRef({ x: 0, y: 0 })
  const [imgLoaded, setImgLoaded] = useState(false)
  const [viewSize, setViewSize] = useState({ w: 800, h: 500 })
  const fittedRef = useRef(false)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const obs = new ResizeObserver(entries => {
      for (const e of entries) setViewSize({ w: e.contentRect.width, h: e.contentRect.height })
    })
    obs.observe(el)
    setViewSize({ w: el.clientWidth, h: el.clientHeight })
    return () => obs.disconnect()
  }, [])

  useEffect(() => {
    if (!imgLoaded || viewSize.w === 0 || fittedRef.current) return
    fittedRef.current = true
    const fitZoom = Math.min(viewSize.w / imgW, viewSize.h / imgH, 1)
    setZoom(fitZoom)
    setPanX((viewSize.w - imgW * fitZoom) / 2)
    setPanY((viewSize.h - imgH * fitZoom) / 2)
  }, [imgLoaded, imgW, imgH, viewSize.w, viewSize.h])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const mx = e.clientX - rect.left, my = e.clientY - rect.top
      const factor = e.deltaY > 0 ? 0.9 : 1.1
      const newZoom = Math.max(0.1, Math.min(8, zoom * factor))
      setPanX(mx - (mx - panX) * (newZoom / zoom))
      setPanY(my - (my - panY) * (newZoom / zoom))
      setZoom(newZoom)
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [zoom, panX, panY])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    setDragging(true)
    lastPos.current = { x: e.clientX, y: e.clientY }
  }, [])
  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return
    setPanX(prev => prev + e.clientX - lastPos.current.x)
    setPanY(prev => prev + e.clientY - lastPos.current.y)
    lastPos.current = { x: e.clientX, y: e.clientY }
  }, [dragging])
  const onMouseUp = useCallback(() => setDragging(false), [])

  const onMinimapClick = useCallback((e: React.MouseEvent<HTMLImageElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const mx = (e.clientX - rect.left) / rect.width
    const my = (e.clientY - rect.top) / rect.height
    setPanX(viewSize.w / 2 - mx * imgW * zoom)
    setPanY(viewSize.h / 2 - my * imgH * zoom)
  }, [zoom, imgW, imgH, viewSize.w, viewSize.h])

  let vpRect: { left: string; top: string; width: string; height: string } | null = null
  if (imgLoaded && viewSize.w > 0) {
    const vpLeft = (-panX / zoom) / imgW * 100
    const vpTop = (-panY / zoom) / imgH * 100
    const vpW = (viewSize.w / zoom) / imgW * 100
    const vpH = (viewSize.h / zoom) / imgH * 100
    vpRect = { left: `${Math.max(0, vpLeft)}%`, top: `${Math.max(0, vpTop)}%`, width: `${Math.min(100, vpW)}%`, height: `${Math.min(100, vpH)}%` }
  }

  if (!heightMapUrl) {
    return <div className="empty-state">No height data available.</div>
  }

  return (
    <div className="tnt-map-viewer">
      <div className="tnt-map-toolbar">
        <span className="tnt-map-info">Height Map · {imgW}×{imgH} · {Math.round(zoom * 100)}%</span>
      </div>
      <div
        ref={containerRef}
        className="tnt-map-viewport"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onContextMenu={e => e.preventDefault()}
      >
        <div
          className="tnt-map-canvas"
          style={{ transform: `translate(${panX}px, ${panY}px) scale(${zoom})`, transformOrigin: '0 0', width: imgW, height: imgH }}
        >
          <img
            src={heightMapUrl}
            alt="Height map"
            className="tnt-map-img"
            onLoad={() => setImgLoaded(true)}
            onError={handleImgError}
            draggable={false}
          />
          <BrokenPlaceholder label="Failed to load height map" style={{ width: 256, height: 256 }} />
        </div>
        {minimapUrl && (
          <div className="tnt-map-minimap-overlay">
            <img src={minimapUrl} alt="Minimap" className="tnt-map-minimap-img" onClick={onMinimapClick} draggable={false} />
            {vpRect && <div className="tnt-map-minimap-vp" style={vpRect} />}
          </div>
        )}
      </div>
    </div>
  )
}
