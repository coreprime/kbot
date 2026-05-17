import { Link } from 'react-router-dom'
import type { Breadcrumb } from '../api'

interface Props {
  crumbs: Breadcrumb[]
  linkPrefix: string // e.g. "/browse"
  current?: string
}

export default function Breadcrumbs({ crumbs, linkPrefix, current }: Props) {
  // Skip the Root crumb (we render our own) and skip the last crumb
  // if it matches `current` (the filename) to avoid a duplicate that
  // links to a non-browsable file path.
  const segments = crumbs.filter(c => {
    if (c.path === '' || c.name === 'Root') return false
    if (current && c.name === current) return false
    return true
  })

  return (
    <div className="breadcrumbs">
      <Link to="/">🏠</Link>
      <span className="sep">/</span>
      <Link to="/browse/">Root</Link>
      {segments.map((c, i) => (
        <span key={i}>
          <span className="sep">/</span>
          <Link to={`${linkPrefix}/${c.path}`}>{c.name}</Link>
        </span>
      ))}
      {current && (
        <>
          <span className="sep">/</span>
          <span className="current">{current}</span>
        </>
      )}
    </div>
  )
}
