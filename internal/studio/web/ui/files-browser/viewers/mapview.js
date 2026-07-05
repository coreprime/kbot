// mapview.js
//
// A pan/zoom canvas for the large map renders shared by the TNT and SCT
// viewers.  It fits the image into the viewport on first load, supports
// drag-to-pan and wheel-to-zoom, and floats a clickable minimap that
// shows the current viewport rectangle.  Feature markers and start
// positions are passed in as overlay data and drawn in map space.

import { htm as html } from '@coreprime/kbot-ui/htm-bind'
import { useRef, useState, useEffect, useCallback } from 'preact/hooks'

function hideBroken(e) { e.target.style.visibility = 'hidden' }

export function PanZoomMap({ imgUrl, minimapUrl, pixelW, pixelH, tileW, tileH, info, features, placements, startPositions }) {
  const containerRef = useRef(null)
  const lastPos = useRef({ x: 0, y: 0 })
  const fittedRef = useRef(false)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const [imgLoaded, setImgLoaded] = useState(false)
  const [viewSize, setViewSize] = useState({ w: 800, h: 500 })
  const [showGrid, setShowGrid] = useState(false)
  const [showFeatures, setShowFeatures] = useState(true)
  const [hoverTile, setHoverTile] = useState(null)
  const [hoverFeat, setHoverFeat] = useState(null)

  const gridW = tileW || 0
  const gridH = tileH || 0

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const obs = new ResizeObserver((entries) => {
      for (const e of entries) setViewSize({ w: e.contentRect.width, h: e.contentRect.height })
    })
    obs.observe(el)
    setViewSize({ w: el.clientWidth, h: el.clientHeight })
    return () => obs.disconnect()
  }, [])

  useEffect(() => {
    if (!imgLoaded || viewSize.w === 0 || fittedRef.current) return
    fittedRef.current = true
    const fit = Math.min(viewSize.w / pixelW, viewSize.h / pixelH, 1)
    setZoom(fit)
    setPan({ x: (viewSize.w - pixelW * fit) / 2, y: (viewSize.h - pixelH * fit) / 2 })
  }, [imgLoaded, pixelW, pixelH, viewSize.w, viewSize.h])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = (e) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const mx = e.clientX - rect.left, my = e.clientY - rect.top
      const factor = e.deltaY > 0 ? 0.9 : 1.1
      const newZoom = Math.max(0.1, Math.min(8, zoom * factor))
      setPan((p) => ({ x: mx - (mx - p.x) * (newZoom / zoom), y: my - (my - p.y) * (newZoom / zoom) }))
      setZoom(newZoom)
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [zoom])

  const onMouseDown = useCallback((e) => { setDragging(true); lastPos.current = { x: e.clientX, y: e.clientY } }, [])
  const onMouseMove = useCallback((e) => {
    if (containerRef.current && gridW > 0) {
      const rect = containerRef.current.getBoundingClientRect()
      const mapX = (e.clientX - rect.left - pan.x) / zoom
      const mapY = (e.clientY - rect.top - pan.y) / zoom
      const tx = Math.floor(mapX / 32), ty = Math.floor(mapY / 32)
      setHoverTile(tx >= 0 && tx < gridW && ty >= 0 && ty < gridH ? { x: tx, y: ty } : null)
    }
    if (!dragging) return
    const dx = e.clientX - lastPos.current.x, dy = e.clientY - lastPos.current.y
    lastPos.current = { x: e.clientX, y: e.clientY }
    setPan((p) => ({ x: p.x + dx, y: p.y + dy }))
  }, [dragging, pan.x, pan.y, zoom, gridW, gridH])
  const onMouseUp = useCallback(() => setDragging(false), [])

  const onMinimapClick = useCallback((e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const mx = (e.clientX - rect.left) / rect.width, my = (e.clientY - rect.top) / rect.height
    setPan({ x: viewSize.w / 2 - mx * pixelW * zoom, y: viewSize.h / 2 - my * pixelH * zoom })
  }, [zoom, pixelW, pixelH, viewSize.w, viewSize.h])

  let vpRect = null
  if (imgLoaded && viewSize.w > 0) {
    vpRect = {
      left: `${Math.max(0, (-pan.x / zoom) / pixelW * 100)}%`,
      top: `${Math.max(0, (-pan.y / zoom) / pixelH * 100)}%`,
      width: `${Math.min(100, (viewSize.w / zoom) / pixelW * 100)}%`,
      height: `${Math.min(100, (viewSize.h / zoom) / pixelH * 100)}%`,
    }
  }

  const hasFeatures = features && placements && placements.length > 0

  return html`
    <div class="fx-map">
      <div class="fx-map-toolbar">
        <span class="fx-map-info">${info} · ${Math.round(zoom * 100)}%</span>
        ${hoverTile ? html`<span class="fx-map-hover">Tile (${hoverTile.x}, ${hoverTile.y})</span>` : null}
        ${gridW > 0 ? html`<label class="fx-map-check"><input type="checkbox" checked=${showGrid} onChange=${(e) => setShowGrid(e.target.checked)} /> Grid</label>` : null}
        ${hasFeatures ? html`<label class="fx-map-check"><input type="checkbox" checked=${showFeatures} onChange=${(e) => setShowFeatures(e.target.checked)} /> Features (${placements.length})</label>` : null}
      </div>
      <div ref=${containerRef} class="fx-map-viewport" onMouseDown=${onMouseDown} onMouseMove=${onMouseMove}
           onMouseUp=${onMouseUp} onMouseLeave=${onMouseUp} onContextMenu=${(e) => e.preventDefault()}>
        <div class="fx-map-canvas" style=${`transform:translate(${pan.x}px,${pan.y}px) scale(${zoom});transform-origin:0 0;width:${pixelW}px;height:${pixelH}px`}>
          <img src=${imgUrl} alt="Map" class="fx-map-img" draggable="false" onLoad=${() => setImgLoaded(true)} onError=${hideBroken} />
          ${showGrid && zoom >= 0.4 && gridW > 0 ? html`
            <svg class="fx-map-grid" viewBox=${`0 0 ${gridW} ${gridH}`} preserveAspectRatio="none">
              ${Array.from({ length: gridW + 1 }, (_, i) => html`<line key=${'v' + i} x1=${i} y1=${0} x2=${i} y2=${gridH} />`)}
              ${Array.from({ length: gridH + 1 }, (_, i) => html`<line key=${'h' + i} x1=${0} y1=${i} x2=${gridW} y2=${i} />`)}
              ${hoverTile ? html`<rect x=${hoverTile.x} y=${hoverTile.y} width=${1} height=${1} class="fx-map-grid-hover" />` : null}
            </svg>` : null}
          ${showFeatures && hasFeatures ? placements.map((p, i) => {
            const feat = features[p.featureIdx]
            if (!feat) return null
            return html`<div key=${i} class="fx-map-marker" style=${`left:${p.pixelX}px;top:${p.pixelY}px`}
                onMouseEnter=${() => setHoverFeat({ name: feat.name, desc: feat.description, x: p.pixelX, y: p.pixelY })}
                onMouseLeave=${() => setHoverFeat(null)}><span class="fx-map-marker-dot"></span></div>`
          }) : null}
        </div>
        ${hoverFeat ? html`
          <div class="fx-map-tip" style=${`left:${pan.x + hoverFeat.x * zoom + 18}px;top:${pan.y + hoverFeat.y * zoom - 8}px`}>
            <div class="fx-map-tip-name">${hoverFeat.name}</div>
            ${hoverFeat.desc ? html`<div class="fx-map-tip-desc">${hoverFeat.desc}</div>` : null}
            <div class="fx-map-tip-pos">(${hoverFeat.x}, ${hoverFeat.y})</div>
          </div>` : null}
        ${minimapUrl ? html`
          <div class="fx-map-minimap">
            <img src=${minimapUrl} alt="Minimap" class="fx-map-minimap-img" onClick=${onMinimapClick} draggable="false" onError=${hideBroken} />
            ${vpRect ? html`<div class="fx-map-minimap-vp" style=${vpRect}></div>` : null}
            ${startPositions ? startPositions.map((sp) => html`
              <div key=${sp.number} class="fx-map-start" style=${`left:${sp.pctX}%;top:${sp.pctY}%`} title=${`Start Position ${sp.number}`}>${sp.number}</div>`) : null}
          </div>` : null}
      </div>
    </div>
  `
}
