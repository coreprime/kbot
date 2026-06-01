// breadcrumbs.js
//
// Renders a path as clickable segments.  Each crumb except the last is a
// button that navigates (folders → Browse via onOpenDir); the trailing
// segment is the current location and renders inert.

import { htm as html } from '/ui/common/htm-bind.js'

export function Breadcrumbs({ crumbs, onOpenDir, trailing }) {
  const items = crumbs && crumbs.length ? crumbs : [{ name: 'Root', path: '' }]
  return html`
    <nav class="fx-crumbs">
      ${items.map((c, i) => {
        const last = i === items.length - 1 && !trailing
        return html`
          ${i > 0 ? html`<span class="fx-crumb-sep">›</span>` : null}
          ${last
            ? html`<span class="fx-crumb current">${c.name || 'Root'}</span>`
            : html`<button type="button" class="fx-crumb" onClick=${() => onOpenDir?.(c.path)}>${c.name || 'Root'}</button>`}
        `
      })}
      ${trailing ? html`<span class="fx-crumb-sep">›</span><span class="fx-crumb current">${trailing}</span>` : null}
    </nav>
  `
}
