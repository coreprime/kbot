import { useState } from 'react'

interface Props {
  data: unknown
  defaultOpen?: boolean
}

export default function MetadataTree({ data, defaultOpen = true }: Props) {
  if (data === null || data === undefined) {
    return <span className="val">null</span>
  }

  if (typeof data !== 'object') {
    return <span className="val">{String(data)}</span>
  }

  if (Array.isArray(data)) {
    return (
      <div className="meta-tree">
        {data.map((item, i) => (
          <div key={i} className="meta-section">
            <MetadataSection title={`[${i}]`} value={item} defaultOpen={defaultOpen} />
          </div>
        ))}
      </div>
    )
  }

  const entries = Object.entries(data as Record<string, unknown>)

  return (
    <div className="meta-tree">
      {entries.map(([key, val]) => (
        <div key={key} className="meta-section">
          {typeof val === 'object' && val !== null ? (
            <MetadataSection title={key} value={val} defaultOpen={defaultOpen} />
          ) : (
            <div className="meta-kv">
              <span className="key">{key}</span>
              <span className="val">{String(val ?? '')}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function MetadataSection({
  title,
  value,
  defaultOpen,
}: {
  title: string
  value: unknown
  defaultOpen: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <>
      <div className="meta-section-title" onClick={() => setOpen(!open)}>
        <span>{open ? '▾' : '▸'}</span>
        <span>{title}</span>
      </div>
      {open && (
        <div className="meta-section-content">
          <MetadataTree data={value} defaultOpen={false} />
        </div>
      )}
    </>
  )
}
