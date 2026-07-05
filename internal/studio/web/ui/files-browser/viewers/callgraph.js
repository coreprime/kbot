// callgraph.js
//
// Force-directed call/signal graph for COB and BOS scripts.  Functions
// are boxes, signals are pills; edges are coloured by kind (call / start
// / signal / set-mask) with arrowheads and hover labels.  The simulation
// runs on a canvas; nodes drag, the background pans, the wheel zooms.

import { htm as html } from '@coreprime/kbot-ui/htm-bind'
import { useRef, useEffect, useState, useCallback } from 'preact/hooks'

const EDGE_COLORS = { call: '#82aaff', start: '#c3e88d', signal: '#f78c6c', 'set-mask': '#c792ea' }
const EDGE_LABELS = { call: 'calls', start: 'starts', signal: 'signals', 'set-mask': 'sets mask' }

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r)
  ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r)
  ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
}

// Call-graph node/edge field names may arrive PascalCase (Go structs) or
// camelCase; normalise on the way in.
function normNodes(raw) {
  return (raw || []).map((n) => ({ name: n.name ?? n.Name ?? '', type: n.type ?? n.Type ?? 'function' }))
}
function normEdges(raw) {
  return (raw || []).map((e) => ({ from: e.from ?? e.From ?? '', to: e.to ?? e.To ?? '', type: e.type ?? e.Type ?? 'call' }))
}

export function CallGraph({ nodes: rawNodesIn, edges: rawEdgesIn }) {
  const rawNodes = normNodes(rawNodesIn)
  const rawEdges = normEdges(rawEdgesIn)
  const canvasRef = useRef(null)
  const nodesRef = useRef([])
  const [hovered, setHovered] = useState(null)
  const dragRef = useRef(null)
  const panRef = useRef({ x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 })
  const zoomRef = useRef(1)
  const rafRef = useRef(0)

  useEffect(() => {
    const W = 800, H = 500
    nodesRef.current = rawNodes.map((n, i) => ({
      ...n, x: W / 2 + Math.cos(i * 2.399) * 150, y: H / 2 + Math.sin(i * 2.399) * 150, vx: 0, vy: 0,
    }))
  }, [rawNodesIn])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || rawNodes.length === 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const nodes = nodesRef.current
    const nodeMap = new Map()
    for (const n of nodes) nodeMap.set(n.name, n)
    let running = true

    function tick() {
      if (!running) return
      const W = canvas.width, H = canvas.height
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[j].x - nodes[i].x, dy = nodes[j].y - nodes[i].y
          const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1)
          const force = 8000 / (dist * dist)
          const fx = (dx / dist) * force, fy = (dy / dist) * force
          nodes[i].vx -= fx; nodes[i].vy -= fy; nodes[j].vx += fx; nodes[j].vy += fy
        }
      }
      for (const e of rawEdges) {
        const a = nodeMap.get(e.from), b = nodeMap.get(e.to)
        if (!a || !b) continue
        const dx = b.x - a.x, dy = b.y - a.y
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1)
        const force = (dist - 120) * 0.01
        const fx = (dx / dist) * force, fy = (dy / dist) * force
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy
      }
      for (const n of nodes) { n.vx += (W / 2 - n.x) * 0.001; n.vy += (H / 2 - n.y) * 0.001 }
      for (const n of nodes) {
        if (dragRef.current && dragRef.current.node === n) continue
        n.vx *= 0.85; n.vy *= 0.85; n.x += n.vx; n.y += n.vy
        n.x = Math.max(60, Math.min(W - 60, n.x)); n.y = Math.max(30, Math.min(H - 30, n.y))
      }
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, W, H)
      ctx.translate(panRef.current.x, panRef.current.y)
      ctx.scale(zoomRef.current, zoomRef.current)

      const pairCount = new Map(), pairIndex = new Map(), pairCursor = new Map()
      for (const e of rawEdges) { const pk = [e.from, e.to].sort().join('|'); pairCount.set(pk, (pairCount.get(pk) || 0) + 1) }
      for (const e of rawEdges) {
        const a = nodeMap.get(e.from), b = nodeMap.get(e.to)
        if (!a || !b) continue
        const color = EDGE_COLORS[e.type] || '#666'
        const isHL = hovered === a.name || hovered === b.name
        const pk = [e.from, e.to].sort().join('|'), ek = `${e.from}|${e.to}|${e.type}`
        let eIdx = pairIndex.get(ek)
        if (eIdx === undefined) { eIdx = pairCursor.get(pk) || 0; pairCursor.set(pk, eIdx + 1); pairIndex.set(ek, eIdx) }
        const cnt = pairCount.get(pk) || 1
        const curveOff = cnt <= 1 ? 0 : (eIdx - (cnt - 1) / 2) * 30
        const dx = b.x - a.x, dy = b.y - a.y
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1)
        const nx = -dy / dist, ny = dx / dist
        const cpx = (a.x + b.x) / 2 + nx * curveOff, cpy = (a.y + b.y) / 2 + ny * curveOff
        ctx.strokeStyle = isHL ? color : color + '88'
        ctx.lineWidth = isHL ? 2 : 1
        ctx.beginPath(); ctx.moveTo(a.x, a.y)
        if (curveOff !== 0) ctx.quadraticCurveTo(cpx, cpy, b.x, b.y); else ctx.lineTo(b.x, b.y)
        ctx.stroke()
        const t = 0.65
        let ax2, ay2, aAngle
        if (curveOff !== 0) {
          const mt = 1 - t
          ax2 = mt * mt * a.x + 2 * mt * t * cpx + t * t * b.x
          ay2 = mt * mt * a.y + 2 * mt * t * cpy + t * t * b.y
          aAngle = Math.atan2(2 * (1 - t) * (cpy - a.y) + 2 * t * (b.y - cpy), 2 * (1 - t) * (cpx - a.x) + 2 * t * (b.x - cpx))
        } else {
          ax2 = a.x + (b.x - a.x) * t; ay2 = a.y + (b.y - a.y) * t; aAngle = Math.atan2(b.y - a.y, b.x - a.x)
        }
        const hl = 8
        ctx.fillStyle = isHL ? color : color + '88'
        ctx.beginPath(); ctx.moveTo(ax2, ay2)
        ctx.lineTo(ax2 - hl * Math.cos(aAngle - 0.4), ay2 - hl * Math.sin(aAngle - 0.4))
        ctx.lineTo(ax2 - hl * Math.cos(aAngle + 0.4), ay2 - hl * Math.sin(aAngle + 0.4))
        ctx.fill()
        if (isHL) {
          const lx = curveOff !== 0 ? cpx : (a.x + b.x) / 2
          const ly = (curveOff !== 0 ? cpy : (a.y + b.y) / 2) - 6
          ctx.font = '10px monospace'; ctx.fillStyle = color; ctx.textAlign = 'center'
          ctx.fillText(EDGE_LABELS[e.type] || e.type, lx, ly)
        }
      }
      for (const n of nodes) {
        const isHovered = hovered === n.name, isSignal = n.type === 'signal'
        ctx.font = '12px monospace'
        const w = ctx.measureText(n.name).width + 20, h = 28
        const x = n.x - w / 2, y = n.y - h / 2
        if (isSignal) { ctx.fillStyle = isHovered ? '#3a2a1a' : '#2a1a0a'; ctx.strokeStyle = '#f78c6c'; roundRect(ctx, x, y, w, h, 14) }
        else { ctx.fillStyle = isHovered ? '#1a2a3a' : '#1a1a2a'; ctx.strokeStyle = isHovered ? '#82aaff' : '#444'; roundRect(ctx, x, y, w, h, 4) }
        ctx.fill(); ctx.lineWidth = isHovered ? 2 : 1; ctx.stroke()
        ctx.fillStyle = isSignal ? '#f78c6c' : '#e0e0e0'
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText(n.name, n.x, n.y)
      }
      ctx.restore()
      rafRef.current = requestAnimationFrame(tick)
    }
    tick()
    return () => { running = false; cancelAnimationFrame(rafRef.current) }
  }, [rawNodesIn, rawEdgesIn, hovered])

  const getNodeAt = useCallback((mx, my) => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const sx = (mx - panRef.current.x) / zoomRef.current, sy = (my - panRef.current.y) / zoomRef.current
    ctx.font = '12px monospace'
    for (const n of nodesRef.current) {
      const w = ctx.measureText(n.name).width + 20
      if (Math.abs(sx - n.x) < w / 2 && Math.abs(sy - n.y) < 14) return n
    }
    return null
  }, [])

  const onMouseDown = useCallback((e) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const mx = e.clientX - rect.left, my = e.clientY - rect.top
    const node = getNodeAt(mx, my)
    if (node) dragRef.current = { node, offX: (mx - panRef.current.x) / zoomRef.current - node.x, offY: (my - panRef.current.y) / zoomRef.current - node.y }
    else { panRef.current.dragging = true; panRef.current.lastX = e.clientX; panRef.current.lastY = e.clientY }
  }, [getNodeAt])

  const onMouseMove = useCallback((e) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const mx = e.clientX - rect.left, my = e.clientY - rect.top
    if (dragRef.current) {
      const n = dragRef.current.node
      n.x = (mx - panRef.current.x) / zoomRef.current - dragRef.current.offX
      n.y = (my - panRef.current.y) / zoomRef.current - dragRef.current.offY
      n.vx = 0; n.vy = 0; return
    }
    if (panRef.current.dragging) {
      panRef.current.x += e.clientX - panRef.current.lastX
      panRef.current.y += e.clientY - panRef.current.lastY
      panRef.current.lastX = e.clientX; panRef.current.lastY = e.clientY; return
    }
    const node = getNodeAt(mx, my)
    setHovered(node ? node.name : null)
  }, [getNodeAt])

  const onMouseUp = useCallback(() => { dragRef.current = null; panRef.current.dragging = false }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const handler = (e) => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left, my = e.clientY - rect.top
      const factor = e.deltaY > 0 ? 0.9 : 1.1
      const newZoom = Math.max(0.3, Math.min(3, zoomRef.current * factor))
      panRef.current.x = mx - (mx - panRef.current.x) * (newZoom / zoomRef.current)
      panRef.current.y = my - (my - panRef.current.y) * (newZoom / zoomRef.current)
      zoomRef.current = newZoom
    }
    canvas.addEventListener('wheel', handler, { passive: false })
    return () => canvas.removeEventListener('wheel', handler)
  }, [])

  if (rawNodes.length === 0) return html`<div class="fx-empty">No call graph data available.</div>`

  return html`
    <div class="fx-callgraph">
      <div class="fx-cg-legend">
        ${Object.entries(EDGE_COLORS).map(([type, color]) => html`
          <span key=${type} class="fx-cg-legend-item"><span class="fx-cg-swatch" style=${`background:${color}`}></span>${EDGE_LABELS[type]}</span>`)}
        <span class="fx-cg-legend-item"><span class="fx-cg-swatch" style="background:#f78c6c;border-radius:50%"></span>signal</span>
      </div>
      <canvas ref=${canvasRef} width="800" height="500" class="fx-cg-canvas"
              onMouseDown=${onMouseDown} onMouseMove=${onMouseMove} onMouseUp=${onMouseUp} onMouseLeave=${onMouseUp}></canvas>
      <div class="fx-cg-hint">Drag nodes to rearrange · Drag background to pan · Scroll to zoom · Hover for details</div>
    </div>
  `
}
