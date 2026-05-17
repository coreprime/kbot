import { useState, useCallback } from 'react'
import type { ViewResult } from '../../api'

interface ObjectInfo {
  name: string
  vertices: number
  primitives: number
  children: number
  depth: number
}

export default function TDOContent({ data }: { data: ViewResult }) {
  const d = data as Record<string, unknown>
  const totalObjects = d.tdoTotalObjects as number | undefined
  const totalVertices = d.tdoTotalVertices as number | undefined
  const totalPrimitives = d.tdoTotalPrimitives as number | undefined
  const textures = d.tdoTextures as string[] | undefined
  const objects = d.tdoObjects as ObjectInfo[] | undefined
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const toggleCollapse = useCallback((name: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  return (
    <div className="tdo-viewer">
      {/* Stats */}
      <div className="tdo-stats">
        {totalObjects != null && <span className="tdo-stat">🧩 {totalObjects} objects</span>}
        {totalVertices != null && <span className="tdo-stat">📐 {totalVertices.toLocaleString()} vertices</span>}
        {totalPrimitives != null && <span className="tdo-stat">🔺 {totalPrimitives.toLocaleString()} primitives</span>}
        {textures && textures.length > 0 && <span className="tdo-stat">🎨 {textures.length} textures</span>}
      </div>

      {/* Object tree */}
      {objects && objects.length > 0 && (
        <div className="tdo-section">
          <h3 className="section-heading">Object Hierarchy</h3>
          <div className="tdo-tree">
            {objects.map((obj, i) => {
              const hasChildren = obj.children > 0
              const isCollapsed = collapsed.has(obj.name)
              // Skip children of collapsed parents.
              if (i > 0) {
                let skip = false
                for (let j = i - 1; j >= 0; j--) {
                  if (objects[j].depth < obj.depth && collapsed.has(objects[j].name)) {
                    skip = true
                    break
                  }
                  if (objects[j].depth < obj.depth) break
                }
                if (skip) return null
              }

              return (
                <div
                  key={`${obj.name}-${i}`}
                  className="tdo-tree-node"
                  style={{ paddingLeft: obj.depth * 20 + 8 }}
                >
                  <span
                    className={`tdo-tree-toggle ${hasChildren ? 'tdo-tree-clickable' : ''}`}
                    onClick={hasChildren ? () => toggleCollapse(obj.name) : undefined}
                  >
                    {hasChildren ? (isCollapsed ? '▸' : '▾') : '·'}
                  </span>
                  <span className="tdo-tree-name">{obj.name || '(unnamed)'}</span>
                  <span className="tdo-tree-meta">
                    {obj.vertices > 0 && <span className="tdo-tree-badge">{obj.vertices}v</span>}
                    {obj.primitives > 0 && <span className="tdo-tree-badge">{obj.primitives}p</span>}
                  </span>
                  {obj.vertices === 1 && obj.primitives === 0 && (
                    <span className="tdo-tree-tag">marker</span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Textures */}
      {textures && textures.length > 0 && (
        <div className="tdo-section">
          <h3 className="section-heading">Textures ({textures.length})</h3>
          <div className="tdo-texture-grid">
            {textures.map(tex => (
              <span key={tex} className="tdo-texture-chip">{tex}</span>
            ))}
          </div>
        </div>
      )}

      {/* Primitive type breakdown */}
      {objects && (
        <div className="tdo-section">
          <h3 className="section-heading">Primitive Breakdown</h3>
          <div className="tdo-prim-breakdown">
            {(() => {
              const withGeom = objects.filter(o => o.primitives > 0)
              const markers = objects.filter(o => o.vertices <= 1 && o.primitives === 0)
              return (
                <>
                  <span className="tdo-stat">{withGeom.length} geometry objects</span>
                  <span className="tdo-stat">{markers.length} markers/points</span>
                </>
              )
            })()}
          </div>
        </div>
      )}
    </div>
  )
}
