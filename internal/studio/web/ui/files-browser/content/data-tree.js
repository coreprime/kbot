// data-tree.js
//
// Collapsible viewer for the structured `describe` document.  Objects
// and arrays render as expandable nodes; scalars render inline.  This
// replaces the Stage-7 raw-JSON <pre> with something navigable for the
// deeper describers (COB disassembly, HPI file lists, TNT tile stats).

import { htm as html } from '/ui/common/htm-bind.js'
import { useState } from 'preact/hooks'

function isLeaf(v) {
  return v === null || typeof v !== 'object'
}

function leafText(v) {
  if (v === null) return 'null'
  if (typeof v === 'string') return v
  return String(v)
}

// Node renders one key/value pair.  Container values (object/array) get
// a disclosure toggle; the top level starts expanded so the most useful
// facts are visible without a click.
function Node({ name, value, depth }) {
  const [open, setOpen] = useState(depth < 1)
  if (isLeaf(value)) {
    return html`
      <div class="files-tree-row" style=${`padding-left:${depth * 14}px`}>
        ${name != null ? html`<span class="files-tree-key">${name}:</span>` : null}
        <span class=${`files-tree-val files-tree-${value === null ? 'null' : typeof value}`}>${leafText(value)}</span>
      </div>
    `
  }
  const isArr = Array.isArray(value)
  const entries = isArr ? value.map((v, i) => [i, v]) : Object.entries(value)
  const summary = isArr ? `[${entries.length}]` : `{${entries.length}}`
  return html`
    <div class="files-tree-node">
      <button type="button" class="files-tree-row files-tree-toggle"
              style=${`padding-left:${depth * 14}px`} onClick=${() => setOpen(!open)}>
        <span class="files-tree-caret">${open ? '▾' : '▸'}</span>
        ${name != null ? html`<span class="files-tree-key">${name}</span>` : null}
        <span class="files-tree-summary">${summary}</span>
      </button>
      ${open ? entries.map(([k, v]) => html`<${Node} name=${String(k)} value=${v} depth=${depth + 1} />`) : null}
    </div>
  `
}

export function DataTree({ data }) {
  if (!data || (typeof data === 'object' && Object.keys(data).length === 0)) {
    return html`<div class="files-preview-empty">No structured description available</div>`
  }
  return html`<div class="files-tree-view"><${Node} value=${data} depth=${0} /></div>`
}
