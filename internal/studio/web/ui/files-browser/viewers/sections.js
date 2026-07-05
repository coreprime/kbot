// sections.js
//
// Viewer for the section-tree formats (TDF / FBI / GUI / OTA).  Each
// section is a collapsible node showing its key/value fields in a tidy
// table; nested sections recurse.  A search box filters the tree to
// sections (or fields) matching the query and auto-expands the matches.

import { htm as html } from '@coreprime/kbot-ui/htm-bind'
import { useState } from 'preact/hooks'

function sectionMatches(section, query) {
  if (section.name && section.name.toLowerCase().includes(query)) return true
  if (section.fields && section.fields.some((f) =>
    f.key.toLowerCase().includes(query) || String(f.value).toLowerCase().includes(query))) return true
  if (section.children && section.children.some((c) => sectionMatches(c, query))) return true
  return false
}

function SectionNode({ section, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen)
  const fields = section.fields || []
  const children = section.children || []
  return html`
    <div class="fx-sec-node">
      <div class="fx-sec-head" onClick=${() => setOpen(!open)}>
        <span class="fx-sec-toggle">${open ? '▾' : '▸'}</span>
        <span class="fx-sec-name">[${section.name}]</span>
        ${fields.length ? html`<span class="fx-sec-count">${fields.length} field${fields.length !== 1 ? 's' : ''}</span>` : null}
      </div>
      ${open ? html`
        <div class="fx-sec-body">
          ${fields.length ? html`
            <table class="fx-sec-fields">
              <tbody>
                ${fields.map((f, i) => html`
                  <tr key=${i}><td class="fx-sec-key">${f.key}</td><td class="fx-sec-eq">=</td><td class="fx-sec-val">${f.value}</td></tr>`)}
              </tbody>
            </table>` : null}
          ${children.length ? html`<div class="fx-sec-children">${children.map((c, i) => html`<${SectionNode} key=${i} section=${c} defaultOpen=${false} />`)}</div>` : null}
        </div>` : null}
    </div>
  `
}

export function SectionsViewer({ sections }) {
  const [search, setSearch] = useState('')
  const all = sections || []
  const q = search.trim().toLowerCase()
  const filtered = q ? all.filter((s) => sectionMatches(s, q)) : all
  return html`
    <div class="fx-sections">
      <div class="fx-sec-toolbar">
        <input type="text" class="fx-sec-search" placeholder="Search sections…" value=${search} onInput=${(e) => setSearch(e.target.value)} />
      </div>
      <div class="fx-sec-list">
        ${filtered.map((s, i) => html`<${SectionNode} key=${i} section=${s} defaultOpen=${filtered.length <= 5 || !!q} />`)}
        ${filtered.length === 0 ? html`<div class="fx-empty">No matching sections.</div>` : null}
      </div>
    </div>
  `
}
