// breadcrumbs.js
//
// Renders a path as clickable segments.  An optional "File System" crumb
// (onGoHome) leads the trail back to the dashboard, the filesystem root
// renders as "/ (Root)", and each crumb except the last is a button that
// navigates (folders → Browse via onOpenDir); the trailing segment is
// the current location and renders inert.

import { htm as html } from '@kbot/ui/htm-bind'

// crumbLabel renders the filesystem root as "/ (Root)" and every other
// segment by its own name.
function crumbLabel(c) {
  return (!c.path || c.name === 'Root') ? '/ (Root)' : c.name
}

export function Breadcrumbs({ crumbs, onOpenDir, onGoHome, trailing }) {
  const items = crumbs && crumbs.length ? crumbs : [{ name: 'Root', path: '' }]
  return html`
    <nav class="fx-crumbs">
      ${onGoHome ? html`
        <button type="button" class="fx-crumb" onClick=${() => onGoHome()}>File System</button>
        <span class="fx-crumb-sep">›</span>` : null}
      ${items.map((c, i) => {
        const last = i === items.length - 1 && !trailing
        return html`
          ${i > 0 ? html`<span class="fx-crumb-sep">›</span>` : null}
          ${last
            ? html`<span class="fx-crumb current">${crumbLabel(c)}</span>`
            : html`<button type="button" class="fx-crumb" onClick=${() => onOpenDir?.(c.path)}>${crumbLabel(c)}</button>`}
        `
      })}
      ${trailing ? html`<span class="fx-crumb-sep">›</span><span class="fx-crumb current">${trailing}</span>` : null}
    </nav>
  `
}
