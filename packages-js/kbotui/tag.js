// tag.js
//
// Tag — a small inline pill for metadata (a game flavour, a version, a
// parent-context name, a "current" marker). Tones map to studio.css
// accent colours.

import { htm as html } from '@kbot/ui/htm-bind'

// Tag — props:
//   tone     — 'default' | 'accent' (visual emphasis)
//   children — pill contents
export function Tag({ tone = 'default', children }) {
  return html`<span class=${'kb-tag kb-tag-' + tone}>${children}</span>`
}
