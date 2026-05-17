import { useState } from 'react'
import type { Section } from '../../api'

export default function SectionsContent({ sections }: { sections: Section[] }) {
  const [search, setSearch] = useState('')

  const filtered = search
    ? sections.filter(s => sectionMatches(s, search.toLowerCase()))
    : sections

  return (
    <div>
      <div className="sections-toolbar">
        <input
          type="text"
          placeholder="Search sections…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="section-search"
        />
      </div>
      <div className="sections-list">
        {filtered.map((section, i) => (
          <SectionNode key={i} section={section} defaultOpen={filtered.length <= 5 || !!search} />
        ))}
        {filtered.length === 0 && (
          <div className="empty-state" style={{ padding: 20 }}>No matching sections.</div>
        )}
      </div>
    </div>
  )
}

function sectionMatches(section: Section, query: string): boolean {
  if (section.name?.toLowerCase().includes(query)) return true
  if (section.fields?.some(f =>
    f.key.toLowerCase().includes(query) || f.value.toLowerCase().includes(query)
  )) return true
  if (section.children?.some(c => sectionMatches(c, query))) return true
  return false
}

function SectionNode({ section, defaultOpen }: { section: Section; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="section-node">
      <div className="section-header" onClick={() => setOpen(!open)}>
        <span className="section-toggle">{open ? '▾' : '▸'}</span>
        <span className="section-name">[{section.name}]</span>
        {section.fields && (
          <span className="section-count">{section.fields.length} fields</span>
        )}
      </div>
      {open && (
        <div className="section-body">
          {section.fields && section.fields.length > 0 && (
            <table className="section-fields">
              <tbody>
                {section.fields.map((f, i) => (
                  <tr key={i}>
                    <td className="field-key">{f.key}</td>
                    <td className="field-sep">=</td>
                    <td className="field-value">{f.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {section.children && section.children.length > 0 && (
            <div className="section-children">
              {section.children.map((child, ci) => (
                <SectionNode key={ci} section={child} defaultOpen={false} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
