// htm-bind.js
//
// Bind htm to Preact's `h` once so every UI module can import the
// pre-bound tagged-template literal without repeating the boilerplate.
// htm ships as a factory (it doesn't know about any framework) — the
// bind step turns it into a JSX-free template syntax we can drop into
// any module:
//
//   import { htm } from '/ui/common/htm-bind.js'
//   const html = htm
//   const view = html`<div class="row">${count}</div>`
//
// Keeping this in its own file means switching to JSX later (or to a
// different framework) is a one-file change rather than a sweep across
// every component.

import { h } from 'preact'
import htmFactory from 'htm'

export const htm = htmFactory.bind(h)
