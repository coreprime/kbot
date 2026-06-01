// layers.js
//
// The Layering tab: lists every archive layer that carries this path,
// ordered by priority (the winning, active layer first).  Clicking a
// layer re-renders the file's other tabs from that specific source so
// you can see what a lower-priority archive holds for the same name.

import { htm as html } from '/ui/common/htm-bind.js'
import { formatSize } from '../api.js'

// Layer records arrive as Go structs (PascalCase); tolerate camelCase too.
function lSource(l) { return l.source ?? l.Source ?? '' }
function lSize(l) { return l.size ?? l.Size ?? 0 }
function lPriority(l) { return l.priority ?? l.Priority ?? 0 }

export function LayersTab({ layers, activeSource, onSwitch }) {
  const items = layers || []
  if (!items.length) return html`<div class="fx-empty">No layer information available.</div>`
  // The active layer is the chosen source, or the highest-priority layer.
  const winning = activeSource || lSource(items[0])
  return html`
    <div class="fx-layers">
      <p class="fx-layers-note">This file exists in ${items.length} source${items.length !== 1 ? 's' : ''}. Click a layer to view its bytes.</p>
      <div class="fx-layer-list">
        ${items.map((layer, i) => {
          const src = lSource(layer)
          const isActive = src === winning
          return html`
            <div key=${i} class=${'fx-layer' + (isActive ? ' active' : '')} onClick=${() => onSwitch && onSwitch(src)}>
              <div class="fx-layer-name">
                <span class="fx-layer-src">${src}</span>
                ${isActive ? html`<span class="fx-layer-active-tag">● active</span>` : null}
              </div>
              <div class="fx-layer-meta">
                <span>${formatSize(lSize(layer))}</span>
                <span>Priority ${lPriority(layer)}</span>
              </div>
            </div>`
        })}
      </div>
    </div>
  `
}
