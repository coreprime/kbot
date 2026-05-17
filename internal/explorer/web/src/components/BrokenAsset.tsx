import React from 'react'

interface Props {
  label?: string
  className?: string
  style?: React.CSSProperties
}

/** Placeholder shown when an image/asset fails to load. Hidden by default. */
export default function BrokenPlaceholder({ label, className, style }: Props) {
  return (
    <div className={`broken-asset ${className || ''}`} style={{ display: 'none', ...style }}>
      <span className="broken-asset-icon">⚠️</span>
      <span className="broken-asset-label">{label || 'Asset unavailable'}</span>
    </div>
  )
}
