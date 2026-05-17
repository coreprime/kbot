import { useRef, useEffect, useState, useCallback } from 'react'
import type { ViewResult } from '../../api'

interface GraphNode { name: string; type: string }
interface GraphEdge { from: string; to: string; type: string }

interface SimNode extends GraphNode {
  x: number; y: number; vx: number; vy: number
}

const EDGE_COLORS: Record<string, string> = {
  call: '#82aaff',
  start: '#c3e88d',
  signal: '#f78c6c',
  'set-mask': '#c792ea',
}
const EDGE_LABELS: Record<string, string> = {
  call: 'calls',
  start: 'starts',
  signal: 'signals',
  'set-mask': 'sets mask',
}

export default function CallGraph({ data }: { data: ViewResult }) {
  const d = data as Record<string, unknown>
  const rawNodes = d.callGraphNodes as GraphNode[] | undefined
  const rawEdges = d.callGraphEdges as GraphEdge[] | undefined
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const nodesRef = useRef<SimNode[]>([])
  const [hovered, setHovered] = useState<string | null>(null)
  const dragRef = useRef<{ node: SimNode; offX: number; offY: number } | null>(null)
  const panRef = useRef({ x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 })
  const zoomRef = useRef(1)
  const rafRef = useRef(0)

  // Init simulation nodes.
  useEffect(() => {
    if (!rawNodes) return
    const W = 800, H = 500
    nodesRef.current = rawNodes.map((n, i) => ({
      ...n,
      x: W / 2 + (Math.cos(i * 2.399) * 150),
      y: H / 2 + (Math.sin(i * 2.399) * 150),
      vx: 0, vy: 0,
    }))
  }, [rawNodes])

  // Force simulation + render loop.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !rawNodes || !rawEdges) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const nodes = nodesRef.current
    const nodeMap = new Map<string, SimNode>()
    for (const n of nodes) nodeMap.set(n.name, n)

    let running = true

    function tick() {
      if (!running) return
      const W = canvas!.width, H = canvas!.height

      // Force-directed: repulsion between all nodes.
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[j].x - nodes[i].x
          const dy = nodes[j].y - nodes[i].y
          const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1)
          const force = 8000 / (dist * dist)
          const fx = (dx / dist) * force
          const fy = (dy / dist) * force
          nodes[i].vx -= fx; nodes[i].vy -= fy
          nodes[j].vx += fx; nodes[j].vy += fy
        }
      }

      // Attraction along edges.
      for (const e of rawEdges!) {
        const a = nodeMap.get(e.from)
        const b = nodeMap.get(e.to)
        if (!a || !b) continue
        const dx = b.x - a.x, dy = b.y - a.y
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1)
        const force = (dist - 120) * 0.01
        const fx = (dx / dist) * force
        const fy = (dy / dist) * force
        a.vx += fx; a.vy += fy
        b.vx -= fx; b.vy -= fy
      }

      // Center gravity.
      for (const n of nodes) {
        n.vx += (W / 2 - n.x) * 0.001
        n.vy += (H / 2 - n.y) * 0.001
      }

      // Apply velocity with damping.
      for (const n of nodes) {
        if (dragRef.current?.node === n) continue
        n.vx *= 0.85; n.vy *= 0.85
        n.x += n.vx; n.y += n.vy
        n.x = Math.max(60, Math.min(W - 60, n.x))
        n.y = Math.max(30, Math.min(H - 30, n.y))
      }

      // Draw.
      ctx!.save()
      ctx!.setTransform(1, 0, 0, 1, 0, 0)
      ctx!.clearRect(0, 0, W, H)
      ctx!.translate(panRef.current.x, panRef.current.y)
      ctx!.scale(zoomRef.current, zoomRef.current)

      // Pre-compute edge grouping for overlapping edges.
      const pairCount = new Map<string, number>()
      const pairIndex = new Map<string, number>()
      for (const e of rawEdges!) {
        const pk = [e.from, e.to].sort().join('|')
        pairCount.set(pk, (pairCount.get(pk) || 0) + 1)
      }
      const pairCursor = new Map<string, number>()

      // Edges.
      for (const e of rawEdges!) {
        const a = nodeMap.get(e.from)
        const b = nodeMap.get(e.to)
        if (!a || !b) continue
        const color = EDGE_COLORS[e.type] || '#666'
        const isHL = hovered === a.name || hovered === b.name

        // Curve offset for parallel edges between the same pair.
        const pk = [e.from, e.to].sort().join('|')
        const ek = `${e.from}|${e.to}|${e.type}`
        let eIdx = pairIndex.get(ek)
        if (eIdx === undefined) {
          eIdx = pairCursor.get(pk) || 0
          pairCursor.set(pk, eIdx + 1)
          pairIndex.set(ek, eIdx)
        }
        const cnt = pairCount.get(pk) || 1
        const curveOff = cnt <= 1 ? 0 : (eIdx - (cnt - 1) / 2) * 30

        const dx = b.x - a.x, dy = b.y - a.y
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1)
        const nx = -dy / dist, ny = dx / dist
        const cpx = (a.x + b.x) / 2 + nx * curveOff
        const cpy = (a.y + b.y) / 2 + ny * curveOff

        ctx!.strokeStyle = isHL ? color : color + '88'
        ctx!.lineWidth = isHL ? 2 : 1
        ctx!.beginPath()
        ctx!.moveTo(a.x, a.y)
        if (curveOff !== 0) {
          ctx!.quadraticCurveTo(cpx, cpy, b.x, b.y)
        } else {
          ctx!.lineTo(b.x, b.y)
        }
        ctx!.stroke()

        // Arrowhead at ~65% along the curve.
        const t = 0.65
        let ax2: number, ay2: number, aAngle: number
        if (curveOff !== 0) {
          const mt = 1 - t
          ax2 = mt * mt * a.x + 2 * mt * t * cpx + t * t * b.x
          ay2 = mt * mt * a.y + 2 * mt * t * cpy + t * t * b.y
          const tx2 = 2 * (1 - t) * (cpx - a.x) + 2 * t * (b.x - cpx)
          const ty2 = 2 * (1 - t) * (cpy - a.y) + 2 * t * (b.y - cpy)
          aAngle = Math.atan2(ty2, tx2)
        } else {
          ax2 = a.x + (b.x - a.x) * t
          ay2 = a.y + (b.y - a.y) * t
          aAngle = Math.atan2(b.y - a.y, b.x - a.x)
        }
        const hl = 8
        ctx!.fillStyle = isHL ? color : color + '88'
        ctx!.beginPath()
        ctx!.moveTo(ax2, ay2)
        ctx!.lineTo(ax2 - hl * Math.cos(aAngle - 0.4), ay2 - hl * Math.sin(aAngle - 0.4))
        ctx!.lineTo(ax2 - hl * Math.cos(aAngle + 0.4), ay2 - hl * Math.sin(aAngle + 0.4))
        ctx!.fill()

        // Edge label at curve apex.
        if (isHL) {
          const lx = curveOff !== 0 ? cpx : (a.x + b.x) / 2
          const ly = (curveOff !== 0 ? cpy : (a.y + b.y) / 2) - 6
          ctx!.font = '10px monospace'
          ctx!.fillStyle = color
          ctx!.textAlign = 'center'
          ctx!.fillText(EDGE_LABELS[e.type] || e.type, lx, ly)
        }
      }
      // Nodes.
      for (const n of nodes) {
        const isHovered = hovered === n.name
        const isSignal = n.type === 'signal'
        const w = ctx!.measureText(n.name).width + 20
        const h = 28
        const x = n.x - w / 2, y = n.y - h / 2

        ctx!.font = '12px monospace'

        // Box.
        if (isSignal) {
          ctx!.fillStyle = isHovered ? '#3a2a1a' : '#2a1a0a'
          ctx!.strokeStyle = '#f78c6c'
          roundRect(ctx!, x, y, w, h, 14)
        } else {
          ctx!.fillStyle = isHovered ? '#1a2a3a' : '#1a1a2a'
          ctx!.strokeStyle = isHovered ? '#82aaff' : '#444'
          roundRect(ctx!, x, y, w, h, 4)
        }
        ctx!.fill()
        ctx!.lineWidth = isHovered ? 2 : 1
        ctx!.stroke()

        // Label.
        ctx!.fillStyle = isSignal ? '#f78c6c' : '#e0e0e0'
        ctx!.textAlign = 'center'
        ctx!.textBaseline = 'middle'
        ctx!.fillText(n.name, n.x, n.y)
      }

      ctx!.restore()
      rafRef.current = requestAnimationFrame(tick)
    }

    tick()
    return () => { running = false; cancelAnimationFrame(rafRef.current) }
  }, [rawNodes, rawEdges, hovered])

  // Mouse interaction.
  const getNodeAt = useCallback((mx: number, my: number): SimNode | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const sx = (mx - panRef.current.x) / zoomRef.current
    const sy = (my - panRef.current.y) / zoomRef.current
    ctx.font = '12px monospace'
    for (const n of nodesRef.current) {
      const w = ctx.measureText(n.name).width + 20
      if (Math.abs(sx - n.x) < w / 2 && Math.abs(sy - n.y) < 14) return n
    }
    return null
  }, [])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const mx = e.clientX - rect.left, my = e.clientY - rect.top
    const node = getNodeAt(mx, my)
    if (node) {
      dragRef.current = { node, offX: (mx - panRef.current.x) / zoomRef.current - node.x, offY: (my - panRef.current.y) / zoomRef.current - node.y }
    } else {
      panRef.current.dragging = true
      panRef.current.lastX = e.clientX
      panRef.current.lastY = e.clientY
    }
  }, [getNodeAt])

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const mx = e.clientX - rect.left, my = e.clientY - rect.top

    if (dragRef.current) {
      const n = dragRef.current.node
      n.x = (mx - panRef.current.x) / zoomRef.current - dragRef.current.offX
      n.y = (my - panRef.current.y) / zoomRef.current - dragRef.current.offY
      n.vx = 0; n.vy = 0
      return
    }

    if (panRef.current.dragging) {
      panRef.current.x += e.clientX - panRef.current.lastX
      panRef.current.y += e.clientY - panRef.current.lastY
      panRef.current.lastX = e.clientX
      panRef.current.lastY = e.clientY
      return
    }

    const node = getNodeAt(mx, my)
    setHovered(node ? node.name : null)
  }, [getNodeAt])

  const onMouseUp = useCallback(() => {
    dragRef.current = null
    panRef.current.dragging = false
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const handler = (e: WheelEvent) => {
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

  if (!rawNodes || !rawEdges || rawNodes.length === 0) {
    return <div className="empty-state">No call graph data available.</div>
  }

  // Legend.
  return (
    <div className="callgraph-container">
      <div className="callgraph-legend">
        {Object.entries(EDGE_COLORS).map(([type, color]) => (
          <span key={type} className="callgraph-legend-item">
            <span className="callgraph-legend-swatch" style={{ backgroundColor: color }} />
            {EDGE_LABELS[type]}
          </span>
        ))}
        <span className="callgraph-legend-item">
          <span className="callgraph-legend-swatch" style={{ backgroundColor: '#f78c6c', borderRadius: '50%' }} />
          signal
        </span>
      </div>
      <canvas
        ref={canvasRef}
        width={800}
        height={500}
        className="callgraph-canvas"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
      />
      <div className="callgraph-hint">
        Drag nodes to rearrange · Drag background to pan · Scroll to zoom · Hover for details
      </div>
    </div>
  )
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y, x + w, y + r, r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h, x, y + h - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
}
