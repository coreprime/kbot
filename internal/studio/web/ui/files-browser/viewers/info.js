// info.js
//
// The Metadata tab: file identity (name, path, format, size, winning
// source layer) above the full structured describe document rendered as
// a collapsible tree.

import { htm as html } from '/ui/common/htm-bind.js'
import { formatSize } from '../api.js'
import { DataTree } from '../content/data-tree.js'

export function InfoTab({ meta }) {
  const d = (meta && meta.describe) || {}
  const rows = [
    ['Name', meta.name],
    ['Path', meta.path],
    ['Format', d.format || 'Unknown'],
    ['Size', `${formatSize(meta.size)} (${Number(meta.size || 0).toLocaleString()} bytes)`],
    ['Source', meta.source || '—'],
  ]
  return html`
    <div class="fx-info">
      <div class="fx-info-facts">
        ${rows.map(([k, v]) => html`
          <div class="fx-info-row"><span class="fx-info-key">${k}</span><span class="fx-info-val">${v}</span></div>
        `)}
      </div>
      <h3 class="fx-info-h">Structured description</h3>
      <${DataTree} data=${d} />
    </div>
  `
}
