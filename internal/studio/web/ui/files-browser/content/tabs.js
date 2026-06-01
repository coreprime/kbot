// tabs.js
//
// A tiny tab-strip primitive used by the preview pane to switch between
// the rendered representation, the structured details, the archive
// layering, and a raw hex dump.  It's intentionally local to the Files
// tab (the editor's main tab strip is a different, heavier component);
// this one is just a row of buttons over a content slot.

import { htm as html } from '/ui/common/htm-bind.js'
import { useState } from 'preact/hooks'

// Tabs takes an array of { id, label, render } and shows one panel at a
// time.  `render` is a thunk so only the active panel's tree is built —
// the hex view in particular is lazy this way.
export function Tabs({ items, initial }) {
  const visible = items.filter(Boolean)
  const [active, setActive] = useState(initial || (visible[0] && visible[0].id))
  const current = visible.find((t) => t.id === active) || visible[0]
  if (!current) return null
  return html`
    <div class="files-tabs">
      <div class="files-tabs-strip" role="tablist">
        ${visible.map((t) => html`
          <button type="button"
                  role="tab"
                  class=${`files-tab ${t.id === current.id ? 'active' : ''}`}
                  aria-selected=${t.id === current.id}
                  onClick=${() => setActive(t.id)}>${t.label}</button>
        `)}
      </div>
      <div class="files-tabs-body">${current.render()}</div>
    </div>
  `
}
