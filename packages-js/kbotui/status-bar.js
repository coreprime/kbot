// status-bar.js
//
// The footer status strip: a left-aligned status message, optional
// right-aligned hints, and an optional trailing copyright note.  Uses
// the same `.statusbar` / `.hints` / `.copyright` classes as the studio
// shell so the look-and-feel is shared.
//
// Presentational only — the caller owns the message text.  `statusId`
// lets a host keep a stable element id on the status span when it
// updates the text imperatively from outside the component tree.

import { htm as html } from './htm-bind.js'

export function StatusBar({ status = '', hints, copyright, statusId, children }) {
  return html`
    <footer class="statusbar">
      <span id=${statusId || undefined}>${status}</span>
      ${hints ? html`<span class="muted hints">${hints}</span>` : null}
      ${children}
      ${copyright ? html`<span class="copyright">${copyright}</span>` : null}
    </footer>
  `
}
